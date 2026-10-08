import { ed25519 } from "@noble/curves/ed25519.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
	type AdmissionContext,
	type AdmissionHooks,
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

interface EpochVertex {
	anchor?: string;
	dependencies: string[];
	epoch: number;
	hash: string;
	kind: "drp-epoch-anchor" | "drp-vertex";
	objectId: string;
}

interface CausalityIndexInstance {
	isAncestor(ancestorHash: string, descendantHash: string): boolean;
}

type CausalityIndexConstructor = new (
	vertices: ReadonlyMap<string, EpochVertex>,
	order?: readonly string[]
) => CausalityIndexInstance;
let CausalityIndexOwner: CausalityIndexConstructor;

interface AdmissionScenario {
	readonly anchor: Readonly<Record<string, unknown>>;
	readonly anchorHash: string;
	readonly candidate: Readonly<Record<string, unknown>>;
	readonly context: PreparedAdmissionContext;
	readonly hooks: AdmissionHooks;
	readonly index: CausalityIndexInstance;
	readonly semanticCalls: {
		readonly authorization: ReturnType<typeof vi.fn>;
		readonly invariant: ReturnType<typeof vi.fn>;
		readonly operationSchema: ReturnType<typeof vi.fn>;
	};
	readonly vertices: readonly Readonly<Record<string, unknown>>[];
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function epochAnchor(parameters: AdmissionContext["parameters"]): Readonly<Record<string, unknown>> {
	const parametersDigest = hex(digestRegistryPreimage(registry, "parameters", { ...parameters }));
	const preimage = {
		kind: "drp-epoch-anchor",
		protocolMajor: 2,
		objectId: "phase-0e-room",
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
	};
	return {
		...preimage,
		hash: hex(digestRegistryPreimage(registry, "epochAnchor", preimage)),
	};
}

function signedVertex(
	anchorHash: string,
	overrides: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
	const preimage = {
		kind: "drp-vertex",
		protocolMajor: 2,
		objectId: "phase-0e-room",
		epoch: 4,
		anchor: anchorHash,
		author: "phase-0e-author",
		logicalTime: 1,
		dependencies: [anchorHash],
		operation: { action: "phase-0e" },
		...overrides,
	};
	const digest = vertexDigest(preimage as never);
	return {
		...preimage,
		hash: hex(digest),
		signature: signIdentityDigest(IDENTITY_SEED, digest),
	};
}

function graphVertex(envelope: Readonly<Record<string, unknown>>): EpochVertex {
	const anchor = envelope.anchor;
	return {
		...(typeof anchor === "string" ? { anchor } : {}),
		dependencies: [...(envelope.dependencies as readonly string[])],
		epoch: envelope.epoch as number,
		hash: envelope.hash as string,
		kind: envelope.kind as EpochVertex["kind"],
		objectId: envelope.objectId as string,
	};
}

function scenario(
	dependencyCount: number,
	ancestryOverride?: (left: string, right: string) => boolean
): AdmissionScenario {
	const parameters: AdmissionContext["parameters"] = {
		maxDependencies: dependencyCount,
		maxEpochBytes: 8 * 1024 * 1024,
		maxEpochVertices: 8192,
		maxPendingBytes: 16 * 1024 * 1024,
		maxPendingEntries: 4096,
		maxSnapshotBytes: 256 * 1024 * 1024,
		snapshotChunkBytes: 128 * 1024,
	};
	const anchor = epochAnchor(parameters);
	const anchorHash = anchor.hash as string;
	const vertices = Array.from({ length: dependencyCount }, (_, index) =>
		signedVertex(anchorHash, {
			author: `phase-0e-parent-${index.toString().padStart(3, "0")}`,
			operation: { action: "parent", index },
		})
	).sort((left, right) => String(left.hash).localeCompare(String(right.hash), "en-US"));
	const graph = new Map<string, EpochVertex>([
		[
			anchorHash,
			{
				dependencies: [],
				epoch: 4,
				hash: anchorHash,
				kind: "drp-epoch-anchor",
				objectId: "phase-0e-room",
			},
		],
		...vertices.map((vertex) => [vertex.hash as string, graphVertex(vertex)] as const),
	]);
	const index = new CausalityIndexOwner(graph, [anchorHash, ...vertices.map((vertex) => vertex.hash as string)]);
	const isAncestor = ancestryOverride ?? index.isAncestor.bind(index);
	const prepared = prepareAdmissionContext({
		cryptoSuiteId: "ed25519-sha256-v1",
		currentAnchor: anchorHash,
		currentEpoch: 4,
		currentEpochAnchor: anchor,
		isAncestor,
		objectId: "phase-0e-room",
		parameters,
		protocolMajor: 2,
	});
	if (!prepared.ok) throw new Error(`invalid Phase 0e test context: ${prepared.code}`);
	const byHash = new Map<string, Readonly<Record<string, unknown>>>([
		[anchorHash, anchor],
		...vertices.map((vertex) => [vertex.hash as string, vertex] as const),
	]);
	const authorization = vi.fn(() => true);
	const operationSchema = vi.fn(() => true);
	const invariant = vi.fn(() => true);
	const hooks: AdmissionHooks = {
		authorize: authorization,
		isDependencyAccepted: () => true,
		resolveAuthorPublicKey: () => IDENTITY_PUBLIC_KEY,
		resolveDependencies: (hashes) => hashes.map((hash) => byHash.get(hash)),
		validateDeterministicInvariant: invariant,
		validateOperationSchema: operationSchema,
	};
	const candidate = signedVertex(anchorHash, {
		dependencies: vertices.map((vertex) => vertex.hash),
		logicalTime: 2,
		operation: { action: "candidate", dependencyCount },
	});
	return {
		anchor,
		anchorHash,
		candidate,
		context: prepared.context,
		hooks,
		index,
		semanticCalls: { authorization, invariant, operationSchema },
		vertices,
	};
}

describe("Phase 0e admission ancestry integration", () => {
	beforeAll(async () => {
		const sourceUrl = new URL("../../compaction/src/index.ts", import.meta.url).href;
		const module = (await import(/* @vite-ignore */ sourceUrl)) as unknown as {
			readonly CausalityIndex: CausalityIndexConstructor;
		};
		CausalityIndexOwner = module.CausalityIndex;
	});

	it.each([
		{ dependencies: 16, unorderedPairs: 120, directionalProbes: 240 },
		{ dependencies: 256, unorderedPairs: 32_640, directionalProbes: 65_280 },
	])(
		"separates $dependencies-dependency unordered-pair and directional-probe bounds",
		({ dependencies, directionalProbes, unorderedPairs }) => {
			const fixture = scenario(dependencies);
			const ancestry = vi.fn(fixture.index.isAncestor.bind(fixture.index));
			const prepared = prepareAdmissionContext({
				cryptoSuiteId: "ed25519-sha256-v1",
				currentAnchor: fixture.anchorHash,
				currentEpoch: 4,
				currentEpochAnchor: fixture.anchor,
				isAncestor: ancestry,
				objectId: "phase-0e-room",
				parameters: fixture.context.parameters,
				protocolMajor: 2,
			});
			if (!prepared.ok) throw new Error(`invalid Phase 0e bounds context: ${prepared.code}`);

			expect(admitVertex(fixture.candidate, prepared.context, fixture.hooks)).toEqual({
				code: "ADMISSIBLE",
				latchByHash: false,
				status: "accept",
			});
			expect({
				directionalProbes: ancestry.mock.calls.length,
				unorderedPairs: (dependencies * (dependencies - 1)) / 2,
			}).toEqual({ directionalProbes, unorderedPairs });
		}
	);

	it("uses the anchor-inclusive real index to reject mixed [anchor, vertex] dependencies", () => {
		const fixture = scenario(2);
		const parent = fixture.vertices[0] as Readonly<Record<string, unknown>>;
		const dependencies = [fixture.anchorHash, parent.hash as string].sort();
		const candidate = signedVertex(fixture.anchorHash, {
			dependencies,
			logicalTime: 2,
			operation: { action: "mixed-anchor-parent" },
		});
		const hooks: AdmissionHooks = {
			...fixture.hooks,
			resolveDependencies: (hashes) => hashes.map((hash) => (hash === fixture.anchorHash ? fixture.anchor : parent)),
		};

		expect(fixture.index.isAncestor(fixture.anchorHash, parent.hash as string)).toBe(true);
		expect(admitVertex(candidate, fixture.context, hooks)).toEqual({
			code: "NON_ANTICHAIN_DEPENDENCIES",
			latchByHash: true,
			status: "terminal",
		});
		expect(fixture.semanticCalls.authorization).not.toHaveBeenCalled();
		expect(fixture.semanticCalls.operationSchema).not.toHaveBeenCalled();
		expect(fixture.semanticCalls.invariant).not.toHaveBeenCalled();
	});

	it("fails closed without latching when ancestry returns any non-boolean answer", () => {
		const nonBooleanAnswers: ReadonlyArray<readonly [string, unknown]> = [
			["undefined", undefined],
			["null", null],
			["zero", 0],
			["one", 1],
			["empty-string", ""],
			["string-false", "false"],
			["object", {}],
			["array", []],
		];
		const outcomes = nonBooleanAnswers.map(([answerName, answer]) => {
			const ancestry = vi.fn(() => answer);
			const fixture = scenario(2, ancestry as unknown as AdmissionContext["isAncestor"]);
			const result = admitVertex(fixture.candidate, fixture.context, fixture.hooks);
			return {
				answerName,
				ancestryCalls: ancestry.mock.calls.length,
				code: result.code,
				latchByHash: result.latchByHash,
				semanticCalls:
					fixture.semanticCalls.authorization.mock.calls.length +
					fixture.semanticCalls.operationSchema.mock.calls.length +
					fixture.semanticCalls.invariant.mock.calls.length,
				status: result.status,
			};
		});

		expect(outcomes).toEqual(
			nonBooleanAnswers.map(([answerName]) => ({
				answerName,
				ancestryCalls: 1,
				code: "ADMISSION_CONTEXT_INVALID",
				latchByHash: false,
				semanticCalls: 0,
				status: "terminal",
			}))
		);
	});
});
