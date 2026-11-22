import { ESLint } from "eslint";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import { describe, expect, it } from "vitest";

import registry from "../registry/field-registry.json" with { type: "json" };
import {
	encodeCanonical,
	hashDomain,
	makeRegistryPreimageBuilder,
	type RegistryDocument,
	type RegistryField,
	registryPreimageParts,
	signerSetBytes,
} from "../src/index.js";
import coverageVectors from "./fixtures/registry-coverage-vectors.json" with { type: "json" };

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validFieldValue(kind: string, field: RegistryField): unknown {
	if (field.const !== null && field.const !== undefined) return field.const;
	if (kind === "parameters" && field.name === "lineagePolicy") {
		return {
			mode: "fixed-creator",
			maximumEpochs: null,
			allowedUpgrade: "none",
			recursiveVerificationKeyId: null,
		};
	}
	if (field.type.includes("array")) {
		if (field.sortRule === "index-ascending") {
			return [
				{ index: 1, digest: "1".repeat(64), byteLength: 1 },
				{ index: 0, digest: "0".repeat(64), byteLength: 1 },
			];
		}
		if (field.name === "dependencies") return ["1".repeat(64), "0".repeat(64)];
		if (field.name === "votes") {
			return ["peer-b", "peer-a"].map((signerId) => ({
				kind: "drp-seal-vote",
				objectId: "value",
				epoch: 0,
				round: 0,
				phase: "prepare",
				proposalDigest: "0".repeat(64),
				proposalHash: "0".repeat(64),
				signerId,
				signature: `sig-${signerId}`,
			}));
		}
		if (field.name === "nextSignerSet") return [];
		if (field.name.toLowerCase().includes("signer")) {
			return [
				{ publicKey: "pk-b", signerId: "peer-b" },
				{ publicKey: "pk-a", signerId: "peer-a" },
			];
		}
		return [{ record: 1 }];
	}
	if (field.type.includes("digest-hex")) return "0".repeat(64);
	if (field.type.includes("safe-integer")) {
		const minimum = field.constraints.minimum;
		return typeof minimum === "number" ? minimum : 0;
	}
	if (field.type === "enum") {
		const values = field.constraints.values;
		if (!Array.isArray(values) || values.length === 0) throw new Error(`missing enum values for ${kind}.${field.name}`);
		return values[0];
	}
	if (field.type.includes("null")) return null;
	if (field.type === "bytes") return Uint8Array.of(1);
	if (field.type.includes("string")) return "value";
	if (field.type.includes("canonical") || field.type === "parameters") return { value: 1 };
	return { value: 1 };
}

function validRegistryInput(kind: string, document: RegistryDocument): Readonly<Record<string, unknown>> {
	const definition = document.kinds[kind];
	if (definition === undefined) throw new Error(`missing coverage kind ${kind}`);
	const input = Object.fromEntries(definition.fields.map((field) => [field.name, validFieldValue(kind, field)]));
	if (kind === "profile") {
		input.profileId = "creator-trusted-v1";
		input.signers = [];
		input.quorum = 1;
	}
	return input;
}

describe("B4 executable hardening gates", () => {
	it("runs ESLint against real structuredClone and Buffer violations", async () => {
		const workspace = fileURLToPath(new URL("../../..", import.meta.url));
		const eslint = new ESLint({ cwd: workspace });
		const fixturePath = fileURLToPath(new URL("../src/admission.ts", import.meta.url));
		const [structuredCloneResult] = await eslint.lintText("export const clone = structuredClone({ value: 1 });", {
			filePath: fixturePath,
		});
		const [bufferResult] = await eslint.lintText("export const bytes = Buffer.from([1]);", {
			filePath: fixturePath,
		});

		expect(structuredCloneResult?.messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-globals", severity: 2 })])
		);
		expect(bufferResult?.messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-globals", severity: 2 })])
		);
	}, 15_000);

	it("has an every-PR workflow caller for the base-governed protocol freeze", () => {
		const workflowUrl = new URL("../../../.github/workflows/protocol-v2-registry.yml", import.meta.url);
		expect(existsSync(workflowUrl)).toBe(true);
		const workflow = readFileSync(workflowUrl, "utf8");
		expect(workflow).toContain("pull_request");
		expect(workflow).toContain("git show");
		expect(workflow).toContain("PROTOCOL_FREEZE_REPOSITORY_ROOT");
		expect(workflow).toContain("node packages/protocol-v2/scripts/check-protocol-freeze.mjs");
		expect(workflow).not.toContain("pnpm install");
	});

	it("pins framing, codec tags, and endianness through emitted bytes and the oracle", async () => {
		const referencePath: string = "../conformance/ahe-reference/src/hash.js";
		const reference = (await import(referencePath)) as {
			hashDomain(domain: string, ...parts: Uint8Array[]): Promise<Uint8Array>;
		};
		const part = Uint8Array.of(0, 1, 2, 3);
		expect(hashDomain("ts-drp/test/v2", part)).toEqual(await reference.hashDomain("ts-drp/test/v2", part));

		expect(hex(encodeCanonical(null))).toBe("00");
		expect(hex(encodeCanonical("A"))).toBe("050141");
		expect(hex(encodeCanonical(Float32Array.of(1.5)))).toBe("0b013fc00000");
		expect(hex(encodeCanonical(Int32Array.of(0x01020304)))).toBe("0d0101020304");
	});

	it("encodes and domain-hashes every coverage vector's real fields", async () => {
		const document = registry as RegistryDocument & { domains: Readonly<Record<string, string>> };
		const runtime = (await import("../src/registry.js")) as {
			digestRegistryPreimage?(
				document: RegistryDocument,
				kind: string,
				input: Readonly<Record<string, unknown>>
			): Uint8Array;
		};
		expect(runtime.digestRegistryPreimage).toBeTypeOf("function");

		for (const vector of coverageVectors) {
			const input = validRegistryInput(vector.kind, document);
			const preimage = makeRegistryPreimageBuilder(document, vector.kind)(input);
			const parts = registryPreimageParts(document, vector.kind, input);
			const digest = runtime.digestRegistryPreimage?.(document, vector.kind, input);

			expect(parts.length, vector.id).toBeGreaterThan(0);
			expect(
				parts.every((part) => part.byteLength > 0),
				vector.id
			).toBe(true);
			expect(digest, vector.id).toEqual(hashDomain(document.domains[vector.kind] as string, ...parts));
			for (const field of vector.covers) expect(Object.hasOwn(preimage, field), `${vector.id}.${field}`).toBe(true);
		}
	});
});

describe("B5 smaller review findings", () => {
	it("pins Float64Array negative-zero normalization", () => {
		expect(encodeCanonical(Float64Array.of(-0))).toEqual(encodeCanonical(Float64Array.of(+0)));
	});

	it("excludes Stryker sandboxes from root Vitest collection", async () => {
		const configPath = fileURLToPath(new URL("../../../vite.config.mts", import.meta.url));
		const loaded = await loadConfigFromFile({ command: "serve", mode: "test" }, configPath);
		expect(loaded?.config.test?.exclude).toContain("**/.stryker-tmp/**");
	});

	it("rejects lone surrogates at the signerId registry boundary", () => {
		expect(() => signerSetBytes([{ publicKey: "pk", signerId: "peer-\ud800" }])).toThrowError(
			/signerId.*Unicode scalar/i
		);
	});

	it("states UTF-8 ordering as codepoint order, not UTF-16 code-unit order", () => {
		const plan = readFileSync(
			new URL("../../../docs/production-hardening/production-hardening-tdd-plan-v2.md", import.meta.url),
			"utf8"
		);
		expect(plan).not.toContain("UTF-8 (equivalently code-unit order)");
		expect(plan).toContain("UTF-8 byte order equals codepoint order");
	});

	it("resolves the package-local pinned noble hash implementation", () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../node_modules/@noble/hashes/package.json", import.meta.url), "utf8")
		) as { version: string };
		expect(packageJson.version).toBe("1.7.1");
		expect(registry.protocolMajor).toBe(2);
	});
});
