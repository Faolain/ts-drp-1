import "fake-indexeddb/auto";
import { createHash, createHmac } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	EpochRetirementError,
	EpochRetirementStore,
	hex,
	openEpochRetirementFloor,
	rowKeyText,
	type EpochRetirementFloorPort,
	type LegacyRetentionSource,
	type MigrationStep,
	type RetainedBlobInput,
	type RetainedRowInput,
	type RetainedRowKey,
	type RetirementDecision,
	type RetirementStep,
	type RowClass,
} from "./prototypes/epoch-retirement-store.js";

// Mechanism tests over fake-indexeddb. They are NOT native evidence (G28):
// strict durability, process death and cross-engine scheduling need the
// three-engine and SIGKILL harnesses.

const OWNERS = ["journal", "evidence", "summary", "issuance", "snapshot", "ahe"] as const;
const ROWS_PER_OWNER_EPOCH = 2;
const SCOPE = "room";
const CREATOR_KEY = "creator-signing-key";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const digest = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const mac = (payload: Uint8Array): Uint8Array => new Uint8Array(createHmac("sha256", CREATOR_KEY).update(payload).digest());

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
	const out = new Uint8Array(left.byteLength + right.byteLength);
	out.set(left, 0);
	out.set(right, left.byteLength);
	return out;
}

/** A row whose bytes carry a creator "signature" (HMAC stand-in) over its own key and body. */
function signedRow(owner: string, epoch: number, id: string, status = "published", scope = SCOPE): RetainedRowInput {
	const payload = encoder.encode(JSON.stringify({ owner, scope, epoch, kind: "row", id, status }));
	return { owner, scope, epoch, kind: "row", id, bytes: concat(payload, mac(payload)) };
}

/** Re-verification: signature over the payload, and the payload must name exactly its own key. */
function parseSigned(bytes: Uint8Array, key: RetainedRowKey): { status: string } | undefined {
	if (bytes.byteLength <= 32) return undefined;
	const payload = bytes.subarray(0, bytes.byteLength - 32);
	if (!Buffer.from(mac(payload)).equals(Buffer.from(bytes.subarray(bytes.byteLength - 32)))) return undefined;
	try {
		const body = JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
		if (body.owner !== key[0] || body.scope !== key[1] || body.epoch !== key[2] || body.kind !== key[3] || body.id !== key[4]) return undefined;
		return { status: String(body.status) };
	} catch { return undefined; }
}

const verifyRow = (bytes: Uint8Array, key: RetainedRowKey): boolean => parseSigned(bytes, key) !== undefined;

/** Owner policy: only verified, published rows retire; pending blocks; anything else is malformed. */
function classify(bytes: Uint8Array, key: RetainedRowKey): RowClass {
	const parsed = parseSigned(bytes, key);
	if (parsed === undefined) return "malformed";
	return parsed.status === "published" ? "retire" : parsed.status === "pending" ? "block" : "malformed";
}

function signedHead(epoch: number): Uint8Array {
	const payload = encoder.encode(JSON.stringify({ head: epoch, baseExpectedHead: epoch === 0 ? { kind: "none" } : epoch - 1 }));
	return concat(payload, mac(payload));
}

function blob(label: string, epoch: number, scope = SCOPE): RetainedBlobInput {
	const bytes = encoder.encode(`blob:${label}`);
	return { scope, digest: hex(digest(bytes)), epoch, bytes };
}

let counter = 0;
function names(): { retention: string; floor: string } {
	const id = `${Date.now()}-${counter++}-${Math.random().toString(16).slice(2)}`;
	return { retention: `epoch-retention-${id}`, floor: `epoch-retention-${id}--floor` };
}

class CrashAt extends Error {
	constructor(readonly step: string) { super(`crash at ${step}`); }
}

interface Harness {
	readonly names: { retention: string; floor: string };
	floor: EpochRetirementFloorPort & { close(): void };
	store: EpochRetirementStore;
	epoch: number;
	head: Uint8Array;
	crashAt?: RetirementStep | MigrationStep;
}

async function openStore(harness: Pick<Harness, "names" | "floor" | "crashAt">): Promise<EpochRetirementStore> {
	return EpochRetirementStore.open({
		databaseName: harness.names.retention,
		digest,
		floor: harness.floor,
		observe: (step) => { if (harness.crashAt === step) throw new CrashAt(step); },
	});
}

/** A fresh room: genesis head, verified on open, epoch 0 written. */
async function createRoom(): Promise<Harness> {
	const dbNames = names();
	const floor = await openEpochRetirementFloor(dbNames.floor);
	const harness = { names: dbNames, floor, epoch: 0, head: signedHead(0) } as Harness;
	harness.store = await openStore(harness);
	await harness.store.putHead(SCOPE, null, harness.head);
	expect((await harness.store.verifyOnOpen(SCOPE, openVerification(harness))).kind).toBe("verified");
	await writeEpoch(harness, 0);
	return harness;
}

function epochRows(epoch: number): RetainedRowInput[] {
	return OWNERS.flatMap((owner) => Array.from({ length: ROWS_PER_OWNER_EPOCH }, (_, index) => signedRow(owner, epoch, `${owner}-${epoch}-${index}`)));
}

async function writeEpoch(harness: Harness, epoch: number): Promise<void> {
	await harness.store.append(epochRows(epoch), [blob(`epoch-${epoch}`, epoch), blob("shared", epoch)]);
}

async function advance(harness: Harness): Promise<void> {
	const next = harness.epoch + 1;
	await writeEpoch(harness, next);
	const head = signedHead(next);
	await harness.store.putHead(SCOPE, harness.head, head);
	harness.epoch = next;
	harness.head = head;
}

/** The verified protected set: head, its two rollback ancestors (baseExpectedHead twice), and their blobs. */
function decisionFor(harness: Pick<Harness, "epoch" | "head">, overrides: Partial<RetirementDecision> = {}): RetirementDecision {
	const protectedFrom = Math.max(0, harness.epoch - 2);
	const through = protectedFrom - 1;
	const protectedRows = new Set<string>();
	for (let epoch = protectedFrom; epoch <= harness.epoch; epoch++)
		for (const row of epochRows(epoch)) protectedRows.add(rowKeyText([row.owner, row.scope, row.epoch, row.kind, row.id]));
	const protectedBlobs = new Set<string>([blob("shared", 0).digest]);
	for (let epoch = protectedFrom; epoch <= harness.epoch; epoch++) protectedBlobs.add(blob(`epoch-${epoch}`, epoch).digest);
	return {
		scope: SCOPE,
		head: harness.head,
		protectedFrom,
		protectedRows,
		protectedBlobs,
		owners: OWNERS.map((owner) => ({ owner, through, cap: 64, classify })),
		blobThrough: through,
		blobCap: 64,
		proofBytes: 4 * 1024 * 1024,
		decisionDigest: digest(encoder.encode(`decision:${harness.epoch}:${through}`)),
		...overrides,
	};
}

function openVerification(harness: Pick<Harness, "epoch" | "head">): Parameters<EpochRetirementStore["verifyOnOpen"]>[1] {
	return { head: harness.head, protectedFrom: Math.max(0, harness.epoch - 2), owners: OWNERS, verifyRow, cap: 1000, blobCap: 1000 };
}

/** Simulated process death and restart: drop the connection, reopen, re-verify. */
async function restart(harness: Harness): Promise<ReturnType<EpochRetirementStore["verifyOnOpen"]>> {
	harness.store.close();
	harness.floor.close();
	harness.floor = await openEpochRetirementFloor(harness.names.floor);
	harness.store = await openStore(harness);
	return harness.store.verifyOnOpen(SCOPE, openVerification(harness));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function raw(name: string): Promise<IDBDatabase> {
	return requestResult(indexedDB.open(name));
}

interface Dump { rows: Map<string, string>; marks: Map<string, { fence: number; drained: number }>; blobs: Map<string, number>; heads: Map<string, string> }

async function dump(name: string): Promise<Dump> {
	const database = await raw(name);
	const transaction = database.transaction(["retainedRows", "retirementMarks", "retainedBlobs", "retainedHeads"], "readonly");
	const all = async (store: string): Promise<Array<[IDBValidKey, unknown]>> => {
		const [keys, values] = await Promise.all([
			requestResult(transaction.objectStore(store).getAllKeys()),
			requestResult(transaction.objectStore(store).getAll()),
		]);
		return keys.map((key, index) => [key, values[index]]);
	};
	const [rows, marks, blobs, heads] = await Promise.all([all("retainedRows"), all("retirementMarks"), all("retainedBlobs"), all("retainedHeads")]);
	database.close();
	return {
		rows: new Map(rows.map(([key, value]) => [JSON.stringify(key), value instanceof Uint8Array ? hex(value) : JSON.stringify(value)])),
		marks: new Map(marks.map(([key, value]) => {
			const mark = value as { fence: number; drained: number };
			return [JSON.stringify(key), { fence: mark.fence, drained: mark.drained }];
		})),
		blobs: new Map(blobs.map(([key, value]) => [JSON.stringify(key), (value as { lastRef: number }).lastRef])),
		heads: new Map(heads.map(([key, value]) => [JSON.stringify(key), hex((value as { bytes: Uint8Array }).bytes)])),
	};
}

async function tamper(name: string, stores: string[], change: (transaction: IDBTransaction) => void): Promise<void> {
	const database = await raw(name);
	const transaction = database.transaction(stores, "readwrite");
	const done = new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error);
	});
	change(transaction);
	await done;
	database.close();
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	const error = await promise.then(() => undefined, (cause: unknown) => cause);
	expect(error).toBeInstanceOf(EpochRetirementError);
	expect((error as EpochRetirementError).code).toBe(code);
}

/** The host floor's retired-through fence for one owner (-1 when none). */
async function floorFor(harness: Pick<Harness, "floor">, owner = "journal"): Promise<number> {
	return (await harness.floor.read(SCOPE))[owner] ?? -1;
}

function windowRowCount(epoch: number): number {
	return OWNERS.length * ROWS_PER_OWNER_EPOCH * Math.min(epoch + 1, 3);
}

async function roomAt(epoch: number): Promise<Harness> {
	const harness = await createRoom();
	while (harness.epoch < epoch) await advance(harness);
	return harness;
}

async function close(harness: Harness): Promise<void> {
	harness.store.close();
	harness.floor.close();
}

describe("opt-in single-database epoch retirement (Step 4 mechanism)", () => {
	it("keeps exactly the protected window (head + two rollbacks) across 60 epochs, one strict transaction each", async () => {
		const harness = await createRoom();
		for (let epoch = 1; epoch <= 60; epoch++) {
			await advance(harness);
			const outcome = await harness.store.retire(decisionFor(harness));
			expect(outcome.kind).toBe("retired");
			const counts = await harness.store.counts();
			expect(counts.rows).toBe(windowRowCount(epoch));
			// Per-epoch blobs for the window, plus the shared blob.
			expect(counts.blobs).toBe(Math.min(epoch + 1, 3) + 1);
		}
		const after = await dump(harness.names.retention);
		for (const owner of OWNERS) expect(after.marks.get(JSON.stringify([SCOPE, owner]))).toEqual({ fence: 57, drained: 57 });
		expect(await floorFor(harness)).toBe(57);
		// Protected rows read back exactly; retired rows are gone and hidden.
		for (const row of epochRows(58)) expect(await harness.store.read([row.owner, row.scope, row.epoch, row.kind, row.id])).toEqual(row.bytes);
		for (const row of epochRows(57)) expect(await harness.store.read([row.owner, row.scope, row.epoch, row.kind, row.id])).toBeUndefined();
		await close(harness);
	});

	it("replays idempotently: the same decision twice deletes nothing more and never lowers a mark", async () => {
		const harness = await roomAt(6);
		const decision = decisionFor(harness);
		expect((await harness.store.retire(decision)).kind).toBe("retired");
		const once = await dump(harness.names.retention);
		const replay = await harness.store.retire(decision);
		expect(replay.kind).toBe("retired");
		if (replay.kind === "retired") for (const owner of OWNERS) expect(replay.owners[owner]).toEqual({ kind: "current", drained: 3 });
		expect(await dump(harness.names.retention)).toEqual(once);
		// An older (stale) decision is a no-op: marks are monotone.
		const older = { ...decision, owners: decision.owners.map((owner) => ({ ...owner, through: 1 })), blobThrough: 1 };
		const stale = await harness.store.retire(older);
		expect(stale.kind).toBe("retired");
		expect(await dump(harness.names.retention)).toEqual(once);
		await close(harness);
	});

	describe("crash at every step: old XOR new, and replay converges to the crash-free state", () => {
		const steps: RetirementStep[] = ["before-floor", "after-floor", "after-reads", "after-deletes", "after-commit"];
		for (const step of steps) {
			it(`crash ${step}`, async () => {
				const reference = await roomAt(7);
				expect((await reference.store.retire(decisionFor(reference))).kind).toBe("retired");
				const expected = await dump(reference.names.retention);
				await close(reference);

				const harness = await roomAt(7);
				const before = await dump(harness.names.retention);
				harness.crashAt = step;
				const crash = await harness.store.retire(decisionFor(harness)).then(() => undefined, (cause: unknown) => cause);
				expect(crash).toBeInstanceOf(CrashAt);
				harness.crashAt = undefined;
				const atCrash = await dump(harness.names.retention);
				if (step === "after-commit") {
					expect(atCrash).toEqual(expected);
				} else {
					// Atomic: no row, blob or mark changed in the retention database.
					expect(atCrash).toEqual(before);
				}
				// Floor first: from "after-floor" on, the floor is ahead (retains too much, never deletes too much).
				for (const owner of OWNERS) expect(await floorFor(harness, owner)).toBe(step === "before-floor" ? -1 : 4);

				const reopened = await restart(harness);
				expect(reopened.kind).toBe("verified");
				if (reopened.kind === "verified" && step !== "before-floor" && step !== "after-commit") {
					expect(reopened.fencesRaised).toEqual([...OWNERS]);
					expect(reopened.retiredPending).toBe(OWNERS.length * ROWS_PER_OWNER_EPOCH * 5);
				}
				if (step !== "before-floor") {
					// Rows at or below the floor are hidden and refuse late writers even before deletion.
					expect(await harness.store.read(["journal", SCOPE, 4, "row", "journal-4-0"])).toBeUndefined();
					await expectCode(harness.store.append([signedRow("journal", 4, "late")]), "RETIRED");
				}
				expect((await harness.store.retire(decisionFor(harness))).kind).toBe("retired");
				const converged = await dump(harness.names.retention);
				expect(converged.rows).toEqual(expected.rows);
				expect(converged.blobs).toEqual(expected.blobs);
				expect(converged.marks).toEqual(expected.marks);
				await close(harness);
			});
		}
	});

	describe("stale writers and resurrection", () => {
		it("refuses any append at or below the fence with zero writes, even for valid rows in the same batch", async () => {
			const harness = await roomAt(6);
			expect((await harness.store.retire(decisionFor(harness))).kind).toBe("retired");
			const before = await dump(harness.names.retention);
			await expectCode(harness.store.append([signedRow("issuance", 7, "fresh"), signedRow("issuance", 3, "resurrect")]), "RETIRED");
			await expectCode(harness.store.append([], [blob("old-ref", 2)]), "RETIRED");
			expect(await dump(harness.names.retention)).toEqual(before);
			// Exact-bytes immutability: a different body under an existing key conflicts.
			await expectCode(harness.store.append([signedRow("journal", 6, "journal-6-0", "rewritten")]), "CONFLICT");
			await close(harness);
		});

		it("answers a late acknowledgement below the mark with RECORD_PRUNED", async () => {
			const harness = await roomAt(6);
			const pruned = signedRow("issuance", 3, "issuance-3-0");
			expect((await harness.store.retire(decisionFor(harness))).kind).toBe("retired");
			await expectCode(harness.store.replace(["issuance", SCOPE, 3, "row", "issuance-3-0"], pruned.bytes, signedRow("issuance", 3, "issuance-3-0", "acked").bytes), "RECORD_PRUNED");
			const live = signedRow("issuance", 6, "issuance-6-0");
			await harness.store.replace(["issuance", SCOPE, 6, "row", "issuance-6-0"], live.bytes, signedRow("issuance", 6, "issuance-6-0", "acked").bytes);
			await close(harness);
		});

		it("a newer schema closes this connection natively, and code pinned to the old version cannot reopen", async () => {
			const harness = await roomAt(2);
			const upgrade = await requestResult(indexedDB.open(harness.names.retention, 2));
			expect(harness.store.closed).toBe(true);
			await expectCode(harness.store.append(epochRows(3)), "STORE_CLOSED");
			upgrade.close();
			const stale = await requestResult(indexedDB.open(harness.names.retention, 1)).then(() => undefined, (cause: unknown) => cause);
			expect((stale as DOMException).name).toBe("VersionError");
			harness.floor.close();
		});

		it("nothing is read, written or retired on a scope before it is re-verified on this open (G5)", async () => {
			const harness = await roomAt(5);
			harness.store.close();
			harness.store = await openStore(harness);
			await expectCode(harness.store.read(["journal", SCOPE, 5, "row", "journal-5-0"]), "UNVERIFIED");
			await expectCode(harness.store.append(epochRows(6)), "UNVERIFIED");
			await expectCode(harness.store.retire(decisionFor(harness)), "UNVERIFIED");
			expect((await harness.store.verifyOnOpen(SCOPE, openVerification(harness))).kind).toBe("verified");
			expect((await harness.store.retire(decisionFor(harness))).kind).toBe("retired");
			await close(harness);
		});
	});

	describe("rollback of the watermark and of the database", () => {
		it("marks rolled back below the host floor: fences are re-raised on open, rows stay hidden, and only a verified decision deletes them", async () => {
			const harness = await roomAt(7);
			const image = await dump(harness.names.retention);
			const rawMarks = new Map<string, unknown>();
			{
				const database = await raw(harness.names.retention);
				const transaction = database.transaction("retirementMarks", "readonly");
				const keys = await requestResult(transaction.objectStore("retirementMarks").getAllKeys());
				for (const key of keys) rawMarks.set(JSON.stringify(key), await requestResult(transaction.objectStore("retirementMarks").get(key)));
				database.close();
			}
			expect((await harness.store.retire(decisionFor(harness))).kind).toBe("retired");
			// Restore the old rows and marks (head unchanged): a partial rollback of the retention database.
			await tamper(harness.names.retention, ["retainedRows", "retirementMarks"], (transaction) => {
				transaction.objectStore("retirementMarks").clear();
				for (const [key, value] of rawMarks) transaction.objectStore("retirementMarks").put(value, JSON.parse(key));
				for (const row of OWNERS.flatMap((owner) => [0, 1, 2, 3, 4].flatMap((epoch) =>
					Array.from({ length: ROWS_PER_OWNER_EPOCH }, (_, index) => signedRow(owner, epoch, `${owner}-${epoch}-${index}`)))))
					transaction.objectStore("retainedRows").put(row.bytes, [row.owner, row.scope, row.epoch, row.kind, row.id]);
			});
			expect((await dump(harness.names.retention)).rows).toEqual(image.rows);
			const reopened = await restart(harness);
			expect(reopened).toMatchObject({ kind: "verified", fencesRaised: [...OWNERS] });
			expect(await floorFor(harness, "ahe")).toBe(4);
			expect(await harness.store.read(["ahe", SCOPE, 2, "row", "ahe-2-0"])).toBeUndefined();
			await expectCode(harness.store.append([signedRow("ahe", 3, "resurrect")]), "RETIRED");
			expect((await harness.store.retire(decisionFor(harness))).kind).toBe("retired");
			expect((await harness.store.counts()).rows).toBe(windowRowCount(7));
			await close(harness);
		});

		it("the whole retention database rolled back (older head) fails closed against the verified head", async () => {
			const harness = await roomAt(7);
			expect((await harness.store.retire(decisionFor(harness))).kind).toBe("retired");
			await tamper(harness.names.retention, ["retainedHeads"], (transaction) => {
				transaction.objectStore("retainedHeads").put({ bytes: signedHead(5), revision: 5 }, SCOPE);
			});
			expect(await restart(harness)).toMatchObject({ kind: "refused", reason: "HEAD_MISMATCH" });
			await close(harness);
		});

		it("a mark rolled forward (poisoned) above the floor or into the protected set fails closed with zero writes", async () => {
			const harness = await roomAt(8);
			const decision = decisionFor(harness);
			const early = { ...decision, owners: decision.owners.map((owner) => ({ ...owner, through: 3 })), blobThrough: 3 };
			expect((await harness.store.retire(early)).kind).toBe("retired");
			expect(await floorFor(harness, "snapshot")).toBe(3);
			const poison = (fence: number) => tamper(harness.names.retention, ["retirementMarks"], (transaction) => {
				transaction.objectStore("retirementMarks").put({ fence, drained: 3, revision: 9, decision: null }, [SCOPE, "snapshot"]);
			});
			// Above the host floor (5 > 3): the database claims more than the floor authorised.
			await poison(5);
			expect(await restart(harness)).toMatchObject({ kind: "refused", reason: "CORRUPT" });
			// Inside the verified protected set (7 >= 6).
			await poison(7);
			expect(await restart(harness)).toMatchObject({ kind: "refused", reason: "CORRUPT" });
			// On a verified connection, a retirement over a poisoned mark refuses with zero writes.
			await poison(3);
			expect((await restart(harness)).kind).toBe("verified");
			await poison(7);
			const before = await dump(harness.names.retention);
			expect(await harness.store.retire(decision)).toMatchObject({ kind: "refused", reason: "CORRUPT" });
			expect(await dump(harness.names.retention)).toEqual(before);
			await close(harness);
		});

		it("a regressed host floor is never repaired: marks above it fail the open closed", async () => {
			const harness = await roomAt(7);
			expect((await harness.store.retire(decisionFor(harness))).kind).toBe("retired");
			await tamper(harness.names.floor, ["retiredThrough"], (transaction) => {
				for (const owner of OWNERS) transaction.objectStore("retiredThrough").put(1, [SCOPE, owner]);
			});
			expect(await restart(harness)).toMatchObject({ kind: "refused", reason: "CORRUPT" });
			expect(await floorFor(harness)).toBe(1);
			await close(harness);
		});
	});

	describe("poisoned bytes", () => {
		it("a flipped byte in a protected row fails verify-on-open closed", async () => {
			const harness = await roomAt(5);
			const row = signedRow("summary", 4, "summary-4-1");
			const poisoned = row.bytes.slice();
			poisoned[3] ^= 1;
			await tamper(harness.names.retention, ["retainedRows"], (transaction) =>
				transaction.objectStore("retainedRows").put(poisoned, [row.owner, row.scope, row.epoch, row.kind, row.id]));
			expect(await restart(harness)).toMatchObject({ kind: "refused", reason: "POISONED" });
			await close(harness);
		});

		it("a malformed or pending issuance candidate blocks issuance only, with zero issuance writes; other owners advance", async () => {
			const harness = await roomAt(7);
			const pending = signedRow("issuance", 2, "issuance-pending", "pending");
			await harness.store.append([pending]);
			const malformedKey: RetainedRowKey = ["evidence", SCOPE, 1, "row", "evidence-1-0"];
			await tamper(harness.names.retention, ["retainedRows"], (transaction) =>
				transaction.objectStore("retainedRows").put({ structured: "not exact bytes" }, malformedKey as unknown as IDBValidKey));
			const outcome = await harness.store.retire(decisionFor(harness));
			expect(outcome.kind).toBe("retired");
			if (outcome.kind !== "retired") return;
			expect(outcome.owners.issuance).toEqual({ kind: "blocked", reason: "pending" });
			expect(outcome.owners.evidence).toEqual({ kind: "blocked", reason: "malformed" });
			expect(outcome.owners.journal).toMatchObject({ kind: "advanced", to: 4 });
			const after = await dump(harness.names.retention);
			expect(after.marks.get(JSON.stringify([SCOPE, "issuance"]))).toBeUndefined();
			expect(after.marks.get(JSON.stringify([SCOPE, "journal"]))).toEqual({ fence: 4, drained: 4 });
			expect([...after.rows.keys()].filter((key) => key.startsWith('["issuance"')).length).toBe(ROWS_PER_OWNER_EPOCH * 8 + 1);
			expect([...after.rows.keys()].filter((key) => key.startsWith('["journal"')).length).toBe(ROWS_PER_OWNER_EPOCH * 3);
			await close(harness);
		});

		it("pending work the planner knows of holds back only its own owner; it stays readable and finishable (G19, G2)", async () => {
			const harness = await roomAt(7);
			const pending = signedRow("issuance", 2, "issuance-pending", "pending");
			await harness.store.append([pending]);
			const decision = decisionFor(harness);
			// The verified facts include the pending record at epoch 2, so issuance retires only through epoch 1.
			const outcome = await harness.store.retire({ ...decision, owners: decision.owners.map((owner) => owner.owner === "issuance" ? { ...owner, through: 1 } : owner) });
			expect(outcome).toMatchObject({ kind: "retired", owners: { issuance: { kind: "advanced", to: 1 }, journal: { kind: "advanced", to: 4 } } });
			expect(await floorFor(harness, "issuance")).toBe(1);
			const key: RetainedRowKey = ["issuance", SCOPE, 2, "row", "issuance-pending"];
			expect(await harness.store.read(key)).toEqual(pending.bytes);
			const published = signedRow("issuance", 2, "issuance-pending", "published");
			await harness.store.replace(key, pending.bytes, published.bytes);
			expect((await harness.store.retire(decisionFor(harness))).kind).toBe("retired");
			expect(await harness.store.read(key)).toBeUndefined();
			await expectCode(harness.store.replace(key, published.bytes, pending.bytes), "RECORD_PRUNED");
			await close(harness);
		});

		it("a mis-keyed row (valid signature, wrong key) is malformed: it blocks its owner and fails verify-on-open", async () => {
			const harness = await roomAt(7);
			const protectedRow = signedRow("snapshot", 7, "snapshot-7-0");
			await tamper(harness.names.retention, ["retainedRows"], (transaction) =>
				transaction.objectStore("retainedRows").put(protectedRow.bytes, ["snapshot", SCOPE, 1, "row", "moved"]));
			const outcome = await harness.store.retire(decisionFor(harness));
			expect(outcome).toMatchObject({ kind: "retired", owners: { snapshot: { kind: "blocked", reason: "malformed" } } });
			expect(await harness.store.read(["snapshot", SCOPE, 7, "row", "snapshot-7-0"])).toEqual(protectedRow.bytes);
			await close(harness);
			const second = await roomAt(3);
			await tamper(second.names.retention, ["retainedRows"], (transaction) =>
				transaction.objectStore("retainedRows").put(signedRow("snapshot", 3, "snapshot-3-0").bytes, ["snapshot", SCOPE, 2, "row", "moved"]));
			expect(await restart(second)).toMatchObject({ kind: "refused", reason: "POISONED" });
			await close(second);
		});

		it("a protected key inside a retired range means the decision and the store disagree: CORRUPT, zero writes", async () => {
			const harness = await roomAt(7);
			const before = await dump(harness.names.retention);
			const decision = decisionFor(harness);
			const protectedRows = new Set(decision.protectedRows);
			protectedRows.add(rowKeyText(["ahe", SCOPE, 2, "row", "ahe-2-1"]));
			expect(await harness.store.retire({ ...decision, protectedRows })).toMatchObject({ kind: "refused", reason: "CORRUPT" });
			expect(await dump(harness.names.retention)).toEqual({ ...before });
			await close(harness);
		});

		it("a foreign head change between verification and retirement refuses HEAD_CHANGED with zero writes", async () => {
			const harness = await roomAt(7);
			const before = await dump(harness.names.retention);
			await tamper(harness.names.retention, ["retainedHeads"], (transaction) =>
				transaction.objectStore("retainedHeads").put({ bytes: signedHead(6), revision: 99 }, SCOPE));
			const tampered = await dump(harness.names.retention);
			expect(await harness.store.retire(decisionFor(harness))).toMatchObject({ kind: "refused", reason: "HEAD_CHANGED" });
			expect(await dump(harness.names.retention)).toEqual(tampered);
			expect(tampered.rows).toEqual(before.rows);
			await close(harness);
		});

		it("blobs: lastRef only selects (a poisoned lastRef never deletes a protected blob); bad bytes are refused on arrival and on open", async () => {
			const harness = await roomAt(7);
			const shared = blob("shared", 0);
			await tamper(harness.names.retention, ["retainedBlobs"], (transaction) =>
				transaction.objectStore("retainedBlobs").put({ scope: SCOPE, lastRef: 0, bytes: shared.bytes }, [SCOPE, shared.digest]));
			expect((await harness.store.retire(decisionFor(harness))).kind).toBe("retired");
			expect(await harness.store.readBlob(SCOPE, shared.digest)).toEqual(shared.bytes);
			await expectCode(harness.store.append([], [{ ...blob("arrival", 8), bytes: encoder.encode("other bytes") }]), "POISONED");
			const target = blob("epoch-7", 7);
			await tamper(harness.names.retention, ["retainedBlobs"], (transaction) =>
				transaction.objectStore("retainedBlobs").put({ scope: SCOPE, lastRef: 7, bytes: encoder.encode("poison") }, [SCOPE, target.digest]));
			await expectCode(harness.store.readBlob(SCOPE, target.digest), "POISONED");
			expect(await restart(harness)).toMatchObject({ kind: "refused", reason: "POISONED" });
			await close(harness);
		});

		it("over-budget or over-cap census refuses or blocks before any delete", async () => {
			const harness = await roomAt(7);
			const before = await dump(harness.names.retention);
			expect(await harness.store.retire(decisionFor(harness, { proofBytes: 2048 }))).toMatchObject({ kind: "refused", reason: "BUDGET" });
			expect(await dump(harness.names.retention)).toEqual(before);
			const decision = decisionFor(harness);
			const capped = await harness.store.retire({ ...decision, owners: decision.owners.map((owner) => owner.owner === "ahe" ? { ...owner, cap: 3 } : owner) });
			expect(capped).toMatchObject({ kind: "retired", owners: { ahe: { kind: "blocked", reason: "capacity" }, journal: { kind: "advanced" } } });
			await close(harness);
		});

		it("an owner rewrite (AHE lineage floor) is exact-compared and lands atomically with the deletes", async () => {
			const harness = await roomAt(7);
			const oldest = signedRow("ahe", 5, "ahe-5-0");
			const rewritten = signedRow("ahe", 5, "ahe-5-0", "published-lineage-floor-none");
			const decision = decisionFor(harness);
			expect(await harness.store.retire({ ...decision, rewrites: [{ key: ["ahe", SCOPE, 5, "row", "ahe-5-0"], expected: rewritten.bytes, next: oldest.bytes }] }))
				.toMatchObject({ kind: "refused", reason: "CORRUPT" });
			expect((await harness.store.counts()).rows).toBe(OWNERS.length * ROWS_PER_OWNER_EPOCH * 8);
			expect(await harness.store.retire({ ...decision, rewrites: [{ key: ["ahe", SCOPE, 5, "row", "ahe-5-0"], expected: oldest.bytes, next: rewritten.bytes }] }))
				.toMatchObject({ kind: "retired" });
			expect(await harness.store.read(["ahe", SCOPE, 5, "row", "ahe-5-0"])).toEqual(rewritten.bytes);
			expect((await harness.store.counts()).rows).toBe(windowRowCount(7));
			await close(harness);
		});
	});

	describe("authenticated migration from legacy databases (G25)", () => {
		const LEGACY_VERSION = 3;

		async function legacyJournal(name: string, epochs: number, completedThrough: number): Promise<void> {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const open = indexedDB.open(name, LEGACY_VERSION);
				open.onupgradeneeded = () => {
					open.result.createObjectStore("acceptedEntries");
					open.result.createObjectStore("retirementControls");
				};
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => reject(open.error);
			});
			const transaction = database.transaction(["acceptedEntries", "retirementControls"], "readwrite");
			for (let epoch = completedThrough + 1; epoch <= epochs; epoch++)
				for (let index = 0; index < ROWS_PER_OWNER_EPOCH; index++)
					transaction.objectStore("acceptedEntries").put({ epoch, index, bytes: signedRow("journal", epoch, `journal-${epoch}-${index}`).bytes }, [epoch, index]);
			transaction.objectStore("retirementControls").put({ completedThrough }, SCOPE);
			await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
			database.close();
		}

		function journalSource(name: string, onCarry?: () => void, poisonEpoch?: number): LegacyRetentionSource {
			return {
				databaseName: name,
				stores: ["acceptedEntries", "retirementControls"],
				cap: 1000,
				carry: (store, _key, value) => {
					if (store !== "acceptedEntries") return undefined;
					onCarry?.();
					const entry = value as { epoch: number; index: number; bytes: Uint8Array };
					const row = signedRow("journal", entry.epoch, `journal-${entry.epoch}-${entry.index}`);
					const bytes = entry.epoch === poisonEpoch ? row.bytes.map((byte, index) => index === 2 ? byte ^ 1 : byte) : entry.bytes;
					// Authenticate exactly as an open would; a protected row that fails refuses the migration.
					if (!verifyRow(bytes, [row.owner, row.scope, row.epoch, row.kind, row.id])) throw new Error(`unverifiable legacy journal row ${entry.epoch}`);
					return { ...row, bytes };
				},
				marks: (image) => {
					const control = image.get("retirementControls")?.find(([key]) => key === SCOPE)?.[1] as { completedThrough: number } | undefined;
					return control === undefined ? {} : { [JSON.stringify([SCOPE, "journal"])]: control.completedThrough };
				},
			};
		}

		async function migrationHarness(): Promise<Harness & { legacy: string }> {
			const harness = await createRoom();
			while (harness.epoch < 7) {
				const next = harness.epoch + 1;
				const head = signedHead(next);
				await harness.store.putHead(SCOPE, harness.head, head);
				harness.epoch = next;
				harness.head = head;
			}
			await tamper(harness.names.retention, ["retainedRows", "retainedBlobs"], (transaction) => {
				transaction.objectStore("retainedRows").clear();
				transaction.objectStore("retainedBlobs").clear();
			});
			const legacy = `${harness.names.retention}--legacy-journal`;
			await legacyJournal(legacy, 7, 2);
			return Object.assign(harness, { legacy });
		}

		it("fences old connections, authenticates, copies with a receipt in one transaction, then deletes the legacy database", async () => {
			const harness = await migrationHarness();
			const old = await requestResult(indexedDB.open(harness.legacy, LEGACY_VERSION));
			let oldClosed = false;
			old.onversionchange = () => { oldClosed = true; old.close(); };
			const reports = await harness.store.migrateLegacy([journalSource(harness.legacy)]);
			expect(reports).toEqual([{ databaseName: harness.legacy, kind: "migrated", rows: ROWS_PER_OWNER_EPOCH * 5 }]);
			expect(oldClosed).toBe(true);
			expect((await indexedDB.databases()).some((info) => info.name === harness.legacy)).toBe(false);
			const receipt = await harness.store.receipt(harness.legacy);
			expect(receipt).toMatchObject({ rows: 10, legacyVersion: LEGACY_VERSION + 1 });
			// The legacy completion becomes a floor fence and a store fence, never a deletion claim.
			expect(await floorFor(harness, "journal")).toBe(2);
			expect(await floorFor(harness, "issuance")).toBe(-1);
			expect(await harness.store.mark(SCOPE, "journal")).toMatchObject({ fence: 2, drained: -1 });
			expect(await harness.store.read(["journal", SCOPE, 3, "row", "journal-3-0"])).toEqual(signedRow("journal", 3, "journal-3-0").bytes);
			await expectCode(harness.store.append([signedRow("journal", 2, "resurrect")]), "RETIRED");
			await close(harness);
		});

		it("crash after the fence: old code cannot reopen; the next open resumes and migrates", async () => {
			const harness = await migrationHarness();
			harness.crashAt = "after-fence";
			await expect(harness.store.migrateLegacy([journalSource(harness.legacy)])).rejects.toBeInstanceOf(CrashAt);
			harness.crashAt = undefined;
			const stale = await requestResult(indexedDB.open(harness.legacy, LEGACY_VERSION)).then(() => undefined, (cause: unknown) => cause);
			expect((stale as DOMException).name).toBe("VersionError");
			expect(await harness.store.receipt(harness.legacy)).toBeUndefined();
			expect((await restart(harness)).kind).toBe("verified");
			expect(await harness.store.migrateLegacy([journalSource(harness.legacy)])).toEqual([{ databaseName: harness.legacy, kind: "migrated", rows: 10 }]);
			await close(harness);
		});

		it("crash after the copy: the receipt makes the legacy database a deletion target only (never read again, never copied twice)", async () => {
			const harness = await migrationHarness();
			harness.crashAt = "after-copy";
			await expect(harness.store.migrateLegacy([journalSource(harness.legacy)])).rejects.toBeInstanceOf(CrashAt);
			harness.crashAt = undefined;
			const copied = await dump(harness.names.retention);
			expect((await indexedDB.databases()).some((info) => info.name === harness.legacy)).toBe(true);
			expect((await restart(harness)).kind).toBe("verified");
			let carried = 0;
			expect(await harness.store.migrateLegacy([journalSource(harness.legacy, () => { carried++; })]))
				.toEqual([{ databaseName: harness.legacy, kind: "deleted-after-receipt" }]);
			expect(carried).toBe(0);
			expect((await indexedDB.databases()).some((info) => info.name === harness.legacy)).toBe(false);
			expect((await dump(harness.names.retention)).rows).toEqual(copied.rows);
			await close(harness);
		});

		it("an unverifiable legacy row fails the migration closed: nothing copied, no receipt, legacy kept fenced", async () => {
			const harness = await migrationHarness();
			await expect(harness.store.migrateLegacy([journalSource(harness.legacy, undefined, 5)])).rejects.toThrow("unverifiable legacy journal row 5");
			expect(await harness.store.receipt(harness.legacy)).toBeUndefined();
			expect((await harness.store.counts()).rows).toBe(0);
			expect(await floorFor(harness, "journal")).toBe(-1);
			const stale = await requestResult(indexedDB.open(harness.legacy, LEGACY_VERSION)).then(() => undefined, (cause: unknown) => cause);
			expect((stale as DOMException).name).toBe("VersionError");
			await close(harness);
		});
	});

	it("property: random epochs, crashes, restarts and stale writes never lose a protected row or resurrect a retired one", async () => {
		const steps: Array<RetirementStep | undefined> = [undefined, "before-floor", "after-floor", "after-reads", "after-deletes", "after-commit"];
		const command = fc.oneof(
			fc.constant({ kind: "advance" as const }),
			fc.record({ kind: fc.constant("retire" as const), crash: fc.constantFrom(...steps) }),
			fc.record({ kind: fc.constant("stale" as const), back: fc.integer({ min: 0, max: 8 }), owner: fc.constantFrom(...OWNERS) }),
			fc.constant({ kind: "restart" as const }),
		);
		await fc.assert(fc.asyncProperty(fc.array(command, { minLength: 4, maxLength: 24 }), async (commands) => {
			const harness = await createRoom();
			let fence = -1;
			try {
				for (const next of commands) {
					if (next.kind === "advance") await advance(harness);
					else if (next.kind === "restart") {
						expect((await restart(harness)).kind).toBe("verified");
						fence = Math.max(fence, await floorFor(harness));
					} else if (next.kind === "retire") {
						harness.crashAt = next.crash;
						const outcome = await harness.store.retire(decisionFor(harness)).then((value) => value, (cause: unknown) => cause);
						harness.crashAt = undefined;
						if (outcome instanceof CrashAt) {
							expect((await restart(harness)).kind).toBe("verified");
						} else if (!(outcome instanceof Error)) {
							expect((outcome as { kind: string }).kind).toBe("retired");
						} else throw outcome;
						fence = Math.max(fence, await floorFor(harness));
					} else {
						const epoch = harness.epoch - next.back;
						if (epoch < 0) continue;
						const write = harness.store.append([signedRow(next.owner, epoch, `stale-${epoch}`)]);
						if (epoch <= fence) await expectCode(write, "RETIRED");
						else await write;
					}
					// Invariants after every command.
					for (let epoch = Math.max(0, harness.epoch - 2); epoch <= harness.epoch; epoch++)
						for (const row of epochRows(epoch)) expect(await harness.store.read([row.owner, row.scope, row.epoch, row.kind, row.id])).toEqual(row.bytes);
					for (let epoch = 0; epoch <= fence; epoch++)
						expect(await harness.store.read(["journal", SCOPE, epoch, "row", `journal-${epoch}-0`])).toBeUndefined();
				}
				// A final crash-free retirement converges to exactly the window (+ surviving unretired stale rows above the fence).
				expect((await harness.store.retire(decisionFor(harness))).kind).toBe("retired");
				const after = await dump(harness.names.retention);
				const floor = Math.max(-1, harness.epoch - 3);
				for (const key of after.rows.keys()) expect((JSON.parse(key) as RetainedRowKey)[2]).toBeGreaterThan(floor);
			} finally { await close(harness); }
		}), { numRuns: 25 });
	}, 120_000);
});
