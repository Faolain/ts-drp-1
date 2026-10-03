import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CASES, SQLITE_KEYS } from "../../../tests/fixtures/bounded-active-read/contract.js";

const child = resolve(import.meta.dirname, "../../../tests/fixtures/bounded-active-read/node-child.ts");
const custody = resolve(import.meta.dirname, "../../../tests/fixtures/bounded-active-read/runtime-custody.mjs");
describe("bounded AHE native fresh-process RED", () => {
	for (const name of [...CASES, ...SQLITE_KEYS])
		it(name, () => {
			const directory = mkdtempSync(join(tmpdir(), "bounded-ahe-case-")),
				filename = join(directory, "store.sqlite");
			const invoke = (mode: string): { pid: number; result?: Record<string, unknown>; setup?: unknown } => {
				const native = spawnSync(process.execPath, ["--import", custody, "--import=tsx", child, mode, filename, name], {
					encoding: "utf8",
					timeout: 15000,
				});
				expect(native.error, native.stderr).toBeUndefined();
				expect(native.status, native.stdout + native.stderr).toBe(0);
				return JSON.parse(native.stdout.trim()) as { pid: number; result?: Record<string, unknown>; setup?: unknown };
			};
			try {
				const seeded = invoke("setup"),
					observed = invoke("run");
				expect(seeded.setup).toBeDefined();
				expect(observed.pid).not.toBe(seeded.pid);
				expect(observed.pid).not.toBe(process.pid);
				console.log(JSON.stringify({ lane: "bounded-active-read", name, setupPid: seeded.pid, ...observed }));
				expect(observed.result, JSON.stringify(observed.result)).toMatchObject({ case: name, passed: true });
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
});
