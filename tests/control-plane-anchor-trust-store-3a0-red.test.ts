import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import {
	authenticateCurrentEpochAnchor,
	type AuthenticateCurrentEpochAnchorInput,
	type AuthenticateCurrentEpochAnchorResult,
	installCreatorAnchorTrustRoot,
	type InstallCreatorAnchorTrustRootInput,
	type InstallCreatorAnchorTrustRootResult,
	isAnchorTrustStateRecordBytes,
	openCurrentAnchorTrust,
	type OpenCurrentAnchorTrustInput,
	type OpenCurrentAnchorTrustResult,
} from "@ts-drp/protocol-v3";
import {
	type AheDurableStore,
	type BlobDigest,
	digestBlob,
	type ExpectedHead,
	type GenerationId,
	type GenerationRef,
	parseGenerationId,
	parseStorageObjectId,
	type PresentHead,
	type StorageObjectId,
} from "@ts-drp/storage";
import { createMemoryAheDurableStore } from "@ts-drp/storage";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	bytesHex,
	contract,
	type CreatorMaterial,
	makeCreatorMaterial,
	makeTrustStateRecord,
} from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import * as controlPlane from "../packages/control-plane/src/index.js";
import { createSqliteAheDurableStore } from "../packages/storage-node/src/index.js";

type ProtocolV3Module = Readonly<{
	authenticateCurrentEpochAnchor(input: AuthenticateCurrentEpochAnchorInput): AuthenticateCurrentEpochAnchorResult;
	installCreatorAnchorTrustRoot(input: InstallCreatorAnchorTrustRootInput): InstallCreatorAnchorTrustRootResult;
	isAnchorTrustStateRecordBytes(bytes: Uint8Array): boolean;
	openCurrentAnchorTrust(input: OpenCurrentAnchorTrustInput): OpenCurrentAnchorTrustResult;
}> &
	Record<string, unknown>;
type StorageModule = Readonly<{
	digestBlob(bytes: Uint8Array): Readonly<{ ok: true; value: BlobDigest }> | Readonly<{ ok: false; reason: string }>;
}> &
	Record<string, unknown>;

const genuineCallEvidence = vi.hoisted(() => ({
	digests: [] as Uint8Array[],
	events: [] as string[],
	authenticateInputs: [] as unknown[],
	classifierInputs: [] as Uint8Array[],
	installInputs: [] as unknown[],
	installerTrusts: [] as unknown[],
	openInputs: [] as unknown[],
	openedTrusts: [] as unknown[],
}));

vi.mock("@ts-drp/protocol-v3", async (importOriginal) => {
	const genuine = await importOriginal<ProtocolV3Module>();
	return {
		...genuine,
		authenticateCurrentEpochAnchor(input: AuthenticateCurrentEpochAnchorInput): AuthenticateCurrentEpochAnchorResult {
			genuineCallEvidence.events.push("authenticateCurrentEpochAnchor");
			genuineCallEvidence.authenticateInputs.push(input);
			return genuine.authenticateCurrentEpochAnchor(input);
		},
		installCreatorAnchorTrustRoot(input: InstallCreatorAnchorTrustRootInput): InstallCreatorAnchorTrustRootResult {
			genuineCallEvidence.events.push("installCreatorAnchorTrustRoot");
			genuineCallEvidence.installInputs.push(input);
			const result = genuine.installCreatorAnchorTrustRoot(input);
			if (result.ok) genuineCallEvidence.installerTrusts.push(result.trust);
			return result;
		},
		isAnchorTrustStateRecordBytes(bytes: Uint8Array): boolean {
			genuineCallEvidence.events.push("isAnchorTrustStateRecordBytes");
			genuineCallEvidence.classifierInputs.push(new Uint8Array(bytes));
			return genuine.isAnchorTrustStateRecordBytes(bytes);
		},
		openCurrentAnchorTrust(input: OpenCurrentAnchorTrustInput): OpenCurrentAnchorTrustResult {
			genuineCallEvidence.events.push("openCurrentAnchorTrust");
			genuineCallEvidence.openInputs.push(input);
			const result = genuine.openCurrentAnchorTrust(input);
			if (result.ok) genuineCallEvidence.openedTrusts.push(result.trust);
			return result;
		},
	};
});

vi.mock("@ts-drp/storage", async (importOriginal) => {
	const genuine = await importOriginal<StorageModule>();
	return {
		...genuine,
		digestBlob(bytes: Uint8Array): ReturnType<StorageModule["digestBlob"]> {
			genuineCallEvidence.events.push("digestBlob");
			genuineCallEvidence.digests.push(new Uint8Array(bytes));
			return genuine.digestBlob(bytes);
		},
	};
});

type TrustClosureRejection =
	| "malformed-input"
	| "closure-invalid"
	| "candidate-invalid"
	| "candidate-not-in-closure"
	| "candidate-duplicate"
	| "candidate-not-scannable"
	| "candidate-missing"
	| "candidate-length-mismatch"
	| "candidate-digest-mismatch"
	| "trust-state-missing"
	| "trust-state-ambiguous";

type DetachedClosureCandidate = Readonly<{ bytes: Uint8Array; ref: GenerationRef }>;
type InspectTrustClosureResult =
	| Readonly<{ ok: false; reason: TrustClosureRejection }>
	| Readonly<{
			exactCanonicalTrustStateRecordBytes: Uint8Array;
			ok: true;
			trustRef: GenerationRef;
	  }>;
type AssertTrustPreservedResult =
	| Readonly<{ ok: false; reason: TrustClosureRejection | "trust-ref-not-preserved" }>
	| Readonly<{
			exactCanonicalTrustStateRecordBytes: Uint8Array;
			ok: true;
			trustRef: GenerationRef;
	  }>;
type InspectTrustClosure = (input: unknown) => InspectTrustClosureResult;
type AssertTrustPreserved = (input: unknown) => AssertTrustPreservedResult;
type InstallCreatorAnchorTrustRootFailureReason = Extract<
	InstallCreatorAnchorTrustRootResult,
	{ readonly ok: false }
>["reason"];

type InstallCurrentAnchorTrustResult =
	| Readonly<{
			head: PresentHead;
			ok: true;
			trust: Readonly<Record<string, unknown>>;
			trustRef: GenerationRef;
	  }>
	| Readonly<{
			cause?: string;
			ok: false;
			reason:
				| "already-installed"
				| "closure-rejected"
				| "genesis-rejected"
				| "store-failed"
				| "trust-rejected"
				| "trust-state-conflict";
	  }>;
type OpenDurableCurrentAnchorTrustResult =
	| Readonly<{
			head: PresentHead;
			ok: true;
			trust: Readonly<Record<string, unknown>>;
			trustRef: GenerationRef;
	  }>
	| Readonly<{
			cause?: string;
			ok: false;
			reason: "closure-rejected" | "not-installed" | "store-failed" | "trust-rejected" | "trust-state-unreadable";
	  }>;
type CurrentAnchorTrustStore = Readonly<{
	install(input: InstallCreatorAnchorTrustRootInput): Promise<InstallCurrentAnchorTrustResult>;
	open(): Promise<OpenDurableCurrentAnchorTrustResult>;
}>;
type CreateCurrentAnchorTrustStore = (options: {
	readonly objectId: StorageObjectId;
	readonly pinnedGenesisAnchorDigest: string;
	readonly store: AheDurableStore;
}) => CurrentAnchorTrustStore;

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const PUBLIC_TYPE_AUDIT_CONFIG = resolve(
	REPOSITORY_ROOT,
	"tests/fixtures/phase-3a0-b-v3/tsconfig.public-entry-audit.json"
);
const EXPECTED_RUNTIME_ADDITIONS = [
	"assertTrustPreserved",
	"createCurrentAnchorTrustStore",
	"inspectTrustClosure",
] as const;
const EXPECTED_CONTROL_PLANE_RUNTIME_NAMES = [
	"ControlPlaneCoordinator",
	"ControlPlaneHealthAggregator",
	"DISABLE_ENVELOPE_DOMAIN_V1",
	"RecoveryTerminal",
	"SignedDisableController",
	"SystemControlPlaneScheduler",
	...EXPECTED_RUNTIME_ADDITIONS,
].sort();
const FORBIDDEN_RUNTIME_NAMES = [
	"advanceCurrentAnchorTrust",
	"createAnchorTrustTestSeam",
	"prepareAnchorTrustAdvance",
	"replaceCurrentAnchorTrust",
] as const;
const DURABLE_OPEN_REACHABLE_CAUSES = [
	"object-id-mismatch",
	"genesis-pin-mismatch",
	"malformed-input",
	"record-schema-invalid",
	"unsupported-trust-state-version",
	"unsupported-trust-profile",
	"trust-state-inconsistent",
	"invalid-signature",
] as const;
const MUTATION_CONTROLS = Object.freeze([
	Object.freeze({ id: "C1", mutant: "scanner reads or reports a classified record field" }),
	Object.freeze({ id: "C2", mutant: "scanner decodes a trust record instead of using the classifier" }),
	Object.freeze({ id: "C3", mutant: "scanner excludes a record-kind candidate from ambiguity" }),
	Object.freeze({ id: "C4", mutant: "durable open skips openCurrentAnchorTrust after scan" }),
	Object.freeze({ id: "C5", mutant: "durable open mints capability on object-id-mismatch" }),
	Object.freeze({ id: "C6", mutant: "assertTrustPreserved accepts object identity" }),
	Object.freeze({ id: "C7", mutant: "caller selects a partial candidate set" }),
	Object.freeze({ id: "C8", mutant: "first ambiguous trust record wins" }),
	Object.freeze({ id: "C9", mutant: "last ambiguous trust record wins" }),
	Object.freeze({ id: "C10", mutant: "digest-selected ambiguous trust record wins" }),
	Object.freeze({ id: "C11", mutant: "preservation check runs after staging" }),
	Object.freeze({ id: "C12", mutant: "scanner trusts caller ref-to-bytes association" }),
] as const);
const temporaryDirectories: string[] = [];

function resetGenuineCallEvidence(): void {
	genuineCallEvidence.digests.length = 0;
	genuineCallEvidence.events.length = 0;
	genuineCallEvidence.authenticateInputs.length = 0;
	genuineCallEvidence.classifierInputs.length = 0;
	genuineCallEvidence.installInputs.length = 0;
	genuineCallEvidence.installerTrusts.length = 0;
	genuineCallEvidence.openInputs.length = 0;
	genuineCallEvidence.openedTrusts.length = 0;
}

function must<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: string }>): T {
	if (!result.ok) throw new Error(`NON_CANONICAL_TEST_FIXTURE:${result.reason}`);
	return result.value;
}

const OBJECT_ID = must(parseStorageObjectId(contract.objectId));
const FOREIGN_OBJECT_ID = must(parseStorageObjectId(`foreign-creator:${"f".repeat(32)}`));

function requireExport<T>(name: string): T {
	const value = Reflect.get(controlPlane, name) as unknown;
	if (typeof value !== "function") throw new Error(`MISSING_CONTROL_PLANE_EXPORT:${name}`);
	return value as T;
}

function installInput(material: CreatorMaterial): InstallCreatorAnchorTrustRootInput {
	return {
		detachedGenesisSignature: new Uint8Array(material.signature),
		exactCanonicalGenesisAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
		exactCanonicalProfileBytes: new Uint8Array(material.profileBytes),
		exactCanonicalSignerSetBytes: new Uint8Array(material.signerSetBytes),
		pinnedGenesisAnchorDigest: material.anchorDigest,
	};
}

function mutateCanonical(bytes: Uint8Array, changes: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical({ ...(decodeCanonical(bytes) as Record<string, unknown>), ...changes });
}

function genesisFailureCases(): ReadonlyArray<
	readonly [InstallCreatorAnchorTrustRootFailureReason, InstallCreatorAnchorTrustRootInput | unknown]
> {
	const material = makeCreatorMaterial();
	const base = installInput(material);
	const wrong = makeCreatorMaterial("20".repeat(32));
	const delegated = makeCreatorMaterial({ profileId: "delegated-trusted-v1" });
	const secondSigner = {
		publicKey: (makeCreatorMaterial("30".repeat(32)).signerSet[0] as Record<string, unknown>).publicKey,
		signerId: "second",
	};
	const mismatched = makeCreatorMaterial({ profileSigners: [secondSigner] });
	const maximumSigner = {
		...(material.signerSet[0] as Readonly<Record<string, unknown>>),
		signerId: "\u0800".repeat(512),
	};
	const oversized = makeCreatorMaterial({
		objectId: `${"\u0800".repeat(990)}:${"a".repeat(32)}`,
		profileSigners: [maximumSigner],
		signerSet: [maximumSigner],
	});
	return [
		["malformed-input", { ...base, extra: true }],
		["anchor-decode-failed", { ...base, exactCanonicalGenesisAnchorPreimageBytes: Uint8Array.of(0xff) }],
		[
			"noncanonical-anchor",
			{ ...base, exactCanonicalGenesisAnchorPreimageBytes: new Uint8Array([...material.anchorBytes, 0]) },
		],
		[
			"anchor-schema-invalid",
			{ ...base, exactCanonicalGenesisAnchorPreimageBytes: mutateCanonical(material.anchorBytes, { extra: true }) },
		],
		[
			"inactive-crypto-suite",
			{
				...base,
				exactCanonicalGenesisAnchorPreimageBytes: mutateCanonical(material.anchorBytes, {
					cryptoSuiteId: "ed25519-seal-v3",
				}),
			},
		],
		[
			"not-genesis-anchor",
			{ ...base, exactCanonicalGenesisAnchorPreimageBytes: mutateCanonical(material.anchorBytes, { epoch: 1 }) },
		],
		[
			"object-id-invalid",
			{
				...base,
				exactCanonicalGenesisAnchorPreimageBytes: mutateCanonical(material.anchorBytes, { objectId: "plain" }),
			},
		],
		["genesis-pin-mismatch", { ...base, pinnedGenesisAnchorDigest: "f".repeat(64) }],
		["signer-set-digest-mismatch", { ...base, exactCanonicalSignerSetBytes: wrong.signerSetBytes }],
		["profile-digest-mismatch", { ...base, exactCanonicalProfileBytes: wrong.profileBytes }],
		["unsupported-trust-profile", installInput(delegated)],
		["signer-set-profile-mismatch", installInput(mismatched)],
		["trust-state-too-large", installInput(oversized)],
		["invalid-signature", { ...base, detachedGenesisSignature: new Uint8Array(64) }],
	];
}

function trustRecord(material = makeCreatorMaterial()): Uint8Array {
	const installed = installCreatorAnchorTrustRoot(installInput(material));
	if (!installed.ok) throw new Error(`TRUST_FIXTURE_REJECTED:${installed.reason}`);
	return new Uint8Array(installed.exactCanonicalTrustStateRecordBytes);
}

function refFor(bytes: Uint8Array): GenerationRef {
	return { byteLength: bytes.byteLength, digest: must(digestBlob(bytes)) };
}

function candidate(bytes: Uint8Array): DetachedClosureCandidate {
	return { bytes: new Uint8Array(bytes), ref: refFor(bytes) };
}

function sortedReferences(candidates: readonly DetachedClosureCandidate[]): GenerationRef[] {
	return candidates
		.map(({ ref }) => ({ ...ref }))
		.sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0));
}

function successBytes(result: InspectTrustClosureResult | AssertTrustPreservedResult): Uint8Array {
	if (!result.ok) throw new Error(`EXPECTED_SCANNER_SUCCESS:${result.reason}`);
	return result.exactCanonicalTrustStateRecordBytes;
}

function assertClosedFailure(result: unknown, expected: unknown): void {
	expect(result).toEqual(expected);
	expect(result).not.toHaveProperty("trust");
}

async function databaseFilename(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-phase-3a0-b-red-"));
	temporaryDirectories.push(directory);
	return join(directory, "store.sqlite");
}

function noHead(objectId: StorageObjectId): Readonly<{ kind: "none"; objectId: StorageObjectId }> {
	return { kind: "none", objectId };
}

function generationId(unit: string): GenerationId {
	return must(parseGenerationId(unit.repeat(64)));
}

async function stageAndSwap(
	store: AheDurableStore,
	objectId: StorageObjectId,
	id: GenerationId,
	baseExpectedHead: ExpectedHead,
	candidates: readonly DetachedClosureCandidate[]
): Promise<PresentHead> {
	const closure = sortedReferences(candidates);
	const begun = await store.beginGeneration({ baseExpectedHead, closure, generationId: id, objectId });
	if (!begun.ok) throw new Error(`BEGIN_FAILED:${begun.reason}`);
	for (const entry of candidates) {
		const cached = await store.putCachedBlob({
			bytes: new Uint8Array(entry.bytes),
			digest: entry.ref.digest,
			generationId: id,
			objectId,
		});
		if (!cached.ok) throw new Error(`CACHE_FAILED:${cached.reason}`);
		const promoted = await store.promoteReference({ digest: entry.ref.digest, generationId: id, objectId });
		if (!promoted.ok) throw new Error(`PROMOTE_FAILED:${promoted.reason}`);
	}
	const completed = await store.completeGeneration({ generationId: id, objectId });
	if (!completed.ok) throw new Error(`COMPLETE_FAILED:${completed.reason}`);
	const swapped = await store.swapHead({ expectedHead: baseExpectedHead, generationId: id, objectId });
	if (!swapped.ok) throw new Error(`SWAP_FAILED:${swapped.reason}`);
	return swapped.value.head;
}

type StoreMethod = Exclude<keyof AheDurableStore, "capabilities">;

function observeStore(
	store: AheDurableStore,
	options: Readonly<{ failFirstSwap?: boolean; rewriteSwapRevision?: number }> = {}
): Readonly<{ calls: Array<Readonly<{ input: unknown; method: StoreMethod }>>; store: AheDurableStore }> {
	const calls: Array<Readonly<{ input: unknown; method: StoreMethod }>> = [];
	const record = (method: StoreMethod, input: unknown): void => {
		calls.push({ input, method });
		genuineCallEvidence.events.push(method);
	};
	let failSwap = options.failFirstSwap === true;
	const wrapper = Object.freeze({
		capabilities: store.capabilities,
		beginGeneration(input: Parameters<AheDurableStore["beginGeneration"]>[0]) {
			record("beginGeneration", input);
			return store.beginGeneration(input);
		},
		close() {
			record("close", undefined);
			return store.close();
		},
		completeGeneration(input: Parameters<AheDurableStore["completeGeneration"]>[0]) {
			record("completeGeneration", input);
			return store.completeGeneration(input);
		},
		discardGeneration(input: Parameters<AheDurableStore["discardGeneration"]>[0]) {
			record("discardGeneration", input);
			return store.discardGeneration(input);
		},
		getBlob(input: Parameters<AheDurableStore["getBlob"]>[0]) {
			record("getBlob", input);
			return store.getBlob(input);
		},
		promoteReference(input: Parameters<AheDurableStore["promoteReference"]>[0]) {
			record("promoteReference", input);
			return store.promoteReference(input);
		},
		putCachedBlob(input: Parameters<AheDurableStore["putCachedBlob"]>[0]) {
			record("putCachedBlob", input);
			return store.putCachedBlob(input);
		},
		readGenerationPage(input: Parameters<AheDurableStore["readGenerationPage"]>[0]) {
			record("readGenerationPage", input);
			return store.readGenerationPage(input);
		},
		readHead(input: Parameters<AheDurableStore["readHead"]>[0]) {
			record("readHead", input);
			return store.readHead(input);
		},
		recoverActiveGeneration(input: Parameters<AheDurableStore["recoverActiveGeneration"]>[0]) {
			record("recoverActiveGeneration", input);
			return store.recoverActiveGeneration(input);
		},
		async swapHead(input: Parameters<AheDurableStore["swapHead"]>[0]) {
			record("swapHead", input);
			if (failSwap) {
				failSwap = false;
				return {
					cause: "SIMULATED_CRASH_BEFORE_HEAD_CAS",
					ok: false as const,
					reason: "SUBSTRATE_FAILURE" as const,
				};
			}
			const result = await store.swapHead(input);
			if (!result.ok || options.rewriteSwapRevision === undefined) return result;
			return Object.freeze({
				ok: true as const,
				value: Object.freeze({
					head: Object.freeze({
						...result.value.head,
						revision: options.rewriteSwapRevision as PresentHead["revision"],
					}),
					supersededGenerationId: result.value.supersededGenerationId,
				}),
			});
		},
	});
	return { calls, store: wrapper };
}

function simulateLostCasStore(primary: AheDurableStore, winner: AheDurableStore): AheDurableStore {
	let lost = false;
	return Object.freeze({
		capabilities: primary.capabilities,
		beginGeneration: primary.beginGeneration.bind(primary),
		async close() {
			await primary.close();
			await winner.close();
		},
		completeGeneration: primary.completeGeneration.bind(primary),
		discardGeneration: primary.discardGeneration.bind(primary),
		getBlob(input: Parameters<AheDurableStore["getBlob"]>[0]) {
			return (lost ? winner : primary).getBlob(input);
		},
		promoteReference: primary.promoteReference.bind(primary),
		putCachedBlob: primary.putCachedBlob.bind(primary),
		readGenerationPage(input: Parameters<AheDurableStore["readGenerationPage"]>[0]) {
			return (lost ? winner : primary).readGenerationPage(input);
		},
		readHead(input: Parameters<AheDurableStore["readHead"]>[0]) {
			return (lost ? winner : primary).readHead(input);
		},
		recoverActiveGeneration(input: Parameters<AheDurableStore["recoverActiveGeneration"]>[0]) {
			return (lost ? winner : primary).recoverActiveGeneration(input);
		},
		swapHead() {
			lost = true;
			return Promise.resolve({ ok: false as const, reason: "HEAD_CONFLICT" as const });
		},
	});
}

const STORE_WRITE_METHODS = [
	"beginGeneration",
	"putCachedBlob",
	"promoteReference",
	"completeGeneration",
	"swapHead",
] as const satisfies readonly StoreMethod[];

function adversarialStrictStore(
	responses: Readonly<{
		getBlob(): unknown;
		readHead(): unknown;
		recoverActiveGeneration(): unknown;
	}>
): Readonly<{ calls: StoreMethod[]; store: AheDurableStore }> {
	const calls: StoreMethod[] = [];
	const record = (method: StoreMethod): void => {
		calls.push(method);
	};
	const rejectedWrite = (method: StoreMethod): Promise<never> => {
		record(method);
		return Promise.resolve({ cause: "UNEXPECTED_WRITE", ok: false, reason: "SUBSTRATE_FAILURE" } as never);
	};
	const store = Object.freeze({
		capabilities: Object.freeze({
			durability: "strict" as const,
			signingEligibility: "backend-capability-required" as const,
		}),
		beginGeneration() {
			return rejectedWrite("beginGeneration");
		},
		close() {
			record("close");
			return Promise.resolve();
		},
		completeGeneration() {
			return rejectedWrite("completeGeneration");
		},
		discardGeneration() {
			return rejectedWrite("discardGeneration");
		},
		getBlob() {
			record("getBlob");
			return Promise.resolve(responses.getBlob() as never);
		},
		promoteReference() {
			return rejectedWrite("promoteReference");
		},
		putCachedBlob() {
			return rejectedWrite("putCachedBlob");
		},
		readGenerationPage() {
			return rejectedWrite("readGenerationPage");
		},
		readHead() {
			record("readHead");
			return Promise.resolve(responses.readHead() as never);
		},
		recoverActiveGeneration() {
			record("recoverActiveGeneration");
			return Promise.resolve(responses.recoverActiveGeneration() as never);
		},
		swapHead() {
			return rejectedWrite("swapHead");
		},
	}) as AheDurableStore;
	return { calls, store };
}

async function settledResult(operation: () => Promise<unknown>): Promise<unknown> {
	try {
		return await operation();
	} catch (error) {
		return Object.freeze({
			message: error instanceof Error ? error.message : String(error),
			threw: true as const,
		});
	}
}

function runPublicTypeAudit(): ReturnType<typeof spawnSync> {
	return spawnSync(
		process.execPath,
		[resolve(REPOSITORY_ROOT, "node_modules/typescript/bin/tsc"), "-p", PUBLIC_TYPE_AUDIT_CONFIG, "--pretty", "false"],
		{ cwd: REPOSITORY_ROOT, encoding: "utf8" }
	);
}

async function simulateCombinedGeneration(
	assertPreserved: AssertTrustPreserved,
	observed: ReturnType<typeof observeStore>,
	candidates: readonly DetachedClosureCandidate[],
	expectedTrustRef: GenerationRef,
	id: GenerationId,
	preservationOrder: "before-stage" | "after-stage-mutant" = "before-stage"
): Promise<AssertTrustPreservedResult> {
	if (preservationOrder === "after-stage-mutant") {
		await stageAndSwap(observed.store, OBJECT_ID, id, noHead(OBJECT_ID), candidates);
	}
	const preserved = assertPreserved({
		candidates,
		closure: sortedReferences(candidates),
		expectedTrustRef,
	});
	if (!preserved.ok || preservationOrder === "after-stage-mutant") return preserved;
	await stageAndSwap(observed.store, OBJECT_ID, id, noHead(OBJECT_ID), candidates);
	return preserved;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { force: true, recursive: true });
});

beforeEach(() => {
	resetGenuineCallEvidence();
});

describe("Phase 3a-0-B control-plane trust closure RED", () => {
	it("[CONTROL] freezes the closed C1-C12 mutant registry and exact C7/C12 ownership", () => {
		expect(MUTATION_CONTROLS.map(({ id }) => id)).toEqual([
			"C1",
			"C2",
			"C3",
			"C4",
			"C5",
			"C6",
			"C7",
			"C8",
			"C9",
			"C10",
			"C11",
			"C12",
		]);
		expect(MUTATION_CONTROLS).toHaveLength(12);
		expect(MUTATION_CONTROLS[6]).toEqual({ id: "C7", mutant: "caller selects a partial candidate set" });
		expect(MUTATION_CONTROLS[11]).toEqual({
			id: "C12",
			mutant: "scanner trusts caller ref-to-bytes association",
		});
	});

	it("[CONTROL] proves protocol-v3 classification is version-agnostic and grants no record authority", () => {
		const material = makeCreatorMaterial();
		const firstVersion = trustRecord(material);
		const laterVersion = makeTrustStateRecord(material, 2);
		const ordinary = encodeCanonical({ kind: "ordinary-state", value: 1 });
		expect(isAnchorTrustStateRecordBytes(firstVersion)).toBe(true);
		expect(isAnchorTrustStateRecordBytes(laterVersion)).toBe(true);
		expect(isAnchorTrustStateRecordBytes(ordinary)).toBe(false);
		expect(
			openCurrentAnchorTrust({
				exactCanonicalTrustStateRecordBytes: laterVersion,
				expectedObjectId: contract.objectId,
				pinnedGenesisAnchorDigest: material.anchorDigest,
			})
		).toEqual({ ok: false, reason: "unsupported-trust-state-version" });
	});

	it("[CONTROL] proves the selected strict backend persists exact closure bytes across a fresh reopen", async () => {
		const filename = await databaseFilename();
		const trust = candidate(trustRecord());
		const initial = createSqliteAheDurableStore({ filename });
		expect(initial.capabilities.durability).toBe("strict");
		const head = await stageAndSwap(initial, OBJECT_ID, generationId("0"), noHead(OBJECT_ID), [trust]);
		await initial.close();

		const reopened = createSqliteAheDurableStore({ filename });
		expect(await reopened.readHead(OBJECT_ID)).toEqual({ ok: true, value: head });
		expect(await reopened.getBlob(trust.ref.digest)).toEqual({ ok: true, value: trust.bytes });
		await reopened.close();
	});

	it("[RED surface] adds exactly the scanner, preservation and durable-owner runtime names without an advance seam", () => {
		expect(Object.keys(controlPlane).sort()).toEqual(EXPECTED_CONTROL_PLANE_RUNTIME_NAMES);
		for (const name of EXPECTED_RUNTIME_ADDITIONS) expect(Reflect.get(controlPlane, name), name).toBeTypeOf("function");
		for (const name of FORBIDDEN_RUNTIME_NAMES) expect(Reflect.has(controlPlane, name), name).toBe(false);
	});

	it("[RED types] exposes the exact closed scanner, preservation and durable-owner declarations", () => {
		const audit = runPublicTypeAudit();
		expect(audit.status, `${audit.stdout}\n${audit.stderr}`).toBe(0);
	});

	it("[RED genesis] losslessly wraps all fourteen pure installer failures before every store call", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const observed = observeStore(createMemoryAheDurableStore());
		const durable = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: observed.store,
		});
		const cases = genesisFailureCases();
		expect(cases.map(([reason]) => reason)).toEqual([
			"malformed-input",
			"anchor-decode-failed",
			"noncanonical-anchor",
			"anchor-schema-invalid",
			"inactive-crypto-suite",
			"not-genesis-anchor",
			"object-id-invalid",
			"genesis-pin-mismatch",
			"signer-set-digest-mismatch",
			"profile-digest-mismatch",
			"unsupported-trust-profile",
			"signer-set-profile-mismatch",
			"trust-state-too-large",
			"invalid-signature",
		]);
		for (const [reason, input] of cases) {
			resetGenuineCallEvidence();
			assertClosedFailure(await durable.install(input as InstallCreatorAnchorTrustRootInput), {
				cause: reason,
				ok: false,
				reason: "genesis-rejected",
			});
			expect(genuineCallEvidence.events, reason).toEqual(["installCreatorAnchorTrustRoot"]);
			expect(observed.calls, reason).toEqual([]);
		}
		await observed.store.close();
	});

	it("[RED fixed owner] reopens generated bytes against fixed options with exact mismatch precedence before storage", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const cases = [
			{
				expected: "object-id-mismatch",
				objectId: FOREIGN_OBJECT_ID,
				pin: material.anchorDigest,
			},
			{
				expected: "genesis-pin-mismatch",
				objectId: OBJECT_ID,
				pin: "f".repeat(64),
			},
			{
				expected: "object-id-mismatch",
				objectId: FOREIGN_OBJECT_ID,
				pin: "f".repeat(64),
			},
			{
				expected: "malformed-input",
				objectId: "plain",
				pin: "not-a-digest",
			},
		] as const;
		for (const row of cases) {
			const observed = observeStore(createMemoryAheDurableStore());
			const durable = createStore({
				objectId: row.objectId as StorageObjectId,
				pinnedGenesisAnchorDigest: row.pin,
				store: observed.store,
			});
			resetGenuineCallEvidence();
			assertClosedFailure(await durable.install(installInput(material)), {
				cause: row.expected,
				ok: false,
				reason: "trust-rejected",
			});
			expect(genuineCallEvidence.events, row.expected).toEqual([
				"installCreatorAnchorTrustRoot",
				"openCurrentAnchorTrust",
			]);
			expect(genuineCallEvidence.openInputs).toEqual([
				{
					exactCanonicalTrustStateRecordBytes: expect.any(Uint8Array),
					expectedObjectId: row.objectId,
					pinnedGenesisAnchorDigest: row.pin,
				},
			]);
			expect(observed.calls, row.expected).toEqual([]);
			await observed.store.close();
		}
	});

	it("[RED sequencing] uses only open-minted authority before genuine digest, exact ref and first readHead", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const input = installInput(material);
		const observed = observeStore(createSqliteAheDurableStore({ filename: await databaseFilename() }));
		const durable = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: observed.store,
		});
		resetGenuineCallEvidence();
		const installed = await durable.install(input);
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		expect(genuineCallEvidence.installInputs).toEqual([input]);
		expect(genuineCallEvidence.events.slice(0, 6)).toEqual([
			"installCreatorAnchorTrustRoot",
			"openCurrentAnchorTrust",
			"digestBlob",
			"digestBlob",
			"isAnchorTrustStateRecordBytes",
			"readHead",
		]);
		expect(genuineCallEvidence.digests).toHaveLength(2);
		expect(genuineCallEvidence.digests[1]).toEqual(genuineCallEvidence.digests[0]);
		const exactRecordBytes = genuineCallEvidence.digests[0] as Uint8Array;
		const expectedRef = refFor(exactRecordBytes);
		expect(installed.trustRef).toEqual(expectedRef);
		expect(genuineCallEvidence.openedTrusts).toHaveLength(1);
		expect(installed.trust).toBe(genuineCallEvidence.openedTrusts[0]);
		expect(installed.trust).not.toBe(genuineCallEvidence.installerTrusts[0]);
		expect(Object.keys(installed).sort()).toEqual(["head", "ok", "trust", "trustRef"]);
		expect(genuineCallEvidence.authenticateInputs).toEqual([]);
		expect(
			authenticateCurrentEpochAnchor({
				detachedSignature: new Uint8Array(material.signature),
				exactCanonicalAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
				trust: installed.trust as unknown as Parameters<typeof authenticateCurrentEpochAnchor>[0]["trust"],
			})
		).toMatchObject({ ok: true });
		expect(genuineCallEvidence.authenticateInputs).toHaveLength(1);
		const authenticatedTrust = (genuineCallEvidence.authenticateInputs[0] as { readonly trust: unknown }).trust;
		expect(authenticatedTrust).toBe(genuineCallEvidence.openedTrusts[0]);
		expect(authenticatedTrust).not.toBe(genuineCallEvidence.installerTrusts[0]);
		const begun = observed.calls.find(({ method }) => method === "beginGeneration")?.input as
			| { readonly closure: readonly GenerationRef[] }
			| undefined;
		expect(begun?.closure).toEqual([installed.trustRef]);
		await observed.store.close();
	});

	it("[RED C1/C2] classifies every detached candidate through the genuine identity-agnostic classifier", () => {
		const inspect = requireExport<InspectTrustClosure>("inspectTrustClosure");
		const local = candidate(trustRecord());
		const foreign = candidate(
			trustRecord(makeCreatorMaterial({ objectId: String(FOREIGN_OBJECT_ID), privateKeySeedHex: "20".repeat(32) }))
		);
		const ordinary = candidate(encodeCanonical({ kind: "ordinary-state", value: 1 }));
		resetGenuineCallEvidence();
		expect(
			inspect({ candidates: [ordinary, local, foreign], closure: sortedReferences([ordinary, local, foreign]) })
		).toEqual({
			ok: false,
			reason: "trust-state-ambiguous",
		});
		expect(genuineCallEvidence.classifierInputs.map(bytesHex).sort()).toEqual(
			[ordinary.bytes, local.bytes, foreign.bytes].map(bytesHex).sort()
		);
	});

	it("[RED precedence] returns every scanner reason in the exact frozen order", () => {
		const inspect = requireExport<InspectTrustClosure>("inspectTrustClosure");
		const trust = candidate(trustRecord());
		const ordinary = candidate(encodeCanonical({ kind: "ordinary-state", value: 1 }));
		const oversizedRef = { byteLength: 8193, digest: ordinary.ref.digest };
		const differentLengthBytes = new Uint8Array(ordinary.bytes.byteLength + 1);
		differentLengthBytes.set(ordinary.bytes);
		const rows: ReadonlyArray<Readonly<{ expected: TrustClosureRejection; input: unknown }>> = [
			{ expected: "malformed-input", input: { candidates: [trust], closure: [trust.ref], extra: true } },
			{ expected: "closure-invalid", input: { candidates: [trust], closure: [] } },
			{
				expected: "candidate-invalid",
				input: { candidates: [{ bytes: "not-bytes", ref: trust.ref }], closure: [trust.ref] },
			},
			{
				expected: "candidate-not-in-closure",
				input: { candidates: [ordinary], closure: [trust.ref] },
			},
			{
				expected: "candidate-duplicate",
				input: {
					candidates: [trust, { bytes: new Uint8Array(trust.bytes), ref: { ...trust.ref } }],
					closure: [trust.ref],
				},
			},
			{
				expected: "candidate-not-scannable",
				input: { candidates: [{ bytes: ordinary.bytes, ref: oversizedRef }], closure: [oversizedRef] },
			},
			{
				expected: "candidate-missing",
				input: { candidates: [trust], closure: sortedReferences([trust, ordinary]) },
			},
			{
				expected: "candidate-length-mismatch",
				input: { candidates: [{ bytes: differentLengthBytes, ref: ordinary.ref }], closure: [ordinary.ref] },
			},
			{
				expected: "candidate-digest-mismatch",
				input: {
					candidates: [
						{
							bytes: new Uint8Array(ordinary.bytes.map((byte, index) => (index === 0 ? byte ^ 1 : byte))),
							ref: ordinary.ref,
						},
					],
					closure: [ordinary.ref],
				},
			},
			{ expected: "trust-state-missing", input: { candidates: [ordinary], closure: [ordinary.ref] } },
			{
				expected: "trust-state-ambiguous",
				input: {
					candidates: [trust, candidate(makeTrustStateRecord(makeCreatorMaterial(), 2))],
					closure: sortedReferences([trust, candidate(makeTrustStateRecord(makeCreatorMaterial(), 2))]),
				},
			},
		];
		for (const { expected, input } of rows) expect(inspect(input)).toEqual({ ok: false, reason: expected });
	});

	it("[RED scanner boundaries] rejects sparse/shared/noncanonical sets and honors the exact 8192 scannable cutoff", () => {
		const inspect = requireExport<InspectTrustClosure>("inspectTrustClosure");
		const trust = candidate(trustRecord());
		const sparseCandidates = new Array<DetachedClosureCandidate>(1);
		const sparseClosure = new Array<GenerationRef>(1);
		expect(inspect({ candidates: sparseCandidates, closure: [trust.ref] })).toEqual({
			ok: false,
			reason: "candidate-invalid",
		});
		expect(inspect({ candidates: [trust], closure: sparseClosure })).toEqual({ ok: false, reason: "closure-invalid" });
		const reversed = [trust.ref, candidate(encodeCanonical({ kind: "ordinary-state" })).ref].sort((left, right) =>
			left.digest < right.digest ? 1 : -1
		);
		expect(inspect({ candidates: [trust], closure: reversed })).toEqual({ ok: false, reason: "closure-invalid" });
		expect(
			inspect({
				candidates: [trust],
				closure: [{ ...trust.ref, digest: trust.ref.digest.toUpperCase() }],
			})
		).toEqual({ ok: false, reason: "closure-invalid" });
		if (typeof SharedArrayBuffer !== "undefined") {
			const shared = new Uint8Array(new SharedArrayBuffer(trust.bytes.byteLength));
			shared.set(trust.bytes);
			expect(inspect({ candidates: [{ bytes: shared, ref: trust.ref }], closure: [trust.ref] })).toEqual({
				ok: false,
				reason: "candidate-invalid",
			});
		}
		const exactBoundary = candidate(new Uint8Array(8192));
		expect(inspect({ candidates: [exactBoundary], closure: [exactBoundary.ref] })).toEqual({
			ok: false,
			reason: "trust-state-missing",
		});
		const oversizedRef = { ...exactBoundary.ref, byteLength: 8193 };
		expect(inspect({ candidates: [], closure: [oversizedRef] })).toEqual({
			ok: false,
			reason: "trust-state-missing",
		});
		expect(
			inspect({ candidates: [{ bytes: exactBoundary.bytes, ref: oversizedRef }], closure: [oversizedRef] })
		).toEqual({
			ok: false,
			reason: "candidate-not-scannable",
		});
		const oversizedActualBytes = new Uint8Array(8193);
		expect(
			inspect({
				candidates: [{ bytes: oversizedActualBytes, ref: exactBoundary.ref }],
				closure: [exactBoundary.ref],
			})
		).toEqual({
			ok: false,
			reason: "candidate-length-mismatch",
		});
	});

	it("[RED C3/C7/C8/C9/C10] counts all candidates, rejects partial sets and never elects an ambiguity winner", () => {
		const inspect = requireExport<InspectTrustClosure>("inspectTrustClosure");
		const local = candidate(trustRecord());
		const foreignMaterial = makeCreatorMaterial({
			objectId: String(FOREIGN_OBJECT_ID),
			privateKeySeedHex: "20".repeat(32),
		});
		const foreign = candidate(trustRecord(foreignMaterial));
		const ordinary = candidate(encodeCanonical({ kind: "ordinary-state", value: 1 }));
		const all = [local, foreign, ordinary] as const;
		const closure = sortedReferences(all);
		expect(inspect({ candidates: all, closure })).toEqual({ ok: false, reason: "trust-state-ambiguous" });
		expect(inspect({ candidates: [local, foreign], closure })).toEqual({ ok: false, reason: "candidate-missing" });
		for (const candidates of [
			[local, foreign],
			[foreign, local],
		]) {
			expect(inspect({ candidates, closure: sortedReferences(candidates) })).toEqual({
				ok: false,
				reason: "trust-state-ambiguous",
			});
		}
	});

	it("[RED C12] copies bytes once, validates length and digest, and returns fresh detached bytes plus the exact ref", () => {
		const inspect = requireExport<InspectTrustClosure>("inspectTrustClosure");
		const bytes = trustRecord();
		const entry = candidate(bytes);
		const result = inspect({ candidates: [entry], closure: [entry.ref] });
		expect(result).toEqual({
			exactCanonicalTrustStateRecordBytes: bytes,
			ok: true,
			trustRef: entry.ref,
		});
		if (!result.ok) return;
		expect(result.exactCanonicalTrustStateRecordBytes).not.toBe(bytes);
		expect(result.exactCanonicalTrustStateRecordBytes).not.toBe(entry.bytes);
		entry.bytes.fill(0);
		expect(isAnchorTrustStateRecordBytes(result.exactCanonicalTrustStateRecordBytes)).toBe(true);
		result.exactCanonicalTrustStateRecordBytes.fill(0);
		const repeated = inspect({ candidates: [candidate(bytes)], closure: [refFor(bytes)] });
		expect(isAnchorTrustStateRecordBytes(successBytes(repeated))).toBe(true);
	});

	it("[RED C6] preserves only the exact trust ref and accepts no object-identity argument", () => {
		const assertPreserved = requireExport<AssertTrustPreserved>("assertTrustPreserved");
		const trust = candidate(trustRecord());
		const ordinary = candidate(encodeCanonical({ kind: "ordinary-state", value: 1 }));
		const input = {
			candidates: [trust, ordinary],
			closure: sortedReferences([trust, ordinary]),
			expectedTrustRef: trust.ref,
		};
		expect(assertPreserved(input)).toMatchObject({ ok: true, trustRef: trust.ref });
		expect(assertPreserved({ ...input, expectedTrustRef: ordinary.ref })).toEqual({
			ok: false,
			reason: "trust-ref-not-preserved",
		});
		expect(assertPreserved({ ...input, objectId: OBJECT_ID })).toEqual({ ok: false, reason: "malformed-input" });
	});

	it("[RED C4/C5] foreign-only scanning succeeds, then durable open rejects object identity without minting authority", async () => {
		const inspect = requireExport<InspectTrustClosure>("inspectTrustClosure");
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const foreignMaterial = makeCreatorMaterial({
			objectId: String(FOREIGN_OBJECT_ID),
			privateKeySeedHex: "20".repeat(32),
		});
		const foreign = candidate(trustRecord(foreignMaterial));
		expect(inspect({ candidates: [foreign], closure: [foreign.ref] })).toMatchObject({
			ok: true,
			trustRef: foreign.ref,
		});

		const backend = createSqliteAheDurableStore({ filename: await databaseFilename() });
		await stageAndSwap(backend, OBJECT_ID, generationId("1"), noHead(OBJECT_ID), [foreign]);
		const durable = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: foreignMaterial.anchorDigest,
			store: backend,
		});
		assertClosedFailure(await durable.open(), {
			cause: "object-id-mismatch",
			ok: false,
			reason: "trust-rejected",
		});
		await backend.close();
	});

	it("[RED durable] installs, opens and reopens one exact trust ref through a strict durable backend", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const filename = await databaseFilename();
		const firstBackend = createSqliteAheDurableStore({ filename });
		expect(firstBackend.capabilities.durability).toBe("strict");
		const first = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: firstBackend,
		});
		const installed = await first.install(installInput(material));
		expect(installed).toMatchObject({ ok: true, trust: { objectId: OBJECT_ID } });
		if (!installed.ok) return;
		expect(installed.head.closureDigest).toBeDefined();
		expect(installed.trustRef).toEqual(refFor(trustRecord(material)));
		expect(await first.open()).toMatchObject({ head: installed.head, ok: true, trustRef: installed.trustRef });
		await firstBackend.close();

		const reopenedBackend = createSqliteAheDurableStore({ filename });
		const reopened = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: reopenedBackend,
		});
		expect(await reopened.open()).toMatchObject({ head: installed.head, ok: true, trustRef: installed.trustRef });
		await reopenedBackend.close();
	});

	it("[RED durable ordering] rejects fallible trust input before store work and uses one final authoritative CAS", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const backend = observeStore(createSqliteAheDurableStore({ filename: await databaseFilename() }));
		const material = makeCreatorMaterial();
		const durable = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: backend.store,
		});
		assertClosedFailure(
			await durable.install({ ...installInput(material), detachedGenesisSignature: new Uint8Array(64) }),
			{ cause: "invalid-signature", ok: false, reason: "genesis-rejected" }
		);
		expect(backend.calls).toEqual([]);
		const installed = await durable.install(installInput(material));
		expect(installed.ok).toBe(true);
		expect(backend.calls.map(({ method }) => method)).toEqual([
			"readHead",
			"beginGeneration",
			"putCachedBlob",
			"promoteReference",
			"completeGeneration",
			"swapHead",
		]);
		expect(backend.calls.filter(({ method }) => method === "swapHead")).toHaveLength(1);
		await backend.store.close();
	});

	it("[RED initial CAS revision] accepts exact revision 1 and rejects a hostile revision 2 success without authority", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const expectedMethods = [
			"readHead",
			"beginGeneration",
			"putCachedBlob",
			"promoteReference",
			"completeGeneration",
			"swapHead",
		] as const satisfies readonly StoreMethod[];
		const controlBackend = observeStore(createSqliteAheDurableStore({ filename: await databaseFilename() }));
		const control = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: controlBackend.store,
		});
		const installed = await control.install(installInput(material));
		expect(installed).toMatchObject({ head: { revision: 1 }, ok: true });
		expect(controlBackend.calls.map(({ method }) => method)).toEqual(expectedMethods);
		await controlBackend.store.close();

		const hostileBackend = observeStore(createSqliteAheDurableStore({ filename: await databaseFilename() }), {
			rewriteSwapRevision: 2,
		});
		const hostile = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: hostileBackend.store,
		});
		assertClosedFailure(await hostile.install(installInput(material)), { ok: false, reason: "store-failed" });
		expect(hostileBackend.calls.map(({ method }) => method)).toEqual(expectedMethods);
		expect(
			hostileBackend.calls.slice(hostileBackend.calls.findIndex(({ method }) => method === "swapHead") + 1)
		).toEqual([]);
		await hostileBackend.store.close();
	});

	it("[RED reopen taxonomy] exposes exactly three fixed-option and five classifiable stored-record open causes", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const valid = makeTrustStateRecord(material);
		const storedRows = [
			["record-schema-invalid", mutateCanonical(valid, { currentEpoch: "zero" })],
			["unsupported-trust-state-version", mutateCanonical(valid, { version: 2 })],
			["unsupported-trust-profile", mutateCanonical(valid, { profileId: "delegated-trusted-v1" })],
			["trust-state-inconsistent", mutateCanonical(valid, { currentAnchorDigest: "e".repeat(64) })],
			["invalid-signature", mutateCanonical(valid, { detachedCurrentAnchorSignature: new Uint8Array(64) })],
		] as const;
		expect([
			"object-id-mismatch",
			"genesis-pin-mismatch",
			"malformed-input",
			...storedRows.map(([reason]) => reason),
		]).toEqual(DURABLE_OPEN_REACHABLE_CAUSES);
		for (const [index, [reason, bytes]] of storedRows.entries()) {
			expect(isAnchorTrustStateRecordBytes(bytes), reason).toBe(true);
			const backend = observeStore(createSqliteAheDurableStore({ filename: await databaseFilename() }));
			const entry = candidate(bytes);
			await stageAndSwap(backend.store, OBJECT_ID, generationId(String(index + 1)), noHead(OBJECT_ID), [entry]);
			backend.calls.length = 0;
			const durable = createStore({
				objectId: OBJECT_ID,
				pinnedGenesisAnchorDigest: material.anchorDigest,
				store: backend.store,
			});
			assertClosedFailure(await durable.open(), { cause: reason, ok: false, reason: "trust-rejected" });
			expect(
				backend.calls.some(({ method }) =>
					["beginGeneration", "putCachedBlob", "promoteReference", "completeGeneration", "swapHead"].includes(method)
				)
			).toBe(false);
			backend.calls.length = 0;
			resetGenuineCallEvidence();
			assertClosedFailure(await durable.install(installInput(material)), {
				cause: reason,
				ok: false,
				reason: "trust-rejected",
			});
			expect(genuineCallEvidence.installInputs).toHaveLength(1);
			expect(genuineCallEvidence.events.filter((event) => event === "openCurrentAnchorTrust")).toHaveLength(2);
			expect(
				backend.calls.some(({ method }) =>
					["beginGeneration", "putCachedBlob", "promoteReference", "completeGeneration", "swapHead"].includes(method)
				)
			).toBe(false);
			await backend.store.close();
		}
	});

	it("[RED scanner/open boundary] owns undecodable and noncanonical stored bytes as missing trust before pure open", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		for (const [name, bytes] of [
			["undecodable", Uint8Array.of(0xff)],
			["noncanonical", new Uint8Array([...makeTrustStateRecord(material), 0])],
		] as const) {
			expect(isAnchorTrustStateRecordBytes(bytes), name).toBe(false);
			const backend = createSqliteAheDurableStore({ filename: await databaseFilename() });
			const entry = candidate(bytes);
			await stageAndSwap(backend, OBJECT_ID, generationId(name === "undecodable" ? "a" : "b"), noHead(OBJECT_ID), [
				entry,
			]);
			const durable = createStore({
				objectId: OBJECT_ID,
				pinnedGenesisAnchorDigest: material.anchorDigest,
				store: backend,
			});
			resetGenuineCallEvidence();
			assertClosedFailure(await durable.open(), {
				cause: "trust-state-missing",
				ok: false,
				reason: "closure-rejected",
			});
			expect(genuineCallEvidence.events).not.toContain("openCurrentAnchorTrust");
			await backend.close();
		}
	});

	it("[RED open] is read-only and maps absent, closure, integrity and pure trust failures without repair", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const backend = observeStore(createSqliteAheDurableStore({ filename: await databaseFilename() }));
		const durable = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: backend.store,
		});
		assertClosedFailure(await durable.open(), { ok: false, reason: "not-installed" });
		expect(backend.calls.map(({ method }) => method)).toEqual(["readHead"]);
		await backend.store.close();

		const ambiguousBackend = createSqliteAheDurableStore({ filename: await databaseFilename() });
		const first = candidate(trustRecord(material));
		const second = candidate(makeTrustStateRecord(material, 2));
		await stageAndSwap(ambiguousBackend, OBJECT_ID, generationId("2"), noHead(OBJECT_ID), [first, second]);
		const ambiguous = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: ambiguousBackend,
		});
		assertClosedFailure(await ambiguous.open(), {
			cause: "trust-state-ambiguous",
			ok: false,
			reason: "closure-rejected",
		});
		await ambiguousBackend.close();
	});

	it("[RED post-await head] closes throwing and malformed readHead results without writes or authority", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const poisonedOk = Object.defineProperty({}, "ok", {
			enumerable: true,
			get(): never {
				throw new Error("POISONED_READ_HEAD_OK");
			},
		});
		const poisonedValue = Object.defineProperties(
			{},
			{
				ok: { enumerable: true, value: true },
				value: {
					enumerable: true,
					get(): never {
						throw new Error("POISONED_READ_HEAD_VALUE");
					},
				},
			}
		);
		const poisonedKind = Object.freeze({
			ok: true,
			value: Object.defineProperty({}, "kind", {
				enumerable: true,
				get(): never {
					throw new Error("POISONED_READ_HEAD_KIND");
				},
			}),
		});
		const rows = [
			["null-result", null],
			["missing-value", Object.freeze({ ok: true })],
			["invalid-head-kind", Object.freeze({ ok: true, value: Object.freeze({ kind: "bogus" }) })],
			["poisoned-ok", poisonedOk],
			["poisoned-value", poisonedValue],
			["poisoned-kind", poisonedKind],
		] as const;
		const outcomes: unknown[] = [];
		for (const [name, response] of rows) {
			for (const phase of ["open", "install"] as const) {
				const fake = adversarialStrictStore({
					getBlob: () => ({ ok: false, reason: "STORE_CLOSED" }),
					readHead: () => response,
					recoverActiveGeneration: () => ({ ok: false, reason: "STORE_CLOSED" }),
				});
				const durable = createStore({
					objectId: OBJECT_ID,
					pinnedGenesisAnchorDigest: material.anchorDigest,
					store: fake.store,
				});
				const result = await settledResult(() =>
					phase === "open" ? durable.open() : durable.install(installInput(material))
				);
				outcomes.push({
					name,
					phase,
					result,
					writes: fake.calls.filter((method) => STORE_WRITE_METHODS.includes(method as never)),
				});
			}
		}
		expect(outcomes).toEqual(
			rows.flatMap(([name]) =>
				(["open", "install"] as const).map((phase) => ({
					name,
					phase,
					result: { ok: false, reason: "store-failed" },
					writes: [],
				}))
			)
		);
	});

	it("[RED post-await recovery/blob] snapshots dense references without iterators and closes malformed store data", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const entry = candidate(trustRecord(material));
		const seed = createSqliteAheDurableStore({ filename: await databaseFilename() });
		const head = await stageAndSwap(seed, OBJECT_ID, generationId("9"), noHead(OBJECT_ID), [entry]);
		const recovered = await seed.recoverActiveGeneration(OBJECT_ID);
		if (!recovered.ok || recovered.value.kind !== "active") throw new Error("SEED_RECOVERY_FAILED");
		const active = recovered.value;
		await seed.close();

		const denseWithoutIterator = [Object.freeze({ ...entry.ref })];
		Object.defineProperty(denseWithoutIterator, Symbol.iterator, {
			configurable: true,
			get(): never {
				throw new Error("REFERENCES_ITERATOR_MUST_NOT_BE_READ");
			},
		});
		const indexedAccessor: unknown[] = [];
		Object.defineProperty(indexedAccessor, "0", {
			enumerable: true,
			get(): never {
				throw new Error("POISONED_REFERENCE_INDEX");
			},
		});
		indexedAccessor.length = 1;
		const sparseReferences = new Array<GenerationRef>(1);
		const nonArrayReferences = Object.freeze({ 0: entry.ref, length: 1 });
		const poisonedReferenceByteLength = Object.defineProperties(
			{},
			{
				byteLength: {
					enumerable: true,
					get(): never {
						throw new Error("POISONED_REFERENCE_BYTE_LENGTH");
					},
				},
				digest: { enumerable: true, value: entry.ref.digest },
			}
		);
		const poisonedReferenceDigest = Object.defineProperties(
			{},
			{
				byteLength: { enumerable: true, value: entry.ref.byteLength },
				digest: {
					enumerable: true,
					get(): never {
						throw new Error("POISONED_REFERENCE_DIGEST");
					},
				},
			}
		);
		const poisonedRecoveryOk = Object.defineProperty({}, "ok", {
			enumerable: true,
			get(): never {
				throw new Error("POISONED_RECOVERY_OK");
			},
		});
		const poisonedRecoveryValue = Object.defineProperties(
			{},
			{
				ok: { enumerable: true, value: true },
				value: {
					enumerable: true,
					get(): never {
						throw new Error("POISONED_RECOVERY_VALUE");
					},
				},
			}
		);
		const poisonedRecoveryKind = Object.freeze({
			ok: true,
			value: Object.defineProperty({}, "kind", {
				enumerable: true,
				get(): never {
					throw new Error("POISONED_RECOVERY_KIND");
				},
			}),
		});
		const poisonedRecoveryHead = Object.freeze({
			ok: true,
			value: Object.defineProperties(
				{},
				{
					head: {
						enumerable: true,
						get(): never {
							throw new Error("POISONED_RECOVERY_HEAD");
						},
					},
					kind: { enumerable: true, value: "active" },
				}
			),
		});
		const poisonedRecoveryReferences = Object.freeze({
			ok: true,
			value: Object.defineProperties(
				{},
				{
					head: { enumerable: true, value: head },
					kind: { enumerable: true, value: "active" },
					references: {
						enumerable: true,
						get(): never {
							throw new Error("POISONED_RECOVERY_REFERENCES");
						},
					},
				}
			),
		});
		const poisonedBlobResult = Object.defineProperties(
			{},
			{
				ok: { enumerable: true, value: true },
				value: {
					enumerable: true,
					get(): never {
						throw new Error("POISONED_BLOB_VALUE");
					},
				},
			}
		);
		const poisonedBlobOk = Object.defineProperty({}, "ok", {
			enumerable: true,
			get(): never {
				throw new Error("POISONED_BLOB_OK");
			},
		});
		const poisonedBlobBytes = new Proxy(new Uint8Array(entry.bytes), {
			get(_target, property): never {
				throw new Error(`POISONED_BLOB_DATA:${String(property)}`);
			},
		});
		const rows = [
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "already-installed" },
				expectedOpen: { head, ok: true, trustRef: entry.ref },
				name: "dense-poisoned-iterator-control",
				recovery: { ok: true, value: { ...active, references: denseWithoutIterator } },
			},
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "indexed-accessor",
				recovery: { ok: true, value: { ...active, references: indexedAccessor } },
			},
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "sparse-references",
				recovery: { ok: true, value: { ...active, references: sparseReferences } },
			},
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "non-array-references",
				recovery: { ok: true, value: { ...active, references: nonArrayReferences } },
			},
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "poisoned-reference-byte-length",
				recovery: { ok: true, value: { ...active, references: [poisonedReferenceByteLength] } },
			},
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "poisoned-reference-digest",
				recovery: { ok: true, value: { ...active, references: [poisonedReferenceDigest] } },
			},
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "malformed-recovery-result",
				recovery: null,
			},
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "poisoned-recovery-ok",
				recovery: poisonedRecoveryOk,
			},
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "poisoned-recovery-value",
				recovery: poisonedRecoveryValue,
			},
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "poisoned-recovery-kind",
				recovery: poisonedRecoveryKind,
			},
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "poisoned-recovery-head",
				recovery: poisonedRecoveryHead,
			},
			{
				blob: { ok: true, value: new Uint8Array(entry.bytes) },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "poisoned-recovery-references",
				recovery: poisonedRecoveryReferences,
			},
			{
				blob: null,
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "malformed-blob-result",
				recovery: { ok: true, value: { ...active, references: [entry.ref] } },
			},
			{
				blob: poisonedBlobOk,
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "poisoned-blob-ok",
				recovery: { ok: true, value: { ...active, references: [entry.ref] } },
			},
			{
				blob: poisonedBlobResult,
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "poisoned-blob-value",
				recovery: { ok: true, value: { ...active, references: [entry.ref] } },
			},
			{
				blob: { ok: true, value: poisonedBlobBytes },
				expectedInstall: { ok: false, reason: "store-failed" },
				expectedOpen: { ok: false, reason: "trust-state-unreadable" },
				name: "poisoned-blob-data",
				recovery: { ok: true, value: { ...active, references: [entry.ref] } },
			},
		] as const;
		const outcomes: unknown[] = [];
		for (const row of rows) {
			for (const phase of ["open", "install"] as const) {
				const fake = adversarialStrictStore({
					getBlob: () => row.blob,
					readHead: () => ({ ok: true, value: head }),
					recoverActiveGeneration: () => row.recovery,
				});
				const durable = createStore({
					objectId: OBJECT_ID,
					pinnedGenesisAnchorDigest: material.anchorDigest,
					store: fake.store,
				});
				const result = await settledResult(() =>
					phase === "open" ? durable.open() : durable.install(installInput(material))
				);
				outcomes.push({
					name: row.name,
					phase,
					result,
					writes: fake.calls.filter((method) => STORE_WRITE_METHODS.includes(method as never)),
				});
			}
		}
		expect(outcomes).toEqual(
			rows.flatMap((row) =>
				(["open", "install"] as const).map((phase) => ({
					name: row.name,
					phase,
					result:
						phase === "open" && row.expectedOpen.ok
							? expect.objectContaining(row.expectedOpen)
							: phase === "open"
								? row.expectedOpen
								: row.expectedInstall,
					writes: [],
				}))
			)
		);
	});

	it("[RED concurrency] gives one absent-head CAS winner and byte-classifies identical versus conflicting losers", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const filename = await databaseFilename();
		const material = makeCreatorMaterial();
		const firstBackend = createSqliteAheDurableStore({ filename });
		const secondBackend = createSqliteAheDurableStore({ filename });
		const first = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: firstBackend,
		});
		const second = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: secondBackend,
		});
		const identical = await Promise.all([
			first.install(installInput(material)),
			second.install(installInput(material)),
		]);
		expect(identical.filter(({ ok }) => ok)).toHaveLength(1);
		expect(identical.filter((result) => !result.ok)).toEqual([
			expect.objectContaining({ ok: false, reason: "already-installed" }),
		]);
		await firstBackend.close();
		await secondBackend.close();

		const conflictFilename = await databaseFilename();
		const victimBackend = createSqliteAheDurableStore({ filename: conflictFilename });
		const attackerBackend = createSqliteAheDurableStore({ filename: conflictFilename });
		const attacker = makeCreatorMaterial("20".repeat(32));
		const victimOwner = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: victimBackend,
		});
		const attackerOwner = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: attacker.anchorDigest,
			store: attackerBackend,
		});
		const conflict = await Promise.all([
			victimOwner.install(installInput(material)),
			attackerOwner.install(installInput(attacker)),
		]);
		expect(conflict.filter(({ ok }) => ok)).toHaveLength(1);
		expect(conflict.filter((result) => !result.ok)).toEqual([
			expect.objectContaining({ cause: "genesis-pin-mismatch", ok: false, reason: "trust-rejected" }),
		]);
		await victimBackend.close();
		await attackerBackend.close();
	});

	it("[RED lost CAS] reruns the scanner and reopens only classifiable winners", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const valid = makeTrustStateRecord(material);
		const rows = [
			["record-schema-invalid", mutateCanonical(valid, { currentEpoch: "zero" }), "trust-rejected", 2],
			["unsupported-trust-state-version", mutateCanonical(valid, { version: 2 }), "trust-rejected", 2],
			["unsupported-trust-profile", mutateCanonical(valid, { profileId: "delegated-trusted-v1" }), "trust-rejected", 2],
			[
				"trust-state-inconsistent",
				mutateCanonical(valid, { currentAnchorDigest: "e".repeat(64) }),
				"trust-rejected",
				2,
			],
			[
				"invalid-signature",
				mutateCanonical(valid, { detachedCurrentAnchorSignature: new Uint8Array(64) }),
				"trust-rejected",
				2,
			],
			["trust-state-missing", Uint8Array.of(0xff), "closure-rejected", 1],
			["trust-state-missing", new Uint8Array([...valid, 0]), "closure-rejected", 1],
		] as const;
		for (const [index, [cause, bytes, reason, expectedOpenCalls]] of rows.entries()) {
			const winnerEntry = candidate(bytes);
			const winner = createSqliteAheDurableStore({ filename: await databaseFilename() });
			await stageAndSwap(
				winner,
				OBJECT_ID,
				generationId(["c", "d", "e", "f", "a", "b", "0"][index] as string),
				noHead(OBJECT_ID),
				[winnerEntry]
			);
			const primary = createSqliteAheDurableStore({ filename: await databaseFilename() });
			const store = simulateLostCasStore(primary, winner);
			const durable = createStore({
				objectId: OBJECT_ID,
				pinnedGenesisAnchorDigest: material.anchorDigest,
				store,
			});
			resetGenuineCallEvidence();
			assertClosedFailure(await durable.install(installInput(material)), {
				cause,
				ok: false,
				reason,
			});
			expect(
				genuineCallEvidence.events.filter((event) => event === "openCurrentAnchorTrust"),
				`${reason}/${cause}`
			).toHaveLength(expectedOpenCalls);
			await store.close();
		}
	});

	it("[RED crash retry] leaves no authoritative head and allocates a fresh GenerationId for retry", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const observed = observeStore(createSqliteAheDurableStore({ filename: await databaseFilename() }), {
			failFirstSwap: true,
		});
		const durable = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: observed.store,
		});
		assertClosedFailure(await durable.install(installInput(material)), { ok: false, reason: "store-failed" });
		expect(await observed.store.readHead(OBJECT_ID)).toEqual({ ok: true, value: noHead(OBJECT_ID) });
		const retried = await durable.install(installInput(material));
		expect(retried.ok).toBe(true);
		const generationIds = observed.calls
			.filter(({ method }) => method === "beginGeneration")
			.map(({ input }) => (input as { readonly generationId: GenerationId }).generationId);
		expect(generationIds).toHaveLength(2);
		expect(new Set(generationIds).size).toBe(2);
		await observed.store.close();
	});

	it("[RED C11 combined] checks exact trust preservation before staging and rejects drop/duplicate/replace", async () => {
		const assertPreserved = requireExport<AssertTrustPreserved>("assertTrustPreserved");
		const trust = candidate(trustRecord());
		const state = candidate(encodeCanonical({ kind: "combined-state", value: 1 }));
		const foreign = candidate(
			trustRecord(makeCreatorMaterial({ objectId: String(FOREIGN_OBJECT_ID), privateKeySeedHex: "20".repeat(32) }))
		);
		const duplicate = candidate(makeTrustStateRecord(makeCreatorMaterial(), 2));
		const scenarios = [
			{ candidates: [trust, state], expected: { ok: true }, name: "retained" },
			{
				candidates: [state],
				expected: { ok: false, reason: "trust-state-missing" },
				name: "dropped",
			},
			{
				candidates: [trust, duplicate, state],
				expected: { ok: false, reason: "trust-state-ambiguous" },
				name: "duplicated",
			},
			{
				candidates: [foreign, state],
				expected: { ok: false, reason: "trust-ref-not-preserved" },
				name: "replaced",
			},
		] as const;
		for (const [index, scenario] of scenarios.entries()) {
			const backend = observeStore(createSqliteAheDurableStore({ filename: await databaseFilename() }));
			const result = await simulateCombinedGeneration(
				assertPreserved,
				backend,
				scenario.candidates,
				trust.ref,
				generationId(String(index + 5))
			);
			expect(result, scenario.name).toMatchObject(scenario.expected);
			if (!result.ok) expect(backend.calls, `${scenario.name}:must reject before staging`).toEqual([]);
			else {
				expect(backend.calls.map(({ method }) => method)).toEqual([
					"beginGeneration",
					"putCachedBlob",
					"promoteReference",
					"putCachedBlob",
					"promoteReference",
					"completeGeneration",
					"swapHead",
				]);
			}
			await backend.store.close();
		}

		const lateMutant = observeStore(createSqliteAheDurableStore({ filename: await databaseFilename() }));
		const killed = await simulateCombinedGeneration(
			assertPreserved,
			lateMutant,
			[state],
			trust.ref,
			generationId("9"),
			"after-stage-mutant"
		);
		expect(killed).toEqual({ ok: false, reason: "trust-state-missing" });
		expect(lateMutant.calls.map(({ method }) => method)).toContain("swapHead");
		expect(await lateMutant.store.readHead(OBJECT_ID)).toMatchObject({ ok: true, value: { kind: "present" } });
		await lateMutant.store.close();
	});

	it("[RED capability] refuses ephemeral AHE success and exports no parallel store or advancement authority", async () => {
		const createStore = requireExport<CreateCurrentAnchorTrustStore>("createCurrentAnchorTrustStore");
		const material = makeCreatorMaterial();
		const memory = observeStore(createMemoryAheDurableStore());
		const durable = createStore({
			objectId: OBJECT_ID,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store: memory.store,
		});
		assertClosedFailure(await durable.install(installInput(material)), { ok: false, reason: "store-failed" });
		expect(memory.calls).toEqual([]);
		for (const name of FORBIDDEN_RUNTIME_NAMES) expect(Reflect.has(controlPlane, name), name).toBe(false);
		await memory.store.close();
	});
});
