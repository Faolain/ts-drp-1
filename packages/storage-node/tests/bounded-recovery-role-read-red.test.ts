import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ROLE_CASES, supported } from "../../../tests/fixtures/bounded-active-read/role-contract.js";

const child = resolve(import.meta.dirname, "../../../tests/fixtures/bounded-active-read/role-node-child.ts");
const custody = resolve(import.meta.dirname, "../../../tests/fixtures/bounded-active-read/runtime-custody.mjs");
describe("bounded recovery role SQLite fresh-process RED", () => {
	for (const name of ROLE_CASES.filter((name) => supported(name, "sqlite")))
		it(name, () => {
			const directory = mkdtempSync(join(tmpdir(), "bounded-role-case-")),
				filename = join(directory, "store.sqlite");
			const invoke = (mode: string): { pid: number; setup?: unknown; result?: unknown } => {
				const native = spawnSync(process.execPath, ["--import", custody, "--import=tsx", child, mode, filename, name], {
					encoding: "utf8",
					timeout: 15000,
				});
				expect(native.error, native.stderr).toBeUndefined();
				expect(native.status, native.stdout + native.stderr).toBe(0);
				return JSON.parse(native.stdout.trim()) as { pid: number; setup?: unknown; result?: unknown };
			};
			try {
				const setup = invoke("setup"),
					run = invoke("run");
				expect(setup.setup).toBeDefined();
				expect(run.pid).not.toBe(setup.pid);
				expect(run.pid).not.toBe(process.pid);
				console.log(JSON.stringify({ lane: "bounded-recovery-role-read", case: name, setupPid: setup.pid, ...run }));
				expect(run.result, JSON.stringify(run.result)).toMatchObject({
					case: name,
					passed: true,
					downstreamExecuted: true,
				});
			} finally {
				rmSync(directory, { recursive: true, force: true });
				console.log(JSON.stringify({ case: name, nativeChildrenJoined: true, temporaryDatabaseRemoved: true }));
			}
		});
});
