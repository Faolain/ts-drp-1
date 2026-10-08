import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { createBrowserDurableIssuanceStore } from "@ts-drp/storage-browser/issuance";

// eslint-disable-next-line import/no-unresolved -- resolved by the private Phase 2l-d bundler.
import { runPhase2lDRealAdapterConformance } from "#phase-2l-d-shared-harness";
// eslint-disable-next-line import/no-unresolved -- resolved by the private Phase 2l-d bundler.
import { createTransactionalVertexIssuer, verifyReceivedVertex } from "#phase-2l-d-unmodified-protocol";
import profile from "../../../../tests/fixtures/phase-0g2s/ed25519-acceptance-profile-contract.json" with { type: "json" };

declare global {
	interface Window {
		phase2lDRun(caseId: "golden-path" | "lineage-recovery" | "shared-conformance"): Promise<unknown>;
	}
}

const DATABASE_SUFFIX = "--drp-issuance-v1";
const LINEAGE_SCOPE = Object.freeze({ author: "author:lineage-recovery", objectId: "object:lineage-recovery" });

interface RawLineage {
	readonly exhausted: boolean;
	readonly next: number;
}

interface LineageSeed {
	readonly authorSequence: number;
	readonly lineage: RawLineage | null;
	readonly publishState: "pending" | "published";
}

function fromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.addEventListener("success", () => resolve(), { once: true });
		request.addEventListener("blocked", () => reject(new Error(`delete blocked: ${name}`)), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error(`delete failed: ${name}`)), {
			once: true,
		});
	});
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("transaction aborted")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new Error("transaction failed")), {
			once: true,
		});
	});
}

function errorCode(error: unknown): string {
	return typeof error === "object" && error !== null ? String(Reflect.get(error, "code")) : "NON_OBJECT";
}

async function rejection(operation: () => Promise<unknown>): Promise<unknown> {
	try {
		await operation();
		return null;
	} catch (error) {
		return error;
	}
}

async function seedLineageClosure(primaryDatabaseName: string, seed: LineageSeed): Promise<void> {
	const bootstrap = await createBrowserDurableIssuanceStore({ primaryDatabaseName });
	await bootstrap.close();
	const database = await requestResult(indexedDB.open(`${primaryDatabaseName}${DATABASE_SUFFIX}`));
	try {
		const transaction = database.transaction(["issuanceOutbox", "issuedRecords", "lineages"], "readwrite", {
			durability: "strict",
		});
		const terminal = transactionComplete(transaction);
		const canonicalPreimageBytes = encodeCanonical({ ...LINEAGE_SCOPE, authorSequence: seed.authorSequence });
		const digest = Uint8Array.of(83, 209);
		transaction.objectStore("issuedRecords").add({
			...LINEAGE_SCOPE,
			authorSequence: seed.authorSequence,
			canonicalPreimageBytes,
			digest,
			signature: Uint8Array.of(83, 81),
		});
		transaction.objectStore("issuanceOutbox").add({
			...LINEAGE_SCOPE,
			authorSequence: seed.authorSequence,
			digest,
			publishState: seed.publishState,
		});
		if (seed.lineage !== null) transaction.objectStore("lineages").add({ ...LINEAGE_SCOPE, ...seed.lineage });
		await terminal;
	} finally {
		database.close();
	}
}

async function corruptLineageCase(label: string, seed: LineageSeed): Promise<unknown> {
	const primaryDatabaseName = `phase-2l-d-lineage-${label}-${crypto.randomUUID()}`;
	await seedLineageClosure(primaryDatabaseName, seed);
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName });
	try {
		let publicationCount = 0;
		let pageFailure: unknown = null;
		try {
			publicationCount = (await store.readOutboxPage()).length;
		} catch (error) {
			pageFailure = error;
		}
		const issuedFailure = await rejection(() => store.readIssued(LINEAGE_SCOPE, seed.authorSequence));
		const lineageFailure = await rejection(() => store.readLineage(LINEAGE_SCOPE));
		const repeatedPageFailure = await rejection(() => store.readOutboxPage());
		let builderCalls = 0;
		const issueFailure = await rejection(() =>
			store.transactIssue(LINEAGE_SCOPE, () => {
				builderCalls++;
				throw new Error("poisoned store reached the issuance builder");
			})
		);
		return {
			builderCalls,
			code: errorCode(pageFailure),
			publicationCount,
			sticky:
				pageFailure !== null &&
				issuedFailure === pageFailure &&
				lineageFailure === pageFailure &&
				repeatedPageFailure === pageFailure &&
				issueFailure === pageFailure,
		};
	} finally {
		await store.close();
		await deleteDatabase(`${primaryDatabaseName}${DATABASE_SUFFIX}`);
	}
}

async function validLineageCase(label: string, seed: LineageSeed): Promise<unknown> {
	const primaryDatabaseName = `phase-2l-d-lineage-${label}-${crypto.randomUUID()}`;
	await seedLineageClosure(primaryDatabaseName, seed);
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName });
	try {
		const page = await store.readOutboxPage();
		const issued = await store.readIssued(LINEAGE_SCOPE, seed.authorSequence);
		return {
			authorSequence: page[0]?.commit.authorSequence,
			issued: issued?.authorSequence,
			pageCount: page.length,
			publishState: page[0]?.publishState,
		};
	} finally {
		await store.close();
		await deleteDatabase(`${primaryDatabaseName}${DATABASE_SUFFIX}`);
	}
}

async function lineageRecovery(): Promise<unknown> {
	return {
		corrupt: await Promise.all([
			corruptLineageCase("absent", { authorSequence: 0, lineage: null, publishState: "pending" }),
			corruptLineageCase("equality-unadvanced", {
				authorSequence: 0,
				lineage: { exhausted: false, next: 0 },
				publishState: "pending",
			}),
			corruptLineageCase("lagging", {
				authorSequence: 1,
				lineage: { exhausted: false, next: 0 },
				publishState: "pending",
			}),
		]),
		valid: await Promise.all([
			validLineageCase("ordinary", {
				authorSequence: 0,
				lineage: { exhausted: false, next: 1 },
				publishState: "pending",
			}),
			validLineageCase("maximum", {
				authorSequence: Number.MAX_SAFE_INTEGER,
				lineage: { exhausted: true, next: Number.MAX_SAFE_INTEGER },
				publishState: "published",
			}),
		]),
	};
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function sharedConformance(): Promise<unknown> {
	const primaryDatabaseName = `phase-2l-d-shared-${crypto.randomUUID()}`;
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName });
	try {
		return await runPhase2lDRealAdapterConformance(store);
	} finally {
		await store.close();
		await deleteDatabase(`${primaryDatabaseName}--drp-issuance-v1`);
	}
}

async function goldenPath(): Promise<unknown> {
	const primaryDatabaseName = `phase-2l-d-golden-${crypto.randomUUID()}`;
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName });
	try {
		const issuer = createTransactionalVertexIssuer({
			author: profile.live.preimage.author,
			privateKeySeed: fromHex(profile.live.privateKeySeedHex),
			publicKey: { bytes: fromHex(profile.live.publicKeyHex), format: "raw" },
			transactIssue: store.transactIssue,
		});
		const commit = await issuer.issue({
			anchor: profile.live.preimage.anchor,
			dependencies: profile.live.unsortedDependencies,
			epoch: profile.live.preimage.epoch,
			logicalTime: profile.live.preimage.logicalTime,
			objectId: profile.live.preimage.objectId,
			operation: profile.live.preimage.operation,
		});
		const decoded = decodeCanonical(commit.envelope.canonicalPreimageBytes) as {
			authorSequence: number;
			dependencies: string[];
		};
		const durable = await store.readIssued(commit.issuedRecord.scope, 0);
		const admitted = verifyReceivedVertex({
			domain: profile.live.domain,
			expectedAnchor: profile.live.preimage.anchor,
			receivedCanonicalPreimageBytes: commit.envelope.canonicalPreimageBytes,
			resolveAuthorPublicKey: () => ({ bytes: fromHex(profile.live.publicKeyHex), format: "raw" }),
			signature: commit.envelope.signature,
			suiteId: profile.live.suiteId,
		});
		return {
			accepted: admitted.accepted,
			admissionDigestEqual:
				admitted.digest !== undefined &&
				equalBytes(admitted.digest, commit.envelope.digest) &&
				durable !== null &&
				equalBytes(admitted.digest, durable.envelope.digest),
			authorSequence: decoded.authorSequence,
			dependencies: decoded.dependencies,
			durableClosureEqual:
				durable !== null &&
				durable.authorSequence === commit.authorSequence &&
				equalBytes(durable.envelope.canonicalPreimageBytes, commit.envelope.canonicalPreimageBytes) &&
				equalBytes(durable.envelope.digest, commit.envelope.digest) &&
				equalBytes(durable.envelope.signature, commit.envelope.signature) &&
				durable.issuedRecord.scope.author === commit.issuedRecord.scope.author &&
				durable.issuedRecord.scope.objectId === commit.issuedRecord.scope.objectId &&
				durable.outboxEntry.scope.author === commit.outboxEntry.scope.author &&
				durable.outboxEntry.scope.objectId === commit.outboxEntry.scope.objectId,
			pendingCount: (await store.readOutboxPage({ scope: commit.issuedRecord.scope })).length,
		};
	} finally {
		await store.close();
		await deleteDatabase(`${primaryDatabaseName}--drp-issuance-v1`);
	}
}

window.phase2lDRun = (caseId): Promise<unknown> => {
	if (caseId === "shared-conformance") return sharedConformance();
	if (caseId === "lineage-recovery") return lineageRecovery();
	return goldenPath();
};
