import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ROLE_CASES, supported } from "../../../tests/fixtures/bounded-active-read/role-contract.js";

const child = resolve(import.meta.dirname, "../../../tests/fixtures/bounded-active-read/role-node-child.ts");
const custody = resolve(import.meta.dirname, "../../../tests/fixtures/bounded-active-read/runtime-custody.mjs");
// The custody loader hook refuses to run without an output file. A receipt run may
// collect custody into its own file through BOUNDED_AHE_RUNTIME_CUSTODY; otherwise
// each case owns a file in its temporary directory, so a plain
// `npx vitest run packages/storage-node/tests` needs no setup.
const receiptCustody = process.env.BOUNDED_AHE_RUNTIME_CUSTODY;
// Two fresh native processes per case, each importing tsx and the native store.
const CHILD_TIMEOUT_MS = 40_000;
const CASE_TIMEOUT_MS = 2 * CHILD_TIMEOUT_MS + 10_000;
describe("bounded recovery role SQLite fresh-process RED", () => {
	for (const name of ROLE_CASES.filter((name) => supported(name, "sqlite")))
		it(name, () => {
			const directory = mkdtempSync(join(tmpdir(), "bounded-role-case-")),
				filename = join(directory, "store.sqlite"),
				custodyFile = receiptCustody ?? join(directory, "runtime-custody.jsonl");
			const invoke = (mode: string): { pid: number; setup?: unknown; result?: unknown } => {
				const native = spawnSync(process.execPath, ["--import", custody, "--import=tsx", child, mode, filename, name], {
					encoding: "utf8",
					timeout: CHILD_TIMEOUT_MS,
					env: { ...process.env, BOUNDED_AHE_RUNTIME_CUSTODY: custodyFile },
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
				// The loader hook ran in the children and recorded what they actually executed.
				expect(readFileSync(custodyFile, "utf8")).toContain(`"pid":${run.pid},`);
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
		}, CASE_TIMEOUT_MS);
});
