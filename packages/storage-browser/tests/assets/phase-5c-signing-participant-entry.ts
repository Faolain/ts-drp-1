import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { resolveCreatorCloseEvidenceStore } from "@ts-drp/seal/internal/creator-close-intent";
import {
	resolveSealStorePort,
	type SigningDependencyObservation,
	type SigningEvidenceRetirementEntry,
	type SigningRetirementControl,
	type SigningRetirementControlWidth,
	type SigningRetirementObservation,
	signingRetirementDataDigest,
	signingRetirementFrameDigest,
	signingRetirementPrefixWidths,
	type SigningRetirementPreparation,
	type SigningRetirementResult,
	type SigningSummaryRetirementSource,
} from "@ts-drp/seal/internal/storage-port";

import { SIGNING_FRONTIER_SCHEMA_AUTHORITY } from "../../src/internal/schema-idb.js";
import { type InternalSealVoteStore, openInternalSealVoteStore } from "../../src/internal/seal-vote-store.js";
import { openBrowserSealEvidenceStore } from "../../src/seal-evidence.js";
import { openBrowserSealVoteStore } from "../../src/seal-vote.js";
import { openBrowserSealSigningStore } from "../../src/seal-signing.js";

// Original native consumers with synthetic mechanical carriers. No signature,
// source-eligibility, external execution, all-owner or deletion claim.
const objectId = "phase5:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const anchor = "11".repeat(32),
	signerId = "A";
const proposal = (throughEpoch = 0, protectedEpochs: readonly number[] = []): SigningRetirementPreparation => ({
	throughEpoch,
	protectedEpochs,
	decisionDigest: "22".repeat(32),
	sourceProofDigest: "33".repeat(32),
});
const request = <T>(value: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		value.addEventListener("success", () => resolve(value.result), { once: true });
		value.addEventListener("error", () => reject(value.error), { once: true });
	});
const terminal = (transaction: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("NATIVE_ABORT")), { once: true });
	});
async function nativeImage(name: string): Promise<unknown> {
	const db = await request(indexedDB.open(name));
	try {
		const names = Array.from(db.objectStoreNames),
			tx = db.transaction(names),
			done = terminal(tx);
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
function round(
	store: InternalSealVoteStore,
	epoch: number,
	expectedRevision = 0,
	value = 2
): Readonly<Record<string, unknown>> {
	return { anchor, objectId, signerId, epoch, expectedIncarnation: store.incarnation, expectedRevision, round: value };
}
function vote(
	store: InternalSealVoteStore,
	epoch: number,
	expectedRevision: number
): Readonly<Record<string, unknown>> {
	return {
		...round(store, epoch, expectedRevision),
		phase: "prepare",
		valueDigest: "44".repeat(32),
		carrier: {
			exactCanonicalPreimageBytes: encodeCanonical({
				kind: "drp-seal-vote",
				objectId,
				epoch,
				signerId,
				round: 2,
				phase: "prepare",
				proposalDigest: "44".repeat(32),
				proposalHash: "55".repeat(32),
			}),
			signature: new Uint8Array(64).fill(0x42),
		},
	};
}
async function v5(name: string, forged: boolean): Promise<IDBDatabase> {
	const open = indexedDB.open(name, 5);
	open.onupgradeneeded = (): void => {
		for (const entry of SIGNING_FRONTIER_SCHEMA_AUTHORITY.stores)
			open.result.createObjectStore(entry.name, {
				keyPath: typeof entry.keyPath === "string" ? entry.keyPath : [...entry.keyPath],
			});
		const tx = open.transaction;
		if (tx === null) throw new Error("MISSING_UPGRADE_TRANSACTION");
		tx.objectStore("storageMeta").add({ key: "incarnation", value: "ab".repeat(16) });
		tx.objectStore("storageMeta").add({ key: `ahe-retirement:${objectId}`, record: new Uint8Array([1, 2, 3]) });
		if (forged) tx.objectStore("storageMeta").add({ key: `signing-retirement:${objectId}`, value: { forged: true } });
		tx.objectStore("signerState").add({
			anchor,
			objectId,
			epoch: 0,
			signerId,
			enteredRound: 2,
			revision: 7,
			retiredBeforeRound: 1,
		});
	};
	return request(open);
}

/**
 * Mechanical native codec conformance only; these fixture rows are not authenticated grants.
 * @param name - Fresh native fixture database name.
 * @returns Exact native/readout widths and refusal observation.
 */
async function runSigningPrefixWidths(name: string): Promise<unknown> {
	const store = await openInternalSealVoteStore({ databaseName: name });
	const checks: unknown[] = [];
	const record = (
		label: string,
		actual: SigningRetirementControl,
		expected: SigningRetirementControlWidth | undefined
	): void => {
		if (expected === undefined) throw new Error("SIGNING_PREFIX_MISSING_WIDTH");
		const key = `signing-retirement:${objectId}`;
		checks.push({
			label,
			actual: {
				revision: actual.revision,
				sequence: actual.sequence,
				controlBytes: encodeCanonical(actual).byteLength,
				storageMetaFrameBytes: encodeCanonical(["storageMeta", key, { key, value: actual }]).byteLength,
				...(actual.drain == null ? {} : { cursor: actual.drain.cursor, batches: actual.drain.batches }),
			},
			expected,
		});
	};
	const must = (value: SigningRetirementResult): SigningRetirementControl => {
		if (!value.ok) throw new Error(`SIGNING_PREFIX_NATIVE_REFUSAL:${value.reason}`);
		return value.control;
	};
	try {
		await store.commitRound(round(store, 0));
		const db = await request(indexedDB.open(name));
		try {
			const tx = db.transaction(["storageMeta", "sealEvidence", "signerState"], "readwrite", { durability: "strict" }),
				done = terminal(tx);
			const initial: SigningRetirementControl = {
				kind: "signing-retirement-control-1",
				objectId,
				incarnation: store.incarnation,
				revision: 126,
				sequence: 63,
				active: null,
				completed: proposal(0, [0]),
			};
			await request(tx.objectStore("storageMeta").put({ key: `signing-retirement:${objectId}`, value: initial }));
			const prior = await request(tx.objectStore("signerState").get([objectId, 0, signerId]));
			await request(
				tx
					.objectStore("signerState")
					.put({ ...prior, highestPrepareQC: { mechanical: true }, finalizedCommitQC: { mechanical: true } })
			);
			for (let epoch = 0; epoch < 17; epoch++)
				await request(
					tx
						.objectStore("sealEvidence")
						.put({ objectId, epoch, signerId, phase: "finalized", revision: 1, storageIncarnation: store.incarnation })
				);
			await done;
		} finally {
			db.close();
		}
		let observed = await store.acquireRetirementObservation({ objectId });
		const target = proposal(16),
			entries: SigningEvidenceRetirementEntry[] = observed
				.readExactCanonicalRows()
				.map((bytes) => ({ bytes, frame: decodeCanonical(bytes) as unknown[] }))
				.filter(({ frame }) => frame[0] === "sealEvidence")
				.map(({ bytes, frame }) => ({
					key: frame[1] as readonly [string, number, string],
					revision: 1,
					frameDigest: signingRetirementFrameDigest(bytes),
				}));
		let widths = signingRetirementPrefixWidths(observed.control, {
			preparationBytes: encodeCanonical(target).byteLength,
			drain: { kind: "evidence", entriesBytes: encodeCanonical(entries).byteLength, entryCount: entries.length },
		});
		record("old", observed.control, widths.old);
		record("prepare127", must(await observed.prepareFence(target)), widths.prepared);
		observed = await store.acquireRetirementObservation({ objectId });
		record("abort128", must(await observed.abortPrepared()), widths.aborted);
		observed = await store.acquireRetirementObservation({ objectId });
		widths = signingRetirementPrefixWidths(observed.control, {
			preparationBytes: encodeCanonical(target).byteLength,
			drain: { kind: "evidence", entriesBytes: encodeCanonical(entries).byteLength, entryCount: entries.length },
		});
		record("prepare", must(await observed.prepareFence(target)), widths.prepared);
		observed = await store.acquireRetirementObservation({ objectId });
		const completed = must(await observed.commitPrepared());
		record("complete", completed, widths.completed);
		observed = await store.acquireRetirementObservation({ objectId });
		record(
			"evidence-begin",
			must(
				await observed.beginEvidenceDrain({
					baseControl: completed,
					entries,
					sourceDataDigest: signingRetirementDataDigest(observed.readExactCanonicalRows(), objectId),
				})
			),
			widths.drainPrefixes[0]
		);
		let unsupported = false;
		observed = await store.acquireRetirementObservation({ objectId });
		try {
			signingRetirementPrefixWidths(observed.control, { preparationBytes: encodeCanonical(target).byteLength });
		} catch {
			unsupported = true;
		}
		record("evidence16", must(await observed.drainEvidenceBatch()), widths.drainPrefixes[1]);
		observed = await store.acquireRetirementObservation({ objectId });
		record("evidence17", must(await observed.drainEvidenceBatch()), widths.drainPrefixes[2]);
		observed = await store.acquireRetirementObservation({ objectId });
		widths = signingRetirementPrefixWidths(observed.control, {
			preparationBytes: encodeCanonical(target).byteLength,
		});
		record("retained-drain-old", observed.control, widths.old);
		record("retained-drain-prepare", must(await observed.prepareFence(target)), widths.prepared);
		observed = await store.acquireRetirementObservation({ objectId });
		record("retained-drain-abort", must(await observed.abortPrepared()), widths.aborted);
		observed = await store.acquireRetirementObservation({ objectId });
		const frames = observed.readExactCanonicalRows(),
			source: SigningSummaryRetirementSource = {
				entries: frames
					.map((bytes) => ({ bytes, frame: decodeCanonical(bytes) as unknown[] }))
					.filter(({ frame }) => frame[0] === "signerState")
					.map(({ bytes, frame }) => ({
						store: "signerState",
						key: frame[1] as readonly [string, number, string],
						frameDigest: signingRetirementFrameDigest(bytes),
					})),
				sourceDataDigest: signingRetirementDataDigest(frames, objectId),
				resumeBasisDigest: observed.imageDigest,
				eligibilityFence: target,
			};
		const summaryTarget = { ...target, summarySource: source };
		widths = signingRetirementPrefixWidths(observed.control, {
			preparationBytes: encodeCanonical(summaryTarget).byteLength,
			drain: { kind: "summary", sourceBytes: encodeCanonical(source).byteLength, entryCount: source.entries.length },
		});
		record("summary-prepare", must(await observed.prepareFence(summaryTarget)), widths.prepared);
		observed = await store.acquireRetirementObservation({ objectId });
		const summaryComplete = must(await observed.commitPrepared());
		record("summary-complete", summaryComplete, widths.completed);
		observed = await store.acquireRetirementObservation({ objectId });
		record(
			"summary-begin",
			must(
				await observed.beginSummaryDrain({
					kind: "signing-summary-retirement-plan-2",
					baseControl: summaryComplete,
					...source,
				})
			),
			widths.drainPrefixes[0]
		);
		observed = await store.acquireRetirementObservation({ objectId });
		record("summary-terminal", must(await observed.drainEvidenceBatch()), widths.drainPrefixes[1]);
		return { checks, unsupported, entryCount: entries.length, summaryCount: source.entries.length };
	} finally {
		await store.close();
	}
}

async function run(name: string, scenario: string): Promise<unknown> {
	const events: Record<string, unknown>[] = [],
		results: Record<string, unknown> = {},
		images: Record<string, unknown> = {};
	const cleanup: unknown[] = [],
		close: (() => Promise<unknown>)[] = [];
	let ordinal = 0,
		transactionId = 0,
		publicId = 0;
	const ids = new WeakMap<IDBTransaction, number>();
	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalPut = IDBObjectStore.prototype.put,
		originalAdd = IDBObjectStore.prototype.add;
	const emit = (value: Record<string, unknown>): void => {
		events.push({ ordinal: ++ordinal, ...value });
	};
	IDBDatabase.prototype.transaction = function (stores, mode, options): IDBTransaction {
		const tx = originalTransaction.call(this, typeof stores === "string" ? stores : Array.from(stores), mode, options),
			id = ++transactionId;
		ids.set(tx, id);
		emit({ kind: "native-invoke", id, mode: tx.mode, stores: Array.from(tx.objectStoreNames) });
		tx.addEventListener("complete", () => emit({ kind: "native-complete", id }), { once: true });
		tx.addEventListener("abort", () => emit({ kind: "native-abort", id, error: tx.error?.name ?? null }), {
			once: true,
		});
		return tx;
	};
	for (const [kind, original] of [
		["put", originalPut],
		["add", originalAdd],
	] as const) {
		IDBObjectStore.prototype[kind] = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
			const result = key === undefined ? original.call(this, value) : original.call(this, value, key);
			result.addEventListener(
				"success",
				() => emit({ kind: "native-write-request-success", id: ids.get(this.transaction), store: this.name }),
				{ once: true }
			);
			return result;
		};
	}
	const call = async (label: string, action: () => Promise<unknown>): Promise<unknown> => {
		const id = ++publicId;
		emit({ kind: "public-invoke", id, label });
		try {
			const value = await action();
			results[label] = value === undefined ? { undefined: true } : value;
			emit({ kind: "public-deliver", id, label, fulfilled: true });
			return value;
		} catch (cause) {
			results[label] = { threw: String(cause) };
			emit({ kind: "public-deliver", id, label, fulfilled: false, cause: String(cause) });
			return undefined;
		}
	};
	try {
		if (scenario === "prefix-widths") {
			results.widths = await runSigningPrefixWidths(name);
		} else if (scenario === "migration" || scenario === "forged-v5") {
			const legacy = await v5(name, scenario === "forged-v5");
			let changed = false;
			legacy.onversionchange = (): void => {
				changed = true;
				legacy.close();
			};
			images.before = await nativeImage(name);
			const store = await call("open", async () => {
				const opened = await openInternalSealVoteStore({ databaseName: name });
				close.push(() => opened.close());
				return { version: opened.schema.version, incarnation: opened.incarnation };
			});
			results.versionChanged = changed;
			try {
				legacy.transaction("signerState");
				results.oldHandleRefused = false;
			} catch {
				results.oldHandleRefused = true;
			}
			images.after = await nativeImage(name);
			results.opened = store !== undefined;
		} else {
			const store = await openInternalSealVoteStore({ databaseName: name });
			close.push(() => store.close());
			await call("seed", () => store.commitRound(round(store, 0)));
			if (scenario === "lifecycle")
				await call("round-frontier", () =>
					store.advanceRetirementFloor({
						anchor,
						objectId,
						signerId,
						epoch: 0,
						expectedIncarnation: store.incarnation,
						expectedRevision: 1,
						retiredBeforeRound: 1,
					})
				);
			if (scenario === "budget") {
				const db = await request(indexedDB.open(name));
				try {
					const tx = db.transaction("signerState", "readwrite"),
						done = terminal(tx),
						native = tx.objectStore("signerState");
					const row = await request(native.get([objectId, 0, signerId]));
					await request(native.put({ ...row, payload: new Uint8Array(262_144) }));
					await done;
				} finally {
					db.close();
				}
				images.before = await nativeImage(name);
				await call("acquire", () => store.acquireRetirementObservation({ objectId }));
				images.after = await nativeImage(name);
			} else if (scenario === "capture-close") {
				images.before = await nativeImage(name);
				const originalCursor = IDBObjectStore.prototype.openKeyCursor;
				let closing: Promise<unknown> | undefined;
				IDBObjectStore.prototype.openKeyCursor = function (range, direction): IDBRequest<IDBCursor | null> {
					const result = originalCursor.call(this, range, direction);
					if (this.name === "voteOutbox")
						result.addEventListener("success", () => {
							if (result.result !== null || closing !== undefined) return;
							// Actual final addressed cursor success, not a substituted read.
							// Close in this event's microtask turn before capture delivery.
							queueMicrotask(() => {
								emit({ kind: "capture-final-cursor-close", id: ids.get(this.transaction) });
								closing = call("capture-owner-close", () => store.close());
							});
						});
					return result;
				};
				try {
					await call("capture-close", async () => {
						const observed = await store.acquireRetirementObservation({ objectId });
						await call("returned-check", () => observed.check());
						return {
							control: observed.control,
							imageDigest: observed.imageDigest,
							logicalBytes: observed.logicalBytes,
						};
					});
				} finally {
					IDBObjectStore.prototype.openKeyCursor = originalCursor;
					if (closing !== undefined) await closing;
				}
				results.closeEntered = closing !== undefined;
				images.after = await nativeImage(name);
			} else if (scenario === "close-window") {
				images.before = await nativeImage(name);
				const observed = await store.acquireRetirementObservation({ objectId });
				results.capture = {
					control: observed.control,
					imageDigest: observed.imageDigest,
					logicalBytes: observed.logicalBytes,
				};
				let joined = false;
				const closing = call("owner-close", () => store.close()).then(() => {
					joined = true;
				});
				results.closeJoinedBeforeMutation = joined;
				await call("during-close-round", () => store.commitRound(round(store, 3)));
				await closing;
				await call("closed-check", () => observed.check());
				images.after = await nativeImage(name);
			} else if (scenario === "custody") {
				const facade = await openBrowserSealVoteStore({ databaseName: name });
				close.push(() => facade.close());
				const evidence = await openBrowserSealEvidenceStore({ databaseName: name });
				close.push(() => evidence.close());
				results.foreign = resolveSealStorePort({}) === undefined;
				results.copied = resolveSealStorePort({ ...facade.store }) === undefined;
				results.foreignEvidence = resolveCreatorCloseEvidenceStore({}) === undefined;
				const adapter = resolveSealStorePort(facade.store);
				if (adapter?.acquireRetirementObservation === undefined) throw new Error("MISSING_NATIVE_PARTICIPANT");
				const observed = await adapter.acquireRetirementObservation({ objectId });
				results.capture = {
					control: observed.control,
					imageDigest: observed.imageDigest,
					logicalBytes: observed.logicalBytes,
				};
				await call("copied-check", () => observed.check.call({ ...observed }));
				await call("early-abort", () => observed.abortPrepared());
				await call("prepare", () => observed.prepareFence(proposal()));
				await call("used-check", () => observed.check());
				const evidenceAdapter = resolveCreatorCloseEvidenceStore(evidence.store);
				if (evidenceAdapter?.acquireRetirementObservation === undefined)
					throw new Error("MISSING_EVIDENCE_PARTICIPANT");
				const prepared = await evidenceAdapter.acquireRetirementObservation({ objectId });
				await call("owner-close", () => evidence.close());
				await call("closed-check", () => prepared.check());
			} else if (scenario === "image-cas") {
				const observed = await store.acquireRetirementObservation({ objectId });
				results.capture = {
					control: observed.control,
					imageDigest: observed.imageDigest,
					logicalBytes: observed.logicalBytes,
				};
				images.before = await nativeImage(name);
				const foreign = await request(indexedDB.open(name));
				try {
					const tx = foreign.transaction("signerState", "readwrite", { durability: "strict" }),
						done = terminal(tx);
					const work = (async (): Promise<void> => {
						const native = tx.objectStore("signerState"),
							row = await request(native.get([objectId, 0, signerId]));
						await request(native.put({ ...row, enteredRound: 3 }));
						await done;
					})();
					// Genuine foreign RW queued behind the original held RO; it gets the
					// native turn before prepare's later RW after joined RO release.
					await call("prepare", () => observed.prepareFence(proposal()));
					await work;
					await call("replay", () => observed.prepareFence(proposal()));
					images.after = await nativeImage(name);
				} finally {
					foreign.close();
				}
			} else if (scenario === "lost-response") {
				const observed = await store.acquireRetirementObservation({ objectId });
				const lost = new Error("TEST_RESPONSE_LOST_AFTER_NATIVE_COMPLETION");
				await call("prepare-lost", async () => {
					const actual = await observed.prepareFence(proposal());
					emit({ kind: "test-response-loss", actual });
					throw lost;
				});
				images.prepared = await nativeImage(name);
				const recovered = await store.acquireRetirementObservation({ objectId });
				results.readback = {
					control: recovered.control,
					imageDigest: recovered.imageDigest,
					logicalBytes: recovered.logicalBytes,
				};
				await call("commit-readback", () => recovered.commitPrepared());
				images.committed = await nativeImage(name);
			} else {
				const observed = await store.acquireRetirementObservation({ objectId });
				results.capture = {
					control: observed.control,
					imageDigest: observed.imageDigest,
					logicalBytes: observed.logicalBytes,
				};
				if (scenario === "lifecycle") {
					await call("old-round-scope", () => observed.checkSigningScope({ epoch: 0, round: 0, signerId }));
					await call("current-round-scope", () => observed.checkSigningScope({ epoch: 0, round: 2, signerId }));
				}
				const target = scenario === "holes" ? proposal(2, [1]) : proposal();
				await call("prepare", () => observed.prepareFence(target));
				images.prepared = await nativeImage(name);
				await call("fenced-vote", () => store.commitVote(vote(store, 0, 1)));
				await call("fenced-round", () => store.commitRound(round(store, 0, 1)));
				await call("fenced-ack", () => store.markDispatched([objectId, 0, 2, "prepare", signerId]));
				images.refused = await nativeImage(name);
				let prepared = await store.acquireRetirementObservation({ objectId });
				await call("fenced-scope", () => prepared.checkSigningScope({ epoch: 0, round: 2, signerId }));
				await call("future-scope", () => prepared.checkSigningScope({ epoch: 3, round: 0, signerId }));
				await call("abort", () => prepared.abortPrepared());
				const idle = await store.acquireRetirementObservation({ objectId });
				await call("prepare-again", () => idle.prepareFence(target));
				prepared = await store.acquireRetirementObservation({ objectId });
				await call("commit", () => prepared.commitPrepared());
				images.committed = await nativeImage(name);
				await call("retired-round", () => store.commitRound(round(store, 0, 1)));
				await call("future-round", () => store.commitRound(round(store, 3)));
				if (scenario === "holes") {
					await call("hole-round", () => store.commitRound(round(store, 1)));
					const next = await store.acquireRetirementObservation({ objectId });
					await call("reintroduce", () => next.prepareFence(proposal(3, [0, 1])));
					await call("valid-next", () => next.prepareFence(proposal(3, [1, 3])));
				}
			}
		}
	} catch (cause) {
		results.primary = String(cause);
	} finally {
		for (const operation of close.reverse()) {
			try {
				await operation();
				cleanup.push({ status: "fulfilled" });
			} catch (cause) {
				cleanup.push({ status: "rejected", cause: String(cause) });
			}
		}
		IDBDatabase.prototype.transaction = originalTransaction;
		IDBObjectStore.prototype.put = originalPut;
		IDBObjectStore.prototype.add = originalAdd;
	}
	return { scenario, results, images, events, cleanup };
}
/** Diagnostic of actual independent connections, not an attribution of any old
 * failure. A genuine successful vote check supplies the causal barrier; the
 * timer is only an emergency rescue, never transaction keepalive or evidence. */
async function runSigningAcquisitionCycle(name: string): Promise<unknown> {
	const events: string[] = [], transactions: {id: number; mode: string; stage: string; terminal?: string}[] = [];
	let stage = "open", emergency = false, writerStarted = false, writerFinished = false, evidenceDelivered = false;
	let vote: Awaited<ReturnType<typeof openBrowserSealVoteStore>> | undefined;
	let evidence: Awaited<ReturnType<typeof openBrowserSealEvidenceStore>> | undefined;
	let foreign: IDBDatabase | undefined, writer: IDBTransaction | undefined;
	let voteRead: SigningDependencyObservation | undefined, evidenceRead: SigningDependencyObservation | undefined;
	let evidenceTask: Promise<SigningDependencyObservation> | undefined, writerTask: Promise<void> | undefined;
	let before: unknown, after: unknown, observation: unknown, primary: string | undefined;
	const originalTransaction = IDBDatabase.prototype.transaction;
	const cleanup: {label: string; status: string; reason?: string}[] = [];
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	const rescue = (): void => {
		emergency = true; events.push("emergency-rescue");
		try { writer?.abort(); } catch { /* Original native terminal owns the result. */ }
		void voteRead?.release().catch(() => undefined);
		void evidenceRead?.release().catch(() => undefined);
		void vote?.close().catch(() => undefined);
		void evidence?.close().catch(() => undefined);
	};
	try {
		vote = await openBrowserSealVoteStore({databaseName: name});
		evidence = await openBrowserSealEvidenceStore({databaseName: name});
		foreign = await request(indexedDB.open(name));
		before = await nativeImage(name);
		const votePort = resolveSealStorePort(vote.store), evidencePort = resolveCreatorCloseEvidenceStore(evidence.store);
		if (votePort?.acquireSigningDependencyObservation === undefined || evidencePort?.acquireSigningDependencyObservation === undefined)
			throw new Error("NATIVE_SIGNING_DEPENDENCY_PORT_REQUIRED");
		IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
			const tx = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
			if (this.name === name) {
				const row = {id: transactions.length + 1, mode: tx.mode, stage, terminal: undefined as string | undefined};
				transactions.push(row); events.push(`native-create:${row.id}:${stage}`);
				tx.addEventListener("complete", () => {row.terminal = "complete"; events.push(`native-complete:${row.id}`);}, {once: true});
				tx.addEventListener("abort", () => {row.terminal = "abort"; events.push(`native-abort:${row.id}`);}, {once: true});
			}
			return tx;
		};
		watchdog = setTimeout(rescue, 8000);
		stage = "vote-ro";
		voteRead = await votePort.acquireSigningDependencyObservation({objectId});
		const voteRows = voteRead.readExactCanonicalRows(); events.push("vote-delivered");
		stage = "foreign-rw";
		writer = foreign.transaction("storageMeta", "readwrite", {durability: "strict"});
		writerTask = terminal(writer).then(() => {writerFinished = true; events.push("foreign-complete");});
		void writerTask.catch(() => undefined);
		const meta = writer.objectStore("storageMeta"), read = meta.get("incarnation");
		read.addEventListener("success", () => {
			writerStarted = true; events.push("foreign-read-started");
			meta.put(read.result); // Exact no-op write: scheduling witness, no logical mutation.
		}, {once: true});
		stage = "evidence-ro";
		evidenceTask = evidencePort.acquireSigningDependencyObservation({objectId}).then(value => {
			evidenceRead = value; evidenceDelivered = true; events.push("evidence-delivered"); return value;
		});
		void evidenceTask.catch(() => undefined);
		await voteRead.check(); events.push("vote-check-after-evidence-request");
		observation = {writerStarted, writerFinished, evidenceDelivered, emergency,
			transactions: transactions.map(row => ({...row}))};
		stage = "rescue-by-vote-release"; events.push("vote-release-request");
		await voteRead.release(); voteRead = undefined; events.push("vote-release-joined");
		await writerTask;
		const joinedEvidence = await evidenceTask;
		await joinedEvidence.check();
		const evidenceRows = joinedEvidence.readExactCanonicalRows();
		if (voteRows.length !== evidenceRows.length || voteRows.some((bytes, index) =>
			bytes.length !== evidenceRows[index]!.length || bytes.some((value, offset) => value !== evidenceRows[index]![offset])))
			throw new Error("NOOP_WRITER_CHANGED_CAPTURED_SIGNING_ROWS");
		events.push("evidence-check-joined");
		await joinedEvidence.release(); evidenceRead = undefined;
		events.push("evidence-release-joined");
	} catch (cause) { primary = String(cause); rescue(); }
	finally {
		if (watchdog !== undefined) clearTimeout(watchdog);
		if (!writerFinished) {try { writer?.abort(); } catch { /* Already terminal. */ }}
		const work = [
			["vote-read", () => voteRead?.release()], ["evidence-read", () => evidenceRead?.release()],
			["vote-owner", () => vote?.close()], ["evidence-owner", () => evidence?.close()],
			["evidence-acquisition", () => evidenceTask?.then(() => undefined)],
			["foreign-writer", () => writerTask],
		] as const;
		const results = await Promise.allSettled(work.map(async ([, close]) => {await close();}));
		for (const [index, result] of results.entries()) cleanup.push({label: work[index]![0], status: result.status,
			...(result.status === "rejected" ? {reason: String(result.reason)} : {})});
		IDBDatabase.prototype.transaction = originalTransaction;
		foreign?.close();
	}
	if (primary === undefined) after = await nativeImage(name);
	return {observation, events, transactions, cleanup, emergency, writerStarted, writerFinished, evidenceDelivered,
		before, after, ...(primary === undefined ? {} : {primary})};
}

/** Same race under one genuine native owner. Synthetic mechanical signer row:
 * this verifies custody/progress, not its signature or retirement eligibility. */
async function runSharedSigningAcquisition(name: string, retirement = false): Promise<unknown> {
	const pair = await openBrowserSealSigningStore({databaseName: name});
	const raw = await request(indexedDB.open(name));
	const votes = resolveSealStorePort(pair.vote.store), evidence = resolveCreatorCloseEvidenceStore(pair.evidence.store);
	if (votes?.acquireSigningDependencyObservation === undefined || evidence?.acquireSigningDependencyObservation === undefined)
		throw Error("SHARED_SIGNING_NATIVE_PORT_REQUIRED");
	const seed = raw.transaction("signerState", "readwrite", {durability: "strict"}), seeded = terminal(seed);
	seed.objectStore("signerState").put({objectId, epoch: 0, signerId, enteredRound: 0, revision: 0});
	await seeded;
	const before = await nativeImage(name);
	const originalTransaction = IDBDatabase.prototype.transaction, originalGet = IDBObjectStore.prototype.get;
	const originalCursor = IDBObjectStore.prototype.openKeyCursor;
	let stage = "vote", imageReads = 0, writerStarted = false, writerFinished = false, emergency = false;
	let vote: SigningDependencyObservation | undefined, peer: SigningDependencyObservation | undefined;
	let writer: IDBTransaction | undefined, writerTask: Promise<void> | undefined;
	const transactions: {mode: string; stage: string; terminal?: string}[] = [];
	const events: string[] = [], checks: Record<string, unknown> = {};
	const acquireVote = (address = objectId) => retirement
		? votes.acquireRetirementObservation!({objectId: address}) : votes.acquireSigningDependencyObservation!({objectId: address});
	const acquireEvidence = (address = objectId) => retirement
		? evidence.acquireRetirementObservation!({objectId: address}) : evidence.acquireSigningDependencyObservation!({objectId: address});
	const sameRows = (a: readonly Uint8Array[], b: readonly Uint8Array[]): boolean => a.length === b.length &&
		a.every((bytes, index) => bytes.length === b[index]!.length && bytes.every((value, offset) => value === b[index]![offset]));
	IDBDatabase.prototype.transaction = function(this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
		const tx = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
		if (this.name === name) {
			const item = {mode: tx.mode, stage, terminal: undefined as string | undefined}; transactions.push(item);
			tx.addEventListener("complete", () => {item.terminal = "complete";}, {once: true});
			tx.addEventListener("abort", () => {item.terminal = "abort";}, {once: true});
		}
		return tx;
	};
	IDBObjectStore.prototype.get = function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
		if (this.transaction.db.name === name && this.transaction.mode === "readonly") imageReads++;
		return Reflect.apply(originalGet, this, args) as IDBRequest;
	};
	IDBObjectStore.prototype.openKeyCursor = function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["openKeyCursor"]>) {
		if (this.transaction.db.name === name && this.transaction.mode === "readonly") imageReads++;
		return Reflect.apply(originalCursor, this, args) as IDBRequest;
	};
	const rescue = setTimeout(() => {
		emergency = true;
		try {writer?.abort();} catch { /* Already terminal. */ }
		void pair.close().catch(() => undefined);
	}, 8000);
	let primary: string | undefined;
	try {
		vote = await acquireVote();
		checks.firstImageReads = imageReads;
		const originalRows = vote.readExactCanonicalRows();
		checks.rowCount = originalRows.length;
		stage = "foreign";
		writer = raw.transaction("storageMeta", "readwrite", {durability: "strict"});
		writerTask = terminal(writer).then(() => {writerFinished = true; events.push("writer-joined");});
		void writerTask.catch(() => undefined);
		const meta = writer.objectStore("storageMeta"), read = meta.get("incarnation");
		read.addEventListener("success", () => {writerStarted = true; meta.put(read.result);}, {once: true});
		stage = "evidence"; imageReads = 0;
		peer = await acquireEvidence();
		checks.secondImageReads = imageReads;
		await peer.check(); await vote.check();
		checks.writerExcludedWithBoth = !writerStarted && !writerFinished;
		checks.sameCompleteRows = sameRows(originalRows, peer.readExactCanonicalRows());
		originalRows[0]![0] ^= 255;
		checks.detachedRows = !sameRows(originalRows, peer.readExactCanonicalRows()) &&
			sameRows(vote.readExactCanonicalRows(), peer.readExactCanonicalRows());
		const refuses = async (operation: () => Promise<unknown>): Promise<boolean> => {
			try {await operation(); return false;} catch {return true;}
		};
		checks.duplicateVoteRefused = await refuses(() => acquireVote());
		checks.duplicateEvidenceRefused = await refuses(() => acquireEvidence());
		checks.foreignObjectRefused = await refuses(() => acquireEvidence("foreign"));
		if (retirement) {
			checks.mixedPurposeRefused = await refuses(() => votes.acquireSigningDependencyObservation!({objectId}));
			checks.mutationBeforeJoin = await (peer as SigningRetirementObservation).prepareFence(proposal(0, [0]));
		}
		await vote.release(); vote = undefined; events.push("vote-child-joined");
		checks.releasedRoleRefused = await refuses(() => acquireVote());
		await peer.check();
		checks.writerExcludedAfterFirstRelease = !writerStarted && !writerFinished;
		if (retirement) {
			stage = "retirement";
			const admittedCheck = peer.check();
			checks.mutationDuringCheck = await (peer as SigningRetirementObservation).prepareFence(proposal(0, [0]));
			await admittedCheck;
			checks.prepareAfterJoin = await (peer as SigningRetirementObservation).prepareFence(proposal(0, [0]));
			checks.mutationRevokesRead = await refuses(() => peer!.check());
			checks.mutationOneUse = await (peer as SigningRetirementObservation).prepareFence(proposal(0, [0]));
		}
		await peer.release(); peer = undefined; events.push("evidence-child-joined");
		await writerTask;
		if (retirement) {
			stage = "readback";
			vote = await acquireVote(); peer = await acquireEvidence();
			await vote.check(); await peer.check();
			checks.freshReadback = vote.control.active?.preparation;
			checks.sameReadback = sameRows(vote.readExactCanonicalRows(), peer.readExactCanonicalRows());
			await vote.release(); vote = undefined; await peer.release(); peer = undefined;
		}
		await pair.close();
		checks.closedRefused = await refuses(() => acquireVote());
	} catch (cause) {primary = String(cause);}
	finally {
		const joined = await Promise.allSettled([vote?.release(), peer?.release()]);
		checks.childCleanupJoined = joined.every(result => result.status === "fulfilled");
		try {await pair.close(); await writerTask;}
		finally {
			clearTimeout(rescue);
			IDBDatabase.prototype.transaction = originalTransaction;
			IDBObjectStore.prototype.get = originalGet;
			IDBObjectStore.prototype.openKeyCursor = originalCursor;
			raw.close();
		}
	}
	return {checks, transactions, events, emergency, writerStarted, writerFinished, before, after: await nativeImage(name),
		...(primary === undefined ? {} : {primary})};
}

declare global {
	interface Window {
		signingParticipantRun: typeof run;
		signingAcquisitionCycle: typeof runSigningAcquisitionCycle;
		sharedSigningAcquisition: typeof runSharedSigningAcquisition;
	}
}
window.signingParticipantRun = run;
window.signingAcquisitionCycle = runSigningAcquisitionCycle;
window.sharedSigningAcquisition = runSharedSigningAcquisition;
