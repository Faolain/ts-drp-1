import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	createV3RoomCreatorInviteMaterial,
	type V3RoomCreatorInviteMaterial,
	type V3RoomCreatorInviteMaterialInput,
} from "../examples/v3-room/src/index.js";
import registryJson from "../packages/protocol-v2/registry/field-registry.json" with { type: "json" };
import {
	digestRegistryPreimage,
	makeRegistryPreimageBuilder,
	type RegistryDocument,
} from "../packages/protocol-v2/src/index.js";

type LineageMode = "durable-pinned" | "durable-recursive" | "ephemeral-chain" | "fixed-creator";

interface LineagePolicy {
	readonly allowedUpgrade: "none" | "recursive-v1";
	readonly maximumEpochs: number | null;
	readonly mode: LineageMode;
	readonly recursiveVerificationKeyId: string | null;
}

const PARAMETERS = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
const CURRENT_PARAMETERS_HEX =
	"0807050d6d617845706f636842797465730380808008050f6d6178446570656e64656e636965730320050f6d617850656e64696e674279746573038080801005106d617845706f636856657274696365730380800105106d6178536e617073686f74427974657303808080800205116d617850656e64696e67456e74726965730380400512736e617073686f744368756e6b427974657303808010";
const CURRENT_PARAMETERS_DIGEST = "cd31923f2f1928daab3a6943fa361f7cf40516ba3c4929abbd3109ee65cdc669";
const UNSUPPORTED_LINEAGE_POLICY = "D110C_LINEAGE_POLICY_UNSUPPORTED";
const registry = registryJson as RegistryDocument;

function bytesHex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function parametersDigest(value: Uint8Array): string {
	return bytesHex(hashDomain("ts-drp/parameters/v3", value));
}

function fixedCreatorPolicy(overrides: Partial<LineagePolicy> = {}): LineagePolicy {
	return Object.freeze({
		allowedUpgrade: "none",
		maximumEpochs: null,
		mode: "fixed-creator",
		recursiveVerificationKeyId: null,
		...overrides,
	});
}

function registeredParameters(lineagePolicy?: unknown): Readonly<Record<string, unknown>> {
	const input: Record<string, unknown> = { ...PARAMETERS };
	if (lineagePolicy !== undefined) input.lineagePolicy = lineagePolicy;
	return makeRegistryPreimageBuilder(registry, "parameters")(input);
}

function materialInput(exactCanonicalParametersCarrierBytes: Uint8Array): V3RoomCreatorInviteMaterialInput {
	return {
		blueprintDigest: "11".repeat(32),
		exactCanonicalApplicationStateBytes: encodeCanonical([]),
		exactCanonicalLatchedAclBytes: encodeCanonical({ acl: "latched" }),
		exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes: encodeCanonical({ profileId: "creator-trusted-v1" }),
		exactCanonicalSignerSetBytes: encodeCanonical([{ publicKey: "22".repeat(32), signerId: "creator" }]),
		objectId: `creator:${"33".repeat(16)}`,
		signGenesisAnchorDigest: () => Promise.resolve(new Uint8Array(64).fill(0x5a)),
	};
}

function decodedAnchor(material: V3RoomCreatorInviteMaterial): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(material.exactCanonicalGenesisAnchorPreimageBytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("D110C_LINEAGE_TEST_ANCHOR_INVALID");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

describe("D.110c-0c1j-0 genesis lineage-policy reservation RED", () => {
	it("keeps an omitted lineagePolicy byte-identical to the pinned parameters bytes and digest", async () => {
		const fields = registry.kinds.parameters?.fields.map(({ name }) => name);
		const normalized = registeredParameters();
		const exactBytes = encodeCanonical(normalized);

		expect(bytesHex(exactBytes)).toBe(CURRENT_PARAMETERS_HEX);
		expect(parametersDigest(exactBytes)).toBe(CURRENT_PARAMETERS_DIGEST);
		expect(bytesHex(digestRegistryPreimage(registry, "parameters", PARAMETERS))).toBe(
			"26af70b10f18538db3c6e9210eb2414d7619b267f71bbd1217c3d24e9fc2fc19"
		);
		const pinnedGenesis = await createV3RoomCreatorInviteMaterial(materialInput(exactBytes));
		expect(pinnedGenesis.pinnedGenesisAnchorDigest).toBe(
			"da25ccd1d49cc5b6d2c25b8dfc8a0caf1e49951692c4524c1115a3a9aafaca27"
		);
		expect(decodedAnchor(pinnedGenesis).parametersDigest).toBe(CURRENT_PARAMETERS_DIGEST);
		expect(fields).toEqual([
			"maxEpochVertices",
			"maxEpochBytes",
			"maxDependencies",
			"snapshotChunkBytes",
			"maxSnapshotBytes",
			"maxPendingEntries",
			"maxPendingBytes",
			"lineagePolicy",
		]);
		expect(registry.kinds.parameters?.fields.at(-1)).toMatchObject({
			name: "lineagePolicy",
			required: false,
		});
	});

	it("binds an explicit fixed-creator policy into genesis and carries its parameters digest through close", async () => {
		const explicit = registeredParameters(fixedCreatorPolicy());
		const exactBytes = encodeCanonical(explicit);
		const digest = parametersDigest(exactBytes);

		expect(bytesHex(exactBytes)).not.toBe(CURRENT_PARAMETERS_HEX);
		expect(digest).not.toBe(CURRENT_PARAMETERS_DIGEST);
		const material = await createV3RoomCreatorInviteMaterial(materialInput(exactBytes));
		expect(material.exactCanonicalParametersCarrierBytes).toEqual(exactBytes);
		expect(decodedAnchor(material).parametersDigest).toBe(digest);

		const closeSource = readFileSync(resolve("packages/protocol-v3/src/creator-close.ts"), "utf8");
		expect(closeSource).toMatch(/parametersDigest:\s*currentAnchor\.parametersDigest/u);
		expect(closeSource).toMatch(
			/prepareCreatorClose[\s\S]*hashDomain\("ts-drp\/parameters\/v3",\s*parametersBytes\)[\s\S]*currentAnchor\.parametersDigest/u
		);
	});

	it("keeps future lineage modes codec-valid but rejects them at room genesis with one stable error", async () => {
		const policies: readonly LineagePolicy[] = [
			fixedCreatorPolicy({ mode: "ephemeral-chain", maximumEpochs: 100 }),
			fixedCreatorPolicy({ mode: "durable-pinned", allowedUpgrade: "recursive-v1" }),
			fixedCreatorPolicy({
				mode: "durable-recursive",
				allowedUpgrade: "recursive-v1",
				recursiveVerificationKeyId: "wraps-v1",
			}),
		];

		for (const policy of policies) {
			const normalized = registeredParameters(policy);
			expect(normalized.lineagePolicy).toEqual(policy);
			await expect(
				createV3RoomCreatorInviteMaterial(materialInput(encodeCanonical(normalized))),
				policy.mode
			).rejects.toThrowError(UNSUPPORTED_LINEAGE_POLICY);
		}
	});

	it("fails closed on malformed lineage-policy modes, epoch bounds, upgrades, and verification-key bytes", () => {
		const malformed: readonly [string, unknown, RegExp][] = [
			["unknown mode", fixedCreatorPolicy({ mode: "unregistered" as LineageMode }), /lineagePolicy\.mode.*invalid/u],
			[
				"negative maximum",
				fixedCreatorPolicy({ mode: "ephemeral-chain", maximumEpochs: -1 }),
				/lineagePolicy\.maximumEpochs.*non-negative safe integer/u,
			],
			[
				"fractional maximum",
				fixedCreatorPolicy({ mode: "ephemeral-chain", maximumEpochs: 1.5 }),
				/lineagePolicy\.maximumEpochs.*non-negative safe integer/u,
			],
			["maximum on fixed", fixedCreatorPolicy({ maximumEpochs: 10 }), /lineagePolicy\.maximumEpochs.*ephemeral-chain/u],
			[
				"unknown upgrade",
				fixedCreatorPolicy({ allowedUpgrade: "anything" as "none" }),
				/lineagePolicy\.allowedUpgrade.*invalid/u,
			],
			[
				"verification key bytes",
				{ ...fixedCreatorPolicy(), recursiveVerificationKeyId: new Uint8Array([1, 2, 3]) },
				/lineagePolicy\.recursiveVerificationKeyId.*string or null/u,
			],
		];

		for (const [name, policy, expected] of malformed) {
			expect(() => registeredParameters(policy), name).toThrowError(expected);
		}
	});

	it("documents old-binary behavior: a legacy parameters decoder rejects the present key as unknown", () => {
		const legacy = structuredClone(registryJson) as RegistryDocument;
		const parameters = legacy.kinds.parameters;
		if (parameters === undefined) throw new TypeError("D110C_LINEAGE_TEST_PARAMETERS_KIND_MISSING");
		const legacyRegistry: RegistryDocument = {
			...legacy,
			kinds: {
				...legacy.kinds,
				parameters: {
					...parameters,
					fields: parameters.fields.filter(({ name }) => name !== "lineagePolicy"),
				},
			},
		};

		expect(() =>
			makeRegistryPreimageBuilder(
				legacyRegistry,
				"parameters"
			)({
				...PARAMETERS,
				lineagePolicy: fixedCreatorPolicy(),
			})
		).toThrowError(/unknown field lineagePolicy for registry kind parameters/u);
	});
});
