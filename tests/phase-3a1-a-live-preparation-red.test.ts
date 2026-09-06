import { ed25519 } from "@noble/curves/ed25519.js";
import { type decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type assertTrustPreserved, type createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import {
	type authenticateCurrentEpochAnchor,
	installCreatorAnchorTrustRoot,
	type openCurrentAnchorTrust,
	type prepareBlueprintAdmission,
	type prepareBlueprintRuntime,
} from "@ts-drp/protocol-v3";
import {
	type AheDurableStore,
	createMemoryAheDurableStore,
	digestBlob,
	digestClosure,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type StorageObjectId,
} from "@ts-drp/storage";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	bytesHex,
	contract,
	type CreatorMaterial,
	hexBytes,
	independentHashDomain,
	makeCreatorMaterial,
} from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import packageGolden from "./fixtures/track-p2-b/forward-counter-package.json" with { type: "json" };
import { type TrustedBlueprintCatalog } from "../packages/blueprint-catalog/src/index.js";
import type { CausalityIndex } from "../packages/compaction/src/index.js";

type CanonicalModule = Readonly<{
	decodeCanonical: typeof decodeCanonical;
	encodeCanonical: typeof encodeCanonical;
	hashDomain: typeof hashDomain;
}> &
	Record<string, unknown>;
type CompactionModule = Readonly<{
	CausalityIndex: typeof CausalityIndex;
}> &
	Record<string, unknown>;
type ControlPlaneModule = Readonly<{
	assertTrustPreserved: typeof assertTrustPreserved;
	createCurrentAnchorTrustStore: typeof createCurrentAnchorTrustStore;
}> &
	Record<string, unknown>;
type ProtocolV3Module = Readonly<{
	authenticateCurrentEpochAnchor: typeof authenticateCurrentEpochAnchor;
	openCurrentAnchorTrust: typeof openCurrentAnchorTrust;
	prepareBlueprintAdmission: typeof prepareBlueprintAdmission;
	prepareBlueprintRuntime: typeof prepareBlueprintRuntime;
}> &
	Record<string, unknown>;

const stageProbe = vi.hoisted(() => ({
	admissionOutputMismatch: false,
	admissionInputs: [] as unknown[],
	admissionInputCopies: [] as unknown[],
	admissionResults: [] as unknown[],
	authenticationInputs: [] as unknown[],
	authenticationInputCopies: [] as unknown[],
	authenticationResults: [] as unknown[],
	catalogResults: [] as unknown[],
	catalogRequests: [] as string[],
	events: [] as string[],
	expectedAnchorHex: undefined as string | undefined,
	expectedParameterHex: undefined as string | undefined,
	authenticationHashDepth: 0,
	authenticationHashInputs: [] as readonly Uint8Array[][],
	trustOpenHashDepth: 0,
	trustOpenHashInputs: [] as readonly Uint8Array[][],
	anchorHashInputs: [] as readonly Uint8Array[][],
	anchorHashMismatch: false,
	graphValidationFailure: false,
	graphValidationInputs: [] as unknown[][],
	liveEffects: [] as string[],
	openRecordInputs: [] as unknown[],
	openRecordInputCopies: [] as unknown[],
	openRecordResults: [] as unknown[],
	parameterDecodeInputs: [] as Uint8Array[],
	parameterDecodeInputCopies: [] as Uint8Array[],
	parameterEncodeOutputs: [] as Uint8Array[],
	parameterEncodeOutputCopies: [] as Uint8Array[],
	parameterHashInputs: [] as readonly Uint8Array[][],
	parameterHashInputCopies: [] as readonly Uint8Array[][],
	preservationFailure: false,
	preservationInputs: [] as unknown[],
	preservationResults: [] as unknown[],
	prepareInputs: [] as unknown[],
	runtimeInputs: [] as unknown[],
	runtimeInputCopies: [] as unknown[],
	runtimeOutputMismatch: undefined as
		| "artifactDigest"
		| "artifactId"
		| "blueprintDigest"
		| "runtimeProfile"
		| undefined,
	runtimeResults: [] as unknown[],
	trustFactoryInputs: [] as unknown[],
	trustOpenResults: [] as unknown[],
}));

vi.mock("@ts-drp/compaction", async (importOriginal) => {
	const genuine = await importOriginal<CompactionModule>();
	return {
		...genuine,
		CausalityIndex: class InstrumentedCausalityIndex extends genuine.CausalityIndex {
			constructor(...input: ConstructorParameters<typeof genuine.CausalityIndex>) {
				stageProbe.events.push("graph.validate");
				stageProbe.graphValidationInputs.push(input);
				if (stageProbe.graphValidationFailure) {
					super(input[0], [], input[2]);
					throw new TypeError("genuine CausalityIndex accepted an incomplete order");
				}
				super(...input);
			}
		},
	};
});

vi.mock("@ts-drp/canonical", async (importOriginal) => {
	const genuine = await importOriginal<CanonicalModule>();
	const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	const isExpectedAnchor = (bytes: Uint8Array): boolean =>
		stageProbe.expectedAnchorHex !== undefined && hex(bytes) === stageProbe.expectedAnchorHex;
	const isExpectedParameters = (bytes: Uint8Array): boolean =>
		stageProbe.expectedParameterHex !== undefined && hex(bytes) === stageProbe.expectedParameterHex;
	return {
		...genuine,
		decodeCanonical(bytes: Uint8Array): unknown {
			if (isExpectedParameters(bytes)) {
				stageProbe.events.push("parameters.decode");
				stageProbe.parameterDecodeInputs.push(bytes);
				stageProbe.parameterDecodeInputCopies.push(new Uint8Array(bytes));
			}
			return genuine.decodeCanonical(bytes);
		},
		encodeCanonical(value: unknown): Uint8Array {
			const bytes = genuine.encodeCanonical(value);
			if (isExpectedParameters(bytes) && stageProbe.events.includes("parameters.decode")) {
				stageProbe.events.push("parameters.encode");
				stageProbe.parameterEncodeOutputs.push(bytes);
				stageProbe.parameterEncodeOutputCopies.push(new Uint8Array(bytes));
			}
			return bytes;
		},
		hashDomain(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
			if (domain === "ts-drp/epoch-anchor/v3" && parts.length === 1 && isExpectedAnchor(parts[0] as Uint8Array)) {
				const context =
					stageProbe.trustOpenHashDepth > 0
						? "trust-open"
						: stageProbe.authenticationHashDepth > 0
							? "authentication"
							: "independent";
				stageProbe.events.push(
					context === "trust-open"
						? "trust.open.hash"
						: context === "authentication"
							? "anchor.authenticate.hash"
							: "anchor.hash"
				);
				(context === "trust-open"
					? stageProbe.trustOpenHashInputs
					: context === "authentication"
						? stageProbe.authenticationHashInputs
						: stageProbe.anchorHashInputs
				).push(parts);
				const digest = genuine.hashDomain(domain, ...parts);
				if (context === "independent" && stageProbe.anchorHashMismatch) {
					const mismatched = new Uint8Array(digest);
					mismatched[0] = (mismatched[0] as number) ^ 0xff;
					return mismatched;
				}
				return digest;
			}
			if (domain === "ts-drp/parameters/v3" && parts.length === 1 && isExpectedParameters(parts[0] as Uint8Array)) {
				stageProbe.events.push("parameters.hash");
				stageProbe.parameterHashInputs.push(parts);
				stageProbe.parameterHashInputCopies.push(parts.map((part) => new Uint8Array(part)));
			}
			return genuine.hashDomain(domain, ...parts);
		},
	};
});

vi.mock("@ts-drp/protocol-v3", async (importOriginal) => {
	const genuine = await importOriginal<ProtocolV3Module>();
	return {
		...genuine,
		authenticateCurrentEpochAnchor(
			input: Parameters<ProtocolV3Module["authenticateCurrentEpochAnchor"]>[0]
		): ReturnType<ProtocolV3Module["authenticateCurrentEpochAnchor"]> {
			stageProbe.events.push("anchor.authenticate");
			stageProbe.authenticationInputs.push(input);
			stageProbe.authenticationInputCopies.push({
				detachedSignature: new Uint8Array(input.detachedSignature),
				exactCanonicalAnchorPreimageBytes: new Uint8Array(input.exactCanonicalAnchorPreimageBytes),
				trust: input.trust,
			});
			stageProbe.authenticationHashDepth += 1;
			let result: ReturnType<ProtocolV3Module["authenticateCurrentEpochAnchor"]>;
			try {
				result = genuine.authenticateCurrentEpochAnchor(input);
			} finally {
				stageProbe.authenticationHashDepth -= 1;
			}
			stageProbe.authenticationResults.push(result);
			return result;
		},
		openCurrentAnchorTrust(
			input: Parameters<ProtocolV3Module["openCurrentAnchorTrust"]>[0]
		): ReturnType<ProtocolV3Module["openCurrentAnchorTrust"]> {
			stageProbe.events.push("trust.record.open");
			stageProbe.openRecordInputs.push(input);
			stageProbe.openRecordInputCopies.push({
				exactCanonicalTrustStateRecordBytes: new Uint8Array(input.exactCanonicalTrustStateRecordBytes),
				expectedObjectId: input.expectedObjectId,
				pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
			});
			const result = genuine.openCurrentAnchorTrust(input);
			stageProbe.openRecordResults.push(result);
			return result;
		},
		prepareBlueprintAdmission(
			input: Parameters<ProtocolV3Module["prepareBlueprintAdmission"]>[0]
		): ReturnType<ProtocolV3Module["prepareBlueprintAdmission"]> {
			stageProbe.events.push("blueprint.admission");
			stageProbe.admissionInputs.push(input);
			stageProbe.admissionInputCopies.push({
				canonicalBlueprintPackageBytes: new Uint8Array(input.canonicalBlueprintPackageBytes),
				expectedBlueprintDigest: input.expectedBlueprintDigest,
			});
			const result = genuine.prepareBlueprintAdmission(input);
			const returned = stageProbe.admissionOutputMismatch
				? Object.freeze({ ...result, blueprintDigest: "f".repeat(64) })
				: result;
			stageProbe.admissionResults.push(returned);
			return returned as ReturnType<ProtocolV3Module["prepareBlueprintAdmission"]>;
		},
		async prepareBlueprintRuntime(
			input: Parameters<ProtocolV3Module["prepareBlueprintRuntime"]>[0]
		): Promise<Awaited<ReturnType<ProtocolV3Module["prepareBlueprintRuntime"]>>> {
			stageProbe.events.push("blueprint.runtime:start");
			stageProbe.runtimeInputs.push(input);
			stageProbe.runtimeInputCopies.push({
				canonicalBlueprintPackageBytes: new Uint8Array(input.canonicalBlueprintPackageBytes),
				exactArtifactBytes: new Uint8Array(input.exactArtifactBytes),
				expectedBlueprintDigest: input.expectedBlueprintDigest,
				preparedBlueprintAdmission: input.preparedBlueprintAdmission,
			});
			const result = await genuine.prepareBlueprintRuntime(input);
			stageProbe.events.push("blueprint.runtime:resolved");
			const mismatch = stageProbe.runtimeOutputMismatch;
			const returned =
				mismatch === undefined
					? result
					: Object.freeze({
							...result,
							[mismatch]: mismatch === "runtimeProfile" ? "unsupported-runtime" : "f".repeat(64),
						});
			stageProbe.runtimeResults.push(returned);
			return returned as Awaited<ReturnType<ProtocolV3Module["prepareBlueprintRuntime"]>>;
		},
	};
});

vi.mock("@ts-drp/control-plane", async (importOriginal) => {
	const genuine = await importOriginal<ControlPlaneModule>();
	return {
		...genuine,
		assertTrustPreserved(
			input: Parameters<ControlPlaneModule["assertTrustPreserved"]>[0]
		): ReturnType<ControlPlaneModule["assertTrustPreserved"]> {
			stageProbe.events.push("trust.preserve");
			stageProbe.preservationInputs.push(input);
			const result = genuine.assertTrustPreserved(
				stageProbe.preservationFailure ? { ...input, candidates: Object.freeze([]) } : input
			);
			stageProbe.preservationResults.push(result);
			return result;
		},
		createCurrentAnchorTrustStore(
			options: Parameters<ControlPlaneModule["createCurrentAnchorTrustStore"]>[0]
		): ReturnType<ControlPlaneModule["createCurrentAnchorTrustStore"]> {
			stageProbe.events.push("trust.create");
			stageProbe.trustFactoryInputs.push(options);
			const owner = genuine.createCurrentAnchorTrustStore(options);
			const result = Object.freeze({
				...owner,
				async open(): ReturnType<typeof owner.open> {
					stageProbe.events.push("trust.open:start");
					stageProbe.trustOpenHashDepth += 1;
					let result: Awaited<ReturnType<typeof owner.open>>;
					try {
						result = await owner.open();
					} finally {
						stageProbe.trustOpenHashDepth -= 1;
					}
					stageProbe.events.push("trust.open:resolved");
					stageProbe.trustOpenResults.push(result);
					return result;
				},
			});
			return result;
		},
	};
});

type PrepareV3LiveFailureKind =
	| "malformed-input"
	| "trust-open-failed"
	| "anchor-authentication-failed"
	| "parameters-rejected"
	| "blueprint-unresolved"
	| "admission-rejected"
	| "runtime-preparation-failed"
	| "graph-rejected"
	| "trust-not-preserved"
	| "stale-head"
	| "storage-failed"
	| "internal-invariant";

interface PrepareV3LiveInput {
	readonly authenticationProfile: "creator-only";
	readonly store: AheDurableStore;
	readonly objectId: StorageObjectId;
	readonly pinnedGenesisAnchorDigest: string;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly detachedSignature: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly catalog: TrustedBlueprintCatalog;
}

type PrepareV3LiveResult =
	| Readonly<{ readonly ok: true; readonly capability: unknown; readonly descriptor: unknown }>
	| Readonly<{ readonly ok: false; readonly kind: PrepareV3LiveFailureKind; readonly detail: string }>;

interface V3LiveModule {
	prepareV3LiveGeneration?(input: PrepareV3LiveInput): Promise<PrepareV3LiveResult>;
}

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const IMPLEMENTATION = path.join(REPOSITORY_ROOT, "packages/node/src/v3-live.ts");
const PARAMETER_SOURCE = path.join(REPOSITORY_ROOT, "packages/protocol-v2/src/registry.ts");
const PARAMETER_REGISTRY = path.join(REPOSITORY_ROOT, "packages/protocol-v3/registry/registry-v1.json");
const FIXTURE_ARTIFACT = path.join(REPOSITORY_ROOT, "tests/fixtures/track-p2-c/primary.mjs");
const LIVE_EFFECT_KEY = "__tsDrpPhase3a1aLiveEffect";
const temporaryDirectories: string[] = [];
const FAILURE_KINDS = [
	"malformed-input",
	"trust-open-failed",
	"anchor-authentication-failed",
	"parameters-rejected",
	"blueprint-unresolved",
	"admission-rejected",
	"runtime-preparation-failed",
	"graph-rejected",
	"trust-not-preserved",
	"stale-head",
	"storage-failed",
	"internal-invariant",
] as const;
const NODE_ROOT_EXPORTS = [
	"DRPIntervalSync",
	"DRPNode",
	"INITIAL_SYNC_RETRY_INTERVAL_MS",
	"NostrRendezvousConfigurationError",
	"createConfiguredRendezvousRegistries",
	"createDRPIntervalSync",
] as const;
const NODE_RUNTIME_EXPORTS = [
	"NodeRoutingRestartUnsupportedError",
	"PublicNetworkAcknowledgementError",
	"createNodeRuntime",
	"resolveNodeRoutingRuntimeConfig",
] as const;
const PROTOCOL_V3_RUNTIME_EXPORTS = [
	"ANCHOR_TRUST_STATE_MAX_RECORD_BYTES",
	"admitReceivedVertex",
	"authenticateCurrentEpochAnchor",
	"createAdmissionBoundTransactionalVertexIssuer",
	"extractAdmittedReceivedVertex",
	"installCertifiedAnchorTrustRoot",
	"installCreatorAnchorTrustRoot",
	"isAnchorTrustStateRecordBytes",
	"openCertifiedAnchorTrust",
	"openCurrentAnchorTrust",
	"prepareBlueprintAdmission",
	"prepareBlueprintRuntime",
] as const;
const DRP_NODE_PROTOTYPE = [
	"_addRoomRendezvousProducer",
	"_backfillRoomRendezvousProducers",
	"_connectObjectCreator",
	"_createDefaultControlPlaneMechanisms",
	"_createIntervalDiscovery",
	"_createIntervalSync",
	"_createObjectIntervals",
	"_createRendezvousCache",
	"_emitRendezvousEvent",
	"_readControlPlaneHealth",
	"_refreshAuthenticatedDrpPeers",
	"_registerRendezvousRecord",
	"_registerRendezvousRecords",
	"_registerRoomRendezvousRecord",
	"_startControlPlaneRecovery",
	"_startRendezvous",
	"_stopObjectIntervals",
	"_warmRendezvous",
	"addCustomGroup",
	"buildSyncPayloadForProtocol",
	"buildSyncResponseChunks",
	"connectObject",
	"constructor",
	"createObject",
	"dispatchMessage",
	"get",
	"getReconnectInterval",
	"handleDiscoveryResponse",
	"handleGroupPeerChange",
	"put",
	"rendezvous",
	"rendezvousCache",
	"restart",
	"restoreSubscriptions",
	"routing",
	"sendCustomMessage",
	"sendGroupMessage",
	"sendNegotiatedSync",
	"sendNegotiatedSyncResponse",
	"start",
	"stop",
	"subscribe",
	"subscribeObject",
	"syncObject",
	"unsubscribeObject",
] as const;

function resetStageProbe(): void {
	for (const value of Object.values(stageProbe)) {
		if (Array.isArray(value)) value.length = 0;
	}
	stageProbe.admissionOutputMismatch = false;
	stageProbe.authenticationHashDepth = 0;
	stageProbe.trustOpenHashDepth = 0;
	stageProbe.anchorHashMismatch = false;
	stageProbe.graphValidationFailure = false;
	stageProbe.preservationFailure = false;
	stageProbe.expectedAnchorHex = undefined;
	stageProbe.expectedParameterHex = undefined;
	stageProbe.runtimeOutputMismatch = undefined;
	Reflect.set(globalThis, LIVE_EFFECT_KEY, (name: string): void => {
		stageProbe.liveEffects.push(name);
	});
}

const liveEffectRestorers: (() => void)[] = [];

function guardCallable(owner: object, name: PropertyKey, label: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(owner, name);
	if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") return;
	Object.defineProperty(owner, name, {
		...descriptor,
		value: (..._args: readonly unknown[]): never => {
			stageProbe.liveEffects.push(label);
			throw new Error(`forbidden A-a live effect: ${label}`);
		},
	});
	liveEffectRestorers.push(() => Object.defineProperty(owner, name, descriptor));
}

function installLiveEffectGuards(): void {
	for (const name of ["fetch", "queueMicrotask", "setInterval", "setTimeout", "WebSocket"] as const) {
		guardCallable(globalThis, name, `global:${name}`);
	}
	if (typeof EventTarget === "function")
		guardCallable(EventTarget.prototype, "addEventListener", "event:addEventListener");
}

beforeEach(() => {
	resetStageProbe();
	installLiveEffectGuards();
});

afterEach(() => {
	for (const restore of liveEffectRestorers.splice(0).reverse()) restore();
});

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new TypeError("test fixture identity is invalid");
	return result.value;
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface BlueprintFixture {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly exactArtifactBytes: Uint8Array;
}

let cachedBlueprintFixture: BlueprintFixture | undefined;

function blueprintFixture(): BlueprintFixture {
	if (cachedBlueprintFixture !== undefined) return cachedBlueprintFixture;
	const instrument = (name: string): string => `globalThis.${LIVE_EFFECT_KEY}?.(${JSON.stringify(`reducer:${name}`)});`;
	const source = readFileSync(FIXTURE_ARTIFACT, "utf8")
		.replace("function addReducer(input) {", `function addReducer(input) { ${instrument("add")}`)
		.replace("function readReducer(input) {", `function readReducer(input) { ${instrument("read-value")}`)
		.replace("function setReducer(input) {", `function setReducer(input) { ${instrument("set")}`);
	const exactArtifactBytes = new TextEncoder().encode(source);
	const artifactDigest = lowerHex(hashDomain(packageGolden.artifactDigestDomain, exactArtifactBytes));
	const packageRecord = Object.freeze({
		...packageGolden.package,
		implementation: Object.freeze({ ...packageGolden.package.implementation, artifactDigest }),
	});
	const canonicalBlueprintPackageBytes = encodeCanonical(packageRecord);
	const blueprintDigest = lowerHex(hashDomain(packageGolden.blueprintDigestDomain, canonicalBlueprintPackageBytes));
	cachedBlueprintFixture = Object.freeze({
		artifactDigest,
		artifactId: packageRecord.implementation.artifactId,
		blueprintDigest,
		canonicalBlueprintPackageBytes,
		exactArtifactBytes,
	});
	return cachedBlueprintFixture;
}

function canonicalParameters(): Readonly<Record<string, number>> {
	const source = readFileSync(PARAMETER_SOURCE, "utf8");
	const match = /const defaultParameters = Object\.freeze\(\{(?<body>[\s\S]*?)\}\);/u.exec(source);
	if (match?.groups?.body === undefined) throw new TypeError("Phase-0p defaultParameters source is missing");
	const fields = Object.fromEntries(
		[...match.groups.body.matchAll(/(?<key>[A-Za-z][A-Za-z0-9]*):\s*(?<expression>[^,\n]+),?/gu)].map(({ groups }) => {
			if (groups?.key === undefined || groups.expression === undefined) throw new TypeError("invalid parameter source");
			const factors = groups.expression.split("*").map((part) => Number(part.trim()));
			if (factors.some((factor) => !Number.isSafeInteger(factor))) throw new TypeError("invalid parameter expression");
			return [groups.key, factors.reduce((product, factor) => product * factor, 1)];
		})
	);
	return Object.freeze(fields);
}

function parameterDigest(parameters = canonicalParameters()): string {
	const registry = JSON.parse(readFileSync(PARAMETER_REGISTRY, "utf8")) as {
		readonly kinds: Readonly<Record<string, { readonly domain: string }>>;
	};
	const domain = registry.kinds.parameters?.domain;
	if (domain !== "ts-drp/parameters/v3") throw new TypeError("unexpected parameter registry domain");
	return lowerHex(hashDomain(domain, encodeCanonical(parameters)));
}

type CatalogMutation =
	| "none"
	| "admission-output"
	| "admission-package"
	| "catalog-blueprint"
	| "catalog-runtime-profile"
	| "runtime-artifact"
	| "runtime-output-artifact-digest"
	| "runtime-output-artifact-id"
	| "runtime-output-blueprint-digest"
	| "runtime-output-profile"
	| "shared-ordinary-backing"
	| "throw";

function temporaryCatalog(mutation: CatalogMutation = "none"): TrustedBlueprintCatalog {
	stageProbe.admissionOutputMismatch = mutation === "admission-output";
	stageProbe.runtimeOutputMismatch =
		mutation === "runtime-output-artifact-digest"
			? "artifactDigest"
			: mutation === "runtime-output-artifact-id"
				? "artifactId"
				: mutation === "runtime-output-blueprint-digest"
					? "blueprintDigest"
					: mutation === "runtime-output-profile"
						? "runtimeProfile"
						: undefined;
	const fixture = blueprintFixture();
	const blueprintDigest = fixture.blueprintDigest;
	const exactArtifactBytes = fixture.exactArtifactBytes;
	const canonicalBlueprintPackageBytes = fixture.canonicalBlueprintPackageBytes;
	const catalogDigest = "9".repeat(64);
	return Object.freeze({
		blueprintDigests: Object.freeze([blueprintDigest]),
		catalogDigest,
		resolve(requested: string) {
			stageProbe.events.push("catalog.resolve");
			stageProbe.catalogRequests.push(requested);
			if (mutation === "throw") throw new Error("synthetic private catalog failure");
			if (requested !== blueprintDigest) throw new TypeError("not catalogued");
			let resolvedPackageBytes =
				mutation === "admission-package"
					? new Uint8Array([...canonicalBlueprintPackageBytes, 0])
					: new Uint8Array(canonicalBlueprintPackageBytes);
			let resolvedArtifactBytes =
				mutation === "runtime-artifact"
					? new Uint8Array([...exactArtifactBytes, 0x0a])
					: new Uint8Array(exactArtifactBytes);
			if (mutation === "shared-ordinary-backing") {
				const shared = new ArrayBuffer(canonicalBlueprintPackageBytes.byteLength + exactArtifactBytes.byteLength);
				resolvedPackageBytes = new Uint8Array(shared, 0, canonicalBlueprintPackageBytes.byteLength);
				resolvedArtifactBytes = new Uint8Array(
					shared,
					canonicalBlueprintPackageBytes.byteLength,
					exactArtifactBytes.byteLength
				);
				resolvedPackageBytes.set(canonicalBlueprintPackageBytes);
				resolvedArtifactBytes.set(exactArtifactBytes);
			}
			const result = Object.freeze({
				artifactDigest: fixture.artifactDigest,
				artifactId: fixture.artifactId,
				blueprintDigest: mutation === "catalog-blueprint" ? "f".repeat(64) : blueprintDigest,
				canonicalBlueprintPackageBytes: resolvedPackageBytes,
				exactArtifactBytes: resolvedArtifactBytes,
				runtimeProfile:
					mutation === "catalog-runtime-profile" ? ("unsupported-runtime" as never) : "ecmascript-2024-sync-v1",
				evidence: Object.freeze({
					catalogDigest,
					lintEvidenceDigest: "a".repeat(64),
					conformanceReceiptDigest: "b".repeat(64),
					conformanceDigest: "c".repeat(64),
					conformanceTier: "nightly" as const,
					conformanceResult: "passed" as const,
					engines: Object.freeze(
						(["node", "chromium", "firefox", "webkit"] as const).map((name) =>
							Object.freeze({ name, build: `phase-3a1-a-${name}` })
						)
					),
				}),
			});
			stageProbe.catalogResults.push(result);
			return result;
		},
	});
}

function liveMaterial(): CreatorMaterial {
	const base = makeCreatorMaterial({ objectId: "creator:" + "a".repeat(32) });
	const anchor = Object.freeze({
		...base.anchor,
		blueprintDigest: blueprintFixture().blueprintDigest,
		parametersDigest: parameterDigest(),
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

async function moduleSurface(): Promise<V3LiveModule> {
	if (!existsSync(IMPLEMENTATION)) return {};
	try {
		return (await import(`${pathToFileURL(IMPLEMENTATION).href}?phase-3a1-a`)) as V3LiveModule;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return {};
		throw error;
	}
}

interface FirstAwaitGate {
	readonly entered: Promise<void>;
	markEntered(): void;
	readonly released: Promise<void>;
	release(): void;
}

function firstAwaitGate(): FirstAwaitGate {
	let markEntered!: () => void;
	let release!: () => void;
	return {
		entered: new Promise<void>((resolve) => {
			markEntered = resolve;
		}),
		markEntered,
		released: new Promise<void>((resolve) => {
			release = resolve;
		}),
		release,
	};
}

function instrumentedStore(material = liveMaterial(), gate?: FirstAwaitGate): AheDurableStore {
	const installed = installCreatorAnchorTrustRoot({
		detachedGenesisSignature: material.signature,
		exactCanonicalGenesisAnchorPreimageBytes: material.anchorBytes,
		exactCanonicalProfileBytes: material.profileBytes,
		exactCanonicalSignerSetBytes: material.signerSetBytes,
		pinnedGenesisAnchorDigest: material.anchorDigest,
	});
	if (!installed.ok) throw new TypeError(`invalid creator fixture: ${installed.reason}`);
	const trustStateBytes = installed.exactCanonicalTrustStateRecordBytes;
	const digest = must(digestBlob(trustStateBytes));
	const ref = Object.freeze({ byteLength: trustStateBytes.byteLength, digest });
	const objectId = must(parseStorageObjectId(String(material.anchor.objectId)));
	const generationId = must(parseGenerationId("a".repeat(64)));
	const closureDigest = must(digestClosure([ref]));
	const revision = must(parseHeadRevision(1));
	const baseExpectedHead = Object.freeze({ kind: "none" as const, objectId });
	const head = Object.freeze({ kind: "present" as const, closureDigest, generationId, objectId, revision });
	const target = createMemoryAheDurableStore();
	const facade: AheDurableStore = Object.freeze({
		capabilities: Object.freeze({ durability: "strict", signingEligibility: "backend-capability-required" }),
		async readHead() {
			stageProbe.events.push("store.readHead");
			if (gate !== undefined) {
				gate.markEntered();
				await gate.released;
			}
			return { ok: true, value: head };
		},
		readGenerationPage(input) {
			stageProbe.events.push("store.readGenerationPage");
			return target.readGenerationPage(input);
		},
		recoverActiveGeneration() {
			stageProbe.events.push("store.recoverActiveGeneration");
			return Promise.resolve({
				ok: true,
				value: Object.freeze({
					kind: "active",
					head,
					adoptedGeneration: Object.freeze({
						baseExpectedHead,
						closure: Object.freeze([ref]),
						closureDigest,
						generationId,
						objectId,
						state: "Adopted",
					}),
					recomputedClosureDigest: closureDigest,
					references: Object.freeze([ref]),
				}),
			});
		},
		getBlob() {
			stageProbe.events.push("store.getBlob");
			return Promise.resolve({ ok: true, value: new Uint8Array(trustStateBytes) });
		},
		beginGeneration(_input) {
			stageProbe.events.push("store.beginGeneration");
			return Promise.resolve({
				ok: false as const,
				reason: "SUBSTRATE_FAILURE" as const,
				cause: "strict no-write A-c boundary",
			});
		},
		putCachedBlob(input) {
			stageProbe.events.push("store.putCachedBlob");
			return target.putCachedBlob(input);
		},
		promoteReference(input) {
			stageProbe.events.push("store.promoteReference");
			return target.promoteReference(input);
		},
		completeGeneration(input) {
			stageProbe.events.push("store.completeGeneration");
			return target.completeGeneration(input);
		},
		swapHead(input) {
			stageProbe.events.push("store.swapHead");
			return target.swapHead(input);
		},
		discardGeneration(input) {
			stageProbe.events.push("store.discardGeneration");
			return target.discardGeneration(input);
		},
		close() {
			stageProbe.events.push("store.close");
			return target.close();
		},
	});
	return facade;
}

function baselineInput(
	options: { readonly catalogMutation?: CatalogMutation; readonly gate?: FirstAwaitGate } = {}
): PrepareV3LiveInput {
	const material = liveMaterial();
	const objectId = must(parseStorageObjectId(String(material.anchor.objectId)));
	return {
		authenticationProfile: "creator-only",
		store: instrumentedStore(material, options.gate),
		objectId,
		pinnedGenesisAnchorDigest: material.anchorDigest,
		exactCanonicalAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
		detachedSignature: new Uint8Array(material.signature),
		exactCanonicalParametersCarrierBytes: encodeCanonical(canonicalParameters()),
		catalog: temporaryCatalog(options.catalogMutation),
	};
}

function controlledPrepare(
	overrides: Partial<PrepareV3LiveInput> = {},
	options: { readonly anchorHashMismatch?: boolean; readonly catalogMutation?: CatalogMutation } = {}
): Promise<PrepareV3LiveResult> {
	const input = Object.freeze({ ...baselineInput(options), ...overrides }) as PrepareV3LiveInput;
	stageProbe.prepareInputs.push(input);
	stageProbe.anchorHashMismatch = options.anchorHashMismatch === true;
	stageProbe.expectedAnchorHex = lowerHex(input.exactCanonicalAnchorPreimageBytes);
	stageProbe.expectedParameterHex = lowerHex(input.exactCanonicalParametersCarrierBytes);
	return moduleSurface().then(async (surface) => {
		if (surface.prepareV3LiveGeneration === undefined) {
			return Object.freeze({ ok: false as const, kind: "internal-invariant" as const, detail: "missing private API" });
		}
		return surface.prepareV3LiveGeneration(input);
	});
}

function independentlyObservedProjection(): Readonly<{
	readonly bytes: Uint8Array;
	readonly ref: Readonly<{ readonly byteLength: number; readonly digest: string }>;
}> {
	const authentication = stageProbe.authenticationResults[0] as
		| Readonly<{ readonly ok: false }>
		| Readonly<{
				readonly ok: true;
				readonly provenance: Readonly<{
					readonly anchorDigest: string;
					readonly blueprintDigest: string;
					readonly epoch: number;
					readonly objectId: string;
					readonly parametersDigest: string;
					readonly profileDigest: string;
					readonly signerSetDigest: string;
				}>;
		  }>;
	if (!authentication?.ok) throw new TypeError("missing authenticated A-a provenance");
	const catalogResult = stageProbe.catalogResults[0] as Readonly<{
		readonly artifactDigest: string;
		readonly artifactId: string;
		readonly blueprintDigest: string;
		readonly evidence: Readonly<{ readonly catalogDigest: string }>;
		readonly runtimeProfile: string;
	}>;
	const runtimeResult = stageProbe.runtimeResults[0] as Readonly<{
		readonly artifactDigest: string;
		readonly artifactId: string;
		readonly blueprintDigest: string;
		readonly runtimeProfile: string;
	}>;
	const graphInput = stageProbe.graphValidationInputs[0] as readonly [
		ReadonlyMap<string, Readonly<Record<string, unknown>>>,
		readonly string[],
		Readonly<{
			readonly initialByteCharges: ReadonlyMap<string, number>;
			readonly maxEpochBytes: number;
			readonly maxEpochVertices: number;
		}>,
	];
	const [verticesByHash, order, graphOptions] = graphInput;
	const orderRecord = Object.freeze({ kind: "v3-live-order-1", orderedVertexHashes: Object.freeze([...order]) });
	const graphRecord = Object.freeze({
		kind: "v3-live-graph-1",
		vertices: Object.freeze(order.map((hash) => Object.freeze({ ...verticesByHash.get(hash) }))),
		charges: Object.freeze(
			order.map((hash) => Object.freeze({ hash, byteCharge: graphOptions.initialByteCharges.get(hash) }))
		),
	});
	const orderedVertexHashesDigest = must(digestBlob(encodeCanonical(orderRecord)));
	const graphDigest = must(digestBlob(encodeCanonical(graphRecord)));
	const parameters = canonicalParameters();
	const projection = Object.freeze({
		kind: "v3-live-generation-1",
		objectId: authentication.provenance.objectId,
		epoch: authentication.provenance.epoch,
		anchorDigest: authentication.provenance.anchorDigest,
		blueprintDigest: catalogResult.blueprintDigest,
		parametersDigest: parameterDigest(parameters),
		profileDigest: authentication.provenance.profileDigest,
		signerSetDigest: authentication.provenance.signerSetDigest,
		artifactDigest: runtimeResult.artifactDigest,
		artifactId: runtimeResult.artifactId,
		catalogDigest: catalogResult.evidence.catalogDigest,
		runtimeProfile: runtimeResult.runtimeProfile,
		trustProfile: "creator-only",
		maxEpochVertices: graphOptions.maxEpochVertices,
		maxEpochBytes: graphOptions.maxEpochBytes,
		maxDependencies: parameters.maxDependencies,
		vertexCount: verticesByHash.size,
		byteCharge: [...graphOptions.initialByteCharges.values()].reduce((total, value) => total + value, 0),
		orderedVertexHashesDigest,
		graphDigest,
	});
	if (
		catalogResult.blueprintDigest !== authentication.provenance.blueprintDigest ||
		runtimeResult.blueprintDigest !== authentication.provenance.blueprintDigest ||
		catalogResult.artifactDigest !== runtimeResult.artifactDigest ||
		catalogResult.artifactId !== runtimeResult.artifactId ||
		catalogResult.runtimeProfile !== runtimeResult.runtimeProfile ||
		authentication.provenance.parametersDigest !== projection.parametersDigest
	) {
		throw new TypeError("instrumented A-a projection inputs disagree");
	}
	const bytes = encodeCanonical(projection);
	return Object.freeze({
		bytes,
		ref: Object.freeze({ byteLength: bytes.byteLength, digest: must(digestBlob(bytes)) }),
	});
}

function expectFailure(result: PrepareV3LiveResult, kind: PrepareV3LiveFailureKind): void {
	expect(result).toEqual({ ok: false, kind, detail: expect.any(String) });
	expect(Object.isFrozen(result)).toBe(true);
}

function isStrictNoWriteACBoundary(result: PrepareV3LiveResult): boolean {
	return result.ok === false && result.kind === "storage-failed" && typeof result.detail === "string";
}

function expectStrictNoWriteACBoundary(result: PrepareV3LiveResult): void {
	expect(isStrictNoWriteACBoundary(result)).toBe(true);
	expect(Object.isFrozen(result)).toBe(true);
}

interface StaticAudit {
	readonly futureOrLiveEdges: readonly string[];
	readonly violations: readonly string[];
}

interface ModuleEdge {
	readonly from: string;
	readonly specifier: string;
	readonly typeOnly: boolean;
}

const PARAMETER_FIELD_NAMES = new Set([
	"maxEpochVertices",
	"maxEpochBytes",
	"maxDependencies",
	"snapshotChunkBytes",
	"maxSnapshotBytes",
	"maxPendingEntries",
	"maxPendingBytes",
]);
const A_A_RUNTIME_ROOTS = new Set([
	"@ts-drp/canonical",
	"@ts-drp/control-plane",
	"@ts-drp/protocol-v3",
	"@ts-drp/storage",
]);
const A_B_RUNTIME_ROOT = "@ts-drp/compaction";
const PUBLISHED_PARAMETER_REGISTRY_SPECIFIER = "@ts-drp/protocol-v3/registry/registry-v1.json";
const PUBLISHED_PARAMETER_REGISTRY_EXPORT = "./registry/registry-v1.json";
const A_A_RUNTIME_DEPENDENCIES = Object.freeze({
	"@ts-drp/canonical": Object.freeze({ manifest: "0.11.0", resolved: "link:../canonical" }),
	"@ts-drp/control-plane": Object.freeze({ manifest: "workspace:*", resolved: "link:../control-plane" }),
	"@ts-drp/protocol-v3": Object.freeze({ manifest: "0.11.0", resolved: "link:../protocol-v3" }),
	"@ts-drp/storage": Object.freeze({ manifest: "0.11.0", resolved: "link:../storage" }),
});
const A_B_RUNTIME_DEPENDENCY = Object.freeze({ manifest: "0.11.0", resolved: "link:../compaction" });
const A_B_STAGE_IDENTIFIERS = new Set(["CausalityIndex", "digestBlob", "digestClosure"]);
const A_C_STAGE_IDENTIFIERS = new Set([
	"GenerationId",
	"WeakMap",
	"assertTrustPreserved",
	"beginGeneration",
	"completeGeneration",
	"discardGeneration",
	"getBlob",
	"parseGenerationId",
	"parseHeadRevision",
	"promoteReference",
	"promoteGeneration",
	"putCachedBlob",
	"putBlob",
	"readGenerationPage",
	"recoverActiveGeneration",
	"recoverGeneration",
	"swapHead",
]);
const A_C_REQUIRED_CALL_ORDER = [
	"recoverActiveGeneration",
	"getBlob",
	"assertTrustPreserved",
	"parseGenerationId",
	"beginGeneration",
	"putCachedBlob",
	"promoteReference",
	"completeGeneration",
	"parseHeadRevision",
	"swapHead",
] as const;
const A_C_STORE_CALLS = new Set([
	"recoverActiveGeneration",
	"getBlob",
	"beginGeneration",
	"putCachedBlob",
	"promoteReference",
	"completeGeneration",
	"swapHead",
]);
const A_C_FORBIDDEN_IDENTIFIERS = new Set([
	"createAnchorTrustStore",
	"createIndexedDbAheDurableStore",
	"createMemoryAheDurableStore",
	"createSqliteAheDurableStore",
	"discardGeneration",
	"promoteGeneration",
	"putBlob",
	"readHead",
	"readGenerationPage",
	"recoverGeneration",
	"repairGeneration",
]);
const B_LIVE_IDENTIFIERS = new Set([
	"compareAndMarkOutboxPublished",
	"WebSocket",
	"addEventListener",
	"admitReceivedVertex",
	"append",
	"createAdmissionBoundTransactionalVertexIssuer",
	"callback",
	"dispatchMessage",
	"fetch",
	"outbox",
	"queueMicrotask",
	"reducer",
	"reducers",
	"setInterval",
	"setTimeout",
	"subscribe",
	"transactIssue",
]);
const THROUGH_A_B_FORBIDDEN_IDENTIFIERS = new Set([...A_C_STAGE_IDENTIFIERS, ...B_LIVE_IDENTIFIERS]);
const THROUGH_A_C_FORBIDDEN_IDENTIFIERS = new Set([...A_C_FORBIDDEN_IDENTIFIERS, ...B_LIVE_IDENTIFIERS]);
const SEAM3_ALLOWED_LIVE_IDENTIFIERS = new Set(["compareAndMarkOutboxPublished", "outbox", "subscribe"]);
const THROUGH_SEAM3_FORBIDDEN_IDENTIFIERS = new Set([
	...A_C_FORBIDDEN_IDENTIFIERS,
	...[...B_LIVE_IDENTIFIERS].filter((name) => !SEAM3_ALLOWED_LIVE_IDENTIFIERS.has(name)),
]);
const SEAM3_RUNTIME_ROOTS = new Set([
	"@ts-drp/issuance-store",
	"@ts-drp/live-journal",
	"@ts-drp/message-queue",
	"@ts-drp/protocol-v3/author-authorization",
	"@ts-drp/types",
]);
const SEAM3_RUNTIME_DEPENDENCY = Object.freeze({ manifest: "0.11.0", resolved: "link:../issuance-store" });
const D9336_RUNTIME_DEPENDENCY = Object.freeze({ manifest: "0.11.0", resolved: "link:../live-journal" });
type SweepStage = "through-a-b" | "through-a-c" | "through-seam3";

function moduleSpecifiers(filename: string): readonly ModuleEdge[] {
	const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
	const edges: ModuleEdge[] = [];
	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
			const clause = statement.importClause;
			const named = clause?.namedBindings;
			const typeOnly =
				clause?.isTypeOnly === true ||
				(named !== undefined &&
					ts.isNamedImports(named) &&
					named.elements.length > 0 &&
					named.elements.every((element) => element.isTypeOnly));
			edges.push({ from: filename, specifier: statement.moduleSpecifier.text, typeOnly });
		}
		if (
			ts.isExportDeclaration(statement) &&
			statement.moduleSpecifier !== undefined &&
			ts.isStringLiteral(statement.moduleSpecifier)
		) {
			edges.push({ from: filename, specifier: statement.moduleSpecifier.text, typeOnly: statement.isTypeOnly });
		}
	}
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0]) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require"))
		) {
			edges.push({ from: filename, specifier: node.arguments[0].text, typeOnly: false });
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return edges;
}

function resolveRelativeModule(from: string, specifier: string): string | undefined {
	const base = path.resolve(path.dirname(from), specifier);
	const withoutJavaScriptExtension = base.replace(/\.(?:c|m)?js$/u, "");
	for (const candidate of [
		base,
		`${withoutJavaScriptExtension}.ts`,
		`${withoutJavaScriptExtension}.mts`,
		`${withoutJavaScriptExtension}.cts`,
		`${withoutJavaScriptExtension}.js`,
		path.join(base, "index.ts"),
		path.join(base, "index.js"),
	]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

function collectModuleGraph(entry: string): {
	readonly edges: readonly ModuleEdge[];
	readonly files: readonly string[];
} {
	const edges: ModuleEdge[] = [];
	const files = new Set<string>();
	const visit = (filename: string): void => {
		if (files.has(filename)) return;
		files.add(filename);
		for (const edge of moduleSpecifiers(filename)) {
			edges.push(edge);
			if (!edge.specifier.startsWith(".")) continue;
			const resolved = resolveRelativeModule(filename, edge.specifier);
			if (resolved !== undefined) visit(resolved);
		}
	};
	visit(entry);
	return { edges: Object.freeze(edges), files: Object.freeze([...files]) };
}

function aBStageViolations(filename: string, stage: SweepStage): readonly string[] {
	const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
	const importCounts = new Map<string, number>();
	const useCounts = new Map<string, number>();
	const digestBlobArguments = new Map<string, number>();
	const digestBlobCalls: ts.CallExpression[] = [];
	const violations: string[] = [];
	const ownerFor = (name: string): string => (name === "CausalityIndex" ? A_B_RUNTIME_ROOT : "@ts-drp/storage");
	const increment = (counts: Map<string, number>, name: string): void => {
		counts.set(name, (counts.get(name) ?? 0) + 1);
	};
	const isExactCausalityConstruction = (node: ts.NewExpression): boolean => {
		if (
			!ts.isExpressionStatement(node.parent) ||
			node.arguments?.length !== 3 ||
			!ts.isIdentifier(node.arguments[0]) ||
			!ts.isIdentifier(node.arguments[1]) ||
			!ts.isObjectLiteralExpression(node.arguments[2])
		) {
			return false;
		}
		const optionNames = node.arguments[2].properties.map((property) =>
			ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) ? property.name.text : ""
		);
		return (
			optionNames.length === 3 &&
			["initialByteCharges", "maxEpochBytes", "maxEpochVertices"].every((name) => optionNames.includes(name))
		);
	};
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== A_B_RUNTIME_ROOT
		) {
			continue;
		}
		const bindings = statement.importClause?.namedBindings;
		if (
			statement.importClause?.isTypeOnly !== false ||
			statement.importClause.name !== undefined ||
			bindings === undefined ||
			!ts.isNamedImports(bindings) ||
			bindings.elements.length !== 1 ||
			bindings.elements[0]?.isTypeOnly !== false ||
			bindings.elements[0].propertyName !== undefined ||
			bindings.elements[0].name.text !== "CausalityIndex"
		) {
			violations.push("a-b-stage:compaction-import");
		}
	}
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && A_B_STAGE_IDENTIFIERS.has(node.text)) {
			const name = node.text;
			const parent = node.parent;
			let allowed = false;
			if (
				ts.isImportSpecifier(parent) &&
				parent.name === node &&
				parent.propertyName === undefined &&
				parent.isTypeOnly === false
			) {
				const namedImports = parent.parent;
				const importClause = namedImports.parent;
				const declaration = importClause.parent;
				if (
					ts.isNamedImports(namedImports) &&
					ts.isImportClause(importClause) &&
					importClause.isTypeOnly === false &&
					ts.isImportDeclaration(declaration) &&
					ts.isStringLiteral(declaration.moduleSpecifier) &&
					declaration.moduleSpecifier.text === ownerFor(name)
				) {
					increment(importCounts, name);
					allowed = true;
				}
			} else if (name === "CausalityIndex" && ts.isNewExpression(parent) && parent.expression === node) {
				increment(useCounts, name);
				allowed = isExactCausalityConstruction(parent);
			} else if (
				(name === "digestBlob" || name === "digestClosure") &&
				ts.isCallExpression(parent) &&
				parent.expression === node
			) {
				increment(useCounts, name);
				allowed = parent.arguments.length === 1;
				if (allowed && name === "digestClosure") allowed = ts.isIdentifier(parent.arguments[0]);
				if (allowed && name === "digestBlob" && ts.isIdentifier(parent.arguments[0])) {
					increment(digestBlobArguments, parent.arguments[0].text);
					digestBlobCalls.push(parent);
				}
			}
			if (!allowed) violations.push(`a-b-stage:${name}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	for (const [name, expectedUses] of [
		["CausalityIndex", 1],
		["digestBlob", stage === "through-a-c" ? 4 : 3],
		["digestClosure", 1],
	] as const) {
		const imports = importCounts.get(name) ?? 0;
		const uses = useCounts.get(name) ?? 0;
		if (imports + uses > 0 && (imports !== 1 || uses !== expectedUses)) {
			violations.push(`a-b-stage:${name}`);
		}
	}
	if (
		(importCounts.get("digestBlob") ?? 0) + (useCounts.get("digestBlob") ?? 0) > 0 &&
		!["exactGraphChargePreimageBytes", "exactOrderPreimageBytes", "exactProjectionBytes"].every(
			(name) => digestBlobArguments.get(name) === 1
		)
	) {
		violations.push("a-b-stage:digestBlob-preimages");
	}
	const derivationNames = new Set(["exactGraphChargePreimageBytes", "exactOrderPreimageBytes", "exactProjectionBytes"]);
	const rawVerificationCalls = digestBlobCalls.filter((call) => {
		const argument = call.arguments[0];
		return ts.isIdentifier(argument) && !derivationNames.has(argument.text);
	});
	if (stage === "through-a-c") {
		const rawCall = rawVerificationCalls[0];
		const owner = rawCall === undefined ? undefined : containingFunction(rawCall);
		const ownerCalls: ts.CallExpression[] = [];
		const preservationCalls: ts.CallExpression[] = [];
		if (owner !== undefined) {
			const collectOwnerCalls = (node: ts.Node): void => {
				if (ts.isFunctionLike(node) && node !== owner) return;
				if (ts.isCallExpression(node)) ownerCalls.push(node);
				ts.forEachChild(node, collectOwnerCalls);
			};
			collectOwnerCalls(owner);
		}
		const collectPreservationCalls = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && aCCallName(node) === "assertTrustPreserved") {
				preservationCalls.push(node);
			}
			ts.forEachChild(node, collectPreservationCalls);
		};
		collectPreservationCalls(source);
		const getBlobCall = ownerCalls.find((call) => aCCallName(call) === "getBlob");
		const rawArgument = rawCall?.arguments[0];
		const afterRaw = rawCall === undefined || owner === undefined ? "" : source.text.slice(rawCall.end, owner.end);
		if (
			rawVerificationCalls.length !== 1 ||
			!ts.isIdentifier(rawArgument) ||
			getBlobCall === undefined ||
			preservationCalls.length !== 1 ||
			getBlobCall.pos >= rawCall.pos ||
			!afterRaw.includes(`${rawArgument.text}.byteLength`) ||
			!afterRaw.includes(".byteLength") ||
			!afterRaw.includes(".digest") ||
			!afterRaw.includes("!==")
		) {
			violations.push("a-b-stage:digestBlob-raw-verification");
		}
	} else if (rawVerificationCalls.length !== 0) {
		violations.push("a-b-stage:digestBlob-raw-verification");
	}
	return Object.freeze([...new Set(violations)].sort());
}

function aCCallName(node: ts.CallExpression): string | undefined {
	if (ts.isIdentifier(node.expression)) return node.expression.text;
	if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
	return undefined;
}

function containingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
	let current = node.parent;
	while (current !== undefined) {
		if (ts.isFunctionLike(current)) return current;
		current = current.parent;
	}
	return undefined;
}

function isExactTwoAttemptLoop(node: ts.ForStatement): boolean {
	const initializer = node.initializer;
	const condition = node.condition;
	if (
		initializer === undefined ||
		!ts.isVariableDeclarationList(initializer) ||
		(initializer.flags & ts.NodeFlags.Let) === 0 ||
		initializer.declarations.length !== 1
	) {
		return false;
	}
	const declaration = initializer.declarations[0];
	if (
		declaration === undefined ||
		!ts.isIdentifier(declaration.name) ||
		declaration.initializer === undefined ||
		!ts.isNumericLiteral(declaration.initializer) ||
		declaration.initializer.text !== "0"
	) {
		return false;
	}
	const counter = declaration.name.text;
	const incrementor = node.incrementor;
	const exactIncrement =
		incrementor !== undefined &&
		((ts.isPostfixUnaryExpression(incrementor) &&
			incrementor.operator === ts.SyntaxKind.PlusPlusToken &&
			ts.isIdentifier(incrementor.operand) &&
			incrementor.operand.text === counter) ||
			(ts.isBinaryExpression(incrementor) &&
				incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
				ts.isIdentifier(incrementor.left) &&
				incrementor.left.text === counter &&
				ts.isNumericLiteral(incrementor.right) &&
				incrementor.right.text === "1"));
	return (
		exactIncrement &&
		condition !== undefined &&
		ts.isBinaryExpression(condition) &&
		condition.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
		ts.isIdentifier(condition.left) &&
		condition.left.text === counter &&
		ts.isNumericLiteral(condition.right) &&
		condition.right.text === "2"
	);
}

function isCapturedInputStoreCall(node: ts.CallExpression): boolean {
	if (!ts.isPropertyAccessExpression(node.expression)) return false;
	const receiver = node.expression.expression;
	return (
		ts.isPropertyAccessExpression(receiver) &&
		receiver.name.text === "store" &&
		ts.isIdentifier(receiver.expression) &&
		receiver.expression.text === "captured"
	);
}

function aCStageViolations(filename: string, allowSeam3 = false): readonly string[] {
	const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
	const violations: string[] = [];
	const topLevelFunctions = new Map<string, ts.FunctionDeclaration[]>();
	for (const statement of source.statements) {
		if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
		const declarations = topLevelFunctions.get(statement.name.text) ?? [];
		declarations.push(statement);
		topLevelFunctions.set(statement.name.text, declarations);
	}
	const entryDeclarations = topLevelFunctions.get("prepareV3LiveGeneration") ?? [];
	if (entryDeclarations.length !== 1 || entryDeclarations[0]?.body === undefined) {
		return Object.freeze(["a-c-stage:owner"]);
	}
	const entry = entryDeclarations[0];
	const consumeDeclarations = topLevelFunctions.get("consumePreparedV3Live") ?? [];
	if (consumeDeclarations.length !== 1 || consumeDeclarations[0]?.body === undefined) {
		violations.push("a-c-stage:consumer-owner");
	}
	const consume = consumeDeclarations.length === 1 ? consumeDeclarations[0] : undefined;
	const namedExports = source.statements.flatMap((statement) => {
		if (
			!ts.isExportDeclaration(statement) ||
			statement.moduleSpecifier !== undefined ||
			statement.exportClause === undefined ||
			!ts.isNamedExports(statement.exportClause)
		) {
			return [];
		}
		return statement.exportClause.elements.map((element) => ({
			exported: element.name.text,
			local: element.propertyName?.text ?? element.name.text,
			typeOnly: element.isTypeOnly,
		}));
	});
	if (source.statements.some((statement) => ts.isExportAssignment(statement))) {
		violations.push("a-c-stage:public-seam");
	}
	const entryExports = namedExports.filter(({ local }) => local === "prepareV3LiveGeneration");
	if (
		entry.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
		entryExports.length !== 1 ||
		entryExports[0]?.exported !== "prepareV3LiveGeneration" ||
		entryExports[0].typeOnly
	) {
		violations.push("a-c-stage:entry-export");
	}
	for (const [name, declarations] of topLevelFunctions) {
		if (
			name === "prepareV3LiveGeneration" ||
			(allowSeam3 && (name === "activateV3LivePlane" || name === "routeV3Ingress"))
		) {
			continue;
		}
		if (
			declarations.some((declaration) =>
				declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
			) ||
			namedExports.some(({ local }) => local === name)
		) {
			violations.push("a-c-stage:public-seam");
		}
	}
	const functionNames = new Set(topLevelFunctions.keys());
	type ReachableFlow = {
		readonly calls: Set<ts.CallExpression>;
		readonly functions: Set<string>;
		readonly loops: Array<Readonly<{ readonly node: ts.ForStatement; readonly operations: readonly string[] }>>;
		readonly operations: string[];
	};
	const newFlow = (): ReachableFlow => ({ calls: new Set(), functions: new Set(), loops: [], operations: [] });
	const flattenExpression = (node: ts.Node | undefined, stack: readonly string[], flow: ReachableFlow): void => {
		if (node === undefined || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
		if (ts.isCallExpression(node)) {
			for (const argument of node.arguments) flattenExpression(argument, stack, flow);
			flow.calls.add(node);
			if (ts.isIdentifier(node.expression) && functionNames.has(node.expression.text)) {
				flattenFunction(node.expression.text, stack, flow);
				return;
			}
			const operation = aCCallName(node);
			if (
				operation !== undefined &&
				A_C_REQUIRED_CALL_ORDER.includes(operation as (typeof A_C_REQUIRED_CALL_ORDER)[number])
			) {
				flow.operations.push(operation);
			}
			return;
		}
		ts.forEachChild(node, (child) => flattenExpression(child, stack, flow));
	};
	const flattenStatements = (
		statements: readonly ts.Statement[],
		stack: readonly string[],
		flow: ReachableFlow
	): boolean => {
		for (const statement of statements) {
			if (!flattenStatement(statement, stack, flow)) return false;
		}
		return true;
	};
	function flattenStatement(statement: ts.Statement, stack: readonly string[], flow: ReachableFlow): boolean {
		if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return true;
		if (ts.isBlock(statement)) return flattenStatements(statement.statements, stack, flow);
		if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
			flattenExpression(statement.expression, stack, flow);
			return false;
		}
		if (ts.isIfStatement(statement)) {
			flattenExpression(statement.expression, stack, flow);
			if (statement.expression.kind === ts.SyntaxKind.TrueKeyword) {
				return flattenStatement(statement.thenStatement, stack, flow);
			}
			if (statement.expression.kind === ts.SyntaxKind.FalseKeyword) {
				return statement.elseStatement === undefined || flattenStatement(statement.elseStatement, stack, flow);
			}
			const thenFalls = flattenStatement(statement.thenStatement, stack, flow);
			const elseFalls = statement.elseStatement === undefined || flattenStatement(statement.elseStatement, stack, flow);
			return thenFalls || elseFalls;
		}
		if (ts.isTryStatement(statement)) {
			const tryFalls = flattenStatements(statement.tryBlock.statements, stack, flow);
			const catchFalls =
				statement.catchClause === undefined || flattenStatements(statement.catchClause.block.statements, stack, flow);
			const finallyFalls =
				statement.finallyBlock === undefined || flattenStatements(statement.finallyBlock.statements, stack, flow);
			return finallyFalls && (tryFalls || catchFalls);
		}
		if (ts.isForStatement(statement)) {
			flattenExpression(statement.initializer, stack, flow);
			flattenExpression(statement.condition, stack, flow);
			const before = flow.operations.length;
			flattenStatement(statement.statement, stack, flow);
			flattenExpression(statement.incrementor, stack, flow);
			flow.loops.push(Object.freeze({ node: statement, operations: Object.freeze(flow.operations.slice(before)) }));
			return true;
		}
		if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
			flattenExpression(statement.expression, stack, flow);
			flattenStatement(statement.statement, stack, flow);
			return true;
		}
		if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
			flattenExpression(statement.expression, stack, flow);
			flattenStatement(statement.statement, stack, flow);
			return true;
		}
		flattenExpression(statement, stack, flow);
		return true;
	}
	function flattenFunction(name: string, stack: readonly string[], flow: ReachableFlow): boolean {
		if (stack.includes(name)) {
			violations.push("a-c-stage:recursive-helper");
			return false;
		}
		const declarations = topLevelFunctions.get(name);
		if (declarations?.length !== 1 || declarations[0]?.body === undefined) {
			violations.push(`a-c-stage:helper:${name}`);
			return false;
		}
		flow.functions.add(name);
		return flattenStatements(declarations[0].body.statements, [...stack, name], flow);
	}
	const entryFlow = newFlow();
	flattenFunction("prepareV3LiveGeneration", [], entryFlow);
	const consumeFlow = newFlow();
	if (consume !== undefined) flattenFunction("consumePreparedV3Live", [], consumeFlow);
	if (entryFlow.functions.has("consumePreparedV3Live")) {
		violations.push("a-c-stage:consumer-premature");
	}

	const callSites = new Map<string, ts.CallExpression[]>();
	const weakMapOwners: Array<Readonly<{ name: string; statement: ts.VariableStatement }>> = [];
	const visitAll = (node: ts.Node): void => {
		if (ts.isVariableStatement(node) && node.parent === source) {
			for (const declaration of node.declarationList.declarations) {
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.initializer !== undefined &&
					ts.isNewExpression(declaration.initializer) &&
					ts.isIdentifier(declaration.initializer.expression) &&
					declaration.initializer.expression.text === "WeakMap" &&
					declaration.initializer.arguments?.length === 0
				) {
					weakMapOwners.push({ name: declaration.name.text, statement: node });
				}
			}
		}
		if (ts.isCallExpression(node)) {
			const name = aCCallName(node);
			if (name !== undefined && A_C_REQUIRED_CALL_ORDER.includes(name as (typeof A_C_REQUIRED_CALL_ORDER)[number])) {
				const sites = callSites.get(name) ?? [];
				sites.push(node);
				callSites.set(name, sites);
				const owner = containingFunction(node);
				if (
					!ts.isFunctionDeclaration(owner) ||
					owner.name === undefined ||
					owner.parent !== source ||
					!entryFlow.calls.has(node)
				) {
					violations.push(`a-c-stage:owner:${name}`);
				}
				if (A_C_STORE_CALLS.has(name) && !isCapturedInputStoreCall(node)) {
					violations.push(`a-c-stage:receiver:${name}`);
				}
			}
		}
		ts.forEachChild(node, visitAll);
	};
	visitAll(source);

	if (weakMapOwners.length !== (allowSeam3 ? 2 : 1)) violations.push("a-c-stage:WeakMap-owner");
	const weakMapOwner = weakMapOwners.find(({ name }) =>
		[...consumeFlow.calls].some(
			(call) =>
				ts.isPropertyAccessExpression(call.expression) &&
				ts.isIdentifier(call.expression.expression) &&
				call.expression.expression.text === name &&
				call.expression.name.text === "get"
		)
	);
	if (weakMapOwner === undefined) violations.push("a-c-stage:token-WeakMap-owner");
	if (
		weakMapOwner !== undefined &&
		(weakMapOwner.statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true ||
			namedExports.some(({ local }) => local === weakMapOwner.name))
	) {
		violations.push("a-c-stage:public-seam");
	}
	for (const owner of weakMapOwners) {
		if (
			owner.statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true ||
			namedExports.some(({ local }) => local === owner.name)
		) {
			violations.push("a-c-stage:public-seam");
		}
	}

	for (const name of A_C_REQUIRED_CALL_ORDER) {
		const sites = callSites.get(name) ?? [];
		if (sites.length !== 1) violations.push(`a-c-stage:${name}-count`);
	}
	if (entryFlow.operations.join("\u0000") !== A_C_REQUIRED_CALL_ORDER.join("\u0000")) {
		violations.push("a-c-stage:operation-order");
	}
	const stageLoops = entryFlow.loops.filter(({ operations }) => operations.length > 0);
	if (
		stageLoops.length !== 1 ||
		!isExactTwoAttemptLoop((stageLoops[0] as { readonly node: ts.ForStatement }).node) ||
		stageLoops[0]?.operations.join("\u0000") !== A_C_REQUIRED_CALL_ORDER.join("\u0000")
	) {
		violations.push("a-c-stage:retry-bound");
	}

	if (weakMapOwner !== undefined) {
		let setCount = 0;
		let getCount = 0;
		let deleteCount = 0;
		let otherAuthorityCount = 0;
		const inspectAuthority = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === weakMapOwner.name
			) {
				const owner = containingFunction(node);
				if (node.expression.name.text === "set" && entryFlow.calls.has(node) && node.arguments.length === 2) {
					setCount += 1;
				} else if (
					node.expression.name.text === "get" &&
					owner === consume &&
					consumeFlow.calls.has(node) &&
					node.arguments.length === 1
				) {
					getCount += 1;
				} else if (
					node.expression.name.text === "delete" &&
					owner === consume &&
					consumeFlow.calls.has(node) &&
					node.arguments.length === 1
				) {
					deleteCount += 1;
				} else {
					otherAuthorityCount += 1;
				}
			}
			ts.forEachChild(node, inspectAuthority);
		};
		inspectAuthority(source);
		if (setCount !== 1) violations.push("a-c-stage:WeakMap-set");
		if (getCount !== 1 || deleteCount !== 1) violations.push("a-c-stage:WeakMap-consume");
		if (otherAuthorityCount !== 0) violations.push("a-c-stage:WeakMap-surface");
	}

	return Object.freeze([...new Set(violations)].sort());
}

function seam3TopologyViolations(filename: string): readonly string[] {
	const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
	const violations: string[] = [];
	const weakMapOwners: string[] = [];
	const observed = new Map<string, number>();
	const expectedCalls = new Map<string, Readonly<{ readonly owner: string; readonly receiver: string }>>([
		["compareAndMarkOutboxPublished", { owner: "publishPending", receiver: "registration.issuanceStore" }],
		["queue-subscribe", { owner: "subscribeActivationQueue", receiver: "messageQueueManager" }],
		["topic-subscribe", { owner: "activateV3LivePlane", receiver: "boundNetworkNode" }],
	]);
	const ownerName = (node: ts.Node): string | undefined => {
		const owner = containingFunction(node);
		return owner !== undefined && "name" in owner && owner.name !== undefined && ts.isIdentifier(owner.name)
			? owner.name.text
			: undefined;
	};
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			node.parent.parent.parent === source &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined &&
			ts.isNewExpression(node.initializer) &&
			ts.isIdentifier(node.initializer.expression) &&
			node.initializer.expression.text === "WeakMap"
		) {
			weakMapOwners.push(node.name.text);
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			const receiver = node.expression.expression.getText(source);
			let key: string | undefined;
			if (method === "compareAndMarkOutboxPublished") key = method;
			if (method === "subscribe" && receiver === "messageQueueManager") key = "queue-subscribe";
			if (method === "subscribe" && receiver === "boundNetworkNode") key = "topic-subscribe";
			if (key !== undefined) {
				observed.set(key, (observed.get(key) ?? 0) + 1);
				const expected = expectedCalls.get(key);
				if (expected === undefined || expected.owner !== ownerName(node) || expected.receiver !== receiver) {
					violations.push(`seam3-owner:${key}`);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	if (weakMapOwners.length !== 3) violations.push("seam3-WeakMap-owners");
	for (const [key] of expectedCalls) if (observed.get(key) !== 1) violations.push(`seam3-call:${key}`);
	const registrationOwner = weakMapOwners.find((name) => {
		let usedByActivate = false;
		let usedByRoute = false;
		const inspect = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && node.text === name) {
				const owner = ownerName(node);
				if (owner === "activateV3LivePlane") usedByActivate = true;
				if (owner === "routeV3Ingress") usedByRoute = true;
			}
			ts.forEachChild(node, inspect);
		};
		inspect(source);
		return usedByActivate && usedByRoute;
	});
	if (registrationOwner === undefined) violations.push("seam3-registration-owner");
	return Object.freeze([...new Set(violations)].sort());
}

function nodeV3IngressViolations(sourceText: string): readonly string[] {
	const source = ts.createSourceFile("packages/node/src/index.ts", sourceText, ts.ScriptTarget.Latest, true);
	const violations: string[] = [];
	const imports = source.statements.filter(
		(statement): statement is ts.ImportDeclaration =>
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			/(?:^|\/)v3-live(?:\.[cm]?[jt]s)?$/u.test(statement.moduleSpecifier.text)
	);
	if (imports.length !== 1) violations.push("node-v3-import-count");
	const imported = imports[0];
	const bindings = imported?.importClause?.namedBindings;
	if (
		imported === undefined ||
		imported.moduleSpecifier.text !== "./v3-live.js" ||
		imported.importClause?.isTypeOnly !== false ||
		imported.importClause.name !== undefined ||
		bindings === undefined ||
		!ts.isNamedImports(bindings) ||
		bindings.elements.length !== 1 ||
		bindings.elements[0]?.name.text !== "routeV3Ingress" ||
		bindings.elements[0].propertyName !== undefined
	) {
		violations.push("node-v3-import-shape");
	}
	let dispatch: ts.MethodDeclaration | undefined;
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isMethodDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === "dispatchMessage" &&
			ts.isClassDeclaration(node.parent) &&
			node.parent.name?.text === "DRPNode"
		) {
			dispatch = node;
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "routeV3Ingress") {
			calls.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	if (calls.length !== 1) violations.push("node-v3-route-count");
	const body = dispatch?.body?.statements;
	const first = body?.[0];
	const second = body?.[1];
	const declaration =
		first !== undefined && ts.isVariableStatement(first) ? first.declarationList.declarations[0] : undefined;
	const call = declaration?.initializer;
	const exactCall =
		call !== undefined &&
		ts.isCallExpression(call) &&
		ts.isIdentifier(call.expression) &&
		call.expression.text === "routeV3Ingress" &&
		call.arguments.length === 2 &&
		call.arguments[0]?.getText(source) === "this.networkNode" &&
		call.arguments[1]?.getText(source) === "msg";
	const exactReturn =
		declaration !== undefined &&
		ts.isIdentifier(declaration.name) &&
		second !== undefined &&
		ts.isIfStatement(second) &&
		ts.isIdentifier(second.expression) &&
		second.expression.text === declaration.name.text &&
		ts.isReturnStatement(second.thenStatement);
	if (!exactCall || !exactReturn) violations.push("node-v3-route-order");
	return Object.freeze([...new Set(violations)].sort());
}

function expectedGeneratedStage(sourceFilename: string): string {
	return ts.transpileModule(readFileSync(sourceFilename, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2015,
		},
		fileName: sourceFilename,
	}).outputText;
}

function generatedStageViolations(
	sourceFilename: string,
	generatedFilename: string,
	stage: SweepStage
): readonly string[] {
	const generatedText = readFileSync(generatedFilename, "utf8");
	const generated = ts.createSourceFile(
		generatedFilename,
		generatedText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS
	);
	const violations: string[] = [];
	if (generatedText !== expectedGeneratedStage(sourceFilename)) violations.push("generated-out-of-date");
	const exports = exportedDeclarationNames(generatedFilename);
	const expectedExports =
		stage === "through-seam3"
			? ["activateV3LivePlane", "prepareV3LiveGeneration", "recoverV3LiveReplica", "routeV3Ingress"]
			: stage === "through-a-c"
				? ["prepareV3LiveGeneration"]
				: [];
	if (exports.join("\u0000") !== expectedExports.join("\u0000")) violations.push("generated-export-surface");
	let awaiterCount = 0;
	let generatorCount = 0;
	let weakMapOwnerCount = 0;
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "__awaiter") {
			awaiterCount += 1;
		}
		if (ts.isFunctionExpression(node) && node.asteriskToken !== undefined) generatorCount += 1;
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "WeakMap") {
			weakMapOwnerCount += 1;
		}
		ts.forEachChild(node, visit);
	};
	visit(generated);
	if (stage === "through-a-c" || stage === "through-seam3") {
		if (awaiterCount !== 1 || generatorCount === 0) violations.push("generated-async-lowering");
		if (weakMapOwnerCount !== (stage === "through-seam3" ? 3 : 1)) violations.push("generated-parallel-owner");
	} else if (weakMapOwnerCount !== 0) {
		violations.push("generated-parallel-owner");
	}
	return Object.freeze([...new Set(violations)].sort());
}

function recursiveFiles(directory: string): readonly string[] {
	if (!existsSync(directory)) return [];
	const output: string[] = [];
	for (const name of readdirSync(directory)) {
		if (name === "node_modules" || name === "tests") continue;
		const candidate = path.join(directory, name);
		if (statSync(candidate).isDirectory()) output.push(...recursiveFiles(candidate));
		else output.push(candidate);
	}
	return output;
}

function ownsLiteralParameterRecord(filename: string): boolean {
	if (!/\.(?:[cm]?[jt]s)$/u.test(filename)) return false;
	const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
	let found = false;
	const visit = (node: ts.Node): void => {
		if (ts.isObjectLiteralExpression(node)) {
			const literalFields = new Set<string>();
			for (const property of node.properties) {
				if (!ts.isPropertyAssignment(property)) continue;
				const name = property.name.getText(source).replace(/["']/gu, "");
				if (PARAMETER_FIELD_NAMES.has(name) && /\d/u.test(property.initializer.getText(source)))
					literalFields.add(name);
			}
			if (literalFields.size === PARAMETER_FIELD_NAMES.size) found = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function nodeLockDependencies(lockfile: string): ReadonlyMap<string, Readonly<{ specifier: string; version: string }>> {
	const lines = lockfile.split("\n");
	const importerStart = lines.findIndex((line) => line === "  packages/node:");
	if (importerStart < 0) return new Map();
	const importerEnd = lines.findIndex((line, index) => index > importerStart && /^ {2}\S/u.test(line));
	const importer = lines.slice(importerStart + 1, importerEnd < 0 ? undefined : importerEnd);
	const dependenciesStart = importer.findIndex((line) => line === "    dependencies:");
	if (dependenciesStart < 0) return new Map();
	const dependencies = new Map<string, { specifier: string; version: string }>();
	for (let index = dependenciesStart + 1; index < importer.length; index += 1) {
		const key = /^ {6}(?:'(?<single>[^']+)'|"(?<double>[^"]+)"|(?<plain>[^'"\s][^:]*)):\s*$/u.exec(
			importer[index] ?? ""
		);
		if (key === null) {
			if (/^ {4}\S/u.test(importer[index] ?? "")) break;
			continue;
		}
		const name = key.groups?.single ?? key.groups?.double ?? key.groups?.plain;
		if (name === undefined) continue;
		const fields = Object.fromEntries(
			importer
				.slice(index + 1, index + 3)
				.map((line) => /^ {8}(?<field>specifier|version):\s*(?<value>\S.*)$/u.exec(line))
				.filter((match): match is RegExpExecArray => match !== null)
				.map((match) => [match.groups?.field, match.groups?.value])
		);
		dependencies.set(name, {
			specifier: typeof fields.specifier === "string" ? fields.specifier : "",
			version: typeof fields.version === "string" ? fields.version : "",
		});
	}
	return dependencies;
}

function sourceSweep(root: string, stage: SweepStage = "through-a-b"): StaticAudit {
	const violations: string[] = [];
	const futureOrLiveEdges: string[] = [];
	const entry = path.join(root, "packages/node/src/v3-live.ts");
	if (!existsSync(entry)) return { futureOrLiveEdges: [], violations: ["missing-source"] };
	const sourceGraph = collectModuleGraph(entry);
	const generatedEntry = path.join(root, "packages/node/dist/src/v3-live.js");
	const generatedGraph = existsSync(generatedEntry) ? collectModuleGraph(generatedEntry) : { edges: [], files: [] };
	const nodeManifestPath = path.join(root, "packages/node/package.json");
	const manifest = JSON.parse(readFileSync(nodeManifestPath, "utf8")) as {
		readonly dependencies?: Readonly<Record<string, string>>;
		readonly devDependencies?: Readonly<Record<string, string>>;
		readonly optionalDependencies?: Readonly<Record<string, string>>;
		readonly peerDependencies?: Readonly<Record<string, string>>;
		readonly scripts?: Readonly<Record<string, string>>;
	};
	const protocolManifest = JSON.parse(readFileSync(path.join(root, "packages/protocol-v3/package.json"), "utf8")) as {
		readonly exports?: Readonly<Record<string, unknown>>;
	};
	if (protocolManifest.exports?.[PUBLISHED_PARAMETER_REGISTRY_EXPORT] !== PUBLISHED_PARAMETER_REGISTRY_EXPORT) {
		violations.push("protocol-v3-registry-export");
	}
	for (const [kind, dependencies] of Object.entries({
		dependencies: manifest.dependencies,
		optionalDependencies: manifest.optionalDependencies,
		peerDependencies: manifest.peerDependencies,
	})) {
		if (dependencies?.["@ts-drp/protocol-v2"] !== undefined) violations.push(`protocol-v2-manifest:${kind}`);
	}
	const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
	const lockedDependencies = nodeLockDependencies(lockfile);
	if (lockedDependencies.has("@ts-drp/protocol-v2")) violations.push("protocol-v2-lockfile");
	for (const [name, expected] of Object.entries(A_A_RUNTIME_DEPENDENCIES)) {
		if (manifest.dependencies?.[name] !== expected.manifest) violations.push(`runtime-manifest:${name}`);
		const locked = lockedDependencies.get(name);
		if (locked?.specifier !== expected.manifest || locked.version !== expected.resolved) {
			violations.push(`runtime-lockfile:${name}`);
		}
	}
	if (stage === "through-seam3") {
		if (manifest.dependencies?.["@ts-drp/issuance-store"] !== SEAM3_RUNTIME_DEPENDENCY.manifest) {
			violations.push("runtime-manifest:@ts-drp/issuance-store");
		}
		const locked = lockedDependencies.get("@ts-drp/issuance-store");
		if (
			locked?.specifier !== SEAM3_RUNTIME_DEPENDENCY.manifest ||
			locked.version !== SEAM3_RUNTIME_DEPENDENCY.resolved
		) {
			violations.push("runtime-lockfile:@ts-drp/issuance-store");
		}
		if (manifest.dependencies?.["@ts-drp/live-journal"] !== D9336_RUNTIME_DEPENDENCY.manifest) {
			violations.push("runtime-manifest:@ts-drp/live-journal");
		}
		const journalLocked = lockedDependencies.get("@ts-drp/live-journal");
		if (
			journalLocked?.specifier !== D9336_RUNTIME_DEPENDENCY.manifest ||
			journalLocked.version !== D9336_RUNTIME_DEPENDENCY.resolved
		) {
			violations.push("runtime-lockfile:@ts-drp/live-journal");
		}
	}

	const codeGenerationFiles = new Set<string>();
	for (const filename of recursiveFiles(path.join(root, "packages/node"))) {
		const relative = path.relative(path.join(root, "packages/node"), filename);
		if (
			/(?:^|\/)(?:scripts|templates)\//u.test(relative) ||
			/(?:build|codegen|generat|template)/iu.test(path.basename(filename))
		) {
			codeGenerationFiles.add(filename);
		}
	}
	for (const command of Object.values(manifest.scripts ?? {})) {
		if (/protocol-v2|defaultParameters/u.test(command)) violations.push("protocol-v2-codegen");
		for (const match of command.matchAll(
			/(?<file>(?:\.?\.?\/)?[^\s"']*(?:build|codegen|generat|template)[^\s"']*\.(?:[cm]?[jt]s))/giu
		)) {
			if (match.groups?.file === undefined) continue;
			const candidate = path.resolve(path.dirname(nodeManifestPath), match.groups.file);
			if (existsSync(candidate)) codeGenerationFiles.add(candidate);
		}
	}

	const allEdges = [...sourceGraph.edges, ...generatedGraph.edges];
	const hasABSourceRuntimeImport = allEdges.some(
		(edge) => edge.typeOnly === false && edge.specifier === A_B_RUNTIME_ROOT && edge.from === entry
	);
	const hasABGeneratedRuntimeImport = allEdges.some(
		(edge) => edge.typeOnly === false && edge.specifier === A_B_RUNTIME_ROOT && edge.from === generatedEntry
	);
	const hasABRuntimeImport = hasABSourceRuntimeImport || hasABGeneratedRuntimeImport;
	const hasABRuntimeDeclaration = manifest.dependencies?.[A_B_RUNTIME_ROOT] !== undefined;
	const hasABRuntimeLock = lockedDependencies.has(A_B_RUNTIME_ROOT);
	if (hasABRuntimeImport || hasABRuntimeDeclaration || hasABRuntimeLock) {
		if (!hasABRuntimeImport) violations.push(`runtime-import:${A_B_RUNTIME_ROOT}`);
		if (!hasABSourceRuntimeImport) violations.push(`runtime-source:${A_B_RUNTIME_ROOT}`);
		if (existsSync(generatedEntry) && !hasABGeneratedRuntimeImport) {
			violations.push(`runtime-generated:${A_B_RUNTIME_ROOT}`);
		}
		if (manifest.dependencies?.[A_B_RUNTIME_ROOT] !== A_B_RUNTIME_DEPENDENCY.manifest) {
			violations.push(`runtime-manifest:${A_B_RUNTIME_ROOT}`);
		}
		const locked = lockedDependencies.get(A_B_RUNTIME_ROOT);
		if (locked?.specifier !== A_B_RUNTIME_DEPENDENCY.manifest || locked.version !== A_B_RUNTIME_DEPENDENCY.resolved) {
			violations.push(`runtime-lockfile:${A_B_RUNTIME_ROOT}`);
		}
	}
	for (const edge of allEdges) {
		if (/^@ts-drp\/protocol-v2(?:\/|$)/u.test(edge.specifier)) {
			violations.push(edge.from === entry ? "protocol-v2-direct" : "protocol-v2-indirect");
		}
		if (
			/^@ts-drp\/[^/]+\//u.test(edge.specifier) &&
			edge.specifier !== PUBLISHED_PARAMETER_REGISTRY_SPECIFIER &&
			edge.specifier !== "@ts-drp/protocol-v3/author-authorization"
		) {
			violations.push(`deep-import:${edge.specifier}`);
		}
		if (!edge.specifier.startsWith(".")) {
			const isABRuntimeEdge =
				edge.typeOnly === false &&
				edge.specifier === A_B_RUNTIME_ROOT &&
				(edge.from === entry || edge.from === generatedEntry);
			const permitted =
				A_A_RUNTIME_ROOTS.has(edge.specifier) ||
				isABRuntimeEdge ||
				(stage === "through-seam3" && SEAM3_RUNTIME_ROOTS.has(edge.specifier)) ||
				edge.specifier === PUBLISHED_PARAMETER_REGISTRY_SPECIFIER ||
				(edge.typeOnly && edge.specifier === "@ts-drp/blueprint-catalog");
			if (!permitted) futureOrLiveEdges.push(`import:${edge.specifier}`);
			const dependencyRoot =
				edge.specifier === PUBLISHED_PARAMETER_REGISTRY_SPECIFIER ? "@ts-drp/protocol-v3" : edge.specifier;
			if (A_A_RUNTIME_ROOTS.has(dependencyRoot)) {
				if (manifest.dependencies?.[dependencyRoot] === undefined)
					violations.push(`undeclared-runtime:${dependencyRoot}`);
				if (!lockedDependencies.has(dependencyRoot)) violations.push(`unlocked-runtime:${dependencyRoot}`);
			}
			if (
				edge.typeOnly &&
				edge.specifier === "@ts-drp/blueprint-catalog" &&
				manifest.devDependencies?.[edge.specifier] === undefined
			) {
				violations.push("undeclared-type:@ts-drp/blueprint-catalog");
			}
		}
	}

	const inspectFutureOrLive = (filename: string, identifiers: ReadonlySet<string>): void => {
		const parsed = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
		const inspect = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && identifiers.has(node.text)) {
				futureOrLiveEdges.push(`identifier:${node.text}`);
			}
			ts.forEachChild(node, inspect);
		};
		inspect(parsed);
	};
	for (const filename of sourceGraph.files) {
		futureOrLiveEdges.push(
			...aBStageViolations(filename, stage !== "through-a-b" && filename === entry ? "through-a-c" : "through-a-b")
		);
		if ((stage === "through-a-c" || stage === "through-seam3") && filename === entry) {
			futureOrLiveEdges.push(...aCStageViolations(filename, stage === "through-seam3"));
			if (stage === "through-seam3") {
				futureOrLiveEdges.push(...seam3TopologyViolations(filename));
				inspectFutureOrLive(filename, THROUGH_SEAM3_FORBIDDEN_IDENTIFIERS);
			} else {
				inspectFutureOrLive(filename, THROUGH_A_C_FORBIDDEN_IDENTIFIERS);
			}
		} else {
			inspectFutureOrLive(filename, THROUGH_A_B_FORBIDDEN_IDENTIFIERS);
		}
		if (ownsLiteralParameterRecord(filename)) violations.push("parallel-parameters-source");
	}
	for (const filename of generatedGraph.files) {
		if (filename === generatedEntry) {
			futureOrLiveEdges.push(...generatedStageViolations(entry, generatedEntry, stage));
		}
		if ((stage === "through-a-c" || stage === "through-seam3") && filename === generatedEntry) {
			inspectFutureOrLive(
				filename,
				stage === "through-seam3" ? THROUGH_SEAM3_FORBIDDEN_IDENTIFIERS : THROUGH_A_C_FORBIDDEN_IDENTIFIERS
			);
		} else {
			futureOrLiveEdges.push(...aBStageViolations(filename, "through-a-b"));
			inspectFutureOrLive(filename, THROUGH_A_B_FORBIDDEN_IDENTIFIERS);
		}
		if (ownsLiteralParameterRecord(filename)) violations.push("parallel-parameters-generated");
	}
	for (const filename of recursiveFiles(path.join(root, "packages/node/src"))) {
		if (ownsLiteralParameterRecord(filename)) violations.push("parallel-parameters-source");
	}
	for (const filename of recursiveFiles(path.join(root, "packages/node/dist"))) {
		if (ownsLiteralParameterRecord(filename)) violations.push("parallel-parameters-generated");
	}
	for (const filename of codeGenerationFiles) {
		const value = readFileSync(filename, "utf8");
		if (/protocol-v2|defaultParameters/u.test(value) || ownsLiteralParameterRecord(filename)) {
			violations.push("protocol-v2-codegen");
		}
	}
	const source = readFileSync(entry, "utf8");
	const profileEntries = [
		...source.matchAll(/parametersDigest:\s*["'](?<digest>[0-9a-f]{64})["'][\s\S]{0,160}runtimeProfile:/gu),
	];
	if (profileEntries.length !== 1 || profileEntries[0]?.groups?.digest !== parameterDigest()) {
		violations.push("profile-entry");
	}
	return {
		futureOrLiveEdges: Object.freeze([...new Set(futureOrLiveEdges)].sort()),
		violations: Object.freeze([...new Set(violations)].sort()),
	};
}

function temporarySweepTree(): string {
	const root = mkdtempSync(path.join(path.resolve(tmpdir()), "phase-3a1-a-sweep-"));
	temporaryDirectories.push(root);
	for (const filename of [
		"packages/node/src/v3-live.ts",
		"packages/node/dist/src/v3-live.js",
		"packages/node/package.json",
		"packages/protocol-v3/package.json",
		"pnpm-lock.yaml",
	]) {
		const target = path.join(root, filename);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, "", { flag: "wx" });
	}
	writeFileSync(
		path.join(root, "packages/node/package.json"),
		JSON.stringify({
			dependencies: {
				"@ts-drp/canonical": "0.11.0",
				"@ts-drp/control-plane": "workspace:*",
				"@ts-drp/protocol-v3": "0.11.0",
				"@ts-drp/storage": "0.11.0",
			},
			name: "@ts-drp/node",
			scripts: {},
		})
	);
	writeFileSync(
		path.join(root, "packages/protocol-v3/package.json"),
		JSON.stringify({
			exports: {
				".": { import: "./dist/src/public.js", types: "./dist/src/public.d.ts" },
				[PUBLISHED_PARAMETER_REGISTRY_EXPORT]: PUBLISHED_PARAMETER_REGISTRY_EXPORT,
			},
			name: "@ts-drp/protocol-v3",
		})
	);
	writeFileSync(
		path.join(root, "pnpm-lock.yaml"),
		"lockfileVersion: '9.0'\nimporters:\n  packages/node:\n    dependencies:\n      '@ts-drp/canonical':\n        specifier: 0.11.0\n        version: link:../canonical\n      '@ts-drp/control-plane':\n        specifier: workspace:*\n        version: link:../control-plane\n      '@ts-drp/protocol-v3':\n        specifier: 0.11.0\n        version: link:../protocol-v3\n      '@ts-drp/storage':\n        specifier: 0.11.0\n        version: link:../storage\n"
	);
	writeFileSync(
		path.join(root, "packages/node/src/v3-live.ts"),
		`import registry from "${PUBLISHED_PARAMETER_REGISTRY_SPECIFIER}" with { type: "json" };\nconst supported = { parametersDigest: "${parameterDigest()}", runtimeProfile: "ecmascript-2024-sync-v1" };\nvoid supported; void registry;\n`
	);
	emitSweepGenerated(root);
	return root;
}

function emitSweepGenerated(root: string): void {
	const source = path.join(root, "packages/node/src/v3-live.ts");
	writeFileSync(path.join(root, "packages/node/dist/src/v3-live.js"), expectedGeneratedStage(source));
}

function addABRuntimeDependency(root: string): void {
	const manifestPath = path.join(root, "packages/node/package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		dependencies: Record<string, string>;
	};
	manifest.dependencies[A_B_RUNTIME_ROOT] = A_B_RUNTIME_DEPENDENCY.manifest;
	writeFileSync(manifestPath, JSON.stringify(manifest));
	const lockPath = path.join(root, "pnpm-lock.yaml");
	const lockfile = readFileSync(lockPath, "utf8");
	writeFileSync(
		lockPath,
		lockfile.replace(
			"    dependencies:\n",
			`    dependencies:\n      '${A_B_RUNTIME_ROOT}':\n        specifier: ${A_B_RUNTIME_DEPENDENCY.manifest}\n        version: ${A_B_RUNTIME_DEPENDENCY.resolved}\n`
		)
	);
}

const A_B_GRAPH_PROJECTION_STAGE_SOURCE = `
import { CausalityIndex } from "@ts-drp/compaction";
import { digestBlob, digestClosure } from "@ts-drp/storage";
const exactOrderPreimageBytes = new Uint8Array([1]);
const exactGraphChargePreimageBytes = new Uint8Array([2]);
const exactProjectionBytes = new Uint8Array([3]);
const orderedVertexHashesDigest = digestBlob(exactOrderPreimageBytes).value;
const graphDigest = digestBlob(exactGraphChargePreimageBytes).value;
const projectionDigest = digestBlob(exactProjectionBytes).value;
const exactClosure = [{ digest: orderedVertexHashesDigest, byteLength: 1 }, { digest: projectionDigest, byteLength: 3 }];
const closureDigest = digestClosure(exactClosure);
const ownedGraph = new Map();
const order = [];
const charges = new Map();
new CausalityIndex(ownedGraph, order, { initialByteCharges: charges, maxEpochBytes: 2, maxEpochVertices: 1 });
void closureDigest;
`;

function addABGraphProjectionStage(root: string): void {
	addABRuntimeDependency(root);
	writeFileSync(path.join(root, "packages/node/src/v3-live.ts"), A_B_GRAPH_PROJECTION_STAGE_SOURCE, { flag: "a" });
	emitSweepGenerated(root);
}

const A_C_PERSISTENCE_STAGE_SOURCE = `
import { assertTrustPreserved } from "@ts-drp/control-plane";
import { parseGenerationId, parseHeadRevision } from "@ts-drp/storage";
const preparedV3LivePayloads = new WeakMap();
async function recoverPreservedTrust() {
	const opened = await trustStore.open();
	const head = opened.head;
	const recovered = await captured.store.recoverActiveGeneration(captured.objectId);
	const recoveredRef = recovered.references[0];
	const candidate = await captured.store.getBlob(recoveredRef.digest);
	const recoveredDigest = digestBlob(candidate).value;
	if (candidate.byteLength !== recoveredRef.byteLength || recoveredDigest !== recoveredRef.digest) throw new TypeError("raw evidence");
	const preserved = assertTrustPreserved({ candidate, head });
	return { head, preserved };
}
async function stagePreparedGeneration(input, head) {
	const generationId = parseGenerationId(input.freshGenerationId()).value;
	await captured.store.beginGeneration({ generationId, head });
	const projectionRef = await captured.store.putCachedBlob({ generationId, bytes: input.projection });
	await captured.store.promoteReference({ generationId, ref: projectionRef });
	const completed = await captured.store.completeGeneration({ generationId });
	const revision = parseHeadRevision(head.revision + 1).value;
	const swapped = await captured.store.swapHead({ completed, expected: head, revision });
	void swapped;
}
function consumePreparedV3Live(token) {
	const value = preparedV3LivePayloads.get(token);
	if (value !== undefined) preparedV3LivePayloads.delete(token);
	return value;
}
async function prepareV3LiveGeneration(input) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const { head, preserved } = await recoverPreservedTrust();
		await stagePreparedGeneration(input, head);
		void preserved;
	}
	const token = Object.freeze({});
	preparedV3LivePayloads.set(token, Object.freeze({ input }));
	return token;
}
export { prepareV3LiveGeneration };
void consumePreparedV3Live;
`;

function addACPersistenceStage(root: string): void {
	addABGraphProjectionStage(root);
	writeFileSync(path.join(root, "packages/node/src/v3-live.ts"), A_C_PERSISTENCE_STAGE_SOURCE, { flag: "a" });
	emitSweepGenerated(root);
}

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
	Reflect.deleteProperty(globalThis, LIVE_EFFECT_KEY);
});

const PRIVATE_V3_LIVE_EXPORTS = [
	"PrepareV3LiveFailureKind",
	"PrepareV3LiveGenerationInput",
	"PrepareV3LiveResult",
	"PreparedV3Live",
	"RecoverV3LiveReplicaFailureKind",
	"RecoverV3LiveReplicaInput",
	"RecoverV3LiveReplicaResult",
	"RecoveredV3Live",
	"V3AdmittedVertexSink",
	"V3EgressResult",
	"V3LiveDescriptor",
	"V3PlaneActivationFailureKind",
	"V3PlaneActivationInput",
	"V3PlaneActivationResult",
	"V3PlaneHandle",
	"activateV3LivePlane",
	"prepareV3LiveGeneration",
	"recoverV3LiveReplica",
	"routeV3Ingress",
] as const;

function exportedDeclarationNames(filename: string): readonly string[] {
	if (!existsSync(filename)) return [];
	const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
	const names: string[] = [];
	for (const statement of source.statements) {
		if (ts.isExportDeclaration(statement)) {
			if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
				for (const element of statement.exportClause.elements) names.push(element.name.text);
			} else if (statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
				names.push(`*:${statement.moduleSpecifier.text}`);
			}
			continue;
		}
		const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
		if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true) continue;
		if (
			ts.isClassDeclaration(statement) ||
			ts.isEnumDeclaration(statement) ||
			ts.isFunctionDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement)
		) {
			if (statement.name !== undefined) names.push(statement.name.text);
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
			}
		}
	}
	return Object.freeze([...new Set(names)].sort());
}

describe.sequential("Phase 3a-1A-a private creator preparation RED", () => {
	it("freezes the exact private API, failure union and absence from runtime/public roots", async () => {
		const typecheck = spawnSync(
			"pnpm",
			["exec", "tsc", "--noEmit", "--project", "tests/fixtures/phase-3a1-a-v3/tsconfig.test.json"],
			{ cwd: REPOSITORY_ROOT, encoding: "utf8" }
		);
		expect.soft(typecheck.status, `${typecheck.stdout}${typecheck.stderr}`).toBe(0);
		const surface = await moduleSurface();
		const nodeRoot = await import("../packages/node/src/index.js");
		const nodeRuntime = await import("../packages/node/src/runtime.js");
		const protocolRoot = await import("../packages/protocol-v3/src/public.js");
		expect.soft(typeof surface.prepareV3LiveGeneration).toBe("function");
		expect
			.soft(Object.keys(surface).sort())
			.toEqual(["activateV3LivePlane", "prepareV3LiveGeneration", "recoverV3LiveReplica", "routeV3Ingress"]);
		expect.soft(exportedDeclarationNames(IMPLEMENTATION)).toEqual(PRIVATE_V3_LIVE_EXPORTS);
		const implementationSource = existsSync(IMPLEMENTATION) ? readFileSync(IMPLEMENTATION, "utf8") : "";
		expect.soft(implementationSource.match(/declare const preparedV3LiveBrand:\s*unique symbol;/gu)).toHaveLength(1);
		expect
			.soft(
				implementationSource.match(
					/export type PreparedV3Live\s*=\s*Readonly<\{\s*readonly \[preparedV3LiveBrand\]: true;?\s*\}>;/gu
				)
			)
			.toHaveLength(1);
		const privateNames = new Set<string>(PRIVATE_V3_LIVE_EXPORTS);
		const nodeIndexFilename = path.join(REPOSITORY_ROOT, "packages/node/src/index.ts");
		for (const filename of [
			nodeIndexFilename,
			path.join(REPOSITORY_ROOT, "packages/node/src/runtime.ts"),
			path.join(REPOSITORY_ROOT, "packages/protocol-v3/src/public.ts"),
		]) {
			expect(
				exportedDeclarationNames(filename).filter((name) => privateNames.has(name)),
				filename
			).toEqual([]);
			if (filename !== nodeIndexFilename) {
				expect(
					moduleSpecifiers(filename).filter((edge) => /(?:^|\/)v3-live(?:\.[cm]?[jt]s)?$/u.test(edge.specifier)),
					filename
				).toEqual([]);
			}
		}
		const nodeIndexSource = readFileSync(nodeIndexFilename, "utf8");
		expect(nodeV3IngressViolations(nodeIndexSource)).toEqual([]);
		for (const mutant of [
			nodeIndexSource.replace(
				'import { routeV3Ingress } from "./v3-live.js";',
				'import { routeV3Ingress as route } from "./v3-live.js";'
			),
			nodeIndexSource.replace(
				"const routeV3IngressResult = routeV3Ingress(this.networkNode, msg);",
				"const routeV3IngressResult = false;"
			),
			nodeIndexSource.replace("if (routeV3IngressResult) return;", "void routeV3IngressResult;"),
			`${nodeIndexSource}\nimport { activateV3LivePlane } from "./v3-live.js";\n`,
		]) {
			expect(nodeV3IngressViolations(mutant)).not.toEqual([]);
		}
		expect(Object.keys(nodeRoot).sort()).toEqual(NODE_ROOT_EXPORTS);
		expect(Object.keys(nodeRuntime).sort()).toEqual(NODE_RUNTIME_EXPORTS);
		expect(Object.keys(protocolRoot).sort()).toEqual(PROTOCOL_V3_RUNTIME_EXPORTS);
		expect(Object.getOwnPropertyNames(nodeRoot.DRPNode.prototype).sort()).toEqual(DRP_NODE_PROTOTYPE);
		expect(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "packages/node/package.json"), "utf8")).exports).toEqual({
			".": { import: "./dist/src/index.js", types: "./dist/src/index.d.ts" },
			"./runtime": { import: "./dist/src/runtime.js", types: "./dist/src/runtime.d.ts" },
		});
		expect(FAILURE_KINDS).toHaveLength(12);
		expect(new Set(FAILURE_KINDS).size).toBe(12);
	});

	it("rejects malformed closed input before trust, catalog or live effects", async () => {
		const baseline = baselineInput();
		const accessorInput = { ...baseline };
		Object.defineProperty(accessorInput, "catalog", {
			configurable: true,
			enumerable: true,
			get: () => baseline.catalog,
		});
		const symbolInput = { ...baseline, [Symbol("extra")]: true };
		const inheritedInput = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, baseline);
		const sharedBuffer = new ArrayBuffer(
			baseline.exactCanonicalAnchorPreimageBytes.byteLength +
				baseline.detachedSignature.byteLength +
				baseline.exactCanonicalParametersCarrierBytes.byteLength
		);
		const sharedAnchor = new Uint8Array(sharedBuffer, 0, baseline.exactCanonicalAnchorPreimageBytes.byteLength);
		const sharedSignature = new Uint8Array(
			sharedBuffer,
			sharedAnchor.byteLength,
			baseline.detachedSignature.byteLength
		);
		const sharedParameters = new Uint8Array(
			sharedBuffer,
			sharedAnchor.byteLength + sharedSignature.byteLength,
			baseline.exactCanonicalParametersCarrierBytes.byteLength
		);
		sharedAnchor.set(baseline.exactCanonicalAnchorPreimageBytes);
		sharedSignature.set(baseline.detachedSignature);
		sharedParameters.set(baseline.exactCanonicalParametersCarrierBytes);
		for (const candidate of [
			{ ...baseline, authenticationProfile: "delegated" },
			{ ...baseline, pinnedGenesisAnchorDigest: "A".repeat(64) },
			{ ...baseline, objectId: "invalid" },
			{ ...baseline, extra: true },
			accessorInput,
			symbolInput,
			inheritedInput,
			{
				...baseline,
				exactCanonicalAnchorPreimageBytes: sharedAnchor,
				detachedSignature: sharedSignature,
				exactCanonicalParametersCarrierBytes: sharedParameters,
			},
		]) {
			const surface = await moduleSurface();
			if (surface.prepareV3LiveGeneration === undefined) throw new Error("missing private API");
			expectFailure(await surface.prepareV3LiveGeneration(candidate as PrepareV3LiveInput), "malformed-input");
			expect(stageProbe.events).toEqual([]);
		}
	});

	it("copies all three byte arrays before the first await and binds anchor domain, pin, object and trust", async () => {
		const gate = firstAwaitGate();
		const input = baselineInput({ gate });
		const anchor = new Uint8Array(input.exactCanonicalAnchorPreimageBytes);
		const signature = new Uint8Array(input.detachedSignature);
		const parameters = new Uint8Array(input.exactCanonicalParametersCarrierBytes);
		const expectedAnchor = new Uint8Array(anchor);
		const expectedSignature = new Uint8Array(signature);
		const expectedParameters = new Uint8Array(parameters);
		const originalCatalog = input.catalog;
		const originalObjectId = input.objectId;
		const originalPin = input.pinnedGenesisAnchorDigest;
		const originalStore = input.store;
		const candidate = {
			...input,
			exactCanonicalAnchorPreimageBytes: anchor,
			detachedSignature: signature,
			exactCanonicalParametersCarrierBytes: parameters,
		};
		const surface = await moduleSurface();
		if (surface.prepareV3LiveGeneration === undefined) throw new Error("missing private API");
		stageProbe.expectedAnchorHex = lowerHex(expectedAnchor);
		stageProbe.expectedParameterHex = lowerHex(parameters);
		const promise = surface.prepareV3LiveGeneration(candidate);
		await gate.entered;
		for (const name of [
			"authenticationProfile",
			"catalog",
			"objectId",
			"pinnedGenesisAnchorDigest",
			"store",
		] as const) {
			Object.defineProperty(candidate, name, {
				configurable: true,
				enumerable: true,
				get: (): never => {
					throw new Error(`post-await reread:${name}`);
				},
			});
		}
		anchor.fill(0xff);
		signature.fill(0xff);
		parameters.fill(0xff);
		gate.release();
		const result = await promise;
		expectStrictNoWriteACBoundary(result);
		expect(stageProbe.events.at(-1)).toBe("store.beginGeneration");
		expect(stageProbe.events.filter((event) => event === "store.beginGeneration")).toHaveLength(1);
		const trustFactoryInput = stageProbe.trustFactoryInputs[0] as {
			readonly objectId: StorageObjectId;
			readonly pinnedGenesisAnchorDigest: string;
			readonly store: AheDurableStore;
		};
		expect(trustFactoryInput.objectId).toBe(originalObjectId);
		expect(trustFactoryInput.pinnedGenesisAnchorDigest).toBe(originalPin);
		expect(trustFactoryInput.store).toBe(originalStore);
		const authenticationInput = stageProbe.authenticationInputs[0] as {
			readonly detachedSignature: Uint8Array;
			readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
		};
		expect(authenticationInput.detachedSignature).not.toBe(signature);
		expect(authenticationInput.detachedSignature).toEqual(expectedSignature);
		expect(authenticationInput.exactCanonicalAnchorPreimageBytes).not.toBe(anchor);
		expect(authenticationInput.exactCanonicalAnchorPreimageBytes).toEqual(expectedAnchor);
		expect(stageProbe.trustOpenHashInputs).toHaveLength(2);
		for (const inputParts of stageProbe.trustOpenHashInputs) expect(inputParts[0]).toEqual(expectedAnchor);
		expect(stageProbe.authenticationHashInputs).toHaveLength(1);
		expect(stageProbe.authenticationHashInputs[0]?.[0]).not.toBe(authenticationInput.exactCanonicalAnchorPreimageBytes);
		expect(stageProbe.authenticationHashInputs[0]?.[0]).toEqual(authenticationInput.exactCanonicalAnchorPreimageBytes);
		expect(stageProbe.anchorHashInputs).toHaveLength(1);
		expect(stageProbe.anchorHashInputs[0]?.[0]).toBe(authenticationInput.exactCanonicalAnchorPreimageBytes);
		expect(stageProbe.parameterDecodeInputs[0]).not.toBe(parameters);
		expect(stageProbe.parameterDecodeInputs[0]).toEqual(expectedParameters);
		expect(stageProbe.catalogRequests).toEqual([blueprintFixture().blueprintDigest]);
		expect(stageProbe.prepareInputs).toEqual([]);
		expect(stageProbe.liveEffects).toEqual([]);
		expect(originalCatalog).toBe(input.catalog);
	});

	it("orders trust, anchor, parameters, catalog, admission and awaited runtime before graph handoff", async () => {
		const result = await controlledPrepare();
		expectStrictNoWriteACBoundary(result);
		expect(
			isStrictNoWriteACBoundary({
				ok: false,
				kind: "trust-not-preserved",
				detail: "stale A-b terminal mutant",
			})
		).toBe(false);
		expect(stageProbe.events).toEqual([
			"trust.create",
			"trust.open:start",
			"store.readHead",
			"store.recoverActiveGeneration",
			"store.getBlob",
			"trust.record.open",
			"trust.open.hash",
			"trust.open:resolved",
			"anchor.authenticate",
			"anchor.authenticate.hash",
			"anchor.hash",
			"parameters.decode",
			"parameters.encode",
			"parameters.hash",
			"catalog.resolve",
			"blueprint.admission",
			"blueprint.runtime:start",
			"blueprint.runtime:resolved",
			"graph.validate",
			"trust.open:start",
			"store.readHead",
			"store.recoverActiveGeneration",
			"store.getBlob",
			"trust.record.open",
			"trust.open.hash",
			"trust.open:resolved",
			"store.recoverActiveGeneration",
			"store.getBlob",
			"trust.preserve",
			"store.beginGeneration",
		]);
		const input = stageProbe.prepareInputs[0] as PrepareV3LiveInput;
		const trustFactoryInput = stageProbe.trustFactoryInputs[0] as {
			readonly objectId: StorageObjectId;
			readonly pinnedGenesisAnchorDigest: string;
			readonly store: AheDurableStore;
		};
		expect(trustFactoryInput.objectId).toBe(input.objectId);
		expect(trustFactoryInput.pinnedGenesisAnchorDigest).toBe(input.pinnedGenesisAnchorDigest);
		expect(trustFactoryInput.store).toBe(input.store);
		const trustOpen = stageProbe.trustOpenResults[0] as { readonly ok: true; readonly trust: unknown };
		const authenticationInput = stageProbe.authenticationInputs[0] as { readonly trust: unknown };
		expect(authenticationInput.trust).toBe(trustOpen.trust);
		expect(stageProbe.trustOpenHashInputs).toHaveLength(2);
		expect(stageProbe.authenticationHashInputs).toHaveLength(1);
		expect(stageProbe.authenticationHashInputs[0]?.[0]).not.toBe(
			(stageProbe.authenticationInputs[0] as { readonly exactCanonicalAnchorPreimageBytes: Uint8Array })
				.exactCanonicalAnchorPreimageBytes
		);
		expect(stageProbe.authenticationHashInputs[0]?.[0]).toEqual(
			(stageProbe.authenticationInputs[0] as { readonly exactCanonicalAnchorPreimageBytes: Uint8Array })
				.exactCanonicalAnchorPreimageBytes
		);
		expect(stageProbe.anchorHashInputs).toHaveLength(1);
		expect(stageProbe.anchorHashInputs[0]?.[0]).toBe(
			(stageProbe.authenticationInputs[0] as { readonly exactCanonicalAnchorPreimageBytes: Uint8Array })
				.exactCanonicalAnchorPreimageBytes
		);
		expect(stageProbe.parameterHashInputs[0]?.[0]).toBe(stageProbe.parameterEncodeOutputs[0]);
		expect(stageProbe.catalogRequests).toEqual([blueprintFixture().blueprintDigest]);
		const catalogResult = stageProbe.catalogResults[0] as {
			readonly canonicalBlueprintPackageBytes: Uint8Array;
			readonly exactArtifactBytes: Uint8Array;
		};
		const admissionInput = stageProbe.admissionInputs[0] as {
			readonly canonicalBlueprintPackageBytes: Uint8Array;
			readonly expectedBlueprintDigest: string;
		};
		expect(admissionInput.expectedBlueprintDigest).toBe(blueprintFixture().blueprintDigest);
		expect(admissionInput.canonicalBlueprintPackageBytes).not.toBe(catalogResult.canonicalBlueprintPackageBytes);
		expect(admissionInput.canonicalBlueprintPackageBytes).toEqual(catalogResult.canonicalBlueprintPackageBytes);
		expect(stageProbe.admissionResults).toHaveLength(1);
		const runtimeInput = stageProbe.runtimeInputs[0] as {
			readonly canonicalBlueprintPackageBytes: Uint8Array;
			readonly exactArtifactBytes: Uint8Array;
			readonly expectedBlueprintDigest: string;
			readonly preparedBlueprintAdmission: unknown;
		};
		expect(runtimeInput.expectedBlueprintDigest).toBe(blueprintFixture().blueprintDigest);
		expect(runtimeInput.preparedBlueprintAdmission).toBe(stageProbe.admissionResults[0]);
		expect(runtimeInput.canonicalBlueprintPackageBytes).toBe(admissionInput.canonicalBlueprintPackageBytes);
		expect(runtimeInput.exactArtifactBytes).not.toBe(catalogResult.exactArtifactBytes);
		expect(runtimeInput.exactArtifactBytes).toEqual(catalogResult.exactArtifactBytes);
		expect(stageProbe.runtimeResults).toHaveLength(1);
		expect(stageProbe.graphValidationInputs).toHaveLength(1);
		expect(stageProbe.preservationInputs).toHaveLength(1);
		const preservationInput = stageProbe.preservationInputs[0] as {
			readonly candidates: readonly Readonly<{
				readonly bytes: Uint8Array;
				readonly ref: { readonly byteLength: number; readonly digest: string };
			}>[];
			readonly closure: readonly Readonly<{ readonly byteLength: number; readonly digest: string }>[];
			readonly expectedTrustRef: Readonly<{ readonly byteLength: number; readonly digest: string }>;
		};
		expect(Reflect.ownKeys(preservationInput)).toEqual(["candidates", "closure", "expectedTrustRef"]);
		expect(preservationInput.candidates).toHaveLength(2);
		expect(preservationInput.closure).toHaveLength(2);
		expect(preservationInput.closure.map(({ digest }) => digest)).toEqual(
			preservationInput.closure
				.map(({ digest }) => digest)
				.slice()
				.sort()
		);
		expect(preservationInput.candidates.map(({ ref }) => ref)).toEqual(preservationInput.closure);
		const reopenedTrustRef = (
			stageProbe.trustOpenResults[1] as {
				readonly trustRef: Readonly<{ readonly byteLength: number; readonly digest: string }>;
			}
		).trustRef;
		expect(preservationInput.expectedTrustRef).toEqual(reopenedTrustRef);
		expect(preservationInput.closure).toContainEqual(reopenedTrustRef);
		const independentlyDerivedProjection = independentlyObservedProjection();
		const nonTrustRefs = preservationInput.closure.filter(
			({ byteLength, digest }) => digest !== reopenedTrustRef.digest || byteLength !== reopenedTrustRef.byteLength
		);
		expect(nonTrustRefs).toEqual([independentlyDerivedProjection.ref]);
		const projectionCandidate = preservationInput.candidates.find(
			({ ref }) => ref.digest === independentlyDerivedProjection.ref.digest
		);
		expect(projectionCandidate?.ref).toEqual(nonTrustRefs[0]);
		expect(projectionCandidate?.bytes.byteLength).toBe(independentlyDerivedProjection.ref.byteLength);
		expect(projectionCandidate?.bytes).not.toBe(independentlyDerivedProjection.bytes);
		expect(projectionCandidate?.bytes).toEqual(independentlyDerivedProjection.bytes);
		expect(must(digestBlob(projectionCandidate?.bytes as Uint8Array))).toBe(independentlyDerivedProjection.ref.digest);
		expect(stageProbe.preservationResults).toEqual([
			{ ok: true, exactCanonicalTrustStateRecordBytes: expect.any(Uint8Array), trustRef: expect.any(Object) },
		]);
		expect(stageProbe.liveEffects).toEqual([]);
	});

	it("stops a rejected exact two-ref preservation decision before the strict no-write stage boundary", async () => {
		stageProbe.preservationFailure = true;
		const result = await controlledPrepare();
		expectFailure(result, "trust-not-preserved");
		expect(stageProbe.preservationInputs).toHaveLength(1);
		expect(stageProbe.preservationResults).toEqual([{ ok: false, reason: "candidate-missing" }]);
		expect(stageProbe.events.at(-1)).toBe("trust.preserve");
		expect(stageProbe.events).not.toContain("store.beginGeneration");
	});

	it("accepts distinct catalog byte views sharing one ordinary buffer and detaches both before preparation", async () => {
		const result = await controlledPrepare({}, { catalogMutation: "shared-ordinary-backing" });
		expectStrictNoWriteACBoundary(result);
		const fixture = blueprintFixture();
		const catalogResult = stageProbe.catalogResults[0] as {
			readonly canonicalBlueprintPackageBytes: Uint8Array;
			readonly exactArtifactBytes: Uint8Array;
		};
		expect(catalogResult.canonicalBlueprintPackageBytes).not.toBe(catalogResult.exactArtifactBytes);
		expect(catalogResult.canonicalBlueprintPackageBytes.byteLength).toBeGreaterThan(0);
		expect(catalogResult.exactArtifactBytes.byteLength).toBeGreaterThan(0);
		expect(catalogResult.canonicalBlueprintPackageBytes.buffer).toBe(catalogResult.exactArtifactBytes.buffer);
		expect(catalogResult.canonicalBlueprintPackageBytes).toEqual(fixture.canonicalBlueprintPackageBytes);
		expect(catalogResult.exactArtifactBytes).toEqual(fixture.exactArtifactBytes);

		const admissionInput = stageProbe.admissionInputs[0] as {
			readonly canonicalBlueprintPackageBytes: Uint8Array;
			readonly expectedBlueprintDigest: string;
		};
		expect(admissionInput.expectedBlueprintDigest).toBe(fixture.blueprintDigest);
		expect(admissionInput.canonicalBlueprintPackageBytes).not.toBe(catalogResult.canonicalBlueprintPackageBytes);
		expect(admissionInput.canonicalBlueprintPackageBytes.buffer).not.toBe(
			catalogResult.canonicalBlueprintPackageBytes.buffer
		);
		expect(admissionInput.canonicalBlueprintPackageBytes).toEqual(fixture.canonicalBlueprintPackageBytes);

		const runtimeInput = stageProbe.runtimeInputs[0] as {
			readonly canonicalBlueprintPackageBytes: Uint8Array;
			readonly exactArtifactBytes: Uint8Array;
			readonly expectedBlueprintDigest: string;
			readonly preparedBlueprintAdmission: unknown;
		};
		expect(runtimeInput.expectedBlueprintDigest).toBe(fixture.blueprintDigest);
		expect(runtimeInput.preparedBlueprintAdmission).toBe(stageProbe.admissionResults[0]);
		expect(runtimeInput.canonicalBlueprintPackageBytes).toBe(admissionInput.canonicalBlueprintPackageBytes);
		expect(runtimeInput.exactArtifactBytes).not.toBe(catalogResult.exactArtifactBytes);
		expect(runtimeInput.exactArtifactBytes.buffer).not.toBe(catalogResult.exactArtifactBytes.buffer);
		expect(runtimeInput.exactArtifactBytes.buffer).not.toBe(runtimeInput.canonicalBlueprintPackageBytes.buffer);
		expect(runtimeInput.exactArtifactBytes).toEqual(fixture.exactArtifactBytes);
		expect(stageProbe.runtimeResults).toHaveLength(1);
		expect(stageProbe.graphValidationInputs).toHaveLength(1);
		expect(stageProbe.liveEffects).toEqual([]);
	});

	it("keeps a genuine validation refusal graph-rejected without entering A-c or a live effect", async () => {
		stageProbe.graphValidationFailure = true;
		const result = await controlledPrepare();
		expectFailure(result, "graph-rejected");
		expect(stageProbe.graphValidationInputs).toHaveLength(1);
		expect(stageProbe.events.at(-1)).toBe("graph.validate");
		expect(stageProbe.events).not.toContain("store.beginGeneration");
		expect(stageProbe.events).not.toContain("store.putCachedBlob");
		expect(stageProbe.events).not.toContain("store.promoteReference");
		expect(stageProbe.events).not.toContain("store.completeGeneration");
		expect(stageProbe.events).not.toContain("store.swapHead");
		expect(stageProbe.liveEffects).toEqual([]);
	});

	it("maps reachable A-a stage failures without starting a later stage or live effect", async () => {
		const cases: readonly [PrepareV3LiveFailureKind, Partial<PrepareV3LiveInput>, CatalogMutation, string, boolean?][] =
			[
				["trust-open-failed", { store: createMemoryAheDurableStore() }, "none", "trust.open:resolved"],
				["anchor-authentication-failed", { detachedSignature: new Uint8Array(64) }, "none", "anchor.authenticate.hash"],
				["anchor-authentication-failed", {}, "none", "anchor.hash", true],
				[
					"parameters-rejected",
					{
						exactCanonicalParametersCarrierBytes: encodeCanonical({
							...canonicalParameters(),
							maxDependencies: 15,
						}),
					},
					"none",
					"parameters.hash",
				],
				["blueprint-unresolved", {}, "throw", "catalog.resolve"],
				["blueprint-unresolved", {}, "catalog-blueprint", "catalog.resolve"],
				["blueprint-unresolved", {}, "catalog-runtime-profile", "catalog.resolve"],
				["admission-rejected", {}, "admission-package", "blueprint.admission"],
				["admission-rejected", {}, "admission-output", "blueprint.admission"],
				["runtime-preparation-failed", {}, "runtime-artifact", "blueprint.runtime:start"],
				["runtime-preparation-failed", {}, "runtime-output-artifact-digest", "blueprint.runtime:resolved"],
				["runtime-preparation-failed", {}, "runtime-output-artifact-id", "blueprint.runtime:resolved"],
				["runtime-preparation-failed", {}, "runtime-output-blueprint-digest", "blueprint.runtime:resolved"],
				["runtime-preparation-failed", {}, "runtime-output-profile", "blueprint.runtime:resolved"],
			];
		for (const [kind, overrides, catalogMutation, lastEvent, anchorHashMismatch] of cases) {
			resetStageProbe();
			expectFailure(await controlledPrepare(overrides, { anchorHashMismatch, catalogMutation }), kind);
			expect(stageProbe.events.at(-1), kind).toBe(lastEvent);
			if (kind === "parameters-rejected") expect(stageProbe.catalogRequests).toEqual([]);
			if (overrides.detachedSignature !== undefined) {
				expect(stageProbe.trustOpenHashInputs).toHaveLength(1);
				expect(stageProbe.authenticationHashInputs).toHaveLength(1);
				expect(stageProbe.anchorHashInputs).toEqual([]);
			}
			if (kind !== "runtime-preparation-failed") expect(stageProbe.runtimeResults, kind).toEqual([]);
			expect(stageProbe.liveEffects, kind).toEqual([]);
		}
	});

	it("derives the sole supported digest from Phase-0p while descriptor maxima remain carrier-owned", () => {
		const parameters = canonicalParameters();
		expect(parameters).toEqual({
			maxEpochVertices: 8192,
			maxEpochBytes: 8388608,
			maxDependencies: 16,
			snapshotChunkBytes: 131072,
			maxSnapshotBytes: 268435456,
			maxPendingEntries: 4096,
			maxPendingBytes: 16777216,
		});
		expect(parameterDigest(parameters)).toBe("cd31923f2f1928daab3a6943fa361f7cf40516ba3c4929abbd3109ee65cdc669");
	});

	it("stage-scopes the recursive hygiene sweep through private A-c while killing repair, extra-CAS, seam and 1B mutants", () => {
		const clean = temporarySweepTree();
		expect(sourceSweep(clean)).toEqual({ futureOrLiveEdges: [], violations: [] });
		const allowedAB = temporarySweepTree();
		addABGraphProjectionStage(allowedAB);
		expect(sourceSweep(allowedAB)).toEqual({ futureOrLiveEdges: [], violations: [] });
		const allowedAC = temporarySweepTree();
		addACPersistenceStage(allowedAC);
		expect(sourceSweep(allowedAC, "through-a-c")).toEqual({ futureOrLiveEdges: [], violations: [] });
		const loweredAC = readFileSync(path.join(allowedAC, "packages/node/dist/src/v3-live.js"), "utf8");
		expect(loweredAC.match(/\b__awaiter\b/gu)).not.toBeNull();
		expect(loweredAC.match(/function\s*\*/gu)).not.toBeNull();

		for (const [name, addition, expected] of [
			["generated-export-escape", "\nexport { consumePreparedV3Live };\n", "generated-export-surface"],
			["generated-parallel-owner", "\nconst parallelPrepared = new WeakMap();\n", "generated-parallel-owner"],
			["generated-b-effect", "\nvoid subscribe;\n", "identifier:subscribe"],
			["generated-forbidden-import", '\nimport "@ts-drp/protocol-v2";\n', "protocol-v2-indirect"],
		] as const) {
			const root = temporarySweepTree();
			addACPersistenceStage(root);
			writeFileSync(path.join(root, "packages/node/dist/src/v3-live.js"), addition, { flag: "a" });
			const audit = sourceSweep(root, "through-a-c");
			expect([...audit.futureOrLiveEdges, ...audit.violations], name).toContain(expected);
		}

		for (const [name, mutate, expected] of [
			[
				"old-a-b-termination",
				(source: string): string =>
					source.replace(
						/\tfor \(let attempt = 0; attempt < 2; attempt \+= 1\) \{[\s\S]*?\n\t\}/u,
						'\treturn failure("trust-not-preserved", "stale A-b terminal");'
					),
				"a-c-stage:owner:recoverActiveGeneration",
			],
			[
				"extra-cas",
				(source: string): string =>
					source.replace(
						"\tvoid swapped;",
						"\tawait captured.store.swapHead({ completed, expected: head, revision });\n\tvoid swapped;"
					),
				"a-c-stage:swapHead-count",
			],
			[
				"third-attempt",
				(source: string): string => source.replace("attempt < 2", "attempt < 3"),
				"a-c-stage:retry-bound",
			],
			[
				"nonadvancing-attempt",
				(source: string): string => source.replace("attempt += 1", "attempt -= 1"),
				"a-c-stage:retry-bound",
			],
			[
				"recovery-outside-attempt",
				(source: string): string =>
					source.replace(
						"\tfor (let attempt = 0; attempt < 2; attempt += 1) {\n\t\tconst { head, preserved } = await recoverPreservedTrust();",
						"\tconst { head, preserved } = await recoverPreservedTrust();\n\tfor (let attempt = 0; attempt < 2; attempt += 1) {"
					),
				"a-c-stage:retry-bound",
			],
			[
				"missing-raw-verification",
				(source: string): string =>
					source.replace(
						"const recoveredDigest = digestBlob(candidate).value;",
						"const recoveredDigest = recoveredRef.digest;"
					),
				"a-b-stage:digestBlob-raw-verification",
			],
			[
				"extra-raw-verification",
				(source: string): string =>
					source.replace(
						"const recoveredDigest = digestBlob(candidate).value;",
						"const recoveredDigest = digestBlob(candidate).value;\n\tvoid digestBlob(candidate);"
					),
				"a-b-stage:digestBlob-raw-verification",
			],
			[
				"misplaced-raw-verification",
				(source: string): string =>
					source.replace(
						"const candidate = await captured.store.getBlob(recoveredRef.digest);\n\tconst recoveredDigest = digestBlob(candidate).value;",
						"const recoveredDigest = digestBlob(candidate).value;\n\tconst candidate = await captured.store.getBlob(recoveredRef.digest);"
					),
				"a-b-stage:digestBlob-raw-verification",
			],
			[
				"false-branch-recovery",
				(source: string): string =>
					source.replace(
						"\t\tconst { head, preserved } = await recoverPreservedTrust();",
						"\t\tif (false) { const { head, preserved } = await recoverPreservedTrust(); void head; void preserved; }\n\t\tconst head = undefined; const preserved = undefined;"
					),
				"a-c-stage:owner:recoverActiveGeneration",
			],
			[
				"post-return-stage",
				(source: string): string =>
					source.replace(
						"\t\tawait stagePreparedGeneration(input, head);",
						"\t\treturn;\n\t\tawait stagePreparedGeneration(input, head);"
					),
				"a-c-stage:owner:beginGeneration",
			],
			[
				"public-capability-seam",
				(source: string): string =>
					source.replace("const preparedV3LivePayloads", "export const preparedV3LivePayloads"),
				"a-c-stage:public-seam",
			],
			[
				"operation-reorder",
				(source: string): string =>
					source.replace(
						"\tawait captured.store.beginGeneration({ generationId, head });\n\tconst projectionRef = await captured.store.putCachedBlob({ generationId, bytes: input.projection });",
						"\tconst projectionRef = await captured.store.putCachedBlob({ generationId, bytes: input.projection });\n\tawait captured.store.beginGeneration({ generationId, head });"
					),
				"a-c-stage:operation-order",
			],
			[
				"dead-owner-decoy",
				(source: string): string => `${source}\nasync function deadOwner(input) { await input.store.swapHead({}); }\n`,
				"a-c-stage:owner:swapHead",
			],
			[
				"parallel-store-receiver",
				(source: string): string =>
					source.replace("captured.store.recoverActiveGeneration", "parallelStore.recoverActiveGeneration"),
				"a-c-stage:receiver:recoverActiveGeneration",
			],
			[
				"caller-store-reread",
				(source: string): string =>
					source.replace("captured.store.recoverActiveGeneration", "input.store.recoverActiveGeneration"),
				"a-c-stage:receiver:recoverActiveGeneration",
			],
			[
				"aliased-helper",
				(source: string): string =>
					source.replace("await recoverPreservedTrust()", "await recoverPreservedTrustAlias()"),
				"a-c-stage:owner:recoverActiveGeneration",
			],
			[
				"exported-helper",
				(source: string): string =>
					source.replace("async function recoverPreservedTrust()", "export async function recoverPreservedTrust()"),
				"a-c-stage:public-seam",
			],
			[
				"aliased-entry-export",
				(source: string): string =>
					source.replace(
						"export { prepareV3LiveGeneration };",
						"export { prepareV3LiveGeneration as publicPrepareV3LiveGeneration };"
					),
				"a-c-stage:entry-export",
			],
			[
				"exported-consumer",
				(source: string): string =>
					source.replace("function consumePreparedV3Live(token)", "export function consumePreparedV3Live(token)"),
				"a-c-stage:public-seam",
			],
			[
				"default-exported-entry",
				(source: string): string => `${source}\nexport default prepareV3LiveGeneration;\n`,
				"a-c-stage:public-seam",
			],
			[
				"default-exported-consumer",
				(source: string): string => `${source}\nexport default consumePreparedV3Live;\n`,
				"a-c-stage:public-seam",
			],
			[
				"duplicate-consumer",
				(source: string): string => `${source}\nfunction consumePreparedV3Live(token) { return token; }\n`,
				"a-c-stage:consumer-owner",
			],
		] as const) {
			const root = temporarySweepTree();
			addACPersistenceStage(root);
			for (const filename of ["packages/node/src/v3-live.ts", "packages/node/dist/src/v3-live.js"]) {
				const target = path.join(root, filename);
				writeFileSync(target, mutate(readFileSync(target, "utf8")));
			}
			expect(sourceSweep(root, "through-a-c").futureOrLiveEdges, name).toContain(expected);
		}

		for (const forbidden of [
			"discardGeneration",
			"repairGeneration",
			"createMemoryAheDurableStore",
			"createSqliteAheDurableStore",
			"subscribe",
		] as const) {
			const root = temporarySweepTree();
			addACPersistenceStage(root);
			for (const filename of ["packages/node/src/v3-live.ts", "packages/node/dist/src/v3-live.js"]) {
				writeFileSync(path.join(root, filename), `\nvoid ${forbidden};\n`, { flag: "a" });
			}
			expect(sourceSweep(root, "through-a-c").futureOrLiveEdges, forbidden).toContain(`identifier:${forbidden}`);
		}

		const declaredWithoutOwner = temporarySweepTree();
		addABRuntimeDependency(declaredWithoutOwner);
		expect(sourceSweep(declaredWithoutOwner).violations).toContain(`runtime-import:${A_B_RUNTIME_ROOT}`);

		for (const [field, replacement] of [
			["manifest", "wrong"],
			["specifier", "wrong"],
			["version", "wrong"],
		] as const) {
			const root = temporarySweepTree();
			addABGraphProjectionStage(root);
			if (field === "manifest") {
				const manifestPath = path.join(root, "packages/node/package.json");
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				manifest.dependencies[A_B_RUNTIME_ROOT] = replacement;
				writeFileSync(manifestPath, JSON.stringify(manifest));
			} else {
				const lockPath = path.join(root, "pnpm-lock.yaml");
				const lockfile = readFileSync(lockPath, "utf8");
				writeFileSync(
					lockPath,
					lockfile.replace(
						`${field}: ${field === "specifier" ? A_B_RUNTIME_DEPENDENCY.manifest : A_B_RUNTIME_DEPENDENCY.resolved}`,
						`${field}: ${replacement}`
					)
				);
			}
			expect(sourceSweep(root).violations, field).toContain(
				field === "manifest" ? `runtime-manifest:${A_B_RUNTIME_ROOT}` : `runtime-lockfile:${A_B_RUNTIME_ROOT}`
			);
		}

		const extraABUse = temporarySweepTree();
		addABGraphProjectionStage(extraABUse);
		writeFileSync(path.join(extraABUse, "packages/node/src/v3-live.ts"), "\nvoid digestBlob(exactProjectionBytes);\n", {
			flag: "a",
		});
		expect(sourceSweep(extraABUse).futureOrLiveEdges).toContain("a-b-stage:digestBlob");

		for (const compactionImport of [
			'import { CausalityIndex, linearizeEpoch } from "@ts-drp/compaction";',
			'import Extra, { CausalityIndex } from "@ts-drp/compaction";',
		]) {
			const extraCompactionImport = temporarySweepTree();
			addABGraphProjectionStage(extraCompactionImport);
			const extraCompactionSource = path.join(extraCompactionImport, "packages/node/src/v3-live.ts");
			writeFileSync(
				extraCompactionSource,
				readFileSync(extraCompactionSource, "utf8").replace(
					'import { CausalityIndex } from "@ts-drp/compaction";',
					compactionImport
				)
			);
			expect(sourceSweep(extraCompactionImport).futureOrLiveEdges, compactionImport).toContain(
				"a-b-stage:compaction-import"
			);
		}

		const retainedIndex = temporarySweepTree();
		addABGraphProjectionStage(retainedIndex);
		const retainedIndexSource = path.join(retainedIndex, "packages/node/src/v3-live.ts");
		writeFileSync(
			retainedIndexSource,
			readFileSync(retainedIndexSource, "utf8").replace(
				"new CausalityIndex(ownedGraph, order,",
				"const retainedValidationIndex = new CausalityIndex(ownedGraph, order,"
			)
		);
		expect(sourceSweep(retainedIndex).futureOrLiveEdges).toContain("a-b-stage:CausalityIndex");

		const indirectABOwner = temporarySweepTree();
		addABRuntimeDependency(indirectABOwner);
		writeFileSync(path.join(indirectABOwner, "packages/node/src/a-b-indirect.ts"), A_B_GRAPH_PROJECTION_STAGE_SOURCE, {
			flag: "wx",
		});
		writeFileSync(path.join(indirectABOwner, "packages/node/src/v3-live.ts"), '\nimport "./a-b-indirect.js";\n', {
			flag: "a",
		});
		const indirectAudit = sourceSweep(indirectABOwner);
		expect(indirectAudit.violations).toContain(`runtime-import:${A_B_RUNTIME_ROOT}`);
		expect(indirectAudit.futureOrLiveEdges).toContain(`import:${A_B_RUNTIME_ROOT}`);

		expect([...A_C_STAGE_IDENTIFIERS].sort()).toEqual([
			"GenerationId",
			"WeakMap",
			"assertTrustPreserved",
			"beginGeneration",
			"completeGeneration",
			"discardGeneration",
			"getBlob",
			"parseGenerationId",
			"parseHeadRevision",
			"promoteGeneration",
			"promoteReference",
			"putBlob",
			"putCachedBlob",
			"readGenerationPage",
			"recoverActiveGeneration",
			"recoverGeneration",
			"swapHead",
		]);
		expect([...B_LIVE_IDENTIFIERS].sort()).toEqual([
			"WebSocket",
			"addEventListener",
			"admitReceivedVertex",
			"append",
			"callback",
			"compareAndMarkOutboxPublished",
			"createAdmissionBoundTransactionalVertexIssuer",
			"dispatchMessage",
			"fetch",
			"outbox",
			"queueMicrotask",
			"reducer",
			"reducers",
			"setInterval",
			"setTimeout",
			"subscribe",
			"transactIssue",
		]);
		for (const [stage, identifiers] of [
			["a-c", A_C_STAGE_IDENTIFIERS],
			["1b", B_LIVE_IDENTIFIERS],
		] as const) {
			const root = temporarySweepTree();
			writeFileSync(
				path.join(root, "packages/node/src/v3-live.ts"),
				`\n${[...identifiers].map((name) => `void ${name};`).join("\n")}\n`,
				{ flag: "a" }
			);
			emitSweepGenerated(root);
			const audit = sourceSweep(root);
			expect(audit.futureOrLiveEdges, stage).toEqual([...identifiers].map((name) => `identifier:${name}`).sort());
		}
		for (const [name, expected] of Object.entries(A_A_RUNTIME_DEPENDENCIES)) {
			const manifestRoot = temporarySweepTree();
			const manifestPath = path.join(manifestRoot, "packages/node/package.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.dependencies[name] = "wrong";
			writeFileSync(manifestPath, JSON.stringify(manifest));
			expect(sourceSweep(manifestRoot).violations, name).toContain(`runtime-manifest:${name}`);

			const lockRoot = temporarySweepTree();
			const lockPath = path.join(lockRoot, "pnpm-lock.yaml");
			const lockfile = readFileSync(lockPath, "utf8");
			writeFileSync(
				lockPath,
				lockfile.replace(
					`      '${name}':\n        specifier: ${expected.manifest}`,
					`      '${name}':\n        specifier: wrong`
				)
			);
			expect(sourceSweep(lockRoot).violations, name).toContain(`runtime-lockfile:${name}`);

			const resolvedRoot = temporarySweepTree();
			const resolvedLockPath = path.join(resolvedRoot, "pnpm-lock.yaml");
			const resolvedLockfile = readFileSync(resolvedLockPath, "utf8");
			writeFileSync(
				resolvedLockPath,
				resolvedLockfile.replace(
					`      '${name}':\n        specifier: ${expected.manifest}\n        version: ${expected.resolved}`,
					`      '${name}':\n        specifier: ${expected.manifest}\n        version: wrong`
				)
			);
			expect(sourceSweep(resolvedRoot).violations, name).toContain(`runtime-lockfile:${name}`);
		}
		for (const replacement of [undefined, "./registry/retargeted.json"] as const) {
			const root = temporarySweepTree();
			const manifestPath = path.join(root, "packages/protocol-v3/package.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
				exports: Record<string, unknown>;
			};
			if (replacement === undefined) Reflect.deleteProperty(manifest.exports, PUBLISHED_PARAMETER_REGISTRY_EXPORT);
			else manifest.exports[PUBLISHED_PARAMETER_REGISTRY_EXPORT] = replacement;
			writeFileSync(manifestPath, JSON.stringify(manifest));
			expect(sourceSweep(root).violations, replacement ?? "missing").toContain("protocol-v3-registry-export");
		}
		for (const specifier of [
			"@ts-drp/protocol-v3/conformance/vectors",
			"@ts-drp/protocol-v3/formal/model",
			"@ts-drp/protocol-v3/src/index.js",
			"@ts-drp/protocol-v3/private",
		]) {
			const root = temporarySweepTree();
			writeFileSync(path.join(root, "packages/node/src/v3-live.ts"), `\nimport "${specifier}";\n`, { flag: "a" });
			const audit = sourceSweep(root);
			expect(audit.violations, specifier).toContain(`deep-import:${specifier}`);
			expect(audit.futureOrLiveEdges, specifier).toContain(`import:${specifier}`);
		}
		const mutations = [
			["packages/node/src/v3-live.ts", '\nimport "@ts-drp/protocol-v2";\n', "protocol-v2-direct", undefined],
			[
				"packages/node/dist/src/v3-live.js",
				"\nconst emittedDefaults={maxEpochVertices:8192,maxEpochBytes:8388608,maxDependencies:16,snapshotChunkBytes:131072,maxSnapshotBytes:268435456,maxPendingEntries:4096,maxPendingBytes:16777216}; void emittedDefaults;\n",
				"parallel-parameters-generated",
				undefined,
			],
			["packages/node/src/indirect.ts", '\nrequire("@ts-drp/protocol-v2");\n', "protocol-v2-indirect", undefined],
			["packages/node/package.json", "", "protocol-v2-manifest:dependencies", undefined],
			[
				"packages/node/scripts/generate-defaults.mjs",
				'\nconst generator = "defaultParameters";\n',
				"protocol-v2-codegen",
				undefined,
			],
			[
				"packages/node/src/parallel.ts",
				"\nconst fallback={maxEpochVertices:8192,maxEpochBytes:8388608,maxDependencies:16,snapshotChunkBytes:131072,maxSnapshotBytes:268435456,maxPendingEntries:4096,maxPendingBytes:16777216};\nvoid fallback;\n",
				"parallel-parameters-source",
				undefined,
			],
		] as const;
		for (const [filename, addition, expectedViolation, expectedFutureEdge] of mutations) {
			const root = temporarySweepTree();
			const target = path.join(root, filename);
			mkdirSync(path.dirname(target), { recursive: true });
			if (expectedViolation === "protocol-v2-manifest:dependencies") {
				const manifestPath = path.join(root, "packages/node/package.json");
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				manifest.dependencies["@ts-drp/protocol-v2"] = "0.11.0";
				writeFileSync(manifestPath, JSON.stringify(manifest));
				writeFileSync(
					path.join(root, "pnpm-lock.yaml"),
					"lockfileVersion: '9.0'\nimporters:\n  packages/node:\n    dependencies:\n      '@ts-drp/protocol-v2':\n        version: 0.11.0\n"
				);
			} else {
				writeFileSync(target, addition, { flag: existsSync(target) ? "a" : "wx" });
			}
			if (filename === "packages/node/scripts/generate-defaults.mjs") {
				const manifestPath = path.join(root, "packages/node/package.json");
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				manifest.scripts.codegen = "node scripts/generate-defaults.mjs --source defaultParameters";
				writeFileSync(manifestPath, JSON.stringify(manifest));
			}
			if (filename.endsWith("indirect.ts")) {
				writeFileSync(path.join(root, "packages/node/src/v3-live.ts"), '\nimport "./indirect.js";\n', { flag: "a" });
			}
			const audit = sourceSweep(root);
			expect(audit.violations, filename).toContain(expectedViolation);
			if (expectedViolation === "protocol-v2-manifest:dependencies") {
				expect(audit.violations, filename).toContain("protocol-v2-lockfile");
			}
			if (expectedFutureEdge !== undefined) expect(audit.futureOrLiveEdges, filename).toContain(expectedFutureEdge);
		}
		const repositoryAudit = sourceSweep(REPOSITORY_ROOT, "through-seam3");
		expect(repositoryAudit.violations).toEqual([]);
		const authorizedD9336Edges = new Set([
			"a-b-stage:CausalityIndex",
			"a-b-stage:compaction-import",
			"a-c-stage:WeakMap-owner",
			"a-c-stage:public-seam",
			"identifier:append",
			"seam3-WeakMap-owners",
		]);
		expect(repositoryAudit.futureOrLiveEdges.filter((edge) => !authorizedD9336Edges.has(edge))).toEqual([]);
		const seam3Source = readFileSync(IMPLEMENTATION, "utf8");
		expect(seam3TopologyViolations(IMPLEMENTATION)).toEqual([]);
		for (const mutant of [
			seam3Source.replace("messageQueueManager.subscribe(queueId, handler)", "subscribe(queueId, handler)"),
			seam3Source.replace("boundNetworkNode.subscribe(topic)", "subscribe(topic)"),
			seam3Source.replace("registration.issuanceStore.compareAndMarkOutboxPublished", "compareAndMarkOutboxPublished"),
			`${seam3Source}\nconst escapedRegistrationOwner = new WeakMap();\n`,
			`${seam3Source}\nfunction deadSubscriptionDecoy() { messageQueueManager.subscribe(queueId, handler); }\n`,
		]) {
			const root = temporarySweepTree();
			addABRuntimeDependency(root);
			const manifestPath = path.join(root, "packages/node/package.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.dependencies["@ts-drp/issuance-store"] = SEAM3_RUNTIME_DEPENDENCY.manifest;
			writeFileSync(manifestPath, JSON.stringify(manifest));
			const lockPath = path.join(root, "pnpm-lock.yaml");
			writeFileSync(
				lockPath,
				readFileSync(lockPath, "utf8").replace(
					"    dependencies:\n",
					`    dependencies:\n      '@ts-drp/issuance-store':\n        specifier: ${SEAM3_RUNTIME_DEPENDENCY.manifest}\n        version: ${SEAM3_RUNTIME_DEPENDENCY.resolved}\n`
				)
			);
			writeFileSync(path.join(root, "packages/node/src/v3-live.ts"), mutant);
			emitSweepGenerated(root);
			expect(sourceSweep(root, "through-seam3").futureOrLiveEdges).not.toEqual([]);
		}
	});
});
