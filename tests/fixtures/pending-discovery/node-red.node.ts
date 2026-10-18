import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { assertProbe, assertRecovery } from "./assertions.js";
import { type Case, probeModes, sqliteAuthProbes, sqliteCases } from "./roster.js";
import type { ProbeReport, RecoveryReport, SetupReport } from "./types.js";
const artifacts = process.env.PENDING_ARTIFACTS,
	evidence = process.env.PENDING_EVIDENCE;
if (artifacts === undefined || evidence === undefined || existsSync(evidence))
	throw new Error("NEW_ARTIFACT_EVIDENCE_REQUIRED");
mkdirSync(evidence, { recursive: true });
const artifactsDirectory = artifacts,
	evidenceDirectory = evidence;
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const manifest = JSON.parse(readFileSync(join(artifacts, "artifacts.json"), "utf8")) as {
	controllers: Record<string, string>;
	entries: { name: string; outputPath: string; outputSha256: string; inputs: Record<string, string> }[];
};
for (const [path, expected] of Object.entries(manifest.controllers))
	assert.equal(hash(readFileSync(path)), expected, "fixture/controller input drift:" + path);
for (const entry of manifest.entries) {
	assert.equal(hash(readFileSync(entry.outputPath)), entry.outputSha256);
	for (const [path, digest] of Object.entries(entry.inputs))
		assert.equal(hash(readFileSync(path)), digest, "input drift:" + path);
}
function run(directory: string, name: string, args: string[]): { pid: number; kind: string; report: unknown } {
	const command = [join(artifactsDirectory, name + ".mjs"), ...args],
		started = new Date().toISOString();
	const completed = spawnSync(process.execPath, command, {
		encoding: "utf8",
		timeout: 15000,
		killSignal: "SIGKILL",
		stdio: ["ignore", "pipe", "pipe"],
	});
	writeFileSync(join(directory, name + ".stdout"), completed.stdout ?? "", { flag: "wx" });
	writeFileSync(join(directory, name + ".stderr"), completed.stderr ?? "", { flag: "wx" });
	writeFileSync(
		join(directory, name + ".terminal.json"),
		JSON.stringify(
			{
				command: [process.execPath, ...command],
				started,
				finished: new Date().toISOString(),
				pid: completed.pid,
				status: completed.status,
				signal: completed.signal,
				error: completed.error?.message,
				stdoutSha256: hash(completed.stdout ?? ""),
				stderrSha256: hash(completed.stderr ?? ""),
			},
			null,
			2
		),
		{ flag: "wx" }
	);
	assert.equal(completed.status, 0, name + " failed:" + completed.stderr);
	const line = (completed.stdout ?? "").trim().split("\n").at(-1);
	if (line === undefined) throw new Error("CHILD_REPORT_MISSING");
	const result = JSON.parse(line) as {
		pid: number;
		kind: string;
		ownersClosed: boolean;
		report: unknown;
	};
	assert.equal(result.ownersClosed, true, "child report emitted only after native owner cleanup settles");
	return result;
}
function clean(directory: string): void {
	const native = [
		"ahe.sqlite",
		"issuance.sqlite.drp-issuance-v1.sqlite",
		"journal.sqlite.drp-live-journal-v1.sqlite",
		"snapshot.sqlite.drp-snapshot-quarantine-v1.sqlite",
	];
	const deleted: string[] = [];
	const failures: unknown[] = [];
	for (const name of native)
		for (const suffix of ["", "-wal", "-shm"]) {
			const file = join(directory, name + suffix);
			if (existsSync(file)) {
				try {
					unlinkSync(file);
					deleted.push(file);
				} catch (error) {
					failures.push(error);
				}
			}
		}
	writeFileSync(
		join(directory, "cleanup.json"),
		JSON.stringify(
			{
				childTerminalEvidence: ["node-setup", "node-recovery", "node-probe", "node-auth-probe"]
					.filter((name) => existsSync(join(directory, name + ".terminal.json")))
					.map((name) => JSON.parse(readFileSync(join(directory, name + ".terminal.json"), "utf8")) as unknown),
				deleted,
				exactTargets: native,
				cleanupFailures: failures.map(String),
			},
			null,
			2
		),
		{ flag: "wx" }
	);
	if (failures.length !== 0) throw new AggregateError(failures, "EXACT_NATIVE_CLEANUP_FAILED");
}
function directory(id: string): string {
	const path = resolve(evidenceDirectory, id);
	mkdirSync(path);
	return path;
}
function prepared(path: string, scenario: Case): { pid: number; setup: SetupReport } {
	const first = run(path, "node-setup", [
			path,
			String(scenario.epoch),
			scenario.published ? "published" : "staged",
			scenario.mode,
		]),
		setup = first.report as SetupReport;
	assert.equal(first.kind, "SETUP_COMPLETE");
	assert.deepEqual(setup.oracle.closeEpochs, scenario.epoch === 1 ? [0] : [0, 1]);
	assert.deepEqual(setup.oracle.lookupScope.objectId, setup.bootstrap.expectedPreviousRoomHead.objectId);
	assert.equal(setup.oracle.lookupScope.epoch, setup.bootstrap.expectedPreviousRoomHead.epoch);
	assert.equal(setup.oracle.lookupScope.anchor, setup.bootstrap.expectedPreviousRoomHead.currentAnchorDigest);
	assert.notEqual(setup.oracle.competingScope.epoch, setup.oracle.lookupScope.epoch);
	assert.equal(
		(setup.oracle.pendingHead as { generationId: string }).generationId,
		scenario.published
			? setup.oracle.pendingGenerationId
			: (setup.oracle.proposedHead as { generationId: string }).generationId
	);
	return { pid: first.pid, setup };
}
for (const scenario of sqliteCases)
	void test("SQLite declaration-free: " + scenario.id, { timeout: 15000 }, () => {
		const path = directory("product-" + scenario.id);
		let primary: { error: unknown } | undefined;
		try {
			const { pid, setup } = prepared(path, scenario),
				file = join(path, "restart-bootstrap.json");
			writeFileSync(file, JSON.stringify(setup.bootstrap), { flag: "wx" });
			const recovered = run(path, "node-recovery", [file, scenario.mode]);
			assert.notEqual(pid, recovered.pid);
			assert.equal(recovered.kind, "RECOVERY_COMPLETE");
			const report = recovered.report as RecoveryReport;
			writeFileSync(
				join(path, "assertion-reach.json"),
				JSON.stringify(
					{
						classification: report.classification,
						downstream:
							report.classification === "MASKED_BY_ENVELOPE_REJECTION" ? "MASKED_BY_ENVELOPE_REJECTION" : "REACHED",
						scenario,
						report,
					},
					null,
					2
				),
				{ flag: "wx" }
			);
			console.log(
				JSON.stringify({
					lane: "product",
					scenario,
					classification: report.classification,
					result: report.result,
					effects: report.effects,
				})
			);
			try {
				assertRecovery(report, setup, scenario);
			} finally {
				writeFileSync(
					join(path, "executed-assertions.json"),
					JSON.stringify(
						{
							scenario,
							classification: report.classification,
							downstream: report.downstreamAssertions,
							assertions: report.executedAssertions,
							expectedObservations: report.expectedObservations,
						},
						null,
						2
					),
					{ flag: "wx" }
				);
			}
		} catch (error) {
			primary = { error };
		} finally {
			try {
				clean(path);
			} catch (error) {
				if (primary === undefined) primary = { error };
				else
					primary = {
						error: new AggregateError([primary.error, error], "PRIMARY_AND_CLEANUP", { cause: primary.error }),
					};
			}
		}
		if (primary !== undefined) throw primary.error;
	});
for (const mode of probeModes)
	void test("SQLite direct owner unmasked: " + mode, { timeout: 15000 }, () => {
		const path = directory("owner-" + mode);
		let primary: { error: unknown } | undefined;
		try {
			const scenario: Case = { id: mode, mode, epoch: 1, published: false },
				{ pid, setup } = prepared(path, scenario),
				file = join(path, "probe-only-input.json");
			writeFileSync(
				file,
				JSON.stringify({
					bootstrap: setup.bootstrap,
					scope: setup.oracle.lookupScope,
					competingScope: setup.oracle.competingScope,
				}),
				{ flag: "wx" }
			);
			const probed = run(path, "node-probe", [file, mode]);
			assert.notEqual(pid, probed.pid);
			assert.equal(probed.kind, "PROBE_COMPLETE");
			const report = probed.report as ProbeReport;
			console.log(JSON.stringify({ lane: "direct-owner-unmasked", mode, report }));
			assertProbe(report, mode, setup);
		} catch (error) {
			primary = { error };
		} finally {
			try {
				clean(path);
			} catch (error) {
				if (primary === undefined) primary = { error };
				else
					primary = {
						error: new AggregateError([primary.error, error], "PRIMARY_AND_CLEANUP", { cause: primary.error }),
					};
			}
		}
		if (primary !== undefined) throw primary.error;
	});
for (const scenario of sqliteAuthProbes)
	void test("SQLite RED-baseline instrumentation ONLY: " + scenario.id, { timeout: 15000 }, () => {
		const path = directory("instrumentation-" + scenario.id);
		let primary: { error: unknown } | undefined;
		try {
			const { pid, setup } = prepared(path, scenario),
				file = join(path, "probe-only-input.json");
			writeFileSync(
				file,
				JSON.stringify({
					bootstrap: setup.bootstrap,
					scope: setup.oracle.lookupScope,
					competingScope: setup.oracle.competingScope,
				}),
				{ flag: "wx" }
			);
			const probed = run(path, "node-auth-probe", [file, scenario.mode]);
			assert.notEqual(pid, probed.pid);
			assert.equal(probed.kind, "INSTRUMENTATION_ONLY");
			const report = probed.report as RecoveryReport;
			console.log(JSON.stringify({ lane: "RED_BASELINE_INSTRUMENTATION_ONLY", scenario, report }));
			try {
				assertRecovery(report, setup, scenario, true);
			} finally {
				writeFileSync(
					join(path, "executed-assertions.json"),
					JSON.stringify(
						{
							lane: "RED_BASELINE_INSTRUMENTATION_ONLY",
							scenario,
							classification: report.classification,
							downstream: report.downstreamAssertions,
							assertions: report.executedAssertions,
							allAvailableAssertions: report.allAvailable?.executedAssertions,
							expectedObservations: report.expectedObservations,
							allAvailableExpectedObservations: report.allAvailable?.expectedObservations,
						},
						null,
						2
					),
					{ flag: "wx" }
				);
			}
		} catch (error) {
			primary = { error };
		} finally {
			try {
				clean(path);
			} catch (error) {
				if (primary === undefined) primary = { error };
				else
					primary = {
						error: new AggregateError([primary.error, error], "PRIMARY_AND_CLEANUP", { cause: primary.error }),
					};
			}
		}
		if (primary !== undefined) throw primary.error;
	});
