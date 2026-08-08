import { expect, type Page, test } from "@playwright/test";

import { parseSpikeEvidence } from "./fixtures/evidence-schema.js";

const SENTINEL = Object.freeze({
	key: "phase-2-spike-s1-sentinel-key-v1",
	value: "phase-2-spike-s1-exact-sentinel-v1",
});
const EXPECTED_EVIDENCE_JSON =
	'{"schemaVersion":1,"artifactKind":"strict-idb-capability","requestedDurability":"strict","observedDurability":"strict","observedFrom":"live-transaction","nonStrictOutcome":"typed-fatal-capability-error","nonStrictWritesCommitted":0,"durabilityEvidenceScope":"capability-and-no-fallback","notProven":["fsync","power-loss","torn-write"]}';

interface ScenarioResult {
	readonly kind: "committed" | "fatal-capability-error";
	readonly requestedDurability: "strict";
	readonly liveReportedDurability: "default" | "relaxed" | "strict";
	readonly observedDurability: "strict" | "relaxed";
	readonly reportedDurability: "strict" | null;
	readonly error: null | {
		readonly name: "StrictIdbCapabilityError";
		readonly code: "NON_STRICT_DURABILITY";
		readonly requestedDurability: "strict";
		readonly observedDurability: "relaxed";
	};
	readonly reopened: { readonly count: number; readonly value: string | null };
	readonly evidenceJson: string | null;
	readonly evidenceBytes: readonly number[] | null;
}

interface StrictIdbPageGlobal {
	runStrictIdbCapabilityScenario(options?: {
		readonly testOnlyForcedObservedDurability?: "strict" | "relaxed";
	}): Promise<ScenarioResult>;
	readonly strictIdbSentinel: typeof SENTINEL;
}

async function runScenario(page: Page, forced?: "strict" | "relaxed"): Promise<ScenarioResult> {
	await page.goto("/");
	await page.waitForFunction(() => "runStrictIdbCapabilityScenario" in globalThis);
	return page.evaluate(async (forcedObservation) => {
		const ownedGlobal = globalThis as unknown as StrictIdbPageGlobal;
		return ownedGlobal.runStrictIdbCapabilityScenario(
			forcedObservation === undefined ? undefined : { testOnlyForcedObservedDurability: forcedObservation }
		);
	}, forced);
}

test.beforeAll(({ browser }) => {
	console.log(`S1_BROWSER_VERSION=${browser.version()}`);
});

test("absent seam reads live strict durability, commits one exact sentinel, and emits exact S0 evidence bytes", async ({
	page,
}) => {
	const result = await runScenario(page);
	const pageSentinel = await page.evaluate(() => (globalThis as unknown as StrictIdbPageGlobal).strictIdbSentinel);

	expect(result).toMatchObject({
		kind: "committed",
		requestedDurability: "strict",
		liveReportedDurability: "strict",
		observedDurability: "strict",
		reportedDurability: "strict",
		error: null,
		reopened: { count: 1, value: SENTINEL.value },
	});
	expect(pageSentinel).toEqual(SENTINEL);
	expect(result.evidenceJson).toBe(EXPECTED_EVIDENCE_JSON);
	expect(result.evidenceBytes).toEqual(Array.from(new TextEncoder().encode(EXPECTED_EVIDENCE_JSON)));
	const parsed: unknown = JSON.parse(result.evidenceJson ?? "null");
	expect(parseSpikeEvidence(parsed)).toEqual(parsed);
});

test("forced strict observation is a causal control against a vacuous always-fatal implementation", async ({
	page,
}) => {
	const result = await runScenario(page, "strict");
	expect(result).toMatchObject({
		kind: "committed",
		liveReportedDurability: "strict",
		observedDurability: "strict",
		reopened: { count: 1, value: SENTINEL.value },
	});
});

test("forced relaxed observation returns one typed fatal capability error and reopens with zero committed writes", async ({
	page,
}) => {
	const result = await runScenario(page, "relaxed");
	expect({
		kind: result.kind,
		requestedDurability: result.requestedDurability,
		liveReportedDurability: result.liveReportedDurability,
		observedDurability: result.observedDurability,
		reportedDurability: result.reportedDurability,
		error: result.error,
		committedWritesAfterReopen: result.reopened.count,
		reopenedValue: result.reopened.value,
		emittedEvidence:
			result.evidenceJson === null && result.evidenceBytes === null
				? "none"
				: `present:${result.evidenceBytes?.length ?? 0}-bytes`,
	}).toEqual({
		kind: "fatal-capability-error",
		requestedDurability: "strict",
		liveReportedDurability: "strict",
		observedDurability: "relaxed",
		reportedDurability: null,
		error: {
			name: "StrictIdbCapabilityError",
			code: "NON_STRICT_DURABILITY",
			requestedDurability: "strict",
			observedDurability: "relaxed",
		},
		committedWritesAfterReopen: 0,
		reopenedValue: null,
		emittedEvidence: "none",
	});
});
