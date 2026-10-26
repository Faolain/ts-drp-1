/* eslint-disable @typescript-eslint/explicit-function-return-type -- Shared measurement driver preserves the inferred artifact contract. */
import { decodeCanonical } from "@ts-drp/canonical";
import assert from "node:assert/strict";

import { ChatWindowOracle } from "./chat-oracle.js";
import { type AppKind, fromBase64, type RoleEndpoint, type WireRow } from "../track-m-apps/long-room-driver.js";

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
		 * room has advanced, then the driver carries the published offers to the Writer as a host
		 * would. An epoch of this driver is then one application rollover.
		 */
		rollover?: "harness" | "app";
		write(record: Readonly<Record<string, unknown>>): void;
	}>
) {
	const { app, epochs, moves, streamLimit } = input;
	const appMode = input.rollover === "app";
	let peers = input.peers;
	const started = performance.now();
	const issueTimes: number[] = [];
	const receiveTimes: number[] = [];
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
					if (last >= 0) receiveTimes.push(await required(peers[1 - from]).receive(chunk.slice(0, last + 1)));
					await required(peers[1 - from]).inject(chunk.slice(last + 1));
				}
				delivered[from] = required(rows.at(-1)).authorSequence;
				if (ahead >= 0) return;
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
		for (let epoch = 0; epoch < epochs; epoch++) {
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
				const creator = required(peers[0]);
				const policy = await required(creator.rollover)();
				const events = policy.events.slice(rolloverEventsSeen);
				rolloverEventsSeen = policy.events.length;
				assert.deepEqual(policy.errors, [], "application rollover failures");
				if (chatModel !== undefined)
					for (const event of events) {
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
				stage = `epoch-${epoch}-install`;
				let installMs = 0;
				for (const offer of await required(creator.takeOffers)()) installMs += await required(peers[1]).install(offer);
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
			const settlement = await joinAll(peers.map((peer) => peer.settlementAudit()));
			for (const value of settlement) assert.deepEqual(value.missing, [], "no dangling settlement-plan dependency");
			const lostDisposition: { sourceDigest: string; acceptedDigests: readonly string[] }[] = [];
			for (const row of lost) {
				const replacement = required(settlement[1]).replacements.find((entry) => entry.sourceDigest === row.digest);
				const candidates = [row.digest, ...(replacement?.replacementDigests ?? [])];
				const admitted = await required(peers[0]).acceptance(candidates);
				const exact = admitted[0] === true;
				const completeReplacement = candidates.length > 1 && admitted.slice(1).every(Boolean);
				assert.ok(
					exact || completeReplacement,
					`dropped source ${row.digest} admitted exactly or by every durable replacement chunk`
				);
				lostDisposition.push({ sourceDigest: row.digest, acceptedDigests: exact ? [row.digest] : candidates.slice(1) });
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
			const state = await conservation(epoch);
			const receiverAfter = await joinAll(peers.map((peer) => peer.projectionAudit()));
			let reopened = false;
			if (input.reopen !== undefined && epoch + 1 === input.reopenAt) {
				stage = `epoch-${epoch}-persisted-reopen`;
				const before = await joinAll(peers.map((peer) => peer.state()));
				peers = await input.reopen(peers);
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
						value.startedAt >= performance.timeOrigin + rolloverStarted &&
						value.completedAt <= rolloverEndedAt &&
						value.outcome === "accepted"
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
			assert.ok(activity.completedDuringRollover > 0, "an accepted issue completed before rollover returned");
			const record = {
				epoch: epoch + 1,
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
			completed = epoch + 1;
			if (completed <= 3 || completed % 10 === 0)
				console.log(
					`ACTIVE_ENDURANCE ${app} ${completed}/${epochs} accepted=${accepted.length} transition=${Math.round(transitionMs)}ms`
				);
		}
		const summary = {
			completed,
			accepted: accepted.length,
			elapsedMs: performance.now() - started,
			issueMs: {
				p50: q(issueTimes, 0.5),
				p95: q(issueTimes, 0.95),
				p99: q(issueTimes, 0.99),
				max: Math.max(...issueTimes),
			},
			receiveMs: { p50: q(receiveTimes, 0.5), p95: q(receiveTimes, 0.95), max: Math.max(...receiveTimes) },
			transitionMs: {
				p50: q(transitionTimes, 0.5),
				p95: q(transitionTimes, 0.95),
				max: Math.max(...transitionTimes),
			},
		};
		return summary;
	} catch (error) {
		input.write({ kind: "failure", completed, stage, error: String(error), stack: (error as Error).stack });
		throw error;
	}
}
