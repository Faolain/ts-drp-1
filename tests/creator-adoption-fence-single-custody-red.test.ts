// RED (read count, phase-time independent): the creator's steady-state adoption fence reads its
// retained closed data twice — once before native custody and again under it.
//
// The fence's cold maintenance proof (acquireCreatorIssuanceMaintenanceProof with
// mandatoryAdoptionFence) takes two optional "detached preparations" added for ordinary quotes:
//  - native: the journal, snapshot, AHE and floor retirement images are captured, every native
//    reservation is released, and `qualify` reacquires the reservations and captures (and
//    byte-compares) all four images and the snapshot inventory again;
//  - snapshot: every retained snapshot target is read in full (`captureCreatorClosedSnapshotEvidence`)
//    and then read in full again under a fresh protection by `qualifyPreparedSnapshots`.
// Each detached read is re-read under custody before the proof may be used, so neither saves
// authentication (G5): the bytes are read twice. The fence holds the issuance consumer
// exclusively and its forecast is short, so moving work out of custody buys it nothing.
// Chromium m40 (def0d5ef): closedData(incl.prepare+qualify).fence p50 127-262 ms of a
// creator.drain.fence p50 313-558 ms; fake-indexeddb: 1,488 IndexedDB requests p50 (max 2,171).
//
// Observed with product diagnostics only (`__warmProofEvent`) on the browser room database with
// retention (what a new Grid room opens on) over fake-indexeddb: mechanism and request counts, not
// engine timing. Each fence acquisition is bracketed by `closed-maintenance-acquisition-start|end`
// (purpose "adoption-fence"). Inside it the test counts:
//  - pre-custody reads that must be re-read under custody: `closed-native-preparation-detached`
//    (four images plus inventory) and `closed-snapshot-preparation-detached` (one retained target);
//  - IndexedDB requests, and repeated reads of the same (store, key), split by owner namespace and
//    by whether the repeat came from a different transaction (logged for the A/B, not asserted).
//
// Expected at the RED commit: every steady-state fence reads before custody (RED). A fix must read
// each retained byte once, under custody, with complete authentication (G5), the same book and
// limits (G10/G22), and must keep the fence's readiness hint joined (guarded below).
// Model: packages/node/formal/creator-fence-single-custody.qnt.
import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";

import { closeLongRooms, runLongRoom } from "./fixtures/track-m-apps/app-long-room.js";

afterEach(async () => {
	expect(await closeLongRooms()).toEqual([]);
});

const EPOCHS = 6;
const MOVES = 7;
// Epochs 1 and 2 still fill the retention window; steady state from the third adoption on.
const STEADY_FROM = 3;

type Seen = {
	kind: string;
	epoch: number | undefined;
	idb: number;
	reads: number;
	purpose?: unknown;
	outcome?: unknown;
};
type Read = { namespace: string; key: string; transaction: number };

function keyText(value: unknown): string {
	if (value === undefined || value === null) return "*";
	if (value instanceof globalThis.IDBKeyRange) return `[${keyText(value.lower)},${keyText(value.upper)}]`;
	if (Array.isArray(value)) return `(${value.map(keyText).join(",")})`;
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex");
	if (value instanceof ArrayBuffer) return Buffer.from(value).toString("hex");
	return typeof value === "string" ? value : String(value);
}

function repeats(
	reads: readonly Read[]
): Record<string, { requests: number; sameKey: number; crossTransaction: number }> {
	const out: Record<string, { requests: number; sameKey: number; crossTransaction: number }> = {};
	const byKey = new Map<string, Set<number>>();
	const counts = new Map<string, number>();
	for (const read of reads) {
		const row = (out[read.namespace] ??= { requests: 0, sameKey: 0, crossTransaction: 0 });
		row.requests += 1;
		const id = `${read.namespace}\u0000${read.key}`;
		const seen = counts.get(id) ?? 0;
		if (seen > 0) row.sameKey += 1;
		counts.set(id, seen + 1);
		const transactions = byKey.get(id) ?? new Set<number>();
		if (transactions.size > 0 && !transactions.has(read.transaction)) row.crossTransaction += 1;
		transactions.add(read.transaction);
		byKey.set(id, transactions);
	}
	return out;
}

it("the creator's steady-state adoption fence reads its retained closed data once, under custody", async () => {
	const idb = { n: 0 };
	const reads: Read[] = [];
	const transactions = new WeakMap<object, number>();
	let nextTransaction = 0;
	const transactionId = (transaction: object): number => {
		const known = transactions.get(transaction);
		if (known !== undefined) return known;
		nextTransaction += 1;
		transactions.set(transaction, nextTransaction);
		return nextTransaction;
	};
	const pointReads = new Set(["get", "getAll", "getAllKeys", "getKey", "count", "openCursor", "openKeyCursor"]);
	for (const [proto, isIndex] of [
		[globalThis.IDBObjectStore.prototype, false],
		[globalThis.IDBIndex.prototype, true],
	] as const) {
		for (const name of [...pointReads, "put", "add", "delete", "clear"]) {
			const original = Reflect.get(proto, name) as ((...args: unknown[]) => unknown) | undefined;
			if (typeof original !== "function") continue;
			Reflect.set(proto, name, function (this: IDBObjectStore | IDBIndex, ...args: unknown[]): unknown {
				idb.n += 1;
				if (pointReads.has(name)) {
					try {
						const store = isIndex ? (this as IDBIndex).objectStore : (this as IDBObjectStore);
						const label = isIndex ? `${store.name}#${(this as IDBIndex).name}` : store.name;
						reads.push({
							namespace: store.name.includes(":") ? store.name.slice(0, store.name.indexOf(":")) : "other",
							key: `${label}\u0000${name}\u0000${keyText(args[0])}`,
							transaction: transactionId(store.transaction),
						});
					} catch {
						/* Observation only. */
					}
				}
				return original.apply(this, args);
			});
		}
	}
	const cursorContinue = globalThis.IDBCursor.prototype.continue;
	globalThis.IDBCursor.prototype.continue = function (...args: Parameters<IDBCursor["continue"]>): void {
		idb.n += 1;
		return cursorContinue.apply(this, args);
	};
	const seen: Seen[] = [];
	let current: unknown = Reflect.get(globalThis, "__warmProofEvent");
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__warmProofEvent");
	// The room installs its own observer; every observer it installs is wrapped, unchanged.
	Object.defineProperty(globalThis, "__warmProofEvent", {
		configurable: true,
		get: (): unknown => current,
		set: (value: unknown): void => {
			current =
				typeof value === "function"
					? (event: unknown): unknown => {
							if (event !== null && typeof event === "object") {
								const e = event as Record<string, unknown>;
								seen.push({
									kind: String(e.kind),
									epoch: typeof e.epoch === "number" ? e.epoch : undefined,
									idb: idb.n,
									reads: reads.length,
									...(e.purpose === undefined ? {} : { purpose: e.purpose }),
									...(e.outcome === undefined ? {} : { outcome: e.outcome }),
								});
							}
							return (value as (event: unknown) => unknown)(event);
						}
					: value;
		},
	});
	try {
		await runLongRoom({
			app: "grid",
			host: "room-retention",
			recipient: "writer",
			creatorLull: true,
			epochs: EPOCHS,
			moves: MOVES,
		});
	} finally {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, "__warmProofEvent");
		else Object.defineProperty(globalThis, "__warmProofEvent", descriptor);
	}
	const fences = seen.flatMap((event, start) => {
		if (event.kind !== "closed-maintenance-acquisition-start" || event.purpose !== "adoption-fence") return [];
		const length = seen
			.slice(start + 1)
			.findIndex(
				(next) =>
					next.kind === "closed-maintenance-acquisition-end" || next.kind === "closed-maintenance-acquisition-start"
			);
		const end = length < 0 ? undefined : seen[start + 1 + length];
		if (end?.kind !== "closed-maintenance-acquisition-end") return [];
		const window = seen.slice(start, start + 2 + length);
		return [
			{
				epoch: event.epoch,
				nativeDetached: window.filter((next) => next.kind === "closed-native-preparation-detached").length,
				nativeDeclined: window.filter((next) => next.kind === "closed-native-preparation-declined").length,
				snapshotDetached: window.filter((next) => next.kind === "closed-snapshot-preparation-detached").length,
				snapshotDeclined: window.filter((next) => next.kind === "closed-snapshot-preparation-declined").length,
				idbRequests: end.idb - event.idb,
				reads: repeats(reads.slice(event.reads, end.reads)),
			},
		];
	});
	const readiness = seen
		.filter((event) => event.kind === "ordinary-readiness-source-refresh")
		.map((event) => ({ epoch: event.epoch, outcome: event.outcome }));
	console.info(`CREATOR_FENCE_SINGLE_CUSTODY ${JSON.stringify({ fences, readiness })}`);
	const steady = fences.filter((row) => (row.epoch ?? 0) >= STEADY_FROM);
	// Preconditions: every steady adoption's fence ran one complete bracketed acquisition.
	expect(steady.length, JSON.stringify(fences)).toBeGreaterThanOrEqual(EPOCHS - STEADY_FROM);
	// Guard (holds before the fix): the fence's source still hands readiness a joined refresh, so
	// the next epoch's ordinary moves stay warm.
	const steadyReadiness = readiness.filter((row) => (row.epoch ?? 0) >= STEADY_FROM);
	expect(steadyReadiness.length, JSON.stringify(readiness)).toBeGreaterThanOrEqual(EPOCHS - STEADY_FROM);
	expect(steadyReadiness.map((row) => row.outcome)).toEqual(steadyReadiness.map(() => "joined-refresh-delivery"));
	// THE assertion: no steady-state fence reads retained closed data before custody (which it then
	// has to read again under custody).
	expect(
		steady.map((row) => ({
			epoch: row.epoch,
			nativeDetached: row.nativeDetached,
			snapshotDetached: row.snapshotDetached,
		}))
	).toEqual(steady.map((row) => ({ epoch: row.epoch, nativeDetached: 0, snapshotDetached: 0 })));
}, 1_800_000);
