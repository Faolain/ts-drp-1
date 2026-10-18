import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";

import { prepareTestAdmissionContext } from "./admission-context-fixture.js";
import {
	type AdmissionContext,
	type AdmissionHooks,
	type AdmissionResult,
	admitVertex,
	digestRegistryPreimage,
	prepareAdmissionContext,
	type PreparedAdmissionContext,
	type SignaturePublicKey,
	signIdentityDigest,
	vertexDigest,
} from "../src/index.js";
import { protocolRegistry } from "../src/registry.js";

const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);
const IDENTITY_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const IDENTITY_PUBLIC_KEY: SignaturePublicKey = {
	bytes: ed25519.getPublicKey(IDENTITY_SEED),
	format: "raw",
};
const registry = protocolRegistry();
const defaultParameters = {
	maxEpochVertices: 8192,
	maxEpochBytes: 8 * 1024 * 1024,
	maxDependencies: 16,
	snapshotChunkBytes: 128 * 1024,
	maxSnapshotBytes: 256 * 1024 * 1024,
	maxPendingEntries: 4096,
	maxPendingBytes: 16 * 1024 * 1024,
} as const;

interface ProbeSet {
	readonly ancestry: ReturnType<typeof vi.fn<(left: string, right: string) => boolean>>;
	readonly authorization: ReturnType<
		typeof vi.fn<(vertex: Readonly<Record<string, unknown>>, epochAuthority?: unknown) => boolean>
	>;
	readonly dependencyAccepted: ReturnType<typeof vi.fn<(dependencyHash: string) => boolean>>;
	readonly invariant: ReturnType<typeof vi.fn<(vertex: Readonly<Record<string, unknown>>) => boolean>>;
	readonly operationSchema: ReturnType<typeof vi.fn<(operation: unknown) => boolean>>;
	readonly resolveAuthor: ReturnType<typeof vi.fn<(author: string) => SignaturePublicKey | undefined>>;
	readonly resolveDependencies: ReturnType<typeof vi.fn<(dependencies: readonly string[]) => readonly unknown[]>>;
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signedVertex(
	overrides: Readonly<Record<string, unknown>> = {},
	signatureSeed: Uint8Array = IDENTITY_SEED
): Readonly<Record<string, unknown>> {
	const preimage = {
		kind: "drp-vertex",
		protocolMajor: 2,
		objectId: "room-a",
		epoch: 4,
		anchor: defaultAnchorHash,
		author: "peer-a",
		logicalTime: 2,
		dependencies: [ONE_DIGEST],
		operation: { action: "set", key: "greeting", value: "hello" },
		...overrides,
	};
	const digest = vertexDigest(preimage as never);
	return {
		...preimage,
		hash: hex(digest),
		signature: signIdentityDigest(signatureSeed, digest),
	};
}

function epochAnchor(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
	const preimage = {
		kind: "drp-epoch-anchor",
		protocolMajor: 2,
		objectId: "room-a",
		epoch: 4,
		previousAnchor: ZERO_DIGEST,
		cutDigest: ONE_DIGEST,
		stateDigest: ZERO_DIGEST,
		aclDigest: ONE_DIGEST,
		historyRoot: ZERO_DIGEST,
		historySize: 0,
		archiveIndexRoot: ONE_DIGEST,
		blueprintDigest: ZERO_DIGEST,
		signerSetDigest: ONE_DIGEST,
		parametersDigest: ZERO_DIGEST,
		profileDigest: ONE_DIGEST,
		cryptoSuiteId: "ed25519-sha256-v1",
		...overrides,
	};
	return {
		...preimage,
		hash: hex(digestRegistryPreimage(registry, "epochAnchor", preimage)),
	};
}

const defaultParametersDigest = hex(digestRegistryPreimage(registry, "parameters", defaultParameters));
const currentEpochAnchor = epochAnchor({ parametersDigest: defaultParametersDigest });
const defaultAnchorHash = currentEpochAnchor.hash as string;

const lowRoot = signedVertex({
	author: "peer-low-root",
	dependencies: [defaultAnchorHash],
	logicalTime: 1,
	operation: { action: "low-root" },
});
const parentLow = signedVertex({
	author: "peer-parent-low",
	dependencies: [lowRoot.hash],
	logicalTime: 2,
	operation: { action: "parent-low" },
});
const highRoot = signedVertex({
	author: "peer-high-root",
	dependencies: [defaultAnchorHash],
	logicalTime: 1,
	operation: { action: "high-root" },
});
const highSecond = signedVertex({
	author: "peer-high-second",
	dependencies: [highRoot.hash],
	logicalTime: 2,
	operation: { action: "high-second" },
});
const highThird = signedVertex({
	author: "peer-high-third",
	dependencies: [highSecond.hash],
	logicalTime: 3,
	operation: { action: "high-third" },
});
const parentHigh = signedVertex({
	author: "peer-parent-high",
	dependencies: [highThird.hash],
	logicalTime: 4,
	operation: { action: "parent-high" },
});
const sortedParents = [parentLow, parentHigh].sort((left, right) =>
	String(left.hash) < String(right.hash) ? -1 : String(left.hash) > String(right.hash) ? 1 : 0
);
const parentHashes = sortedParents.map((parent) => parent.hash as string);
const validTwoParentVertex = signedVertex({
	dependencies: parentHashes,
	logicalTime: 5,
});
const validOneParentVertex = signedVertex({
	dependencies: [parentLow.hash],
	logicalTime: 3,
});
const otherCurrentEpochAnchor = epochAnchor({ historySize: 1, parametersDigest: defaultParametersDigest });
const governedParameters = {
	maxEpochVertices: 8192,
	maxEpochBytes: 65_536,
	maxDependencies: 256,
	snapshotChunkBytes: 128 * 1024,
	maxSnapshotBytes: 256 * 1024 * 1024,
	maxPendingEntries: 4096,
	maxPendingBytes: 16 * 1024 * 1024,
} as const;
const governedParametersDigest = hex(digestRegistryPreimage(registry, "parameters", governedParameters));
const governedEpochAnchor = epochAnchor({ parametersDigest: governedParametersDigest });
const governedAnchorHash = governedEpochAnchor.hash as string;
const governedParents = Array.from({ length: 17 }, (_, index) =>
	signedVertex({
		anchor: governedAnchorHash,
		author: `governed-parent-${index.toString().padStart(2, "0")}`,
		dependencies: [governedAnchorHash],
		logicalTime: 1,
		operation: { action: "governed-parent", index },
	})
).sort((left, right) => (String(left.hash) < String(right.hash) ? -1 : String(left.hash) > String(right.hash) ? 1 : 0));
const governanceMaxDependenciesChild = signedVertex({
	anchor: governedAnchorHash,
	dependencies: governedParents.map((parent) => parent.hash),
	logicalTime: 2,
});

function phase0dHarness(
	options: {
		readonly accepted?: boolean;
		ancestor?(left: string, right: string): boolean;
		readonly authorized?: boolean;
		readonly currentAnchor?: string;
		readonly currentEpoch?: number;
		readonly currentEpochAnchor?: Readonly<Record<string, unknown>>;
		readonly invariantValid?: boolean;
		readonly operationValid?: boolean;
		readonly parameters?: AdmissionContext["parameters"];
		readonly publicKey?: SignaturePublicKey;
		readonly resolved?: readonly unknown[];
	} = {}
): { readonly context: PreparedAdmissionContext; readonly hooks: AdmissionHooks; readonly probes: ProbeSet } {
	const probes: ProbeSet = {
		ancestry: vi.fn(options.ancestor ?? ((): boolean => false)),
		authorization: vi.fn((_vertex, _epochAuthority) => options.authorized ?? true),
		dependencyAccepted: vi.fn(() => options.accepted ?? true),
		invariant: vi.fn(() => options.invariantValid ?? true),
		operationSchema: vi.fn(() => options.operationValid ?? true),
		resolveAuthor: vi.fn(() => options.publicKey ?? IDENTITY_PUBLIC_KEY),
		resolveDependencies: vi.fn(
			(dependencies) =>
				options.resolved ?? dependencies.map((hash) => sortedParents.find((parent) => parent.hash === hash))
		),
	};
	const context = prepareTestAdmissionContext({
		cryptoSuiteId: "ed25519-sha256-v1",
		currentAnchor: options.currentAnchor ?? defaultAnchorHash,
		currentEpoch: options.currentEpoch ?? 4,
		currentEpochAnchor: options.currentEpochAnchor ?? currentEpochAnchor,
		isAncestor: probes.ancestry,
		objectId: "room-a",
		parameters: options.parameters ?? defaultParameters,
		protocolMajor: 2,
	});
	const hooks: AdmissionHooks = {
		authorize: probes.authorization,
		isDependencyAccepted: probes.dependencyAccepted,
		resolveAuthorPublicKey: probes.resolveAuthor,
		resolveDependencies: probes.resolveDependencies,
		validateDeterministicInvariant: probes.invariant,
		validateOperationSchema: probes.operationSchema,
	};
	return { context, hooks, probes };
}

function expectNoSemanticWork(probes: ProbeSet): void {
	expect(probes.authorization).not.toHaveBeenCalled();
	expect(probes.invariant).not.toHaveBeenCalled();
	expect(probes.operationSchema).not.toHaveBeenCalled();
}

function latchByHash(result: AdmissionResult): unknown {
	return "latchByHash" in result ? result.latchByHash : undefined;
}

function classificationWithLatch(result: AdmissionResult): Readonly<Record<string, unknown>> {
	return {
		status: result.status,
		code: result.code,
		latchByHash: latchByHash(result),
	};
}

describe("Phase 0d mandatory fail-closed admission pipeline", () => {
	it("accepts only after package-owned signature, accepted dependencies, exact time, antichain, ACL, schema and invariant checks", () => {
		const { context, hooks, probes } = phase0dHarness();

		expect(admitVertex(validTwoParentVertex, context, hooks)).toEqual({
			status: "accept",
			code: "ADMISSIBLE",
			latchByHash: false,
		});
		expect(probes.resolveAuthor).toHaveBeenCalledOnce();
		expect(probes.resolveAuthor).toHaveBeenCalledWith("peer-a");
		expect(probes.resolveDependencies).toHaveBeenCalledWith(parentHashes);
		expect(probes.dependencyAccepted.mock.calls.map(([hash]) => hash)).toEqual(parentHashes);
		expect(probes.ancestry).toHaveBeenCalledTimes(2);
		expect(probes.authorization).toHaveBeenCalledOnce();
		expect(probes.operationSchema).toHaveBeenCalledOnce();
		expect(probes.invariant).toHaveBeenCalledOnce();
	});

	it("isolates authenticated operation bytes from caller and earlier-hook mutations", () => {
		const callerBytes = Uint8Array.of(1, 2, 3);
		const vertex = signedVertex({
			dependencies: [parentLow.hash],
			logicalTime: 3,
			operation: { action: "set-bytes", payload: callerBytes },
		});
		const { context, hooks, probes } = phase0dHarness();
		const observations: Record<string, readonly number[]> = {};
		const hookPayloads: Uint8Array[] = [];
		const payloadFrom = (operation: unknown): Uint8Array => {
			if (
				operation === null ||
				typeof operation !== "object" ||
				!("payload" in operation) ||
				!(operation.payload instanceof Uint8Array)
			) {
				throw new TypeError("operation must carry Uint8Array payload");
			}
			return operation.payload;
		};
		probes.resolveDependencies.mockImplementation(() => {
			callerBytes[2] = 7;
			return [parentLow];
		});
		probes.authorization.mockImplementation((candidate) => {
			const payload = payloadFrom(candidate.operation);
			hookPayloads.push(payload);
			observations.authorizationBefore = [...payload];
			payload[0] = 9;
			observations.authorizationAfter = [...payload];
			return true;
		});
		probes.operationSchema.mockImplementation((operation) => {
			const payload = payloadFrom(operation);
			hookPayloads.push(payload);
			observations.schemaBefore = [...payload];
			payload[1] = 8;
			observations.schemaAfter = [...payload];
			return true;
		});
		probes.invariant.mockImplementation((candidate) => {
			const payload = payloadFrom(candidate.operation);
			hookPayloads.push(payload);
			observations.invariant = [...payload];
			return true;
		});

		const result = admitVertex(vertex, context, hooks);

		expect({
			result,
			callerBytes: [...callerBytes],
			observations,
			detachedFromCaller: hookPayloads.every((payload) => payload !== callerBytes),
			isolatedBetweenHooks:
				hookPayloads.length === 3 &&
				hookPayloads[0] !== hookPayloads[1] &&
				hookPayloads[1] !== hookPayloads[2] &&
				hookPayloads[0] !== hookPayloads[2],
		}).toEqual({
			result: { status: "accept", code: "ADMISSIBLE", latchByHash: false },
			callerBytes: [1, 2, 7],
			observations: {
				authorizationBefore: [1, 2, 3],
				authorizationAfter: [9, 2, 3],
				schemaBefore: [1, 2, 3],
				schemaAfter: [1, 8, 3],
				invariant: [1, 2, 3],
			},
			detachedFromCaller: true,
			isolatedBetweenHooks: true,
		});
	});

	it("rejects a missing, malformed or wrong-key author signature before dependency work", () => {
		const cases: readonly Readonly<Record<string, unknown>>[] = [
			((): Record<string, unknown> => {
				const unsigned = { ...validOneParentVertex } as Record<string, unknown>;
				delete unsigned.signature;
				return unsigned;
			})(),
			{ ...validOneParentVertex, signature: Uint8Array.of(1, 2, 3) },
			signedVertex(
				{ dependencies: [parentLow.hash], logicalTime: 3 },
				Uint8Array.from({ length: 32 }, (_, index) => 255 - index)
			),
		];

		const runs = cases.map((vertex) => {
			const { context, hooks, probes } = phase0dHarness();
			return { probes, result: admitVertex(vertex, context, hooks) };
		});
		expect(runs.map(({ result }) => result)).toEqual(
			cases.map(() => ({
				status: "terminal",
				code: "INVALID_SIGNATURE",
				latchByHash: false,
			}))
		);
		for (const { probes } of runs) {
			expect(probes.resolveAuthor).toHaveBeenCalledOnce();
			expect(probes.resolveDependencies).not.toHaveBeenCalled();
			expectNoSemanticWork(probes);
		}
	});

	it("makes claimed-hash cache safety explicit across every pre-authentication outcome", () => {
		if (!(validOneParentVertex.signature instanceof Uint8Array)) {
			throw new TypeError("signed fixture must carry Uint8Array signature bytes");
		}
		const missingDependencies = { ...validOneParentVertex } as Record<string, unknown>;
		delete missingDependencies.dependencies;
		const missingAuthor = { ...validOneParentVertex } as Record<string, unknown>;
		delete missingAuthor.author;
		const missingSignature = { ...validOneParentVertex } as Record<string, unknown>;
		delete missingSignature.signature;
		const corruptedSignature = validOneParentVertex.signature.slice();
		corruptedSignature[0] = (corruptedSignature[0] as number) ^ 1;
		const cases = [
			[missingDependencies, "terminal", "MISSING_DEPENDENCIES"],
			[missingAuthor, "terminal", "INVALID_HASH"],
			[{ ...validOneParentVertex, objectId: "wrong-room" }, "terminal", "WRONG_OBJECT"],
			[{ ...validOneParentVertex, protocolMajor: 1 }, "terminal", "LEGACY_PROTOCOL"],
			[{ ...validOneParentVertex, protocolMajor: 3 }, "pending", "FUTURE_PROTOCOL"],
			[{ ...validOneParentVertex, epoch: 3 }, "terminal", "STALE_EPOCH"],
			[{ ...validOneParentVertex, epoch: 5 }, "pending", "FUTURE_EPOCH"],
			[{ ...validOneParentVertex, anchor: ONE_DIGEST }, "terminal", "WRONG_ANCHOR"],
			[{ ...validOneParentVertex, hash: validTwoParentVertex.hash }, "terminal", "INVALID_HASH"],
			[missingSignature, "terminal", "INVALID_SIGNATURE"],
			[{ ...validOneParentVertex, signature: corruptedSignature }, "terminal", "INVALID_SIGNATURE"],
		] as const;

		const classifications = cases.map(([vertex]) => {
			const harness = phase0dHarness();
			return admitVertex(vertex, harness.context, harness.hooks);
		});
		const missingCrypto = phase0dHarness();
		const contextWithoutCrypto = { ...missingCrypto.context } as Partial<AdmissionContext>;
		delete contextWithoutCrypto.cryptoSuiteId;
		const missingCryptoPreparation = prepareAdmissionContext(contextWithoutCrypto as AdmissionContext);
		const missingAuthorResolver = phase0dHarness();
		const hooksWithoutAuthorResolver = { ...missingAuthorResolver.hooks } as Partial<AdmissionHooks>;
		delete hooksWithoutAuthorResolver.resolveAuthorPublicKey;
		const missingAuthorResolverResult = admitVertex(
			validOneParentVertex,
			missingAuthorResolver.context,
			hooksWithoutAuthorResolver as AdmissionHooks
		);
		const authenticatedSemanticFailure = phase0dHarness({ authorized: false });
		const unauthorized = admitVertex(
			validOneParentVertex,
			authenticatedSemanticFailure.context,
			authenticatedSemanticFailure.hooks
		);

		expect([...classifications, missingAuthorResolverResult].map(classificationWithLatch)).toEqual([
			...cases.map(([, status, code]) => ({
				status,
				code,
				latchByHash: false,
			})),
			{ status: "terminal", code: "AUTHOR_KEY_RESOLVER_UNAVAILABLE", latchByHash: false },
		]);
		expect(missingCryptoPreparation).toEqual({ ok: false, code: "ADMISSION_CONTEXT_INVALID" });
		expect(missingCrypto.probes.resolveAuthor).not.toHaveBeenCalled();

		expect(classificationWithLatch(unauthorized)).toEqual({
			status: "terminal",
			code: "UNAUTHORIZED",
			latchByHash: true,
		});
	});

	it("rejects a hash-preserving candidate-kind tamper before dependency or semantic work", () => {
		const tampered: Readonly<Record<string, unknown>> = {
			...validOneParentVertex,
			kind: "drp-epoch-anchor",
		};
		const { context, hooks, probes } = phase0dHarness();
		const result = admitVertex(tampered, context, hooks);

		expect({
			result: classificationWithLatch(result),
			calls: {
				author: probes.resolveAuthor.mock.calls.length,
				dependencies: probes.resolveDependencies.mock.calls.length,
				accepted: probes.dependencyAccepted.mock.calls.length,
				ancestry: probes.ancestry.mock.calls.length,
				authorization: probes.authorization.mock.calls.length,
				schema: probes.operationSchema.mock.calls.length,
				invariant: probes.invariant.mock.calls.length,
			},
		}).toEqual({
			result: {
				status: "quarantine",
				code: "NON_CANONICAL_ENVELOPE",
				latchByHash: false,
			},
			calls: {
				author: 0,
				dependencies: 0,
				accepted: 0,
				ancestry: 0,
				authorization: 0,
				schema: 0,
				invariant: 0,
			},
		});
		expect(tampered.hash).toBe(validOneParentVertex.hash);
		expect(tampered.signature).toEqual(validOneParentVertex.signature);
	});

	it("does zero registered-digest work for a batch of wrong-object envelopes", () => {
		let digestComputations = 0;
		const wrongObjectBatch = Array.from({ length: 8 }, (_, index) => {
			const vertex = signedVertex({ operation: { action: "batch", index } });
			return {
				...vertex,
				objectId: "wrong-room",
				get operation(): unknown {
					digestComputations++;
					return vertex.operation;
				},
			};
		});
		const { context, hooks, probes } = phase0dHarness();

		expect(wrongObjectBatch.map((vertex) => admitVertex(vertex, context, hooks))).toEqual(
			Array.from({ length: 8 }, () => ({ status: "terminal", code: "WRONG_OBJECT", latchByHash: false }))
		);
		expect(digestComputations).toBe(0);
		expect(probes.resolveAuthor).not.toHaveBeenCalled();
		expect(probes.resolveDependencies).not.toHaveBeenCalled();
		expectNoSemanticWork(probes);
	});

	it("derives dependency fan-out from anchored parameters and excludes transport-local byte policy", () => {
		const candidate = { ...governanceMaxDependenciesChild } as Record<string, unknown>;
		delete candidate.encodedByteLength;
		const harness = phase0dHarness({
			currentAnchor: governedAnchorHash,
			currentEpochAnchor: governedEpochAnchor,
			parameters: governedParameters,
			resolved: governedParents,
		});
		const governedRawContext: AdmissionContext = {
			cryptoSuiteId: "ed25519-sha256-v1",
			currentAnchor: governedAnchorHash,
			currentEpoch: 4,
			currentEpochAnchor: governedEpochAnchor,
			isAncestor: harness.context.isAncestor,
			objectId: "room-a",
			parameters: governedParameters,
			protocolMajor: 2,
		};
		const legacyDefaultRaw = {
			...governedRawContext,
			maxBytes: 128,
			maxDependencies: 16,
		};
		const governanceMaximumRaw = {
			...governedRawContext,
			maxBytes: 1024,
			maxDependencies: 256,
		};
		const legacyDefaultReplica = prepareTestAdmissionContext(legacyDefaultRaw);
		const governanceMaximumReplica = prepareTestAdmissionContext(governanceMaximumRaw);

		expect([
			admitVertex(candidate, legacyDefaultReplica, harness.hooks),
			admitVertex(candidate, governanceMaximumReplica, harness.hooks),
		]).toEqual([
			{ status: "accept", code: "ADMISSIBLE", latchByHash: false },
			{ status: "accept", code: "ADMISSIBLE", latchByHash: false },
		]);

		const maxDependenciesField = registry.kinds.parameters?.fields.find((field) => field.name === "maxDependencies");
		expect(maxDependenciesField?.constraints.maximum).toBe(256);
		expect(governedParameters.maxDependencies).toBe(256);
		expect(Object.hasOwn(candidate, "encodedByteLength")).toBe(false);
	});

	it("derives the fan-out limit from the same registry-normalized parameters snapshot that was hashed", () => {
		let maxDependencyReads = 0;
		const changingParameters = new Proxy(governedParameters, {
			get(target, property, receiver): unknown {
				if (property === "maxDependencies") {
					maxDependencyReads++;
					return maxDependencyReads === 1 ? 256 : 16;
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const harness = phase0dHarness({
			currentAnchor: governedAnchorHash,
			currentEpochAnchor: governedEpochAnchor,
			parameters: changingParameters,
			resolved: governedParents,
		});

		expect(admitVertex(governanceMaxDependenciesChild, harness.context, harness.hooks)).toEqual({
			status: "accept",
			code: "ADMISSIBLE",
			latchByHash: false,
		});
		expect(maxDependencyReads).toBe(1);
	});

	it("keeps transport measurement outside admission and quarantines every unknown envelope key", () => {
		const canonical = { ...validOneParentVertex } as Record<string, unknown>;
		delete canonical.encodedByteLength;
		const padded = { ...canonical, padding: "relay-controlled-padding" };
		const embeddedMeasurement = { ...canonical, encodedByteLength: 256 };
		const harness = phase0dHarness();

		expect(
			[
				admitVertex(canonical, harness.context, harness.hooks),
				admitVertex(padded, harness.context, harness.hooks),
				admitVertex(embeddedMeasurement, harness.context, harness.hooks),
			].map(classificationWithLatch)
		).toEqual([
			{ status: "accept", code: "ADMISSIBLE", latchByHash: false },
			{ status: "quarantine", code: "NON_CANONICAL_ENVELOPE", latchByHash: false },
			{ status: "quarantine", code: "NON_CANONICAL_ENVELOPE", latchByHash: false },
		]);
	});

	it("rejects malformed, registry-duplicate and unsorted dependency lists at their literal stages", () => {
		const unsorted = [...parentHashes].reverse();
		expect(unsorted).not.toEqual(parentHashes);
		const cases: readonly (readonly [Readonly<Record<string, unknown>>, string, string, number])[] = [
			[{ ...validTwoParentVertex, dependencies: ["not-a-digest"] }, "quarantine", "NON_CANONICAL_ENVELOPE", 0],
			[
				{ ...validTwoParentVertex, dependencies: [parentHashes[0], parentHashes[0]] },
				"quarantine",
				"NON_CANONICAL_ENVELOPE",
				0,
			],
			[signedVertex({ dependencies: unsorted, logicalTime: 5 }), "quarantine", "NON_CANONICAL_ENVELOPE", 0],
		];

		const runs = cases.map(([vertex, expectedStatus, expectedCode, expectedAuthorResolutions]) => {
			const { context, hooks, probes } = phase0dHarness();
			return {
				expectedAuthorResolutions,
				expectedResult: { status: expectedStatus, code: expectedCode, latchByHash: false },
				probes,
				result: admitVertex(vertex, context, hooks),
			};
		});
		expect(runs.map(({ result }) => classificationWithLatch(result))).toEqual(
			runs.map(({ expectedResult }) => expectedResult)
		);
		for (const { expectedAuthorResolutions, probes } of runs) {
			expect(probes.resolveAuthor).toHaveBeenCalledTimes(expectedAuthorResolutions);
			expect(probes.resolveDependencies).not.toHaveBeenCalled();
			expect(probes.dependencyAccepted).not.toHaveBeenCalled();
			expect(probes.ancestry).not.toHaveBeenCalled();
			expectNoSemanticWork(probes);
		}

		const sorted = phase0dHarness();
		expect(admitVertex(validTwoParentVertex, sorted.context, sorted.hooks)).toEqual({
			status: "accept",
			code: "ADMISSIBLE",
			latchByHash: false,
		});
	});

	it("snapshots a bounded dependency array once and reuses the frozen snapshot at every later stage", () => {
		const reads = [0, 0];
		const changingDependencies = new Proxy([...parentHashes], {
			get(target, property, receiver): unknown {
				if (property === "0" || property === "1") {
					const index = Number(property);
					reads[index] = (reads[index] as number) + 1;
					return reads[index] === 1 ? target[index] : target[index === 0 ? 1 : 0];
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const candidate = {
			...validTwoParentVertex,
			dependencies: changingDependencies,
		};
		const harness = phase0dHarness({ resolved: sortedParents });

		expect(admitVertex(candidate, harness.context, harness.hooks)).toEqual({
			status: "accept",
			code: "ADMISSIBLE",
			latchByHash: false,
		});
		expect(reads).toEqual([1, 1]);
		expect(harness.probes.resolveDependencies).toHaveBeenCalledOnce();
		const dependencySnapshot = harness.probes.resolveDependencies.mock.calls[0]?.[0];
		expect(dependencySnapshot).toEqual(parentHashes);
		expect(Object.isFrozen(dependencySnapshot)).toBe(true);
		expect(harness.probes.dependencyAccepted.mock.calls.map(([hash]) => hash)).toEqual(parentHashes);
		expect(harness.probes.ancestry.mock.calls).toEqual([
			[parentHashes[0], parentHashes[1]],
			[parentHashes[1], parentHashes[0]],
		]);
	});

	it("keeps unknown dependencies pending and never treats known-but-unaccepted dependencies as valid parents", () => {
		const unknown = phase0dHarness({ resolved: [] });
		expect(admitVertex(validOneParentVertex, unknown.context, unknown.hooks)).toEqual({
			status: "pending",
			code: "MISSING_CURRENT_EPOCH_DEPENDENCIES",
			latchByHash: false,
		});
		expect(unknown.probes.ancestry).not.toHaveBeenCalled();
		expectNoSemanticWork(unknown.probes);

		const unaccepted = phase0dHarness({ accepted: false });
		const result = admitVertex(validOneParentVertex, unaccepted.context, unaccepted.hooks);
		expect(result).toEqual({ status: "pending", code: "UNACCEPTED_DEPENDENCIES", latchByHash: false });
		expect(unaccepted.probes.ancestry).not.toHaveBeenCalled();
		expectNoSemanticWork(unaccepted.probes);

		const corrupt = phase0dHarness({
			resolved: [{ ...parentLow, operation: { action: "relay-corruption" } }],
		});
		expect(classificationWithLatch(admitVertex(validOneParentVertex, corrupt.context, corrupt.hooks))).toEqual({
			status: "terminal",
			code: "INVALID_DEPENDENCY_ENVELOPE",
			latchByHash: false,
		});

		const substituted = phase0dHarness({
			resolved: [{ ...parentLow, hash: "f".repeat(64) }],
		});
		expect(classificationWithLatch(admitVertex(validOneParentVertex, substituted.context, substituted.hooks))).toEqual({
			status: "terminal",
			code: "INVALID_DEPENDENCY_ENVELOPE",
			latchByHash: false,
		});
	});

	it("detaches a valid resolved vertex before an acceptance hook can cause a latched false reject", () => {
		const control = phase0dHarness({ resolved: [{ ...parentLow }] });
		const liveParent = { ...parentLow };
		const mutated = phase0dHarness({ resolved: [liveParent] });
		mutated.probes.dependencyAccepted.mockImplementation(() => {
			liveParent.logicalTime = 10;
			return true;
		});

		expect({
			control: admitVertex(validOneParentVertex, control.context, control.hooks),
			mutated: admitVertex(validOneParentVertex, mutated.context, mutated.hooks),
			mutationObserved: liveParent.logicalTime,
			acceptanceCalls: mutated.probes.dependencyAccepted.mock.calls.length,
		}).toEqual({
			control: { status: "accept", code: "ADMISSIBLE", latchByHash: false },
			mutated: { status: "accept", code: "ADMISSIBLE", latchByHash: false },
			mutationObserved: 10,
			acceptanceCalls: 1,
		});
	});

	it("detaches an invalid-time resolved vertex before an acceptance hook can cause a false accept", () => {
		const invalidTimeChild = signedVertex({
			dependencies: [parentLow.hash],
			logicalTime: 11,
		});
		const control = phase0dHarness({ resolved: [{ ...parentLow }] });
		const liveParent = { ...parentLow };
		const mutated = phase0dHarness({ resolved: [liveParent] });
		mutated.probes.dependencyAccepted.mockImplementation(() => {
			liveParent.logicalTime = 10;
			return true;
		});

		expect({
			control: admitVertex(invalidTimeChild, control.context, control.hooks),
			mutated: admitVertex(invalidTimeChild, mutated.context, mutated.hooks),
			mutationObserved: liveParent.logicalTime,
			acceptanceCalls: mutated.probes.dependencyAccepted.mock.calls.length,
		}).toEqual({
			control: { status: "terminal", code: "INVALID_LOGICAL_TIME", latchByHash: true },
			mutated: { status: "terminal", code: "INVALID_LOGICAL_TIME", latchByHash: true },
			mutationObserved: 10,
			acceptanceCalls: 1,
		});
	});

	it("detaches registered epoch-anchor evidence before its kind or logical time can change classification", () => {
		const anchorHash = currentEpochAnchor.hash as string;
		const validChild = signedVertex({
			anchor: anchorHash,
			dependencies: [anchorHash],
			logicalTime: 1,
		});
		const invalidTimeChild = signedVertex({
			anchor: anchorHash,
			dependencies: [anchorHash],
			logicalTime: 2,
		});
		const controlValid = phase0dHarness({ currentAnchor: anchorHash, resolved: [{ ...currentEpochAnchor }] });
		const controlInvalid = phase0dHarness({ currentAnchor: anchorHash, resolved: [{ ...currentEpochAnchor }] });
		const liveValidAnchor = { ...currentEpochAnchor };
		const liveInvalidAnchor = { ...currentEpochAnchor };
		const mutatedValid = phase0dHarness({ currentAnchor: anchorHash, resolved: [liveValidAnchor] });
		const mutatedInvalid = phase0dHarness({ currentAnchor: anchorHash, resolved: [liveInvalidAnchor] });
		mutatedValid.probes.dependencyAccepted.mockImplementation(() => {
			liveValidAnchor.kind = "drp-vertex";
			liveValidAnchor.logicalTime = 10;
			return true;
		});
		mutatedInvalid.probes.dependencyAccepted.mockImplementation(() => {
			liveInvalidAnchor.kind = "drp-vertex";
			liveInvalidAnchor.logicalTime = 1;
			return true;
		});

		expect({
			controlValid: admitVertex(validChild, controlValid.context, controlValid.hooks),
			mutatedValid: admitVertex(validChild, mutatedValid.context, mutatedValid.hooks),
			controlInvalid: admitVertex(invalidTimeChild, controlInvalid.context, controlInvalid.hooks),
			mutatedInvalid: admitVertex(invalidTimeChild, mutatedInvalid.context, mutatedInvalid.hooks),
			mutationsObserved: [
				[liveValidAnchor.kind, liveValidAnchor.logicalTime],
				[liveInvalidAnchor.kind, liveInvalidAnchor.logicalTime],
			],
		}).toEqual({
			controlValid: { status: "accept", code: "ADMISSIBLE", latchByHash: false },
			mutatedValid: { status: "accept", code: "ADMISSIBLE", latchByHash: false },
			controlInvalid: { status: "terminal", code: "INVALID_LOGICAL_TIME", latchByHash: true },
			mutatedInvalid: { status: "terminal", code: "INVALID_LOGICAL_TIME", latchByHash: true },
			mutationsObserved: [
				["drp-vertex", 10],
				["drp-vertex", 1],
			],
		});
	});

	it("reads each registered dependency field and hash once into detached evidence", () => {
		const evidenceFields = [
			"kind",
			"protocolMajor",
			"objectId",
			"epoch",
			"anchor",
			"author",
			"logicalTime",
			"dependencies",
			"operation",
			"hash",
		] as const;
		const makeAlternatingDependency = (): {
			readonly dependency: Readonly<Record<string, unknown>>;
			readonly reads: Record<(typeof evidenceFields)[number], number>;
		} => {
			const reads = Object.fromEntries(evidenceFields.map((field) => [field, 0])) as Record<
				(typeof evidenceFields)[number],
				number
			>;
			const dependency = new Proxy(
				{ ...parentLow },
				{
					get(target, property, receiver): unknown {
						if (typeof property !== "string" || !evidenceFields.includes(property as never)) {
							return Reflect.get(target, property, receiver);
						}
						const field = property as (typeof evidenceFields)[number];
						reads[field]++;
						if (reads[field] === 1) return Reflect.get(target, property, receiver);
						if (field === "kind") return "drp-epoch-anchor";
						if (field === "logicalTime") return 10;
						if (field === "hash") return ZERO_DIGEST;
						return Reflect.get(target, property, receiver);
					},
				}
			);
			return { dependency, reads };
		};
		const alternationControl = makeAlternatingDependency();
		expect([
			alternationControl.dependency.kind,
			alternationControl.dependency.kind,
			alternationControl.dependency.logicalTime,
			alternationControl.dependency.logicalTime,
			alternationControl.dependency.hash,
			alternationControl.dependency.hash,
		]).toEqual(["drp-vertex", "drp-epoch-anchor", 2, 10, parentLow.hash, ZERO_DIGEST]);

		const observed = makeAlternatingDependency();
		const harness = phase0dHarness({ resolved: [observed.dependency] });
		const result = admitVertex(validOneParentVertex, harness.context, harness.hooks);

		expect({
			result,
			reads: observed.reads,
		}).toEqual({
			result: { status: "accept", code: "ADMISSIBLE", latchByHash: false },
			reads: {
				kind: 1,
				protocolMajor: 1,
				objectId: 1,
				epoch: 1,
				anchor: 1,
				author: 1,
				logicalTime: 1,
				dependencies: 1,
				operation: 1,
				hash: 1,
			},
		});
	});

	it("requires exact logicalTime = 1 + max(dep) before ancestry or semantic work", () => {
		const runs = [4, 6].map((logicalTime) => {
			const vertex = signedVertex({ dependencies: [parentHigh.hash], logicalTime });
			const { context, hooks, probes } = phase0dHarness();
			return { probes, result: admitVertex(vertex, context, hooks) };
		});
		expect(runs.map(({ result }) => result)).toEqual(
			[4, 6].map(() => ({
				status: "terminal",
				code: "INVALID_LOGICAL_TIME",
				latchByHash: true,
			}))
		);
		for (const { probes } of runs) {
			expect(probes.ancestry).not.toHaveBeenCalled();
			expectNoSemanticWork(probes);
		}
	});

	it("treats a real registered epoch anchor as logical time zero", () => {
		const anchorHash = currentEpochAnchor.hash as string;
		const validChild = signedVertex({
			anchor: anchorHash,
			dependencies: [anchorHash],
			logicalTime: 1,
		});
		const invalidTimeChild = signedVertex({
			anchor: anchorHash,
			dependencies: [anchorHash],
			logicalTime: 2,
		});
		const harness = phase0dHarness({
			currentAnchor: anchorHash,
			resolved: [currentEpochAnchor],
		});

		expect(admitVertex(validChild, harness.context, harness.hooks)).toEqual({
			status: "accept",
			code: "ADMISSIBLE",
			latchByHash: false,
		});
		expect(admitVertex(invalidTimeChild, harness.context, harness.hooks)).toEqual({
			status: "terminal",
			code: "INVALID_LOGICAL_TIME",
			latchByHash: true,
		});
	});

	it("rejects a valid registered epoch-anchor dependency for the wrong current anchor", () => {
		const currentAnchorHash = currentEpochAnchor.hash as string;
		const otherAnchorHash = otherCurrentEpochAnchor.hash as string;
		const wrongAnchorChild = signedVertex({
			anchor: otherAnchorHash,
			dependencies: [currentAnchorHash],
			logicalTime: 1,
		});
		const wrongAnchorHarness = phase0dHarness({
			currentAnchor: otherAnchorHash,
			currentEpochAnchor: otherCurrentEpochAnchor,
			resolved: [currentEpochAnchor],
		});
		expect(admitVertex(wrongAnchorChild, wrongAnchorHarness.context, wrongAnchorHarness.hooks)).toEqual({
			status: "terminal",
			code: "DEPENDENCY_WRONG_ANCHOR",
			latchByHash: false,
		});
		expect(wrongAnchorHarness.probes.resolveDependencies).toHaveBeenCalledWith([currentAnchorHash]);
		expect(wrongAnchorHarness.probes.dependencyAccepted).not.toHaveBeenCalled();
	});

	it("uses the required exact ancestry oracle in both directions for every direct pair", () => {
		const { context, hooks, probes } = phase0dHarness({
			ancestor: (left, right) => left === parentHashes[0] && right === parentHashes[1],
		});
		expect(admitVertex(validTwoParentVertex, context, hooks)).toEqual({
			status: "terminal",
			code: "NON_ANTICHAIN_DEPENDENCIES",
			latchByHash: true,
		});
		expect(probes.ancestry).toHaveBeenCalledWith(parentHashes[0], parentHashes[1]);
		expect(probes.authorization).not.toHaveBeenCalled();
		expect(probes.operationSchema).not.toHaveBeenCalled();
		expect(probes.invariant).not.toHaveBeenCalled();
	});

	it("rejects a direct pair when only the reverse ancestry direction is true", () => {
		const { context, hooks, probes } = phase0dHarness({
			ancestor: (left, right) => left === parentHashes[1] && right === parentHashes[0],
		});

		expect(admitVertex(validTwoParentVertex, context, hooks)).toEqual({
			status: "terminal",
			code: "NON_ANTICHAIN_DEPENDENCIES",
			latchByHash: true,
		});
		expect(probes.ancestry.mock.calls).toEqual([
			[parentHashes[0], parentHashes[1]],
			[parentHashes[1], parentHashes[0]],
		]);
		expect(probes.authorization).not.toHaveBeenCalled();
		expect(probes.operationSchema).not.toHaveBeenCalled();
		expect(probes.invariant).not.toHaveBeenCalled();
	});

	it("rejects raw context evidence when the required ancestry oracle is unavailable", () => {
		const harness = phase0dHarness();
		const contextWithoutOracle = { ...harness.context } as Partial<AdmissionContext>;
		delete contextWithoutOracle.isAncestor;

		expect(prepareAdmissionContext(contextWithoutOracle as AdmissionContext)).toEqual({
			ok: false,
			code: "ADMISSION_CONTEXT_INVALID",
		});
		expect(harness.probes.authorization).not.toHaveBeenCalled();
		expect(harness.probes.operationSchema).not.toHaveBeenCalled();
		expect(harness.probes.invariant).not.toHaveBeenCalled();
	});

	it("fails closed when latched ACL authorization is false or omitted", () => {
		const denied = phase0dHarness({ authorized: false });
		expect(admitVertex(validOneParentVertex, denied.context, denied.hooks)).toEqual({
			status: "terminal",
			code: "UNAUTHORIZED",
			latchByHash: true,
		});
		expect(denied.probes.authorization).toHaveBeenCalledWith(validOneParentVertex, {
			aclDigest: ONE_DIGEST,
			anchor: defaultAnchorHash,
			epoch: 4,
			objectId: "room-a",
		});
		const epochAuthority = denied.probes.authorization.mock.calls[0]?.[1];
		expect(Object.isFrozen(epochAuthority)).toBe(true);
		expect(denied.probes.operationSchema).not.toHaveBeenCalled();
		expect(denied.probes.invariant).not.toHaveBeenCalled();

		const omitted = phase0dHarness();
		const hooksWithoutAuthorization = { ...omitted.hooks } as Partial<AdmissionHooks>;
		delete hooksWithoutAuthorization.authorize;
		expect(admitVertex(validOneParentVertex, omitted.context, hooksWithoutAuthorization as AdmissionHooks)).toEqual({
			status: "terminal",
			code: "AUTHORIZATION_UNAVAILABLE",
			latchByHash: false,
		});
		expect(omitted.probes.operationSchema).not.toHaveBeenCalled();
		expect(omitted.probes.invariant).not.toHaveBeenCalled();
	});

	it("maps a throwing hard-epoch authorizer to a stable non-latching fail-closed result", () => {
		const harness = phase0dHarness();
		harness.probes.authorization.mockImplementation(() => {
			throw new Error("host authorizer failure");
		});
		let result: AdmissionResult | undefined;

		expect(() => {
			result = admitVertex(validOneParentVertex, harness.context, harness.hooks);
		}).not.toThrow();
		expect(result).toEqual({
			status: "terminal",
			code: "AUTHORIZATION_EXCEPTION",
			latchByHash: false,
		});
		expect(harness.probes.authorization).toHaveBeenCalledOnce();
		expect(harness.probes.operationSchema).not.toHaveBeenCalled();
		expect(harness.probes.invariant).not.toHaveBeenCalled();
	});

	it("fails closed when the crypto suite or any other semantic integration hook is omitted", () => {
		const missingCrypto = phase0dHarness();
		const contextWithoutCrypto = { ...missingCrypto.context } as Partial<AdmissionContext>;
		delete contextWithoutCrypto.cryptoSuiteId;
		expect(prepareAdmissionContext(contextWithoutCrypto as AdmissionContext)).toEqual({
			ok: false,
			code: "ADMISSION_CONTEXT_INVALID",
		});
		expect(missingCrypto.probes.resolveAuthor).not.toHaveBeenCalled();

		const missingAnchorEvidence = phase0dHarness();
		const contextWithoutAnchorEvidence = { ...missingAnchorEvidence.context } as Partial<AdmissionContext>;
		delete contextWithoutAnchorEvidence.currentEpochAnchor;
		expect(prepareAdmissionContext(contextWithoutAnchorEvidence as AdmissionContext)).toEqual({
			ok: false,
			code: "ADMISSION_CONTEXT_INVALID",
		});

		const inconsistentParameters = phase0dHarness();
		expect(
			prepareAdmissionContext({
				...inconsistentParameters.context,
				parameters: { ...defaultParameters, maxDependencies: 15 },
			})
		).toEqual({
			ok: false,
			code: "ADMISSION_CONTEXT_INVALID",
		});

		const cases = [
			["resolveAuthorPublicKey", "AUTHOR_KEY_RESOLVER_UNAVAILABLE"],
			["resolveDependencies", "DEPENDENCY_RESOLVER_UNAVAILABLE"],
			["isDependencyAccepted", "DEPENDENCY_ACCEPTANCE_ORACLE_UNAVAILABLE"],
			["validateOperationSchema", "OPERATION_SCHEMA_VALIDATOR_UNAVAILABLE"],
			["validateDeterministicInvariant", "DETERMINISTIC_INVARIANT_VALIDATOR_UNAVAILABLE"],
		] as const;
		for (const [missingName, expectedCode] of cases) {
			const harness = phase0dHarness();
			const incomplete = { ...harness.hooks } as Partial<AdmissionHooks>;
			delete incomplete[missingName];
			expect(admitVertex(validOneParentVertex, harness.context, incomplete as AdmissionHooks)).toEqual({
				status: "terminal",
				code: expectedCode,
				latchByHash: false,
			});
		}
	});

	it("rejects the seal-only suite at the vertex boundary before author-key or dependency work", () => {
		const sealAnchor = epochAnchor({
			cryptoSuiteId: "ed25519-seal-v1",
			parametersDigest: defaultParametersDigest,
		});
		const sealSuiteContext = prepareTestAdmissionContext({
			cryptoSuiteId: "ed25519-seal-v1",
			currentAnchor: sealAnchor.hash as string,
			currentEpoch: 4,
			currentEpochAnchor: sealAnchor,
			isAncestor: (): boolean => false,
			objectId: "room-a",
			parameters: defaultParameters,
			protocolMajor: 2,
		});
		const harness = phase0dHarness();
		const sealSuiteVertex = signedVertex({ anchor: sealAnchor.hash });
		const result = admitVertex(sealSuiteVertex, sealSuiteContext, harness.hooks);

		expect({
			result: classificationWithLatch(result),
			calls: {
				author: harness.probes.resolveAuthor.mock.calls.length,
				dependencies: harness.probes.resolveDependencies.mock.calls.length,
				accepted: harness.probes.dependencyAccepted.mock.calls.length,
				ancestry: harness.probes.ancestry.mock.calls.length,
				authorization: harness.probes.authorization.mock.calls.length,
				schema: harness.probes.operationSchema.mock.calls.length,
				invariant: harness.probes.invariant.mock.calls.length,
			},
		}).toEqual({
			result: {
				status: "terminal",
				code: "CRYPTO_SUITE_UNAVAILABLE",
				latchByHash: false,
			},
			calls: {
				author: 0,
				dependencies: 0,
				accepted: 0,
				ancestry: 0,
				authorization: 0,
				schema: 0,
				invariant: 0,
			},
		});
	});

	it("runs operation schema before deterministic invariant and fails closed at either terminal stage", () => {
		const invalidOperation = phase0dHarness({ operationValid: false });
		expect(admitVertex(validOneParentVertex, invalidOperation.context, invalidOperation.hooks)).toEqual({
			status: "terminal",
			code: "INVALID_OPERATION_SCHEMA",
			latchByHash: true,
		});
		expect(invalidOperation.probes.operationSchema).toHaveBeenCalledOnce();
		expect(invalidOperation.probes.invariant).not.toHaveBeenCalled();

		const invalidInvariant = phase0dHarness({ invariantValid: false });
		expect(admitVertex(validOneParentVertex, invalidInvariant.context, invalidInvariant.hooks)).toEqual({
			status: "terminal",
			code: "INVARIANT_VIOLATION",
			latchByHash: true,
		});
		expect(invalidInvariant.probes.operationSchema).toHaveBeenCalledOnce();
		expect(invalidInvariant.probes.invariant).toHaveBeenCalledOnce();
	});
});

const contextWithoutRequiredAncestor = {
	cryptoSuiteId: "ed25519-sha256-v1",
	currentAnchor: defaultAnchorHash,
	currentEpoch: 4,
	currentEpochAnchor,
	objectId: "room-a",
	parameters: defaultParameters,
	protocolMajor: 2,
} as const;

// @ts-expect-error Phase 0d requires AdmissionContext.isAncestor; absence must never typecheck.
const missingAncestryOracle: AdmissionContext = contextWithoutRequiredAncestor;
void missingAncestryOracle;

const contextWithoutRequiredCryptoSuite = {
	currentAnchor: defaultAnchorHash,
	currentEpoch: 4,
	currentEpochAnchor,
	isAncestor: (): boolean => false,
	objectId: "room-a",
	parameters: defaultParameters,
	protocolMajor: 2,
} as const;

// @ts-expect-error Phase 0d requires AdmissionContext.cryptoSuiteId; absence must never typecheck.
const missingCryptoSuite: AdmissionContext = contextWithoutRequiredCryptoSuite;
void missingCryptoSuite;

// @ts-expect-error Phase 0d limits come from the anchor's parameters, not a caller-owned context field.
type CallerOwnedMaxDependenciesMustNotExist = AdmissionContext["maxDependencies"];
// @ts-expect-error Phase 0d byte limits come from anchored parameters, not a caller-owned context field.
type CallerOwnedMaxBytesMustNotExist = AdmissionContext["maxBytes"];
type _CallerOwnedLimitDiagnostics = [CallerOwnedMaxDependenciesMustNotExist, CallerOwnedMaxBytesMustNotExist];

const contextWithoutAnchoredParameters = {
	cryptoSuiteId: "ed25519-sha256-v1",
	currentAnchor: defaultAnchorHash,
	currentEpoch: 4,
	isAncestor: (): boolean => false,
	objectId: "room-a",
	protocolMajor: 2,
} as const;

// @ts-expect-error Phase 0d requires the verified current anchor and its digest-bound parameters.
const missingAnchoredParameters: AdmissionContext = contextWithoutAnchoredParameters;
void missingAnchoredParameters;

type _AdmissionResultMustExposeExplicitHashLatchPolicy = AdmissionResult["latchByHash"];
