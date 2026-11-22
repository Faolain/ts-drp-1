import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sqliteEnvironment } from "./fixtures/declaration-discovery-environment.js";
import {
	DISCOVERY_CASES,
	type Key,
	runDiscoveryCase,
} from "../../../tests/fixtures/snapshot-declaration-discovery/contract.js";
import { fixture, receiptFor, stable } from "../../../tests/fixtures/snapshot-recovery-owner/contract.js";

const directories: string[] = [];
function primary(): string {
	const directory = mkdtempSync(join(tmpdir(), "discovery-red-"));
	directories.push(directory);
	return join(directory, "primary.sqlite");
}
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
describe("2a native SQLite declaration discovery RED", () => {
	it("native-control", async () => {
		expect(await runDiscoveryCase("native-control", sqliteEnvironment(primary()))).toMatchObject({
			native: true,
			instrumented: true,
			invalidObservationRejected: true,
		});
	});
	it("native setup controls (not discovery behavior)", async () => {
		for (const name of DISCOVERY_CASES)
			expect(await runDiscoveryCase(name, sqliteEnvironment(primary()), true)).toEqual({
				case: name,
				setupValidated: true,
			});
	});
	for (const name of DISCOVERY_CASES)
		it(name, async () => {
			expect(await runDiscoveryCase(name, sqliteEnvironment(primary()))).toMatchObject({ case: name, passed: true });
		});
	it("fresh process receives only database identity and exact key", async () => {
		const primaryFilename = primary();
		const env = sqliteEnvironment(primaryFilename);
		const selected = fixture("discovery-fresh");
		const store = await env.open();
		const scope = await store.openScope(selected.declaration);
		await scope.complete(await receiptFor(scope, selected));
		await scope.retainForRecovery();
		await store.close();
		const before = stable(await env.image());
		const entry = resolve(import.meta.dirname, "fixtures/declaration-discovery-child.ts");
		const directory = directories.at(-1);
		if (!directory) throw new Error("child directory absent");
		const outfile = join(directory, "child.mjs");
		await build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node" });
		const input: { primaryFilename: string; key: Key } = { primaryFilename, key: { ...selected.declaration.scope } };
		expect(Object.keys(input).sort()).toEqual(["key", "primaryFilename"]);
		const child = spawnSync(process.execPath, [outfile, JSON.stringify(input)], { encoding: "utf8", timeout: 15000 });
		expect(child.error, child.stderr).toBeUndefined();
		expect(child.status, child.stdout + child.stderr).toBe(0);
		const returned = JSON.parse(child.stdout) as { pid: number; result: unknown };
		expect(returned.pid).not.toBe(process.pid);
		expect(returned.result).toEqual(
			JSON.parse(
				stable({
					kind: "present",
					declaration: selected.declaration,
					state: "verified",
					retention: "recovery",
					expiresAt: (await env.row(input.key)).expiresAt,
				})
			)
		);
		expect(stable(await env.image())).toBe(before);
	});
});
