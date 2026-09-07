import { expect, test, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { NativeCase } from "./assets/snapshot-recovery-retention-entry.js";
import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";
import {
	expectedRetentionCase,
	RETENTION_CASES,
} from "../../../tests/fixtures/snapshot-recovery-retention/contract.js";
let server: Phase4cBrowserServer;
async function persistObservation(testInfo: TestInfo, name: string, result: unknown): Promise<void> {
	const path = testInfo.outputPath(`${name}.json`);
	await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
	await testInfo.attach(name, { path, contentType: "application/json" });
}
test.beforeAll(async () => {
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(import.meta.dirname, "assets/snapshot-recovery-retention-entry.ts"),
	});
});

const nativeCases: readonly NativeCase[] = [
	"strict-missing",
	"strict-default",
	"strict-relaxed",
	"abort-after-write",
	"late-abort",
	"prevented-request-error",
	"active-release",
	"neighbor-isolation",
	"cursor-key-row-mismatch",
	"cursor-key-row-control",
	"earlier-refusal-late-signal",
];
for (const name of nativeCases)
	test(`native terminal edge ${name}`, async ({ page }, testInfo) => {
		await page.goto(server.origin);
		await page.waitForFunction(() => typeof window.runSnapshotRecoveryRetention === "function");
		const result = (await page.evaluate((selected) => window.runSnapshotRecoveryRetention(selected), name)) as {
			code: string;
			unchanged: boolean;
			recoveryScopes: number;
			evidence: Record<string, unknown>;
		};
		await persistObservation(testInfo, "native-terminal-observation", result);
		const refusal =
			name.startsWith("strict-") ||
			name === "earlier-refusal-late-signal" ||
			name === "abort-after-write" ||
			name === "cursor-key-row-mismatch";
		expect(result.code).toBe(
			name.startsWith("strict-")
				? "storage-failed"
				: name === "earlier-refusal-late-signal" || name === "cursor-key-row-mismatch"
					? "poisoned"
					: name === "abort-after-write"
						? "aborted"
						: "none"
		);
		expect(result.unchanged).toBe(refusal || name === "cursor-key-row-control");
		expect(result.evidence).toMatchObject({
			payloadBatches: 0,
			otherScopePayloads: 0,
			transactions: 1,
			transactionStores: ["chunks", "owner", "scopes"],
			complete: refusal ? 0 : 1,
			abort: refusal ? 1 : 0,
			settledAfterTerminal: true,
			requestedStrict: true,
			nativeReportedStrict: true,
			exposedDurability: name === "strict-missing" ? null : name.startsWith("strict-") ? name.slice(7) : "strict",
		});
		if (name.startsWith("strict-")) expect(result.evidence.writes).toBe(0);
		if (name.startsWith("strict-")) expect(result.evidence.storeAccess).toBe(0);
		if (name === "abort-after-write" || name === "active-release")
			expect(result.evidence.requestSuccess).toBeGreaterThan(0);
		if (name === "late-abort") expect(result.evidence.lateCancellationDispatched).toBe(true);
		if (name.startsWith("cursor-key-row-")) {
			expect(result.evidence.keyMismatchExposures).toBeGreaterThan(0);
			const witnesses = result.evidence.keyMismatchWitnesses as {
				property: string;
				nativeKey: unknown[];
				exposedKey: unknown[];
				nativeRowIndex: unknown;
				rowIndex: unknown;
			}[];
			expect(witnesses.length).toBeGreaterThan(0);
			for (const witness of witnesses) {
				expect(witness.nativeKey[4]).toBe(witness.nativeRowIndex);
				expect([0, 1]).toContain(witness.exposedKey[4]);
				expect([0, 1]).toContain(witness.rowIndex);
				expect(witness.exposedKey[4]).not.toBe(witness.rowIndex);
			}
			if (name === "cursor-key-row-control") expect(result.evidence.keyOnlyControlRows).toBe(2);
			if (name === "cursor-key-row-control")
				expect([...new Set(witnesses.map((witness) => witness.property))].sort()).toEqual([
					"get.result",
					"key",
					"primaryKey",
				]);
		}
		if (name === "prevented-request-error") expect(result.evidence.error).toBeGreaterThan(0);
		expect(result.recoveryScopes).toBe(
			(refusal && name !== "earlier-refusal-late-signal") || name === "cursor-key-row-control" ? 0 : 1
		);
	});
test.afterAll(async () => {
	await server.close();
});
for (const name of RETENTION_CASES)
	test(`1a-1 native retention ${name}`, async ({ page }, testInfo) => {
		await page.goto(server.origin);
		await page.waitForFunction(() => typeof window.runSnapshotRecoveryRetention === "function");
		const result = await page.evaluate((selected) => window.runSnapshotRecoveryRetention(selected), name);
		await persistObservation(testInfo, "retention-observation", result);
		expect(result).toEqual(expectedRetentionCase(name));
	});
