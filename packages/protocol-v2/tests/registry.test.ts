import { describe, expect, it } from "vitest";

import registry from "../registry/field-registry.json" with { type: "json" };
import {
	cutValuePreimage,
	makeRegistryPreimageBuilder,
	quorumSize,
	type RegistryDocument,
	type RegistryField,
} from "../src/index.js";
import coverageVectors from "./fixtures/registry-coverage-vectors.json" with { type: "json" };

function placeholder(field: RegistryField): unknown {
	if (field.const !== null && field.const !== undefined) return field.const;
	if (field.name === "lineagePolicy") {
		return {
			mode: "fixed-creator",
			maximumEpochs: null,
			allowedUpgrade: "none",
			recursiveVerificationKeyId: null,
		};
	}
	if (field.type === "enum") {
		const values = field.constraints.values;
		return Array.isArray(values) ? values[0] : "value";
	}
	if (field.type === "array<digest-hex>") return ["0".repeat(64)];
	if (field.name === "nextSignerSet") return [];
	if (field.type.includes("signer")) return [{ publicKey: "pk", signerId: "peer-a" }];
	if (field.type === "array<signed-seal-vote>") {
		return [
			{
				kind: "drp-seal-vote",
				objectId: "room-a",
				epoch: 0,
				round: 0,
				phase: "prepare",
				proposalDigest: "0".repeat(64),
				proposalHash: "0".repeat(64),
				signerId: "peer-a",
				signature: "sig-a",
			},
		];
	}
	if (field.type === "array<{index,digest,byteLength}>") {
		return [{ index: 0, digest: "0".repeat(64), byteLength: 1 }];
	}
	if (field.type === "array<canonical-value>") return [{ value: 1 }];
	if (field.type.includes("integer")) {
		const minimum = field.constraints.minimum;
		return typeof minimum === "number" ? minimum : 0;
	}
	if (field.type === "bytes") {
		const length = field.constraints.bytes;
		return new Uint8Array(typeof length === "number" ? length : 1);
	}
	if (field.type === "canonical-string") return "value";
	if (field.type === "canonical-object" || field.type === "canonical-value") return Object.create(null);
	if (field.type === "parameters") return Object.create(null);
	if (field.type.includes("digest")) return "0".repeat(64);
	if (field.type.includes("null")) return null;
	return "value";
}

describe("Phase -1a field registry", () => {
	it("constructs preimages from the registry field list, including a registry-only added field", () => {
		const syntheticField = {
			name: "futureRegistryOnlyField",
			type: "string",
			const: null,
			constraints: {},
			required: true,
			sortRule: null,
		};
		const mutatedRegistry = {
			...registry,
			kinds: {
				...registry.kinds,
				cutValue: {
					...registry.kinds.cutValue,
					fields: [...registry.kinds.cutValue.fields, syntheticField],
				},
			},
		} as RegistryDocument;
		const input = Object.fromEntries(
			mutatedRegistry.kinds.cutValue.fields.map((field) => [field.name, placeholder(field)])
		);

		const build = makeRegistryPreimageBuilder(mutatedRegistry, "cutValue");
		const preimage = build(input);

		expect(Object.keys(preimage)).toEqual(mutatedRegistry.kinds.cutValue.fields.map(({ name }) => name));
		expect(preimage.futureRegistryOnlyField).toBe("value");
	});

	it("rejects an unknown cutValue field with an observable registry error", () => {
		expect(() => cutValuePreimage({ unknownField: "must not be ignored" })).toThrowError(/unknown field/i);
	});

	it("references every registry field from at least one structural coverage vector", () => {
		const covered = new Set(
			coverageVectors.flatMap((vector) => vector.covers.map((field) => `${vector.kind}.${field}`))
		);
		const allFields = Object.entries(registry.kinds).flatMap(([kind, definition]) =>
			definition.fields.map((field) => `${kind}.${field.name}`)
		);
		const uncoveredFields = allFields.filter((field) => !covered.has(field));

		expect(uncoveredFields).toEqual([]);

		for (const vector of coverageVectors) {
			const definition = registry.kinds[vector.kind as keyof typeof registry.kinds];
			const build = makeRegistryPreimageBuilder(registry as RegistryDocument, vector.kind);
			const input = Object.fromEntries(definition.fields.map((field) => [field.name, placeholder(field)]));
			if (vector.kind === "profile") input.quorum = 1;
			expect(() => build(input), vector.id).not.toThrow();
		}
	});

	it("asserts all eleven frozen decisions", () => {
		expect(registry.framing).toEqual({
			magicHex: "44525000",
			domainEncoding: "utf8",
			domainLength: "U32BE",
			partLength: "U64BE",
			formula: '"DRP\\0" || U32BE(|domain|) || domain || (U64BE(|part|) || part)*',
		});
		expect(registry.endianness).toBe("big-endian");
		expect(registry.codec).toMatchObject({
			format: "reference-tag-codec",
			cbor: false,
			floatNegativeZero: { encode: "normalize-to-positive-zero", decode: "reject" },
		});

		const names = (kind: keyof typeof registry.kinds): string[] =>
			registry.kinds[kind].fields.map((field) => field.name);
		expect(names("cutValue")).toEqual(
			expect.arrayContaining(["archiveIndexRoot", "availabilityPolicyDigest", "blueprintDigest"])
		);
		expect(names("cutValue")).not.toContain("round");
		expect(names("sealProposal")).toEqual(["kind", "objectId", "epoch", "round", "valueDigest"]);
		expect(names("epochAnchor")).toEqual(expect.arrayContaining(["archiveIndexRoot", "blueprintDigest"]));
		expect(names("snapshotPayload")).toEqual(expect.arrayContaining(["blueprintDigest", "archiveIndexRoot"]));

		expect(names("sealVote")).not.toContain("highestPrepareQC");
		expect(registry.kinds.sealVote.fields.find(({ name }) => name === "phase")?.constraints.values).toEqual([
			"prepare",
			"commit",
		]);
		expect(names("roundChange")).toContain("highestPrepareQC");
		expect(registry.kinds.roundChange.fields.find(({ name }) => name === "phase")?.const).toBe("round-change");

		expect(registry.quorum).toEqual({
			q: "ceil(2*n/3)",
			f: "floor((n-1)/3)",
			callerSuppliedMaxByzantine: false,
		});
		expect(registry.kinds.signerSet.fields[0]).toMatchObject({
			sortRule: "codepoint",
			constraints: { signerIdCharset: "unicode-scalar-excluding-controls" },
		});
		expect(registry.actions).toEqual(["Nop", "DropLeft", "DropRight", "Swap", "Drop"]);

		expect(registry.trustProfiles).toEqual(["creator-trusted-v1", "delegated-trusted-v1", "attested-bft-v1"]);
		expect(names("epochAnchor")).toEqual(expect.arrayContaining(["profileDigest", "cryptoSuiteId"]));
		expect(registry.protocolMajor).toBe(2);
		expect(registry.packageName).toBe("protocol-v2");
		expect(Object.values(registry.domains).every((domain) => /^ts-drp\/.+\/v2$/.test(domain))).toBe(true);
		expect(registry.wireFormat).toEqual({
			canonicalPreimage: "bytes",
			signature: "bytes",
			digestVerification: "received-bytes",
			reencodeBeforeDigest: false,
		});

		const consensusQuorumHasOneParameter: Parameters<typeof quorumSize> extends [number] ? true : false = true;
		expect(consensusQuorumHasOneParameter).toBe(true);
		expect(quorumSize(4)).toBe(3);
	});
});
