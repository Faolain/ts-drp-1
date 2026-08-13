import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import correctedIdentities from "./fixtures/track-p2-ab-operation-abi/identities.json" with { type: "json" };
import frozenPackage from "./fixtures/track-p2-b/forward-counter-package.json" with { type: "json" };
import { buildBlueprint } from "../packages/blueprint-toolchain/src/index.js";
import { decodeCanonical, hashDomain } from "../packages/canonical/src/index.js";

type AuthoredCase = {
	readonly action: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly id: string;
};
type Authoring = {
	readonly conformance: {
		readonly initialState: unknown;
		readonly nightlyAdditionalCases: readonly AuthoredCase[];
		readonly prCases: readonly AuthoredCase[];
	};
};
type ReducerResult = { readonly output: unknown; readonly state: unknown };
type Reducer = (input: { readonly operation: AuthoredCase; readonly state: unknown }) => ReducerResult;
type BlueprintNamespace = {
	readonly blueprint: { readonly reducers: Readonly<Record<string, Reducer>> };
};

const FROZEN_ROOT = path.join(import.meta.dirname, "fixtures/track-p2-a/forward-counter");
const CORRECTIVE_ROOT = path.join(import.meta.dirname, "fixtures/track-p2-ab-operation-abi");
const frozenAuthoring = JSON.parse(fs.readFileSync(path.join(FROZEN_ROOT, "blueprint.json"), "utf8")) as Authoring;
const correctiveSource = fs.readFileSync(path.join(CORRECTIVE_ROOT, "blueprint.ts"));
const correctiveArtifact = fs.readFileSync(path.join(CORRECTIVE_ROOT, "artifact.mjs"));
const temporaryDirectories: string[] = [];

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function domainHex(domain: string, bytes: Uint8Array): string {
	return Buffer.from(hashDomain(domain, bytes)).toString("hex");
}

function correctiveAuthoringCopy(label: string): { readonly authoring: string; readonly output: string } {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `track-p2-ab-operation-abi-${label}-`));
	temporaryDirectories.push(root);
	const authoring = path.join(root, "authoring");
	fs.mkdirSync(authoring);
	fs.copyFileSync(path.join(FROZEN_ROOT, "blueprint.json"), path.join(authoring, "blueprint.json"));
	fs.copyFileSync(path.join(CORRECTIVE_ROOT, "blueprint.ts"), path.join(authoring, "blueprint.ts"));
	return { authoring, output: path.join(root, "bundle") };
}

async function loadBlueprint(filename: string, label: string): Promise<BlueprintNamespace["blueprint"]> {
	const namespace = (await import(`${pathToFileURL(filename).href}?track-p2-ab=${label}`)) as BlueprintNamespace;
	return namespace.blueprint;
}

function executeCases(
	reducers: Readonly<Record<string, Reducer>>,
	initialState: unknown,
	cases: readonly AuthoredCase[]
): { readonly outputs: readonly unknown[]; readonly state: unknown } {
	let state = initialState;
	const outputs = [];
	for (const operation of cases) {
		const reducer = reducers[operation.action];
		if (reducer === undefined) throw new TypeError(`missing reducer ${operation.action}`);
		const result = reducer({ operation, state });
		state = result.state;
		outputs.push(result.output);
	}
	return { outputs, state };
}

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("Track P2-a/P2-b accepted reducer-input ABI corrective RED", () => {
	it("requires the committed source, artifact and package identities to regenerate as one exact chain", () => {
		const frozenSource = fs.readFileSync(path.join(FROZEN_ROOT, "blueprint.ts"));
		const frozenArtifact = fs.readFileSync(path.join(FROZEN_ROOT, "artifact.mjs"));

		expect.soft(frozenSource).toEqual(correctiveSource);
		expect.soft(frozenArtifact).toEqual(correctiveArtifact);
		expect.soft(sha256(frozenArtifact)).toBe(correctedIdentities.artifactSha256);
		expect.soft(domainHex("ts-drp/blueprint-artifact/v3", frozenArtifact)).toBe(correctedIdentities.artifactDigest);
		expect.soft(frozenPackage.artifactDigest).toBe(correctedIdentities.artifactDigest);
		expect.soft(frozenPackage.package.implementation.artifactDigest).toBe(correctedIdentities.artifactDigest);
		expect.soft(frozenPackage.packageSha256).toBe(correctedIdentities.packageSha256);
		expect.soft(frozenPackage.blueprintDigest).toBe(correctedIdentities.blueprintDigest);
	});

	it("executes the committed artifact over the authored PR prefix and nightly suffix with {state,operation}", async () => {
		const blueprint = await loadBlueprint(path.join(FROZEN_ROOT, "artifact.mjs"), "frozen");
		const pr = executeCases(
			blueprint.reducers,
			frozenAuthoring.conformance.initialState,
			frozenAuthoring.conformance.prCases
		);
		expect(pr).toEqual({ outputs: [0, 0], state: 0 });
		expect(Object.is(pr.outputs[0], -0)).toBe(false);

		const nightlyCases = [
			...frozenAuthoring.conformance.prCases,
			...frozenAuthoring.conformance.nightlyAdditionalCases,
		];
		expect(executeCases(blueprint.reducers, frozenAuthoring.conformance.initialState, nightlyCases)).toEqual({
			outputs: [0, 0, 7],
			state: 7,
		});
	});

	it("rejects the legacy {state,arguments} mutant instead of adding a wrapper or second ABI", async () => {
		const blueprint = await loadBlueprint(path.join(FROZEN_ROOT, "artifact.mjs"), "legacy-mutant");
		const add = blueprint.reducers.add;
		if (add === undefined) throw new TypeError("missing add reducer");
		expect(() => add({ arguments: { value: 2 }, state: 0 } as never)).toThrow();
	});

	it("proves the direct correct-ABI fixture is buildable, executable and identity-bound without receipt widening", async () => {
		const { authoring, output } = correctiveAuthoringCopy("control");
		await expect(buildBlueprint(authoring, output)).resolves.toBeUndefined();
		const artifact = fs.readFileSync(path.join(output, "artifact.mjs"));
		const packageBytes = fs.readFileSync(path.join(output, "package.bin"));

		expect(artifact).toEqual(correctiveArtifact);
		expect(artifact.toString("utf8")).toContain("input.operation.arguments");
		expect(artifact.toString("utf8")).not.toContain("input.arguments");
		expect(sha256(artifact)).toBe(correctedIdentities.artifactSha256);
		expect(domainHex("ts-drp/blueprint-artifact/v3", artifact)).toBe(correctedIdentities.artifactDigest);
		expect(packageBytes.byteLength).toBe(correctedIdentities.packageByteLength);
		expect(sha256(packageBytes)).toBe(correctedIdentities.packageSha256);
		expect(domainHex("ts-drp/blueprint-admission/v3", packageBytes)).toBe(correctedIdentities.blueprintDigest);
		expect(correctedIdentities.artifactDigest).not.toBe(frozenPackage.artifactDigest);
		expect(correctedIdentities.packageSha256).not.toBe(frozenPackage.packageSha256);
		expect(correctedIdentities.blueprintDigest).not.toBe(frozenPackage.blueprintDigest);
		expect(decodeCanonical(fs.readFileSync(path.join(output, "receipt.bin")))).toEqual({
			kind: "track-p2-c-receipt-placeholder",
			schemaVersion: 1,
		});

		const blueprint = await loadBlueprint(path.join(output, "artifact.mjs"), "correct-control");
		const nightlyCases = [
			...frozenAuthoring.conformance.prCases,
			...frozenAuthoring.conformance.nightlyAdditionalCases,
		];
		expect(executeCases(blueprint.reducers, frozenAuthoring.conformance.initialState, nightlyCases)).toEqual({
			outputs: [0, 0, 7],
			state: 7,
		});
	});
});
