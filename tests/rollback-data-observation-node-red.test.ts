/* eslint-disable @typescript-eslint/explicit-function-return-type -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";

import {
	assertObservation,
	assertPresentPrecondition,
	type ObservationReport,
} from "./fixtures/rollback-data-observation/assertions.js";
import { negatives } from "./fixtures/rollback-data-observation/scenarios.js";
import { type Bootstrap, POSITIVES } from "./fixtures/rollback-data-observation/types.js";
const execute = promisify(execFile),
	directory = mkdtempSync(join(tmpdir(), "rollback-data-native-")),
	artifact = process.env.ROLLBACK_ARTIFACTS;
if (!artifact) throw new Error("FROZEN_BUNDLES_REQUIRED");
const frozenArtifact = artifact;
const raw = process.env.ROLLBACK_EVIDENCE;
if (!raw) throw new Error("RAW_EVIDENCE_REQUIRED");
mkdirSync(raw, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let serial = 0;
async function child(name: string, args: string[]): Promise<Record<string, unknown>> {
	const result = await execute(process.execPath, [join(frozenArtifact, name + ".mjs"), ...args], {
		timeout: 90_000,
		maxBuffer: 5 * 1024 * 1024,
	});
	return JSON.parse(result.stdout) as Record<string, unknown>;
}
async function produce(config: { name: string; epoch: 0 | 1 | 2 | 3; settlement: boolean; legacy: boolean }) {
	const identity = join(directory, String(serial++)),
		value = await child("node-entry", ["setup", identity, JSON.stringify(config)]);
	return value as unknown as {
		pid: number;
		report: { bootstrap: Bootstrap; expectedStates: number[] };
		precondition: ObservationReport["precondition"];
		integrity?: unknown;
	};
}
for (const config of POSITIVES) {
	it("real signed profile prerequisite: " + config.name, async () => {
		const setup = await produce(config);
		assertPresentPrecondition(setup.precondition, config.epoch, setup.report.expectedStates, config.legacy);
		writeFileSync(join(raw, "precondition-" + config.name + ".json"), JSON.stringify(setup, null, 2));
		expect(setup.precondition.transition).toEqual({ ok: true });
	});
	it("fresh SQLite whole observation: " + config.name, async () => {
		const setup = await produce(config),
			value = await child("node-recovery", [JSON.stringify(setup.report.bootstrap), "none"]);
		writeFileSync(join(raw, "positive-" + config.name + ".json"), JSON.stringify({ setup, value }, null, 2));
		expect(value.pid).not.toBe(setup.pid);
		assertPresentPrecondition(
			(value as unknown as ObservationReport).precondition,
			config.epoch,
			setup.report.expectedStates,
			config.legacy
		);
		assertObservation(value as unknown as ObservationReport, setup.precondition.targets, "none");
	});
}
for (const scenario of negatives)
	it("fresh SQLite causal refusal: " + scenario.name, async () => {
		const setup = await produce(scenario.config),
			value = await child("node-recovery", [JSON.stringify(setup.report.bootstrap), scenario.name]);
		writeFileSync(join(raw, "negative-" + scenario.name + ".json"), JSON.stringify({ setup, value }, null, 2));
		expect(value.pid).not.toBe(setup.pid);
		if (scenario.name === "forged-old-acl")
			expect((value as unknown as ObservationReport).mutation).toMatchObject({
				structural: { ok: true },
				tupleRepaired: true,
				genuineSignedRetirementUnchanged: true,
			});
		if (scenario.name === "wrong-retirement-anchor" || scenario.name === "old-qc-length")
			expect((value as unknown as ObservationReport).mutation).toMatchObject({
				crypto: { ok: true },
				actualSignatures: true,
				refAndBaseTuplesRepaired: true,
			});
		assertObservation(value as unknown as ObservationReport, setup.precondition.targets, scenario.name);
	});
it("actual generic bytes stay charged once inside native U; SAME-U journal-pressure killer is explicitly held", async () => {
	const setup = await produce(POSITIVES[5]),
		value = await child("node-recovery", [JSON.stringify(setup.report.bootstrap), "same-u"]);
	writeFileSync(join(raw, "generic-native-control.json"), JSON.stringify({ setup, value }, null, 2));
	expect(value.classification).toBe("GENERIC_NATIVE_CONTROL");
	const native = value.nativeControl as { actualDistinctUnionBytes: number; closureCounts: number[] };
	expect(native.closureCounts).toEqual([7, 7, 7]);
	expect(native.actualDistinctUnionBytes).toBeGreaterThan(setup.precondition.proofBytes + 65536);
	expect(native.actualDistinctUnionBytes).toBeLessThanOrEqual(262144);
	expect(native.actualDistinctUnionBytes).toBe(
		(value.mutation as { actualDistinctUnionBytes: number }).actualDistinctUnionBytes
	);
});
it("genuine unpruned G8 is actual bounded native refusal, not an availability positive", async () => {
	const setup = await produce({ ...POSITIVES[5], legacy: false }),
		value = await child("node-recovery", [JSON.stringify(setup.report.bootstrap), "unpruned-g8"]);
	writeFileSync(join(raw, "unpruned-g8-control.json"), JSON.stringify({ setup, value }, null, 2));
	expect(value.precondition).toMatchObject({
		physicalRows: 8,
		actualBoundedResult: { ok: false, reason: "READ_BUDGET_EXCEEDED" },
	});
});
it("prospective SQLite lookup/status are plain BEGIN with zero DML, original results and native terminals", async () => {
	const setup = await produce(POSITIVES[2]),
		value = await child("node-metadata", [JSON.stringify(setup.report.bootstrap)]);
	writeFileSync(join(raw, "metadata-mode-red.json"), JSON.stringify({ setup, value }, null, 2));
	const observed = value as unknown as {
		evidence: { modes: string[]; writes: number; terminals: string[] };
		value: { lookup: { kind: string; state: string; retention: string }; status: { migration: string } };
	};
	expect(observed.value.lookup).toMatchObject({ kind: "present", state: "verified", retention: "recovery" });
	expect(observed.value.status.migration).toBe("ready");
	expect(observed.evidence.writes).toBe(0);
	expect(observed.evidence.terminals).toEqual(["COMMIT", "COMMIT"]);
	expect(observed.evidence.modes).toEqual(["BEGIN", "BEGIN"]);
});
it("private observer/anchor custody has no Node package root or subpath export", () => {
	const manifest = JSON.parse(readFileSync("packages/node/package.json", "utf8")) as {
		exports: Record<string, unknown>;
	};
	expect(JSON.stringify(manifest.exports)).not.toMatch(/rollback-data|snapshot-data|closed-anchor-dependency/u);
	expect(readFileSync("packages/node/src/index.ts", "utf8")).not.toMatch(
		/authenticateCreatorClosedRollbackData|resolveCreatorClosedRollbackDataObservation/u
	);
});
