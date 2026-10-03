import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";

import { type Artifact, compile } from "./fixtures/snapshot-recovery-read/build.js";
import { READ_CASES } from "./fixtures/snapshot-recovery-read/cases.js";
import type { ReadReport } from "./fixtures/snapshot-recovery-read/contract.js";

let owner: Artifact;
let bootstrap: Artifact;
beforeAll(async () => {
	[owner, bootstrap] = await Promise.all([compile("node-owner.ts"), compile("node-child.ts")]);
});

for (const name of READ_CASES) {
	test(`native SQLite reader: ${name}`, () => {
		const directory = mkdtempSync(join(tmpdir(), "snapshot-reader-case-"));
		const primaryFilename = join(directory, "primary.sqlite");
		const child = (phase: "setup" | "read"): { pid: number; result: ReadReport | unknown } => {
			const processResult = spawnSync(process.execPath, ["--input-type=module", "--eval", bootstrap.text], {
				input: JSON.stringify({ phase, name, primaryFilename, bundle: owner.text }),
				encoding: "utf8",
				timeout: 15000,
				maxBuffer: 4 * 1024 * 1024,
			});
			expect(processResult.error, processResult.stderr).toBeUndefined();
			expect(processResult.status, processResult.stdout + processResult.stderr).toBe(0);
			return JSON.parse(processResult.stdout) as { pid: number; result: unknown };
		};
		const setup = child("setup");
		const recovery = child("read");
		expect(recovery.pid).not.toBe(setup.pid);
		expect(recovery.pid).not.toBe(process.pid);
		const result = recovery.result as ReadReport;
		console.log(
			"SNAPSHOT_READER_RESULT " +
				JSON.stringify({
					name,
					setup,
					recovery,
					primaryFilename,
					directory,
					owner: { sha256: owner.sha256, inputs: owner.inputs },
					bootstrap: { sha256: bootstrap.sha256, inputs: bootstrap.inputs },
				})
		);
		expect(result.preconditions.unchanged, "genuine native preconditions reached independently").toBe(true);
		expect(result.passed, result.mask ?? result.observed.detail).toBe(true);
	});
}
