import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { assertRecovery } from "./assertions.js";
import { cases, type RecoveryReport, type SetupReport } from "./types.js";

const artifacts = process.env.COLD_ARTIFACTS;
const evidence = process.env.COLD_EVIDENCE;
if (artifacts === undefined || evidence === undefined || existsSync(evidence))
	throw new Error("REQUIRE_BUILT_ARTIFACTS_AND_NEW_EVIDENCE_DIRECTORY");
mkdirSync(evidence, { recursive: true });
const manifest = JSON.parse(readFileSync(join(artifacts, "artifacts.json"), "utf8")) as {
	entries: { name: string; outputPath: string; outputSha256: string; inputs: Record<string, string> }[];
};
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
for (const entry of manifest.entries) {
	assert.equal(hash(readFileSync(entry.outputPath)), entry.outputSha256, "built fixture changed before execution");
	for (const [path, expected] of Object.entries(entry.inputs))
		assert.equal(hash(readFileSync(path)), expected, `loaded input drift:${path}`);
}
for (const epoch of [1, 2] as const)
	for (const mode of cases) {
		void test(`native SQLite fresh process epoch ${epoch}: ${mode}`, () => {
			const directory = resolve(evidence, `epoch-${epoch}-${mode}`);
			mkdirSync(directory);
			const run = (name: string, args: string[]): { pid: number; kind: string; report: unknown } => {
				const started = new Date().toISOString();
				const command = [join(artifacts, `${name}.mjs`), ...args];
				const completed = spawnSync(process.execPath, command, {
					encoding: "utf8",
					timeout: 15000,
					stdio: ["ignore", "pipe", "pipe"],
				});
				const text = completed.stdout ?? "";
				writeFileSync(join(directory, `${name}.stderr`), completed.stderr ?? "", { flag: "wx" });
				writeFileSync(
					join(directory, `${name}.receipt.json`),
					JSON.stringify({
						started,
						finished: new Date().toISOString(),
						command: [process.execPath, ...command],
						pid: completed.pid,
						status: completed.status,
						signal: completed.signal,
						error: completed.error?.message,
						stdoutSha256: hash(Buffer.from(text)),
						stderrSha256: hash(Buffer.from(completed.stderr ?? "")),
					}),
					{ flag: "wx" }
				);
				writeFileSync(join(directory, `${name}.jsonl`), text, { flag: "wx" });
				assert.equal(completed.status, 0, `${name} failed:${completed.stderr}`);
				return JSON.parse(text.trim().split("\n").at(-1) as string) as { pid: number; kind: string; report: unknown };
			};
			const prepared = run("node-setup", [directory, String(epoch)]);
			assert.equal(prepared.kind, "SETUP_COMPLETE");
			const setup = prepared.report as SetupReport;
			assert.deepEqual(setup.oracle.closeEpochs, epoch === 1 ? [0] : [0, 1]);
			assert.equal(setup.bootstrap.expectedRoomHead.epoch, epoch);
			const envelopePath = join(directory, "restart-bootstrap.json");
			writeFileSync(envelopePath, JSON.stringify(setup.bootstrap), { flag: "wx" });
			assert.ok(!readFileSync(envelopePath, "utf8").includes("lookupScope"));
			// spawnSync has returned: the setup process is terminal before recovery starts.
			const recovered = run("node-recovery", [envelopePath, mode]);
			assert.notEqual(recovered.pid, prepared.pid);
			assert.equal(recovered.kind, "RECOVERY_COMPLETE");
			const report = recovered.report as RecoveryReport;
			console.log(
				JSON.stringify({
					epoch,
					mode,
					classification: report.classification,
					result: report.result,
					effects: report.effects,
				})
			);
			assertRecovery(report, setup);
		});
	}
