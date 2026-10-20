import { decodeGenerationRecordV1, encodeGenerationRecordV1 } from "@ts-drp/storage";
import { roomRetentionSourceDigest } from "@ts-drp/storage/room-head";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	closeFixtures,
	dumpDatabase,
	installEnvironment,
	lullFixture,
	type LullFixture,
	type OpenedRoom,
	required,
	rollover,
	transition,
} from "./fixtures/track-m/room-retention-fixture.js";
import {
	type Dump,
	foreignWrite,
	ownedDifference,
	rowId,
	rowsOf,
	stable,
	trapRetention,
} from "./fixtures/track-m/room-retention-probe.js";

// Track M, slice 14e RED 1-4 (retention bounds and charges), on the browser room database
// host (fake-indexeddb: mechanism evidence; native engines are slice 14f). The per-
// transaction caps are parameters a test may LOWER (never raise): a decision over the cap
// in these rooms is reached by lowering the cap below the decision's real size. The
// default caps are 512 writes and 4,194,304 charged bytes (ROOM_RETENTION_LIMITS).

type Event = Readonly<Record<string, unknown>>;
type Session = Record<string, (...args: unknown[]) => Promise<unknown>>;
interface Planned {
	readonly decisionDigest: string;
	readonly writes: number;
	readonly charged: number;
}
interface OwnerDecision {
	readonly delete: readonly Readonly<{ store: string; key: unknown }>[];
	readonly rewrite: readonly Readonly<{ store: string; key: unknown }>[];
}
type TraceEvent = Readonly<{ kind: string; total?: number; bytes?: number }>;

const events: Event[] = [];
let restore: (() => void) | undefined;
beforeEach(() => {
	events.length = 0;
	restore = installEnvironment((event) => {
		if (String(event.kind ?? "").startsWith("room-retention")) events.push(event);
	});
});
afterEach(async () => {
	restore?.();
	expect(await closeFixtures()).toEqual([]);
});

const STEADY = 5;
type Room = Readonly<{ fixture: LullFixture; creator: OpenedRoom; recipient: OpenedRoom }>;

async function steady(seed: string): Promise<Room> {
	const fixture = await lullFixture({ retention: true, creatorLull: true, seed });
	const creator = await fixture.open("creator", fixture.creator);
	const recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	for (let epoch = 0; epoch < STEADY; epoch++) await rollover(fixture, creator, recipient, epoch);
	await transition(fixture, creator, recipient, STEADY);
	return { fixture, creator, recipient };
}

function setLimits(limits: Readonly<{ maxWrites?: number; maxChargedBytes?: number }> | undefined): void {
	if (limits === undefined) Reflect.deleteProperty(globalThis, "__roomRetentionLimits");
	else Reflect.set(globalThis, "__roomRetentionLimits", limits);
}

/**
 * Inside the lull's first retention decision (before the node's own step B), a second
 * genuine session plans the SAME selection and applies it with `limits`; returns the
 * refusal and the owned rows it changed (it then aborts, and the node's lull goes on).
 */
async function applyBeside(
	room: Room,
	limits: (planned: Planned) => Readonly<{ maxWrites: number; maxChargedBytes: number }>
): Promise<Readonly<{ refusal: unknown; changed: string[]; planned: Planned }>> {
	let refusal: unknown,
		changed: string[] | undefined,
		planned: Planned | undefined,
		done = false;
	const trap = trapRetention(room.fixture, {
		beforeFirstPlan: async ({ database, selection, owners }) => {
			if (done) return;
			done = true;
			const other = (await room.fixture.host.storageHost.openRoomRetirement("creator")) as unknown as Session;
			const before: Dump = await dumpDatabase(database);
			try {
				planned = (await required(other.planRetention)(owners, selection)) as Planned;
				await required(other.applyRetention)(
					owners,
					selection,
					{
						throughEpoch: (selection as { throughEpoch: number }).throughEpoch,
						decisionDigest: planned.decisionDigest,
						sourceProofDigest: roomRetentionSourceDigest(selection as never),
					},
					{ limits: limits(planned) }
				);
				await required(other.commit)();
			} catch (error) {
				refusal = error;
				await required(other.abort)(error).catch(() => undefined);
			}
			changed = ownedDifference(before, await dumpDatabase(database));
		},
	});
	try {
		expect(await room.creator.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
	} finally {
		trap.release();
	}
	return { refusal, changed: required(changed), planned: required(planned) };
}

describe("14e RED 1: the per-transaction write cap", () => {
	it("a decision over the cap refuses RETENTION_CAPACITY in step B with zero writes", async () => {
		const room = await steady("track-m-bounds-capacity");
		const result = await applyBeside(room, (planned) => ({
			maxWrites: planned.writes - 1,
			maxChargedBytes: 4_194_304,
		}));
		expect(result.planned.writes).toBeGreaterThan(1);
		expect(result.refusal).toMatchObject({ code: "RETENTION_CAPACITY" });
		expect(result.changed).toEqual([]);
	}, 600_000);

	it("the planner splits an over-cap decision into continuations that each commit whole", async () => {
		// The same room twice (same seed, same history): the first lull, on the default cap,
		// names its largest multi-unit decision; the second room's lull runs one write under
		// it, so that decision cannot commit whole while every proper part of it can.
		const probe = await steady("track-m-bounds-split");
		const probed = events.length;
		expect(await probe.creator.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
		const whole = required(events.slice(probed).find((event) => event.kind === "room-retention-pass"));
		expect(whole).toMatchObject({ outcome: "applied" });
		const sizes = (whole.decisions as readonly Readonly<{ items: number; writes: number }>[])
			.filter((report) => report.items >= 2)
			.map((report) => report.writes);
		expect(sizes.length).toBeGreaterThan(0);
		await probe.fixture.stop(probe.recipient);
		await probe.fixture.stop(probe.creator);
		const room = await steady("track-m-bounds-split");
		const database = room.fixture.host.database("creator");
		const cap = Math.max(...sizes) - 1;
		setLimits({ maxWrites: cap });
		const continuations: { applied: Readonly<Record<string, unknown>>; before: Dump; after?: Dump }[] = [];
		let current: Dump | undefined;
		const trap = trapRetention(room.fixture, {
			beforeFirstPlan: async () => {
				current = await dumpDatabase(database);
			},
			afterApply: ({ applied }) => {
				continuations.push({ applied, before: required(current) });
			},
			afterCommit: async ({ kind }) => {
				if (kind !== "checkpoint") return;
				const last = required(continuations.at(-1));
				last.after = await dumpDatabase(database);
				current = last.after;
			},
		});
		const before = events.length;
		try {
			expect(await room.creator.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
		} finally {
			trap.release();
			setLimits(undefined);
		}
		const pass = required(events.slice(before).find((event) => event.kind === "room-retention-pass"));
		expect(pass).toMatchObject({ outcome: "applied" });
		const reports = pass.decisions as readonly Readonly<{ decision: number; writes: number }>[];
		// More continuations than decisions: the decisions were split.
		expect(new Set(reports.map((report) => report.decision)).size).toBeLessThan(reports.length);
		expect(continuations.length).toBe(reports.length);
		for (const continuation of continuations) {
			const decision = continuation.applied.decision as { owners: Record<string, OwnerDecision | undefined> };
			expect(continuation.applied.writes as number).toBeLessThanOrEqual(cap);
			// Whole: exactly the named rows are gone, and only named rows or controls changed.
			const physical = (owner: string, store: string): string =>
				continuation.before[`${owner}:${store}`] !== undefined ? `${owner}:${store}` : store;
			const deleted = new Set<string>(),
				rewritten = new Set<string>();
			for (const [owner, section] of Object.entries(decision.owners)) {
				for (const row of section?.delete ?? []) deleted.add(rowId(physical(owner, row.store), row.key));
				for (const row of section?.rewrite ?? []) rewritten.add(rowId(physical(owner, row.store), row.key));
			}
			const difference = ownedDifference(continuation.before, required(continuation.after));
			const removed = difference.filter((line) => line.startsWith("removed ")).map((line) => line.slice(8));
			expect(new Set(removed)).toEqual(deleted);
			const other = difference
				.filter((line) => !line.startsWith("removed "))
				.map((line) => line.replace(/^(changed|added) /, ""))
				.filter((id) => !rewritten.has(id) && !/retirementControls|ahe:.*meta|storageMeta/.test(id));
			expect(other).toEqual([]);
		}
	}, 600_000);

	it("a single unit over the cap retains (the existing path runs from a fresh acquisition)", async () => {
		const room = await steady("track-m-bounds-unit");
		const database = room.fixture.host.database("creator");
		setLimits({ maxWrites: 1 });
		let before: Dump | undefined, after: Dump | undefined;
		const trap = trapRetention(room.fixture, {
			beforeFirstPlan: async () => {
				before ??= await dumpDatabase(database);
			},
			afterAbort: async () => {
				after ??= await dumpDatabase(database);
			},
		});
		const first = events.length;
		try {
			expect(await room.creator.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
		} finally {
			trap.release();
			setLimits(undefined);
		}
		expect(events.slice(first).find((event) => event.kind === "room-retention-pass")).toMatchObject({
			outcome: "retained",
			reason: "unit-over-cap",
		});
		expect(ownedDifference(required(before), required(after))).toEqual([]);
	}, 600_000);
});

describe("14e RED 2: the charged-read budget", () => {
	it("a decision whose reads exceed the budget refuses RETENTION_BUDGET in step B with zero writes", async () => {
		const room = await steady("track-m-bounds-budget");
		const result = await applyBeside(room, (planned) => ({ maxWrites: 512, maxChargedBytes: planned.charged - 1 }));
		expect(result.refusal).toMatchObject({ code: "RETENTION_BUDGET" });
		expect(result.changed).toEqual([]);
	}, 600_000);

	it("the lull retains on a lowered budget and the existing path runs", async () => {
		const room = await steady("track-m-bounds-budget-lull");
		setLimits({ maxChargedBytes: 1024 });
		const first = events.length;
		try {
			expect(await room.creator.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
		} finally {
			setLimits(undefined);
		}
		const pass = required(events.slice(first).find((event) => event.kind === "room-retention-pass"));
		expect(pass).toMatchObject({ outcome: "retained" });
		expect(String(pass.reason)).toMatch(/^RETENTION_BUDGET:/);
	}, 600_000);
});

describe("14e RED 3: charges precede the first write and are never refunded", () => {
	it("every step B trace charges before its first delete, rewrite or control write", async () => {
		const room = await steady("track-m-bounds-trace");
		const traces: { trace: readonly TraceEvent[]; charged: number }[] = [];
		const trap = trapRetention(room.fixture, {
			afterApply: ({ applied }) => {
				traces.push({ trace: applied.trace as readonly TraceEvent[], charged: applied.charged as number });
			},
		});
		try {
			expect(await room.creator.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
			expect(await room.recipient.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
		} finally {
			trap.release();
		}
		expect(traces.length).toBeGreaterThanOrEqual(2);
		for (const { trace, charged } of traces) {
			const lastCharge = trace.map((event) => event.kind).lastIndexOf("charge");
			const firstWrite = trace.findIndex((event) => event.kind !== "charge");
			expect(lastCharge).toBeGreaterThanOrEqual(0);
			expect(firstWrite).toBeGreaterThan(lastCharge);
			const totals = trace.filter((event) => event.kind === "charge").map((event) => required(event.total));
			for (let index = 1; index < totals.length; index++)
				expect(required(totals[index])).toBeGreaterThanOrEqual(required(totals[index - 1]));
			expect(totals.at(-1)).toBe(charged);
			// Every write is in the trace: deletes, rewrites and exactly five control writes.
			expect(trace.filter((event) => event.kind === "control").length).toBe(5);
		}
	}, 600_000);
});

describe("14e RED 4: census reads are bounded before they are issued", () => {
	it("an over-bound AHE census refuses without materialising more than bound + 1 rows", async () => {
		const room = await steady("track-m-bounds-census");
		const { fixture } = room;
		const BOUND = 7; // AHE_BOUNDED_READ_LIMITS.maxObjectGenerations
		const materialised: number[] = [];
		let watching = false,
			added: unknown[] = [],
			before: Dump | undefined,
			after: Dump | undefined;
		// Instrument every native read of the generations store while step B runs.
		const proto = globalThis.IDBObjectStore.prototype as unknown as Record<string, (...args: unknown[]) => IDBRequest>;
		const cursorProto = globalThis.IDBCursor.prototype as unknown as Record<string, (...args: unknown[]) => void>;
		const originals = {
			getAll: proto.getAll,
			getAllKeys: proto.getAllKeys,
			openCursor: proto.openCursor,
			cont: cursorProto.continue,
		};
		const generations = (store: IDBObjectStore): boolean => store.name.endsWith("generations");
		proto.getAll = function (this: IDBObjectStore, ...args: unknown[]) {
			const request = required(originals.getAll).apply(this, args);
			if (watching && generations(this))
				request.addEventListener("success", () => materialised.push((request.result as unknown[]).length));
			return request;
		};
		proto.getAllKeys = function (this: IDBObjectStore, ...args: unknown[]) {
			const request = required(originals.getAllKeys).apply(this, args);
			if (watching && generations(this))
				request.addEventListener("success", () => materialised.push((request.result as unknown[]).length));
			return request;
		};
		const cursors = new WeakMap<object, number>();
		proto.openCursor = function (this: IDBObjectStore, ...args: unknown[]) {
			const request = required(originals.openCursor).apply(this, args);
			if (watching && generations(this)) {
				const slot = materialised.push(0) - 1;
				request.addEventListener("success", () => {
					if (request.result !== null) {
						cursors.set(request.result as object, slot);
						materialised[slot] = required(materialised[slot]) + 1;
					}
				});
			}
			return request;
		};
		cursorProto.continue = function (this: IDBCursor, ...args: unknown[]) {
			const slot = cursors.get(this);
			if (slot !== undefined) materialised[slot] = required(materialised[slot]) + 1;
			required(originals.cont).apply(this, args);
		};
		const trap = trapRetention(fixture, {
			beforeFirstPlan: async ({ database }) => {
				if (before !== undefined) return;
				// A foreign writer adds BOUND + 1 well-formed generations (over the owner bound).
				const rows = await rowsOf(database, "ahe:generations");
				const [, value] = required(rows[0]);
				const row = value as Record<string, unknown>;
				const decoded = decodeGenerationRecordV1(row.record as Uint8Array);
				if (!decoded.ok) throw new TypeError("TRACK_M_GENERATION");
				const existing = new Set(rows.map(([key]) => String((key as unknown[])[1])));
				const puts = [];
				for (let index = 0; puts.length <= BOUND; index++) {
					const generationId = `${decoded.value.generationId.slice(0, -2)}${index.toString(16).padStart(2, "0")}`;
					if (existing.has(generationId)) continue;
					const record = encodeGenerationRecordV1({
						...decoded.value,
						generationId: generationId as typeof decoded.value.generationId,
					});
					puts.push({
						store: "ahe:generations",
						key: [decoded.value.objectId, generationId],
						value: { ...row, generationId, record },
					});
				}
				added = puts.map((put) => put.key);
				await foreignWrite(database, puts).committed;
				before = await dumpDatabase(database);
				watching = true;
			},
			afterAbort: async ({ database }) => {
				if (after !== undefined) return;
				watching = false;
				after = await dumpDatabase(database);
				await foreignWrite(
					database,
					[],
					added.map((key) => ({ store: "ahe:generations", key }))
				).committed;
			},
		});
		const first = events.length;
		try {
			expect(await room.creator.room.maintainRecoveryPool()).toMatchObject({ kind: "maintained" });
		} finally {
			trap.release();
			Object.assign(proto, {
				getAll: originals.getAll,
				getAllKeys: originals.getAllKeys,
				openCursor: originals.openCursor,
			});
			cursorProto.continue = required(originals.cont);
		}
		const pass = required(events.slice(first).find((event) => event.kind === "room-retention-pass"));
		expect(pass).toMatchObject({ outcome: "retained" });
		expect(String(pass.reason)).toMatch(/^RETENTION_CAPACITY:ahe:/);
		expect(ownedDifference(required(before), required(after))).toEqual([]);
		expect(materialised.length).toBeGreaterThan(0);
		expect(Math.max(...materialised), stable(materialised)).toBeLessThanOrEqual(BOUND + 1);
	}, 600_000);
});
