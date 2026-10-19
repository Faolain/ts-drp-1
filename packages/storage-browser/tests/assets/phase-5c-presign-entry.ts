import {
	signCreatorAnchorRequest,
	signSealRegisteredDigest,
	createRecoverableFinalitySigner,
} from "@ts-drp/keychain/finality";
import {
	completeCreatorSuccessor,
	prepareCreatorClose,
	prepareCreatorSuccessor,
} from "@ts-drp/protocol-v3/creator-close";
import { prepareRoundChange, prepareSealVote } from "@ts-drp/protocol-v3/seal";
import { openCreatorActorHarness } from "./phase-5e-creator-actor-entry.js";
import { openInternalSealVoteStore } from "../../src/internal/seal-vote-store.js";
import { openBrowserSealVoteStore } from "../../src/seal-vote.js";
import { createSealVoter } from "@ts-drp/seal";
import { mintSealStorePort, resolveSealStorePort } from "@ts-drp/seal/internal/storage-port";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { verifySealQC } from "@ts-drp/protocol-v3/seal";
import { resolveSealAuthorityIdentity } from "@ts-drp/protocol-v3/internal/seal-authority-identity";
import { bindCreatorAnchorSigningRequest } from "@ts-drp/protocol-v3/internal/creator-anchor-signing-request";
import { mintSealVoterEnrollment, nativeSigningAdmissionFactory } from "../../../seal/src/internal/seal-vote-intent.js";

// The browser store's port is typed through the built seal package; this entry
// calls the seal source, whose port type carries its own brand.
type SourceSealStorePort = Parameters<typeof nativeSigningAdmissionFactory>[0];

function barrier(): { task: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const task = new Promise<void>((done) => {
		resolve = done;
	});
	return { task, resolve };
}

// Original verified-successor/keychain composition, NOT a new actor lifecycle.
// The q1 carrier is assembled from actual original signed vote bytes and then
// must pass the shipping verifier before it can prepare a successor request.
async function anchorRun(name: string): Promise<unknown> {
	const events: unknown[] = [],
		cleanup: unknown[] = [];
	let ordinal = 0,
		entered = 0,
		delay = false;
	const emit = (event: object): void => {
		events.push({ ordinal: ++ordinal, ...event });
	};
	const gate = barrier(),
		reached = barrier();
	const originalSign = SubtleCrypto.prototype.sign;
	SubtleCrypto.prototype.sign = function (algorithm, key, data): Promise<ArrayBuffer> {
		if ((typeof algorithm === "string" ? algorithm : algorithm.name) === "Ed25519") {
			entered++;
			emit({ kind: "actual-crypto-entered" });
		}
		return originalSign.call(this, algorithm, key, data);
	};
	let harness: Awaited<ReturnType<typeof openCreatorActorHarness>> | undefined;
	let facade: Awaited<ReturnType<typeof openBrowserSealVoteStore>> | undefined;
	let native: Awaited<ReturnType<typeof openInternalSealVoteStore>> | undefined;
	let signing: Promise<unknown> | undefined;
	let outcome: unknown;
	try {
		harness = await openCreatorActorHarness(name);
		facade = await openBrowserSealVoteStore({ databaseName: name });
		native = await openInternalSealVoteStore({ databaseName: name });
		const identity = resolveSealAuthorityIdentity(harness.authority);
		const adapter = resolveSealStorePort(facade.store);
		if (identity === undefined || adapter?.acquireSigningAdmission === undefined)
			throw new Error("ORIGINAL_AUTHORITY_NATIVE_REQUIRED");
		const acquire = adapter.acquireSigningAdmission;
		const store = mintSealStorePort({
			...adapter,
			async acquireSigningAdmission(enrollment) {
				emit({ kind: "bound-anchor-native-acquire-invoked", delayed: delay });
				if (delay) {
					reached.resolve();
					await gate.task;
				}
				return acquire(enrollment);
			},
		});
		const signer = await createRecoverableFinalitySigner({ seed: new Uint8Array(32).fill(0x31) });
		const opened = await createSealVoter({
			authority: harness.authority,
			signer: signer.signer,
			store,
			expectedStorageIncarnation: facade.observation.incarnation,
		});
		if (!opened.ok) throw new Error(`GENUINE_VOTER_OPEN:${opened.reason}`);
		const close = prepareCreatorClose(harness.closeInput);
		if (!close.ok) throw new Error(`GENUINE_CLOSE:${close.reason}`);
		const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
		let commitQc: Uint8Array | undefined;
		for (const phase of ["prepare", "commit"] as const) {
			const voted = await opened.voter.vote({
				expectedRevision: opened.voter.status().revision,
				round: 1,
				phase,
				exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
			});
			if (!voted.ok) throw new Error(`GENUINE_ROUND1_VOTE:${voted.reason}`);
			const vote = decodeCanonical(voted.stored.exactCanonicalPreimageBytes) as Record<string, unknown>;
			const qc = encodeCanonical({
				epoch: vote.epoch,
				kind: "drp-seal-qc",
				objectId: vote.objectId,
				phase: vote.phase,
				proposalDigest: vote.proposalDigest,
				proposalHash: vote.proposalHash,
				round: vote.round,
				votes: [
					{
						signature: hex(voted.stored.signature),
						signerId: vote.signerId,
						voteDigest: hex(hashDomain("ts-drp/seal-vote/v3", voted.stored.exactCanonicalPreimageBytes)),
					},
				],
			});
			const verified = verifySealQC({ authority: harness.authority, exactCanonicalQcBytes: qc });
			if (!verified.ok || verified.round !== 1 || verified.phase !== phase)
				throw new Error("GENUINE_ROUND1_QC_REQUIRED");
			emit({ kind: "actual-signed-qc-verified", phase, round: verified.round, exactCanonicalQcBytes: Array.from(qc) });
			const persisted = (await opened.voter.persistQc({ exactCanonicalQcBytes: qc })) as {
				ok: boolean;
				reason?: string;
			};
			if (!persisted.ok) throw new Error(`GENUINE_QC_PERSIST:${persisted.reason}`);
			if (phase === "commit") commitQc = qc;
		}
		if (commitQc === undefined) throw new Error("GENUINE_COMMIT_QC_REQUIRED");
		for (const row of await native.readPending())
			await native.markDispatched([row.objectId, row.epoch, row.round, row.phase, row.signerId]);
		const floor = await native.advanceRetirementFloor({
			...identity,
			expectedIncarnation: native.incarnation,
			expectedRevision: opened.voter.status().revision,
			retiredBeforeRound: 1,
		});
		if (!floor.ok) throw new Error(`GENUINE_ROUND_FLOOR:${floor.reason}`);
		emit({ kind: "native-round-floor-committed", floor });
		const nativeFactory = nativeSigningAdmissionFactory(
			store as unknown as SourceSealStorePort,
			mintSealVoterEnrollment({ ...identity, expectedIncarnation: facade.observation.incarnation })
		);
		const authoredScopes: unknown[] = [];
		const makeSigning = (): Promise<Uint8Array> => {
			const prepared = prepareCreatorSuccessor({
				authority: harness!.authority,
				close: close.close,
				exactCanonicalCommitQcBytes: commitQc!,
			});
			if (!prepared.ok) throw new Error(`GENUINE_SUCCESSOR:${prepared.reason}`);
			const wire = decodeCanonical(prepared.exactCanonicalAnchorPreimageBytes) as Record<string, unknown>;
			bindCreatorAnchorSigningRequest(prepared.signingRequest, async (scope) => {
				const captured = {
					objectId: scope.objectId,
					epoch: scope.epoch,
					round: scope.round,
					signerId: scope.signerId,
					publicKey: Array.from(scope.publicKey),
					wireEpoch: wire.epoch,
					wireHasRound: Object.hasOwn(wire, "round"),
				};
				authoredScopes.push(captured);
				emit({ kind: "actual-request-scope-consumed", scope: captured });
				return nativeFactory(scope);
			});
			return signCreatorAnchorRequest({ signer: signer.signer, request: prepared.signingRequest }).then((signature) => {
				const completed = completeCreatorSuccessor({ preparation: prepared.preparation, detachedSignature: signature });
				if (!completed.ok) throw new Error(`ORIGINAL_ANCHOR_SIGNATURE_VERIFICATION:${completed.reason}`);
				emit({ kind: "original-successor-signature-verified" });
				return signature;
			});
		};
		const beforeHealthy = entered;
		const healthySignature = await makeSigning();
		const healthy = { signatureBytes: healthySignature.byteLength, entered: entered - beforeHealthy };
		emit({ kind: "bound-anchor-healthy-delivered", healthy });
		delay = true;
		const beforeDelayed = entered;
		signing = makeSigning().then(
			(signature) => ({ fulfilled: true, signatureBytes: signature.byteLength }),
			(cause) => ({
				fulfilled: false,
				cause: String(cause),
				reason: cause instanceof Error && "reason" in cause ? cause.reason : undefined,
			})
		);
		await reached.task;
		const read = await native.acquireRetirementObservation({ objectId: identity.objectId });
		const prepared = await read.prepareFence({
			throughEpoch: 0,
			protectedEpochs: [],
			decisionDigest: "22".repeat(32),
			sourceProofDigest: "33".repeat(32),
		});
		if (!prepared.ok) throw new Error(`NATIVE_EPOCH_PREPARE:${prepared.reason}`);
		const preparedRead = await native.acquireRetirementObservation({ objectId: identity.objectId });
		const committed = await preparedRead.commitPrepared();
		if (!committed.ok) throw new Error(`NATIVE_EPOCH_COMMIT:${committed.reason}`);
		emit({ kind: "native-epoch-retirement-committed", control: committed.control });
		const beforeRead = await native.acquireRetirementObservation({ objectId: identity.objectId });
		const beforeDigest = beforeRead.imageDigest;
		await beforeRead.release();
		gate.resolve();
		const refused = await signing;
		emit({ kind: "bound-anchor-delayed-delivered", result: refused });
		const afterRead = await native.acquireRetirementObservation({ objectId: identity.objectId });
		const afterDigest = afterRead.imageDigest;
		await afterRead.release();
		outcome = { healthy, refused, delayedEntered: entered - beforeDelayed, beforeDigest, afterDigest, authoredScopes };
	} catch (cause) {
		outcome = { setupFailure: String(cause) };
	} finally {
		gate.resolve();
		await Promise.allSettled([signing]);
		for (const close of [() => facade?.close(), () => native?.close(), () => harness?.close()]) {
			try {
				await close();
				cleanup.push({ status: "fulfilled" });
			} catch (cause) {
				cleanup.push({ status: "rejected", cause: String(cause) });
			}
		}
		SubtleCrypto.prototype.sign = originalSign;
	}
	return { events, outcome, cleanup };
}

// Scheduling instrumentation wraps only the original branded adapter. The
// original voter still authors, binds, and consumes its genuine request.
async function boundRun(
	name: string,
	mode: "retired" | "close" | "initial",
	requestKind: "vote" | "round" = "round"
): Promise<unknown> {
	const events: unknown[] = [],
		cleanup: unknown[] = [];
	let ordinal = 0,
		entered = 0;
	const emit = (event: object): void => {
		events.push({ ordinal: ++ordinal, ...event });
	};
	const gate = barrier(),
		reached = barrier(),
		cryptoGate = barrier(),
		cryptoReached = barrier();
	const closeReadTurn = barrier();
	const originalSign = SubtleCrypto.prototype.sign;
	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalGetKey = IDBObjectStore.prototype.getKey;
	let capturingNative = false,
		closeInvoked = false;
	let signingTransaction: IDBTransaction | undefined;
	IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>): IDBTransaction {
		const transaction = originalTransaction.apply(this, args);
		if (capturingNative && transaction.mode === "readonly") signingTransaction = transaction;
		return transaction;
	};
	IDBObjectStore.prototype.getKey = function (query): IDBRequest<IDBValidKey | undefined> {
		const request = originalGetKey.call(this, query);
		if (this.transaction === signingTransaction)
			request.addEventListener(
				"success",
				() => {
					if (closeInvoked) {
						emit({ kind: "signing-native-read-success-after-close" });
						closeReadTurn.resolve();
					}
				},
				{ once: true }
			);
		return request;
	};
	let armed = false;
	SubtleCrypto.prototype.sign = function (algorithm, key, data): Promise<ArrayBuffer> {
		const actual = originalSign.call(this, algorithm, key, data);
		if ((typeof algorithm === "string" ? algorithm : algorithm.name) !== "Ed25519") return actual;
		entered++;
		emit({ kind: "actual-crypto-entered" });
		if (!armed || mode !== "close") return actual;
		cryptoReached.resolve();
		return actual.then(async (bytes) => {
			await cryptoGate.task;
			emit({ kind: "actual-crypto-result-released" });
			return bytes;
		});
	};
	let harness: Awaited<ReturnType<typeof openCreatorActorHarness>> | undefined;
	let facade: Awaited<ReturnType<typeof openBrowserSealVoteStore>> | undefined;
	let native: Awaited<ReturnType<typeof openInternalSealVoteStore>> | undefined;
	let signing: Promise<unknown> | undefined, closing: Promise<void> | undefined, foreign: Promise<unknown> | undefined;
	let outcome: unknown;
	try {
		harness = await openCreatorActorHarness(name);
		if (mode !== "initial") {
			const closed = await harness.actor.close({ closeInput: harness.closeInput });
			if (!closed.ok) throw new Error(`GENUINE_CREATOR_SETUP:${closed.reason}`);
		}
		facade = await openBrowserSealVoteStore({ databaseName: name });
		native = await openInternalSealVoteStore({ databaseName: name });
		if (mode !== "initial") {
			for (const row of await native.readPending())
				await native.markDispatched([row.objectId, row.epoch, row.round, row.phase, row.signerId]);
			const born = await native.acquireRetirementObservation({ objectId: "creator:" + "6".repeat(32) });
			await born.release();
		}
		const adapter = resolveSealStorePort(facade.store);
		if (adapter?.acquireSigningAdmission === undefined) throw new Error("GENUINE_NATIVE_ADAPTER_REQUIRED");
		const acquire = adapter.acquireSigningAdmission;
		const store = mintSealStorePort({
			...adapter,
			async acquireSigningAdmission(enrollment) {
				emit({ kind: "bound-request-native-acquire-invoked" });
				if (mode === "retired") {
					reached.resolve();
					await gate.task;
				}
				capturingNative = true;
				try {
					return await acquire(enrollment);
				} finally {
					capturingNative = false;
				}
			},
		});
		const signer = await createRecoverableFinalitySigner({ seed: new Uint8Array(32).fill(0x31) });
		const opened = await createSealVoter({
			authority: harness.authority,
			signer: signer.signer,
			store,
			expectedStorageIncarnation: facade.observation.incarnation,
		});
		if (!opened.ok) throw new Error(`GENUINE_VOTER_OPEN:${opened.reason}`);
		const before = entered;
		armed = true;
		emit({ kind: `original-bound-${requestKind}-invoked` });
		if (requestKind === "round")
			signing = opened.voter.roundChange({ expectedRevision: opened.voter.status().revision, round: 1 });
		else {
			const close = prepareCreatorClose(harness.closeInput);
			if (!close.ok) throw new Error(`GENUINE_CLOSE:${close.reason}`);
			signing = opened.voter.vote({
				expectedRevision: opened.voter.status().revision,
				round: 1,
				phase: "prepare",
				exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
			});
		}
		let beforeDigest: string | undefined, afterDigest: string | undefined, blocked: unknown;
		if (mode === "retired") {
			await reached.task;
			const captured = await native.acquireRetirementObservation({ objectId: "creator:" + "6".repeat(32) });
			const prepared = await captured.prepareFence({
				throughEpoch: 0,
				protectedEpochs: [],
				decisionDigest: "22".repeat(32),
				sourceProofDigest: "33".repeat(32),
			});
			if (!prepared.ok) throw new Error(`FOREIGN_NATIVE_PREPARE:${prepared.reason}`);
			const preparedRead = await native.acquireRetirementObservation({ objectId: "creator:" + "6".repeat(32) });
			const committed = await preparedRead.commitPrepared();
			if (!committed.ok) throw new Error(`FOREIGN_NATIVE_COMMIT:${committed.reason}`);
			emit({ kind: "foreign-native-retirement-committed", control: committed.control });
			const image = await native.acquireRetirementObservation({ objectId: "creator:" + "6".repeat(32) });
			beforeDigest = image.imageDigest;
			await image.release();
			gate.resolve();
		} else if (mode === "close") {
			await cryptoReached.task;
			const captured = await native.acquireRetirementObservation({ objectId: "creator:" + "6".repeat(32) });
			let foreignDone = false,
				closeDone = false;
			emit({ kind: "foreign-native-prepare-invoked" });
			foreign = captured
				.prepareFence({
					throughEpoch: 0,
					protectedEpochs: [],
					decisionDigest: "22".repeat(32),
					sourceProofDigest: "33".repeat(32),
				})
				.then((result) => {
					foreignDone = true;
					emit({ kind: "foreign-native-prepare-delivered", result });
					return result;
				});
			emit({ kind: "owner-close-invoked" });
			closeInvoked = true;
			closing = facade.close().then(() => {
				closeDone = true;
				emit({ kind: "owner-close-delivered" });
			});
			// Observe an ORIGINAL keepalive request success on this exact signing
			// transaction after close, while foreign prepare RW is queued. No
			// third held reader or timer is allowed to explain the exclusion.
			await closeReadTurn.task;
			blocked = { foreignDone, closeDone };
			emit({ kind: "held-crypto-native-read-delivered", blocked });
			closeInvoked = false;
			cryptoGate.resolve();
		}
		const result = await signing;
		emit({ kind: `original-bound-${requestKind}-delivered`, result });
		if (mode === "retired") {
			const image = await native.acquireRetirementObservation({ objectId: "creator:" + "6".repeat(32) });
			afterDigest = image.imageDigest;
			await image.release();
		}
		if (closing !== undefined) await closing;
		const foreignResult = foreign === undefined ? undefined : await foreign;
		outcome = { result, entered: entered - before, beforeDigest, afterDigest, blocked, foreignResult };
	} catch (cause) {
		outcome = { setupFailure: String(cause) };
	} finally {
		gate.resolve();
		cryptoGate.resolve();
		const joins = await Promise.allSettled([signing, closing, foreign]);
		for (const result of joins)
			if (result.status === "rejected") cleanup.push({ status: "rejected", cause: String(result.reason) });
		for (const close of [() => facade?.close(), () => native?.close(), () => harness?.close()]) {
			try {
				await close();
				cleanup.push({ status: "fulfilled" });
			} catch (cause) {
				cleanup.push({ status: "rejected", cause: String(cause) });
			}
		}
		SubtleCrypto.prototype.sign = originalSign;
		IDBDatabase.prototype.transaction = originalTransaction;
		IDBObjectStore.prototype.getKey = originalGetKey;
	}
	return { mode, events, outcome, cleanup };
}

async function run(name: string, kind: "vote" | "round" | "anchor"): Promise<unknown> {
	const events: unknown[] = [],
		cleanup: unknown[] = [];
	let ordinal = 0,
		entered = 0;
	const emit = (event: object): void => {
		events.push({ ordinal: ++ordinal, ...event });
	};
	const originalSign = SubtleCrypto.prototype.sign;
	SubtleCrypto.prototype.sign = function (algorithm, key, data): Promise<ArrayBuffer> {
		if ((typeof algorithm === "string" ? algorithm : algorithm.name) === "Ed25519") {
			entered++;
			emit({ kind: "actual-crypto-entered" });
		}
		return originalSign.call(this, algorithm, key, data);
	};
	let harness: Awaited<ReturnType<typeof openCreatorActorHarness>> | undefined;
	let native: Awaited<ReturnType<typeof openInternalSealVoteStore>> | undefined;
	let outcome: unknown;
	try {
		harness = await openCreatorActorHarness(name);
		const closed = await harness.actor.close({ closeInput: harness.closeInput });
		if (!closed.ok) throw new Error(`GENUINE_CREATOR_SETUP:${closed.reason}`);
		emit({ kind: "genuine-creator-closed" });
		native = await openInternalSealVoteStore({ databaseName: name });
		for (const row of await native.readPending())
			await native.markDispatched([row.objectId, row.epoch, row.round, row.phase, row.signerId]);
		const objectId = "creator:" + "6".repeat(32);
		const held = await native.acquireRetirementObservation({ objectId });
		const prepared = await held.prepareFence({
			throughEpoch: 0,
			protectedEpochs: [],
			decisionDigest: "22".repeat(32),
			sourceProofDigest: "33".repeat(32),
		});
		if (!prepared.ok) throw new Error(`GENUINE_NATIVE_PREPARE:${prepared.reason}`);
		const captured = await native.acquireRetirementObservation({ objectId });
		const committed = await captured.commitPrepared();
		if (!committed.ok) throw new Error(`GENUINE_NATIVE_COMMIT:${committed.reason}`);
		emit({ kind: "native-retirement-committed", control: committed.control });
		const signer = await createRecoverableFinalitySigner({ seed: new Uint8Array(32).fill(0x31) });
		const before = entered;
		const close = prepareCreatorClose(harness.closeInput);
		if (!close.ok) throw new Error(`PREPARE_CLOSE:${close.reason}`);
		let sign: () => Promise<Uint8Array>;
		if (kind === "anchor") {
			const successor = prepareCreatorSuccessor({
				authority: harness.authority,
				close: close.close,
				exactCanonicalCommitQcBytes: closed.exactCanonicalCommitQcBytes,
			});
			if (!successor.ok) throw new Error(`PREPARE_SUCCESSOR:${successor.reason}`);
			sign = () => signCreatorAnchorRequest({ signer: signer.signer, request: successor.signingRequest });
		} else {
			const prepared =
				kind === "round"
					? prepareRoundChange({ authority: harness.authority, highestPrepareQC: null, round: 1 })
					: prepareSealVote({
							authority: harness.authority,
							exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
							phase: "prepare",
							round: 1,
						});
			if (!prepared.ok) throw new Error(`PREPARE_REQUEST:${prepared.reason}`);
			sign = () => signSealRegisteredDigest({ signer: signer.signer, request: prepared.signingRequest });
		}
		emit({ kind: "original-sign-invoked", requestKind: kind });
		try {
			const signature = await sign();
			outcome = { fulfilled: true, signatureBytes: signature.byteLength, entered: entered - before };
		} catch (cause) {
			outcome = { fulfilled: false, cause: String(cause), entered: entered - before };
		}
		emit({ kind: "original-sign-delivered", outcome });
	} catch (cause) {
		outcome = { setupFailure: String(cause) };
	} finally {
		for (const close of [() => harness?.close(), () => native?.close()]) {
			try {
				await close();
				cleanup.push({ status: "fulfilled" });
			} catch (cause) {
				cleanup.push({ status: "rejected", cause: String(cause) });
			}
		}
		SubtleCrypto.prototype.sign = originalSign;
	}
	return { kind, events, outcome, cleanup };
}
declare global {
	interface Window {
		presignRun: typeof run;
		presignBoundRun: typeof boundRun;
		presignAnchorRun: typeof anchorRun;
	}
}
window.presignRun = run;
window.presignBoundRun = boundRun;
window.presignAnchorRun = anchorRun;
