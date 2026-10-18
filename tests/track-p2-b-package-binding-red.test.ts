/* eslint-disable import/order -- the protocol-v3 mock must be declared before importing the toolchain under test */

import { decodeCanonical, encodeCanonical, hashDomain } from "../packages/canonical/src/index.js";

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import expected from "./fixtures/track-p2-b/forward-counter-package.json" with { type: "json" };
import toolchainManifest from "../packages/blueprint-toolchain/package.json" with { type: "json" };

type Mutation = "none" | "artifact" | "digest" | "runtime-profile" | "manifest" | "operation-schema" | "artifact-id";
type ByteInput = {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
};
type RuntimeInput = ByteInput & {
	readonly exactArtifactBytes: Uint8Array;
	readonly preparedBlueprintAdmission: unknown;
};
type PackageValue = typeof expected.package;

const probe = vi.hoisted(() => ({
	admissionCapabilities: [] as unknown[],
	events: [] as string[],
	mutation: "none" as Mutation,
	runtimeCapabilities: [] as unknown[],
}));

vi.mock("@ts-drp/protocol-v3", async (importOriginal) => {
	const genuine = (await importOriginal()) as {
		prepareBlueprintAdmission(input: ByteInput): unknown;
		prepareBlueprintRuntime(input: RuntimeInput): Promise<unknown>;
	};
	const canonical = await import("../packages/canonical/src/index.js");
	const mutatePackage = (input: ByteInput): ByteInput => {
		if (!["runtime-profile", "manifest", "operation-schema", "artifact-id"].includes(probe.mutation)) return input;
		const value = canonical.decodeCanonical(input.canonicalBlueprintPackageBytes) as PackageValue;
		if (probe.mutation === "runtime-profile") value.implementation.runtimeProfile = "future-runtime-profile";
		if (probe.mutation === "artifact-id") value.implementation.artifactId = "cross-paired-counter.v1";
		if (probe.mutation === "manifest") value.manifest.operationDiscriminator = "kind";
		if (probe.mutation === "operation-schema") value.manifest.operations[0].argumentSchema.fields[0].type = "string";
		const bytes = canonical.encodeCanonical(value);
		return {
			canonicalBlueprintPackageBytes: bytes,
			expectedBlueprintDigest: Buffer.from(canonical.hashDomain("ts-drp/blueprint-admission/v3", bytes)).toString(
				"hex"
			),
		};
	};
	return {
		...genuine,
		prepareBlueprintAdmission(input: ByteInput): unknown {
			probe.events.push("admission:start");
			const candidate =
				probe.mutation === "digest" ? { ...input, expectedBlueprintDigest: "00".repeat(32) } : mutatePackage(input);
			const capability = genuine.prepareBlueprintAdmission(candidate);
			probe.admissionCapabilities.push(capability);
			probe.events.push("admission:success");
			return capability;
		},
		async prepareBlueprintRuntime(input: RuntimeInput): Promise<unknown> {
			probe.events.push("runtime:start");
			const candidate =
				probe.mutation === "artifact"
					? { ...input, exactArtifactBytes: new Uint8Array([...input.exactArtifactBytes, 0x0a]) }
					: input;
			const capability = await genuine.prepareBlueprintRuntime(candidate);
			probe.runtimeCapabilities.push(capability);
			probe.events.push("runtime:success");
			return capability;
		},
	};
});

import { buildBlueprint } from "../packages/blueprint-toolchain/src/index.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const AUTHORING_FIXTURE = path.join(import.meta.dirname, "fixtures/track-p2-a/forward-counter");
const TYPE_FIXTURE = "tests/fixtures/track-p2-b/tsconfig.public-surface.json";
const temporaryDirectories: string[] = [];

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function domainHex(domain: string, bytes: Uint8Array): string {
	return Buffer.from(hashDomain(domain, bytes)).toString("hex");
}

function authoringCopy(label: string): { readonly authoring: string; readonly output: string; readonly root: string } {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `track-p2-b-${label}-`));
	temporaryDirectories.push(root);
	const authoring = path.join(root, "authoring");
	fs.cpSync(AUTHORING_FIXTURE, authoring, { recursive: true });
	fs.rmSync(path.join(authoring, "artifact.mjs"));
	return { authoring, output: path.join(root, "bundle"), root };
}

function outputBytes(output: string): Readonly<Record<string, Buffer>> {
	return Object.fromEntries(
		fs
			.readdirSync(output)
			.sort()
			.map((filename) => [filename, fs.readFileSync(path.join(output, filename))])
	);
}

function packageValue(bytes: Uint8Array): PackageValue {
	return decodeCanonical(bytes) as PackageValue;
}

beforeEach(() => {
	probe.admissionCapabilities.length = 0;
	probe.events.length = 0;
	probe.mutation = "none";
	probe.runtimeCapabilities.length = 0;
});

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe.sequential("Track P2-b exact package and genuine binding causal RED", () => {
	it("writes the exact frozen package projection, distinct domain identities, and awaits both genuine preparers", async () => {
		const { authoring, output } = authoringCopy("exact-package");
		const result = await buildBlueprint(authoring, output);
		expect(result).toBeUndefined();
		expect(fs.readdirSync(output).sort()).toEqual(["artifact.mjs", "lint.bin", "package.bin", "receipt.bin"]);

		const artifactBytes = fs.readFileSync(path.join(output, "artifact.mjs"));
		const packageBytes = fs.readFileSync(path.join(output, "package.bin"));
		const expectedPackageBytes = Buffer.from(encodeCanonical(expected.package));
		expect(packageBytes).toEqual(expectedPackageBytes);
		expect(packageBytes.byteLength).toBe(expected.packageByteLength);
		expect(sha256(packageBytes)).toBe(expected.packageSha256);
		expect(packageValue(packageBytes)).toEqual(expected.package);
		expect(Reflect.ownKeys(packageValue(packageBytes)).sort()).toEqual(
			["implementation", "kind", "manifest", "protocolMajor", "schemaVersion"].sort()
		);
		expect(JSON.stringify(packageValue(packageBytes))).not.toContain("reducerBinding");

		const artifactDigest = domainHex(expected.artifactDigestDomain, artifactBytes);
		const blueprintDigest = domainHex(expected.blueprintDigestDomain, packageBytes);
		expect(artifactDigest).toBe(expected.artifactDigest);
		expect(blueprintDigest).toBe(expected.blueprintDigest);
		expect(artifactDigest).not.toBe(blueprintDigest);
		expect(packageValue(packageBytes).implementation.artifactDigest).toBe(artifactDigest);

		expect(probe.events).toEqual(["admission:start", "admission:success", "runtime:start", "runtime:success"]);
		expect(probe.admissionCapabilities).toHaveLength(1);
		expect(probe.runtimeCapabilities).toHaveLength(1);
		for (const bytes of Object.values(outputBytes(output)))
			expect(bytes.includes(Buffer.from("PreparedBlueprint"))).toBe(false);
		expect(decodeCanonical(fs.readFileSync(path.join(output, "receipt.bin")))).toEqual({
			kind: "track-p2-c-receipt-placeholder",
			schemaVersion: 1,
		});
	});

	it("is byte-deterministic for identical inputs while retaining the P2-c receipt placeholder", async () => {
		const first = authoringCopy("repeat-first");
		const second = authoringCopy("repeat-second");
		await buildBlueprint(first.authoring, first.output);
		await buildBlueprint(second.authoring, second.output);
		const firstFiles = outputBytes(first.output);
		const secondFiles = outputBytes(second.output);
		expect(Object.keys(secondFiles)).toEqual(Object.keys(firstFiles));
		for (const filename of Object.keys(firstFiles)) expect(secondFiles[filename]).toEqual(firstFiles[filename]);
		expect(decodeCanonical(firstFiles["receipt.bin"])).toEqual({
			kind: "track-p2-c-receipt-placeholder",
			schemaVersion: 1,
		});
	});

	it.each([
		["artifact/package cross-pair", "artifact"],
		["blueprint digest mismatch", "digest"],
		["runtime profile cross-pair", "runtime-profile"],
		["manifest discriminator cross-pair", "manifest"],
		["operation-schema cross-pair", "operation-schema"],
		["artifactId cross-pair", "artifact-id"],
	] as const)("rejects the %s before any product becomes admissible", async (_label, mutation) => {
		const { authoring, output, root } = authoringCopy(`mutant-${mutation}`);
		probe.mutation = mutation;
		await expect(buildBlueprint(authoring, output)).rejects.toThrow();
		expect(fs.existsSync(output)).toBe(false);
		expect(fs.readdirSync(root)).toEqual(["authoring"]);
	});
});

describe("Track P2-b type, package and slice boundary controls", () => {
	it("keeps build authority private and the exact package dependency boundary unchanged", () => {
		const typeConfig = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, TYPE_FIXTURE), "utf8")) as {
			readonly files?: readonly string[];
		};
		expect(typeConfig.files).toEqual(["public-surface.ts"]);
		expect(Object.keys(toolchainManifest.exports)).toEqual(["."]);
		expect(toolchainManifest.dependencies).toEqual({
			"@ts-drp/blueprint-catalog": "0.11.0",
			"@ts-drp/canonical": "0.11.0",
			"@ts-drp/protocol-v3": "0.11.0",
			"@typescript-eslint/parser": "8.29.0",
			"es-module-lexer": "1.6.0",
			"esbuild": "0.25.3",
			"eslint": "9.23.0",
			"eslint-plugin-ts-drp": "0.11.0",
			"yaml": "2.8.0",
		});
	});
});
