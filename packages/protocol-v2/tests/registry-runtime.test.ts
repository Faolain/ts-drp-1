import { describe, expect, it } from "vitest";

import registryJson from "../registry/field-registry.json" with { type: "json" };
import {
	makeRegistryPreimageBuilder,
	quorumCertificateBytes,
	type RegistryDocument,
	type RegistryField,
	signerSetBytes,
} from "../src/index.js";
import { protocolRegistry } from "../src/registry.js";

const ZERO_DIGEST = "0".repeat(64);
const ONE_DIGEST = "1".repeat(64);

type RegistryRuntime = {
	digestRegistryPreimage?(
		document: RegistryDocument,
		kind: string,
		input: Readonly<Record<string, unknown>>
	): Uint8Array;
};

function clonedRegistry(): RegistryDocument {
	return structuredClone(registryJson) as RegistryDocument;
}

function probeField(sortRule: string): RegistryField {
	return {
		name: "values",
		type: "array<canonical-value>",
		const: null,
		constraints: {},
		required: true,
		sortRule,
	};
}

function registryWithProbe(field: RegistryField): RegistryDocument {
	const document = clonedRegistry();
	return {
		...document,
		kinds: {
			...document.kinds,
			probe: {
				domain: "ts-drp/probe/v2",
				encoding: "canonical-object",
				fields: [field],
			},
		},
	};
}

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
		parameters: {},
		closeReason: "size",
		...overrides,
	};
}

describe("B2 normative registry runtime", () => {
	it("throws on an unknown or misspelled sortRule", () => {
		const build = makeRegistryPreimageBuilder(registryWithProbe(probeField("codepont")), "probe");
		expect(() => build({ values: ["b", "a"] })).toThrowError(/unknown sortRule.*codepont/i);
	});

	it("implements index-ascending and linearized-order explicitly", () => {
		const indexed = makeRegistryPreimageBuilder(
			registryWithProbe({
				...probeField("index-ascending"),
				type: "array<{index,digest,byteLength}>",
				constraints: { contiguous: true },
			}),
			"probe"
		);
		const indexedOutput = indexed({
			values: [
				{ index: 1, digest: ONE_DIGEST, byteLength: 1 },
				{ index: 0, digest: ZERO_DIGEST, byteLength: 1 },
			],
		});
		expect((indexedOutput.values as readonly { index: number }[]).map(({ index }) => index)).toEqual([0, 1]);

		const records = [{ ordinal: 1 }, { ordinal: 0 }];
		const linearized = makeRegistryPreimageBuilder(
			registryWithProbe(probeField("linearized-order")),
			"probe"
		)({ values: records });
		expect(linearized.values).toEqual(records);
		expect(linearized.values).not.toBe(records);
	});

	it("routes signer-set protocol sorting through the registry rule", () => {
		const document = protocolRegistry();
		const signerField = document.kinds.signerSet?.fields[0] as RegistryField;
		expect(Object.isFrozen(signerField)).toBe(true);
		expect(() => {
			(signerField as { sortRule: string | null }).sortRule = null;
		}).toThrow(TypeError);
		expect(
			signerSetBytes([
				{ publicKey: "pk-b", signerId: "peer-b" },
				{ publicKey: "pk-a", signerId: "peer-a" },
			])
		).toEqual(
			signerSetBytes([
				{ publicKey: "pk-a", signerId: "peer-a" },
				{ publicKey: "pk-b", signerId: "peer-b" },
			])
		);
	});

	it("enforces enums, digest shape, minima, charset, and UTF-16 limits in registry builders", () => {
		expect(() =>
			quorumCertificateBytes({
				epoch: 4,
				objectId: "room-a",
				phase: "nope" as "prepare",
				proposalDigest: ZERO_DIGEST,
				proposalHash: ONE_DIGEST,
				round: 2,
				votes: [
					{
						objectId: "room-a",
						epoch: 4,
						round: 2,
						phase: "prepare",
						proposalDigest: ZERO_DIGEST,
						proposalHash: ONE_DIGEST,
						signerId: "peer-a",
						signature: "sig-a",
					},
				],
			})
		).toThrowError(/sealQC\.phase.*prepare.*commit/i);

		const buildCut = makeRegistryPreimageBuilder(clonedRegistry(), "cutValue");
		expect(() => buildCut(cutValue({ epoch: -99 }))).toThrowError(/cutValue\.epoch.*minimum/i);
		expect(() => buildCut(cutValue({ previousAnchor: "bad" }))).toThrowError(/cutValue\.previousAnchor.*32-byte/i);

		const buildSignerSet = makeRegistryPreimageBuilder(clonedRegistry(), "signerSet");
		expect(() => buildSignerSet({ signers: [{ publicKey: "pk", signerId: "peer-\ud800" }] })).toThrowError(
			/signerSet\.signers.*Unicode scalar/i
		);
	});

	it("throws when a declared constraint name is misspelled instead of silently ignoring it", () => {
		const document = registryWithProbe({
			...probeField("linearized-order"),
			type: "safe-integer",
			sortRule: null,
			constraints: { minimim: 1 },
		});
		const build = makeRegistryPreimageBuilder(document, "probe");
		expect(() => build({ values: 0 })).toThrowError(/unknown constraint.*minimim/i);
	});

	it("consumes domains{} by kind and fails a domain typo", async () => {
		const runtime = (await import("../src/registry.js")) as RegistryRuntime;
		expect(runtime.digestRegistryPreimage).toBeTypeOf("function");
		const document = clonedRegistry() as RegistryDocument & { domains: Record<string, string> };
		document.domains.vertex = "ts-drp/vertxe/v2";
		expect(() =>
			runtime.digestRegistryPreimage?.(document, "vertex", {
				objectId: "room-a",
				epoch: 1,
				anchor: ZERO_DIGEST,
				author: "peer-a",
				logicalTime: 1,
				dependencies: [ONE_DIGEST],
				operation: { op: "set" },
			})
		).toThrowError(/domain.*vertex.*mismatch/i);
	});
});
