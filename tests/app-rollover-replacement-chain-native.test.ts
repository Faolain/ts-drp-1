/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole, type RoleEnvironment } from "./fixtures/track-m-apps/long-room-core.js";
import {
	fromBase64,
	type RoleEndpoint,
	successorWire,
	type WireRow,
} from "./fixtures/track-m-apps/long-room-driver.js";
import { V3_SETTLEMENT_OWN_WINDOW_EPOCHS } from "../packages/node/src/v3-live.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// The replacement chain (fix/replacement-retarget; design note
// .logs/realtime-resume-2026-11-10/agent-status/replacement-retarget-design.md).
//
// A member's install runs its settlement drain after the adoption, on the epoch it just reached: it
// signs the author fence, then one replacement row per displaced own row. When the creator seals
// that epoch before or while the drain signs, every replacement signed after the seal can never be
// admitted (ingress admits only the current anchor). The next install finds it displaced and
// replaces it again, into an epoch that is closed again, and each install has more to replace.
//
// Time-driven model, deterministic. A logical clock (ticks) drives the creator: it rolls on a fixed
// timer, every PERIOD ticks, independent of the member. A member install costs a base INSTALL_BASE
// ticks before its drain signs anything, then ROW_COST ticks per row its drain signs (Firefox:
// about 310-390 ms per replacement row against a ~6.3 s creator epoch). The clock advances only at
// the member's own signatures (the room's signer, awaited inside each row's issuance) and, when the
// member is idle, by jumping to the creator's next roll tick. When a step crosses a roll tick, the
// creator rolls (its seal and adoption) and its successor offer reaches the member's delivery before
// the drain signs its next row. Nothing in the model reads wall time: wall time only bounds waits.
//
// Rule R (the fix): the drain keeps merge, window expiry, resolveRetained and the fence, but asks
// the delivery before each replacement batch whether a newer offer is queued, and defers the
// replacements if so. Counts, not durations:
// - replacements signed into an epoch the creator had already sealed: 0 with R (base: grows);
// - each move admitted by the creator exactly once, its rows in author order, none lost;
// - at most V3_SETTLEMENT_OWN_WINDOW_EPOCHS deferring installs per move.

const track = {
	rooms: new Set<{ close(): Promise<void> }>(),
	heads: new Set<{ close(): Promise<void> }>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
};
const directories: string[] = [];
afterEach(async () => {
	await Promise.allSettled([...track.rooms].map((room) => room.close()));
	await Promise.allSettled([...track.heads].map((head) => head.close()));
	await Promise.allSettled([...track.ports].map((port) => port.close()));
	track.rooms.clear();
	track.heads.clear();
	track.ports.clear();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type RowValue = { epoch: number; author: string; authorSequence: number; operation: Record<string, unknown> };
const rowValue = (row: WireRow) => decodeCanonical(fromBase64(row.preimage)) as RowValue;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
// A batched row (applicationBatch) carries several moves.
const movesOf = (operation: unknown): string[] => {
	if (operation === null || typeof operation !== "object") return [];
	const id = Reflect.get(operation, "id");
	if (typeof id === "string") return [id];
	const entries = Reflect.get(Reflect.get(operation, "batch") ?? {}, "entries");
	return Array.isArray(entries) ? entries.flatMap((entry) => movesOf(Reflect.get(entry, "operation"))) : [];
};

type MemberHooks = Pick<RoleEnvironment, "deliveryRoom" | "sign">;

async function openPair(directory: string, member: MemberHooks) {
	const options = {
		app: "grid" as const,
		host: "node" as const,
		recipient: "writer" as const,
		creatorLull: false,
		epochs: 1,
		moves: 1,
		chatFormat: "shares" as const,
		rollover: "app" as const,
	};
	const env = {
		host: nodeHostFor("node", directory),
		unique: directory,
		track,
		openFloor: (role: string) =>
			createNodeRoomHeadAuthority({
				filename: join(directory, `${role}-external-floor.sqlite`),
				initialization: { kind: "create" as const },
			}),
	};
	const creator = await openRole(options, 0, env);
	const writer = await openRole(options, 1, {
		...env,
		...(member.deliveryRoom === undefined ? {} : { deliveryRoom: member.deliveryRoom }),
		...(member.sign === undefined ? {} : { sign: member.sign }),
		relay: (request) => creator.dispatch(request),
	});
	return { creator, writer };
}

/** The scripted row wire: each side's rows reach the other only in the receiver's current epoch. */
function rowWire(creator: RoleEndpoint, writer: RoleEndpoint) {
	const cursor = { creator: null as number | null, writer: null as number | null };
	const carry = async (from: RoleEndpoint, to: RoleEndpoint, key: "creator" | "writer") => {
		const published = await from.published(cursor[key]);
		if (published.length === 0) return;
		const current = (await to.authorityEpoch()) ?? 0;
		const ahead = published.findIndex((row) => rowValue(row).epoch > current);
		const rows = ahead < 0 ? published : published.slice(0, ahead);
		if (rows.length === 0) return;
		await to.inject(rows.filter((row) => rowValue(row).epoch === current));
		cursor[key] = rows.at(-1)?.authorSequence ?? cursor[key];
	};
	return {
		toWriter: () => carry(creator, writer, "creator"),
		toCreator: () => carry(writer, creator, "writer"),
	};
}

/** Creator moves (with the creator's rows carried to the Writer) until its policy rolls the epoch. */
async function rollCreator(creator: RoleEndpoint, carry: () => Promise<void>, ordinal: { next: number }) {
	const before = (await creator.rollover?.())?.epoch ?? 0;
	for (;;) {
		await creator.issue(0, ordinal.next++);
		await carry();
		const epoch = (await creator.rollover?.())?.epoch ?? 0;
		if (epoch > before) return epoch;
	}
}

async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 120_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (performance.now() > deadline) throw new Error(`${label}: timed out at ${JSON.stringify(value).slice(0, 2000)}`);
		await sleep(50);
	}
}

// The model, in logical ticks (Firefox: the drain starts ~0.6 of the creator's epoch into an
// install; one replacement row costs ~0.05-0.06 of it).
const PERIOD = 20; // the creator rolls every PERIOD ticks
const INSTALL_BASE = 12; // an install's receive, stage and activation, before its drain signs
const ROW_COST = 2; // each row the drain signs (the fence and each replacement)
// The trigger: a burst of moves offered late in an epoch (after the creator has the member's rows of
// it, before its seal), as when a member re-offers its kept moves at once. Each is its own row, and
// every one misses the seal.
const BURST = 5;
const MOVES_PER_INSTALL = 3; // the player's moves made while an install runs (held by the room: one row)
const MOVING_INSTALLS = 3; // installs during which the player moves
// Four installs. On base the burst's moves (origin epoch 2) reach the settlement window at the fourth
// (epoch 6): its drain gives them back and the member's rollover policy offers them again as new moves.
// The policy offers on its own timer and per-epoch budget, which races the next install in wall time,
// so the model stops there: more installs would feed that race back into the per-install counts.
const INSTALLS = Number(process.env.REPLACEMENT_CHAIN_INSTALLS ?? 4);
const LANDING_CREATOR_MOVE_MS = 300;

it("an install that reaches an epoch the creator already sealed signs no replacement into it (time-driven chain model)", async () => {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-replacement-chain-"));
	directories.push(directory);

	type Install = {
		index: number;
		from: number;
		to?: number;
		startTick: number;
		endTick?: number;
		startSign: number;
		endSign?: number;
		drainSigns: number;
		baseCharged: boolean;
		drainOpen: boolean;
		rolls: number[];
		givenBack?: number;
		expired?: number | string;
		ok?: boolean;
		error?: string;
	};
	type Sign = {
		order: number;
		tick: number;
		gated: boolean;
		drain: boolean;
		install: number | null;
		memberEpoch: number;
		creatorEpoch: number;
	};
	const clock = { tick: 0, nextRoll: PERIOD };
	const model = {
		creatorEpoch: 0,
		rolls: [] as { tick: number; epoch: number; install: number | null }[],
		violations: [] as string[],
		notes: [] as string[],
	};
	const installs: Install[] = [];
	const signs = new Map<string, Sign>();
	let signOrder = 0;
	let gating = false;
	let memberRoom: { authority(): { epoch: number } | null | undefined } | undefined;
	// Bound by the test body once both roles are open.
	let rollNow: ((install: number | null, carry?: boolean) => Promise<void>) | undefined;
	let givenBackSettled: ((install: Install) => Promise<void>) | undefined;
	let makeMoves: (() => void) | undefined;
	let readOwnNow: (() => Promise<void>) | undefined;
	let policyIdleNow: (() => Promise<{ undelivered: number }>) | undefined;
	let expiredNow: (() => Promise<number | string>) | undefined;
	const pending: Promise<unknown>[] = [];

	const advance = async (ticks: number, install: number | null) => {
		clock.tick += ticks;
		while (clock.tick >= clock.nextRoll) await rollNow!(install);
	};

	try {
		const { creator, writer } = await openPair(directory, {
			deliveryRoom: (room) => {
				memberRoom = room;
				return {
					authority: () => room.authority(),
					connectedPeers: () => room.connectedPeers(),
					installCreatorSuccessor: async (request) => {
						// The model drives INSTALLS installs; later ones (landing) run unstepped.
						if (!gating || installs.length >= INSTALLS) return room.installCreatorSuccessor(request);
						const record: Install = {
							index: installs.length,
							from: room.authority()?.epoch ?? 0,
							startTick: clock.tick,
							startSign: signOrder,
							drainSigns: 0,
							baseCharged: false,
							drainOpen: true,
							rolls: [],
						};
						installs.push(record);
						try {
							await room.installCreatorSuccessor(request);
							record.ok = true;
						} catch (error) {
							record.ok = false;
							record.error = String(error).slice(0, 400);
							throw error;
						} finally {
							record.drainOpen = false;
							record.to = room.authority()?.epoch ?? 0;
							// The moves held for this install land in the epoch it reached before the delivery
							// can start the next install (the next install waits for this call).
							await Promise.allSettled(pending.splice(0));
							// Own rows are read at every install's end: the outbox prunes them as epochs retire.
							await readOwnNow?.();
							// Moves the drain gave back (window expiry) are offered again by the rollover policy
							// before the next install, too.
							await givenBackSettled?.(record);
							record.endTick = clock.tick;
							record.endSign = signOrder;
							// Observation: moves given back so far (the plan's expired entries; the drain writes them) and
							// those the policy has not yet offered again (timer-driven, so this one varies run to run).
							record.expired = await expiredNow?.();
							record.givenBack = (await policyIdleNow?.())?.undelivered;
							process.stdout.write(`SLOW_MEMBER_CHAIN_INSTALL ${JSON.stringify({ ...record, creator: model.creatorEpoch })}\n`);
						}
					},
				};
			},
			sign: async (digest, sign) => {
				const install = gating ? installs.at(-1) : undefined;
				const memberEpoch = memberRoom?.authority()?.epoch ?? 0;
				// A drain row: signed by an install after its adoption (the room's epoch is the one it reached).
				const drain = install !== undefined && install.drainOpen && memberEpoch > install.from;
				if (drain && !install.baseCharged) {
					install.baseCharged = true;
					// The player keeps moving while the install runs; the room holds the moves until it ends.
					if (install.index < MOVING_INSTALLS) makeMoves!();
					await advance(INSTALL_BASE, install.index);
				}
				const order = signOrder++;
				const signature = await sign();
				signs.set(hex(digest), {
					order,
					tick: clock.tick,
					gated: gating,
					drain,
					install: install === undefined ? null : install.index,
					memberEpoch,
					creatorEpoch: model.creatorEpoch,
				});
				if (drain) {
					install.drainSigns++;
					// The row took ROW_COST ticks to sign: a roll tick crossed meanwhile seals the epoch (and
					// the creator's offer reaches the delivery) before the drain asks about, or signs, its next row.
					await advance(ROW_COST, install.index);
				}
				return signature;
			},
		});
		const wire = successorWire(() => [creator, writer] as const);
		const wireRows = rowWire(creator, writer);
		// One carrier at a time (the row wire's cursors are not reentrant).
		let carrying: Promise<void> = Promise.resolve();
		const serial = (carry: () => Promise<void>) => (carrying = carrying.then(carry, carry));
		const rows = { toWriter: () => serial(wireRows.toWriter), toCreator: () => serial(wireRows.toCreator) };
		const ordinal = { next: 0 };
		let writerOrdinal = 10;
		const moves: { id: string; outcome?: { ok: boolean; error?: string } }[] = [];
		// Every own row the member published, in issue order (the outbox is pruned as epochs retire).
		const own: { sequence: number; epoch: number; digest: string; moves: string[] }[] = [];
		let ownCursor: number | null = null;
		const readOwn = async () => {
			for (;;) {
				const page = await writer.published(ownCursor);
				if (page.length === 0) return;
				for (const row of page) {
					const value = rowValue(row);
					own.push({ sequence: value.authorSequence, epoch: value.epoch, digest: row.digest, moves: movesOf(value.operation) });
				}
				ownCursor = page.at(-1)!.authorSequence;
			}
		};
		readOwnNow = readOwn;
		makeMoves = () => {
			for (let n = 0; n < MOVES_PER_INSTALL; n++) {
				const move: (typeof moves)[number] = { id: `block-1-${writerOrdinal}` };
				moves.push(move);
				// Through the member's rollover policy (it keeps a refused move and offers given-back moves again).
				pending.push(
					writer.issue(0, writerOrdinal++).then(
						() => (move.outcome = { ok: true }),
						(error: unknown) => (move.outcome = { ok: false, error: String(error).slice(0, 300) })
					)
				);
			}
		};
		// The creator's offer reaches the member's delivery (its single newest-offer slot).
		const deliverOffer = async (epoch: number) => {
			const deadline = performance.now() + 30_000;
			for (;;) {
				const down = (await creator.successorFrames?.()) ?? [];
				const up = (await writer.successorFrames?.()) ?? [];
				if (down.length) await writer.deliverSuccessorFrames?.(down);
				if (up.length) await creator.deliverSuccessorFrames?.(up);
				const offered = down.some((frame) => {
					try {
						const value = decodeCanonical(fromBase64(frame)) as { kind?: unknown; successorEpoch?: unknown };
						return value.kind === "ts-drp-v3-successor-offer" && Number(value.successorEpoch) >= epoch;
					} catch {
						return false;
					}
				});
				if (offered) return;
				if (performance.now() > deadline) throw new Error(`the creator's offer for epoch ${epoch} never reached the member`);
				await sleep(20);
			}
		};
		rollNow = async (install, carry = true) => {
			const observed = (await creator.rollover?.())?.epoch ?? 0;
			if (observed !== model.creatorEpoch)
				model.violations.push(`creator at ${observed}, model at ${model.creatorEpoch} (tick ${clock.nextRoll})`);
			// The member's committed rows of the creator's epoch reach it before the seal.
			if (carry) await rows.toCreator();
			const epoch = await rollCreator(creator, async () => undefined, ordinal);
			model.creatorEpoch = epoch;
			model.rolls.push({ tick: clock.nextRoll, epoch, install });
			if (install !== null) installs[install]?.rolls.push(epoch);
			clock.nextRoll += PERIOD;
			await deliverOffer(epoch);
		};
		// Given-back moves: the room lists each until the row offering it again consumes its record; the
		// policy keeps it until it offers it (now, or in a later epoch when this epoch's budget is spent).
		// A listed move the policy does not keep is being offered.
		type Settlement = { undelivered?: { operations: { id?: string }[] }[] } | null | undefined;
		type Policy = { kept?: { id?: string }[] } | null | undefined;
		const policyIdle = async () => {
			const listed = (((await writer.settlementStatus?.()) as Settlement)?.undelivered ?? []).flatMap((given) =>
				given.operations.map((operation) => String(operation.id))
			);
			const kept = new Set((((await writer.rolloverStatus?.()) as Policy)?.kept ?? []).map((operation) => String(operation.id)));
			return { undelivered: listed.length, kept: kept.size, offering: listed.filter((id) => !kept.has(id)).length };
		};
		policyIdleNow = policyIdle;
		expiredNow = async () => {
			const audit = await Promise.race([writer.settlementAudit(), sleep(5_000).then(() => "NO-ANSWER-5S" as const)]);
			if (typeof audit === "string") return audit;
			return ((audit as { dispositions?: { expire?: number } } | null)?.dispositions?.expire ?? 0) as number;
		};
		givenBackSettled = async (install) => {
			try {
				await waitFor("no given-back move is being offered", policyIdle, (state) => state.offering === 0, 10_000);
			} catch (error) {
				model.notes.push(`install ${install.index}: ${String(error).slice(0, 300)}`);
			}
		};

		// Connected for two epochs at the creator's pace: rows both ways, one member move each.
		for (let n = 0; n < 2; n++) {
			const epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch);
			await rows.toWriter();
			await writer.issue(epoch, n);
			await rows.toCreator();
		}
		const writerAuthor = rowValue((await writer.published(null))[0]!).author;
		await readOwn();
		await wire.pause();
		model.creatorEpoch = (await creator.rollover?.())?.epoch ?? 0;
		const refusalsBefore = ((await writer.successorDelivery?.()) as { refused?: number } | undefined)?.refused ?? 0;
		gating = true;
		try {
			// The stepped scheduler. While the member is idle (no install in flight, at the creator's epoch,
			// its moves signed), the clock jumps to the creator's next roll tick; during an install, only the
			// member's signatures advance it.
			for (;;) {
				await waitFor(
					"the member is idle at the creator's epoch (or the model's installs are done)",
					async () => ({
						member: (await writer.authorityEpoch()) ?? 0,
						creator: model.creatorEpoch,
						installs: installs.length,
						inFlight: installs.some((install) => install.endSign === undefined),
						...(await policyIdle()),
					}),
					// Back-to-back installs (the chain) are never idle in between: the bound covers all of them.
					(state) =>
						!state.inFlight &&
						((state.member === state.creator && state.offering === 0) || state.installs >= INSTALLS),
					900_000
				);
				await readOwn();
				if (installs.length >= INSTALLS) break;
				await rows.toWriter();
				clock.tick = clock.nextRoll;
				if (installs.length === 0) {
					// The trigger: the creator has the member's rows of its epoch; then the burst, each move its
					// own row, all signed before the seal and none carried to the creator before it.
					await rows.toCreator();
					for (let n = 0; n < BURST; n++) {
						const move: (typeof moves)[number] = { id: `block-1-${writerOrdinal}` };
						moves.push(move);
						move.outcome = await writer.issue(0, writerOrdinal++).then(
							() => ({ ok: true }),
							(error: unknown) => ({ ok: false, error: String(error).slice(0, 300) })
						);
					}
					await readOwn();
					await rollNow(null, false);
				} else await rollNow(null);
			}
		} catch (error) {
			// Observation only, bounded: what the member, its policy and its plan held when the scheduler stalled.
			const within = <T,>(value: Promise<T> | undefined): Promise<T | string | undefined> =>
				Promise.race([Promise.resolve(value), sleep(10_000).then(() => "NO-ANSWER-10S")]);
			await within(readOwn());
			process.stdout.write(
				`SLOW_MEMBER_CHAIN_STALL ${JSON.stringify({
					error: String(error).slice(0, 500),
					clock,
					installs,
					rolls: model.rolls,
					violations: model.violations,
					notes: model.notes,
					moves,
					own: own.map((row) => [row.sequence, row.epoch, row.moves.join("+"), signs.get(row.digest)?.creatorEpoch ?? null]),
					status: await within(writer.rolloverStatus?.()),
					settlement: await within(writer.settlementStatus?.()),
					plan: await within(writer.settlementAudit()),
					memberErrors: await within(writer.rollover?.().then((rollover) => rollover?.errors)),
					delivery: await within(writer.successorDelivery?.()),
				})}\n`
			);
			throw error;
		} finally {
			gating = false;
		}
		await readOwn();
		const refusalsGated = (((await writer.successorDelivery?.()) as { refused?: number } | undefined)?.refused ?? 0) - refusalsBefore;

		// Landing: rows flow, the member follows, every move lands on the creator exactly once.
		let pumping = true;
		const pump = (async () => {
			while (pumping) {
				await rows.toCreator();
				await rows.toWriter();
				await sleep(100);
			}
		})();
		wire.resume();
		const ids = ["block-1-0", "block-1-1", ...moves.map((move) => move.id)];
		const admittedRows = async () =>
			((await creator.acceptedVertices?.()) ?? [])
				.filter((vertex) => vertex.author === writerAuthor)
				.flatMap((vertex) => movesOf(JSON.parse(vertex.operation)).map((id) => ({ id, digest: vertex.digest, epoch: vertex.epoch })));
		const counts = async () => {
			const admitted = await admittedRows();
			return ids.map((id) => admitted.filter((row) => row.id === id).length);
		};
		try {
			await waitFor(
				"the creator admits every move of the member",
				async () => {
					const current = await counts();
					if (current.some((count) => count === 0)) {
						await creator.issue(0, ordinal.next++);
						await sleep(LANDING_CREATOR_MOVE_MS);
					}
					await readOwn();
					return current;
				},
				(current) => current.every((count) => count >= 1),
				600_000
			);
			// Close the epoch they landed in; the member follows it.
			const epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch, 120_000);
			await sleep(1_000);
		} finally {
			pumping = false;
			await pump;
		}
		await readOwn();
		const admitted = await admittedRows();
		const finalCounts = ids.map((id) => admitted.filter((row) => row.id === id).length);

		// Classification. A row is a replacement when its moves were already signed in an earlier own
		// row; it is signed into a sealed epoch when the creator's epoch at its signature was past the row's.
		const signed = new Set<string>();
		const classified = own.map((row) => {
			const sign = signs.get(row.digest);
			const replacement = row.moves.length > 0 && row.moves.every((id) => signed.has(id));
			for (const id of row.moves) signed.add(id);
			return { ...row, sign, replacement, intoSealed: replacement && sign !== undefined && sign.gated && sign.creatorEpoch > row.epoch };
		});
		const gatedInstalls = installs.map((install) => {
			const drained = classified.filter((row) => row.sign?.drain === true && row.sign.install === install.index);
			return {
				index: install.index,
				from: install.from,
				to: install.to,
				ticks: [install.startTick, install.endTick],
				rolledTo: install.rolls,
				drainSigns: install.drainSigns,
				replaced: drained.filter((row) => row.replacement).length,
				intoSealed: drained.filter((row) => row.intoSealed).length,
				expired: install.expired,
				givenBack: install.givenBack,
				ok: install.ok,
				...(install.error === undefined ? {} : { error: install.error }),
			};
		});
		// Per move: origin epoch (its first row) to the epoch its admitted row landed in, in epochs and in
		// installs; and the installs that deferred it (it was owed, and the install signed no row for it).
		const firstRowOf = (id: string) => classified.find((row) => row.moves.includes(id));
		const admittedOf = (id: string) => admitted.find((row) => row.id === id);
		const installsBefore = (order: number | undefined) =>
			order === undefined ? null : installs.filter((install) => install.startSign <= order).length;
		const waits = moves.map(({ id }) => {
			const first = firstRowOf(id);
			const landed = admittedOf(id);
			const landedRow = classified.find((row) => row.digest === landed?.digest);
			const deferrals = installs.filter((install) => {
				const before = classified.filter((row) => row.moves.includes(id) && (row.sign?.order ?? Infinity) < install.startSign);
				const latest = before.at(-1);
				if (latest === undefined || latest.digest === landed?.digest) return false;
				return !classified.some(
					(row) =>
						row.moves.includes(id) &&
						(row.sign?.order ?? -1) >= install.startSign &&
						(row.sign?.order ?? Infinity) < (install.endSign ?? Infinity)
				);
			}).length;
			return {
				id,
				origin: first?.epoch ?? null,
				landed: landed?.epoch ?? null,
				epochs: first === undefined || landed === undefined ? null : landed.epoch - first.epoch,
				installs:
					first?.sign === undefined || landedRow?.sign === undefined
						? null
						: (installsBefore(landedRow.sign.order) ?? 0) - (installsBefore(first.sign.order) ?? 0),
				rows: classified.filter((row) => row.moves.includes(id)).length,
				deferrals,
			};
		});
		const intoSealedPerInstall = gatedInstalls.map((install) => install.intoSealed);
		process.stdout.write(
			`SLOW_MEMBER_CHAIN_INSTALLS ${JSON.stringify({
				model: { PERIOD, INSTALL_BASE, ROW_COST, BURST, MOVES_PER_INSTALL, MOVING_INSTALLS },
				installs: gatedInstalls.length,
				replacedPerInstall: gatedInstalls.map((install) => install.replaced),
				intoSealedPerInstall,
				intoSealedTotal: intoSealedPerInstall.reduce((sum, count) => sum + count, 0),
				perInstall: gatedInstalls,
				waits,
				rolls: model.rolls,
				violations: model.violations,
				notes: model.notes,
				refusalsGated,
				unmatchedSigns: classified.filter((row) => row.sign === undefined).map((row) => row.sequence),
				moveOutcomes: moves.filter((move) => move.outcome?.ok !== true),
				finalCounts,
				status: await writer.rolloverStatus?.(),
			})}\n`
		);

		// The model held: the creator rolled only on its timer, and every gated install installed.
		expect.soft(model.violations, "creator rollovers outside the model's timer").toEqual([]);
		expect.soft(gatedInstalls.filter((install) => install.ok !== true), "gated installs that failed").toEqual([]);
		expect.soft(refusalsGated, "delivery refusals during the gated phase").toBe(0);
		// Each move admitted by the creator exactly once, none lost; equal state.
		expect.soft(finalCounts, "each move admitted by the creator once").toEqual(ids.map(() => 1));
		expect.soft(await writer.state(), "the member's state equals the creator's").toBe(await creator.state());
		// Author order: the moves' first rows follow the order they were made, and each drain replaces
		// its rows in their source rows' order.
		const firstRows = moves.map(({ id }) => firstRowOf(id)?.sequence ?? -1);
		expect.soft(firstRows, "first rows in move order").toEqual([...firstRows].sort((left, right) => left - right));
		for (const install of installs) {
			const replaced = classified.filter((row) => row.replacement && row.sign?.drain === true && row.sign.install === install.index);
			const sources = replaced.map((row) =>
				Math.max(...row.moves.map((id) => classified.filter((other) => other.sequence < row.sequence && other.moves.includes(id)).at(-1)?.sequence ?? -1))
			);
			expect.soft(sources, `install ${install.index}: replacements in source order`).toEqual([...sources].sort((left, right) => left - right));
		}
		// A move waits at most the settlement window's installs while deferred.
		expect
			.soft(waits.filter((wait) => wait.deferrals > V3_SETTLEMENT_OWN_WINDOW_EPOCHS), "moves deferred by more installs than the window")
			.toEqual([]);
		// The chain: no replacement is signed into an epoch the creator had already sealed.
		expect(intoSealedPerInstall, "replacements signed into an already-sealed epoch, per install").toEqual(
			intoSealedPerInstall.map(() => 0)
		);
		await wire.stop();
	} finally {
		gating = false;
		restore();
	}
}, 1_200_000);
