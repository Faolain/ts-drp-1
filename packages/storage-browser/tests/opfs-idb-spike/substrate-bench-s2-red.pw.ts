import { expect, type Page, test } from "@playwright/test";

import { type MeasurementEvidence, parseSpikeEvidence } from "./fixtures/evidence-schema.js";

type BenchmarkResponse = Readonly<{
	evidence: MeasurementEvidence | null;
	oraclePass: boolean;
	diagnostics: Readonly<{
		commandCountPerArm: number;
		commandScriptDigestByArm: Readonly<{ opfs: string; idbStrict: string }>;
		armOraclePass: Readonly<{ opfs: boolean; idbStrict: boolean }>;
		idbObservedDurability: string;
		opfsFlushedBytes: number;
		blobBDigest: string;
	}>;
}>;

declare global {
	interface Window {
		runSubstrateBenchmark(request: { runId: string; corruptOracle: boolean }): Promise<BenchmarkResponse>;
	}
}

async function run(page: Page, request: { runId: string; corruptOracle: boolean }): Promise<BenchmarkResponse> {
	await page.goto("/");
	return page.evaluate((input) => window.runSubstrateBenchmark(input), request);
}

test("both real substrates execute one byte-identical Phase-2a adapter script before timing is admitted", async ({
	page,
}) => {
	const result = await run(page, { runId: "phase-2-spike-s2-baseline", corruptOracle: false });
	expect(result.oraclePass).toBe(true);
	expect(result.diagnostics).toMatchObject({
		commandCountPerArm: 12,
		armOraclePass: { opfs: true, idbStrict: true },
		idbObservedDurability: "strict",
	});
	expect(result.diagnostics.opfsFlushedBytes).toBeGreaterThan(0);
	expect(result.diagnostics.blobBDigest).toMatch(/^[0-9a-f]{64}$/u);

	const evidence = parseSpikeEvidence(JSON.parse(JSON.stringify(result.evidence)));
	expect(evidence.artifactKind).toBe("substrate-measurement");
	if (evidence.artifactKind !== "substrate-measurement") throw new Error("expected measurement evidence");
	expect(evidence).toMatchObject({
		opsExecuted: 24,
		oracleId: "phase-2a-read-object-state-v1",
		runId: "phase-2-spike-s2-baseline",
		executionOwner: "dedicated-worker",
		crossOriginIsolated: true,
		concurrencyShape: "single-writer",
		contendedMultiTab: "unmeasured-for-2i",
		commandParity: "byte-identical",
		correctnessBeforeTiming: true,
		timingPassingThreshold: "none",
	});
	expect(evidence.commandScriptDigest).toMatch(/^[0-9a-f]{64}$/u);
	expect(result.diagnostics.commandScriptDigestByArm).toEqual({
		opfs: evidence.commandScriptDigest,
		idbStrict: evidence.commandScriptDigest,
	});
	expect(evidence.arms.map(({ substrate, postState }) => ({ substrate, postState }))).toEqual([
		{ substrate: "opfs", postState: "oracle-pass" },
		{ substrate: "idb-strict", postState: "oracle-pass" },
	]);
	expect(JSON.stringify(evidence)).not.toMatch(/"(?:winner|chosen|preferred)"/u);
});

test("corrupt post-state is rejected before any measurement evidence is materialized", async ({ page }) => {
	const result = await run(page, { runId: "phase-2-spike-s2-corrupt-oracle", corruptOracle: true });
	expect(result.oraclePass).toBe(false);
	expect(result.diagnostics.commandCountPerArm).toBe(12);
	expect(result.diagnostics.armOraclePass).toEqual({ opfs: false, idbStrict: true });
	expect(result.diagnostics.commandScriptDigestByArm.opfs).toBe(result.diagnostics.commandScriptDigestByArm.idbStrict);
	expect(result.diagnostics.idbObservedDurability).toBe("strict");
	expect(result.diagnostics.opfsFlushedBytes).toBeGreaterThan(0);

	// RED: the permissive test scaffold publishes timing even though the OPFS oracle failed.
	expect(result.evidence).toBeNull();
});
