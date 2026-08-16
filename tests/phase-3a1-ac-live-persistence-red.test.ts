import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	type AssertTrustPreservedInput,
	type AssertTrustPreservedResult,
	createCurrentAnchorTrustStore,
} from "@ts-drp/control-plane";
import { type prepareBlueprintRuntime } from "@ts-drp/protocol-v3";
import {
	type AheDurableStore,
	type BlobDigest,
	createMemoryAheDurableStore,
	digestBlob,
	digestClosure,
	type GenerationRef,
	parseClosureDigest,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type PresentHead,
	type StorageObjectId,
	type StoreResult,
} from "@ts-drp/storage";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	bytesHex,
	contract,
	type CreatorMaterial,
	hexBytes,
	independentHashDomain,
	makeCreatorMaterial,
} from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import golden from "./fixtures/phase-3a1-ab-v3/graph-projection-golden.json" with { type: "json" };
import packageGolden from "./fixtures/track-p2-b/forward-counter-package.json" with { type: "json" };
import type { TrustedBlueprintCatalog } from "../packages/blueprint-catalog/src/index.js";
import { createSqliteAheDurableStore as createBuiltSqliteAheDurableStore } from "../packages/storage-node/dist/src/index.js";

type ControlPlaneModule = Readonly<{
	assertTrustPreserved(input: AssertTrustPreservedInput): AssertTrustPreservedResult;
	createCurrentAnchorTrustStore: typeof createCurrentAnchorTrustStore;
}> &
	Record<string, unknown>;
type ProtocolV3Module = Readonly<{ prepareBlueprintRuntime: typeof prepareBlueprintRuntime }> & Record<string, unknown>;

interface PreservationSnapshot {
	readonly eventOrdinal: number;
	readonly candidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[];
	readonly closure: readonly GenerationRef[];
	readonly expectedTrustRef: GenerationRef;
	readonly sourceCandidates: AssertTrustPreservedInput["candidates"];
	readonly sourceClosure: AssertTrustPreservedInput["closure"];
	readonly sourceExpectedTrustRef: AssertTrustPreservedInput["expectedTrustRef"];
}

interface TrustOpenSnapshot {
	readonly resolvedEventOrdinal: number;
	readonly startEventOrdinal: number;
}

interface PrepareInvocationSnapshot {
	readonly endEventOrdinal: number;
	readonly startEventOrdinal: number;
}

interface TrustStoreCreationSnapshot {
	readonly objectId: StorageObjectId;
	readonly pinnedGenesisAnchorDigest: string;
	readonly startEventOrdinal: number;
	readonly store: AheDurableStore;
}

const a_cProbe = vi.hoisted(() => ({
	authentications: 0,
	admissions: 0,
	protocolRuntimes: 0,
	preservationFailureAt: undefined as number | undefined,
	preservations: [] as PreservationSnapshot[],
	trustOpens: [] as TrustOpenSnapshot[],
	invocations: [] as PrepareInvocationSnapshot[],
	trustStoreCreations: [] as TrustStoreCreationSnapshot[],
	trustOpenDepth: 0,
	events: [] as string[],
}));

function copiedRef(value: GenerationRef): GenerationRef {
	return Object.freeze({ digest: value.digest, byteLength: value.byteLength });
}

vi.mock("@ts-drp/control-plane", async (importOriginal) => {
	const genuine = await importOriginal<ControlPlaneModule>();
	return {
		...genuine,
		createCurrentAnchorTrustStore(
			input: Parameters<ControlPlaneModule["createCurrentAnchorTrustStore"]>[0]
		): ReturnType<ControlPlaneModule["createCurrentAnchorTrustStore"]> {
			const owner = genuine.createCurrentAnchorTrustStore(input);
			a_cProbe.trustStoreCreations.push(
				Object.freeze({
					objectId: input.objectId,
					pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
					startEventOrdinal: a_cProbe.events.length,
					store: input.store,
				})
			);
			return Object.freeze({
				install: owner.install,
				async open(): ReturnType<typeof owner.open> {
					a_cProbe.events.push("trust.open:start");
					a_cProbe.trustOpenDepth += 1;
					const startEventOrdinal = a_cProbe.events.length - 1;
					try {
						return await owner.open();
					} finally {
						a_cProbe.trustOpenDepth -= 1;
						a_cProbe.events.push("trust.open:resolved");
						a_cProbe.trustOpens.push(
							Object.freeze({
								resolvedEventOrdinal: a_cProbe.events.length - 1,
								startEventOrdinal,
							})
						);
					}
				},
			});
		},
		assertTrustPreserved(input: AssertTrustPreservedInput): ReturnType<ControlPlaneModule["assertTrustPreserved"]> {
			a_cProbe.events.push("trust.preserve");
			a_cProbe.preservations.push(
				Object.freeze({
					eventOrdinal: a_cProbe.events.length - 1,
					candidates: Object.freeze(
						input.candidates.map(({ bytes, ref }) =>
							Object.freeze({ bytes: new Uint8Array(bytes), ref: copiedRef(ref) })
						)
					),
					closure: Object.freeze(input.closure.map(copiedRef)),
					expectedTrustRef: copiedRef(input.expectedTrustRef),
					sourceCandidates: input.candidates,
					sourceClosure: input.closure,
					sourceExpectedTrustRef: input.expectedTrustRef,
				})
			);
			if (a_cProbe.preservationFailureAt === a_cProbe.preservations.length) {
				return Object.freeze({ ok: false as const, reason: "trust-ref-not-preserved" as const });
			}
			return genuine.assertTrustPreserved(input);
		},
	};
});

vi.mock("@ts-drp/protocol-v3", async (importOriginal) => {
	const genuine = await importOriginal<ProtocolV3Module>();
	return {
		...genuine,
		authenticateCurrentEpochAnchor(...input: readonly unknown[]): unknown {
			a_cProbe.authentications += 1;
			return Reflect.apply(
				genuine.authenticateCurrentEpochAnchor as (...args: readonly unknown[]) => unknown,
				genuine,
				input
			);
		},
		prepareBlueprintAdmission(...input: readonly unknown[]): unknown {
			a_cProbe.admissions += 1;
			return Reflect.apply(
				genuine.prepareBlueprintAdmission as (...args: readonly unknown[]) => unknown,
				genuine,
				input
			);
		},
		async prepareBlueprintRuntime(
			input: Parameters<ProtocolV3Module["prepareBlueprintRuntime"]>[0]
		): Promise<Awaited<ReturnType<ProtocolV3Module["prepareBlueprintRuntime"]>>> {
			a_cProbe.protocolRuntimes += 1;
			return await genuine.prepareBlueprintRuntime(input);
		},
	};
});

interface PrepareInput {
	readonly authenticationProfile: "creator-only";
	readonly store: AheDurableStore;
	readonly objectId: StorageObjectId;
	readonly pinnedGenesisAnchorDigest: string;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly detachedSignature: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly catalog: TrustedBlueprintCatalog;
}

interface Descriptor {
	readonly objectId: string;
	readonly epoch: 0;
	readonly anchorDigest: string;
	readonly blueprintDigest: string;
	readonly parametersDigest: string;
	readonly profileDigest: string;
	readonly signerSetDigest: string;
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly catalogDigest: string;
	readonly runtimeProfile: "ecmascript-2024-sync-v1";
	readonly trustProfile: "creator-only";
	readonly trustRef: GenerationRef;
	readonly maxEpochVertices: number;
	readonly maxEpochBytes: number;
	readonly maxDependencies: number;
	readonly vertexCount: 1;
	readonly byteCharge: number;
	readonly projectionDigest: BlobDigest;
	readonly head: PresentHead;
}

type PrepareResult =
	| Readonly<{ readonly ok: true; readonly capability: object; readonly descriptor: Descriptor }>
	| Readonly<{ readonly ok: false; readonly kind: string; readonly detail: string }>;

interface PrivateSurface {
	prepareV3LiveGeneration?(input: PrepareInput): Promise<PrepareResult>;
}

interface BlueprintFixture {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly exactArtifactBytes: Uint8Array;
}

interface CallRecord {
	readonly ordinal: number;
	readonly eventOrdinal: number;
	readonly method: keyof AheDurableStore;
	readonly input: unknown;
}

interface OutcomeRecord {
	readonly ordinal: number;
	readonly method: keyof AheDurableStore;
	readonly result: unknown;
	readonly sourceResult: unknown;
}

type SwapHook = (
	input: Parameters<AheDurableStore["swapHead"]>[0],
	target: AheDurableStore
) => ReturnType<AheDurableStore["swapHead"]>;

type StageFailureMethod = "beginGeneration" | "putCachedBlob" | "promoteReference" | "completeGeneration";
type StageFailure = Readonly<{ readonly method: StageFailureMethod; readonly throws?: boolean }>;
type StageSuccessMutationMethod = StageFailureMethod | "swapHead";
type StageSuccessMutationFault =
	| "extra-key"
	| "wrong-value"
	| "wrong-state"
	| "wrong-object"
	| "wrong-generation"
	| "wrong-base-head"
	| "wrong-closure"
	| "wrong-closure-digest"
	| "wrong-head"
	| "wrong-superseded";
type StageSuccessMutation = Readonly<{
	readonly method: StageSuccessMutationMethod;
	readonly fault: StageSuccessMutationFault;
}>;
type RawEvidenceFault = "wrong-digest" | "wrong-length";

interface FixtureContext {
	readonly rawStore: AheDurableStore;
	readonly observedStore: AheDurableStore;
	readonly calls: CallRecord[];
	readonly outcomes: OutcomeRecord[];
	readonly input: PrepareInput;
	readonly material: CreatorMaterial;
	readonly initialHead: PresentHead;
	readonly trustRef: GenerationRef;
	readonly catalogResolutions: { value: number };
}

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const IMPLEMENTATION = path.join(REPOSITORY_ROOT, "packages/node/src/v3-live.ts");
const ARTIFACT = path.join(REPOSITORY_ROOT, "tests/fixtures/track-p2-c/primary.mjs");
const PARAMETERS = Object.freeze({
	maxEpochVertices: 8192,
	maxEpochBytes: 8_388_608,
	maxDependencies: 16,
	snapshotChunkBytes: 131_072,
	maxSnapshotBytes: 268_435_456,
	maxPendingEntries: 4096,
	maxPendingBytes: 16_777_216,
});
const A_C_MUTATION_METHODS = new Set<keyof AheDurableStore>([
	"beginGeneration",
	"putCachedBlob",
	"promoteReference",
	"completeGeneration",
	"swapHead",
]);
const IntrinsicWeakMap = WeakMap;
const directories: string[] = [];
const createSqliteAheDurableStore = createBuiltSqliteAheDurableStore as unknown as (input: {
	readonly filename: string;
}) => AheDurableStore;

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new TypeError("invalid deterministic fixture");
	return result.value;
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

let cachedBlueprint: BlueprintFixture | undefined;

function blueprintFixture(): BlueprintFixture {
	if (cachedBlueprint !== undefined) return cachedBlueprint;
	const exactArtifactBytes = new TextEncoder().encode(readFileSync(ARTIFACT, "utf8"));
	const artifactDigest = lowerHex(hashDomain(packageGolden.artifactDigestDomain, exactArtifactBytes));
	const packageRecord = Object.freeze({
		...packageGolden.package,
		implementation: Object.freeze({ ...packageGolden.package.implementation, artifactDigest }),
	});
	const canonicalBlueprintPackageBytes = encodeCanonical(packageRecord);
	const blueprintDigest = lowerHex(hashDomain(packageGolden.blueprintDigestDomain, canonicalBlueprintPackageBytes));
	cachedBlueprint = Object.freeze({
		artifactDigest,
		artifactId: packageRecord.implementation.artifactId,
		blueprintDigest,
		canonicalBlueprintPackageBytes,
		exactArtifactBytes,
	});
	return cachedBlueprint;
}

function liveMaterial(): CreatorMaterial {
	const base = makeCreatorMaterial({ objectId: `creator:${"a".repeat(32)}` });
	const anchor = Object.freeze({
		...base.anchor,
		blueprintDigest: blueprintFixture().blueprintDigest,
		parametersDigest: lowerHex(hashDomain("ts-drp/parameters/v3", encodeCanonical(PARAMETERS))),
	});
	const anchorBytes = encodeCanonical(anchor);
	const anchorDigest = bytesHex(independentHashDomain(contract.anchorDigestDomain, anchorBytes));
	return Object.freeze({
		...base,
		anchor,
		anchorBytes,
		anchorDigest,
		signature: ed25519.sign(hexBytes(anchorDigest), hexBytes(contract.privateKeySeedHex)),
	});
}

function catalog(counter: { value: number }): TrustedBlueprintCatalog {
	const fixture = blueprintFixture();
	const catalogDigest = "9".repeat(64);
	return Object.freeze({
		blueprintDigests: Object.freeze([fixture.blueprintDigest]),
		catalogDigest,
		resolve(requested: string) {
			counter.value += 1;
			if (requested !== fixture.blueprintDigest) throw new TypeError("not catalogued");
			return Object.freeze({
				artifactDigest: fixture.artifactDigest,
				artifactId: fixture.artifactId,
				blueprintDigest: fixture.blueprintDigest,
				canonicalBlueprintPackageBytes: new Uint8Array(fixture.canonicalBlueprintPackageBytes),
				exactArtifactBytes: new Uint8Array(fixture.exactArtifactBytes),
				runtimeProfile: "ecmascript-2024-sync-v1" as const,
				evidence: Object.freeze({
					catalogDigest,
					lintEvidenceDigest: "a".repeat(64),
					conformanceReceiptDigest: "b".repeat(64),
					conformanceDigest: "c".repeat(64),
					conformanceTier: "nightly" as const,
					conformanceResult: "passed" as const,
					engines: Object.freeze([
						Object.freeze({ name: "node" as const, build: "node-test" }),
						Object.freeze({ name: "chromium" as const, build: "chromium-test" }),
						Object.freeze({ name: "firefox" as const, build: "firefox-test" }),
						Object.freeze({ name: "webkit" as const, build: "webkit-test" }),
					]),
				}),
			});
		},
	});
}

function copiedInput(input: unknown): unknown {
	if (input === undefined || input === null || typeof input !== "object") return input;
	if (input instanceof Uint8Array) return new Uint8Array(input);
	if (Array.isArray(input)) return Object.freeze(input.map(copiedInput));
	return Object.freeze(
		Object.fromEntries(
			Reflect.ownKeys(input).map((key) => [key, copiedInput((input as Record<PropertyKey, unknown>)[key])])
		)
	);
}

function observedStore(
	target: AheDurableStore,
	calls: CallRecord[],
	outcomes: OutcomeRecord[],
	hooks: SwapHook[] = [],
	stageFailure?: StageFailure,
	stageSuccessMutation?: StageSuccessMutation,
	capabilities: AheDurableStore["capabilities"] = target.capabilities,
	rawEvidenceFault?: RawEvidenceFault
): AheDurableStore {
	const record = (method: keyof AheDurableStore, input: unknown): number => {
		const ordinal = calls.length;
		a_cProbe.events.push(`store.${method}`);
		calls.push(Object.freeze({ ordinal, eventOrdinal: a_cProbe.events.length - 1, method, input: copiedInput(input) }));
		return ordinal;
	};
	const settle = async <T>(ordinal: number, method: keyof AheDurableStore, pending: Promise<T>): Promise<T> => {
		let result: unknown = await pending;
		if (
			stageSuccessMutation?.method === method &&
			typeof result === "object" &&
			result !== null &&
			Reflect.get(result, "ok") === true
		) {
			const value = Reflect.get(result, "value");
			let mutatedValue: unknown;
			if (stageSuccessMutation.fault === "extra-key" && typeof value === "object" && value !== null) {
				mutatedValue = Object.freeze({ ...(value as Record<string, unknown>), unexpected: true });
			} else if (stageSuccessMutation.fault === "wrong-head" && method === "swapHead") {
				const head = Reflect.get(value as object, "head") as Record<string, unknown>;
				mutatedValue = Object.freeze({
					...(value as Record<string, unknown>),
					head: Object.freeze({ ...head, revision: Number(head.revision) + 7 }),
				});
			} else if (stageSuccessMutation.fault === "wrong-superseded" && method === "swapHead") {
				mutatedValue = Object.freeze({ ...(value as Record<string, unknown>), supersededGenerationId: null });
			} else if (
				[
					"wrong-state",
					"wrong-object",
					"wrong-generation",
					"wrong-base-head",
					"wrong-closure",
					"wrong-closure-digest",
				].includes(stageSuccessMutation.fault) &&
				typeof value === "object" &&
				value !== null &&
				(method === "beginGeneration" || method === "completeGeneration")
			) {
				const replacements: Readonly<Record<string, unknown>> = Object.freeze({
					"wrong-state": method === "beginGeneration" ? "Complete" : "Staged",
					"wrong-object": "creator:wrong",
					"wrong-generation": "0".repeat(64),
					"wrong-base-head": null,
					"wrong-closure": Object.freeze([]),
					"wrong-closure-digest": "0".repeat(64),
				});
				const field = stageSuccessMutation.fault.slice("wrong-".length).replaceAll("-", "");
				const recordField =
					field === "object"
						? "objectId"
						: field === "generation"
							? "generationId"
							: field === "basehead"
								? "baseExpectedHead"
								: field === "closuredigest"
									? "closureDigest"
									: field;
				mutatedValue = Object.freeze({
					...(value as Record<string, unknown>),
					[recordField]: replacements[stageSuccessMutation.fault],
				});
			} else if (stageSuccessMutation.fault === "wrong-value") {
				if (method === "putCachedBlob") {
					mutatedValue = Object.freeze({ inserted: "yes" });
				} else {
					mutatedValue = null;
				}
			} else {
				throw new TypeError(`unsupported ${method}/${stageSuccessMutation.fault} test mutation`);
			}
			result = Object.freeze({
				ok: true,
				value: mutatedValue,
			});
		}
		outcomes.push(Object.freeze({ ordinal, method, result: copiedInput(result), sourceResult: result }));
		return result as T;
	};
	let swapOrdinal = 0;
	let rawEvidenceBlobOrdinal = 0;
	let rawEvidenceRecoveryOrdinal = 0;
	const failStage = (method: StageFailureMethod): StoreResult<never> | undefined => {
		if (stageFailure?.method !== method) return undefined;
		if (stageFailure.throws === true) throw new Error(`synthetic ${method} failure`);
		return Object.freeze({ ok: false as const, reason: "SUBSTRATE_FAILURE" as const, cause: method });
	};
	return Object.freeze({
		capabilities,
		readHead(input): ReturnType<AheDurableStore["readHead"]> {
			const ordinal = record("readHead", input);
			return settle(ordinal, "readHead", target.readHead(input));
		},
		readGenerationPage(input): ReturnType<AheDurableStore["readGenerationPage"]> {
			const ordinal = record("readGenerationPage", input);
			return settle(ordinal, "readGenerationPage", target.readGenerationPage(input));
		},
		recoverActiveGeneration(input): ReturnType<AheDurableStore["recoverActiveGeneration"]> {
			const ordinal = record("recoverActiveGeneration", input);
			const pending = target.recoverActiveGeneration(input).then((result) => {
				if (
					rawEvidenceFault !== "wrong-length" ||
					a_cProbe.trustOpenDepth !== 0 ||
					rawEvidenceRecoveryOrdinal > 0 ||
					!result.ok ||
					result.value.kind !== "active" ||
					result.value.references.length === 0
				) {
					return result;
				}
				rawEvidenceRecoveryOrdinal += 1;
				const [first, ...remaining] = result.value.references;
				if (first === undefined) throw new TypeError("missing raw evidence reference");
				return Object.freeze({
					ok: true as const,
					value: Object.freeze({
						...result.value,
						references: Object.freeze([
							Object.freeze({ digest: first.digest, byteLength: first.byteLength + 1 }),
							...remaining,
						]),
					}),
				});
			});
			return settle(ordinal, "recoverActiveGeneration", pending);
		},
		getBlob(input): ReturnType<AheDurableStore["getBlob"]> {
			const ordinal = record("getBlob", input);
			const pending = target.getBlob(input).then((result) => {
				if (
					rawEvidenceFault !== "wrong-digest" ||
					a_cProbe.trustOpenDepth !== 0 ||
					rawEvidenceBlobOrdinal > 0 ||
					!result.ok ||
					result.value === null
				) {
					return result;
				}
				rawEvidenceBlobOrdinal += 1;
				const source = result.value;
				const bytes = Uint8Array.from(source, (byte, index) => (index === 0 ? byte ^ 0xff : byte));
				return Object.freeze({ ok: true as const, value: bytes });
			});
			return settle(ordinal, "getBlob", pending);
		},
		beginGeneration(input): ReturnType<AheDurableStore["beginGeneration"]> {
			const ordinal = record("beginGeneration", input);
			const failed = failStage("beginGeneration");
			return settle(
				ordinal,
				"beginGeneration",
				failed === undefined ? target.beginGeneration(input) : Promise.resolve(failed)
			);
		},
		putCachedBlob(input): ReturnType<AheDurableStore["putCachedBlob"]> {
			const ordinal = record("putCachedBlob", input);
			const failed = failStage("putCachedBlob");
			return settle(
				ordinal,
				"putCachedBlob",
				failed === undefined ? target.putCachedBlob(input) : Promise.resolve(failed)
			);
		},
		promoteReference(input): ReturnType<AheDurableStore["promoteReference"]> {
			const ordinal = record("promoteReference", input);
			const failed = failStage("promoteReference");
			return settle(
				ordinal,
				"promoteReference",
				failed === undefined ? target.promoteReference(input) : Promise.resolve(failed)
			);
		},
		completeGeneration(input): ReturnType<AheDurableStore["completeGeneration"]> {
			const ordinal = record("completeGeneration", input);
			const failed = failStage("completeGeneration");
			return settle(
				ordinal,
				"completeGeneration",
				failed === undefined ? target.completeGeneration(input) : Promise.resolve(failed)
			);
		},
		swapHead(input): ReturnType<AheDurableStore["swapHead"]> {
			const ordinal = record("swapHead", input);
			const hook = hooks[swapOrdinal];
			swapOrdinal += 1;
			return settle(ordinal, "swapHead", hook === undefined ? target.swapHead(input) : hook(input, target));
		},
		discardGeneration(input): ReturnType<AheDurableStore["discardGeneration"]> {
			const ordinal = record("discardGeneration", input);
			return settle(ordinal, "discardGeneration", target.discardGeneration(input));
		},
		close(): ReturnType<AheDurableStore["close"]> {
			record("close", undefined);
			return target.close();
		},
	} satisfies AheDurableStore);
}

async function installTrust(
	store: AheDurableStore,
	material: CreatorMaterial
): Promise<{
	readonly head: PresentHead;
	readonly trustRef: GenerationRef;
}> {
	const objectId = must(parseStorageObjectId(String(material.anchor.objectId)));
	const owner = createCurrentAnchorTrustStore({
		objectId,
		pinnedGenesisAnchorDigest: material.anchorDigest,
		store,
	});
	const installed = await owner.install({
		detachedGenesisSignature: material.signature,
		exactCanonicalGenesisAnchorPreimageBytes: material.anchorBytes,
		exactCanonicalProfileBytes: material.profileBytes,
		exactCanonicalSignerSetBytes: material.signerSetBytes,
		pinnedGenesisAnchorDigest: material.anchorDigest,
	});
	if (!installed.ok) throw new TypeError(`trust installation failed: ${installed.reason}`);
	return Object.freeze({ head: installed.head, trustRef: installed.trustRef });
}

async function fixtureContext(
	hooks: SwapHook[] = [],
	stageFailure?: StageFailure,
	stageSuccessMutation?: StageSuccessMutation,
	rawEvidenceFault?: RawEvidenceFault
): Promise<FixtureContext> {
	const directory = mkdtempSync(path.join(tmpdir(), "drp-3a1-ac-"));
	directories.push(directory);
	const rawStore = createSqliteAheDurableStore({ filename: path.join(directory, "store.sqlite") });
	const material = liveMaterial();
	const installed = await installTrust(rawStore, material);
	const calls: CallRecord[] = [];
	const outcomes: OutcomeRecord[] = [];
	const observed = observedStore(
		rawStore,
		calls,
		outcomes,
		hooks,
		stageFailure,
		stageSuccessMutation,
		rawStore.capabilities,
		rawEvidenceFault
	);
	const objectId = must(parseStorageObjectId(String(material.anchor.objectId)));
	const catalogResolutions = { value: 0 };
	return Object.freeze({
		rawStore,
		observedStore: observed,
		calls,
		outcomes,
		material,
		initialHead: installed.head,
		trustRef: installed.trustRef,
		catalogResolutions,
		input: Object.freeze({
			authenticationProfile: "creator-only" as const,
			store: observed,
			objectId,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			exactCanonicalAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
			detachedSignature: new Uint8Array(material.signature),
			exactCanonicalParametersCarrierBytes: encodeCanonical(PARAMETERS),
			catalog: catalog(catalogResolutions),
		}),
	});
}

async function privateSurface(): Promise<PrivateSurface> {
	return import("../packages/node/src/v3-live.js") as Promise<PrivateSurface>;
}

async function invokePrepare(surface: PrivateSurface, input: PrepareInput): Promise<PrepareResult> {
	if (surface.prepareV3LiveGeneration === undefined) throw new TypeError("missing private preparation API");
	a_cProbe.events.push("prepare:start");
	const startEventOrdinal = a_cProbe.events.length - 1;
	try {
		return await surface.prepareV3LiveGeneration(input);
	} finally {
		a_cProbe.events.push("prepare:resolved");
		a_cProbe.invocations.push(
			Object.freeze({
				endEventOrdinal: a_cProbe.events.length - 1,
				startEventOrdinal,
			})
		);
	}
}

async function prepare(context: FixtureContext): Promise<PrepareResult> {
	return invokePrepare(await privateSurface(), context.input);
}

function expectFailure(result: PrepareResult, kind: string): void {
	expect(result).toEqual({ ok: false, kind, detail: expect.any(String) });
}

function expectSuccess(result: PrepareResult): asserts result is Extract<PrepareResult, { readonly ok: true }> {
	expect(result).toEqual({ ok: true, capability: expect.any(Object), descriptor: expect.any(Object) });
	if (!result.ok) throw new TypeError(`expected success, received ${result.kind}`);
}

function mutationCalls(calls: readonly CallRecord[]): readonly CallRecord[] {
	return calls.filter(({ method }) => A_C_MUTATION_METHODS.has(method));
}

function stringKeys(value: unknown): readonly string[] {
	return typeof value === "object" && value !== null
		? Reflect.ownKeys(value)
				.filter((key): key is string => typeof key === "string")
				.sort()
		: [];
}

function outcomeFor(context: FixtureContext, call: CallRecord): unknown {
	return context.outcomes.find(({ ordinal }) => ordinal === call.ordinal)?.result;
}

function sourceOutcomeFor(context: FixtureContext, call: CallRecord): unknown {
	return context.outcomes.find(({ ordinal }) => ordinal === call.ordinal)?.sourceResult;
}

function samePresentHead(left: unknown, right: PresentHead): boolean {
	if (typeof left !== "object" || left === null) return false;
	return (
		Reflect.get(left, "kind") === "present" &&
		Reflect.get(left, "objectId") === right.objectId &&
		Reflect.get(left, "generationId") === right.generationId &&
		Reflect.get(left, "revision") === right.revision &&
		Reflect.get(left, "closureDigest") === right.closureDigest
	);
}

function aCTrustOpensForInvocation(invocationIndex: number): readonly TrustOpenSnapshot[] {
	const invocation = a_cProbe.invocations[invocationIndex];
	if (invocation === undefined) return [];
	const invocationOpens = a_cProbe.trustOpens.filter(
		(open) =>
			open.startEventOrdinal > invocation.startEventOrdinal && open.resolvedEventOrdinal < invocation.endEventOrdinal
	);
	return invocationOpens.slice(1);
}

function aCTrustOpens(): readonly TrustOpenSnapshot[] {
	return a_cProbe.invocations.flatMap((_, invocationIndex) => {
		return aCTrustOpensForInvocation(invocationIndex);
	});
}

function expectInvocationLedger(
	context: FixtureContext,
	invocationIndex: number,
	expected: Readonly<{ readonly cas: number; readonly preservations: number; readonly reopens: number }>
): void {
	const invocation = a_cProbe.invocations[invocationIndex];
	expect(invocation, `prepare invocation ${invocationIndex}`).toBeDefined();
	if (invocation === undefined) throw new TypeError(`missing prepare invocation ${invocationIndex}`);
	const within = (eventOrdinal: number): boolean =>
		eventOrdinal > invocation.startEventOrdinal && eventOrdinal < invocation.endEventOrdinal;
	const opens = a_cProbe.trustOpens.filter(({ startEventOrdinal }) => within(startEventOrdinal));
	const creations = a_cProbe.trustStoreCreations.filter(({ startEventOrdinal }) => within(startEventOrdinal));
	expect(creations, "one genuine durable trust owner per invocation").toHaveLength(1);
	const creation = creations[0];
	if (creation === undefined) throw new TypeError("missing durable trust owner creation");
	expect(creation.store).toBe(context.observedStore);
	expect(creation.objectId).toBe(context.input.objectId);
	expect(creation.pinnedGenesisAnchorDigest).toBe(context.input.pinnedGenesisAnchorDigest);
	expect(opens, "one A-a authentication open plus the exact A-c reopen ledger").toHaveLength(expected.reopens + 1);
	expect(a_cProbe.preservations.filter(({ eventOrdinal }) => within(eventOrdinal))).toHaveLength(
		expected.preservations
	);
	expect(
		context.calls.filter(({ eventOrdinal, method }) => within(eventOrdinal) && method === "swapHead")
	).toHaveLength(expected.cas);
}

function expectSuccessfulResult(value: unknown, expectedValueKeys: readonly string[]): unknown {
	expect(stringKeys(value)).toEqual(["ok", "value"]);
	expect(Reflect.get(value as object, "ok")).toBe(true);
	const resultValue = Reflect.get(value as object, "value");
	expect(stringKeys(resultValue)).toEqual([...expectedValueKeys].sort());
	return resultValue;
}

function expectExactSuccessfulStageOutputs(
	context: FixtureContext,
	expectedClosure: readonly GenerationRef[],
	expectedHead: PresentHead
): void {
	const stages = mutationCalls(context.calls);
	const beginCall = stages.find(({ method }) => method === "beginGeneration");
	const putCall = stages.find(({ method }) => method === "putCachedBlob");
	const promoteCalls = stages.filter(({ method }) => method === "promoteReference");
	const completeCall = stages.find(({ method }) => method === "completeGeneration");
	const swapCall = stages.find(({ method }) => method === "swapHead");
	if (
		beginCall === undefined ||
		putCall === undefined ||
		promoteCalls.length !== 2 ||
		completeCall === undefined ||
		swapCall === undefined
	) {
		throw new TypeError("missing successful stage evidence");
	}
	const generationKeys = ["baseExpectedHead", "closure", "closureDigest", "generationId", "objectId", "state"];
	const begun = expectSuccessfulResult(outcomeFor(context, beginCall), generationKeys) as Record<string, unknown>;
	expect(begun.state).toBe("Staged");
	expect(begun.closure).toEqual(expectedClosure);
	expectSuccessfulResult(outcomeFor(context, putCall), ["inserted"]);
	for (const promoted of promoteCalls) {
		const result = outcomeFor(context, promoted);
		expect(stringKeys(result)).toEqual(["ok", "value"]);
		expect(Reflect.get(result as object, "ok")).toBe(true);
		expect(Reflect.get(result as object, "value")).toBeUndefined();
	}
	const completed = expectSuccessfulResult(outcomeFor(context, completeCall), generationKeys) as Record<
		string,
		unknown
	>;
	expect(completed.state).toBe("Complete");
	expect(completed.generationId).toBe(begun.generationId);
	const swapped = expectSuccessfulResult(outcomeFor(context, swapCall), ["head", "supersededGenerationId"]) as Record<
		string,
		unknown
	>;
	expect(swapped.head).toEqual(expectedHead);
	expect(swapped.supersededGenerationId).toBe(context.initialHead.generationId);
}

function hasExactRawEvidenceCallShape(
	calls: readonly Pick<CallRecord, "input" | "method">[],
	objectId: StorageObjectId,
	expectedRefs: readonly GenerationRef[]
): boolean {
	if (calls.length !== expectedRefs.length + 1) return false;
	if (calls[0]?.method !== "recoverActiveGeneration" || calls[0].input !== objectId) return false;
	for (let index = 0; index < expectedRefs.length; index += 1) {
		const call = calls[index + 1];
		if (call?.method !== "getBlob" || call.input !== expectedRefs[index]?.digest) return false;
	}
	return true;
}

function expectLogicalReopen(
	context: FixtureContext,
	trustOpen: TrustOpenSnapshot,
	expectedHead: PresentHead,
	expectedRefs: readonly GenerationRef[]
): Readonly<{ readonly firstOrdinal: number; readonly lastOrdinal: number; readonly lastEventOrdinal: number }> {
	const sortedRefs = [...expectedRefs].sort((left, right) =>
		left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
	);
	expect(expectedRefs, "authoritative closure refs are already digest-sorted").toEqual(sortedRefs);
	expect(new Set(expectedRefs.map(({ digest }) => digest)).size).toBe(expectedRefs.length);
	const internalCalls = context.calls.filter(
		({ eventOrdinal }) => eventOrdinal > trustOpen.startEventOrdinal && eventOrdinal < trustOpen.resolvedEventOrdinal
	);
	expect(internalCalls.map(({ method }) => method)).toEqual([
		"readHead",
		"recoverActiveGeneration",
		...expectedRefs.map(() => "getBlob" as const),
	]);
	const headCall = internalCalls[0];
	const internalRecoveryCall = internalCalls[1];
	if (headCall === undefined || internalRecoveryCall === undefined) {
		throw new TypeError("missing genuine open internals");
	}
	expect(headCall.input).toBe(context.input.objectId);
	expect(internalRecoveryCall.input).toBe(context.input.objectId);
	const openedHead = Reflect.get(outcomeFor(context, headCall) as object, "value");
	expect(Reflect.get(outcomeFor(context, headCall) as object, "ok")).toBe(true);
	expect(samePresentHead(openedHead, expectedHead)).toBe(true);
	const internallyRecovered = Reflect.get(outcomeFor(context, internalRecoveryCall) as object, "value") as Record<
		string,
		unknown
	>;
	expect(Reflect.get(outcomeFor(context, internalRecoveryCall) as object, "ok")).toBe(true);
	expect(internallyRecovered.kind).toBe("active");
	expect(samePresentHead(internallyRecovered.head, expectedHead)).toBe(true);
	expect(internallyRecovered.references).toEqual(expectedRefs);
	for (let index = 0; index < expectedRefs.length; index += 1) {
		expect(internalCalls[index + 2]?.input).toBe(expectedRefs[index]?.digest);
	}

	const nextPreservation = a_cProbe.preservations.find(
		({ eventOrdinal }) => eventOrdinal > trustOpen.resolvedEventOrdinal
	);
	const nextTokenSet = a_cProbe.events.findIndex(
		(event, eventOrdinal) => eventOrdinal > trustOpen.resolvedEventOrdinal && event === "token.set"
	);
	const invocation = a_cProbe.invocations.find(
		({ endEventOrdinal, startEventOrdinal }) =>
			trustOpen.startEventOrdinal > startEventOrdinal && trustOpen.resolvedEventOrdinal < endEventOrdinal
	);
	const rawPassEnd = Math.min(
		nextPreservation?.eventOrdinal ?? Number.POSITIVE_INFINITY,
		nextTokenSet < 0 ? Number.POSITIVE_INFINITY : nextTokenSet,
		invocation?.endEventOrdinal ?? Number.POSITIVE_INFINITY
	);
	const rawCalls = context.calls.filter(
		({ eventOrdinal }) => eventOrdinal > trustOpen.resolvedEventOrdinal && eventOrdinal < rawPassEnd
	);
	expect(
		hasExactRawEvidenceCallShape(rawCalls, context.input.objectId, expectedRefs),
		"exactly one raw complete evidence pass"
	).toBe(true);
	const recoveryCall = rawCalls[0];
	if (recoveryCall === undefined) throw new TypeError("missing raw durable generation recovery");
	expect(recoveryCall.input).toBe(context.input.objectId);
	const recovered = Reflect.get(outcomeFor(context, recoveryCall) as object, "value") as Record<string, unknown>;
	expect(Reflect.get(outcomeFor(context, recoveryCall) as object, "ok")).toBe(true);
	expect(recovered.kind).toBe("active");
	expect(samePresentHead(recovered.head, expectedHead)).toBe(true);
	expect(recovered.references).toEqual(expectedRefs);
	let lastCall = recoveryCall;
	for (let index = 0; index < expectedRefs.length; index += 1) {
		const ref = expectedRefs[index] as GenerationRef;
		const call = rawCalls[index + 1];
		expect(call?.method).toBe("getBlob");
		expect(call?.input).toBe(ref.digest);
		if (call === undefined) throw new TypeError(`missing raw durable blob reload ${ref.digest}`);
		lastCall = call;
		const result = outcomeFor(context, call);
		expect(Reflect.get(result as object, "ok")).toBe(true);
		const bytes = Reflect.get(result as object, "value");
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect((bytes as Uint8Array).buffer).toBeInstanceOf(ArrayBuffer);
		expect((bytes as Uint8Array).byteLength).toBe(ref.byteLength);
		expect(must(digestBlob(bytes as Uint8Array))).toBe(ref.digest);
		const sourceBytes = Reflect.get(sourceOutcomeFor(context, call) as object, "value");
		expect(sourceBytes).toBeInstanceOf(Uint8Array);
		if (nextPreservation !== undefined && nextPreservation.eventOrdinal === rawPassEnd) {
			const preserved = nextPreservation.sourceCandidates.find(
				({ ref: candidateRef }) => candidateRef.digest === ref.digest
			);
			expect(preserved?.bytes).not.toBe(sourceBytes);
			expect(preserved?.bytes.buffer).not.toBe((sourceBytes as Uint8Array).buffer);
		}
	}
	return Object.freeze({
		firstOrdinal: headCall.ordinal,
		lastOrdinal: lastCall.ordinal,
		lastEventOrdinal: lastCall.eventOrdinal,
	});
}

function expectDurableReloadAfter(
	context: FixtureContext,
	afterOrdinal: number,
	expectedHead: PresentHead,
	expectedRefs: readonly GenerationRef[]
): Readonly<{ readonly firstOrdinal: number; readonly lastOrdinal: number; readonly lastEventOrdinal: number }> {
	const afterCall = context.calls.find(({ ordinal }) => ordinal === afterOrdinal);
	if (afterCall === undefined) throw new TypeError("missing reload boundary call");
	const trustOpen = aCTrustOpens().find(({ startEventOrdinal }) => startEventOrdinal > afterCall.eventOrdinal);
	expect(trustOpen, "genuine durable trust-owner reopen").toBeDefined();
	if (trustOpen === undefined) throw new TypeError("missing genuine durable trust-owner reopen");
	return expectLogicalReopen(context, trustOpen, expectedHead, expectedRefs);
}

function closureRefs(context: FixtureContext): readonly GenerationRef[] {
	const projectionRef = Object.freeze({
		digest: must(digestBlob(bytesFromHex(golden.projectionHex))),
		byteLength: golden.projectionByteLength,
	});
	return Object.freeze(
		[context.trustRef, projectionRef]
			.map(copiedRef)
			.sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0))
	);
}

function expectInitialTrustOnlyReopen(context: FixtureContext, invocationIndex: number): void {
	const initialReopen = aCTrustOpensForInvocation(invocationIndex)[0];
	expect(initialReopen, "initial A-c trust-only reopen").toBeDefined();
	if (initialReopen === undefined) throw new TypeError("missing initial A-c trust-only reopen");
	expectLogicalReopen(context, initialReopen, context.initialHead, [context.trustRef]);
}

function headConflict(): StoreResult<never> {
	return Object.freeze({ ok: false as const, reason: "HEAD_CONFLICT" as const });
}

function ambiguousFailure(): StoreResult<never> {
	return Object.freeze({ ok: false as const, reason: "SUBSTRATE_FAILURE" as const, cause: new Error("ambiguous") });
}

const conflictWithoutWrite: SwapHook = () => Promise.resolve(headConflict());
const ambiguousWithoutWrite: SwapHook = () => Promise.resolve(ambiguousFailure());

function delegateThen(result: StoreResult<never>): SwapHook {
	return async (input, target) => {
		const delegated = await target.swapHead(input);
		if (!delegated.ok) throw new TypeError(`fixture swap failed: ${delegated.reason}`);
		return result;
	};
}

async function stageAlternateHead(
	context: FixtureContext
): Promise<Readonly<{ readonly closure: readonly GenerationRef[]; readonly head: PresentHead }>> {
	const bytes = Uint8Array.of(0x80);
	const digest = must(digestBlob(bytes));
	const ref = Object.freeze({ digest, byteLength: bytes.byteLength });
	const closure = Object.freeze(
		[context.trustRef, ref]
			.map(copiedRef)
			.sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0))
	);
	const generationId = must(parseGenerationId("f".repeat(64)));
	const begun = await context.rawStore.beginGeneration({
		objectId: context.input.objectId,
		generationId,
		baseExpectedHead: context.initialHead,
		closure,
	});
	if (!begun.ok) throw new TypeError(`alternate begin failed: ${begun.reason}`);
	const put = await context.rawStore.putCachedBlob({
		objectId: context.input.objectId,
		generationId,
		digest,
		bytes,
	});
	if (!put.ok) throw new TypeError(`alternate put failed: ${put.reason}`);
	for (const item of closure) {
		const promoted = await context.rawStore.promoteReference({
			objectId: context.input.objectId,
			generationId,
			digest: item.digest,
		});
		if (!promoted.ok) throw new TypeError(`alternate promote failed: ${promoted.reason}`);
	}
	const completed = await context.rawStore.completeGeneration({ objectId: context.input.objectId, generationId });
	if (!completed.ok) throw new TypeError(`alternate complete failed: ${completed.reason}`);
	const swapped = await context.rawStore.swapHead({
		objectId: context.input.objectId,
		generationId,
		expectedHead: context.initialHead,
	});
	if (!swapped.ok) throw new TypeError(`alternate swap failed: ${swapped.reason}`);
	return Object.freeze({ closure, head: swapped.value.head });
}

function deepFrozen(value: unknown, seen = new Set<object>()): boolean {
	if (typeof value !== "object" || value === null || seen.has(value)) return true;
	seen.add(value);
	if (!Object.isFrozen(value)) return false;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor !== undefined && "value" in descriptor && !deepFrozen(descriptor.value, seen)) return false;
	}
	return true;
}

interface TokenSourceAudit {
	readonly privateWeakMapCount: number;
	readonly hasPrivateRegistrationOwner: boolean;
	readonly setsOnSuccessPath: boolean;
	readonly consumesByGetAndDelete: boolean;
	readonly seam3Topology: readonly string[];
	readonly forbiddenFullBLiveEffects: readonly string[];
}

interface ExtractedTokenConsumer {
	readonly ownerName: string;
	readonly registrationOwnerName: string;
	readonly helperName: string;
	readonly helperSource: string;
	readonly withoutDeleteSource: string;
}

function privateTokenExportEscapes(sourceText: string, privateNames: readonly string[]): readonly string[] {
	const source = ts.createSourceFile(IMPLEMENTATION, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const tainted = new Set(privateNames);
	const containsTaintedIdentifier = (node: ts.Node): boolean => {
		let found = false;
		const visit = (current: ts.Node): void => {
			if (ts.isIdentifier(current) && tainted.has(current.text)) found = true;
			if (!found) ts.forEachChild(current, visit);
		};
		visit(node);
		return found;
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (const statement of source.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			for (const declaration of statement.declarationList.declarations) {
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.initializer !== undefined &&
					containsTaintedIdentifier(declaration.initializer) &&
					!tainted.has(declaration.name.text)
				) {
					tainted.add(declaration.name.text);
					changed = true;
				}
			}
		}
	}
	const escapes: string[] = [];
	for (const statement of source.statements) {
		const exported =
			ts.canHaveModifiers(statement) &&
			(ts
				.getModifiers(statement)
				?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword || kind === ts.SyntaxKind.DefaultKeyword) ??
				false);
		const allowedPrivateOwner =
			ts.isFunctionDeclaration(statement) &&
			(statement.name?.text === "activateV3LivePlane" ||
				statement.name?.text === "recoverV3LiveReplica" ||
				statement.name?.text === "routeV3Ingress");
		if (exported && containsTaintedIdentifier(statement) && !allowedPrivateOwner) {
			escapes.push(`exported-declaration:${statement.pos}`);
		}
		if (allowedPrivateOwner) {
			const inspectReturns = (node: ts.Node): void => {
				if (node !== statement && ts.isFunctionLike(node)) return;
				if (ts.isReturnStatement(node) && node.expression !== undefined && containsTaintedIdentifier(node.expression)) {
					escapes.push(`returned-authority:${node.pos}`);
				}
				ts.forEachChild(node, inspectReturns);
			};
			inspectReturns(statement);
		}
		if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
			if (ts.isNamedExports(statement.exportClause)) {
				for (const element of statement.exportClause.elements) {
					const localName = element.propertyName?.text ?? element.name.text;
					if (tainted.has(localName)) escapes.push(`named-export:${localName}`);
				}
			} else if (tainted.has(statement.exportClause.name.text)) {
				escapes.push(`namespace-export:${statement.exportClause.name.text}`);
			}
		}
		if (ts.isExportAssignment(statement) && containsTaintedIdentifier(statement.expression)) {
			escapes.push(`export-assignment:${statement.pos}`);
		}
	}
	return Object.freeze(escapes.sort());
}

function extractedTokenConsumer(sourceText: string): ExtractedTokenConsumer {
	const source = ts.createSourceFile(IMPLEMENTATION, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const owners: Array<{ readonly declaration: ts.VariableDeclaration; readonly name: string }> = [];
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (
				ts.isIdentifier(declaration.name) &&
				declaration.initializer !== undefined &&
				ts.isNewExpression(declaration.initializer) &&
				ts.isIdentifier(declaration.initializer.expression) &&
				declaration.initializer.expression.text === "WeakMap"
			) {
				owners.push({ declaration, name: declaration.name.text });
			}
		}
	}
	expect(owners, "token, recovered replica and Seam-3 registration WeakMap owners").toHaveLength(3);
	const callsFor = (name: string): ts.CallExpression[] => {
		const calls: ts.CallExpression[] = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === name
			) {
				calls.push(node);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		return calls;
	};
	const tokenOwners = owners.filter(({ name }) => {
		const methods = callsFor(name).map(({ expression }) => (expression as ts.PropertyAccessExpression).name.text);
		return (
			methods.filter((method) => method === "set").length === 1 &&
			methods.filter((method) => method === "get").length === 1 &&
			methods.filter((method) => method === "delete").length === 1 &&
			methods.every((method) => ["delete", "get", "set"].includes(method))
		);
	});
	expect(tokenOwners, "prepared and recovered private token WeakMap owners").toHaveLength(2);
	const owner = tokenOwners.find(({ name }) =>
		callsFor(name).some((call) => {
			if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "set") return false;
			let current: ts.Node | undefined = call;
			while (current !== undefined && !ts.isFunctionDeclaration(current)) current = current.parent;
			return current?.name?.text === "prepareV3LiveGeneration";
		})
	);
	if (owner === undefined) throw new TypeError("missing private token owner");
	const registrationOwner = owners.find(({ name }) => {
		if (name === owner.name) return false;
		const users = callsFor(name)
			.map((call) => {
				let current: ts.Node | undefined = call;
				while (current !== undefined && !ts.isFunctionDeclaration(current)) current = current.parent;
				return current?.name?.text;
			})
			.filter((value): value is string => value !== undefined);
		return users.includes("activateV3LivePlane") && users.includes("routeV3Ingress");
	});
	if (registrationOwner === undefined) throw new TypeError("missing private registration owner");
	const recoveryOwner = owners.find(({ name }) => name !== owner.name && name !== registrationOwner.name);
	if (recoveryOwner === undefined) throw new TypeError("missing private recovered-replica owner");
	const registrationOwners = callsFor(registrationOwner.name)
		.map((call) => {
			let current: ts.Node | undefined = call;
			while (current !== undefined && !ts.isFunctionDeclaration(current)) current = current.parent;
			return current?.name?.text;
		})
		.filter((name): name is string => name !== undefined);
	expect(registrationOwners).toContain("activateV3LivePlane");
	expect(registrationOwners).toContain("routeV3Ingress");

	const ownerCalls = callsFor(owner.name);
	const methodNames = ownerCalls.map(({ expression }) => (expression as ts.PropertyAccessExpression).name.text);
	expect(methodNames.filter((name) => name === "set")).toHaveLength(1);
	expect(methodNames.filter((name) => name === "get")).toHaveLength(1);
	expect(methodNames.filter((name) => name === "delete")).toHaveLength(1);
	expect(methodNames.filter((name) => !["set", "get", "delete"].includes(name))).toEqual([]);
	const setCall = ownerCalls.find(({ expression }) => (expression as ts.PropertyAccessExpression).name.text === "set");
	let setOwner: ts.Node | undefined = setCall;
	while (setOwner !== undefined && !ts.isFunctionDeclaration(setOwner)) setOwner = setOwner.parent;
	expect(setOwner !== undefined && ts.isFunctionDeclaration(setOwner) ? setOwner.name?.text : undefined).toBe(
		"prepareV3LiveGeneration"
	);

	const helpers = source.statements.filter((statement): statement is ts.FunctionDeclaration => {
		if (!ts.isFunctionDeclaration(statement) || statement.body === undefined || statement.name === undefined)
			return false;
		return ownerCalls.some((call) => {
			if (!ts.isPropertyAccessExpression(call.expression) || !["get", "delete"].includes(call.expression.name.text))
				return false;
			let current: ts.Node | undefined = call;
			while (current !== undefined && current !== statement) current = current.parent;
			return current === statement;
		});
	});
	expect(helpers, "one top-level private token consumer").toHaveLength(1);
	const helper = helpers[0];
	if (helper === undefined || helper.body === undefined || helper.name === undefined) {
		throw new TypeError("missing private token consumer");
	}
	expect(
		helper.modifiers?.some(
			({ kind }) => kind === ts.SyntaxKind.ExportKeyword || kind === ts.SyntaxKind.DefaultKeyword
		) ?? false
	).toBe(false);
	expect(helper.parameters).toHaveLength(1);
	const parameter = helper.parameters[0];
	if (parameter === undefined || !ts.isIdentifier(parameter.name)) throw new TypeError("invalid token parameter");
	const [declarationStatement, absentGuard, deleteStatement, returnStatement] = helper.body.statements;
	expect(helper.body.statements).toHaveLength(4);
	if (
		declarationStatement === undefined ||
		!ts.isVariableStatement(declarationStatement) ||
		declarationStatement.declarationList.declarations.length !== 1
	) {
		throw new TypeError("invalid token lookup declaration");
	}
	const payloadDeclaration = declarationStatement.declarationList.declarations[0];
	if (
		payloadDeclaration === undefined ||
		!ts.isIdentifier(payloadDeclaration.name) ||
		payloadDeclaration.initializer === undefined ||
		!ts.isCallExpression(payloadDeclaration.initializer) ||
		!ts.isPropertyAccessExpression(payloadDeclaration.initializer.expression)
	) {
		throw new TypeError("invalid token lookup");
	}
	const payloadName = payloadDeclaration.name.text;
	const lookup = payloadDeclaration.initializer;
	const lookupExpression = lookup.expression;
	if (!ts.isPropertyAccessExpression(lookupExpression)) throw new TypeError("invalid token lookup owner");
	expect(lookupExpression.expression.getText(source)).toBe(owner.name);
	expect(lookupExpression.name.text).toBe("get");
	expect(lookup.arguments.map((argument) => argument.getText(source))).toEqual([parameter.name.text]);
	if (absentGuard === undefined || !ts.isIfStatement(absentGuard)) throw new TypeError("missing absent guard");
	expect(
		ts.isBinaryExpression(absentGuard.expression) &&
			absentGuard.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
			ts.isIdentifier(absentGuard.expression.left) &&
			absentGuard.expression.left.text === payloadName &&
			ts.isIdentifier(absentGuard.expression.right) &&
			absentGuard.expression.right.text === "undefined"
	).toBe(true);
	const absentReturn = ts.isBlock(absentGuard.thenStatement)
		? absentGuard.thenStatement.statements[0]
		: absentGuard.thenStatement;
	expect(ts.isBlock(absentGuard.thenStatement) ? absentGuard.thenStatement.statements.length : 1).toBe(1);
	expect(ts.isReturnStatement(absentReturn) ? absentReturn.expression?.getText(source) : undefined).toBe("undefined");
	if (
		deleteStatement === undefined ||
		!ts.isExpressionStatement(deleteStatement) ||
		!ts.isCallExpression(deleteStatement.expression) ||
		!ts.isPropertyAccessExpression(deleteStatement.expression.expression)
	) {
		throw new TypeError("missing token deletion");
	}
	expect(deleteStatement.expression.expression.expression.getText(source)).toBe(owner.name);
	expect(deleteStatement.expression.expression.name.text).toBe("delete");
	expect(deleteStatement.expression.arguments.map((argument) => argument.getText(source))).toEqual([
		parameter.name.text,
	]);
	expect(ts.isReturnStatement(returnStatement) ? returnStatement.expression?.getText(source) : undefined).toBe(
		payloadName
	);
	const helperSource = helper.getText(source);
	const deleteStart = deleteStatement.getStart(source) - helper.getStart(source);
	const deleteEnd = deleteStatement.end - helper.getStart(source);
	expect(
		privateTokenExportEscapes(sourceText, [owner.name, recoveryOwner.name, registrationOwner.name, helper.name.text])
	).toEqual([]);
	return Object.freeze({
		ownerName: owner.name,
		registrationOwnerName: registrationOwner.name,
		helperName: helper.name.text,
		helperSource,
		withoutDeleteSource: `${helperSource.slice(0, deleteStart)}${helperSource.slice(deleteEnd)}`,
	});
}

function compileTokenConsumer(
	evidence: ExtractedTokenConsumer,
	owner: WeakMap<object, unknown>,
	withoutDelete = false
): (token: object) => unknown {
	const helperSource = withoutDelete ? evidence.withoutDeleteSource : evidence.helperSource;
	const transpiled = ts.transpileModule(`const ${evidence.ownerName} = injectedOwner;\n${helperSource}`, {
		compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
		fileName: "isolated-v3-live-token-consumer.ts",
		reportDiagnostics: true,
	});
	const errors = (transpiled.diagnostics ?? []).filter(({ category }) => category === ts.DiagnosticCategory.Error);
	expect(errors).toEqual([]);
	const sandbox = Object.create(null) as Record<string, unknown>;
	Object.defineProperty(sandbox, "injectedOwner", { value: owner });
	const evaluated = runInNewContext(`"use strict";\n${transpiled.outputText}\n${evidence.helperName};`, sandbox, {
		contextCodeGeneration: { strings: false, wasm: false },
		timeout: 1_000,
	}) as unknown;
	if (typeof evaluated !== "function") throw new TypeError("isolated token consumer is not callable");
	return evaluated as (token: object) => unknown;
}

function tokenSourceAudit(source: string): TokenSourceAudit {
	const parsed = ts.createSourceFile(IMPLEMENTATION, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const weakMapOwners: string[] = [];
	const seam3Topology: string[] = [];
	const forbiddenFullBLiveEffects: string[] = [];
	const authorityCalls = new Map<
		string,
		Array<Readonly<{ readonly method: string; readonly owner: string | undefined }>>
	>();
	const forbiddenCalls = new Set([
		"addEventListener",
		"append",
		"dispatch",
		"discardGeneration",
		"queueMicrotask",
		"reducer",
		"setInterval",
		"setTimeout",
		"transactIssue",
	]);
	const functionOwner = (node: ts.Node): string | undefined => {
		let current = node.parent;
		while (current !== undefined && !ts.isFunctionDeclaration(current)) current = current.parent;
		return current?.name?.text;
	};
	const registrationUse = new Map<string, Set<string>>();
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			node.parent.parent.parent === parsed &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined &&
			ts.isNewExpression(node.initializer) &&
			ts.isIdentifier(node.initializer.expression) &&
			node.initializer.expression.text === "WeakMap"
		) {
			weakMapOwners.push(node.name.text);
		}
		if (ts.isIdentifier(node) && weakMapOwners.includes(node.text)) {
			const owner = functionOwner(node);
			if (owner !== undefined) {
				const users = registrationUse.get(node.text) ?? new Set<string>();
				users.add(owner);
				registrationUse.set(node.text, users);
			}
		}
		if (ts.isCallExpression(node)) {
			const owner = functionOwner(node);
			const expression = node.expression;
			const method = ts.isPropertyAccessExpression(expression)
				? expression.name.text
				: ts.isIdentifier(expression)
					? expression.text
					: undefined;
			const receiver = ts.isPropertyAccessExpression(expression) ? expression.expression.getText(parsed) : undefined;
			if (
				method !== undefined &&
				ts.isPropertyAccessExpression(expression) &&
				ts.isIdentifier(expression.expression) &&
				weakMapOwners.includes(expression.expression.text)
			) {
				const calls = authorityCalls.get(expression.expression.text) ?? [];
				calls.push(Object.freeze({ method, owner }));
				authorityCalls.set(expression.expression.text, calls);
			}
			if (method === "subscribe" && owner === "subscribeActivationQueue" && receiver === "messageQueueManager") {
				seam3Topology.push("queue-subscribe");
			} else if (method === "subscribe" && owner === "activateV3LivePlane" && receiver === "boundNetworkNode") {
				seam3Topology.push("topic-subscribe");
			} else if (
				method === "compareAndMarkOutboxPublished" &&
				owner === "publishPending" &&
				receiver === "registration.issuanceStore"
			) {
				seam3Topology.push("outbox-mark");
			} else if (method === "subscribe" || method === "compareAndMarkOutboxPublished") {
				forbiddenFullBLiveEffects.push(`${owner ?? "module"}:${method}`);
			}
			if (
				method !== undefined &&
				forbiddenCalls.has(method) &&
				!(
					(method === "append" &&
						(owner === "recoverV3LiveReplica" || owner === "handleV3Ingress" || owner === "issueLocal")) ||
					(method === "transactIssue" && owner === "issueLocal")
				)
			) {
				forbiddenFullBLiveEffects.push(method);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	const hasPrivateRegistrationOwner = weakMapOwners.some((name) => {
		const users = registrationUse.get(name);
		return users?.has("activateV3LivePlane") === true && users.has("routeV3Ingress");
	});
	const tokenOwners = weakMapOwners.filter((name) => {
		const calls = authorityCalls.get(name) ?? [];
		return (
			calls.filter(({ method, owner }) => method === "set" && owner === "prepareV3LiveGeneration").length === 1 &&
			calls.filter(({ method, owner }) => method === "get" && owner === "consumePreparedV3Live").length === 1 &&
			calls.filter(({ method, owner }) => method === "delete" && owner === "consumePreparedV3Live").length === 1
		);
	});
	const tokenCalls = tokenOwners.length === 1 ? (authorityCalls.get(tokenOwners[0] as string) ?? []) : [];
	const setsOnSuccessPath = tokenCalls.some(
		({ method, owner }) => method === "set" && owner === "prepareV3LiveGeneration"
	);
	const consumesByGetAndDelete =
		tokenCalls.some(({ method, owner }) => method === "get" && owner === "consumePreparedV3Live") &&
		tokenCalls.some(({ method, owner }) => method === "delete" && owner === "consumePreparedV3Live");
	return {
		privateWeakMapCount: weakMapOwners.length,
		hasPrivateRegistrationOwner,
		setsOnSuccessPath,
		consumesByGetAndDelete,
		seam3Topology: Object.freeze(seam3Topology.sort()),
		forbiddenFullBLiveEffects: Object.freeze(forbiddenFullBLiveEffects.sort()),
	};
}

beforeEach(() => {
	a_cProbe.authentications = 0;
	a_cProbe.admissions = 0;
	a_cProbe.protocolRuntimes = 0;
	a_cProbe.preservationFailureAt = undefined;
	a_cProbe.preservations.length = 0;
	a_cProbe.trustOpens.length = 0;
	a_cProbe.invocations.length = 0;
	a_cProbe.trustStoreCreations.length = 0;
	a_cProbe.trustOpenDepth = 0;
	a_cProbe.events.length = 0;
});

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe.sequential("Phase 3a-1A-c preservation, CAS/reopen and token RED", () => {
	it("uses named-field head semantics and kills missing, duplicate and extra raw evidence passes", () => {
		const objectId = must(parseStorageObjectId(`creator:${"d".repeat(32)}`));
		const expectedHead = Object.freeze({
			kind: "present" as const,
			objectId,
			generationId: must(parseGenerationId("1".repeat(64))),
			revision: must(parseHeadRevision(7)),
			closureDigest: must(parseClosureDigest("2".repeat(64))),
		});
		const reorderedHead = Object.freeze({
			revision: expectedHead.revision,
			closureDigest: expectedHead.closureDigest,
			objectId: expectedHead.objectId,
			kind: expectedHead.kind,
			generationId: expectedHead.generationId,
		});
		expect(JSON.stringify(reorderedHead)).not.toBe(JSON.stringify(expectedHead));
		expect(samePresentHead(reorderedHead, expectedHead)).toBe(true);
		for (const mutant of [
			{ ...reorderedHead, kind: "none" },
			{ ...reorderedHead, objectId: must(parseStorageObjectId(`creator:${"e".repeat(32)}`)) },
			{ ...reorderedHead, generationId: must(parseGenerationId("3".repeat(64))) },
			{ ...reorderedHead, revision: must(parseHeadRevision(expectedHead.revision + 1)) },
			{ ...reorderedHead, closureDigest: "4".repeat(64) },
		]) {
			expect(samePresentHead(mutant, expectedHead)).toBe(false);
		}

		const refs = Object.freeze([
			Object.freeze({ digest: "5".repeat(64) as BlobDigest, byteLength: 17 }),
			Object.freeze({ digest: "6".repeat(64) as BlobDigest, byteLength: 23 }),
		]);
		const recover = Object.freeze({ method: "recoverActiveGeneration" as const, input: objectId });
		const firstBlob = Object.freeze({ method: "getBlob" as const, input: refs[0]?.digest });
		const secondBlob = Object.freeze({ method: "getBlob" as const, input: refs[1]?.digest });
		const valid = Object.freeze([recover, firstBlob, secondBlob]);
		expect(hasExactRawEvidenceCallShape(valid, objectId, refs)).toBe(true);
		for (const mutant of [
			[],
			[firstBlob, secondBlob],
			[recover, recover, firstBlob, secondBlob],
			[recover, firstBlob],
			[recover, firstBlob, firstBlob, secondBlob],
			[recover, secondBlob, firstBlob],
			[recover, firstBlob, secondBlob, { method: "getBlob" as const, input: "7".repeat(64) }],
			[{ method: "readHead" as const, input: objectId }, recover, firstBlob, secondBlob],
			[
				{ method: "recoverActiveGeneration" as const, input: must(parseStorageObjectId(`creator:${"f".repeat(32)}`)) },
				firstBlob,
				secondBlob,
			],
		] as const) {
			expect(hasExactRawEvidenceCallShape(mutant, objectId, refs)).toBe(false);
		}
	});

	it("preserves detached complete candidates immediately before exact SQLite staging and binds the successful head", async () => {
		const context = await fixtureContext();
		const result = await prepare(context);
		expectSuccess(result);
		expectInvocationLedger(context, 0, { reopens: 2, preservations: 1, cas: 1 });
		expectInitialTrustOnlyReopen(context, 0);
		const expectedClosure = closureRefs(context);
		expect(a_cProbe.preservations).toHaveLength(1);
		const preservation = a_cProbe.preservations[0] as PreservationSnapshot;
		expect(preservation.closure).toEqual(expectedClosure);
		expect(preservation.expectedTrustRef).toEqual(context.trustRef);
		for (const ref of [
			preservation.expectedTrustRef,
			...preservation.closure,
			...preservation.candidates.map(({ ref }) => ref),
		]) {
			expect(Reflect.ownKeys(ref)).toEqual(["digest", "byteLength"]);
		}
		expect(
			preservation.candidates.map(({ ref }) => ref).sort((left, right) => left.digest.localeCompare(right.digest))
		).toEqual(expectedClosure);
		const projectionCandidate = preservation.candidates.find(({ ref }) => ref.digest === golden.projectionDigest);
		const trustCandidate = preservation.candidates.find(({ ref }) => ref.digest === context.trustRef.digest);
		expect(lowerHex(projectionCandidate?.bytes ?? new Uint8Array())).toBe(golden.projectionHex);
		expect(trustCandidate?.bytes.byteLength).toBe(context.trustRef.byteLength);
		for (const candidate of preservation.sourceCandidates) {
			expect(candidate.bytes.buffer).not.toBe(context.material.anchorBytes.buffer);
			expect(candidate.ref).not.toBe(context.trustRef);
		}
		const mutations = mutationCalls(context.calls);
		expect(mutations.map(({ method }) => method)).toEqual([
			"beginGeneration",
			"putCachedBlob",
			"promoteReference",
			"promoteReference",
			"completeGeneration",
			"swapHead",
		]);
		const begin = mutations[0]?.input as Parameters<AheDurableStore["beginGeneration"]>[0];
		const put = mutations[1]?.input as Parameters<AheDurableStore["putCachedBlob"]>[0];
		const promotes = mutations
			.slice(2, 4)
			.map(({ input }) => input as Parameters<AheDurableStore["promoteReference"]>[0]);
		expect(begin.baseExpectedHead).toEqual(context.initialHead);
		expect(begin.closure).toEqual(expectedClosure);
		expect(put.bytes).toEqual(bytesFromHex(golden.projectionHex));
		expect(put.digest).toBe(golden.projectionDigest);
		expect(promotes.map(({ digest }) => digest).sort()).toEqual(expectedClosure.map(({ digest }) => digest).sort());
		expect(result.descriptor.head).toEqual({
			...result.descriptor.head,
			kind: "present",
			objectId: context.input.objectId,
			generationId: begin.generationId,
			revision: context.initialHead.revision + 1,
			closureDigest: must(digestClosure(expectedClosure)),
		});
		expect(result.descriptor.projectionDigest).toBe(golden.projectionDigest);
		expect(result.descriptor.trustRef).toEqual(context.trustRef);
		expectExactSuccessfulStageOutputs(context, expectedClosure, result.descriptor.head);
		const swapCall = mutations.find(({ method }) => method === "swapHead");
		if (swapCall === undefined) throw new TypeError("missing successful swap evidence");
		expectDurableReloadAfter(context, swapCall.ordinal, result.descriptor.head, expectedClosure);
		const firstBeginEvent = a_cProbe.events.indexOf("store.beginGeneration");
		expect(a_cProbe.events[firstBeginEvent - 1]).toBe("trust.preserve");
		expect(a_cProbe.events).not.toContain("store.discardGeneration");
	});

	it("fails preservation before staging and keeps the complete two-ref candidate evidence detached", async () => {
		const context = await fixtureContext();
		a_cProbe.preservationFailureAt = 1;
		const result = await prepare(context);
		expectFailure(result, "trust-not-preserved");
		expectInvocationLedger(context, 0, { reopens: 1, preservations: 1, cas: 0 });
		expectInitialTrustOnlyReopen(context, 0);
		expect(a_cProbe.preservations).toHaveLength(1);
		expect(a_cProbe.preservations[0]?.closure).toEqual(closureRefs(context));
		expect(mutationCalls(context.calls)).toEqual([]);
	});

	it("classifies trust-only, exact two-ref restart and stale initial closures without insertion-order authority", async () => {
		const context = await fixtureContext();
		const first = await prepare(context);
		expectSuccess(first);
		expectInvocationLedger(context, 0, { reopens: 2, preservations: 1, cas: 1 });
		expectInitialTrustOnlyReopen(context, 0);
		const swapsAfterFirst = context.calls.filter(({ method }) => method === "swapHead").length;
		const restartBoundary = context.calls.at(-1)?.ordinal ?? -1;
		const second = await prepare(context);
		expectSuccess(second);
		expectInvocationLedger(context, 1, { reopens: 1, preservations: 0, cas: 0 });
		expect(second.capability).not.toBe(first.capability);
		expect(second.descriptor).toEqual(first.descriptor);
		expect(context.calls.filter(({ method }) => method === "swapHead")).toHaveLength(swapsAfterFirst);
		expect(a_cProbe.authentications).toBe(2);
		expect(a_cProbe.admissions).toBe(2);
		expect(a_cProbe.protocolRuntimes).toBe(2);
		expect(context.catalogResolutions.value).toBe(2);
		expectDurableReloadAfter(context, restartBoundary, second.descriptor.head, closureRefs(context));

		const stale = await fixtureContext();
		const alternate = await stageAlternateHead(stale);
		stale.calls.length = 0;
		stale.outcomes.length = 0;
		const staleInvocation = a_cProbe.invocations.length;
		const staleResult = await prepare(stale);
		expectFailure(staleResult, "stale-head");
		expectInvocationLedger(stale, staleInvocation, { reopens: 1, preservations: 0, cas: 0 });
		const staleReopen = aCTrustOpensForInvocation(staleInvocation)[0];
		expect(staleReopen).toBeDefined();
		if (staleReopen === undefined) throw new TypeError("missing stale initial reopen");
		expectLogicalReopen(stale, staleReopen, alternate.head, alternate.closure);
		expect(mutationCalls(stale.calls)).toEqual([]);
	});

	it("makes raw evidence bytes load-bearing before preservation or staging", async () => {
		for (const fault of ["wrong-length", "wrong-digest"] as const) {
			const context = await fixtureContext([], undefined, undefined, fault);
			const invocationIndex = a_cProbe.invocations.length;
			const result = await prepare(context);
			expectFailure(result, "storage-failed");
			expectInvocationLedger(context, invocationIndex, { reopens: 1, preservations: 0, cas: 0 });
			expect(a_cProbe.preservations).toEqual([]);
			expect(mutationCalls(context.calls)).toEqual([]);
			const invocation = a_cProbe.invocations[invocationIndex];
			const trustOpen = aCTrustOpensForInvocation(invocationIndex)[0];
			expect(invocation).toBeDefined();
			expect(trustOpen).toBeDefined();
			if (invocation === undefined || trustOpen === undefined) throw new TypeError("missing raw evidence window");
			const rawCalls = context.calls.filter(
				({ eventOrdinal }) => eventOrdinal > trustOpen.resolvedEventOrdinal && eventOrdinal < invocation.endEventOrdinal
			);
			expect(hasExactRawEvidenceCallShape(rawCalls, context.input.objectId, [context.trustRef])).toBe(true);
			const recoveryCall = rawCalls[0];
			const blobCall = rawCalls[1];
			if (recoveryCall === undefined || blobCall === undefined) throw new TypeError("incomplete raw evidence pass");
			const recovered = Reflect.get(outcomeFor(context, recoveryCall) as object, "value") as Record<string, unknown>;
			const recoveredRefs = Reflect.get(recovered, "references") as readonly GenerationRef[];
			expect(recoveredRefs).toHaveLength(1);
			expect(recoveredRefs[0]?.digest).toBe(context.trustRef.digest);
			expect(recoveredRefs[0]?.byteLength).toBe(context.trustRef.byteLength + (fault === "wrong-length" ? 1 : 0));
			const rawBytes = Reflect.get(outcomeFor(context, blobCall) as object, "value") as Uint8Array;
			expect(rawBytes.byteLength).toBe(context.trustRef.byteLength);
			expect(must(digestBlob(rawBytes)) === context.trustRef.digest).toBe(fault === "wrong-length");
		}
	});

	it("reopens an exact winner after definite or ambiguous swap outcomes and remints without a second CAS", async () => {
		for (const outcome of [headConflict(), ambiguousFailure()]) {
			const context = await fixtureContext([delegateThen(outcome)]);
			const invocationIndex = a_cProbe.invocations.length;
			const result = await prepare(context);
			expectSuccess(result);
			expectInvocationLedger(context, invocationIndex, { reopens: 2, preservations: 1, cas: 1 });
			expectInitialTrustOnlyReopen(context, invocationIndex);
			expect(context.calls.filter(({ method }) => method === "swapHead")).toHaveLength(1);
			expect(result.descriptor.head.revision).toBe(context.initialHead.revision + 1);
			const swapIndex = context.calls.findIndex(({ method }) => method === "swapHead");
			expect(context.calls.slice(swapIndex + 1).some(({ method }) => method === "readHead")).toBe(true);
			expect(context.calls.slice(swapIndex + 1).some(({ method }) => method === "recoverActiveGeneration")).toBe(true);
			const swapCall = context.calls[swapIndex] as CallRecord;
			expectDurableReloadAfter(context, swapCall.ordinal, result.descriptor.head, closureRefs(context));
		}
	});

	it("classifies a different durable winner after both definite and ambiguous reported outcomes", async () => {
		for (const reported of [headConflict(), ambiguousFailure()]) {
			const contextBox: { current?: FixtureContext } = {};
			let alternate: Awaited<ReturnType<typeof stageAlternateHead>> | undefined;
			const hook: SwapHook = async () => {
				if (contextBox.current === undefined) throw new TypeError("alternate-winner context is unavailable");
				alternate = await stageAlternateHead(contextBox.current);
				return reported;
			};
			const context = await fixtureContext([hook]);
			contextBox.current = context;
			const invocationIndex = a_cProbe.invocations.length;
			const result = await prepare(context);
			expectFailure(result, "stale-head");
			expectInvocationLedger(context, invocationIndex, { reopens: 2, preservations: 1, cas: 1 });
			expectInitialTrustOnlyReopen(context, invocationIndex);
			expect(alternate).toBeDefined();
			const swapCall = context.calls.find(({ method }) => method === "swapHead");
			if (swapCall === undefined || alternate === undefined) throw new TypeError("missing alternate-winner evidence");
			expectDurableReloadAfter(context, swapCall.ordinal, alternate.head, alternate.closure);
			expect(context.calls.filter(({ method }) => method === "swapHead")).toHaveLength(1);
		}
	});

	it("maps an ambiguous unchanged trust-only head to storage-failed only after mandatory reopen", async () => {
		const context = await fixtureContext([ambiguousWithoutWrite]);
		const result = await prepare(context);
		expectFailure(result, "storage-failed");
		expectInvocationLedger(context, 0, { reopens: 2, preservations: 1, cas: 1 });
		expectInitialTrustOnlyReopen(context, 0);
		const swapIndex = context.calls.findIndex(({ method }) => method === "swapHead");
		expect(swapIndex).toBeGreaterThan(-1);
		expect(context.calls.slice(swapIndex + 1).map(({ method }) => method)).toContain("readHead");
		expect(context.calls.filter(({ method }) => method === "swapHead")).toHaveLength(1);
		const swapCall = context.calls[swapIndex] as CallRecord;
		expectDurableReloadAfter(context, swapCall.ordinal, context.initialHead, [context.trustRef]);
	});

	it("permits one definite-loss retry with fresh trust evidence, generation and staging, then binds success", async () => {
		const context = await fixtureContext([conflictWithoutWrite]);
		const result = await prepare(context);
		expectSuccess(result);
		expectInvocationLedger(context, 0, { reopens: 3, preservations: 2, cas: 2 });
		expectInitialTrustOnlyReopen(context, 0);
		const begins = context.calls
			.filter(({ method }) => method === "beginGeneration")
			.map(({ input }) => input as Parameters<AheDurableStore["beginGeneration"]>[0]);
		expect(begins).toHaveLength(2);
		expect(begins[0]?.generationId).not.toBe(begins[1]?.generationId);
		expect(context.calls.filter(({ method }) => method === "swapHead")).toHaveLength(2);
		expect(a_cProbe.preservations).toHaveLength(2);
		const firstPreservation = a_cProbe.preservations[0] as PreservationSnapshot;
		const secondPreservation = a_cProbe.preservations[1] as PreservationSnapshot;
		expect(firstPreservation.sourceCandidates).not.toBe(secondPreservation.sourceCandidates);
		expect(firstPreservation.sourceClosure).not.toBe(secondPreservation.sourceClosure);
		expect(firstPreservation.sourceExpectedTrustRef).not.toBe(secondPreservation.sourceExpectedTrustRef);
		for (let index = 0; index < firstPreservation.sourceCandidates.length; index += 1) {
			expect(firstPreservation.sourceCandidates[index]?.bytes).not.toBe(
				secondPreservation.sourceCandidates[index]?.bytes
			);
			expect(firstPreservation.sourceCandidates[index]?.ref).not.toBe(secondPreservation.sourceCandidates[index]?.ref);
		}
		const beginEvents = a_cProbe.events.flatMap((event, index) => (event === "store.beginGeneration" ? [index] : []));
		expect(beginEvents).toHaveLength(2);
		for (const eventIndex of beginEvents) expect(a_cProbe.events[eventIndex - 1]).toBe("trust.preserve");
		const swaps = context.calls.filter(({ method }) => method === "swapHead");
		const firstReload = expectDurableReloadAfter(context, (swaps[0] as CallRecord).ordinal, context.initialHead, [
			context.trustRef,
		]);
		const secondBegin = context.calls.filter(({ method }) => method === "beginGeneration")[1] as CallRecord;
		expect(firstReload.lastOrdinal).toBeLessThan(secondBegin.ordinal);
		expect(firstReload.lastEventOrdinal).toBeLessThan(secondPreservation.eventOrdinal);
		expect(secondPreservation.eventOrdinal).toBeLessThan(secondBegin.eventOrdinal);
		expectDurableReloadAfter(context, (swaps[1] as CallRecord).ordinal, result.descriptor.head, closureRefs(context));
	});

	it("reruns preservation after the first definite loss and stops before a second attempt when it fails", async () => {
		const context = await fixtureContext([conflictWithoutWrite]);
		a_cProbe.preservationFailureAt = 2;
		const result = await prepare(context);
		expectFailure(result, "trust-not-preserved");
		expectInvocationLedger(context, 0, { reopens: 2, preservations: 2, cas: 1 });
		expectInitialTrustOnlyReopen(context, 0);
		expect(a_cProbe.preservations).toHaveLength(2);
		expect(context.calls.filter(({ method }) => method === "beginGeneration")).toHaveLength(1);
		const swaps = context.calls.filter(({ method }) => method === "swapHead");
		expect(swaps).toHaveLength(1);
		const reload = expectDurableReloadAfter(context, (swaps[0] as CallRecord).ordinal, context.initialHead, [
			context.trustRef,
		]);
		expect(reload.lastEventOrdinal).toBeLessThan((a_cProbe.preservations[1] as PreservationSnapshot).eventOrdinal);
	});

	it("maps a second definite loss to stale-head after two reopen and preservation cycles", async () => {
		const context = await fixtureContext([conflictWithoutWrite, conflictWithoutWrite]);
		const result = await prepare(context);
		expectFailure(result, "stale-head");
		expectInvocationLedger(context, 0, { reopens: 3, preservations: 2, cas: 2 });
		expectInitialTrustOnlyReopen(context, 0);
		expect(context.calls.filter(({ method }) => method === "swapHead")).toHaveLength(2);
		expect(a_cProbe.preservations).toHaveLength(2);
		const secondSwap = context.calls.map(({ method }) => method).lastIndexOf("swapHead");
		expect(context.calls.slice(secondSwap + 1).map(({ method }) => method)).toContain("readHead");
		const swaps = context.calls.filter(({ method }) => method === "swapHead");
		for (const swap of swaps) {
			expectDurableReloadAfter(context, swap.ordinal, context.initialHead, [context.trustRef]);
		}
	});

	it("contains every staging rejection and a thrown stage as storage-failed without a later authoritative call", async () => {
		for (const stageFailure of [
			{ method: "beginGeneration", throws: true },
			{ method: "putCachedBlob" },
			{ method: "promoteReference" },
			{ method: "completeGeneration" },
		] as const) {
			const context = await fixtureContext([], stageFailure);
			const invocationIndex = a_cProbe.invocations.length;
			const result = await prepare(context);
			expectFailure(result, "storage-failed");
			expectInvocationLedger(context, invocationIndex, { reopens: 1, preservations: 1, cas: 0 });
			expectInitialTrustOnlyReopen(context, invocationIndex);
			expect(a_cProbe.events).not.toContain("store.discardGeneration");
			const failedIndex = context.calls.findIndex(({ method }) => method === stageFailure.method);
			expect(context.calls.slice(failedIndex + 1).some(({ method }) => method === "swapHead")).toBe(false);
		}
	});

	it("rejects malformed successful stage values and classifies a malformed CAS value only through durable reopen", async () => {
		const recordFaults = [
			"wrong-state",
			"wrong-object",
			"wrong-generation",
			"wrong-base-head",
			"wrong-closure",
			"wrong-closure-digest",
		] as const;
		const mutations: StageSuccessMutation[] = [
			{ method: "beginGeneration", fault: "extra-key" },
			{ method: "putCachedBlob", fault: "extra-key" },
			{ method: "putCachedBlob", fault: "wrong-value" },
			{ method: "promoteReference", fault: "wrong-value" },
			{ method: "completeGeneration", fault: "extra-key" },
			...(["beginGeneration", "completeGeneration"] as const).flatMap((method) =>
				recordFaults.map((fault) => Object.freeze({ method, fault }))
			),
		];
		for (const mutation of mutations) {
			const context = await fixtureContext([], undefined, mutation);
			const invocationIndex = a_cProbe.invocations.length;
			const result = await prepare(context);
			expectFailure(result, "storage-failed");
			expectInvocationLedger(context, invocationIndex, { reopens: 1, preservations: 1, cas: 0 });
			expectInitialTrustOnlyReopen(context, invocationIndex);
			const malformedCall = context.calls.find((call) => call.method === mutation.method);
			if (malformedCall === undefined) throw new TypeError(`missing ${mutation.method} malformed-success evidence`);
			const malformedValue = Reflect.get(outcomeFor(context, malformedCall) as object, "value");
			if (mutation.fault === "extra-key") {
				expect(stringKeys(malformedValue)).toContain("unexpected");
			} else if (mutation.method === "putCachedBlob") {
				expect(Reflect.get(malformedValue as object, "inserted")).toBe("yes");
			} else if (mutation.method === "promoteReference") {
				expect(malformedValue).toBeNull();
			} else {
				const recordFault = mutation.fault as (typeof recordFaults)[number];
				const expected = Object.freeze({
					"wrong-state": mutation.method === "beginGeneration" ? "Complete" : "Staged",
					"wrong-object": "creator:wrong",
					"wrong-generation": "0".repeat(64),
					"wrong-base-head": null,
					"wrong-closure": Object.freeze([]),
					"wrong-closure-digest": "0".repeat(64),
				});
				const field = Object.freeze({
					"wrong-state": "state",
					"wrong-object": "objectId",
					"wrong-generation": "generationId",
					"wrong-base-head": "baseExpectedHead",
					"wrong-closure": "closure",
					"wrong-closure-digest": "closureDigest",
				});
				expect(Reflect.get(malformedValue as object, field[recordFault])).toEqual(expected[recordFault]);
			}
			const forbiddenLater = context.calls
				.filter(({ ordinal }) => ordinal > malformedCall.ordinal)
				.filter(({ method: later }) => A_C_MUTATION_METHODS.has(later));
			expect(forbiddenLater).toEqual([]);
		}

		for (const fault of ["extra-key", "wrong-head", "wrong-superseded"] as const) {
			const swapped = await fixtureContext([], undefined, { method: "swapHead", fault });
			const invocationIndex = a_cProbe.invocations.length;
			const result = await prepare(swapped);
			expectSuccess(result);
			expectInvocationLedger(swapped, invocationIndex, { reopens: 2, preservations: 1, cas: 1 });
			expectInitialTrustOnlyReopen(swapped, invocationIndex);
			const swapCall = swapped.calls.find(({ method }) => method === "swapHead");
			if (swapCall === undefined) throw new TypeError("missing malformed swap evidence");
			const malformedValue = Reflect.get(outcomeFor(swapped, swapCall) as object, "value") as Record<string, unknown>;
			if (fault === "extra-key") {
				expect(stringKeys(malformedValue)).toEqual(["head", "supersededGenerationId", "unexpected"]);
			} else {
				expect(stringKeys(malformedValue)).toEqual(["head", "supersededGenerationId"]);
			}
			if (fault === "wrong-head") expect(malformedValue.head).not.toEqual(result.descriptor.head);
			if (fault === "wrong-superseded") expect(malformedValue.supersededGenerationId).toBeNull();
			expect(result.descriptor.head.revision).toBe(swapped.initialHead.revision + 1);
			expectDurableReloadAfter(swapped, swapCall.ordinal, result.descriptor.head, closureRefs(swapped));
		}
	});

	it("mints a frozen opaque process-local token and a deeply frozen exact descriptor without authority leakage", async () => {
		const context = await fixtureContext();
		const result = await prepare(context);
		expectSuccess(result);
		expect(deepFrozen(result.capability)).toBe(true);
		expect(Reflect.ownKeys(result.capability)).toEqual([]);
		expect(JSON.stringify(result.capability)).toBe("{}");
		expect(deepFrozen(result.descriptor)).toBe(true);
		expect(Reflect.ownKeys(result.descriptor)).toEqual([
			"objectId",
			"epoch",
			"anchorDigest",
			"blueprintDigest",
			"parametersDigest",
			"profileDigest",
			"signerSetDigest",
			"artifactDigest",
			"artifactId",
			"catalogDigest",
			"runtimeProfile",
			"trustProfile",
			"trustRef",
			"maxEpochVertices",
			"maxEpochBytes",
			"maxDependencies",
			"vertexCount",
			"byteCharge",
			"projectionDigest",
			"head",
		]);
		expect(JSON.stringify(result)).not.toContain("canonicalBlueprintPackageBytes");
		expect(JSON.stringify(result)).not.toContain("exactArtifactBytes");
		expect(JSON.stringify(result)).not.toContain("detachedSignature");
		expect(Object.assign({}, result.capability)).not.toBe(result.capability);
	});

	it("registers each fresh token in the actual private WeakMap while forged, copied and serialized tokens have no authority", async () => {
		const context = await fixtureContext();
		const instances: Array<{
			readonly map: WeakMap<object, unknown>;
			readonly sets: Array<Readonly<{ readonly eventOrdinal: number; readonly key: object }>>;
		}> = [];
		class InstrumentedWeakMap<K extends object, V> extends IntrinsicWeakMap<K, V> {
			public readonly observedSets: Array<Readonly<{ readonly eventOrdinal: number; readonly key: object }>> = [];

			public constructor(entries?: readonly (readonly [K, V])[] | null) {
				super(entries);
				instances.push({ map: this as unknown as WeakMap<object, unknown>, sets: this.observedSets });
			}

			public override set(key: K, value: V): this {
				a_cProbe.events.push("token.set");
				this.observedSets.push(Object.freeze({ eventOrdinal: a_cProbe.events.length - 1, key }));
				return super.set(key, value);
			}
		}
		const weakMapDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WeakMap");
		if (weakMapDescriptor === undefined) throw new TypeError("missing intrinsic WeakMap descriptor");
		Object.defineProperty(globalThis, "WeakMap", { ...weakMapDescriptor, value: InstrumentedWeakMap });
		vi.resetModules();
		try {
			const surface = await privateSurface();
			if (surface.prepareV3LiveGeneration === undefined) throw new TypeError("missing private preparation API");
			const first = await invokePrepare(surface, context.input);
			expectSuccess(first);
			const owner = instances.find(({ sets }) => sets.some(({ key }) => key === first.capability));
			expect(owner, "private token owner").toBeDefined();
			if (owner === undefined) return;
			const firstSet = owner.sets.find(({ key }) => key === first.capability);
			const swapCall = context.calls.find(({ method }) => method === "swapHead");
			if (firstSet === undefined || swapCall === undefined) throw new TypeError("missing first token mint evidence");
			const firstReload = expectDurableReloadAfter(
				context,
				swapCall.ordinal,
				first.descriptor.head,
				closureRefs(context)
			);
			expect(firstReload.lastEventOrdinal).toBeLessThan(firstSet.eventOrdinal);
			const copied = Object.assign({}, first.capability);
			const serialized = JSON.parse(JSON.stringify(first.capability)) as object;
			const forged = Object.freeze({});
			for (const counterfeit of [copied, serialized, forged]) {
				expect(owner.map.has(counterfeit)).toBe(false);
				expect(owner.map.get(counterfeit)).toBeUndefined();
				expect(owner.map.delete(counterfeit)).toBe(false);
			}
			expect(owner.map.get(first.capability)).toBeDefined();

			const restartBoundary = context.calls.at(-1)?.ordinal ?? -1;
			const second = await invokePrepare(surface, context.input);
			expectSuccess(second);
			expect(second.capability).not.toBe(first.capability);
			const secondSet = owner.sets.find(({ key }) => key === second.capability);
			expect(secondSet).toBeDefined();
			const secondReload = expectDurableReloadAfter(
				context,
				restartBoundary,
				second.descriptor.head,
				closureRefs(context)
			);
			if (secondSet === undefined) throw new TypeError("missing second token mint evidence");
			expect(secondReload.lastEventOrdinal).toBeLessThan(secondSet.eventOrdinal);
			expect(owner.map.get(second.capability)).toBeDefined();
		} finally {
			Object.defineProperty(globalThis, "WeakMap", weakMapDescriptor);
			vi.resetModules();
		}
	});

	it("executes the exact private consumer and kills the delete-only reuse mutant without exposing a B seam", () => {
		const source = readFileSync(IMPLEMENTATION, "utf8");
		const evidence = extractedTokenConsumer(source);
		const token = Object.freeze({});
		const payload = Object.freeze({ authority: "sealed" });
		const owner = new IntrinsicWeakMap<object, unknown>([[token, payload]]);
		const consume = compileTokenConsumer(evidence, owner);
		expect(consume(Object.freeze({}))).toBeUndefined();
		expect(consume(token)).toBe(payload);
		expect(owner.has(token)).toBe(false);
		expect(consume(token)).toBeUndefined();

		const mutantOwner = new IntrinsicWeakMap<object, unknown>([[token, payload]]);
		const noDeleteMutant = compileTokenConsumer(evidence, mutantOwner, true);
		expect(noDeleteMutant(token)).toBe(payload);
		expect(mutantOwner.has(token)).toBe(true);
		expect(noDeleteMutant(token)).toBe(payload);
		for (const mutant of [
			`${source}\nexport { ${evidence.helperName} };`,
			`${source}\nconst escapedConsumer = ${evidence.helperName};\nexport { escapedConsumer };`,
			`${source}\nexport { ${evidence.ownerName} as preparedV3LiveAuthority };`,
			`${source}\nexport { ${evidence.registrationOwnerName} as v3LiveRegistrations };`,
		]) {
			expect(
				privateTokenExportEscapes(mutant, [evidence.ownerName, evidence.registrationOwnerName, evidence.helperName])
			).not.toEqual([]);
		}
	});

	it("keeps token and Seam-3 registration ownership private while allowing only the signed subscription/outbox topology", () => {
		const source = readFileSync(IMPLEMENTATION, "utf8");
		expect(tokenSourceAudit(source)).toEqual({
			privateWeakMapCount: 3,
			hasPrivateRegistrationOwner: true,
			setsOnSuccessPath: true,
			consumesByGetAndDelete: true,
			seam3Topology: ["outbox-mark", "queue-subscribe", "topic-subscribe"],
			forbiddenFullBLiveEffects: [],
		});
		for (const [name, mutant] of [
			["token owner", source.replace(/new\s+WeakMap/u, "new Map")],
			["token consume", source.replace(/\.delete\(/u, ".has(")],
			["queue owner", source.replace("messageQueueManager.subscribe(queueId, handler)", "subscribe(queueId, handler)")],
			["topic owner", source.replace("boundNetworkNode.subscribe(topic)", "subscribe(topic)")],
			[
				"outbox owner",
				source.replace("registration.issuanceStore.compareAndMarkOutboxPublished", "compareAndMarkOutboxPublished"),
			],
			["parallel owner", `${source}\nconst parallelRegistrationOwner = new WeakMap();`],
			[
				"dead topology",
				`${source}\nfunction deadSubscriptionDecoy() { messageQueueManager.subscribe(queueId, handler); }`,
			],
			["append", `${source}\nappend();`],
			["discard", `${source}\ndiscardGeneration();`],
		] as const) {
			expect(tokenSourceAudit(mutant), name).not.toEqual(tokenSourceAudit(source));
		}
	});

	it("fails closed on the exact memory-store ephemeral capability even when valid trust is already installed", async () => {
		const durable = await fixtureContext();
		const trustBlob = await durable.rawStore.getBlob(durable.trustRef.digest);
		if (!trustBlob.ok || trustBlob.value === null) throw new TypeError("missing genuinely installed trust bytes");
		const rawMemory = createMemoryAheDurableStore();
		const ephemeralCapabilities = rawMemory.capabilities;
		expect(ephemeralCapabilities).toEqual({ durability: "ephemeral", signingEligibility: "never" });
		await rawMemory.close();
		const material = durable.material;
		const counter = { value: 0 };
		const calls: CallRecord[] = [];
		const outcomes: OutcomeRecord[] = [];
		const memory = observedStore(durable.rawStore, calls, outcomes, [], undefined, undefined, ephemeralCapabilities);
		const input: PrepareInput = Object.freeze({
			authenticationProfile: "creator-only",
			store: memory,
			objectId: must(parseStorageObjectId(String(material.anchor.objectId))),
			pinnedGenesisAnchorDigest: material.anchorDigest,
			exactCanonicalAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
			detachedSignature: new Uint8Array(material.signature),
			exactCanonicalParametersCarrierBytes: encodeCanonical(PARAMETERS),
			catalog: catalog(counter),
		});
		const surface = await privateSurface();
		if (surface.prepareV3LiveGeneration === undefined) throw new TypeError("missing private preparation API");
		const result = await invokePrepare(surface, input);
		expectFailure(result, "trust-open-failed");
		expect(await durable.rawStore.getBlob(durable.trustRef.digest)).toEqual({ ok: true, value: trustBlob.value });
		expect(a_cProbe.preservations).toEqual([]);
		expect(counter.value).toBe(0);
		expect(mutationCalls(calls)).toEqual([]);
		expect(calls.map(({ method }) => method)).not.toContain("discardGeneration");
	});
});
