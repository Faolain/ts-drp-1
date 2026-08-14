import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { installCreatorAnchorTrustRoot, type prepareBlueprintRuntime } from "@ts-drp/protocol-v3";
import {
	type AheDurableStore,
	createMemoryAheDurableStore,
	digestBlob,
	digestClosure,
	parseBlobDigest,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type StorageObjectId,
} from "@ts-drp/storage";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { type TrustedBlueprintCatalog } from "../packages/blueprint-catalog/src/index.js";
import type { CausalityIndex, LinearizationError } from "../packages/compaction/src/index.js";

type CompactionModule = Readonly<{
	CausalityIndex: typeof CausalityIndex;
	LinearizationError: typeof LinearizationError;
}> &
	Record<string, unknown>;
type CanonicalModule = Readonly<{ encodeCanonical: typeof encodeCanonical }> & Record<string, unknown>;
type StorageModule = Readonly<{ digestBlob: typeof digestBlob; digestClosure: typeof digestClosure }> &
	Record<string, unknown>;
type ProtocolV3Module = Readonly<{ prepareBlueprintRuntime: typeof prepareBlueprintRuntime }> & Record<string, unknown>;

const graphProbe = vi.hoisted(() => ({
	a_bCaptureActive: false,
	closureDigestDepth: 0,
	closureInputs: [] as (readonly unknown[])[],
	derivationEvents: [] as (
		| Readonly<{ readonly kind: "closure" }>
		| Readonly<{ readonly bytes: Uint8Array; readonly kind: "digest" }>
		| Readonly<{ readonly bytes: Uint8Array; readonly kind: "encode"; readonly label?: "closure" }>
		| Readonly<{ readonly kind: "index" }>
	)[],
	digestFailureBytes: undefined as Uint8Array | undefined,
	digestInputs: [] as Uint8Array[],
	encodeInputs: [] as unknown[],
	encodeOutputs: [] as Uint8Array[],
	indexCalls: [] as Readonly<{
		vertices: ReadonlyMap<string, unknown>;
		order: readonly string[] | undefined;
		options: unknown;
	}>[],
	indexTouches: [] as PropertyKey[],
	indexFailure: undefined as "graph" | "internal" | undefined,
	mutations: [] as string[],
	poisonAfterRuntime: false,
	poisonRestorers: [] as (() => void)[],
	preCaptureDerivationEvents: [] as (
		| Readonly<{ readonly bytes: Uint8Array; readonly kind: "digest" }>
		| Readonly<{ readonly bytes: Uint8Array; readonly kind: "encode" }>
		| Readonly<{ readonly kind: "closure" }>
	)[],
}));

vi.mock("@ts-drp/protocol-v3", async (importOriginal) => {
	const genuine = await importOriginal<ProtocolV3Module>();
	return {
		...genuine,
		async prepareBlueprintRuntime(
			input: Parameters<ProtocolV3Module["prepareBlueprintRuntime"]>[0]
		): Promise<Awaited<ReturnType<ProtocolV3Module["prepareBlueprintRuntime"]>>> {
			const result = await genuine.prepareBlueprintRuntime(input);
			if (!graphProbe.poisonAfterRuntime) return result;
			const define = Object.defineProperty;
			const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
			const getPrototypeOf = Object.getPrototypeOf;
			const reflectApply = Reflect.apply;
			const testBasename = "phase-3a1-ab-live-graph-red.test.ts";
			const calledDirectlyByV3Live = (): boolean => {
				const externalFrame = new Error().stack
					?.split("\n")
					.slice(1)
					.find((line) => !line.includes(testBasename) && !line.includes("node:internal"));
				return externalFrame?.includes("/packages/node/src/v3-live.ts") === true;
			};
			const patch = (owner: object, key: PropertyKey, descriptor: PropertyDescriptor): void => {
				const original = getOwnPropertyDescriptor(owner, key);
				if (original === undefined) throw new TypeError(`missing intrinsic ${String(key)}`);
				define(owner, key, descriptor);
				graphProbe.poisonRestorers.push(() => define(owner, key, original));
			};
			const scopedFunction = (original: (...input: readonly unknown[]) => unknown) => {
				return function scopedPoison(this: unknown, ...input: readonly unknown[]): unknown {
					if (calledDirectlyByV3Live()) throw new Error("post-import v3-live intrinsic lookup");
					return reflectApply(original, this, input);
				};
			};
			const asIntrinsic = (value: unknown): ((...input: readonly unknown[]) => unknown) =>
				value as (...input: readonly unknown[]) => unknown;
			for (const key of ["get", "has", "set", "keys", "entries"] as const) {
				const original = getOwnPropertyDescriptor(Map.prototype, key)?.value as
					| ((...input: readonly unknown[]) => unknown)
					| undefined;
				if (original === undefined) throw new TypeError(`missing intrinsic ${key}`);
				patch(Map.prototype, key, { configurable: true, value: scopedFunction(original), writable: true });
			}
			patch(Array, "isArray", {
				configurable: true,
				value: scopedFunction(asIntrinsic(Array.isArray)),
				writable: true,
			});
			for (const key of ["create", "freeze", "getOwnPropertyDescriptor", "getPrototypeOf"] as const) {
				patch(Object, key, { configurable: true, value: scopedFunction(asIntrinsic(Object[key])), writable: true });
			}
			for (const key of ["apply", "ownKeys"] as const) {
				patch(Reflect, key, { configurable: true, value: scopedFunction(asIntrinsic(Reflect[key])), writable: true });
			}
			const typedArrayPrototype = getPrototypeOf(Uint8Array.prototype) as object;
			for (const key of ["buffer", "byteLength"] as const) {
				const original = getOwnPropertyDescriptor(typedArrayPrototype, key);
				if (original?.get === undefined) throw new TypeError(`missing typed-array intrinsic ${key}`);
				const originalGet = original.get;
				patch(typedArrayPrototype, key, {
					...original,
					get(this: Uint8Array): unknown {
						if (calledDirectlyByV3Live()) throw new Error("post-import v3-live typed-array lookup");
						return reflectApply(originalGet, this, []);
					},
				});
			}
			patch(Object, "defineProperty", {
				configurable: true,
				value: scopedFunction(asIntrinsic(define)),
				writable: true,
			});
			return result;
		},
	};
});

vi.mock("@ts-drp/canonical", async (importOriginal) => {
	const genuine = await importOriginal<CanonicalModule>();
	return {
		...genuine,
		encodeCanonical(value: unknown): Uint8Array {
			const bytes = genuine.encodeCanonical(value);
			const copied = new Uint8Array(bytes);
			if (!graphProbe.a_bCaptureActive) {
				graphProbe.preCaptureDerivationEvents.push({ bytes: copied, kind: "encode" });
				return bytes;
			}
			graphProbe.encodeInputs.push(value);
			graphProbe.encodeOutputs.push(copied);
			graphProbe.derivationEvents.push({
				bytes: copied,
				kind: "encode",
				...(graphProbe.closureDigestDepth > 0 ? { label: "closure" as const } : {}),
			});
			return bytes;
		},
	};
});

vi.mock("@ts-drp/storage", async (importOriginal) => {
	const genuine = await importOriginal<StorageModule>();
	return {
		...genuine,
		digestBlob(bytes: Uint8Array): ReturnType<StorageModule["digestBlob"]> {
			const copied = new Uint8Array(bytes);
			if (!graphProbe.a_bCaptureActive) {
				graphProbe.preCaptureDerivationEvents.push({ bytes: copied, kind: "digest" });
				return genuine.digestBlob(bytes);
			}
			graphProbe.digestInputs.push(copied);
			graphProbe.derivationEvents.push({ bytes: copied, kind: "digest" });
			if (
				graphProbe.digestFailureBytes !== undefined &&
				copied.byteLength === graphProbe.digestFailureBytes.byteLength &&
				copied.every((byte, index) => byte === graphProbe.digestFailureBytes?.[index])
			) {
				return { ok: false, reason: "INVALID_ARGUMENT" };
			}
			return genuine.digestBlob(bytes);
		},
		digestClosure(closure: Parameters<StorageModule["digestClosure"]>[0]): ReturnType<StorageModule["digestClosure"]> {
			if (!graphProbe.a_bCaptureActive) {
				graphProbe.preCaptureDerivationEvents.push({ kind: "closure" });
				return genuine.digestClosure(closure);
			}
			graphProbe.closureInputs.push(closure);
			graphProbe.derivationEvents.push({ kind: "closure" });
			graphProbe.closureDigestDepth += 1;
			try {
				return genuine.digestClosure(closure);
			} finally {
				graphProbe.closureDigestDepth -= 1;
			}
		},
	};
});

vi.mock("@ts-drp/compaction", async (importOriginal) => {
	const genuine = await importOriginal<CompactionModule>();
	return {
		...genuine,
		CausalityIndex: class InstrumentedCausalityIndex extends genuine.CausalityIndex {
			constructor(
				vertices: ConstructorParameters<typeof genuine.CausalityIndex>[0],
				order?: ConstructorParameters<typeof genuine.CausalityIndex>[1],
				options: ConstructorParameters<typeof genuine.CausalityIndex>[2] = {}
			) {
				if (!graphProbe.a_bCaptureActive) {
					graphProbe.closureInputs.length = 0;
					graphProbe.derivationEvents.length = 0;
					graphProbe.digestInputs.length = 0;
					graphProbe.encodeInputs.length = 0;
					graphProbe.encodeOutputs.length = 0;
					graphProbe.indexCalls.length = 0;
					graphProbe.a_bCaptureActive = true;
				}
				graphProbe.derivationEvents.push({ kind: "index" });
				graphProbe.indexCalls.push({ options, order, vertices });
				if (graphProbe.indexFailure === "graph") {
					throw new genuine.LinearizationError("INVALID_ORDER", "synthetic known graph rejection");
				}
				if (graphProbe.indexFailure === "internal") throw new Error("synthetic unclassifiable graph failure");
				super(vertices, order, options);
				return new Proxy(this, {
					get(target, property, receiver): unknown {
						graphProbe.indexTouches.push(property);
						return Reflect.get(target, property, receiver) as unknown;
					},
				});
			}
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

type PrepareResult =
	| Readonly<{ readonly ok: true; readonly capability: unknown; readonly descriptor: unknown }>
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

interface FixtureContext {
	readonly input: PrepareInput;
	readonly material: CreatorMaterial;
	readonly trustRef: Readonly<{ readonly byteLength: number; readonly digest: string }>;
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
const CANDIDATE_GRAPH_SOURCE_MARKERS = [
	"@ts-drp/compaction",
	"Map.prototype.get",
	"Map.prototype.has",
	"Map.prototype.set",
	"Map.prototype.keys",
	"Map.prototype.entries",
	"Array.isArray",
	"Object.create",
	"Object.defineProperty",
	"Object.freeze",
	"Object.getOwnPropertyDescriptor",
	"Object.getPrototypeOf",
	"Reflect.apply",
	"Reflect.ownKeys",
	"digestBlob",
	"digestClosure",
] as const;
const ORDER_PREIMAGE_FIELDS = ["kind", "orderedVertexHashes"] as const;
const GRAPH_PREIMAGE_FIELDS = ["kind", "vertices", "charges"] as const;
const GRAPH_VERTEX_FIELDS = ["hash", "kind", "objectId", "epoch", "dependencies"] as const;
const GRAPH_CHARGE_FIELDS = ["hash", "byteCharge"] as const;
const PROJECTION_FIELDS = [
	"kind",
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
	"maxEpochVertices",
	"maxEpochBytes",
	"maxDependencies",
	"vertexCount",
	"byteCharge",
	"orderedVertexHashesDigest",
	"graphDigest",
] as const;
const OWNER_DERIVATION_STEPS = [
	"map",
	"map",
	"index",
	"record:order",
	"record:graph",
	"encode:order",
	"encode:graph",
	"digest:order",
	"digest:graph",
	"record:projection",
	"encode:projection",
	"digest:projection",
	"closure",
] as const;
const EXACT_A_B_DERIVATION_EVENTS = [
	"index",
	"encode:order",
	"encode:graph",
	"digest:order",
	"digest:graph",
	"encode:projection",
	"digest:projection",
	"closure",
	"encode:closure",
] as const;

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

function strictTrustStore(material: CreatorMaterial): {
	readonly store: AheDurableStore;
	readonly trustRef: Readonly<{ readonly byteLength: number; readonly digest: string }>;
} {
	const installed = installCreatorAnchorTrustRoot({
		detachedGenesisSignature: material.signature,
		exactCanonicalGenesisAnchorPreimageBytes: material.anchorBytes,
		exactCanonicalProfileBytes: material.profileBytes,
		exactCanonicalSignerSetBytes: material.signerSetBytes,
		pinnedGenesisAnchorDigest: material.anchorDigest,
	});
	if (!installed.ok) throw new TypeError(`invalid trust fixture: ${installed.reason}`);
	const trustBytes = installed.exactCanonicalTrustStateRecordBytes;
	const trustRef = Object.freeze({ byteLength: trustBytes.byteLength, digest: must(digestBlob(trustBytes)) });
	const objectId = must(parseStorageObjectId(String(material.anchor.objectId)));
	const generationId = must(parseGenerationId("a".repeat(64)));
	const closureDigest = must(digestClosure([trustRef]));
	const revision = must(parseHeadRevision(1));
	const head = Object.freeze({ kind: "present" as const, closureDigest, generationId, objectId, revision });
	const target = createMemoryAheDurableStore();
	const store = Object.freeze({
		capabilities: Object.freeze({ durability: "strict", signingEligibility: "backend-capability-required" }),
		readHead(_objectId: Parameters<AheDurableStore["readHead"]>[0]): ReturnType<AheDurableStore["readHead"]> {
			return Promise.resolve({ ok: true as const, value: head });
		},
		readGenerationPage(
			input: Parameters<AheDurableStore["readGenerationPage"]>[0]
		): ReturnType<AheDurableStore["readGenerationPage"]> {
			return target.readGenerationPage(input);
		},
		recoverActiveGeneration(
			_objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0]
		): ReturnType<AheDurableStore["recoverActiveGeneration"]> {
			return Promise.resolve({
				ok: true as const,
				value: Object.freeze({
					kind: "active",
					head,
					adoptedGeneration: Object.freeze({
						baseExpectedHead: Object.freeze({ kind: "none" as const, objectId }),
						closure: Object.freeze([trustRef]),
						closureDigest,
						generationId,
						objectId,
						state: "Adopted" as const,
					}),
					recomputedClosureDigest: closureDigest,
					references: Object.freeze([trustRef]),
				}),
			});
		},
		getBlob(_digest: Parameters<AheDurableStore["getBlob"]>[0]): ReturnType<AheDurableStore["getBlob"]> {
			return Promise.resolve({ ok: true, value: new Uint8Array(trustBytes) });
		},
		beginGeneration(
			input: Parameters<AheDurableStore["beginGeneration"]>[0]
		): ReturnType<AheDurableStore["beginGeneration"]> {
			graphProbe.mutations.push("beginGeneration");
			return target.beginGeneration(input);
		},
		putCachedBlob(
			input: Parameters<AheDurableStore["putCachedBlob"]>[0]
		): ReturnType<AheDurableStore["putCachedBlob"]> {
			graphProbe.mutations.push("putCachedBlob");
			return target.putCachedBlob(input);
		},
		promoteReference(
			input: Parameters<AheDurableStore["promoteReference"]>[0]
		): ReturnType<AheDurableStore["promoteReference"]> {
			graphProbe.mutations.push("promoteReference");
			return target.promoteReference(input);
		},
		completeGeneration(
			input: Parameters<AheDurableStore["completeGeneration"]>[0]
		): ReturnType<AheDurableStore["completeGeneration"]> {
			graphProbe.mutations.push("completeGeneration");
			return target.completeGeneration(input);
		},
		swapHead(input: Parameters<AheDurableStore["swapHead"]>[0]): ReturnType<AheDurableStore["swapHead"]> {
			graphProbe.mutations.push("swapHead");
			return target.swapHead(input);
		},
		discardGeneration(
			input: Parameters<AheDurableStore["discardGeneration"]>[0]
		): ReturnType<AheDurableStore["discardGeneration"]> {
			graphProbe.mutations.push("discardGeneration");
			return target.discardGeneration(input);
		},
		close(): ReturnType<AheDurableStore["close"]> {
			return target.close();
		},
	} satisfies AheDurableStore);
	return { store, trustRef };
}

function catalog(): TrustedBlueprintCatalog {
	const fixture = blueprintFixture();
	const catalogDigest = "9".repeat(64);
	return Object.freeze({
		blueprintDigests: Object.freeze([fixture.blueprintDigest]),
		catalogDigest,
		resolve(requested: string) {
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
					engines: Object.freeze(
						(["node", "chromium", "firefox", "webkit"] as const).map((name) =>
							Object.freeze({ name, build: `phase-3a1-ab-${name}` })
						)
					),
				}),
			});
		},
	});
}

function fixtureContext(): FixtureContext {
	const material = liveMaterial();
	const { store, trustRef } = strictTrustStore(material);
	return {
		material,
		trustRef,
		input: Object.freeze({
			authenticationProfile: "creator-only",
			store,
			objectId: must(parseStorageObjectId(String(material.anchor.objectId))),
			pinnedGenesisAnchorDigest: material.anchorDigest,
			exactCanonicalAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
			detachedSignature: new Uint8Array(material.signature),
			exactCanonicalParametersCarrierBytes: encodeCanonical(PARAMETERS),
			catalog: catalog(),
		}),
	};
}

async function moduleSurface(): Promise<PrivateSurface> {
	return (await import(`${pathToFileURL(IMPLEMENTATION).href}?phase-3a1-ab`)) as PrivateSurface;
}

async function prepare(context: FixtureContext): Promise<PrepareResult> {
	const surface = await moduleSurface();
	if (surface.prepareV3LiveGeneration === undefined) throw new TypeError("missing private preparation API");
	return surface.prepareV3LiveGeneration(context.input);
}

function capturedA_bDigests(): readonly Uint8Array[] {
	return graphProbe.digestInputs.filter((bytes) => {
		const hex = lowerHex(bytes);
		return [golden.orderPreimageHex, golden.graphPreimageHex, golden.projectionHex].includes(hex);
	});
}

function refSnapshot(value: unknown): Readonly<{ readonly digest: string; readonly byteLength: number }> | undefined {
	if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype)
		return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== 2 || keys[0] !== "digest" || keys[1] !== "byteLength") return undefined;
	const digest = Object.getOwnPropertyDescriptor(value, "digest");
	const byteLength = Object.getOwnPropertyDescriptor(value, "byteLength");
	if (digest === undefined || !("value" in digest) || byteLength === undefined || !("value" in byteLength)) {
		return undefined;
	}
	return { digest: digest.value as string, byteLength: byteLength.value as number };
}

function exactGoldenOracle(candidate: typeof golden): boolean {
	const orderBytes = bytesFromHex(candidate.orderPreimageHex);
	const graphBytes = bytesFromHex(candidate.graphPreimageHex);
	const projectionBytes = bytesFromHex(candidate.projectionHex);
	return (
		must(digestBlob(orderBytes)) === candidate.orderedVertexHashesDigest &&
		must(digestBlob(graphBytes)) === candidate.graphDigest &&
		must(digestBlob(projectionBytes)) === candidate.projectionDigest &&
		projectionBytes.byteLength === candidate.projectionByteLength
	);
}

function exactClosureOracle(value: unknown): boolean {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2) return false;
	if (!Reflect.ownKeys(value).every((key, index) => key === ["0", "1", "length"][index])) return false;
	const left = refSnapshot(value[0]);
	const right = refSnapshot(value[1]);
	const isExactRef = (ref: typeof left): ref is Readonly<{ readonly digest: string; readonly byteLength: number }> =>
		ref !== undefined &&
		typeof ref.digest === "string" &&
		/^[0-9a-f]{64}$/u.test(ref.digest) &&
		Number.isSafeInteger(ref.byteLength) &&
		ref.byteLength > 0;
	return isExactRef(left) && isExactRef(right) && left.digest < right.digest;
}

function exactOwnerMap(value: unknown, expectedKey: string): boolean {
	if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Map.prototype) return false;
	if (Reflect.ownKeys(value).length !== 0) return false;
	const sizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get;
	if (sizeGetter === undefined) return false;
	try {
		return (
			Reflect.apply(sizeGetter, value, []) === 1 && Reflect.apply(Map.prototype.has, value, [expectedKey]) === true
		);
	} catch {
		return false;
	}
}

function sourcePropertyName(property: ts.ObjectLiteralElementLike): string | undefined {
	return ts.isShorthandPropertyAssignment(property)
		? property.name.text
		: ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
			? property.name.text
			: undefined;
}

function sourceLiteralFields(value: ts.ObjectLiteralExpression): readonly string[] {
	return value.properties.map((property) => sourcePropertyName(property) ?? "<non-data>");
}

function sourceNestedLiteralFields(
	value: ts.ObjectLiteralExpression,
	arrayPropertyName: string
): readonly string[] | undefined {
	const property = value.properties.find(
		(candidate): candidate is ts.PropertyAssignment =>
			ts.isPropertyAssignment(candidate) &&
			sourcePropertyName(candidate) === arrayPropertyName &&
			ts.isArrayLiteralExpression(candidate.initializer)
	);
	const first =
		property !== undefined && ts.isArrayLiteralExpression(property.initializer)
			? property.initializer.elements[0]
			: undefined;
	return first !== undefined && ts.isObjectLiteralExpression(first) ? sourceLiteralFields(first) : undefined;
}

function ownerDerivationSourceShape(
	sourceText: string,
	capturedMapName: string
):
	| Readonly<{
			readonly chargeFields: readonly string[];
			readonly graphFields: readonly string[];
			readonly orderFields: readonly string[];
			readonly projectionFields: readonly string[];
			readonly steps: readonly string[];
			readonly vertexFields: readonly string[];
	  }>
	| undefined {
	const source = ts.createSourceFile(IMPLEMENTATION, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const owners = source.statements.filter(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === "prepareV3LiveGeneration"
	);
	if (owners.length !== 1 || owners[0]?.body === undefined) return undefined;
	const owner = owners[0];
	const ownerBody = owner.body;
	if (
		ownerBody === undefined ||
		owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true
	) {
		return undefined;
	}
	const terminal = ownerBody.statements[ownerBody.statements.length - 1];
	if (
		terminal === undefined ||
		!ts.isReturnStatement(terminal) ||
		terminal.expression === undefined ||
		!ts.isCallExpression(terminal.expression) ||
		!ts.isIdentifier(terminal.expression.expression) ||
		terminal.expression.expression.text !== "failure" ||
		terminal.expression.arguments[0] === undefined ||
		!ts.isStringLiteral(terminal.expression.arguments[0]) ||
		terminal.expression.arguments[0].text !== "trust-not-preserved"
	) {
		return undefined;
	}
	const statementMayFallThrough = (statement: ts.Statement): boolean => {
		if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return false;
		if (ts.isBlock(statement)) return statement.statements.every(statementMayFallThrough);
		if (ts.isTryStatement(statement)) {
			const finallyFallsThrough =
				statement.finallyBlock === undefined || statementMayFallThrough(statement.finallyBlock);
			if (!finallyFallsThrough) return false;
			const tryFallsThrough = statementMayFallThrough(statement.tryBlock);
			return statement.catchClause === undefined
				? tryFallsThrough
				: tryFallsThrough || statementMayFallThrough(statement.catchClause.block);
		}
		if (ts.isIfStatement(statement)) {
			if (statement.expression.kind === ts.SyntaxKind.TrueKeyword) {
				return statementMayFallThrough(statement.thenStatement);
			}
			if (statement.expression.kind === ts.SyntaxKind.FalseKeyword) {
				return statement.elseStatement === undefined || statementMayFallThrough(statement.elseStatement);
			}
			return (
				statementMayFallThrough(statement.thenStatement) ||
				statement.elseStatement === undefined ||
				statementMayFallThrough(statement.elseStatement)
			);
		}
		return true;
	};
	const reachableStatements: ts.Statement[] = [];
	const collectSuccessPath = (block: ts.Block): boolean => {
		for (const statement of block.statements) {
			if (ts.isTryStatement(statement)) {
				const tryFallsThrough = collectSuccessPath(statement.tryBlock);
				const finallyFallsThrough = statement.finallyBlock === undefined || collectSuccessPath(statement.finallyBlock);
				const catchFallsThrough =
					statement.catchClause !== undefined && statementMayFallThrough(statement.catchClause.block);
				if (!finallyFallsThrough || (!tryFallsThrough && !catchFallsThrough)) return false;
				continue;
			}
			if (ts.isBlock(statement)) {
				if (!collectSuccessPath(statement)) return false;
				continue;
			}
			if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
				reachableStatements.push(statement);
				return false;
			}
			if (
				ts.isIfStatement(statement) ||
				ts.isSwitchStatement(statement) ||
				ts.isForStatement(statement) ||
				ts.isForInStatement(statement) ||
				ts.isForOfStatement(statement) ||
				ts.isWhileStatement(statement) ||
				ts.isDoStatement(statement) ||
				ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement)
			) {
				if (!statementMayFallThrough(statement)) return false;
				continue;
			}
			reachableStatements.push(statement);
		}
		return true;
	};
	collectSuccessPath(ownerBody);
	const reachableNodes = new Set<ts.Node>();
	const markReachable = (node: ts.Node): void => {
		if (ts.isFunctionLike(node)) return;
		reachableNodes.add(node);
		ts.forEachChild(node, markReachable);
	};
	for (const statement of reachableStatements) markReachable(statement);
	const isDerivationOperation = (node: ts.Node): boolean =>
		(ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			(node.expression.text === capturedMapName || node.expression.text === "CausalityIndex")) ||
		(ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			["encodeCanonical", "digestBlob", "digestClosure"].includes(node.expression.text));
	let unreachableDerivation = false;
	const inspectAllOwnerNodes = (node: ts.Node): void => {
		if (isDerivationOperation(node) && !reachableNodes.has(node)) unreachableDerivation = true;
		ts.forEachChild(node, inspectAllOwnerNodes);
	};
	inspectAllOwnerNodes(ownerBody);
	if (unreachableDerivation) return undefined;
	const declarations = new Map<string, ts.VariableDeclaration[]>();
	const steps: Readonly<{ readonly position: number; readonly step: string }>[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			const matches = declarations.get(node.name.text) ?? [];
			matches.push(node);
			declarations.set(node.name.text, matches);
		}
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === capturedMapName) {
			steps.push({ position: node.getStart(source), step: "map" });
		}
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "CausalityIndex") {
			steps.push({ position: node.getStart(source), step: "index" });
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length === 1) {
			const argument = node.arguments[0];
			if (ts.isIdentifier(argument)) {
				const labels: Readonly<Record<string, string>> = {
					exactGraphChargePreimageBytes: "graph",
					exactOrderPreimageBytes: "order",
					exactProjectionBytes: "projection",
				};
				const label = labels[argument.text];
				if (node.expression.text === "digestBlob" && label !== undefined) {
					steps.push({ position: node.getStart(source), step: `digest:${label}` });
				}
				if (node.expression.text === "digestClosure") {
					steps.push({ position: node.getStart(source), step: "closure" });
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	for (const statement of reachableStatements) visit(statement);
	const uniqueDeclaration = (name: string): ts.VariableDeclaration | undefined => {
		const matches = declarations.get(name);
		return matches?.length === 1 ? matches[0] : undefined;
	};
	const encodedLiteral = (bytesName: string, label: string): ts.ObjectLiteralExpression | undefined => {
		const bytes = uniqueDeclaration(bytesName);
		if (
			bytes?.initializer === undefined ||
			!ts.isCallExpression(bytes.initializer) ||
			!ts.isIdentifier(bytes.initializer.expression) ||
			bytes.initializer.expression.text !== "encodeCanonical" ||
			bytes.initializer.arguments.length !== 1 ||
			!ts.isIdentifier(bytes.initializer.arguments[0])
		) {
			return undefined;
		}
		const record = uniqueDeclaration(bytes.initializer.arguments[0].text);
		if (record?.initializer === undefined || !ts.isObjectLiteralExpression(record.initializer)) return undefined;
		steps.push({ position: record.getStart(source), step: `record:${label}` });
		steps.push({ position: bytes.initializer.getStart(source), step: `encode:${label}` });
		return record.initializer;
	};
	const order = encodedLiteral("exactOrderPreimageBytes", "order");
	const graph = encodedLiteral("exactGraphChargePreimageBytes", "graph");
	const projection = encodedLiteral("exactProjectionBytes", "projection");
	if (order === undefined || graph === undefined || projection === undefined) return undefined;
	const vertexFields = sourceNestedLiteralFields(graph, "vertices");
	const chargeFields = sourceNestedLiteralFields(graph, "charges");
	if (vertexFields === undefined || chargeFields === undefined) return undefined;
	return {
		chargeFields,
		graphFields: sourceLiteralFields(graph),
		orderFields: sourceLiteralFields(order),
		projectionFields: sourceLiteralFields(projection),
		steps: steps
			.slice()
			.sort((left, right) => left.position - right.position)
			.map(({ step }) => step),
		vertexFields,
	};
}

function ownDataFields(value: unknown): readonly string[] | undefined {
	if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype)
		return undefined;
	const keys = Reflect.ownKeys(value);
	if (!keys.every((key) => typeof key === "string")) return undefined;
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
	}
	return keys as string[];
}

function canonicalInputForHex(hex: string): unknown {
	const matches = graphProbe.encodeOutputs.flatMap((bytes, index) =>
		lowerHex(bytes) === hex ? [graphProbe.encodeInputs[index]] : []
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function capturedMapConstructorOwner(sourceText: string):
	| Readonly<{
			readonly capturedName: string;
			readonly directConstructions: number;
			readonly ownedConstructions: number;
	  }>
	| undefined {
	const source = ts.createSourceFile(IMPLEMENTATION, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const captures = source.statements.flatMap((statement) => {
		if (!ts.isVariableStatement(statement)) return [];
		if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return [];
		return statement.declarationList.declarations.flatMap((declaration) =>
			ts.isIdentifier(declaration.name) &&
			declaration.initializer !== undefined &&
			ts.isIdentifier(declaration.initializer) &&
			declaration.initializer.text === "Map"
				? [declaration.name.text]
				: []
		);
	});
	if (captures.length !== 1) return undefined;
	const capturedName = captures[0] as string;
	let directConstructions = 0;
	let ownedConstructions = 0;
	let inOwner = false;
	const visit = (node: ts.Node): void => {
		const wasInOwner = inOwner;
		if (
			(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
			node.name !== undefined &&
			ts.isIdentifier(node.name) &&
			node.name.text === "prepareV3LiveGeneration"
		) {
			inOwner = true;
		}
		if (inOwner && ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
			if (node.expression.text === "Map") directConstructions += 1;
			if (node.expression.text === capturedName) ownedConstructions += 1;
		}
		ts.forEachChild(node, visit);
		inOwner = wasInOwner;
	};
	visit(source);
	return { capturedName, directConstructions, ownedConstructions };
}

function resetDerivationProbe(): void {
	graphProbe.a_bCaptureActive = false;
	graphProbe.closureDigestDepth = 0;
	graphProbe.closureInputs.length = 0;
	graphProbe.derivationEvents.length = 0;
	graphProbe.digestFailureBytes = undefined;
	graphProbe.digestInputs.length = 0;
	graphProbe.encodeInputs.length = 0;
	graphProbe.encodeOutputs.length = 0;
	graphProbe.indexCalls.length = 0;
	graphProbe.preCaptureDerivationEvents.length = 0;
}

function rawDerivationEventLabels(): readonly string[] {
	const exactPreimages = new Map<string, string>([
		[golden.orderPreimageHex, "order"],
		[golden.graphPreimageHex, "graph"],
		[golden.projectionHex, "projection"],
	]);
	return graphProbe.derivationEvents.map((event) => {
		if (event.kind !== "digest" && event.kind !== "encode") return event.kind;
		if (event.kind === "encode" && event.label === "closure") return "encode:closure";
		const hex = lowerHex(event.bytes);
		const name = exactPreimages.get(hex) ?? `unknown:${hex}`;
		return `${event.kind}:${name}`;
	});
}

function ownerSourceOracleFixture(
	mode: "branch" | "nested-fallthrough" | "nested-terminating" | "post-exit" | "reachable"
): string {
	const derivation = `
		const vertices = new CapturedMap();
		const charges = new CapturedMap();
		const index = new CausalityIndex(vertices, [], { initialByteCharges: charges });
		const orderRecord = { kind: "v3-live-order-1", orderedVertexHashes: [] };
		const graphRecord = {
			kind: "v3-live-graph-1",
			vertices: [{ hash: "a", kind: "drp-epoch-anchor", objectId: "o", epoch: 0, dependencies: [] }],
			charges: [{ hash: "a", byteCharge: 1 }],
		};
		const exactOrderPreimageBytes = encodeCanonical(orderRecord);
		const exactGraphChargePreimageBytes = encodeCanonical(graphRecord);
		const orderDigest = digestBlob(exactOrderPreimageBytes);
		const graphDigest = digestBlob(exactGraphChargePreimageBytes);
		const projectionRecord = { kind: "v3-live-generation-1", graphDigest, orderDigest };
		const exactProjectionBytes = encodeCanonical(projectionRecord);
		const projectionDigest = digestBlob(exactProjectionBytes);
		const refs = [projectionDigest];
		const closure = digestClosure(refs);
	`;
	return `
		const CapturedMap = Map;
		export async function prepareV3LiveGeneration() {
			${mode === "branch" ? `if (false) {${derivation}}` : ""}
			${
				mode === "nested-terminating"
					? `if (condition) {
						try { return failure("graph-rejected", "early"); } catch { throw new Error("caught"); }
					} else {
						try { throw new Error("early"); } finally { return failure("graph-rejected", "finally"); }
					}${derivation}`
					: ""
			}
			${
				mode === "nested-fallthrough"
					? `if (condition) {
						try { const marker = true; } catch { return failure("graph-rejected", "caught"); } finally { const cleanup = true; }
					}${derivation}`
					: ""
			}
			${mode === "post-exit" ? `return failure("graph-rejected", "early");${derivation}` : ""}
			${mode === "reachable" ? derivation : ""}
			return failure("trust-not-preserved", "fixture");
		}
	`;
}

beforeEach(() => {
	graphProbe.a_bCaptureActive = false;
	graphProbe.closureDigestDepth = 0;
	graphProbe.closureInputs.length = 0;
	graphProbe.derivationEvents.length = 0;
	graphProbe.digestFailureBytes = undefined;
	graphProbe.digestInputs.length = 0;
	graphProbe.encodeInputs.length = 0;
	graphProbe.encodeOutputs.length = 0;
	graphProbe.indexCalls.length = 0;
	graphProbe.indexTouches.length = 0;
	graphProbe.indexFailure = undefined;
	graphProbe.mutations.length = 0;
	graphProbe.poisonAfterRuntime = false;
	graphProbe.preCaptureDerivationEvents.length = 0;
	for (const restore of graphProbe.poisonRestorers.splice(0).reverse()) restore();
});

describe.sequential("Phase 3a-1A-b owned graph and projection RED", () => {
	it("constructs the exact anchor-only owner graph, order, charges and discards one genuine validation index", async () => {
		const context = fixtureContext();
		resetDerivationProbe();
		const result = await prepare(context);
		expect(result).toEqual({ ok: false, kind: "trust-not-preserved", detail: expect.any(String) });
		expect(graphProbe.indexCalls).toHaveLength(1);
		const call = graphProbe.indexCalls[0] as {
			readonly vertices: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
			readonly order: readonly string[];
			readonly options: {
				readonly initialByteCharges: ReadonlyMap<string, number>;
				readonly maxEpochBytes: number;
				readonly maxEpochVertices: number;
			};
		};
		expect(call.vertices.constructor).toBe(Map);
		expect(Object.getPrototypeOf(call.vertices)).toBe(Map.prototype);
		expect(call.order).toEqual([context.material.anchorDigest]);
		expect(call.vertices.size).toBe(1);
		expect(call.vertices.get(context.material.anchorDigest)).toEqual({
			hash: context.material.anchorDigest,
			kind: "drp-epoch-anchor",
			objectId: context.input.objectId,
			epoch: 0,
			dependencies: [],
		});
		expect(call.options.initialByteCharges.constructor).toBe(Map);
		expect([...call.options.initialByteCharges]).toEqual([
			[context.material.anchorDigest, context.material.anchorBytes.byteLength],
		]);
		expect([...call.vertices.keys()]).toEqual(call.order);
		expect([...call.options.initialByteCharges.keys()]).toEqual(call.order);
		expect(call.options.maxEpochBytes).toBe(PARAMETERS.maxEpochBytes);
		expect(call.options.maxEpochVertices).toBe(PARAMETERS.maxEpochVertices);
		expect(context.material.anchorBytes.byteLength).toBeLessThanOrEqual(PARAMETERS.maxEpochBytes);
		expect(call.vertices.size).toBeLessThanOrEqual(PARAMETERS.maxEpochVertices);
		expect(graphProbe.indexTouches).toEqual([]);
		expect(graphProbe.mutations).toEqual([]);
	});

	it("emits the two exact canonical preimages and storage-domain digest values", async () => {
		const context = fixtureContext();
		resetDerivationProbe();
		await prepare(context);
		const genuineStorage = await vi.importActual<StorageModule>("@ts-drp/storage");
		expect(capturedA_bDigests().map(lowerHex)).toEqual([
			golden.orderPreimageHex,
			golden.graphPreimageHex,
			golden.projectionHex,
		]);
		expect(must(genuineStorage.digestBlob(bytesFromHex(golden.orderPreimageHex)))).toBe(
			golden.orderedVertexHashesDigest
		);
		expect(must(genuineStorage.digestBlob(bytesFromHex(golden.graphPreimageHex)))).toBe(golden.graphDigest);
		expect(graphProbe.preCaptureDerivationEvents.some((event) => event.kind === "encode")).toBe(true);
		expect(rawDerivationEventLabels()).toEqual(EXACT_A_B_DERIVATION_EVENTS);
	});

	it("derives the exact twenty-field projection bytes, blob ref and dense sorted detached two-ref closure", async () => {
		const context = fixtureContext();
		resetDerivationProbe();
		const result = await prepare(context);
		expect(result).toEqual({ ok: false, kind: "trust-not-preserved", detail: expect.any(String) });
		expect(must(digestBlob(bytesFromHex(golden.projectionHex)))).toBe(golden.projectionDigest);
		expect(graphProbe.closureInputs).toHaveLength(1);
		const closure = graphProbe.closureInputs[0] as readonly unknown[];
		expect(Array.isArray(closure)).toBe(true);
		expect(Object.getPrototypeOf(closure)).toBe(Array.prototype);
		expect(Reflect.ownKeys(closure)).toEqual(["0", "1", "length"]);
		const refs = closure.map(refSnapshot);
		expect(refs).not.toContain(undefined);
		expect(refs).toEqual(
			[
				{ digest: context.trustRef.digest, byteLength: context.trustRef.byteLength },
				{ digest: golden.projectionDigest, byteLength: golden.projectionByteLength },
			].sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0))
		);
		expect(closure[0]).not.toBe(context.trustRef);
		expect(closure[1]).not.toBe(context.trustRef);
		expect(new Set(refs.map((ref) => ref?.digest)).size).toBe(2);
		expect(graphProbe.mutations).toEqual([]);
	});

	it("captures every required graph intrinsic and contains post-import Map prototype poisoning", async () => {
		const source = readFileSync(IMPLEMENTATION, "utf8");
		const context = fixtureContext();
		const surface = await moduleSurface();
		if (surface.prepareV3LiveGeneration === undefined) throw new TypeError("missing private preparation API");
		resetDerivationProbe();
		graphProbe.poisonAfterRuntime = true;
		let result: PrepareResult;
		try {
			result = await surface.prepareV3LiveGeneration(context.input);
		} finally {
			for (const restore of graphProbe.poisonRestorers.splice(0).reverse()) restore();
		}
		for (const marker of CANDIDATE_GRAPH_SOURCE_MARKERS) expect(source.includes(marker), marker).toBe(true);
		const capturedMap = capturedMapConstructorOwner(source);
		expect(capturedMap).toEqual({
			capturedName: expect.any(String),
			directConstructions: 0,
			ownedConstructions: 2,
		});
		const sourceShape = ownerDerivationSourceShape(source, capturedMap?.capturedName ?? "<missing>");
		expect(sourceShape).toEqual({
			chargeFields: GRAPH_CHARGE_FIELDS,
			graphFields: GRAPH_PREIMAGE_FIELDS,
			orderFields: ORDER_PREIMAGE_FIELDS,
			projectionFields: PROJECTION_FIELDS,
			steps: OWNER_DERIVATION_STEPS,
			vertexFields: GRAPH_VERTEX_FIELDS,
		});
		const orderPreimage = canonicalInputForHex(golden.orderPreimageHex) as Record<string, unknown> | undefined;
		const graphPreimage = canonicalInputForHex(golden.graphPreimageHex) as Record<string, unknown> | undefined;
		const projection = canonicalInputForHex(golden.projectionHex);
		expect(ownDataFields(orderPreimage)).toEqual(ORDER_PREIMAGE_FIELDS);
		expect(Reflect.ownKeys(orderPreimage?.orderedVertexHashes ?? {})).toEqual(["0", "length"]);
		expect(ownDataFields(graphPreimage)).toEqual(GRAPH_PREIMAGE_FIELDS);
		const vertices = graphPreimage?.vertices as readonly unknown[] | undefined;
		const charges = graphPreimage?.charges as readonly unknown[] | undefined;
		expect(Reflect.ownKeys(vertices ?? {})).toEqual(["0", "length"]);
		expect(ownDataFields(vertices?.[0])).toEqual(GRAPH_VERTEX_FIELDS);
		expect(Reflect.ownKeys((vertices?.[0] as Record<string, unknown> | undefined)?.dependencies ?? {})).toEqual([
			"length",
		]);
		expect(Reflect.ownKeys(charges ?? {})).toEqual(["0", "length"]);
		expect(ownDataFields(charges?.[0])).toEqual(GRAPH_CHARGE_FIELDS);
		expect(ownDataFields(projection)).toEqual(PROJECTION_FIELDS);
		expect(source).toMatch(/digestBlob\([\s\S]*?\)\.value/u);
		expect(result).toEqual({ ok: false, kind: "trust-not-preserved", detail: expect.any(String) });
		expect(graphProbe.indexCalls).toHaveLength(1);
		expect(graphProbe.mutations).toEqual([]);
	});

	it("binds source evidence to the exported owner's reachable success path and rejects dead derivation decoys", () => {
		const reachable = ownerDerivationSourceShape(ownerSourceOracleFixture("reachable"), "CapturedMap");
		expect(reachable?.steps).toEqual(OWNER_DERIVATION_STEPS);
		expect(ownerDerivationSourceShape(ownerSourceOracleFixture("nested-fallthrough"), "CapturedMap")?.steps).toEqual(
			OWNER_DERIVATION_STEPS
		);
		expect(ownerDerivationSourceShape(ownerSourceOracleFixture("branch"), "CapturedMap")).toBeUndefined();
		expect(ownerDerivationSourceShape(ownerSourceOracleFixture("nested-terminating"), "CapturedMap")).toBeUndefined();
		expect(ownerDerivationSourceShape(ownerSourceOracleFixture("post-exit"), "CapturedMap")).toBeUndefined();
	});

	it("maps a known validation refusal to graph-rejected and an unclassifiable graph failure to internal-invariant", async () => {
		for (const [failure, kind] of [
			["internal", "internal-invariant"],
			["graph", "graph-rejected"],
		] as const) {
			const context = fixtureContext();
			graphProbe.indexCalls.length = 0;
			graphProbe.indexFailure = failure;
			const result = await prepare(context);
			expect(result, failure).toEqual({ ok: false, kind, detail: expect.any(String) });
			expect(graphProbe.indexCalls, failure).toHaveLength(1);
			expect(graphProbe.mutations, failure).toEqual([]);
		}
	});

	it("maps either independent graph-preimage digest refusal to internal-invariant before later derivation", async () => {
		for (const [failureOrdinal, failureHex] of [
			[1, golden.orderPreimageHex],
			[2, golden.graphPreimageHex],
		] as const) {
			const context = fixtureContext();
			resetDerivationProbe();
			graphProbe.digestFailureBytes = bytesFromHex(failureHex);
			const result = await prepare(context);
			expect(result, `digest ${failureOrdinal}`).toEqual({
				ok: false,
				kind: "internal-invariant",
				detail: expect.any(String),
			});
			expect(capturedA_bDigests().map(lowerHex), `digest ${failureOrdinal}`).toEqual(
				[golden.orderPreimageHex, golden.graphPreimageHex].slice(0, failureOrdinal)
			);
			expect(rawDerivationEventLabels(), `digest ${failureOrdinal}`).toEqual(
				EXACT_A_B_DERIVATION_EVENTS.slice(0, failureOrdinal + 3)
			);
			expect(graphProbe.closureInputs, `digest ${failureOrdinal}`).toEqual([]);
			expect(graphProbe.mutations, `digest ${failureOrdinal}`).toEqual([]);
		}
	});

	it("keeps unknown canonical and storage derivation events visible after the genuine A-b capture boundary", async () => {
		resetDerivationProbe();
		const compaction = await import("@ts-drp/compaction");
		const vertex = {
			hash: golden.anchorDigest,
			kind: "drp-epoch-anchor" as const,
			objectId: golden.objectId,
			epoch: 0,
			dependencies: [],
		};
		new compaction.CausalityIndex(new Map([[golden.anchorDigest, vertex]]), [golden.anchorDigest]);
		const unknownEncoded = encodeCanonical({ kind: "unknown-after-a-b-capture" });
		const unknownDigestBytes = Uint8Array.of(0xca, 0xfe);
		digestBlob(unknownDigestBytes);
		digestClosure([
			{ digest: must(parseBlobDigest("0".repeat(64))), byteLength: 1 },
			{ digest: must(parseBlobDigest("f".repeat(64))), byteLength: 1 },
		]);
		const raw = rawDerivationEventLabels();
		expect(graphProbe.preCaptureDerivationEvents).toEqual([]);
		expect(raw).toEqual([
			"index",
			`encode:unknown:${lowerHex(unknownEncoded)}`,
			`digest:unknown:${lowerHex(unknownDigestBytes)}`,
			"closure",
			"encode:closure",
		]);
		expect(raw).not.toEqual(EXACT_A_B_DERIVATION_EVENTS);
	});

	it("kills exact byte, digest, field-order, ref-order and duplicate-ref oracle mutants", () => {
		expect(exactGoldenOracle(golden)).toBe(true);
		const byteMutant = { ...golden, projectionHex: `${golden.projectionHex.slice(0, -2)}00` };
		const digestMutant = { ...golden, graphDigest: "f".repeat(64) };
		const lengthMutant = { ...golden, projectionByteLength: golden.projectionByteLength + 1 };
		expect(exactGoldenOracle(byteMutant)).toBe(false);
		expect(exactGoldenOracle(digestMutant)).toBe(false);
		expect(exactGoldenOracle(lengthMutant)).toBe(false);
		const validRefs = [
			{ digest: "0".repeat(64), byteLength: 1 },
			{ digest: golden.projectionDigest, byteLength: golden.projectionByteLength },
		];
		expect(exactClosureOracle(validRefs)).toBe(true);
		expect(exactClosureOracle([...validRefs].reverse())).toBe(false);
		expect(exactClosureOracle([validRefs[0], validRefs[0]])).toBe(false);
		expect(exactClosureOracle([{ ...validRefs[0], digest: "G".repeat(64) }, validRefs[1]])).toBe(false);
		expect(exactClosureOracle([{ ...validRefs[0], byteLength: -1 }, validRefs[1]])).toBe(false);
		expect(exactClosureOracle([{ ...validRefs[0], byteLength: Number.MAX_SAFE_INTEGER + 1 }, validRefs[1]])).toBe(
			false
		);
		const expando = [...validRefs];
		Object.defineProperty(expando, "extra", { enumerable: true, value: true });
		expect(exactClosureOracle(expando)).toBe(false);
		const sparse = new Array(2);
		sparse[1] = validRefs[1];
		expect(exactClosureOracle(sparse)).toBe(false);
	});

	it("keeps D.73 hostile graph-source controls causal without granting caller graph authority", async () => {
		const genuine = await vi.importActual<CompactionModule>("@ts-drp/compaction");
		const anchor = golden.anchorDigest;
		const vertex = {
			hash: anchor,
			kind: "drp-epoch-anchor" as const,
			objectId: golden.objectId,
			epoch: 0,
			dependencies: [],
		};
		class SubclassMap<K, V> extends Map<K, V> {}
		const subclass = new SubclassMap([[anchor, vertex]]);
		const proxy = new Proxy(new Map([[anchor, vertex]]), {});
		const virtualKeys = new Map([[anchor, vertex]]);
		Object.defineProperty(virtualKeys, "keys", {
			value: (): IterableIterator<string> => ["f".repeat(64)][Symbol.iterator](),
		});
		const owned = new Map([[anchor, vertex]]);
		expect(exactOwnerMap(owned, anchor)).toBe(true);
		expect(exactOwnerMap(subclass, anchor)).toBe(false);
		expect(exactOwnerMap(proxy, anchor)).toBe(false);
		expect(exactOwnerMap(virtualKeys, anchor)).toBe(false);
		expect(() => new genuine.CausalityIndex(owned, [anchor])).not.toThrow();
		expect(graphProbe.indexCalls).toEqual([]);
		expect(graphProbe.mutations).toEqual([]);
	});
});
