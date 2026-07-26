import { ESLint } from "eslint";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import registryJson from "../registry/field-registry.json" with { type: "json" };
import {
	type AdmissionContext,
	admitVertex,
	digestRegistryPreimage,
	makeRegistryPreimageBuilder,
	type QcVote,
	quorumCertificateBytes,
	type RegistryDocument,
	registryDomain,
	signerSetBytes,
	verifyVertexHash,
	vertexDigest,
} from "../src/index.js";
import { protocolRegistry } from "../src/registry.js";

const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clonedRegistry(): RegistryDocument {
	return structuredClone(registryJson) as RegistryDocument;
}

const parameters = {
	maxEpochVertices: 8192,
	maxEpochBytes: 8 * 1024 * 1024,
	maxDependencies: 16,
	snapshotChunkBytes: 128 * 1024,
	maxSnapshotBytes: 256 * 1024 * 1024,
	maxPendingEntries: 4096,
	maxPendingBytes: 16 * 1024 * 1024,
};

function cutValue(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
	return {
		objectId: "room-a",
		epoch: 4,
		previousAnchor: ZERO_DIGEST,
		previousCutDigest: ZERO_DIGEST,
		previousHistoryRoot: ZERO_DIGEST,
		previousHistorySize: 0,
		closeSetRoot: ONE_DIGEST,
		closeSetCount: 1,
		historyRoot: ONE_DIGEST,
		historySize: 1,
		stateDigest: ZERO_DIGEST,
		aclDigest: ZERO_DIGEST,
		snapshotManifestDigest: ZERO_DIGEST,
		blueprintDigest: ZERO_DIGEST,
		archiveIndexRoot: ZERO_DIGEST,
		availabilityPolicyDigest: ZERO_DIGEST,
		nextSignerSet: [],
		parameters,
		closeReason: "size",
		...overrides,
	};
}

function vote(overrides: Partial<QcVote> = {}): QcVote {
	return {
		objectId: "room-a",
		epoch: 4,
		round: 2,
		phase: "prepare",
		proposalDigest: ZERO_DIGEST,
		proposalHash: ONE_DIGEST,
		signerId: "peer-a",
		signature: "sig-a",
		...overrides,
	};
}

const certificate = {
	objectId: "room-a",
	epoch: 4,
	round: 2,
	phase: "prepare" as const,
	proposalDigest: ZERO_DIGEST,
	proposalHash: ONE_DIGEST,
	votes: [vote()],
};

const admissionContext: AdmissionContext = {
	currentAnchor: ZERO_DIGEST,
	currentEpoch: 4,
	maxBytes: 1024,
	maxDependencies: 16,
	objectId: "room-a",
	protocolMajor: 2,
};

function admissionVertex(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
	return {
		kind: "drp-vertex",
		protocolMajor: 2,
		objectId: "room-a",
		epoch: 4,
		anchor: ZERO_DIGEST,
		author: "peer-a",
		logicalTime: 1,
		dependencies: [ONE_DIGEST],
		operation: { op: "set" },
		hash: ZERO_DIGEST,
		encodedByteLength: 128,
		...overrides,
	};
}

function hashedVertex(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
	const fields = admissionVertex(overrides);
	return { ...fields, hash: hex(vertexDigest(fields as never)) };
}

describe("reviewer production-hardening regressions", () => {
	it("C1 strips injected signer keys so the digest stays unchanged and matches the oracle", async () => {
		const clean = [{ signerId: "peer-a", publicKey: "pk-a" }];
		const injected = [{ signerId: "peer-a", publicKey: "pk-a", rogue: "injected" }];
		const document = clonedRegistry();
		const cleanDigest = digestRegistryPreimage(document, "signerSet", { signers: clean });
		const injectedDigest = digestRegistryPreimage(document, "signerSet", { signers: injected });
		const referencePath: string = "../conformance/ahe-reference/src/protocol.js";
		const reference = (await import(referencePath)) as {
			signerSetDigest(signers: readonly Readonly<Record<string, unknown>>[]): Promise<string>;
		};

		expect(injectedDigest).toEqual(cleanDigest);
		expect(hex(cleanDigest)).toBe(await reference.signerSetDigest(injected));
		expect(signerSetBytes(injected)).toEqual(signerSetBytes(clean));
	});

	it("C1 applies the same declared-key normalization to every typed nested object", () => {
		const document = clonedRegistry();
		const probeDocument = {
			...document,
			kinds: {
				...document.kinds,
				probe: {
					domain: "ts-drp/probe/v2",
					encoding: "canonical-object",
					fields: [
						{
							name: "signers",
							type: "array<signer>",
							const: null,
							constraints: {},
							required: true,
							sortRule: null,
						},
						{
							name: "chunks",
							type: "array<{index,digest,byteLength}>",
							const: null,
							constraints: {},
							required: true,
							sortRule: null,
						},
						{
							name: "votes",
							type: "array<signed-seal-vote>",
							const: null,
							constraints: {},
							required: true,
							sortRule: null,
						},
						{
							name: "qc",
							type: "seal-qc|null",
							const: null,
							constraints: {},
							required: true,
							sortRule: null,
						},
					],
				},
			},
		} as RegistryDocument;
		const signedVote = { ...vote(), kind: "drp-seal-vote" };
		const clean = {
			signers: [{ signerId: "peer-a", publicKey: "pk-a" }],
			chunks: [{ index: 0, digest: ZERO_DIGEST, byteLength: 1 }],
			votes: [signedVote],
			qc: { ...certificate, kind: "drp-seal-qc", votes: [signedVote] },
		};
		const injected = {
			signers: [{ ...clean.signers[0], rogue: true }],
			chunks: [{ ...clean.chunks[0], rogue: true }],
			votes: [{ ...signedVote, rogue: true }],
			qc: {
				...clean.qc,
				rogue: true,
				votes: [{ ...signedVote, rogue: true }],
			},
		};
		const build = makeRegistryPreimageBuilder(probeDocument, "probe");

		expect(build(injected)).toEqual(build(clean));
	});

	it("C2 rejects a domain shared by two registry kinds", () => {
		const document = clonedRegistry() as RegistryDocument & {
			domains: Record<string, string>;
			kinds: Record<string, { domain: string }>;
		};
		const duplicated = document.domains.state as string;
		document.domains.cutValue = duplicated;
		document.kinds.cutValue = { ...document.kinds.cutValue, domain: duplicated };

		expect(() => registryDomain(document, "cutValue")).toThrow(/duplicate registry domain/i);
	});

	it("C3 rejects a vertex that omits the required anchor", () => {
		const vertex = { ...admissionVertex() } as Record<string, unknown>;
		delete vertex.anchor;
		expect(
			admitVertex(vertex, admissionContext, {
				isAncestor: () => false,
				resolveDependencies: () => [],
			})
		).toEqual({ status: "terminal", code: "INVALID_HASH" });
	});

	it("C4 returns a deeply frozen registry that callers cannot rewrite", () => {
		const first = protocolRegistry();
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.domains)).toBe(true);
		expect(Object.isFrozen(first.kinds.vertex?.fields)).toBe(true);
		expect(() => {
			(first.domains as Record<string, string>).vertex = "MUTATED";
		}).toThrow(TypeError);
		expect(protocolRegistry().domains.vertex).toBe("ts-drp/vertex/v2");
	});

	it("C5 requires all vertex fields and a non-empty dependency list", () => {
		const hooks = {
			isAncestor: (): boolean => false,
			resolveDependencies: (): readonly unknown[] => [],
		};
		const skeletal = {
			encodedByteLength: 1,
			hash: ZERO_DIGEST,
			objectId: "room-a",
			protocolMajor: 2,
			epoch: 4,
			anchor: ZERO_DIGEST,
		};

		expect(admitVertex(skeletal, admissionContext, hooks)).not.toEqual({ status: "accept", code: "ADMISSIBLE" });
		expect(admitVertex(admissionVertex({ dependencies: [] }), admissionContext, hooks)).toEqual({
			status: "terminal",
			code: "MISSING_DEPENDENCIES",
		});
	});

	it("C5 consumes resolved dependency envelopes, ancestry, and anchor grounding", () => {
		const parent = hashedVertex({ logicalTime: 1, operation: { op: "parent" } });
		const child = hashedVertex({ dependencies: [parent.hash], logicalTime: 2, operation: { op: "child" } });
		const hooks = {
			isAncestor: (): boolean => false,
			resolveDependencies: (): readonly unknown[] => [parent],
		};
		expect(admitVertex(child, admissionContext, hooks)).toEqual({ status: "accept", code: "ADMISSIBLE" });
		expect(
			admitVertex(child, admissionContext, {
				...hooks,
				resolveDependencies: () => [],
			})
		).toEqual({ status: "pending", code: "MISSING_CURRENT_EPOCH_DEPENDENCIES" });
		expect(
			admitVertex(child, admissionContext, {
				...hooks,
				resolveDependencies: () => [{ ...parent, operation: { op: "tampered" } }],
			})
		).toEqual({ status: "terminal", code: "INVALID_DEPENDENCY_ENVELOPE" });

		const otherObjectParent = hashedVertex({ objectId: "room-b" });
		const otherObjectChild = hashedVertex({ dependencies: [otherObjectParent.hash], logicalTime: 2 });
		expect(
			admitVertex(otherObjectChild, admissionContext, {
				...hooks,
				resolveDependencies: () => [otherObjectParent],
			})
		).toEqual({ status: "terminal", code: "DEPENDENCY_DOMAIN_MISMATCH" });

		const wrongEpochParent = hashedVertex({ epoch: 3 });
		const wrongEpochChild = hashedVertex({ dependencies: [wrongEpochParent.hash], logicalTime: 2 });
		expect(
			admitVertex(wrongEpochChild, admissionContext, {
				...hooks,
				resolveDependencies: () => [wrongEpochParent],
			})
		).toEqual({ status: "terminal", code: "DEPENDENCY_WRONG_EPOCH" });

		const nonMonotoneParent = hashedVertex({ logicalTime: 2 });
		const nonMonotoneChild = hashedVertex({ dependencies: [nonMonotoneParent.hash], logicalTime: 2 });
		expect(
			admitVertex(nonMonotoneChild, admissionContext, {
				...hooks,
				resolveDependencies: () => [nonMonotoneParent],
			})
		).toEqual({ status: "terminal", code: "NON_MONOTONE_LOGICAL_TIME" });

		const secondParent = hashedVertex({ author: "peer-b", operation: { op: "second-parent" } });
		const twoParentChild = hashedVertex({
			dependencies: [parent.hash, secondParent.hash],
			logicalTime: 2,
		});
		expect(
			admitVertex(twoParentChild, admissionContext, {
				isAncestor: (left, right) => left === parent.hash && right === secondParent.hash,
				resolveDependencies: () => [parent, secondParent],
			})
		).toEqual({ status: "terminal", code: "NON_ANTICHAIN_DEPENDENCIES" });
	});

	it("C6 exposes package-owned vertex hashing and rejects an echo-hook integration", async () => {
		const runtime = (await import("../src/index.js")) as Record<string, unknown>;
		expect(runtime.verifyVertexHash).toBeTypeOf("function");
		expect(runtime.vertexDigest).toBeTypeOf("function");
		const preimage = admissionVertex({ dependencies: [ONE_DIGEST] });
		const hash = hex(vertexDigest(preimage as never));
		expect(verifyVertexHash({ ...preimage, hash })).toBe(true);
		expect(verifyVertexHash({ ...preimage, operation: { op: "tampered" }, hash })).toBe(false);
	});

	it("C7 enforces nested parameters, enum declarations, cut strings, and cross-field invariants", () => {
		const document = clonedRegistry();
		const buildCut = makeRegistryPreimageBuilder(document, "cutValue");
		expect(() => buildCut(cutValue({ parameters: { ...parameters, maxEpochVertices: 1 } }))).toThrow(
			/parameters\.maxEpochVertices.*minimum/i
		);
		expect(() => buildCut(cutValue({ objectId: "" }))).toThrow(/cutValue\.objectId.*minimumUtf16Units/i);
		expect(() => buildCut(cutValue({ previousHistorySize: 100, closeSetCount: 1, historySize: 0 }))).toThrow(
			/history size/i
		);
		expect(() => buildCut(cutValue({ nextSignerSet: [{ signerId: "peer-a", publicKey: "pk-a" }] }))).toThrow(
			/at least four signers/i
		);

		const emptyEnumDocument = {
			...document,
			domains: { ...document.domains, probe: "ts-drp/probe/v2" },
			kinds: {
				...document.kinds,
				probe: {
					domain: "ts-drp/probe/v2",
					encoding: "canonical-object",
					fields: [
						{
							name: "mode",
							type: "enum",
							const: null,
							constraints: {},
							required: true,
							sortRule: null,
						},
					],
				},
			},
		} as RegistryDocument;
		expect(() => makeRegistryPreimageBuilder(emptyEnumDocument, "probe")({ mode: "anything" })).toThrow(
			/enum.*non-empty values/i
		);

		const profileDocument = clonedRegistry();
		const quorumField = profileDocument.kinds.profile?.fields.find((field) => field.name === "quorum");
		const suiteField = profileDocument.kinds.profile?.fields.find((field) => field.name === "cryptoSuiteId");
		if (quorumField === undefined || suiteField === undefined)
			throw new Error("profile constraint fixtures are missing");
		const quorumConstraints = quorumField.constraints as Record<string, unknown>;
		const suiteConstraints = suiteField.constraints as Record<string, unknown>;
		quorumConstraints.creator = 2;
		quorumConstraints.delegatedMinimum = 3;
		const buildProfile = makeRegistryPreimageBuilder(profileDocument, "profile");
		const profileSigners = ["a", "b", "c", "d"].map((signerId) => ({
			signerId,
			publicKey: `pk-${signerId}`,
		}));
		expect(() =>
			buildProfile({
				profileId: "creator-trusted-v1",
				signers: [],
				quorum: 1,
				cryptoSuiteId: "ed25519-sha256-v1",
			})
		).toThrow(/creator quorum 2/i);
		expect(() =>
			buildProfile({
				profileId: "delegated-trusted-v1",
				signers: profileSigners,
				quorum: 2,
				cryptoSuiteId: "ed25519-sha256-v1",
			})
		).toThrow(/delegated minimum 3/i);
		quorumConstraints.attestedFormula = "floor(2*n/3)";
		expect(() =>
			buildProfile({
				profileId: "attested-bft-v1",
				signers: profileSigners,
				quorum: 3,
				cryptoSuiteId: "ed25519-sha256-v1",
			})
		).toThrow(/quorum constraints are invalid/i);
		quorumConstraints.attestedFormula = "ceil(2*n/3)";
		suiteConstraints.negotiatedAt = "any-epoch";
		expect(() =>
			buildProfile({
				profileId: "attested-bft-v1",
				signers: profileSigners,
				quorum: 3,
				cryptoSuiteId: "ed25519-sha256-v1",
			})
		).toThrow(/unsupported negotiatedAt/i);
	});

	it("C8 pins delegated and attested quorum rules", () => {
		const buildProfile = makeRegistryPreimageBuilder(clonedRegistry(), "profile");
		const signers = ["a", "b", "c", "d"].map((signerId) => ({ signerId, publicKey: `pk-${signerId}` }));
		expect(() =>
			buildProfile({
				profileId: "delegated-trusted-v1",
				signers: signers.slice(0, 2),
				quorum: 1,
				cryptoSuiteId: "ed25519-sha256-v1",
			})
		).toThrow(/delegated minimum 2/i);
		expect(() =>
			buildProfile({
				profileId: "attested-bft-v1",
				signers,
				quorum: 2,
				cryptoSuiteId: "ed25519-sha256-v1",
			})
		).toThrow(/ceil\(2\*n\/3\)/i);
		expect(() =>
			buildProfile({
				profileId: "attested-bft-v1",
				signers,
				quorum: 3,
				cryptoSuiteId: "ed25519-sha256-v1",
			})
		).not.toThrow();
	});

	it("C9 rejects empty and header-mismatched QC votes", () => {
		expect(() => quorumCertificateBytes({ ...certificate, votes: [] })).toThrow(/EMPTY_QC/);
		expect(() =>
			quorumCertificateBytes({
				...certificate,
				votes: [vote({ proposalDigest: ONE_DIGEST })],
			})
		).toThrow(/MIXED_QC.*proposalDigest/i);
	});

	it("C10 bans globalThis.structuredClone and makes the package test script non-watching", async () => {
		const workspace = fileURLToPath(new URL("../../..", import.meta.url));
		const eslint = new ESLint({ cwd: workspace });
		const fixturePath = fileURLToPath(new URL("../src/admission.ts", import.meta.url));
		const [result] = await eslint.lintText("export const clone = globalThis.structuredClone({ value: -0 });", {
			filePath: fixturePath,
		});
		expect(result?.messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-properties", severity: 2 })])
		);

		const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			scripts: { test: string };
		};
		expect(packageJson.scripts.test).toBe("vitest run");
	}, 15_000);

	it("C11 runs every mutant against the whole package suite", () => {
		const source = readFileSync(new URL("../stryker.config.mjs", import.meta.url), "utf8");
		expect(source).toMatch(/coverageAnalysis:\s*"off"/u);
		expect(source).toMatch(/related:\s*false/u);
		expect(source).toMatch(/!packages\/protocol-v2\/docs\/porting-rules\.md/u);
	});
});
