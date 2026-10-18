import { encodeCanonical } from "@ts-drp/canonical";

import { AHE_LOCAL_CONTROL_SCHEMA_AUTHORITY } from "../../src/internal/schema-idb.js";
import { openInternalSealEvidenceStore } from "../../src/internal/seal-evidence-store.js";
import {
	type AdvanceSigningFrontierInput,
	type InternalSealVoteStore,
	openInternalSealVoteStore,
} from "../../src/internal/seal-vote-store.js";

// Mechanical native participant tests. These synthetic carriers deliberately
// do not claim Ed25519 verification or external signing-execution custody.
const objectId = "phase5:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	signerId = "A";
const anchor = "11".repeat(32),
	valueDigest = "22".repeat(32),
	proposalHash = "33".repeat(32);
const request = <T>(r: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		r.onsuccess = (): void => resolve(r.result);
		r.onerror = (): void => reject(r.error);
	});
const complete = (t: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		t.oncomplete = (): void => resolve();
		t.onabort = (): void => reject(t.error ?? new Error("ABORT"));
	});
async function raw(name: string): Promise<IDBDatabase> {
	return request(indexedDB.open(name));
}
async function image(name: string): Promise<unknown> {
	const db = await raw(name);
	try {
		const names = Array.from(db.objectStoreNames),
			tx = db.transaction(names, "readonly"),
			done = complete(tx);
		const rows = await Promise.all(
			names.map(async (name) => {
				const store = tx.objectStore(name);
				const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
				return { name, keys, canonicalBytes: Array.from(encodeCanonical(values)) };
			})
		);
		await done;
		return { version: db.version, rows };
	} finally {
		db.close();
	}
}
function scope(
	store: InternalSealVoteStore,
	revision: number,
	round: number,
	epoch = 0
): {
	anchor: string;
	objectId: string;
	epoch: number;
	signerId: string;
	expectedIncarnation: string;
	expectedRevision: number;
	round: number;
} {
	return {
		anchor,
		objectId,
		epoch,
		signerId,
		expectedIncarnation: store.incarnation,
		expectedRevision: revision,
		round,
	};
}
function vote(
	store: InternalSealVoteStore,
	revision: number,
	round: number,
	epoch = 0
): Readonly<Record<string, unknown>> {
	return {
		...scope(store, revision, round, epoch),
		phase: "prepare",
		valueDigest,
		carrier: {
			exactCanonicalPreimageBytes: encodeCanonical({
				kind: "drp-seal-vote",
				objectId,
				epoch,
				signerId,
				round,
				phase: "prepare",
				proposalDigest: valueDigest,
				proposalHash,
			}),
			signature: new Uint8Array(64).fill(0x42),
		},
	};
}
function qc(store: InternalSealVoteStore, revision: number, round: number): Readonly<Record<string, unknown>> {
	return {
		...scope(store, revision, round),
		phase: "prepare",
		valueDigest,
		proposalHash,
		qcDigest: "44".repeat(32),
		exactCanonicalQcBytes: encodeCanonical({
			kind: "drp-seal-qc",
			objectId,
			epoch: 0,
			phase: "prepare",
			round,
			proposalDigest: valueDigest,
			proposalHash,
		}),
	};
}
function frontier(
	store: InternalSealVoteStore,
	expectedRevision: number,
	retiredBeforeRound: number
): AdvanceSigningFrontierInput {
	return {
		anchor,
		objectId,
		epoch: 0,
		signerId,
		expectedIncarnation: store.incarnation,
		expectedRevision,
		retiredBeforeRound,
	};
}
async function legacy(name: string, forged: boolean): Promise<void> {
	const r = indexedDB.open(name, 4);
	r.onupgradeneeded = (): void => {
		for (const s of AHE_LOCAL_CONTROL_SCHEMA_AUTHORITY.stores)
			r.result.createObjectStore(s.name, { keyPath: typeof s.keyPath === "string" ? s.keyPath : [...s.keyPath] });
		const tx = r.transaction;
		if (tx === null) throw new Error("MISSING_NATIVE_UPGRADE_TRANSACTION");
		tx.objectStore("storageMeta").add({ key: "incarnation", value: "ab".repeat(16) });
		tx.objectStore("storageMeta").add({ key: "preserved-addressed-control", record: new Uint8Array([1, 2, 3]) });
		tx.objectStore("signerState").add({
			anchor,
			objectId,
			epoch: 0,
			signerId,
			enteredRound: 1,
			revision: 7,
			...(forged ? { retiredBeforeRound: 1 } : {}),
		});
	};
	(await request(r)).close();
}
async function run(name: string, scenario: string): Promise<unknown> {
	const events: Record<string, unknown>[] = [];
	let ordinal = 0,
		txId = 0;
	const transaction = IDBDatabase.prototype.transaction;
	IDBDatabase.prototype.transaction = function (stores, mode, options): IDBTransaction {
		const tx = transaction.call(this, stores, mode, options),
			id = ++txId;
		events.push({
			ordinal: ++ordinal,
			kind: "native-invoke",
			id,
			mode: tx.mode,
			stores: Array.from(tx.objectStoreNames),
		});
		tx.addEventListener("complete", () => events.push({ ordinal: ++ordinal, kind: "native-complete", id }), {
			once: true,
		});
		tx.addEventListener("abort", () => events.push({ ordinal: ++ordinal, kind: "native-abort", id }), { once: true });
		return tx;
	};
	const call = async (operation: string, work: () => Promise<unknown>): Promise<unknown> => {
		events.push({ ordinal: ++ordinal, kind: "public-invoke", operation });
		try {
			const result = await work();
			events.push({ ordinal: ++ordinal, kind: "public-deliver", operation, result });
			return result;
		} catch (error) {
			events.push({ ordinal: ++ordinal, kind: "public-reject", operation, message: String(error) });
			return { rejected: String(error) };
		}
	};
	const owners: { close(): void }[] = [];
	try {
		if (scenario === "migration" || scenario === "forged-legacy") {
			await legacy(name, scenario === "forged-legacy");
			const before = await image(name),
				old = await raw(name);
			let versionChanged = false;
			old.onversionchange = (): void => {
				versionChanged = true;
				old.close();
			};
			const result = await call("migration", async () => {
				const s = await openInternalSealVoteStore({ databaseName: name });
				owners.push(s);
				return s.schema;
			});
			const after = await image(name);
			let oldHandleRefused = false;
			try {
				old.transaction("signerState", "readwrite");
			} catch {
				oldHandleRefused = true;
			}
			return { scenario, before, after, result, versionChanged, oldHandleRefused, events };
		}
		const store = await openInternalSealVoteStore({ databaseName: name });
		owners.push(store);
		const evidence = await openInternalSealEvidenceStore({ databaseName: name });
		owners.push(evidence);
		const opened = await call("enter-one", () => store.commitRound(scope(store, 0, 1)));
		const before = await image(name);
		if (scenario === "stale-incarnation") {
			const wrong = { expectedIncarnation: "cd".repeat(16) };
			const roundChange = {
				...scope(store, 1, 2),
				carrier: {
					exactCanonicalPreimageBytes: encodeCanonical({
						kind: "drp-round-change",
						objectId,
						epoch: 0,
						anchor,
						round: 2,
						phase: "round-change",
						signerId,
					}),
					signature: new Uint8Array(64),
				},
			};
			const losses = await Promise.all([
				call("storage-loss-vote", () => store.commitVote({ ...vote(store, 1, 1), ...wrong })),
				call("storage-loss-qc", () => store.commitQc({ ...qc(store, 1, 1), ...wrong })),
				call("storage-loss-round", () => store.commitRound({ ...scope(store, 1, 2), ...wrong })),
				call("storage-loss-round-change", () => store.commitRoundChange({ ...roundChange, ...wrong })),
			]);
			return { scenario, opened, losses, before, after: await image(name), events };
		}
		if (scenario === "summary-debt") {
			const retained = await call("retain-qc", () => store.commitQc(qc(store, 1, 1)));
			const entered = await call("enter-two", () => store.commitRound(scope(store, 2, 2)));
			const old = await image(name);
			const result = await call("advance", () => store.advanceRetirementFloor(frontier(store, 3, 2)));
			return { scenario, opened, retained, entered, result, before: old, after: await image(name), events };
		}
		const floor = await call("advance-one", () => store.advanceRetirementFloor(frontier(store, 1, 1)));
		if (scenario === "stale-cas") {
			const old = await image(name);
			const stale = await call("advance-stale", () => store.advanceRetirementFloor(frontier(store, 1, 1)));
			return { scenario, opened, floor, stale, before: old, after: await image(name), events };
		}
		const old = await image(name);
		const delayedVote = await call("delayed-vote", () => store.commitVote(vote(store, 2, 0)));
		const delayedQc = await call("delayed-qc", () => store.commitQc(qc(store, 2, 0)));
		const delayedRound = await call("delayed-round", () => store.commitRound(scope(store, 2, 0)));
		const delayedAck = await call("delayed-ack", () => store.markDispatched([objectId, 0, 0, "prepare", signerId]));
		const peer = {
			kind: "drp-creator-seal-evidence" as const,
			carrier: {
				exactCanonicalPreimageBytes: encodeCanonical({
					kind: "drp-seal-vote",
					objectId,
					epoch: 0,
					round: 0,
					phase: "commit",
					signerId,
				}),
				signature: new Uint8Array(64),
			},
			exactCanonicalCommitQcBytes: encodeCanonical({
				kind: "drp-seal-qc",
				objectId,
				epoch: 0,
				round: 0,
				phase: "commit",
			}),
			exactCanonicalCutValueBytes: encodeCanonical({
				kind: "drp-hard-epoch-cut",
				objectId,
				epoch: 0,
				previousAnchor: anchor,
			}),
			exactCanonicalTrustStateRecordBytes: encodeCanonical({ epoch: 0 }),
			signerPublicKey: new Uint8Array(32),
		};
		const restore = await call("delayed-evidence", () => evidence.restorePeerEvidence(peer));
		const refusedImage = await image(name);
		const current = await call("current-vote", () => store.commitVote(vote(store, 2, 1)));
		const entered = await call("enter-two", () => store.commitRound(scope(store, 3, 2)));
		const debtImage = await image(name);
		const debt = await call("advance-with-publication", () => store.advanceRetirementFloor(frontier(store, 4, 2)));
		const debtAfter = await image(name);
		const ack = await call("ack-one", () => store.markDispatched([objectId, 0, 1, "prepare", signerId]));
		const advance = await call("advance-two", () => store.advanceRetirementFloor(frontier(store, 4, 2)));
		const future = await call("future-epoch", () => store.commitVote(vote(store, 0, 0, 1)));
		const snapshot = await call("snapshot", () => store.openSnapshot(scope(store, 5, 2)));
		return {
			scenario,
			opened,
			before,
			floor,
			old,
			delayedVote,
			delayedQc,
			delayedRound,
			delayedAck,
			restore,
			refusedImage,
			current,
			entered,
			debt,
			debtImage,
			debtAfter,
			ack,
			advance,
			future,
			snapshot,
			after: await image(name),
			events,
		};
	} finally {
		for (const owner of owners.reverse()) owner.close();
		IDBDatabase.prototype.transaction = transaction;
	}
}
declare global {
	interface Window {
		signingFrontierRun: typeof run;
	}
}
window.signingFrontierRun = run;
