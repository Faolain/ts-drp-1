/* eslint-disable @typescript-eslint/explicit-function-return-type -- Shared measurement driver preserves the inferred artifact contract. */
import { decodeCanonical } from "@ts-drp/canonical";
import assert from "node:assert/strict";

import { ChatWindowOracle } from "./chat-oracle.js";
import { lostRowDisposition } from "./lost-disposition.js";
import {
	type AppKind,
	fromBase64,
	type RoleEndpoint,
	successorWire,
	type WireRow,
} from "../track-m-apps/long-room-driver.js";

interface AppState {
	counters?: number[][];
	blocks?: { id: string; x: number }[];
	messages?: { clientOperationId: string }[];
}
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("ENDURANCE_REQUIRED");
	return value;
}
/** App mode: a policy that has not rolled over after this many moves per role has stranded. */
const APP_ROLLOVER_MAX_MOVES = 200;
/**
 * App mode: the window around each automatic rollover in which issue latency is measured runs from
 * the creator's seal start until this long after its adoption (the member's install follows it).
 */
export const APP_ROLLOVER_WINDOW_TAIL_MS = 1_000;
/**
 * App mode: the default bound on a member's issue that overlaps an automatic rollover's window.
 * Harness mode has no latency bound per rollover, only liveness (an accepted issue completes before
 * the rollover returns), and continued play's 1 s starvation alarm measures timer gaps, not issues.
 * A member's move may legitimately wait out the creator's whole rollover (measured 0.3-2.3 s for
 * seal, adoption and export natively) and then its own install; five seconds is above both
 * together, so a member issue above it is starved rather than jittery (for example a move refused
 * at capacity that waits up to V3_ROOM_MEMBER_SUCCESSOR_WAIT_MS for a successor). Measured worst
 * member issue in a window, 12 adopted epochs per app: Canvas 803 ms, Grid 515 ms, Chat 517 ms.
 */
export const APP_MEMBER_ROLLOVER_ISSUE_BOUND_MS = 5_000;
const q = (values: number[], p: number): number =>
	[...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
const rowValue = (row: WireRow) =>
	decodeCanonical(fromBase64(row.preimage)) as { epoch: number; operation: { action: string } };

// Observe every branch immediately and join every native operation before failure
// reaches the caller, which owns peer cleanup. Promise.all alone fails too early.
async function joinAll<const Tasks extends readonly unknown[]>(
	tasks: Tasks
): Promise<{ -readonly [Key in keyof Tasks]: Awaited<Tasks[Key]> }> {
	const results = await Promise.allSettled(tasks);
	for (const result of results) if (result.status === "rejected") throw result.reason;
	return Promise.all(tasks);
}

/**
 * Same active workload and conservation oracle for native SQLite and browser IndexedDB.
 * @param input - Workload, production endpoints and artifact sink.
 * @returns Completed epochs and measured local/remote timing distributions.
 */
export async function driveActiveAppEndurance(
	input: Readonly<{
		app: AppKind;
		epochs: number;
		moves: number;
		streamLimit: number;
		peers: readonly [RoleEndpoint, RoleEndpoint];
		reopenAt?: number;
		reopen?(peers: readonly [RoleEndpoint, RoleEndpoint]): Promise<readonly [RoleEndpoint, RoleEndpoint]>;
		/**
		 * "harness" (default): the driver seals, adopts and exports after each epoch's moves. "app":
		 * the creator's application policy rolls the room over by itself (the peers must be opened
		 * with `rollover: "app"`); each epoch plays rounds of `moves` per role until the creator's
		 * room has advanced. Offers travel by the pages' own successor delivery over a scripted wire
		 * (`successorWire`); harness offer passing is refused. `epochs` then counts adopted epochs (the
		 * creator room's authenticated epoch), not driver rounds; a round may close more than one.
		 */
		rollover?: "harness" | "app";
		/**
		 * App mode: the most a member's (the Writer's) issue may take when it overlaps an automatic
		 * rollover's window (seal start to `APP_ROLLOVER_WINDOW_TAIL_MS` after adoption). Above it the
		 * member is starved and the run fails.
		 */
		memberRolloverIssueBoundMs?: number;
		write(record: Readonly<Record<string, unknown>>): void;
	}>
) {
	const { app, epochs, moves, streamLimit } = input;
	const appMode = input.rollover === "app";
	let peers = input.peers;
	const started = performance.now();
	const issueTimes: number[] = [];
	const receiveTimes: number[] = [];
	// App mode: `receiveTimes` holds the bounded 5 s acceptance poll below, so a row the creator closed its
	// epoch without (carried later by its author's settlement) reads as ~5 s. Split for reporting only:
	// rows accepted inside the poll ("accepted live"), and rows carried by settlement, timed from delivery
	// to the receiver's actual admission of the exact row or of every replacement chunk that carries it
	// (lostRowDisposition's chain), resolved at each epoch's settlement audit.
	const acceptedLiveTimes: number[] = [];
	const carriedTimes: number[] = [];
	const carriedKinds = { lateExact: 0, replaced: 0 };
	const pendingCarried: { digest: string; from: number; receivedAt: number }[] = [];
	const transitionTimes: number[] = [];
	const accepted: { role: number; epoch: number; ordinal: number }[] = [];
	const attempts: {
		role: number;
		epoch: number;
		ordinal: number;
		startedAt: number;
		completedAt: number;
		phase: string;
		outcome: string;
	}[] = [];
	let completed = 0;
	let stage = "open";
	let rolloverEventsSeen = 0;
	// App mode: real chapters. Every automatic rollover the creator's policy finished, by trigger,
	// and the issue-latency window around each one.
	const rolloversByTrigger: Record<string, number> = {};
	const pendingWindows: { closed: number; trigger: string; start: number; end: number; ms: number }[] = [];
	const rolloverWindows: {
		closed: number;
		trigger: string;
		ms: number;
		start: number;
		end: number;
		issues: number[];
		worstMs: (number | null)[];
	}[] = [];
	let firstEpoch = 0;
	let rounds = 0;
	const memberBound = input.memberRolloverIssueBoundMs ?? Number.POSITIVE_INFINITY;
	// Evaluates every window whose tail has passed: each role's worst latency over its issues that
	// overlap the window (all of which have completed, since the driver joins every issue it starts
	// before a window is evaluated, and the window ended before `now`).
	const evaluateWindows = (now: number, all = false) => {
		const ready = all ? pendingWindows.splice(0) : [];
		if (!all)
			for (let index = pendingWindows.length - 1; index >= 0; index--)
				if (required(pendingWindows[index]).end + APP_ROLLOVER_WINDOW_TAIL_MS < now)
					ready.unshift(...pendingWindows.splice(index, 1));
		const evaluated: typeof rolloverWindows = [];
		for (const window of ready) {
			const until = window.end + APP_ROLLOVER_WINDOW_TAIL_MS;
			const overlapping = attempts.filter((value) => value.startedAt <= until && value.completedAt >= window.start);
			const byRole = [0, 1].map((role) => overlapping.filter((value) => value.role === role));
			const measured = {
				...window,
				issues: byRole.map((values) => values.length),
				worstMs: byRole.map((values) =>
					values.length === 0 ? null : Math.max(...values.map((value) => value.completedAt - value.startedAt))
				),
			};
			evaluated.push(measured);
			rolloverWindows.push(measured);
			const member = measured.worstMs[1];
			assert.ok(
				member === null || member === undefined || member <= memberBound,
				`member issue starved around the rollover closing epoch ${window.closed}: ${Math.round(member ?? 0)} ms > ${memberBound} ms`
			);
		}
		return evaluated;
	};
	const wire = appMode ? successorWire(() => peers) : undefined;
	try {
		const chatModel = app === "chat" ? new ChatWindowOracle(await required(peers[0]).state()) : undefined;
		const delivered: (number | null)[] = [null, null];
		const flush = async (from: number): Promise<void> => {
			for (;;) {
				const published = await required(peers[from]).published(required(delivered[from]));
				if (!published.length) return;
				const current = await required(peers[1 - from]).authorityEpoch();
				// A row of an epoch the receiver has not installed yet waits for its install (app mode:
				// the creator rolls over by itself, ahead of the Writer).
				const ahead = published.findIndex((row) => rowValue(row).epoch > (current ?? 0));
				const rows = ahead < 0 ? published : published.slice(0, ahead);
				if (!rows.length) return;
				const live = rows.filter((row) => rowValue(row).epoch === current);
				for (let offset = 0; offset < live.length; offset += 8) {
					const chunk = live.slice(offset, offset + 8);
					const last = chunk.findLastIndex((row) => !rowValue(row).operation.action.startsWith("$drp."));
					if (appMode) {
						// The creator may close the receiver's epoch while a row is in flight; a row it closed
						// without is carried by its author's settlement after the install, so its acceptance
						// is awaited for a bounded time, never joined.
						const receivedAt = performance.now();
						await required(peers[1 - from]).inject(chunk);
						const final = chunk[last];
						if (final !== undefined)
							for (const deadline = receivedAt + 5_000; performance.now() < deadline; ) {
								if ((await required(peers[1 - from]).acceptance([final.digest]))[0] === true) break;
								await new Promise((resolve) => setTimeout(resolve, 10));
							}
						const waited = performance.now() - receivedAt;
						receiveTimes.push(waited);
						if (final !== undefined) {
							if ((await required(peers[1 - from]).acceptance([final.digest]))[0] === true)
								acceptedLiveTimes.push(waited);
							else pendingCarried.push({ digest: final.digest, from, receivedAt: performance.timeOrigin + receivedAt });
						}
						continue;
					}
					if (last >= 0) receiveTimes.push(await required(peers[1 - from]).receive(chunk.slice(0, last + 1)));
					await required(peers[1 - from]).inject(chunk.slice(last + 1));
				}
				delivered[from] = required(rows.at(-1)).authorSequence;
				if (ahead >= 0) return;
			}
		};
		// Observation only (app mode): carried rows whose chain has reached admission get their latency.
		const resolveCarried = async (
			settlement: readonly Awaited<ReturnType<RoleEndpoint["settlementAudit"]>>[]
		): Promise<void> => {
			for (const row of [...pendingCarried]) {
				const receiver = required(peers[1 - row.from]);
				const disposition = await lostRowDisposition(
					row.digest,
					required(settlement[row.from]).replacements,
					(digests) => receiver.acceptance([...digests])
				);
				if (!disposition.carried) continue;
				const times = await receiver.acceptedAt?.(disposition.acceptedDigests);
				if (times === undefined || times.some((time) => time === null)) continue;
				carriedTimes.push(Math.max(...(times as number[])) - row.receivedAt);
				if (disposition.acceptedDigests.length === 1 && disposition.acceptedDigests[0] === row.digest)
					carriedKinds.lateExact++;
				else carriedKinds.replaced++;
				pendingCarried.splice(pendingCarried.indexOf(row), 1);
			}
		};
		// App mode: every rollover the creator's policy finished is taken once, in order. Chat's oracle
		// checks each closed epoch at its closed cut and freezes the successor's base from it.
		const absorbed: Awaited<ReturnType<NonNullable<RoleEndpoint["rollover"]>>>["events"][number][] = [];
		const absorbRollovers = async () => {
			const creator = required(peers[0]);
			const policy = await required(creator.rollover)();
			assert.deepEqual(policy.errors, [], "application rollover failures");
			const events = policy.events.slice(rolloverEventsSeen);
			rolloverEventsSeen = policy.events.length;
			for (const event of events) {
				rolloversByTrigger[event.trigger] = (rolloversByTrigger[event.trigger] ?? 0) + 1;
				pendingWindows.push({
					closed: event.epoch,
					trigger: event.trigger,
					start: event.endedAt - event.ms,
					end: event.endedAt,
					ms: event.ms,
				});
				if (chatModel !== undefined) {
					const closed = await required(creator.closedProjection)(event.epoch);
					if (closed === null) throw new Error(`ENDURANCE_APP_CLOSED_CUT_ABSENT:${event.epoch}`);
					const cut = {
						projectionAudit: () =>
							Promise.resolve({
								base: closed.base,
								operations: closed.operations,
								acceptedCount: 0,
								lastAcceptedAt: null,
								remoteAcceptedCount: 0,
								lastRemoteAcceptedAt: null,
							}),
						state: () => Promise.resolve(closed.state),
					} as unknown as RoleEndpoint;
					await chatModel.check(cut, event.successorEpoch);
				}
				absorbed.push(event);
			}
			return policy;
		};
		// App mode, before a convergence check: a rollover the creator started meanwhile joins, the
		// Writer installs every published offer, and rows of the receiver's current epoch that it
		// has not accepted (a row injected while an install replaced its live plane is dropped) are
		// offered again, as a room's sync would.
		const appSettle = async (): Promise<void> => {
			if (!appMode) return;
			const policy = await absorbRollovers();
			await required(wire).caughtUp(policy.epoch);
			for (const from of [0, 1]) {
				await flush(from);
				const receiver = required(peers[1 - from]);
				const current = (await receiver.authorityEpoch()) ?? 0;
				const rows = (await required(peers[from]).published(null)).filter((row) => rowValue(row).epoch === current);
				const known = await receiver.acceptance(rows.map((row) => row.digest));
				const final = rows.findLast(
					(row, index) => known[index] !== true && !rowValue(row).operation.action.startsWith("$drp.")
				);
				if (final === undefined) continue;
				await receiver.inject(rows);
				for (const deadline = performance.now() + 5_000; performance.now() < deadline; ) {
					if ((await receiver.acceptance([final.digest]))[0] === true) break;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}
		};
		const issue = async (role: number, epoch: number, ordinal: number): Promise<void> => {
			const startedAt = performance.timeOrigin + performance.now();
			const phase = stage;
			let outcome = "accepted";
			try {
				issueTimes.push(await required(peers[role]).issue(epoch, ordinal));
				accepted.push({ role, epoch, ordinal });
			} catch (error) {
				outcome = String(error);
				throw error;
			} finally {
				attempts.push({
					role,
					epoch,
					ordinal,
					startedAt,
					completedAt: performance.timeOrigin + performance.now(),
					phase,
					outcome,
				});
			}
		};
		const conservation = async (epoch: number): Promise<{ stateBytes: number; rows: number }> => {
			const [left, right] = await joinAll(peers.map((peer) => peer.state()));
			assert.equal(left, right, `exact convergence at ${epoch}`);
			const state = decodeCanonical(Uint8Array.from(Buffer.from(required(left), "hex"))) as unknown as AppState;
			if (app === "canvas") {
				const expected = accepted.reduce((sum, row) => sum + 1 + row.role, 0);
				assert.equal(
					required(state.counters).reduce((sum, rgb) => sum + required(rgb[0]), 0),
					expected,
					"every accepted paint contributes once"
				);
			} else if (app === "grid") {
				const expected = new Map<string, number>();
				for (const row of accepted) expected.set(`block-${row.role}-${row.ordinal}`, row.epoch);
				assert.deepEqual(
					required(state.blocks)
						.map((block) => [block.id, block.x])
						.sort(),
					[...expected].sort(),
					"last value of every bounded grid slot"
				);
			} else {
				await required(chatModel).check(required(peers[0]));
				const actual = new Set(required(state.messages).map((message) => message.clientOperationId));
				for (const row of accepted.filter((row) => row.epoch === epoch))
					assert.ok(
						actual.has(`m-${row.role}-${row.epoch}-${row.ordinal}`),
						"every current checkpoint message retained"
					);
			}
			return {
				stateBytes: required(left).length / 2,
				rows: state.messages?.length ?? state.blocks?.length ?? required(state.counters).length,
			};
		};
		firstEpoch = (await required(peers[0]).authorityEpoch()) ?? 0;
		const adopted = async () => ((await required(peers[0]).authorityEpoch()) ?? 0) - firstEpoch;
		let reopenedOnce = false;
		// Harness mode: one round per epoch. App mode: rounds until `epochs` epochs were adopted.
		for (let epoch = 0; appMode ? (await adopted()) < epochs : epoch < epochs; epoch++) {
			rounds = epoch + 1;
			stage = `epoch-${epoch}-play`;
			const acceptedBefore = accepted.length;
			const attemptsBefore = attempts.length;
			// The next free ordinal of this epoch (app mode plays several rounds per epoch).
			let next = moves;
			if (!appMode)
				for (let ordinal = 0; ordinal < moves; ordinal++) {
					await joinAll([issue(0, epoch, ordinal), issue(1, epoch, ordinal)]);
					await flush(0);
					await flush(1);
				}
			else {
				// Play until the creator's own policy has rolled the room over.
				const startEpoch = (await required(peers[0]).authorityEpoch()) ?? 0;
				for (next = 0; ; ) {
					for (let round = 0; round < moves; round++, next++) {
						await joinAll([issue(0, epoch, next), issue(1, epoch, next)]);
						await flush(0);
						await flush(1);
					}
					if (((await required(peers[0]).authorityEpoch()) ?? 0) !== startEpoch) break;
					if (next >= APP_ROLLOVER_MAX_MOVES) throw new Error("ENDURANCE_APP_ROLLOVER_NOT_TRIGGERED");
				}
			}
			stage = `epoch-${epoch}-rollover`;
			let rolling = true;
			let streamAccepted = 0;
			const failures: string[] = [];
			const rolloverStarted = performance.now();
			const receiverBefore = await joinAll(peers.map((peer) => peer.projectionAudit()));
			let rolloverEndedAt = 0;
			let rolloverReceiverAfter = receiverBefore;
			const lost: WireRow[] = [];
			// App mode: the creator's own rollovers of this epoch, which ran during play.
			const appWindows: { start: number; end: number }[] = [];
			const stream = (async () => {
				for (let n = 0; rolling && n < streamLimit; n++) {
					try {
						await issue(1, epoch, next + n);
						streamAccepted++;
					} catch (error) {
						failures.push(String(error));
						break;
					}
					// Every third first copy is lost; the other delayed old-epoch copies
					// arrive without blocking the sender on the sealed creator.
					const rows = await required(peers[1]).published(required(delivered[1]));
					if (n % 3 !== 0) await required(peers[0]).inject(rows);
					else if (rows.length) lost.push(required(rows.at(-1)));
				}
			})();
			const rollover = (async () => {
				if (appMode) return appRollover();
				const sealMs = await required(peers[0]).seal(epoch);
				await chatModel?.check(required(peers[0]), epoch + 1);
				stage = `epoch-${epoch}-adopt`;
				const adoptMs = await required(peers[0]).adopt();
				stage = `epoch-${epoch}-install`;
				const transfer = await required(peers[0]).exportOffer();
				const installMs = await required(peers[1]).install(transfer.offer);
				rolling = false;
				rolloverEndedAt = performance.timeOrigin + performance.now();
				rolloverReceiverAfter = await joinAll(peers.map((peer) => peer.projectionAudit()));
				return { sealMs, adoptMs, exportMs: transfer.ms, installMs };
			})().finally(() => {
				rolling = false;
			});
			// App mode: the creator already sealed, adopted and exported in the background. Every epoch
			// it closed is checked against the Chat oracle at its closed cut, and every offer it
			// published is installed by the Writer, in order, while the Writer keeps issuing.
			async function appRollover() {
				const policy = await absorbRollovers();
				const events = absorbed.splice(0);
				for (const event of events) appWindows.push({ start: event.endedAt - event.ms, end: event.endedAt });
				stage = `epoch-${epoch}-install`;
				// The member's own delivery installs each offer the creator's delivery announced.
				const installStarted = performance.now();
				const delivery = await required(wire).caughtUp(policy.epoch);
				const installMs = performance.now() - installStarted;
				assert.equal(await required(peers[1]).authorityEpoch(), policy.epoch, "the Writer follows every rollover");
				rolling = false;
				rolloverEndedAt = performance.timeOrigin + performance.now();
				rolloverReceiverAfter = await joinAll(peers.map((peer) => peer.projectionAudit()));
				return {
					// One application rollover is its seal, adoption and export together.
					sealMs: events.reduce((sum, event) => sum + event.ms, 0),
					adoptMs: 0,
					exportMs: 0,
					installMs,
					delivery,
					rollovers: events.map(({ epoch: closed, trigger, moves: most, weight }) => ({
						closed,
						trigger,
						most,
						weight,
					})),
				};
			}
			const [phases] = await joinAll([rollover, stream]);
			const transitionMs = performance.now() - rolloverStarted;
			transitionTimes.push(transitionMs);
			assert.deepEqual(failures, [], "concurrent issue refusals");
			assert.ok(streamAccepted > 0, "a Writer completed an issue during rollover");
			await flush(0);
			await flush(1);
			await appSettle();
			const settlement = await joinAll(peers.map((peer) => peer.settlementAudit()));
			for (const value of settlement) assert.deepEqual(value.missing, [], "no dangling settlement-plan dependency");
			if (appMode) await resolveCarried(settlement);
			const lostDisposition: { sourceDigest: string; acceptedDigests: readonly string[] }[] = [];
			for (const row of lost) {
				const disposition = await lostRowDisposition(row.digest, required(settlement[1]).replacements, (digests) =>
					required(peers[0]).acceptance([...digests])
				);
				assert.ok(
					disposition.carried,
					`dropped source ${row.digest} admitted exactly or by every durable replacement chunk`
				);
				lostDisposition.push({ sourceDigest: row.digest, acceptedDigests: disposition.acceptedDigests });
			}
			stage = `epoch-${epoch}-maintenance-overlap`;
			const maintenanceStart = performance.timeOrigin + performance.now();
			const maintenanceReceiverBefore = await joinAll(peers.map((peer) => peer.projectionAudit()));
			let maintenanceEnd = maintenanceStart;
			let maintenanceReceiverAfter = maintenanceReceiverBefore;
			const lulls = joinAll(peers.map((peer) => peer.lull())).then(async (results) => {
				maintenanceEnd = performance.timeOrigin + performance.now();
				maintenanceReceiverAfter = await joinAll(peers.map((peer) => peer.projectionAudit()));
				return results;
			});
			const writes = joinAll(
				[0, 1].map(async (role) => {
					await issue(role, epoch, next + streamLimit);
					await flush(role);
				})
			);
			const [lullResults] = await joinAll([lulls, writes]);
			await flush(0);
			await flush(1);
			await appSettle();
			const state = await conservation(epoch);
			const receiverAfter = await joinAll(peers.map((peer) => peer.projectionAudit()));
			let reopened = false;
			const adoptedNow = appMode ? await adopted() : epoch + 1;
			if (
				input.reopen !== undefined &&
				input.reopenAt !== undefined &&
				!reopenedOnce &&
				(appMode ? adoptedNow >= input.reopenAt : epoch + 1 === input.reopenAt)
			) {
				reopenedOnce = true;
				stage = `epoch-${epoch}-persisted-reopen`;
				const before = await joinAll(peers.map((peer) => peer.state()));
				await wire?.pause();
				peers = await input.reopen(peers);
				wire?.resume();
				// Decision B: a reopened Writer signs nothing until it is current. App mode: its own
				// successor delivery asks the creator on bind and confirms the answer (the wire carries
				// it). Harness mode passes offers by hand, so it also hands over the creator's statement.
				if (!appMode) {
					const verdict = await required(peers[1]).confirmCurrent?.(await required(peers[0]).currencyStatement?.());
					if (verdict !== undefined && verdict !== "current" && verdict !== "unsupported")
						throw new Error(`ENDURANCE_REOPEN_NOT_CURRENT:${verdict}`);
				}
				// A reopened creator's policy starts a new event list.
				rolloverEventsSeen = 0;
				assert.deepEqual(
					await joinAll(peers.map((peer) => peer.state())),
					before,
					"persisted reopen preserves exact accepted app state"
				);
				await conservation(epoch);
				reopened = true;
			}
			const census = await joinAll(peers.map((peer) => peer.census()));
			const epochAttempts = attempts.slice(attemptsBefore);
			const activity = {
				attempted: epochAttempts.length,
				accepted: epochAttempts.filter((value) => value.outcome === "accepted").length,
				rejected: epochAttempts.filter((value) => value.outcome !== "accepted").length,
				completedDuringRollover: epochAttempts.filter(
					(value) =>
						value.outcome === "accepted" &&
						((value.startedAt >= performance.timeOrigin + rolloverStarted && value.completedAt <= rolloverEndedAt) ||
							// App mode: an issue that completed while the creator's own rollover ran.
							appWindows.some((window) => value.completedAt >= window.start && value.completedAt <= window.end))
				).length,
				completedDuringMaintenance: epochAttempts.filter(
					(value) =>
						value.startedAt >= maintenanceStart && value.completedAt <= maintenanceEnd && value.outcome === "accepted"
				).length,
				receiverAccepted: receiverAfter.map(
					(value, index) => value.remoteAcceptedCount - required(receiverBefore[index]).remoteAcceptedCount
				),
				receiverDuringRollover: rolloverReceiverAfter.map(
					(value, index) => value.remoteAcceptedCount - required(receiverBefore[index]).remoteAcceptedCount
				),
				receiverDuringMaintenance: maintenanceReceiverAfter.map(
					(value, index) => value.remoteAcceptedCount - required(maintenanceReceiverBefore[index]).remoteAcceptedCount
				),
				attempts: epochAttempts,
				lastReceiverAcceptedAt: receiverAfter.map((value) => value.lastRemoteAcceptedAt),
			};
			// App mode: the creator's rollovers run in the background during play, between the driver's
			// rounds, so an issue completing inside one is timing, not a property. Its timing-robust
			// replacement is the per-rollover window (evaluateWindows): every member issue overlapping
			// an automatic rollover must finish within memberRolloverIssueBoundMs.
			if (!appMode)
				assert.ok(activity.completedDuringRollover > 0, "an accepted issue completed before rollover returned");
			const windows = appMode ? evaluateWindows(performance.timeOrigin + performance.now()) : [];
			const record = {
				epoch: epoch + 1,
				...(appMode
					? {
							chapters: {
								round: epoch + 1,
								adoptedEpochs: adoptedNow,
								creatorEpoch: await required(peers[0]).authorityEpoch(),
								memberEpoch: await required(peers[1]).authorityEpoch(),
								rolloversByTrigger: { ...rolloversByTrigger },
							},
							rolloverWindows: windows,
						}
					: {}),
				accepted: accepted.length,
				epochAccepted: accepted.length - acceptedBefore,
				streamAccepted,
				reopened,
				activity,
				lostDisposition,
				settlement,
				phases,
				transitionMs,
				lulls: lullResults,
				...state,
				census,
				elapsedMs: performance.now() - started,
			};
			input.write(record);
			const previous = completed;
			completed = adoptedNow;
			if (completed <= 3 || Math.floor(completed / 10) !== Math.floor(previous / 10))
				console.log(
					`ACTIVE_ENDURANCE ${app} ${completed}/${epochs}${appMode ? ` adopted rounds=${epoch + 1} rollovers=${JSON.stringify(rolloversByTrigger)}` : ""} accepted=${accepted.length} transition=${Math.round(transitionMs)}ms`
				);
		}
		const finalWindows = appMode ? evaluateWindows(0, true) : [];
		if (finalWindows.length) input.write({ kind: "rollover-windows", rolloverWindows: finalWindows });
		const worst = (role: number) => {
			const values = rolloverWindows.flatMap((window) => {
				const value = window.worstMs[role];
				return value === null || value === undefined ? [] : [value];
			});
			return values.length === 0
				? null
				: { p50: q(values, 0.5), p95: q(values, 0.95), max: Math.max(...values), windows: values.length };
		};
		const summary = {
			completed,
			...(appMode
				? {
						chapters: {
							target: epochs,
							adoptedEpochs: completed,
							rounds,
							rolloversByTrigger,
							rolloversTotal: Object.values(rolloversByTrigger).reduce((sum, value) => sum + value, 0),
						},
						rolloverIssueWorstMs: {
							creator: worst(0),
							member: worst(1),
							memberBoundMs: Number.isFinite(memberBound) ? memberBound : null,
							windowTailMs: APP_ROLLOVER_WINDOW_TAIL_MS,
						},
						successorDelivery: {
							framesCarried: required(wire).carried(),
							member: await required(peers[1]).successorDelivery?.(),
							creator: await required(peers[0]).successorDelivery?.(),
						},
					}
				: {}),
			accepted: accepted.length,
			elapsedMs: performance.now() - started,
			issueMs: {
				p50: q(issueTimes, 0.5),
				p95: q(issueTimes, 0.95),
				p99: q(issueTimes, 0.99),
				max: Math.max(...issueTimes),
			},
			// App mode: includes the bounded acceptance poll (a carried row reads ~5 s); see receiveSplit.
			receiveMs: { p50: q(receiveTimes, 0.5), p95: q(receiveTimes, 0.95), max: Math.max(...receiveTimes) },
			...(appMode
				? {
						receiveSplit: {
							acceptedLiveMs: {
								count: acceptedLiveTimes.length,
								p50: q(acceptedLiveTimes, 0.5),
								p95: q(acceptedLiveTimes, 0.95),
								p99: q(acceptedLiveTimes, 0.99),
								max: acceptedLiveTimes.length ? Math.max(...acceptedLiveTimes) : null,
							},
							carriedBySettlementMs: {
								count: carriedTimes.length,
								...carriedKinds,
								p50: q(carriedTimes, 0.5),
								p95: q(carriedTimes, 0.95),
								max: carriedTimes.length ? Math.max(...carriedTimes) : null,
							},
							// Carried rows whose chain had not reached admission by the last settlement audit
							// (or whose receiver was reopened, losing its acceptance times).
							carriedUnresolved: pendingCarried.length,
						},
					}
				: {}),
			transitionMs: {
				p50: q(transitionTimes, 0.5),
				p95: q(transitionTimes, 0.95),
				max: Math.max(...transitionTimes),
			},
		};
		return summary;
	} catch (error) {
		input.write({
			kind: "failure",
			completed,
			rounds,
			stage,
			error: String(error),
			stack: (error as Error).stack,
			...(appMode ? { rolloversByTrigger } : {}),
		});
		throw error;
	} finally {
		await wire?.stop().catch(() => undefined);
	}
}
