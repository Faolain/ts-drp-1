/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import { createHash } from "node:crypto";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// A Grid Writer that installs more slowly than its creator rolls over (fix/slow-member-follow).
//
// Measured in real browsers (.logs/realtime-resume-2026-10-23/browser-fps/exp-silentwriter): a
// member whose installs took 15-23 s while the creator rolled every ~6 s asked the creator for the
// material of a successor the creator no longer served ("CreatorSuccessorMaterialRefused: ... stale"),
// and every move it made while an install ran was refused by the room ("v3 room live plane is
// unavailable", issueOwned under the settlement profile) until the rollover policy's closing bound
// ran out and the page's write failed.
//
// Two contracts, whatever the install speed:
// (a) a member that falls behind follows the creator: it installs the newest successor it knows of
//     when its install actually fetches the material, not the one that was newest when the install
//     was queued, so a slow host never chases manifests the creator has moved past; and its moves
//     keep landing;
// (b) a move made while an install runs waits for that install and lands after it (in the epoch the
//     install reached), exactly once; it is never refused for the install.

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
const idOf = (operation: string): string | undefined => {
	const value = JSON.parse(operation) as Record<string, unknown> | null;
	return typeof value?.id === "string" ? value.id : undefined;
};

type MemberHooks = Pick<RoleEnvironment, "deliveryRoom"> &
	Readonly<{ relay?(request: string, forward: () => Promise<string[]>): Promise<string[]> }>;

async function openPair(directory: string, member: MemberHooks = {}) {
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
		relay: (request) =>
			member.relay === undefined ? creator.dispatch(request) : member.relay(request, () => creator.dispatch(request)),
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

async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (performance.now() > deadline) throw new Error(`${label}: timed out at ${JSON.stringify(value).slice(0, 2000)}`);
		await sleep(100);
	}
}

/** Accepted vertices of `author` carrying each move id, on one replica. */
async function acceptedCounts(role: RoleEndpoint, author: string, ids: readonly string[]) {
	const vertices = (await role.acceptedVertices?.()) ?? [];
	return ids.map((id) => vertices.filter((vertex) => vertex.author === author && idOf(vertex.operation) === id).length);
}


/** The member's live-journal scopes and the retirement's protected scopes, read from its SQLite file. */
function journalRetirement(directory: string, name: string) {
	const file = join(
		directory,
		`${createHash("sha256").update(JSON.stringify(["journal", name])).digest("hex")}.sqlite.drp-live-journal-v1.sqlite`
	);
	if (!existsSync(file))
		return { scopes: [] as number[], protectedScopes: [] as number[], activeProtected: [] as number[], detail: [] as number[][] };
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const scopes = db.prepare("SELECT epoch FROM scopes ORDER BY epoch").all().map((row) => Number(row.epoch));
		// Per scope: [epoch, closed membership held (1/0), received entries, local-issued entries].
		const detail = db
			.prepare(
				"SELECT s.epoch AS epoch, s.closed_membership_bytes IS NOT NULL AS membership, " +
					"(SELECT count(*) FROM accepted_entries e WHERE e.epoch=s.epoch AND e.anchor_digest=s.anchor_digest AND e.source_kind='received') AS received, " +
					"(SELECT count(*) FROM accepted_entries e WHERE e.epoch=s.epoch AND e.anchor_digest=s.anchor_digest AND e.source_kind='local-issued') AS local " +
					"FROM scopes s ORDER BY s.epoch"
			)
			.all()
			.map((row) => [Number(row.epoch), Number(row.membership), Number(row.received), Number(row.local)]);
		let protectedScopes: number[] = [];
		let activeProtected: number[] = [];
		for (const row of db.prepare("SELECT record FROM retirement_controls").all()) {
			const value = decodeCanonical(row.record as Uint8Array) as {
				completed: { protectedScopes: { epoch: number }[] } | null;
				active: { preparation?: { protectedScopes?: { epoch: number }[] } } | null;
			};
			protectedScopes = value.completed?.protectedScopes.map((scope) => scope.epoch) ?? protectedScopes;
			activeProtected = value.active?.preparation?.protectedScopes?.map((scope) => scope.epoch) ?? activeProtected;
		}
		return { scopes, protectedScopes, activeProtected, detail };
	} finally {
		db.close();
	}
}

/** The departed-carrier proof events (fix/skip-scope-carrier), observation only. */
type CarrierEvent = Readonly<{ kind: string; departedEpoch: number; outcome: string; detail?: string; ring?: number[] }>;
const carrierTally = (events: readonly CarrierEvent[]) => {
	const tally: Record<string, number> = {};
	for (const event of events) {
		const key = `${event.kind === "creator-departed-carrier" ? "creator" : "member"}:${event.outcome}${event.detail === undefined ? "" : `:${event.detail}`}`;
		tally[key] = (tally[key] ?? 0) + 1;
	}
	return tally;
};

// The member's install starts this long after its delivery chose the offer: longer than the creator
// takes for several rollovers. It stands for a host whose lifecycle queue (a recovery-pool lull, a
// recovery after a refused install, slow storage) holds the install before it reaches the creator.
const INSTALL_START_DELAY_MS = Number(process.env.SLOW_MEMBER_DELAY_MS ?? 6_000);
// Jittered (seeded) so the member's fetch does not keep landing at the same point of the creator's
// rollover cycle: exactly when the creator has switched its serving to a successor whose offer is
// still on its way, a request is refused as stale whatever the member does.
let seed = 0x5eed;
const installStartDelay = () => {
	seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
	return INSTALL_START_DELAY_MS * (0.75 + (seed / 2_147_483_648) * 0.5);
};
// Creator rollovers while the member is slow.
const ROLLS = Number(process.env.SLOW_MEMBER_ROLLS ?? 12);
// Conservation: the most rollovers driven while waiting for the skip count, and the bound of each
// wait after it (generous: a loaded host only slows the run, it must not fail it).
const CONSERVE_MAX_ROLLS = Number(process.env.SLOW_MEMBER_CONSERVE_MAX_ROLLS ?? 150);
const CONSERVE_BOUND_MS = 600_000;
// The creator's move interval while the member's moves land (it keeps rolling at a person's pace).
const LANDING_CREATOR_MOVE_MS = Number(process.env.SLOW_MEMBER_LANDING_CREATOR_MS ?? 300);

/**
 * The creator rolls over ROLLS times while the member installs slowly and makes a move every half
 * second; the member must follow it and keep issuing. With `conserve`, every move is then expected
 * to land on the creator exactly once.
 * @param conserve - Whether to check conservation after the member caught up.
 * @param rollCount - The creator's rollovers while the member is slow.
 * @param minSkips - Skip installs (more than one epoch ahead) the slow phase must make.
 */
async function slowFollow(conserve: boolean, rollCount = ROLLS, minSkips = 0) {
	const restore = await installEnvironment("node", () => undefined);
	const carrierEvents: CarrierEvent[] = [];
	Reflect.set(globalThis, "__warmProofEvent", (event: unknown) => {
		const kind = typeof event === "object" && event !== null ? Reflect.get(event, "kind") : undefined;
		if (kind === "recipient-departed-carrier" || kind === "creator-departed-carrier") carrierEvents.push(event as CarrierEvent);
	});
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-slow-member-"));
	directories.push(directory);
	const installs: {
		startedAt: number;
		endedAt?: number;
		ok?: boolean;
		epochBefore: number;
		epochAfter?: number;
		offered: number;
		newest?: { at: number; epoch: number | null };
	}[] = [];
	const offeredEpoch = (offer: { exactCanonicalTrustStateRecordBytes: Uint8Array }) =>
		Number((decodeCanonical(offer.exactCanonicalTrustStateRecordBytes) as { currentEpoch: number }).currentEpoch);
	// The member is slow only once it has followed the first epochs at the creator's pace (a
	// member's first install being a skip install is a separate case; see
	// tests/app-rollover-repeated-skip-inflight-native.test.ts).
	let slow = false;
	try {
		const { creator, writer } = await openPair(directory, {
			deliveryRoom: (room) => ({
				authority: () => room.authority(),
				connectedPeers: () => room.connectedPeers(),
				installCreatorSuccessor: async (request) => {
					if (!slow) return room.installCreatorSuccessor(request);
					const record: (typeof installs)[number] = {
						startedAt: performance.now(),
						epochBefore: room.authority()?.epoch ?? 0,
						offered: offeredEpoch(request.offer),
					};
					installs.push(record);
					await sleep(installStartDelay());
					try {
						const newest = request.newest;
						await room.installCreatorSuccessor(
							newest === undefined
								? request
								: {
										...request,
										newest: () => {
											const later = newest();
											record.newest = {
												at: performance.now(),
												epoch: later === undefined ? null : offeredEpoch(later.offer),
											};
											return later;
										},
									}
						);
						record.ok = true;
					} catch (error) {
						record.ok = false;
						throw error;
					} finally {
						record.endedAt = performance.now();
						record.epochAfter = room.authority()?.epoch ?? 0;
					}
				},
			}),
		});
		const wire = successorWire(() => [creator, writer] as const);
		const wireRows = rowWire(creator, writer);
		// One carrier at a time (the row wire's cursors are not reentrant).
		let carrying: Promise<void> = Promise.resolve();
		const serial = (carry: () => Promise<void>) => (carrying = carrying.then(carry, carry));
		const rows = { toWriter: () => serial(wireRows.toWriter), toCreator: () => serial(wireRows.toCreator) };
		const ordinal = { next: 0 };
		const writerOrdinal = { next: 0 };
		const rolls: { epoch: number; at: number; member: number }[] = [];
		// Connected for two epochs at the creator's pace: rows both ways, one member move each.
		for (let epoch = 0; epoch < 2; ) {
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch);
			await rows.toWriter();
			await writer.issue(epoch, writerOrdinal.next++);
			await rows.toCreator();
		}
		slow = true;
		const issued: { id: string; ms: number; error?: string }[] = [
			{ id: "block-1-0", ms: 0 },
			{ id: "block-1-1", ms: 0 },
		];
		const started = performance.now();
		let stopped = false;
		let pumping = true;
		// Rows flow both ways all the time, as on the network (each reaches the other side only in
		// that side's current epoch).
		const pump = (async () => {
			while (pumping) {
				await rows.toCreator();
				await rows.toWriter();
				await sleep(100);
			}
		})();
		// Observation: every move the member's room listed as given back, and for how long.
		const givenBack = new Map<string, { ids: string[]; epoch: number; first: number; last: number }>();
		const watchGivenBack = (async () => {
			while (pumping) {
				const status = (await writer.settlementStatus?.()) as {
					undelivered: { vertexDigest: string; epoch: number; operations: { id?: string }[] }[];
				} | null;
				const now = Math.round(performance.now() - started);
				for (const given of status?.undelivered ?? []) {
					const seen = givenBack.get(given.vertexDigest);
					if (seen === undefined)
						givenBack.set(given.vertexDigest, {
							ids: given.operations.map((operation) => String(operation.id)),
							epoch: given.epoch,
							first: now,
							last: now,
						});
					else seen.last = now;
				}
				await sleep(50);
			}
		})();
		try {
			// The creator rolls over back to back; the member follows through the pages' own delivery,
			// and makes a move every half second (through the application's rollover policy).
			const memberMoves = (async () => {
				while (!stopped) {
					const n = writerOrdinal.next++;
					const id = `block-1-${n}`;
					const at = performance.now();
					try {
						await writer.issue((await writer.authorityEpoch()) ?? 0, n);
						issued.push({ id, ms: performance.now() - at });
					} catch (error) {
						issued.push({ id, ms: performance.now() - at, error: String(error).slice(0, 300) });
					}
					await sleep(500);
				}
			})();
			// Conservation drives rollovers until the slow member has made `minSkips` skip installs (any
			// host speed), bounded by CONSERVE_MAX_ROLLS; the follow test rolls `rollCount` times.
			const completedSkips = () =>
				installs.filter((install) => install.ok === true && (install.epochAfter ?? 0) - install.epochBefore > 1).length;
			const trace = async (label: string) => {
				const own = await writer.published(null);
				const first = own[0] === undefined ? undefined : rowValue(own[0]);
				const settlement = (await writer.settlementStatus?.()) as
					| { epoch: number; unsettledEpochs: number; undelivered: { epoch: number }[] }
					| null
					| undefined;
				const status = (await writer.rolloverStatus?.()) as { state?: string; kept?: unknown[] } | undefined;
				// Observation only, bounded: the member plan's dispositions and its policy's latest errors.
				const bounded = <T,>(value: Promise<T> | undefined): Promise<T | string | undefined> =>
					Promise.race([Promise.resolve(value), sleep(5_000).then(() => "NO-ANSWER-5S")]);
				const audit = (await bounded(writer.settlementAudit())) as { dispositions?: unknown } | string | undefined;
				const policy = (await bounded(writer.rollover?.())) as { errors?: readonly string[] } | string | undefined;
				process.stdout.write(
					`SLOW_MEMBER_TRACE ${JSON.stringify({
						label,
						at: Math.round(performance.now() - started),
						creator: (await creator.rollover?.())?.epoch,
						member: await writer.authorityEpoch(),
						skips: completedSkips(),
						ownRows: own.length,
						oldestOwn: first === undefined ? null : [first.authorSequence, first.epoch],
						unsettled: settlement?.unsettledEpochs,
						undelivered: settlement?.undelivered.length,
						undeliveredEpochs: [...new Set(settlement?.undelivered.map((given) => given.epoch) ?? [])],
						state: status?.state,
						kept: status?.kept?.length,
						dispositions: typeof audit === "object" ? audit.dispositions : audit,
						memberErrors:
							typeof policy === "object"
								? { count: policy.errors?.length ?? 0, last: (policy.errors ?? []).slice(-3).map((error) => error.slice(0, 300)) }
								: policy,
						journal: journalRetirement(directory, "recipient"),
						carriers: carrierTally(carrierEvents),
					})}\n`
				);
			};
			for (let roll = 0; conserve ? completedSkips() < minSkips && roll < CONSERVE_MAX_ROLLS : roll < rollCount; roll++) {
				const epoch = await rollCreator(creator, async () => undefined, ordinal);
				rolls.push({ epoch, at: performance.now(), member: (await writer.authorityEpoch()) ?? 0 });
				process.stdout.write(`SLOW_MEMBER_ROLL ${JSON.stringify(rolls.at(-1))}\n`);
				if (conserve && roll % 4 === 3) await trace("roll");
			}
			const rolledFor = performance.now() - started;
			const creatorEpoch = rolls.at(-1)!.epoch;
			const memberAtEnd = (await writer.authorityEpoch()) ?? 0;
			const finished = installs.filter((install) => install.ok === true);
			process.stdout.write(
				`SLOW_MEMBER_ROLLED ${JSON.stringify({ rolledFor, creatorEpoch, memberAtEnd, installs, stats: await writer.successorDelivery?.() })}\n`
			);
			const perInstall = INSTALL_START_DELAY_MS * 1.25 + 5_000;
			// Each skip install leaves a departed journal scope; past the 7-scope bound a member whose
			// skips leak them refuses its next install ("journal retirement refused").
			const skips = completedSkips();
			expect(skips, "skip installs while the creator rolled").toBeGreaterThanOrEqual(minSkips);
			if (conserve) {
				// Counts, not wall-clock: every completed install advanced the member, and its epoch kept
				// advancing across the slow phase.
				for (const install of finished) expect(install.epochAfter ?? 0, "an install advanced the member").toBeGreaterThan(install.epochBefore);
				expect(memberAtEnd).toBeGreaterThan(2);
				// The creator stops: the member reaches its epoch (generous bound: host load is noise).
				await wire.caughtUp(creatorEpoch, CONSERVE_BOUND_MS);
			} else {
				// While the creator rolled, the member followed it: it installed repeatedly and every
				// install advanced its epoch, never stuck. Counts, not wall clock: how many installs fit in
				// the rolling period depends on the host's speed (the creator's rolls and the member's
				// installs scale differently), so only "at least two" is host independent.
				expect(finished.length, "installs that completed while the creator rolled").toBeGreaterThanOrEqual(2);
				for (const install of finished) expect(install.epochAfter ?? 0, "an install advanced the member").toBeGreaterThan(install.epochBefore);
				expect(creatorEpoch - memberAtEnd, "the member's lag when the creator stopped").toBeLessThanOrEqual(
					Math.ceil(perInstall / (rolledFor / rollCount)) + 2
				);
				// The creator stops: the member reaches its epoch within one more install.
				await wire.caughtUp(creatorEpoch, perInstall * 2 + 30_000);
			}
			stopped = true;
			await memberMoves;
			// Every move the member made was accepted by its room (none was refused for an install).
			expect(issued.filter((move) => move.error !== undefined)).toEqual([]);
			// Each move waited at most for one install in flight (plus its own issue).
			if (!conserve) for (const move of issued) expect(move.ms, move.id).toBeLessThan(perInstall * 2);
			if (!conserve) return;

			// Conservation: every move lands on the creator exactly once. Moves made in an epoch the
			// creator had closed come back through the settlement window and are offered again once the
			// member's moves reach the creator, so the member is fast again from here (a member that stays
			// slower than the creator stays behind it, and its moves wait, kept). The creator keeps
			// rolling at a person's pace (its moves every 300 ms) while they land.
			slow = false;
			let landingPolls = 0;
			await trace("caught-up");
			const writerAuthor = rowValue((await writer.published(null))[0]!).author;
			const ids = issued.map((move) => move.id);
			await waitFor(
				"the creator admits every move of the member",
				async () => {
					const counts = await acceptedCounts(creator, writerAuthor, ids);
					if (counts.some((count) => count === 0)) {
						await creator.issue(0, ordinal.next++);
						await sleep(LANDING_CREATOR_MOVE_MS);
						if (++landingPolls % Math.max(1, Math.round(15_000 / LANDING_CREATOR_MOVE_MS)) === 0) await trace("landing");
					}
					return { counts, status: await writer.rolloverStatus?.() };
				},
				(value) => value.counts.every((count) => count >= 1),
				CONSERVE_BOUND_MS
			);
			// Close the epoch they landed in; the member follows it.
			const epoch = await rollCreator(creator, async () => undefined, ordinal);
			await wire.caughtUp(epoch, CONSERVE_BOUND_MS);
			await sleep(1_000);
			expect(await acceptedCounts(creator, writerAuthor, ids)).toEqual(ids.map(() => 1));
			expect(await writer.state()).toBe(await creator.state());
			const delivery = (await writer.successorDelivery?.()) as { refusals?: readonly string[] } | undefined;
			expect(
				(delivery?.refusals ?? []).filter((refusal) => refusal.includes("journal retirement refused")),
				"journal retirement refusals"
			).toEqual([]);
		} finally {
			stopped = true;
			pumping = false;
			await pump;
			await watchGivenBack;
			// The summary is observation only: a call that does not answer is recorded, never awaited forever.
			const within = <T,>(value: Promise<T> | undefined): Promise<T | string | undefined> =>
				Promise.race([Promise.resolve(value), sleep(15_000).then(() => "NO-ANSWER-15S")]);
			const own = (await writer.published(null)).map((row) => {
				const value = rowValue(row);
				return [value.authorSequence, value.epoch, value.operation.action, value.operation.id];
			});
			process.stdout.write(
				`SLOW_MEMBER_SUMMARY ${JSON.stringify({ givenBack: [...givenBack.values()], carrierEvents, journal: journalRetirement(directory, "recipient"), own, plan: await within(writer.settlementAudit()), rolls, issued, installs, member: await within(writer.successorDelivery?.()), creatorErrors: await within(creator.rollover?.().then((rollover) => rollover?.errors)), memberErrors: await within(writer.rollover?.().then((rollover) => rollover?.errors)), status: await within(writer.rolloverStatus?.()) })}\n`
			);
			await wire.stop();
		}
	} finally {
		Reflect.deleteProperty(globalThis, "__warmProofEvent");
		restore();
	}
}

it(
	"a member whose installs start later than the creator's rollover cadence follows the creator and keeps issuing",
	() => slowFollow(false),
	900_000
);

// Moves the member made in epochs the creator had already closed, while it skip-installed (each
// install jumped several epochs), come back through the settlement window and must land once the
// member caught up: across at least eight skip installs (past the journal's 7-scope bound, which a
// skip install's departed scope used to leak into: fix/skip-scope-carrier), every move lands on the
// creator exactly once and the member never refuses an install.
it(
	"every move a slow member made across eight or more skip installs lands on the creator exactly once",
	() => slowFollow(true, ROLLS, Number(process.env.SLOW_MEMBER_CONSERVE_SKIPS ?? 8)),
	3_600_000
);

it("a move made straight to the room while the member's install runs lands after the install, exactly once", async () => {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-slow-member-issue-"));
	directories.push(directory);
	// The member's material requests wait on this gate (the install is in flight meanwhile).
	let gate: { opened: Promise<void>; open(): void; reached(): void; arrived: Promise<void> } | undefined;
	const newGate = () => {
		let open!: () => void;
		let reached!: () => void;
		const opened = new Promise<void>((resolve) => (open = resolve));
		const arrived = new Promise<void>((resolve) => (reached = resolve));
		return { opened, open, reached, arrived };
	};
	try {
		const { creator, writer } = await openPair(directory, {
			relay: async (request, forward) => {
				const selected = gate;
				if (selected !== undefined) {
					selected.reached();
					await selected.opened;
				}
				return forward();
			},
		});
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		try {
			// Connected for two epochs: rows both ways, one member move each.
			let epoch = 0;
			for (let n = 0; n < 2; n++) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await writer.issue(epoch, n);
				await rows.toCreator();
			}
			const writerAuthor = rowValue((await writer.published(null))[0]!).author;
			// The next install holds at its material fetch.
			gate = newGate();
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await gate.arrived;
			const before = (await writer.authorityEpoch()) ?? 0;
			expect(before, "the member is still in the previous epoch while its install runs").toBe(epoch - 1);
			// A move straight to the room while the install runs.
			const outcome = writer.issueRoom!(before, 10).then(
				() => ({ ok: true as const }),
				(error: unknown) => ({ ok: false as const, error: String(error) })
			);
			await sleep(1_500);
			const selected = gate;
			gate = undefined;
			selected.open();
			await wire.caughtUp(epoch);
			expect(await outcome, "the move made during the install").toEqual({ ok: true });
			// It was issued after the install, in the installed epoch, once.
			const own = (await writer.published(null)).filter((row) => rowValue(row).operation.id === "block-1-10");
			expect(own.map((row) => rowValue(row).epoch)).toEqual([epoch]);
			await rows.toWriter();
			await rows.toCreator();
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch);
			await rows.toWriter();
			await rows.toCreator();
			expect(await acceptedCounts(creator, writerAuthor, ["block-1-0", "block-1-1", "block-1-10"])).toEqual([1, 1, 1]);
			expect(await writer.state()).toBe(await creator.state());
		} finally {
			gate?.open();
			process.stdout.write(
				`SLOW_MEMBER_ISSUE_SUMMARY ${JSON.stringify({ member: await writer.successorDelivery?.(), status: await writer.rolloverStatus?.() })}\n`
			);
			await wire.stop();
		}
	} finally {
		restore();
	}
}, 600_000);
