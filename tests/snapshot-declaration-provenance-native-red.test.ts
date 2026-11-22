import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";

import { nativeCases, type NativeObservation } from "./fixtures/snapshot-declaration-native-provenance/cases.js";

let bundle: string;
let bootstrap: string;
let bundleSha256: string;
const results: NativeObservation[] = [];
beforeAll(async () => {
	const bootstrapResult = await build({
		entryPoints: [
			fileURLToPath(new URL("./fixtures/snapshot-declaration-native-provenance/node-child.ts", import.meta.url)),
		],
		bundle: true,
		format: "esm",
		platform: "node",
		write: false,
	});
	const bootstrapOutput = bootstrapResult.outputFiles[0];
	if (bootstrapOutput === undefined) throw new Error("missing isolated plain-Node test bootstrap");
	bootstrap = bootstrapOutput.text;
	const result = await build({
		entryPoints: [
			fileURLToPath(new URL("./fixtures/snapshot-declaration-native-provenance/node-owner.ts", import.meta.url)),
		],
		bundle: true,
		format: "esm",
		platform: "node",
		write: false,
		metafile: true,
	});
	const output = result.outputFiles[0];
	if (output === undefined) throw new Error("missing source-owner bundle");
	bundle = output.text;
	bundleSha256 = createHash("sha256").update(bundle).digest("hex");
	expect(Object.keys(result.metafile.inputs)).toContain("packages/storage-node/src/snapshot-transfer.ts");
	expect(Object.keys(result.metafile.inputs)).not.toContain("packages/storage-node/dist/src/snapshot-transfer.js");
	for (const path of [
		"packages/storage/dist/src/snapshot-transfer.js",
		"packages/protocol-v3/dist/src/snapshot-transfer.js",
		"packages/canonical/dist/src/index.js",
	])
		expect(Object.keys(result.metafile.inputs)).toContain(path);
});
for (const selected of nativeCases("sqlite")) {
	test(`native SQLite provenance: ${selected.label}`, () => {
		const child = spawnSync(process.execPath, ["--input-type=module", "--eval", bootstrap], {
			input: JSON.stringify({
				bundle,
				boundary: selected.boundary,
				sentinel: selected.sentinel,
				mode: selected.mode,
			}),
			encoding: "utf8",
			timeout: 15000,
			maxBuffer: 4 * 1024 * 1024,
		});
		expect(child.error, child.stderr).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		const observation = JSON.parse(child.stdout) as NativeObservation;
		results.push(observation);
		console.log(
			`NATIVE_PROVENANCE_RESULT ${JSON.stringify({ selected, observation, bundleSha256, sourceOwner: "packages/storage-node/src/snapshot-transfer.ts", builtDependencies: ["packages/storage/dist/src/snapshot-transfer.js", "packages/protocol-v3/dist/src/snapshot-transfer.js", "packages/canonical/dist/src/index.js"] })}`
		);
		expect(Object.values(observation.controls).every(Boolean)).toBe(true);
		if (selected.mode === "fault")
			expect(
				{ code: observation.observed.code, sentinelRetained: observation.observed.sentinelRetained },
				"NATIVE_PROCESSING_MAPPING_GAP"
			).toEqual({ code: "storage-failed", sentinelRetained: true });
		else if (selected.mode === "js-guard")
			expect(
				{ code: observation.observed.code, parseCalls: observation.guard?.parseCalls },
				"NATIVE_JS_PRIMITIVE_GUARD_GAP"
			).toEqual({ code: "poisoned", parseCalls: 0 });
		else expect(observation.observed.code).toBe(selected.expected);
	});
}
test("every genuine SQLite case reached its control boundary without setup failure", () => {
	expect(results).toHaveLength(nativeCases("sqlite").length);
	for (const result of results) expect(Object.values(result.controls).every(Boolean)).toBe(true);
});
