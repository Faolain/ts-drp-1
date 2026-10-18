import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";

import type {
	AdmissionContext,
	AdmissionHooks,
	HardEpochAuthority,
	PreparedAdmissionContext,
	SignaturePublicKey,
} from "../src/index.js";
import * as ProtocolV2 from "../src/index.js";
import type * as Protocol from "../src/protocol.js";
import type * as Registry from "../src/registry.js";
import { protocolRegistry } from "../src/registry.js";
import type * as Signature from "../src/signature.js";

const registryDigestKinds = vi.hoisted(() => vi.fn<(kind: string) => void>());
const vertexDigestComputations = vi.hoisted(() => vi.fn());
const signatureVerifications = vi.hoisted(() => vi.fn());

vi.mock("../src/registry.js", async (importOriginal) => {
	const original = await importOriginal<typeof Registry>();
	return {
		...original,
		digestRegistryPreimage: (
			...arguments_: Parameters<typeof original.digestRegistryPreimage>
		): ReturnType<typeof original.digestRegistryPreimage> => {
			registryDigestKinds(arguments_[1]);
			return original.digestRegistryPreimage(...arguments_);
		},
	};
});

vi.mock("../src/protocol.js", async (importOriginal) => {
	const original = await importOriginal<typeof Protocol>();
	return {
		...original,
		vertexDigest: (...arguments_: Parameters<typeof original.vertexDigest>): Uint8Array => {
			vertexDigestComputations();
			return original.vertexDigest(...arguments_);
		},
	};
});

vi.mock("../src/signature.js", async (importOriginal) => {
	const original = await importOriginal<typeof Signature>();
	return {
		...original,
		verifyRegisteredSignature: (
			...arguments_: Parameters<typeof original.verifyRegisteredSignature>
		): ReturnType<typeof original.verifyRegisteredSignature> => {
			signatureVerifications();
			return original.verifyRegisteredSignature(...arguments_);
		},
	};
});

const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);
const ACL_DIGEST = "a".repeat(64);
const IDENTITY_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const IDENTITY_PUBLIC_KEY: SignaturePublicKey = {
	bytes: ed25519.getPublicKey(IDENTITY_SEED),
	format: "raw",
};
const registry = protocolRegistry();

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rawAdmissionContext(epoch = 4): AdmissionContext {
	const parameters = {
		maxEpochVertices: 8192,
		maxEpochBytes: 8 * 1024 * 1024,
		maxDependencies: 16,
		snapshotChunkBytes: 128 * 1024,
		maxSnapshotBytes: 256 * 1024 * 1024,
		maxPendingEntries: 4096,
		maxPendingBytes: 16 * 1024 * 1024,
	};
	const parametersDigest = hex(
		ProtocolV2.digestRegistryPreimage(
			registry,
			"parameters",
			parameters as unknown as Readonly<Record<string, unknown>>
		)
	);
	const anchorPreimage = {
		kind: "drp-epoch-anchor",
		protocolMajor: 2,
		objectId: "right-room",
		epoch,
		previousAnchor: ZERO_DIGEST,
		cutDigest: ONE_DIGEST,
		stateDigest: ZERO_DIGEST,
		aclDigest: ACL_DIGEST,
		historyRoot: ZERO_DIGEST,
		historySize: 0,
		archiveIndexRoot: ONE_DIGEST,
		blueprintDigest: ZERO_DIGEST,
		signerSetDigest: ONE_DIGEST,
		parametersDigest,
		profileDigest: ONE_DIGEST,
		cryptoSuiteId: "ed25519-sha256-v1",
	};
	const currentEpochAnchor: Record<string, unknown> = {
		...anchorPreimage,
		hash: hex(ProtocolV2.digestRegistryPreimage(registry, "epochAnchor", anchorPreimage)),
	};
	return {
		cryptoSuiteId: "ed25519-sha256-v1",
		currentAnchor: currentEpochAnchor.hash as string,
		currentEpoch: 4,
		currentEpochAnchor,
		isAncestor: (): boolean => false,
		objectId: "right-room",
		parameters,
		protocolMajor: 2,
	};
}

function admissionHooks(): AdmissionHooks {
	return {
		authorize: vi.fn(() => true),
		isDependencyAccepted: vi.fn(() => true),
		resolveAuthorPublicKey: vi.fn(() => undefined),
		resolveDependencies: vi.fn(() => []),
		validateDeterministicInvariant: vi.fn(() => true),
		validateOperationSchema: vi.fn(() => true),
	};
}

function wrongObjectVertex(currentAnchor: string, index = 0): Readonly<Record<string, unknown>> {
	return {
		anchor: currentAnchor,
		author: "peer-a",
		dependencies: [currentAnchor],
		epoch: 4,
		hash: ZERO_DIGEST,
		kind: "drp-vertex",
		logicalTime: 1,
		objectId: `wrong-room-${index}`,
		operation: { action: "set", index },
		protocolMajor: 2,
		signature: new Uint8Array(64),
	};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runtimePrepare(raw: AdmissionContext): {
	readonly available: boolean;
	readonly result: unknown;
} {
	const candidate: unknown = Reflect.get(ProtocolV2, "prepareAdmissionContext");
	return typeof candidate === "function"
		? { available: true, result: candidate(raw) }
		: { available: false, result: undefined };
}

function preparedContextFrom(result: unknown): unknown {
	return isRecord(result) && result.ok === true ? result.context : undefined;
}

function runtimeAdmit(vertex: Readonly<Record<string, unknown>>, context: unknown, hooks: AdmissionHooks): unknown {
	return Reflect.apply(ProtocolV2.admitVertex, undefined, [vertex, context, hooks]);
}

describe("Phase 0d prepared admission context", () => {
	it("verifies anchor and normalized parameters exactly once and freezes package-owned evidence", () => {
		const raw = rawAdmissionContext();
		registryDigestKinds.mockClear();
		vertexDigestComputations.mockClear();
		signatureVerifications.mockClear();

		const preparation = runtimePrepare(raw);
		const prepared = preparedContextFrom(preparation.result);
		const authority = isRecord(prepared) ? prepared.epochAuthority : undefined;
		const normalizedParameters = isRecord(prepared) ? prepared.parameters : undefined;

		expect({
			available: preparation.available,
			ok: isRecord(preparation.result) ? preparation.result.ok : undefined,
			registryDigestKinds: registryDigestKinds.mock.calls.map(([kind]) => kind).sort(),
			vertexDigests: vertexDigestComputations.mock.calls.length,
			preparedFrozen: Object.isFrozen(prepared),
			parametersFrozen: Object.isFrozen(normalizedParameters),
			authorityFrozen: Object.isFrozen(authority),
			authority,
			stableScalars: isRecord(prepared)
				? {
						cryptoSuiteId: prepared.cryptoSuiteId,
						currentAnchor: prepared.currentAnchor,
						currentEpoch: prepared.currentEpoch,
						objectId: prepared.objectId,
						protocolMajor: prepared.protocolMajor,
					}
				: undefined,
			ancestryReferenceCaptured: isRecord(prepared) && prepared.isAncestor === raw.isAncestor,
		}).toEqual({
			available: true,
			ok: true,
			registryDigestKinds: ["epochAnchor", "parameters"],
			vertexDigests: 0,
			preparedFrozen: true,
			parametersFrozen: true,
			authorityFrozen: true,
			authority: {
				aclDigest: ACL_DIGEST,
				anchor: raw.currentAnchor,
				epoch: 4,
				objectId: "right-room",
			},
			stableScalars: {
				cryptoSuiteId: "ed25519-sha256-v1",
				currentAnchor: raw.currentAnchor,
				currentEpoch: 4,
				objectId: "right-room",
				protocolMajor: 2,
			},
			ancestryReferenceCaptured: true,
		});
	});

	it("reads every raw context field once before validating the prepared snapshot", () => {
		const raw = rawAdmissionContext();
		const validAncestry = raw.isAncestor;
		const validCurrentAnchor = raw.currentAnchor;
		const fields = [
			"cryptoSuiteId",
			"currentAnchor",
			"currentEpoch",
			"currentEpochAnchor",
			"isAncestor",
			"objectId",
			"parameters",
			"protocolMajor",
		] as const satisfies readonly (keyof AdmissionContext)[];
		const reads = Object.fromEntries(fields.map((field) => [field, 0])) as Record<(typeof fields)[number], number>;
		const alternatingValues: Record<(typeof fields)[number], unknown> = {
			cryptoSuiteId: "ed25519-seal-v1",
			currentAnchor: ZERO_DIGEST,
			currentEpoch: 5,
			currentEpochAnchor: null,
			isAncestor: undefined,
			objectId: "other-room",
			parameters: { ...raw.parameters, maxDependencies: 15 },
			protocolMajor: 3,
		};
		const alternatingRaw = new Proxy(raw, {
			get(target, property, receiver): unknown {
				if (typeof property !== "string" || !fields.includes(property as (typeof fields)[number])) {
					return Reflect.get(target, property, receiver);
				}
				const field = property as (typeof fields)[number];
				reads[field]++;
				return reads[field] === 1 ? Reflect.get(target, field, receiver) : alternatingValues[field];
			},
		});

		const preparation = runtimePrepare(alternatingRaw);
		const prepared = preparedContextFrom(preparation.result);

		expect({
			result: isRecord(preparation.result)
				? { ok: preparation.result.ok, code: preparation.result.code }
				: preparation.result,
			reads,
			snapshot: isRecord(prepared)
				? {
						cryptoSuiteId: prepared.cryptoSuiteId,
						currentAnchor: prepared.currentAnchor,
						currentEpoch: prepared.currentEpoch,
						isAncestor: prepared.isAncestor,
						maxDependencies: isRecord(prepared.parameters) ? prepared.parameters.maxDependencies : undefined,
						objectId: prepared.objectId,
						protocolMajor: prepared.protocolMajor,
					}
				: undefined,
		}).toEqual({
			result: { ok: true, code: undefined },
			reads: Object.fromEntries(fields.map((field) => [field, 1])),
			snapshot: {
				cryptoSuiteId: "ed25519-sha256-v1",
				currentAnchor: validCurrentAnchor,
				currentEpoch: 4,
				isAncestor: validAncestry,
				maxDependencies: 16,
				objectId: "right-room",
				protocolMajor: 2,
			},
		});
	});

	it("does zero total per-message digest work for a prepared wrong-object batch", () => {
		const raw = rawAdmissionContext();
		const controlPreimage = {
			anchor: raw.currentAnchor,
			author: "peer-a",
			dependencies: [raw.currentAnchor],
			epoch: 4,
			kind: "drp-vertex",
			logicalTime: 1,
			objectId: "right-room",
			operation: { action: "set" },
			protocolMajor: 2,
		} as const;
		const controlDigest = ProtocolV2.vertexDigest(controlPreimage);
		const controlVertex = {
			...controlPreimage,
			hash: hex(controlDigest),
			signature: new Uint8Array(64),
		};
		registryDigestKinds.mockClear();
		vertexDigestComputations.mockClear();
		signatureVerifications.mockClear();
		const preparation = runtimePrepare(raw);
		const preparationDigestKinds = registryDigestKinds.mock.calls.map(([kind]) => kind).sort();
		const prepared = preparedContextFrom(preparation.result);
		const hooks = admissionHooks();
		const batch = Array.from({ length: 8 }, (_, index) => wrongObjectVertex(raw.currentAnchor, index));
		registryDigestKinds.mockClear();
		vertexDigestComputations.mockClear();
		signatureVerifications.mockClear();

		const results = batch.map((vertex) => runtimeAdmit(vertex, prepared ?? raw, hooks));
		const wrongObjectWork = {
			registryDigests: registryDigestKinds.mock.calls.length,
			vertexDigests: vertexDigestComputations.mock.calls.length,
			signatureVerifications: signatureVerifications.mock.calls.length,
		};
		const controlHooks = admissionHooks();
		vi.mocked(controlHooks.resolveAuthorPublicKey).mockReturnValue(IDENTITY_PUBLIC_KEY);
		registryDigestKinds.mockClear();
		vertexDigestComputations.mockClear();
		signatureVerifications.mockClear();
		const controlResult = runtimeAdmit(controlVertex, prepared ?? raw, controlHooks);

		expect({
			preparationAvailable: preparation.available,
			preparationOk: isRecord(preparation.result) ? preparation.result.ok : undefined,
			preparationDigestKinds,
			results,
			wrongObjectWork,
			authorKeyResolutions: vi.mocked(hooks.resolveAuthorPublicKey).mock.calls.length,
			dependencyResolutions: vi.mocked(hooks.resolveDependencies).mock.calls.length,
			controlResult,
			controlRegistryDigestKinds: registryDigestKinds.mock.calls.map(([kind]) => kind),
			controlVertexDigests: vertexDigestComputations.mock.calls.length,
			controlSignatureVerifications: signatureVerifications.mock.calls.length,
			controlAuthorKeyResolutions: vi.mocked(controlHooks.resolveAuthorPublicKey).mock.calls.length,
		}).toEqual({
			preparationAvailable: true,
			preparationOk: true,
			preparationDigestKinds: ["epochAnchor", "parameters"],
			results: Array.from({ length: 8 }, () => ({
				status: "terminal",
				code: "WRONG_OBJECT",
				latchByHash: false,
			})),
			wrongObjectWork: {
				registryDigests: 0,
				vertexDigests: 0,
				signatureVerifications: 0,
			},
			authorKeyResolutions: 0,
			dependencyResolutions: 0,
			controlResult: {
				status: "terminal",
				code: "INVALID_SIGNATURE",
				latchByHash: false,
			},
			controlRegistryDigestKinds: ["vertex"],
			controlVertexDigests: 1,
			controlSignatureVerifications: 1,
			controlAuthorKeyResolutions: 1,
		});
	});

	it("rejects raw and forged-lookalike contexts at runtime before any digest or trust-boundary work", () => {
		const raw = rawAdmissionContext();
		const preparation = runtimePrepare(raw);
		const prepared = preparedContextFrom(preparation.result);
		const forged = isRecord(prepared) ? { ...prepared } : { ...raw };
		const hooks = admissionHooks();
		registryDigestKinds.mockClear();
		vertexDigestComputations.mockClear();
		signatureVerifications.mockClear();

		const results = [raw, forged].map((context) => runtimeAdmit(wrongObjectVertex(raw.currentAnchor), context, hooks));

		expect({
			preparationAvailable: preparation.available,
			preparationOk: isRecord(preparation.result) ? preparation.result.ok : undefined,
			results,
			registryDigests: registryDigestKinds.mock.calls.length,
			vertexDigests: vertexDigestComputations.mock.calls.length,
			signatureVerifications: signatureVerifications.mock.calls.length,
			authorKeyResolutions: vi.mocked(hooks.resolveAuthorPublicKey).mock.calls.length,
			dependencyResolutions: vi.mocked(hooks.resolveDependencies).mock.calls.length,
		}).toEqual({
			preparationAvailable: true,
			preparationOk: true,
			results: Array.from({ length: 2 }, () => ({
				status: "terminal",
				code: "ADMISSION_CONTEXT_UNPREPARED",
				latchByHash: false,
			})),
			registryDigests: 0,
			vertexDigests: 0,
			signatureVerifications: 0,
			authorKeyResolutions: 0,
			dependencyResolutions: 0,
		});
	});

	it("never identity-caches mutable raw evidence and preserves the first immutable snapshot", () => {
		const raw = rawAdmissionContext();
		const first = runtimePrepare(raw);
		const firstPrepared = preparedContextFrom(first.result);
		const firstAuthority = isRecord(firstPrepared) ? firstPrepared.epochAuthority : undefined;
		const firstParameters = isRecord(firstPrepared) ? firstPrepared.parameters : undefined;

		(raw.parameters as { maxDependencies: number }).maxDependencies = 15;
		registryDigestKinds.mockClear();
		const second = runtimePrepare(raw);
		const secondPreparationDigestKinds = registryDigestKinds.mock.calls.map(([kind]) => kind).sort();
		const mutableAnchorRaw = rawAdmissionContext();
		const firstAnchorPreparation = runtimePrepare(mutableAnchorRaw);
		const firstAnchorPrepared = preparedContextFrom(firstAnchorPreparation.result);
		const firstAnchorAuthority = isRecord(firstAnchorPrepared) ? firstAnchorPrepared.epochAuthority : undefined;
		(mutableAnchorRaw.currentEpochAnchor as Record<string, unknown>).aclDigest = ZERO_DIGEST;
		registryDigestKinds.mockClear();
		const secondAnchorPreparation = runtimePrepare(mutableAnchorRaw);
		const secondAnchorDigestKinds = registryDigestKinds.mock.calls.map(([kind]) => kind).sort();

		expect({
			firstAvailable: first.available,
			firstOk: isRecord(first.result) ? first.result.ok : undefined,
			firstPreparedFrozen: Object.isFrozen(firstPrepared),
			firstAuthorityFrozen: Object.isFrozen(firstAuthority),
			firstParametersFrozen: Object.isFrozen(firstParameters),
			firstAuthority,
			firstMaxDependencies: isRecord(firstParameters) ? firstParameters.maxDependencies : undefined,
			secondAvailable: second.available,
			secondResult: second.result,
			secondPreparationDigestKinds,
			firstAnchorAvailable: firstAnchorPreparation.available,
			firstAnchorOk: isRecord(firstAnchorPreparation.result) ? firstAnchorPreparation.result.ok : undefined,
			firstAnchorAuthority,
			firstAnchorAuthorityFrozen: Object.isFrozen(firstAnchorAuthority),
			secondAnchorAvailable: secondAnchorPreparation.available,
			secondAnchorResult: secondAnchorPreparation.result,
			secondAnchorDigestKinds,
		}).toEqual({
			firstAvailable: true,
			firstOk: true,
			firstPreparedFrozen: true,
			firstAuthorityFrozen: true,
			firstParametersFrozen: true,
			firstAuthority: {
				aclDigest: ACL_DIGEST,
				anchor: raw.currentAnchor,
				epoch: 4,
				objectId: "right-room",
			},
			firstMaxDependencies: 16,
			secondAvailable: true,
			secondResult: { ok: false, code: "ADMISSION_CONTEXT_INVALID" },
			secondPreparationDigestKinds: ["epochAnchor", "parameters"],
			firstAnchorAvailable: true,
			firstAnchorOk: true,
			firstAnchorAuthority: {
				aclDigest: ACL_DIGEST,
				anchor: mutableAnchorRaw.currentAnchor,
				epoch: 4,
				objectId: "right-room",
			},
			firstAnchorAuthorityFrozen: true,
			secondAnchorAvailable: true,
			secondAnchorResult: { ok: false, code: "ADMISSION_CONTEXT_INVALID" },
			secondAnchorDigestKinds: ["epochAnchor"],
		});
	});

	it("revalidates every stable scalar when the same raw context identity changes", () => {
		const cases = [
			[
				"cryptoSuiteId",
				(raw: AdmissionContext): void => {
					raw.cryptoSuiteId = "ed25519-seal-v1";
				},
			],
			[
				"currentAnchor",
				(raw: AdmissionContext): void => {
					raw.currentAnchor = ZERO_DIGEST;
				},
			],
			[
				"currentEpoch",
				(raw: AdmissionContext): void => {
					raw.currentEpoch = 5;
				},
			],
			[
				"objectId",
				(raw: AdmissionContext): void => {
					raw.objectId = "other-room";
				},
			],
			[
				"protocolMajor",
				(raw: AdmissionContext): void => {
					raw.protocolMajor = 3;
				},
			],
		] as const;

		const results = cases.map(([field, mutate]) => {
			const raw = rawAdmissionContext();
			const first = runtimePrepare(raw);
			mutate(raw);
			registryDigestKinds.mockClear();
			const second = runtimePrepare(raw);
			return {
				field,
				firstAvailable: first.available,
				firstOk: isRecord(first.result) ? first.result.ok : undefined,
				secondAvailable: second.available,
				secondResult: second.result,
			};
		});

		expect(results).toEqual(
			cases.map(([field]) => ({
				field,
				firstAvailable: true,
				firstOk: true,
				secondAvailable: true,
				secondResult: { ok: false, code: "ADMISSION_CONTEXT_INVALID" },
			}))
		);
	});

	it("classifies an anchor/current-epoch mismatch as preparation failure, not a dependency fault", () => {
		const inconsistent = rawAdmissionContext(5);
		registryDigestKinds.mockClear();

		const preparation = runtimePrepare(inconsistent);

		expect({
			available: preparation.available,
			result: preparation.result,
			registryDigestKinds: registryDigestKinds.mock.calls.map(([kind]) => kind).sort(),
		}).toEqual({
			available: true,
			result: { ok: false, code: "ADMISSION_CONTEXT_INVALID" },
			registryDigestKinds: ["epochAnchor"],
		});
		expect(preparation.result).not.toMatchObject({ code: "DEPENDENCY_WRONG_ANCHOR" });
	});
});

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;
type RuntimePrepareAdmissionContext = (typeof ProtocolV2)["prepareAdmissionContext"];
type PreparationResult = ReturnType<RuntimePrepareAdmissionContext>;
type _PreparationSuccessCarriesPreparedContext = Expect<
	Equal<Extract<PreparationResult, { readonly ok: true }>["context"], PreparedAdmissionContext>
>;
type _PreparationFailureHasStableCode = Expect<
	Equal<Extract<PreparationResult, { readonly ok: false }>["code"], "ADMISSION_CONTEXT_INVALID">
>;
type _AdmitRequiresPreparedContext = Expect<
	Equal<Parameters<typeof ProtocolV2.admitVertex>[1], PreparedAdmissionContext>
>;
type _RawContextIsNotPrepared = Expect<Equal<AdmissionContext extends PreparedAdmissionContext ? true : false, false>>;
type _AuthorizeReceivesHardEpochAuthority = Expect<
	Equal<Parameters<AdmissionHooks["authorize"]>[1], HardEpochAuthority>
>;
