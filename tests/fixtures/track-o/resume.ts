/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference. */
import { RoomRetentionRefusal } from "@ts-drp/storage/room-head";
import { expect } from "vitest";

import {
	dumpDatabase,
	installEnvironment,
	lullFixture,
	type LullFixture,
	type OpenedRoom,
	required,
	rollover,
	transition,
} from "../track-m/room-retention-fixture.js";
import { advancedControl, type Dump, foreignWrite, ownedDifference, readRow } from "../track-m/room-retention-probe.js";

// Track O: crash and refusal between the transactions of ONE boundary on the opt-in
// room retention path (Track M's 14f case 8 and every other split point), at node level
// on the browser room database host (fake-indexeddb: mechanism evidence; the native
// engines with a real SIGKILL are the 14f harness).
//
// A boundary's retention pass commits one or more room transactions (continuations of
// its decisions). Every committed prefix of them is a durable state. From each such
// state, the next pass (after a crash: a reopen; after a refusal: the same lull's next
// pass) must resume and reach the crash-free durable end state, with no unclassified
// dependency and no halt.
//
// - A "kill" is a throw right after a continuation's checkpoint committed: the node aborts
//   the session (nothing else commits), the lull fails, and both rooms are closed and
//   reopened from the same databases. The fixture checks that nothing changed in the room
//   database between the kill and the reopen, so the reopened state is exactly the
//   committed prefix a SIGKILL there leaves.
// - A "refusal" is a genuine owner refusal of the continuation that follows: stale (a
//   foreign writer changed a row it names, restored after the abort), budget or capacity
//   (its step B runs with a lowered per-transaction bound; tests may lower, never raise).
// - "one-unit" continuations: the session refuses RETENTION_CAPACITY for any plan that
//   carries more than one unit, as a per-transaction cap of one unit would. The node's
//   own planner then splits every decision into one-unit continuations, so a kill can
//   land between any two units. A unit is what the planner never splits: the snapshot
//   turnover, one journal header, one journal prefix, one epoch's signing work, or one
//   AHE generation unit.

export const STEADY = 5;
export const RECOVERY_ROLLOVERS = 3;

export type Event = Readonly<Record<string, unknown>>;
export type Role = "creator" | "observer";
export const UNIT_KINDS = Object.freeze([
	"snapshot",
	"journal-header",
	"journal-prefix",
	"signing-evidence",
	"signing-summary",
	"ahe",
] as const);
export type UnitKind = (typeof UNIT_KINDS)[number];

type Selection = Readonly<{
	objectId: string;
	snapshot: Readonly<{ retire: readonly unknown[] }>;
	journal: Readonly<{ prefixes: readonly unknown[]; headers: readonly unknown[] }>;
	signing: Readonly<{
		evidence: readonly Readonly<{ key: readonly unknown[] }>[];
		summaries: readonly Readonly<{ store: string; key: readonly unknown[] }>[];
	}>;
	ahe: Readonly<{ units: readonly unknown[] }>;
}>;

/** The unit kinds one selection carries, with how many of each. */
export function unitsOf(value: unknown): Readonly<Record<UnitKind, number>> & Readonly<{ total: number }> {
	const selection = value as Selection;
	const evidenceEpochs = new Set(selection.signing.evidence.map((entry) => Number(entry.key[1])));
	const summaryEpochs = new Set(selection.signing.summaries.map((entry) => Number(entry.key[1])));
	const signingEpochs = new Set([...evidenceEpochs, ...summaryEpochs]);
	const counts = {
		"snapshot": selection.snapshot.retire.length === 0 ? 0 : 1,
		"journal-header": selection.journal.headers.length,
		"journal-prefix": selection.journal.prefixes.length,
		"signing-evidence": evidenceEpochs.size,
		"signing-summary": summaryEpochs.size,
		"ahe": selection.ahe.units.length,
	};
	return Object.freeze({
		...counts,
		// One epoch's signing work (its evidence, its summaries, or both) is one unit.
		total: counts.snapshot + counts["journal-header"] + counts["journal-prefix"] + signingEpochs.size + counts.ahe,
	});
}

/** What the interruption hooks do in one lull. */
export interface Interruption {
	/** The database whose lull is interrupted. */
	readonly role: Role;
	/** Every continuation carries one unit (a per-transaction cap of one unit). */
	readonly oneUnit?: boolean;
	/** Throw right after the checkpoint of the continuation that carries the `occurrence`-th unit of `kind`. */
	readonly kill?: Readonly<{ kind: UnitKind; occurrence?: number }>;
	/** Refuse the continuation that follows the one carrying the first unit of `after`. */
	readonly refuse?: Readonly<{ after: UnitKind; kind: "stale" | "budget" | "capacity"; occurrence?: number }>;
}

/** What one interrupted lull did. */
export interface InterruptionReport {
	/** The unit kinds of every committed continuation, in order. */
	readonly committed: readonly (Readonly<Record<UnitKind, number>> & Readonly<{ total: number }>)[];
	readonly killed: boolean;
	/** The room database at the kill (owned rows), to compare with the reopened state. */
	readonly killDump?: Dump;
	readonly refused: boolean;
	readonly refusal?: unknown;
	/** The refused continuation's units (what the next pass must still retire). */
	readonly refusedUnits?: Readonly<Record<UnitKind, number>> & Readonly<{ total: number }>;
	/** How many continuations had committed when the refusal aborted (later passes may commit more). */
	readonly committedAtRefusal?: number;
	readonly plans: number;
}

class Killed extends Error {
	constructor() {
		super("TRACK_O_KILLED");
		this.name = "TrackOKilled";
	}
}

type Session = Record<string, (...args: unknown[]) => Promise<unknown>>;

/**
 * Installs the interruption around every retention session of `role` on this fixture's
 * host. Sessions that never plan (the existing path's) pass through untouched.
 * @returns The live report and the release.
 */
export function interrupt(fixture: LullFixture, interruption: Interruption) {
	const committed: (Readonly<Record<UnitKind, number>> & Readonly<{ total: number }>)[] = [];
	const seen: Partial<Record<UnitKind, number>> = {};
	let killed = false,
		killDump: Dump | undefined,
		refused = false,
		refusal: unknown,
		refusedUnits: (Readonly<Record<UnitKind, number>> & Readonly<{ total: number }>) | undefined,
		committedAtRefusal: number | undefined,
		plans = 0,
		armed = false,
		poison: { database: string; store: string; key: unknown; value: unknown } | undefined;
	fixture.host.setWrap((raw, label, database) => {
		if (label !== interruption.role) return raw;
		const session = raw as unknown as Session;
		let pending: (Readonly<Record<UnitKind, number>> & Readonly<{ total: number }>) | undefined;
		let refuseThis = false;
		const call = (name: string) => required(session[name]);
		const dead = (): never => {
			throw new Killed();
		};
		return Object.freeze({
			...raw,
			planRetention: async (...args: unknown[]) => {
				if (killed) return dead();
				plans++;
				const units = unitsOf(args[1]);
				if (interruption.oneUnit === true && units.total > 1)
					throw new RoomRetentionRefusal("RETENTION_CAPACITY", "track-o:one-unit");
				if (armed && interruption.refuse?.kind === "stale" && poison === undefined) {
					// A foreign writer moves the signing owner's control, which every continuation
					// relies on (step B compares it exactly); restored after the abort.
					const key = `signing-retirement:${(args[1] as Selection).objectId}`;
					const value = required(await readRow(database, "storageMeta", key));
					poison = { database, store: "storageMeta", key, value };
					await foreignWrite(database, [{ store: "storageMeta", key, value: advancedControl(value) }]).committed;
				}
				if (armed) {
					refuseThis = true;
					refusedUnits = units;
				}
				return call("planRetention")(...args);
			},
			applyRetention: async (...args: unknown[]) => {
				if (killed) return dead();
				const selection = args[1];
				pending = unitsOf(selection);
				if (refuseThis && interruption.refuse !== undefined && interruption.refuse.kind !== "stale") {
					// The same genuine step B on a lowered bound (never raised).
					const options = (args[3] ?? {}) as Readonly<{
						limits?: Readonly<{ maxWrites: number; maxChargedBytes: number }>;
					}>;
					const limits =
						interruption.refuse.kind === "budget"
							? { maxWrites: options.limits?.maxWrites ?? 512, maxChargedBytes: 0 }
							: { maxWrites: 0, maxChargedBytes: options.limits?.maxChargedBytes ?? 4_194_304 };
					args[3] = { ...options, limits };
				}
				return call("applyRetention")(...args);
			},
			checkpoint: async () => {
				if (killed) return dead();
				await call("checkpoint")();
				const units = pending;
				pending = undefined;
				if (units === undefined) return;
				committed.push(units);
				for (const kind of UNIT_KINDS) if (units[kind] > 0) seen[kind] = (seen[kind] ?? 0) + 1;
				const kill = interruption.kill;
				if (kill !== undefined && units[kill.kind] > 0 && seen[kill.kind] === (kill.occurrence ?? 1)) {
					killed = true;
					killDump = await dumpDatabase(database);
					throw new Killed();
				}
				const refuse = interruption.refuse;
				if (
					refuse !== undefined &&
					!armed &&
					!refused &&
					units[refuse.after] > 0 &&
					seen[refuse.after] === (refuse.occurrence ?? 1)
				)
					armed = true;
			},
			commit: async () => {
				if (killed) return dead();
				return call("commit")();
			},
			abort: async (cause?: unknown) => {
				await call("abort")(cause);
				if (refuseThis && !refused) {
					refused = true;
					refusal = cause;
					committedAtRefusal = committed.length;
					armed = false;
					refuseThis = false;
				}
				if (poison !== undefined) {
					const restore = poison;
					poison = undefined;
					await foreignWrite(restore.database, [{ store: restore.store, key: restore.key, value: restore.value }])
						.committed;
				}
			},
		});
	});
	return Object.freeze({
		report: (): InterruptionReport => ({
			committed: [...committed],
			killed,
			...(killDump === undefined ? {} : { killDump }),
			refused,
			...(refused ? { refusal } : {}),
			...(refusedUnits === undefined ? {} : { refusedUnits }),
			...(committedAtRefusal === undefined ? {} : { committedAtRefusal }),
			plans,
		}),
		release: () => fixture.host.setWrap(undefined),
	});
}

/** One room database's normalized census: per store, its row count and the epochs its keys name. */
export type Census = Readonly<Record<string, Readonly<{ count: number; epochs: readonly number[] }>>>;

export function censusOf(dump: Dump, objectId: string): Census {
	const out: Record<string, { count: number; epochs: number[] }> = {};
	for (const [store, rows] of Object.entries(dump)) {
		const epochs = rows
			.flatMap(([key]) =>
				Array.isArray(key) && key[0] === objectId && Number.isSafeInteger(key[1]) ? [key[1] as number] : []
			)
			.sort((a, b) => a - b);
		out[store] = { count: rows.length, epochs };
	}
	return out;
}

/** The signing control a room database holds (storageMeta `signing-retirement:<object>`). */
export function signingControl(dump: Dump, objectId: string) {
	const row = (dump.storageMeta ?? []).find(([key]) => key === `signing-retirement:${objectId}`);
	return (row?.[1] as { value?: unknown } | undefined)?.value as
		| Readonly<{
				completed: Readonly<{
					throughEpoch: number;
					protectedEpochs: readonly number[];
					summarySource?: unknown;
				}> | null;
				drain?: unknown;
		  }>
		| undefined;
}

/**
 * The signing rows of epochs the room's own signing control already retires (at most
 * `through`, not protected). After a completed boundary there are none: they are rows no
 * later pass would select and whose authority the AHE owner may then retire.
 */
export function retiredSigningRows(dump: Dump, objectId: string): readonly string[] {
	const control = signingControl(dump, objectId);
	const completed = control?.completed;
	if (completed == null) return [];
	const out: string[] = [];
	for (const store of ["signerState", "sealEvidence", "voteSlots", "voteOutbox"])
		for (const [key] of dump[store] ?? []) {
			const epoch = (key as unknown[])[1] as number;
			if (epoch <= completed.throughEpoch && !completed.protectedEpochs.includes(epoch))
				out.push(`${store} ${JSON.stringify(key)}`);
		}
	return out;
}

/** The rooms of one scenario. */
export interface Rooms {
	readonly fixture: LullFixture;
	creator: OpenedRoom;
	recipient: OpenedRoom;
}

/** STEADY rollovers with both lulls, then the transition into the boundary under test. */
export async function steadyRooms(seed: string): Promise<Rooms> {
	const fixture = await lullFixture({ retention: true, creatorLull: true, seed });
	const creator = await fixture.open("creator", fixture.creator);
	const recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	for (let epoch = 0; epoch < STEADY; epoch++) await rollover(fixture, creator, recipient, epoch);
	await transition(fixture, creator, recipient, STEADY);
	return { fixture, creator, recipient };
}

/** Closes both rooms (after a kill, nothing more commits). */
export async function closeBoth(rooms: Rooms): Promise<void> {
	await rooms.fixture.stop(rooms.recipient);
	await rooms.fixture.stop(rooms.creator);
}

/** Reopens both rooms from the same databases. */
export async function openBoth(rooms: Rooms): Promise<void> {
	rooms.creator = await rooms.fixture.open("creator", rooms.fixture.creator, { reopen: true });
	rooms.recipient = await rooms.fixture.open("observer", rooms.fixture.observer, { reopen: true, receiveOnly: true });
}

/** What the room did after the boundary under test. */
export interface Recovery {
	/** Per later rollover: both lull results and both rooms' census after it. */
	readonly rollovers: readonly Readonly<{
		epoch: number;
		creatorLull: unknown;
		recipientLull: unknown;
		creator: Census;
		observer: Census;
		creatorRetiredSigning: readonly string[];
	}>[];
	readonly failed?: Readonly<{ epoch: number; error: string }>;
}

const describe = (error: unknown): string =>
	error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error);

/** RECOVERY_ROLLOVERS more rollovers with both lulls, with each room's census after each. */
export async function recover(rooms: Rooms): Promise<Recovery> {
	const out: Recovery["rollovers"][number][] = [];
	for (let index = 0; index < RECOVERY_ROLLOVERS; index++) {
		const epoch = STEADY + 1 + index;
		let lulls: Awaited<ReturnType<typeof rollover>>;
		try {
			lulls = await rollover(rooms.fixture, rooms.creator, rooms.recipient, epoch);
		} catch (error) {
			return { rollovers: out, failed: { epoch, error: describe(error) } };
		}
		const creatorDump = await dumpDatabase(rooms.fixture.host.database("creator"));
		const observerDump = await dumpDatabase(rooms.fixture.host.database("observer"));
		out.push({
			epoch,
			creatorLull: lulls.creatorLull,
			recipientLull: lulls.recipientLull,
			creator: censusOf(creatorDump, rooms.fixture.objectId),
			observer: censusOf(observerDump, rooms.fixture.objectId),
			creatorRetiredSigning: retiredSigningRows(creatorDump, rooms.fixture.objectId),
		});
	}
	return { rollovers: out };
}

/** Records every proof event (retention passes and acquisition refusals included). */
export function observeEvents() {
	const events: Event[] = [];
	const restore = installEnvironment((event) => events.push(event));
	return Object.freeze({ events, restore });
}

/** The census stores whose rows only retirement decides (controls differ by decision labels). */
const DATA_STORE = /^(?!.*(retirementControls|storageMeta|snapshot:owner|room:layout)).*/;

/** Same durable end state: per data store, the same count and the same epochs. */
export function expectSameEndState(actual: Recovery, reference: Recovery): void {
	expect(actual.failed).toBeUndefined();
	expect(actual.rollovers.map((item) => item.epoch)).toEqual(reference.rollovers.map((item) => item.epoch));
	for (const [index, item] of actual.rollovers.entries()) {
		const expected = required(reference.rollovers[index]);
		expect({ epoch: item.epoch, creatorLull: item.creatorLull, recipientLull: item.recipientLull }).toEqual({
			epoch: expected.epoch,
			creatorLull: expected.creatorLull,
			recipientLull: expected.recipientLull,
		});
		for (const role of ["creator", "observer"] as const) {
			const pick = (census: Census) =>
				Object.fromEntries(Object.entries(census).filter(([store]) => DATA_STORE.test(store)));
			expect({ epoch: item.epoch, role, census: pick(item[role]) }).toEqual({
				epoch: item.epoch,
				role,
				census: pick(expected[role]),
			});
		}
		expect(item.creatorRetiredSigning).toEqual([]);
	}
}

/** No acquisition after `from` refused, and no unclassified signing dependency was seen. */
export function expectNoRefusedAcquisition(events: readonly Event[], from: number): void {
	const refused = events
		.slice(from)
		.filter(
			(event) =>
				event.kind === "closed-data-acquisition-refused" ||
				String(event.message ?? "").includes("UNCLASSIFIED_SIGNING_DEPENDENCY")
		)
		.map((event) => ({ kind: event.kind, refusal: event.refusal, message: event.message }));
	expect(refused).toEqual([]);
}

/** The room database did not change between the kill and the reopen. */
export async function expectUnchangedSinceKill(rooms: Rooms, role: Role, report: InterruptionReport): Promise<void> {
	expect(report.killed).toBe(true);
	const now = await dumpDatabase(rooms.fixture.host.database(role));
	expect(ownedDifference(required(report.killDump), now)).toEqual([]);
}

/** The unit kinds of one committed continuation, as a compact label (e.g. "journal-prefix"). */
export function kindsOf(units: Readonly<Record<UnitKind, number>>): string {
	return UNIT_KINDS.filter((kind) => units[kind] > 0)
		.map((kind) => (units[kind] > 1 ? `${kind}x${units[kind]}` : kind))
		.join("+");
}

/**
 * The boundary under test for one role, as the integrated rollover runs it: the creator's
 * lull, then the recipient's. Only `interruption.role`'s lull is interrupted; when the
 * creator is the role, the recipient's lull of this boundary does not run (the creator's
 * process died or the scenario ends there).
 */
export async function boundary(rooms: Rooms, interruption: Interruption) {
	if (interruption.role === "observer")
		expect(await rooms.creator.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
	const trap = interrupt(rooms.fixture, interruption);
	const opened = interruption.role === "creator" ? rooms.creator : rooms.recipient;
	let lull: unknown;
	try {
		lull = await opened.room.maintainRecoveryPool();
	} catch (error) {
		lull = { failed: describe(error) };
	} finally {
		trap.release();
	}
	return Object.freeze({ lull, report: trap.report() });
}
