import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { runBlueprintCli } from "../packages/blueprint-toolchain/src/index.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "../packages/canonical/src/index.js";

const AUTHORING = path.join(import.meta.dirname, "fixtures/track-p2-a/forward-counter");
const PRELOAD = path.join(import.meta.dirname, "fixtures/track-p2-c/child-preload.mjs");
const temporaryDirectories: string[] = [];

function workspace(): { readonly authoring: string; readonly output: string; readonly telemetry: string } {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "track-p2-c-control-selection-"));
	temporaryDirectories.push(root);
	const authoring = path.join(root, "authoring");
	fs.cpSync(AUTHORING, authoring, { recursive: true });
	fs.rmSync(path.join(authoring, "artifact.mjs"));
	const filename = path.join(authoring, "blueprint.json");
	const value = JSON.parse(fs.readFileSync(filename, "utf8")) as {
		conformance: {
			prCases: Array<{ action: string; arguments: Record<string, unknown>; id: string }>;
		};
	};
	value.conformance.prCases = [
		{ id: "pr-set-negative-zero-first", action: "set", arguments: { value: -0 } },
		{ id: "pr-read-between", action: "read-value", arguments: {} },
		{ id: "pr-set-repeated-later", action: "set", arguments: { value: 2 } },
	];
	const negativeZero = "__track_p2_c_negative_zero__";
	const text = JSON.stringify(
		value,
		(_key, candidate: unknown) =>
			typeof candidate === "number" && Object.is(candidate, -0) ? negativeZero : candidate,
		2
	).replace(`"${negativeZero}"`, "-0");
	fs.writeFileSync(filename, `${text}\n`);
	return { authoring, output: path.join(root, "bundle"), telemetry: path.join(root, "telemetry.json") };
}

function conformanceDigest(outputs: readonly unknown[]): string {
	return Buffer.from(hashDomain("ts-drp/blueprint-conformance/v1", encodeCanonical({ state: 0, outputs }))).toString(
		"hex"
	);
}

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("Track P2-c selected-action control binding corrective RED", () => {
	it("binds every active negative control and drift ordinal to the repeated guaranteed PR action rather than manifest index zero", async () => {
		const { authoring, output, telemetry } = workspace();
		const previousNodeOptions = process.env.NODE_OPTIONS;
		const previousTelemetry = process.env.TRACK_P2_C_TELEMETRY;
		process.env.NODE_OPTIONS = `${previousNodeOptions === undefined ? "" : `${previousNodeOptions} `}--import=${pathToFileURL(PRELOAD).href}`;
		process.env.TRACK_P2_C_TELEMETRY = telemetry;
		try {
			await expect(
				runBlueprintCli(["build", "--dir", authoring, "--out", output, "--tier", "pr"])
			).resolves.toBeUndefined();
		} finally {
			if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = previousNodeOptions;
			if (previousTelemetry === undefined) delete process.env.TRACK_P2_C_TELEMETRY;
			else process.env.TRACK_P2_C_TELEMETRY = previousTelemetry;
		}
		expect(fs.readdirSync(output).sort()).toEqual(["artifact.mjs", "lint.bin", "package.bin", "receipt.bin"]);
		const child = JSON.parse(fs.readFileSync(telemetry, "utf8")) as {
			readonly files: Readonly<Record<string, string>>;
			readonly receipt: {
				readonly negativeControls: {
					readonly moduleGlobalDrift: {
						readonly freshInstanceDigests: readonly string[];
						readonly sameModuleInstanceDigests: readonly string[];
					};
				};
			};
		};
		for (const filename of [
			"thenable.mjs",
			"moduleGlobalDrift.mjs",
			"noncanonicalIntermediate.mjs",
			"sparseIntermediate.mjs",
		]) {
			const artifact = Buffer.from(child.files[filename], "base64").toString("utf8");
			expect(artifact).toContain('"add": unchangedReducer');
			expect(artifact).toMatch(/"set": (?:thenableReducer|driftReducer|invalidReducer|sparseReducer)/u);
		}
		const drift = child.receipt.negativeControls.moduleGlobalDrift;
		expect(drift.sameModuleInstanceDigests).toEqual([conformanceDigest([1, null, 2]), conformanceDigest([3, null, 4])]);
		expect(drift.freshInstanceDigests).toEqual([conformanceDigest([1, null, 2]), conformanceDigest([1, null, 2])]);
		const receipt = decodeCanonical(fs.readFileSync(path.join(output, "receipt.bin"))) as {
			readonly operationOrder: readonly string[];
			readonly selectedCaseIds: readonly string[];
		};
		expect(receipt.operationOrder).toEqual(["set", "read-value", "set"]);
		expect(receipt.selectedCaseIds).toEqual(["pr-set-negative-zero-first", "pr-read-between", "pr-set-repeated-later"]);
	}, 60_000);
});
