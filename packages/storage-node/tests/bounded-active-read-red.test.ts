import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CASES, SQLITE_KEYS } from "../../../tests/fixtures/bounded-active-read/contract.js";

const child = resolve(import.meta.dirname, "../../../tests/fixtures/bounded-active-read/node-child.ts");
const custody = resolve(import.meta.dirname, "../../../tests/fixtures/bounded-active-read/runtime-custody.mjs");
// The custody loader hook refuses to run without an output file. A receipt run may
// collect custody into its own file through BOUNDED_AHE_RUNTIME_CUSTODY; otherwise
// each case owns a file in its temporary directory, so a plain
// `npx vitest run packages/storage-node/tests` needs no setup.
const receiptCustody = process.env.BOUNDED_AHE_RUNTIME_CUSTODY;
// Two fresh native processes per case, each importing tsx and the native store.
const CHILD_TIMEOUT_MS = 40_000;
const CASE_TIMEOUT_MS = 2 * CHILD_TIMEOUT_MS + 10_000;
describe("bounded AHE native fresh-process RED", () => {
	for (const name of [...CASES, ...SQLITE_KEYS])
		it(name, () => {
			const directory = mkdtempSync(join(tmpdir(), "bounded-ahe-case-")),
				filename = join(directory, "store.sqlite"),
				custodyFile = receiptCustody ?? join(directory, "runtime-custody.jsonl");
			const invoke = (mode: string): { pid: number; result?: Record<string, unknown>; setup?: unknown } => {
				const native = spawnSync(process.execPath, ["--import", custody, "--import=tsx", child, mode, filename, name], {
					encoding: "utf8",
					timeout: CHILD_TIMEOUT_MS,
					env: { ...process.env, BOUNDED_AHE_RUNTIME_CUSTODY: custodyFile },
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
				// The loader hook ran in the children and recorded what they actually executed.
				expect(readFileSync(custodyFile, "utf8")).toContain(`"pid":${observed.pid},`);
				console.log(JSON.stringify({ lane: "bounded-active-read", name, setupPid: seeded.pid, ...observed }));
				expect(observed.result, JSON.stringify(observed.result)).toMatchObject({ case: name, passed: true });
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}, CASE_TIMEOUT_MS);
});
