import { ed25519 } from "@noble/curves/ed25519.js";
import { type decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
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

type CanonicalModule = Readonly<{
	decodeCanonical: typeof decodeCanonical;
	encodeCanonical: typeof encodeCanonical;
	hashDomain: typeof hashDomain;
}> &
	Record<string, unknown>;
type ControlPlaneModule = Readonly<{ createCurrentAnchorTrustStore: typeof createCurrentAnchorTrustStore }> &
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
	anchorHashInputs: [] as readonly Uint8Array[][],
	anchorHashMismatch: false,
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
				const authenticating = stageProbe.authenticationHashDepth > 0;
				stageProbe.events.push(authenticating ? "anchor.authenticate.hash" : "anchor.hash");
				(authenticating ? stageProbe.authenticationHashInputs : stageProbe.anchorHashInputs).push(parts);
				const digest = genuine.hashDomain(domain, ...parts);
				if (!authenticating && stageProbe.anchorHashMismatch) {
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
					const result = await owner.open();
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
	"installCreatorAnchorTrustRoot",
	"isAnchorTrustStateRecordBytes",
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
	stageProbe.anchorHashMismatch = false;
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
			const result = Object.freeze({
				artifactDigest: fixture.artifactDigest,
				artifactId: fixture.artifactId,
				blueprintDigest: mutation === "catalog-blueprint" ? "f".repeat(64) : blueprintDigest,
				canonicalBlueprintPackageBytes:
					mutation === "admission-package"
						? new Uint8Array([...canonicalBlueprintPackageBytes, 0])
						: new Uint8Array(canonicalBlueprintPackageBytes),
				exactArtifactBytes:
					mutation === "runtime-artifact"
						? new Uint8Array([...exactArtifactBytes, 0x0a])
						: new Uint8Array(exactArtifactBytes),
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
		beginGeneration(input) {
			stageProbe.events.push("store.beginGeneration");
			return target.beginGeneration(input);
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

function expectFailure(result: PrepareV3LiveResult, kind: PrepareV3LiveFailureKind): void {
	expect(result).toEqual({ ok: false, kind, detail: expect.any(String) });
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
const FUTURE_OR_LIVE_IDENTIFIERS = new Set([
	"CausalityIndex",
	"WebSocket",
	"addEventListener",
	"admitReceivedVertex",
	"append",
	"assertTrustPreserved",
	"beginGeneration",
	"completeGeneration",
	"consumePreparedV3Live",
	"createAdmissionBoundTransactionalVertexIssuer",
	"callback",
	"digestBlob",
	"digestClosure",
	"dispatchMessage",
	"fetch",
	"outbox",
	"promoteGeneration",
	"putBlob",
	"queueMicrotask",
	"reducer",
	"reducers",
	"setInterval",
	"setTimeout",
	"subscribe",
	"swapHead",
	"transactIssue",
]);

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

function sourceSweep(root: string): StaticAudit {
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
	for (const [kind, dependencies] of Object.entries({
		dependencies: manifest.dependencies,
		optionalDependencies: manifest.optionalDependencies,
		peerDependencies: manifest.peerDependencies,
	})) {
		if (dependencies?.["@ts-drp/protocol-v2"] !== undefined) violations.push(`protocol-v2-manifest:${kind}`);
	}
	const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
	const nodeImporter = /^ {2}packages\/node:\n(?<body>(?: {4,}.*\n|\s*\n)*)/mu.exec(lockfile)?.groups?.body ?? "";
	if (/@ts-drp\/protocol-v2/u.test(nodeImporter)) violations.push("protocol-v2-lockfile");

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
	for (const edge of allEdges) {
		if (/^@ts-drp\/protocol-v2(?:\/|$)/u.test(edge.specifier)) {
			violations.push(edge.from === entry ? "protocol-v2-direct" : "protocol-v2-indirect");
		}
		if (/^@ts-drp\/[^/]+\//u.test(edge.specifier)) violations.push(`deep-import:${edge.specifier}`);
		if (!edge.specifier.startsWith(".")) {
			const permitted =
				A_A_RUNTIME_ROOTS.has(edge.specifier) || (edge.typeOnly && edge.specifier === "@ts-drp/blueprint-catalog");
			if (!permitted) futureOrLiveEdges.push(`import:${edge.specifier}`);
			if (A_A_RUNTIME_ROOTS.has(edge.specifier)) {
				if (manifest.dependencies?.[edge.specifier] === undefined)
					violations.push(`undeclared-runtime:${edge.specifier}`);
				if (!nodeImporter.includes(`${edge.specifier}:`)) violations.push(`unlocked-runtime:${edge.specifier}`);
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

	const inspectFutureOrLive = (filename: string): void => {
		const parsed = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
		const inspect = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && FUTURE_OR_LIVE_IDENTIFIERS.has(node.text)) {
				futureOrLiveEdges.push(`identifier:${node.text}`);
			}
			ts.forEachChild(node, inspect);
		};
		inspect(parsed);
	};
	for (const filename of sourceGraph.files) {
		inspectFutureOrLive(filename);
		if (ownsLiteralParameterRecord(filename)) violations.push("parallel-parameters-source");
	}
	for (const filename of generatedGraph.files) {
		inspectFutureOrLive(filename);
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
				"@ts-drp/control-plane": "0.11.0",
				"@ts-drp/protocol-v3": "0.11.0",
				"@ts-drp/storage": "0.11.0",
			},
			name: "@ts-drp/node",
			scripts: {},
		})
	);
	writeFileSync(
		path.join(root, "pnpm-lock.yaml"),
		"lockfileVersion: '9.0'\nimporters:\n  packages/node:\n    dependencies: {}\n"
	);
	writeFileSync(
		path.join(root, "packages/node/src/v3-live.ts"),
		`const supported = { parametersDigest: "${parameterDigest()}", runtimeProfile: "ecmascript-2024-sync-v1" };\nvoid supported;\n`
	);
	writeFileSync(
		path.join(root, "packages/node/dist/src/v3-live.js"),
		`const supported = { parametersDigest: "${parameterDigest()}", runtimeProfile: "ecmascript-2024-sync-v1" };\nvoid supported;\n`
	);
	return root;
}

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
	Reflect.deleteProperty(globalThis, LIVE_EFFECT_KEY);
});

const PRIVATE_V3_LIVE_EXPORTS = [
	"PreparedV3Live",
	"PrepareV3LiveFailureKind",
	"PrepareV3LiveGenerationInput",
	"PrepareV3LiveResult",
	"V3LiveDescriptor",
	"prepareV3LiveGeneration",
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
		expect.soft(Object.keys(surface)).toEqual(["prepareV3LiveGeneration"]);
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
		for (const filename of [
			path.join(REPOSITORY_ROOT, "packages/node/src/index.ts"),
			path.join(REPOSITORY_ROOT, "packages/node/src/runtime.ts"),
			path.join(REPOSITORY_ROOT, "packages/protocol-v3/src/public.ts"),
		]) {
			expect(
				exportedDeclarationNames(filename).filter((name) => privateNames.has(name)),
				filename
			).toEqual([]);
			expect(
				moduleSpecifiers(filename).filter((edge) => /(?:^|\/)v3-live(?:\.[cm]?[jt]s)?$/u.test(edge.specifier)),
				filename
			).toEqual([]);
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
		expectFailure(result, "graph-rejected");
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
		expect(stageProbe.authenticationHashInputs).toHaveLength(1);
		expect(stageProbe.authenticationHashInputs[0]?.[0]).toBe(authenticationInput.exactCanonicalAnchorPreimageBytes);
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
		expectFailure(result, "graph-rejected");
		expect(stageProbe.events).toEqual([
			"trust.create",
			"trust.open:start",
			"store.readHead",
			"store.recoverActiveGeneration",
			"store.getBlob",
			"trust.record.open",
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
		expect(stageProbe.authenticationHashInputs).toHaveLength(1);
		expect(stageProbe.authenticationHashInputs[0]?.[0]).toBe(
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
		expect(stageProbe.liveEffects).toEqual([]);
	});

	it("maps reachable A-a stage failures without starting a later stage or live effect", async () => {
		const cases: readonly [PrepareV3LiveFailureKind, Partial<PrepareV3LiveInput>, CatalogMutation, string, boolean?][] =
			[
				["trust-open-failed", { store: createMemoryAheDurableStore() }, "none", "trust.open:resolved"],
				["anchor-authentication-failed", { detachedSignature: new Uint8Array(64) }, "none", "anchor.authenticate"],
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

	it("uses a root-parameterized recursive hygiene sweep that kills all six owner-edge mutants", () => {
		const clean = temporarySweepTree();
		expect(sourceSweep(clean)).toEqual({ futureOrLiveEdges: [], violations: [] });
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
		const repositoryAudit = sourceSweep(REPOSITORY_ROOT);
		expect(repositoryAudit.violations).toEqual([]);
		expect(repositoryAudit.futureOrLiveEdges).toEqual([]);
	});
});
