import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, it } from "vitest";

import { CASES, CRASH_CASES } from "./fixtures/signed-anchor-mechanism/exercise.js";
const bundles = process.env.SIGNED_ANCHOR_ARTIFACTS,
	evidence = process.env.SIGNED_ANCHOR_EVIDENCE;
if (!bundles || !evidence) throw new Error("FROZEN_BUNDLES_AND_EVIDENCE_REQUIRED");
const outputs = bundles,
	raw = evidence,
	owned = mkdtempSync(join(tmpdir(), "signed-anchor-mechanism-"));
mkdirSync(raw, { recursive: true });
const activeChildren = new Map<ReturnType<typeof spawn>, Promise<void>>();
afterAll(async () => {
	for (const processChild of activeChildren.keys()) processChild.kill("SIGKILL");
	await Promise.allSettled(activeChildren.values());
	rmSync(owned, { recursive: true, force: true });
});
let serial = 0;
async function child(mode: string, identity: string, input: unknown, label: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const args = [join(outputs, "node-entry.mjs"), mode, identity, JSON.stringify(input)],
			processChild = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		let closeJoined: (() => void) | undefined;
		activeChildren.set(
			processChild,
			new Promise<void>((joined) => {
				closeJoined = joined;
			})
		);
		let spawnError: unknown;
		let stdout = "",
			stderr = "",
			killed = false;
		processChild.stdout.on("data", (bytes: Buffer) => {
			stdout += bytes.toString();
		});
		processChild.stderr.on("data", (bytes: Buffer) => {
			stderr += bytes.toString();
		});
		const timer = setTimeout(() => {
			killed = true;
			processChild.kill("SIGKILL");
		}, 90000);
		processChild.on("error", (error) => {
			spawnError = error;
		});
		processChild.on("close", (code, signal) => {
			clearTimeout(timer);
			closeJoined?.();
			activeChildren.delete(processChild);
			writeFileSync(join(raw, label + ".stdout"), stdout);
			writeFileSync(join(raw, label + ".stderr"), stderr);
			writeFileSync(
				join(raw, label + ".terminal.json"),
				JSON.stringify({ executable: process.execPath, args, pid: processChild.pid, code, signal, killed })
			);
			if (spawnError) reject(spawnError);
			else if (signal === "SIGKILL" && mode.startsWith("crash-"))
				resolve({
					classification: "INTERRUPTED_AFTER_REAL_NATIVE_STAGE",
					pid: processChild.pid,
					stage: JSON.parse(stdout),
					signal,
				});
			else if (code !== 0 || signal) reject(new Error(`native terminal ${code}/${signal}: ${stderr}`));
			else {
				try {
					resolve(JSON.parse(stdout) as Record<string, unknown>);
				} catch (error) {
					reject(error);
				}
			}
		});
	});
}
for (const mode of ["baseline", "generic-native", ...CASES])
	it("fresh SQLite causal signed-anchor: " + mode, async () => {
		const identity = join(owned, String(serial++)),
			setup = await child("setup", identity, {}, mode + "-setup");
		const report = setup.report as { bootstrap: unknown };
		const result = await child(mode, identity, report.bootstrap, mode);
		assert.notEqual(result.pid, setup.pid);
		if (mode === "generic-native") {
			assert.equal(result.classification, "GENERIC_NATIVE_CONTROL");
			assert.equal(result.nativeUnionOnly, true);
			assert.equal(result.publishedWholeObserverPressure, "HELD");
			assert.equal(result.fullUnionBytes, Number((result.precondition as { proofBytes: number }).proofBytes) + 65536);
			return;
		}
		assert.equal(result.requirementFrozen, true);
		assert.equal(result.requirementFieldless, true);
		if (mode.startsWith("baseline")) {
			assert.deepEqual((result.observer as { ok: boolean }).ok, true);
			assert.equal(result.classification, "REACHED");
			return;
		}
		assert.equal(
			result.classification,
			mode.startsWith("same-u-unit-") ? "REACHED_IMPORTER_UNIT_COMPOSITION" : "REACHED",
			"WIRING_RED: prospective consumer assertions remain masked, never a product success"
		);
		if (mode.startsWith("same-u-unit-")) {
			assert.ok(result.storageResults);
			if (mode === "same-u-unit-equal") assert.deepEqual(result.observer, { ok: false, kind: "proof-budget-exceeded" });
			return;
		}
		if (
			[
				"signature",
				"parameters",
				"authority",
				"storage-capture",
				"envelope-budget",
				"empty-idempotence",
				"populated-refusal",
				"orphan-nonnumeric",
				"zero-nonnumeric",
				"nonzero-empty",
			].includes(mode) ||
			mode.startsWith("physical-") ||
			mode.startsWith("terminal-")
		) {
			assert.ok(result.storageResults);
			if (mode.startsWith("physical-")) {
				const evidence = (result.storageResults as { evidence: { reads: { rows: unknown[] }[] } }).evidence;
				for (const read of evidence.reads)
					for (const row of read.rows) {
						assert.doesNotMatch(
							JSON.stringify(row),
							/"nativeBytes":(?!0\b)\d/u,
							"ALL BLOBs must stay behind physical metadata and component gates"
						);
						for (const value of Object.values(row as object))
							if (typeof value === "string")
								assert.ok(value.length <= 256, "unchecked metadata TEXT must not cross native projection");
					}
			}
			if (mode === "storage-capture") {
				const storage = result.storageResults as {
					reads: { evidence: { modes: unknown[] } }[];
					imports: { evidence: { modes: unknown[] } }[];
				};
				for (const call of [...storage.reads, ...storage.imports])
					assert.deepEqual(call.evidence.modes, [], "capture refuses before native work");
			}
			return;
		}
		const imported = result.importerResult as { ok: boolean; material?: object; kind?: string };
		if (mode === "in-place" || mode === "empty-import") {
			assert.equal(imported.ok, true);
			assert.ok(imported.material);
			assert.equal(result.importerMaterialFrozen, true);
			assert.equal(result.importerMaterialFieldless, true);
			assert.equal(Reflect.ownKeys(imported.material).length, 0);
			assert.equal((result.observer as { ok: boolean }).ok, true);
			if (mode === "in-place") {
				const native = result.native as { modes: string[]; writes: number; reads: { sql: string }[] };
				assert.equal(native.writes, 0);
				assert.ok(native.modes.every((value) => value === "BEGIN"));
				assert.ok(native.reads.every((read) => !/accepted_entries/u.test(read.sql)));
				const stale = result.postRelease as { ok: boolean; kind: string };
				assert.equal(stale.ok, false);
				assert.ok(["requirement-unavailable", "authority-stale"].includes(stale.kind));
			}
			const reopen = await child(
				mode === "empty-import" ? "empty-import" : "in-place",
				identity,
				report.bootstrap,
				mode + "-reopen"
			);
			assert.notEqual(reopen.pid, result.pid);
			const reopenedImport = reopen.importerResult as { ok: boolean; material?: object };
			assert.equal(reopenedImport.ok, true);
			assert.ok(reopenedImport.material);
			assert.equal(Reflect.ownKeys(reopenedImport.material).length, 0);
			assert.equal(reopen.importerMaterialFrozen, true);
			assert.equal(reopen.importerMaterialFieldless, true);
			assert.equal((reopen.observer as { ok: boolean }).ok, true);
		} else {
			assert.equal(imported.ok, false);
			const expected: Record<string, string[]> = {
				"source-absent": ["source-unavailable"],
				"foreign-requirement": ["requirement-unavailable"],
				"foreign-ledger": ["requirement-unavailable"],
				"capture-accessor": ["malformed-input"],
				"initial-abort": ["aborted"],
				"floor-stale": ["authority-stale"],
				"floor-pending": ["authority-stale"],
				"head-stale": ["authority-stale"],
				"source-close": ["source-unavailable"],
				"destination-close": ["destination-unavailable"],
			};
			assert.ok(expected[mode]?.includes(imported.kind ?? ""), "typed refusal for " + mode + ":" + imported.kind);
			assert.equal(result.getterReads, 0);
			if (["foreign-requirement", "foreign-ledger", "capture-accessor", "initial-abort"].includes(mode)) {
				const native = result.importNative as {
					modes: unknown[];
					reads: unknown[];
					writes: number;
					fixture: { reads: unknown[] };
				};
				assert.deepEqual(native.modes, []);
				assert.deepEqual(native.reads, []);
				assert.deepEqual(native.fixture.reads, []);
				assert.equal(native.writes, 0);
			}
		}
	});
it("private importer and ledger authority never leak through Node root/export maps", () => {
	assert.doesNotMatch(
		readFileSync("packages/node/src/index.ts", "utf8"),
		/importCreatorClosedRollbackAnchor|ClosedAclAnchorRequirement|CreatorClosedRollbackProofLedger/u
	);
	assert.doesNotMatch(readFileSync("packages/node/package.json", "utf8"), /closed-rollback|historical-anchor/u);
});
for (const mode of CRASH_CASES)
	it("actual SQLite process interruption: " + mode, async () => {
		const identity = join(owned, String(serial++)),
			setup = await child("setup", identity, {}, mode + "-setup"),
			report = setup.report as { bootstrap: unknown };
		const interrupted = await child(mode, identity, report.bootstrap, mode);
		assert.equal(
			interrupted.classification,
			"INTERRUPTED_AFTER_REAL_NATIVE_STAGE",
			"WIRING_RED: interruption stage not reached without real future native importer"
		);
		const reopened = await child("census", identity, report.bootstrap, mode + "-reopen");
		assert.notEqual(reopened.pid, interrupted.pid);
		const committed = mode === "crash-after-commit" || mode === "crash-after-confirmation";
		assert.equal((reopened.storageResults as { kind: string }).kind, committed ? "present" : "missing");
		assert.equal((reopened.observer as { ok: boolean }).ok, committed);
		assert.equal(
			(interrupted.stage as { originalClosureDebt: string }).originalClosureDebt,
			"held-not-resolved-by-later-envelope-fact"
		);
	});
