import { expect, type Page, test } from "@playwright/test";

import { parseSpikeEvidence } from "./fixtures/evidence-schema.js";

const ORIGINS = Object.freeze({
	target: "http://127.0.0.1:43873",
	noClear: "http://127.0.0.1:43874",
	secondOrigin: "http://127.0.0.1:43875",
});
const PAYLOADS = Object.freeze({
	target: Object.freeze({ opfsBytes: Object.freeze([0, 83, 51, 255, 1]), idbValue: "s3-target-idb-exact-v1" }),
	noClear: Object.freeze({ opfsBytes: Object.freeze([0, 83, 51, 255, 2]), idbValue: "s3-no-clear-idb-exact-v1" }),
	secondOrigin: Object.freeze({
		opfsBytes: Object.freeze([0, 83, 51, 255, 3]),
		idbValue: "s3-second-origin-idb-exact-v1",
	}),
});
const EXPECTED_CLEAR_EVIDENCE_JSON =
	'{"schemaVersion":1,"artifactKind":"bucket-clear-control","method":"whole-bucket-clear","claim":"deletion-not-eviction","notMeasured":["pressure-eviction","lru-ordering","itp-eviction","quota-driven-eviction","eviction-ordering","co-eviction-atomicity"],"payloadsReadableAfterReopen":true,"payloadsAbsentAfterClear":true,"noClearControlSurvived":true,"secondOriginSurvived":true}';

type OriginName = keyof typeof ORIGINS;
type ExactPayload = (typeof PAYLOADS)[OriginName];
type PayloadObservation = Readonly<{
	opfs: Readonly<{ present: boolean; exactBytes: boolean }>;
	idb: Readonly<{ present: boolean; exactValue: boolean }>;
}>;
interface Harness {
	seedExactPayload(payload: ExactPayload): Promise<void>;
	readExactPayload(payload: ExactPayload): Promise<PayloadObservation>;
	deleteDatabase(): Promise<void>;
}

async function seedAndReopen(page: Page, name: OriginName): Promise<PayloadObservation> {
	await page.goto(ORIGINS[name]);
	await page.waitForFunction(() => "phase2SpikeS3" in globalThis);
	await page.evaluate(
		async ({ payload }) =>
			(globalThis as unknown as { phase2SpikeS3: Harness }).phase2SpikeS3.seedExactPayload(payload),
		{ payload: PAYLOADS[name] }
	);
	await page.reload();
	await page.waitForFunction(() => "phase2SpikeS3" in globalThis);
	return read(page, name);
}

async function read(page: Page, name: OriginName): Promise<PayloadObservation> {
	return page.evaluate(
		async ({ payload }) =>
			(globalThis as unknown as { phase2SpikeS3: Harness }).phase2SpikeS3.readExactPayload(payload),
		{ payload: PAYLOADS[name] }
	);
}

async function partialRedClear(page: Page): Promise<void> {
	// RED defect: this deletes only one endpoint, not the origin's whole default bucket.
	await page.evaluate(async () => (globalThis as unknown as { phase2SpikeS3: Harness }).phase2SpikeS3.deleteDatabase());
}

function exactPresent(): PayloadObservation {
	return { opfs: { present: true, exactBytes: true }, idb: { present: true, exactValue: true } };
}

function wholeBucketEvidence(after: Readonly<Record<OriginName, PayloadObservation>>): Readonly<{
	evidenceJson: string | null;
	evidenceBytes: readonly number[] | null;
}> {
	const targetBothAbsent = !after.target.opfs.present && !after.target.idb.present;
	const noClearControlSurvived =
		after.noClear.opfs.exactBytes &&
		after.noClear.idb.exactValue &&
		after.noClear.opfs.present &&
		after.noClear.idb.present;
	const secondOriginSurvived =
		after.secondOrigin.opfs.exactBytes &&
		after.secondOrigin.idb.exactValue &&
		after.secondOrigin.opfs.present &&
		after.secondOrigin.idb.present;
	if (!targetBothAbsent || !noClearControlSurvived || !secondOriginSurvived) {
		return { evidenceJson: null, evidenceBytes: null };
	}
	return {
		evidenceJson: EXPECTED_CLEAR_EVIDENCE_JSON,
		evidenceBytes: Array.from(new TextEncoder().encode(EXPECTED_CLEAR_EVIDENCE_JSON)),
	};
}

test.beforeAll(({ browser }) => {
	expect(browser.version()).toBe("149.0.7827.55");
});

test("exact target and both true-origin controls survive fresh reload/reopen before clearing", async ({ browser }) => {
	const context = await browser.newContext();
	const pages = {
		target: await context.newPage(),
		noClear: await context.newPage(),
		secondOrigin: await context.newPage(),
	};
	for (const name of Object.keys(pages) as OriginName[]) {
		expect(await seedAndReopen(pages[name], name)).toEqual(exactPresent());
	}
	await context.close();
});

test("one target-origin whole-bucket clear removes both endpoints without touching either control origin", async ({
	browser,
}) => {
	const context = await browser.newContext();
	const pages = {
		target: await context.newPage(),
		noClear: await context.newPage(),
		secondOrigin: await context.newPage(),
	};
	for (const name of Object.keys(pages) as OriginName[]) {
		expect(await seedAndReopen(pages[name], name)).toEqual(exactPresent());
	}

	await partialRedClear(pages.target);
	await pages.target.reload();
	await pages.target.waitForFunction(() => "phase2SpikeS3" in globalThis);
	const after = {
		target: await read(pages.target, "target"),
		noClear: await read(pages.noClear, "noClear"),
		secondOrigin: await read(pages.secondOrigin, "secondOrigin"),
	};
	expect(after.noClear).toEqual(exactPresent());
	expect(after.secondOrigin).toEqual(exactPresent());
	expect(after.target.idb).toEqual({ present: false, exactValue: false });

	const evidence = wholeBucketEvidence(after);
	// Sole causal RED assertion: only genuine whole-bucket deletion may produce S0 clear evidence.
	expect(evidence).toEqual({
		evidenceJson: EXPECTED_CLEAR_EVIDENCE_JSON,
		evidenceBytes: Array.from(new TextEncoder().encode(EXPECTED_CLEAR_EVIDENCE_JSON)),
	});
	const parsed: unknown = JSON.parse(evidence.evidenceJson ?? "null");
	expect(parseSpikeEvidence(parsed)).toEqual(parsed);
	expect(JSON.stringify(parsed)).not.toMatch(/pressure-eviction-(?:measured|pass)|co-eviction-(?:measured|pass)/u);

	await context.close();
});
