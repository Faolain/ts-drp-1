import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";

import { prepareTestAdmissionContext } from "./admission-context-fixture.js";
import {
	type AdmissionHooks,
	admitVertex,
	digestRegistryPreimage,
	type PreparedAdmissionContext,
	type SignaturePublicKey,
	signIdentityDigest,
} from "../src/index.js";
import type * as Protocol from "../src/protocol.js";
import { protocolRegistry } from "../src/registry.js";
import type * as Signature from "../src/signature.js";

const vertexDigestComputations = vi.hoisted(() => vi.fn());
const signatureVerifications = vi.hoisted(() => vi.fn());

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
const IDENTITY_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const IDENTITY_PUBLIC_KEY: SignaturePublicKey = {
	bytes: ed25519.getPublicKey(IDENTITY_SEED),
	format: "raw",
};
const parameters = {
	maxEpochVertices: 8192,
	maxEpochBytes: 8 * 1024 * 1024,
	maxDependencies: 16,
	snapshotChunkBytes: 128 * 1024,
	maxSnapshotBytes: 256 * 1024 * 1024,
	maxPendingEntries: 4096,
	maxPendingBytes: 16 * 1024 * 1024,
} as const;
const registry = protocolRegistry();

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const parametersDigest = hex(digestRegistryPreimage(registry, "parameters", parameters));
const currentEpochAnchorPreimage = {
	kind: "drp-epoch-anchor",
	protocolMajor: 2,
	objectId: "right-room",
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
	parametersDigest,
	profileDigest: ONE_DIGEST,
	cryptoSuiteId: "ed25519-sha256-v1",
} as const;
const currentEpochAnchor = {
	...currentEpochAnchorPreimage,
	hash: hex(digestRegistryPreimage(registry, "epochAnchor", currentEpochAnchorPreimage)),
};

describe("Phase 0d D3 registered-digest work gate", () => {
	it("performs zero package-owned vertex-digest computations for a wrong-object batch", () => {
		const context: PreparedAdmissionContext = prepareTestAdmissionContext({
			cryptoSuiteId: "ed25519-sha256-v1",
			currentAnchor: currentEpochAnchor.hash,
			currentEpoch: 4,
			currentEpochAnchor,
			isAncestor: (): boolean => false,
			objectId: "right-room",
			parameters,
			protocolMajor: 2,
		});
		const hooks: AdmissionHooks = {
			authorize: vi.fn(() => true),
			isDependencyAccepted: vi.fn(() => true),
			resolveAuthorPublicKey: vi.fn(() => undefined),
			resolveDependencies: vi.fn(() => []),
			validateDeterministicInvariant: vi.fn(() => true),
			validateOperationSchema: vi.fn(() => true),
		};
		const wrongObjectBatch = Array.from({ length: 8 }, (_, index) => ({
			anchor: currentEpochAnchor.hash,
			author: "peer-a",
			dependencies: [currentEpochAnchor.hash],
			epoch: 4,
			hash: ZERO_DIGEST,
			kind: "drp-vertex",
			logicalTime: 1,
			objectId: `wrong-room-${index}`,
			operation: { action: "set", index },
			protocolMajor: 2,
			signature: new Uint8Array(64),
		}));
		vertexDigestComputations.mockClear();
		signatureVerifications.mockClear();
		const results = wrongObjectBatch.map((vertex) => admitVertex(vertex, context, hooks));

		expect(vertexDigestComputations).not.toHaveBeenCalled();
		expect(signatureVerifications).not.toHaveBeenCalled();
		expect(results).toEqual(
			Array.from({ length: 8 }, () => ({ status: "terminal", code: "WRONG_OBJECT", latchByHash: false }))
		);
		expect(hooks.resolveAuthorPublicKey).not.toHaveBeenCalled();
		expect(hooks.resolveDependencies).not.toHaveBeenCalled();
	});

	it("checks the anchor-bound dependency limit before traversing attacker-sized elements", () => {
		let dependencyElementReads = 0;
		let dependencyIteratorReads = 0;
		const denseDependencies = Array.from({ length: parameters.maxDependencies + 1 }, (_, index) =>
			(index + 1).toString(16).padStart(64, "0")
		);
		const dependencies = new Proxy(denseDependencies, {
			get(target, property, receiver): unknown {
				if (typeof property === "string" && /^(?:0|[1-9][0-9]*)$/u.test(property)) {
					dependencyElementReads++;
				}
				if (property === Symbol.iterator) dependencyIteratorReads++;
				return Reflect.get(target, property, receiver);
			},
		});
		const ancestry = vi.fn(() => false);
		const context: PreparedAdmissionContext = prepareTestAdmissionContext({
			cryptoSuiteId: "ed25519-sha256-v1",
			currentAnchor: currentEpochAnchor.hash,
			currentEpoch: 4,
			currentEpochAnchor,
			isAncestor: ancestry,
			objectId: "right-room",
			parameters,
			protocolMajor: 2,
		});
		const hooks: AdmissionHooks = {
			authorize: vi.fn(() => true),
			isDependencyAccepted: vi.fn(() => true),
			resolveAuthorPublicKey: vi.fn(() => undefined),
			resolveDependencies: vi.fn(() => []),
			validateDeterministicInvariant: vi.fn(() => true),
			validateOperationSchema: vi.fn(() => true),
		};
		const vertex = {
			anchor: currentEpochAnchor.hash,
			author: "peer-a",
			dependencies,
			epoch: 4,
			hash: ZERO_DIGEST,
			kind: "drp-vertex",
			logicalTime: 1,
			objectId: "right-room",
			operation: { action: "set" },
			protocolMajor: 2,
			signature: new Uint8Array(64),
		};

		vertexDigestComputations.mockClear();
		const result = admitVertex(vertex, context, hooks);

		expect({
			result,
			dependencyElementReads,
			dependencyIteratorReads,
			digestComputations: vertexDigestComputations.mock.calls.length,
			authorKeyResolutions: vi.mocked(hooks.resolveAuthorPublicKey).mock.calls.length,
			dependencyResolutions: vi.mocked(hooks.resolveDependencies).mock.calls.length,
			dependencyAcceptanceChecks: vi.mocked(hooks.isDependencyAccepted).mock.calls.length,
			ancestryChecks: ancestry.mock.calls.length,
			authorizationChecks: vi.mocked(hooks.authorize).mock.calls.length,
			operationSchemaChecks: vi.mocked(hooks.validateOperationSchema).mock.calls.length,
			invariantChecks: vi.mocked(hooks.validateDeterministicInvariant).mock.calls.length,
		}).toEqual({
			result: { status: "terminal", code: "LIMIT_EXCEEDED", latchByHash: false },
			dependencyElementReads: 0,
			dependencyIteratorReads: 0,
			digestComputations: 0,
			authorKeyResolutions: 0,
			dependencyResolutions: 0,
			dependencyAcceptanceChecks: 0,
			ancestryChecks: 0,
			authorizationChecks: 0,
			operationSchemaChecks: 0,
			invariantChecks: 0,
		});
	});

	it("quarantines a sparse dependency array before digest, key, dependency or semantic work", () => {
		const sparseDependencies: string[] = [];
		sparseDependencies.length = 1;
		expect(Object.hasOwn(sparseDependencies, 0)).toBe(false);
		const inheritedDependencies: string[] = [];
		inheritedDependencies.length = 1;
		const inheritedPrototype = Object.create(Array.prototype) as string[];
		Object.defineProperty(inheritedPrototype, 0, {
			configurable: true,
			enumerable: true,
			value: currentEpochAnchor.hash,
		});
		Object.setPrototypeOf(inheritedDependencies, inheritedPrototype);
		expect(Object.hasOwn(inheritedDependencies, 0)).toBe(false);
		expect(inheritedDependencies[0]).toBe(currentEpochAnchor.hash);
		const ancestry = vi.fn(() => false);
		const context: PreparedAdmissionContext = prepareTestAdmissionContext({
			cryptoSuiteId: "ed25519-sha256-v1",
			currentAnchor: currentEpochAnchor.hash,
			currentEpoch: 4,
			currentEpochAnchor,
			isAncestor: ancestry,
			objectId: "right-room",
			parameters,
			protocolMajor: 2,
		});
		const hooks: AdmissionHooks = {
			authorize: vi.fn(() => true),
			isDependencyAccepted: vi.fn(() => true),
			resolveAuthorPublicKey: vi.fn(() => undefined),
			resolveDependencies: vi.fn(() => []),
			validateDeterministicInvariant: vi.fn(() => true),
			validateOperationSchema: vi.fn(() => true),
		};
		const vertices = [sparseDependencies, inheritedDependencies].map((dependencies) => ({
			anchor: currentEpochAnchor.hash,
			author: "peer-a",
			dependencies,
			epoch: 4,
			hash: ZERO_DIGEST,
			kind: "drp-vertex",
			logicalTime: 1,
			objectId: "right-room",
			operation: { action: "set" },
			protocolMajor: 2,
			signature: new Uint8Array(64),
		}));

		vertexDigestComputations.mockClear();
		signatureVerifications.mockClear();
		const results = vertices.map((vertex) => admitVertex(vertex, context, hooks));

		expect({
			results,
			digestComputations: vertexDigestComputations.mock.calls.length,
			signatureVerifications: signatureVerifications.mock.calls.length,
			authorKeyResolutions: vi.mocked(hooks.resolveAuthorPublicKey).mock.calls.length,
			dependencyResolutions: vi.mocked(hooks.resolveDependencies).mock.calls.length,
			dependencyAcceptanceChecks: vi.mocked(hooks.isDependencyAccepted).mock.calls.length,
			ancestryChecks: ancestry.mock.calls.length,
			authorizationChecks: vi.mocked(hooks.authorize).mock.calls.length,
			operationSchemaChecks: vi.mocked(hooks.validateOperationSchema).mock.calls.length,
			invariantChecks: vi.mocked(hooks.validateDeterministicInvariant).mock.calls.length,
		}).toEqual({
			results: Array.from({ length: 2 }, () => ({
				status: "quarantine",
				code: "NON_CANONICAL_ENVELOPE",
				latchByHash: false,
			})),
			digestComputations: 0,
			signatureVerifications: 0,
			authorKeyResolutions: 0,
			dependencyResolutions: 0,
			dependencyAcceptanceChecks: 0,
			ancestryChecks: 0,
			authorizationChecks: 0,
			operationSchemaChecks: 0,
			invariantChecks: 0,
		});
	});

	it("quarantines an unsorted representation before candidate digest, key, dependency or semantic work", () => {
		const sortedDependencies = [currentEpochAnchor.hash, "2".repeat(64)].sort();
		const unsortedDependencies = [...sortedDependencies].reverse();
		expect(unsortedDependencies).not.toEqual(sortedDependencies);
		const preimage = {
			anchor: currentEpochAnchor.hash,
			author: "peer-a",
			dependencies: unsortedDependencies,
			epoch: 4,
			kind: "drp-vertex",
			logicalTime: 1,
			objectId: "right-room",
			operation: { action: "set" },
			protocolMajor: 2,
		} as const;
		const digest = digestRegistryPreimage(registry, "vertex", preimage);
		const vertex = {
			...preimage,
			hash: hex(digest),
			signature: signIdentityDigest(IDENTITY_SEED, digest),
		};
		const ancestry = vi.fn(() => false);
		const context: PreparedAdmissionContext = prepareTestAdmissionContext({
			cryptoSuiteId: "ed25519-sha256-v1",
			currentAnchor: currentEpochAnchor.hash,
			currentEpoch: 4,
			currentEpochAnchor,
			isAncestor: ancestry,
			objectId: "right-room",
			parameters,
			protocolMajor: 2,
		});
		const hooks: AdmissionHooks = {
			authorize: vi.fn(() => true),
			isDependencyAccepted: vi.fn(() => true),
			resolveAuthorPublicKey: vi.fn(() => IDENTITY_PUBLIC_KEY),
			resolveDependencies: vi.fn(() => []),
			validateDeterministicInvariant: vi.fn(() => true),
			validateOperationSchema: vi.fn(() => true),
		};

		vertexDigestComputations.mockClear();
		signatureVerifications.mockClear();
		const result = admitVertex(vertex, context, hooks);

		expect({
			result,
			digestComputations: vertexDigestComputations.mock.calls.length,
			signatureVerifications: signatureVerifications.mock.calls.length,
			authorKeyResolutions: vi.mocked(hooks.resolveAuthorPublicKey).mock.calls.length,
			dependencyResolutions: vi.mocked(hooks.resolveDependencies).mock.calls.length,
			dependencyAcceptanceChecks: vi.mocked(hooks.isDependencyAccepted).mock.calls.length,
			ancestryChecks: ancestry.mock.calls.length,
			authorizationChecks: vi.mocked(hooks.authorize).mock.calls.length,
			operationSchemaChecks: vi.mocked(hooks.validateOperationSchema).mock.calls.length,
			invariantChecks: vi.mocked(hooks.validateDeterministicInvariant).mock.calls.length,
		}).toEqual({
			result: { status: "quarantine", code: "NON_CANONICAL_ENVELOPE", latchByHash: false },
			digestComputations: 0,
			signatureVerifications: 0,
			authorKeyResolutions: 0,
			dependencyResolutions: 0,
			dependencyAcceptanceChecks: 0,
			ancestryChecks: 0,
			authorizationChecks: 0,
			operationSchemaChecks: 0,
			invariantChecks: 0,
		});
	});

	it("computes the registered vertex digest exactly once before signature rejection", () => {
		const preimage = {
			anchor: currentEpochAnchor.hash,
			author: "peer-a",
			dependencies: [currentEpochAnchor.hash],
			epoch: 4,
			kind: "drp-vertex",
			logicalTime: 1,
			objectId: "right-room",
			operation: { action: "set" },
			protocolMajor: 2,
		} as const;
		const vertex = {
			...preimage,
			hash: hex(digestRegistryPreimage(registry, "vertex", preimage)),
			signature: new Uint8Array(64),
		};
		const context: PreparedAdmissionContext = prepareTestAdmissionContext({
			cryptoSuiteId: "ed25519-sha256-v1",
			currentAnchor: currentEpochAnchor.hash,
			currentEpoch: 4,
			currentEpochAnchor,
			isAncestor: (): boolean => false,
			objectId: "right-room",
			parameters,
			protocolMajor: 2,
		});
		const hooks: AdmissionHooks = {
			authorize: vi.fn(() => true),
			isDependencyAccepted: vi.fn(() => true),
			resolveAuthorPublicKey: vi.fn(() => IDENTITY_PUBLIC_KEY),
			resolveDependencies: vi.fn(() => []),
			validateDeterministicInvariant: vi.fn(() => true),
			validateOperationSchema: vi.fn(() => true),
		};

		vertexDigestComputations.mockClear();
		signatureVerifications.mockClear();
		expect(admitVertex(vertex, context, hooks)).toEqual({
			status: "terminal",
			code: "INVALID_SIGNATURE",
			latchByHash: false,
		});
		expect(vertexDigestComputations).toHaveBeenCalledTimes(1);
		expect(signatureVerifications).toHaveBeenCalledTimes(1);
		expect(hooks.resolveDependencies).not.toHaveBeenCalled();
	});
});
