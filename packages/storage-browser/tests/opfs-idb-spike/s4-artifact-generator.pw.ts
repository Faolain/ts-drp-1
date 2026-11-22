import { chromium, expect, type Page, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { parseSpikeEvidence } from "./fixtures/evidence-schema.js";
import { requirePhase2dDecisionConsumptionReady } from "./fixtures/s4-decision-consumption-gate.js";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = (require("@playwright/test/package.json") as { readonly version: string }).version;
const ARTIFACT_DIRECTORY = path.join(import.meta.dirname, "artifacts");
const EXPECTED_S1_EVIDENCE_JSON =
	'{"schemaVersion":1,"artifactKind":"strict-idb-capability","requestedDurability":"strict","observedDurability":"strict","observedFrom":"live-transaction","nonStrictOutcome":"typed-fatal-capability-error","nonStrictWritesCommitted":0,"durabilityEvidenceScope":"capability-and-no-fallback","notProven":["fsync","power-loss","torn-write"]}';
const EXPECTED_S3_EVIDENCE_JSON =
	'{"schemaVersion":1,"artifactKind":"bucket-clear-control","method":"whole-bucket-clear","claim":"deletion-not-eviction","notMeasured":["pressure-eviction","lru-ordering","itp-eviction","quota-driven-eviction","eviction-ordering","co-eviction-atomicity"],"payloadsReadableAfterReopen":true,"payloadsAbsentAfterClear":true,"noClearControlSurvived":true,"secondOriginSurvived":true}';
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

type OriginName = keyof typeof ORIGINS;
type ExactPayload = (typeof PAYLOADS)[OriginName];
type PayloadObservation = Readonly<{
	opfs: Readonly<{ present: boolean; exactBytes: boolean }>;
	idb: Readonly<{ present: boolean; exactValue: boolean }>;
}>;
type S1Result = Readonly<{
	kind: "committed" | "fatal-capability-error";
	liveReportedDurability: "default" | "relaxed" | "strict";
	observedDurability: "default" | "relaxed" | "strict";
	reopened: Readonly<{ count: number; value: string | null }>;
	evidenceJson: string | null;
	evidenceBytes: readonly number[] | null;
}>;
type S2Result = Readonly<{
	evidence: unknown;
	oraclePass: boolean;
	diagnostics: Readonly<{
		commandCountPerArm: number;
		armOraclePass: Readonly<{ opfs: boolean; idbStrict: boolean }>;
		idbObservedDurability: string;
		opfsFlushedBytes: number;
	}>;
}>;
interface S3Harness {
	seedExactPayload(payload: ExactPayload): Promise<void>;
	readExactPayload(payload: ExactPayload): Promise<PayloadObservation>;
}

function sha256(bytes: string): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function exactPresent(): PayloadObservation {
	return { opfs: { present: true, exactBytes: true }, idb: { present: true, exactValue: true } };
}

function executableBuildId(): string {
	const executablePath = chromium.executablePath();
	const result = spawnSync(executablePath, ["--version"], { encoding: "utf8", timeout: 5_000 });
	if (result.error !== undefined || result.status !== 0 || result.stdout.trim().length === 0) {
		throw new Error(
			`could not capture Chromium executable build identity: ${result.error?.message ?? `exit ${result.status}`}`
		);
	}
	return result.stdout.trim();
}

function operatingSystem(): string {
	const result = spawnSync("uname", ["-s", "-r", "-m"], { encoding: "utf8", timeout: 5_000 });
	if (result.error !== undefined || result.status !== 0 || result.stdout.trim().length === 0) {
		throw new Error(`could not capture host OS identity: ${result.error?.message ?? `exit ${result.status}`}`);
	}
	return result.stdout.trim();
}

function publishBundle(files: Readonly<Record<string, string>>): void {
	const artifactParent = path.dirname(ARTIFACT_DIRECTORY);
	const stageRoot = fs.mkdtempSync(path.join(artifactParent, ".s4-artifact-stage-"));
	const stagedArtifacts = path.join(stageRoot, "tests", "opfs-idb-spike", "artifacts");
	const backupDirectory = path.join(artifactParent, `.s4-artifact-backup-${crypto.randomUUID()}`);
	let movedExisting = false;
	let published = false;
	try {
		fs.mkdirSync(stagedArtifacts, { recursive: true });
		for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(stagedArtifacts, name), bytes);
		requirePhase2dDecisionConsumptionReady({
			rootDirectory: stageRoot,
			linkPath: "tests/opfs-idb-spike/artifacts/phase-2d-storage-substrate-decision-link-v1.json",
		});
		if (fs.existsSync(ARTIFACT_DIRECTORY)) {
			fs.renameSync(ARTIFACT_DIRECTORY, backupDirectory);
			movedExisting = true;
		}
		try {
			fs.renameSync(stagedArtifacts, ARTIFACT_DIRECTORY);
			published = true;
		} catch (error) {
			if (movedExisting && !fs.existsSync(ARTIFACT_DIRECTORY)) fs.renameSync(backupDirectory, ARTIFACT_DIRECTORY);
			throw error;
		}
	} finally {
		fs.rmSync(stageRoot, { recursive: true, force: true });
		if (published && movedExisting) fs.rmSync(backupDirectory, { recursive: true, force: true });
	}
}

async function seedAndReopen(page: Page, name: OriginName): Promise<PayloadObservation> {
	await page.goto(ORIGINS[name]);
	await page.waitForFunction(() => "phase2SpikeS3" in globalThis);
	await page.evaluate(
		async ({ payload }) =>
			(globalThis as unknown as { readonly phase2SpikeS3: S3Harness }).phase2SpikeS3.seedExactPayload(payload),
		{ payload: PAYLOADS[name] }
	);
	await page.reload();
	await page.waitForFunction(() => "phase2SpikeS3" in globalThis);
	return readExactPayload(page, name);
}

async function readExactPayload(page: Page, name: OriginName): Promise<PayloadObservation> {
	return page.evaluate(
		async ({ payload }) =>
			(globalThis as unknown as { readonly phase2SpikeS3: S3Harness }).phase2SpikeS3.readExactPayload(payload),
		{ payload: PAYLOADS[name] }
	);
}

test("writes a fresh, engine-bound private S4 evidence bundle", async ({ browser }) => {
	test.skip(process.env.S4_WRITE_ARTIFACTS !== "true", "set S4_WRITE_ARTIFACTS=true to write private S4 artifacts");
	expect(browser.version()).toBe("149.0.7827.55");

	const context = await browser.newContext();
	try {
		const s1Page = await context.newPage();
		await s1Page.goto("http://127.0.0.1:43871/");
		await s1Page.waitForFunction(() => "runStrictIdbCapabilityScenario" in globalThis);
		const s1 = await s1Page.evaluate(async () =>
			(
				globalThis as unknown as {
					runStrictIdbCapabilityScenario(): Promise<S1Result>;
				}
			).runStrictIdbCapabilityScenario()
		);
		expect(s1).toMatchObject({
			kind: "committed",
			liveReportedDurability: "strict",
			observedDurability: "strict",
			reopened: { count: 1, value: "phase-2-spike-s1-exact-sentinel-v1" },
			evidenceJson: EXPECTED_S1_EVIDENCE_JSON,
			evidenceBytes: Array.from(new TextEncoder().encode(EXPECTED_S1_EVIDENCE_JSON)),
		});
		if (s1.evidenceJson === null) throw new Error("unforced S1 run did not emit evidence");
		expect(s1.evidenceBytes).toEqual(Array.from(new TextEncoder().encode(s1.evidenceJson)));
		parseSpikeEvidence(JSON.parse(s1.evidenceJson) as unknown);
		const strictIdb = s1.evidenceJson;

		const s2Page = await context.newPage();
		await s2Page.goto("http://127.0.0.1:43872/");
		const userAgent = await s2Page.evaluate(() => navigator.userAgent);
		const runId = "phase-2-spike-s4-artifact-live-v1";
		const s2 = await s2Page.evaluate(
			async (request) =>
				(
					globalThis as unknown as {
						runSubstrateBenchmark(value: {
							readonly runId: string;
							readonly corruptOracle: boolean;
						}): Promise<S2Result>;
					}
				).runSubstrateBenchmark(request),
			{ runId, corruptOracle: false }
		);
		expect(s2.oraclePass).toBe(true);
		expect(s2.diagnostics).toMatchObject({
			commandCountPerArm: 12,
			armOraclePass: { opfs: true, idbStrict: true },
			idbObservedDurability: "strict",
		});
		expect(s2.diagnostics.opfsFlushedBytes).toBeGreaterThan(0);
		const measurementEvidence = parseSpikeEvidence(s2.evidence);
		expect(measurementEvidence.artifactKind).toBe("substrate-measurement");
		if (measurementEvidence.artifactKind !== "substrate-measurement")
			throw new Error("S2 did not emit measurement evidence");
		expect(measurementEvidence.engineBuild).toBe(userAgent);
		expect(measurementEvidence.opsExecuted).toBe(24);
		expect(measurementEvidence.timingPassingThreshold).toBe("none");
		const measurement = JSON.stringify(measurementEvidence);

		const pages = {
			target: await context.newPage(),
			noClear: await context.newPage(),
			secondOrigin: await context.newPage(),
		};
		for (const name of Object.keys(pages) as OriginName[]) {
			expect(await seedAndReopen(pages[name], name)).toEqual(exactPresent());
		}
		const cdp = await context.newCDPSession(pages.target);
		await cdp.send("Storage.clearDataForOrigin", { origin: ORIGINS.target, storageTypes: "all" });
		await pages.target.reload();
		await pages.target.waitForFunction(() => "phase2SpikeS3" in globalThis);
		const after = {
			target: await readExactPayload(pages.target, "target"),
			noClear: await readExactPayload(pages.noClear, "noClear"),
			secondOrigin: await readExactPayload(pages.secondOrigin, "secondOrigin"),
		};
		expect(after.target).toEqual({
			opfs: { present: false, exactBytes: false },
			idb: { present: false, exactValue: false },
		});
		expect(after.noClear).toEqual(exactPresent());
		expect(after.secondOrigin).toEqual(exactPresent());
		const clearControl = JSON.stringify(parseSpikeEvidence(JSON.parse(EXPECTED_S3_EVIDENCE_JSON) as unknown));

		const engine = {
			browserName: "chromium",
			browserVersion: browser.version(),
			executableRevision: executableBuildId(),
			userAgent,
			operatingSystem: operatingSystem(),
			playwrightVersion: PLAYWRIGHT_VERSION,
		};
		const artifactDigests = {
			strictIdb: sha256(strictIdb),
			measurement: sha256(measurement),
			clearControl: sha256(clearControl),
		};
		const consequences = [
			"workload:generation/blob/pointer-swap-only",
			"vote-slot-parity:unmeasured-and-non-citable;owners:2d,5c;revisit:after-2d-and-5c-executable-vote-transaction",
			"timing-basis:correctness-only;asymmetric-unwarmed-opfs-first-raw-values-not-scored",
			"selection:idb-strict;basis:live strict capability and the 2d/5c strict-transaction race boundary;raw S2 latency not scored",
			`artifact-sha256:strict-idb-capability=${artifactDigests.strictIdb}`,
			`artifact-sha256:substrate-measurement=${artifactDigests.measurement}`,
			`artifact-sha256:bucket-clear-control=${artifactDigests.clearControl}`,
		];
		const decision = JSON.stringify({
			schemaVersion: 1,
			artifactKind: "storage-substrate-decision",
			chosen: "idb-strict",
			measurementArtifactDigests: [artifactDigests.measurement],
			sameDefaultBucket: "normative",
			sameEvictionBehavior: "unmeasured",
			realPressureEviction: {
				status: "unautomatable",
				scope: "ordinary-web/playwright",
				engineBuilds: [userAgent],
				basis: ["WHATWG Storage has no deterministic pressure-eviction trigger"],
				reason: "Ordinary-web and Playwright controls cannot invoke the user agent storage-pressure selection policy.",
				revisitTrigger: "deterministic-supported-trigger",
				consumer: "phase-5-signer-profile-eviction-matrix-and-pre-release-real-device-blocker",
			},
			clearEvidenceScoringWeight: "none",
			custodyFateSharingSurface:
				"The selected vote-log endpoint and non-extractable CryptoKey endpoint remain a Phase-5 fate-sharing input, not eviction evidence.",
			crashAtomicityMechanism:
				"The benchmark proves no crash atomicity; 2d/5c retain the strict transaction boundary and substrate-specific recovery work.",
			implementationRisk:
				"Single-engine, single-writer evidence leaves migration, multi-tab, custody, crash and real-pressure risks open.",
			consequences,
		});
		const decisionDigest = sha256(decision);
		const markdown =
			[
				"# Storage substrate decision v1",
				"",
				"Chosen: idb-strict",
				"",
				`Decision JSON SHA-256: ${decisionDigest}`,
				`Strict IDB SHA-256: ${artifactDigests.strictIdb}`,
				`Measurement SHA-256: ${artifactDigests.measurement}`,
				`Clear control SHA-256: ${artifactDigests.clearControl}`,
				"",
				"The decision is correctness-only for the generation/blob/pointer-swap workload. Raw asymmetric S2 timing is not scored.",
				"IDB strict is selected for the measured scope because its live strict capability and the 2d/5c strict transaction boundary are directly compatible; this does not establish crash, multi-tab, custody, pressure-eviction, vote-parity, anti-equivocation, or golden-path behavior.",
			].join("\n") + "\n";
		const citationBase = { freshSuccessfulRun: true, engine };
		const link = JSON.stringify({
			schemaVersion: 1,
			gate: "phase-2d-storage-substrate-decision-consumption",
			status: "preimplementation-required-before-2d",
			decision: {
				jsonPath: "tests/opfs-idb-spike/artifacts/storage-substrate-decision-v1.json",
				jsonSha256: decisionDigest,
				markdownPath: "tests/opfs-idb-spike/artifacts/storage-substrate-decision-v1.md",
				markdownSha256: sha256(markdown),
			},
			artifacts: {
				strictIdb: {
					...citationBase,
					path: "tests/opfs-idb-spike/artifacts/strict-idb-capability.json",
					sha256: artifactDigests.strictIdb,
					testOnlyForcedObservedDurability: "absent",
					oracleStatus: "not-applicable",
					timingBasis: "not-applicable",
					scoringWeight: "decision-input",
				},
				measurement: {
					...citationBase,
					path: "tests/opfs-idb-spike/artifacts/substrate-measurement.json",
					sha256: artifactDigests.measurement,
					testOnlyForcedObservedDurability: "not-applicable",
					oracleStatus: "pass",
					timingBasis: "correctness-only",
					scoringWeight: "decision-input",
				},
				clearControl: {
					...citationBase,
					path: "tests/opfs-idb-spike/artifacts/bucket-clear-control.json",
					sha256: artifactDigests.clearControl,
					testOnlyForcedObservedDurability: "not-applicable",
					oracleStatus: "not-applicable",
					timingBasis: "not-applicable",
					scoringWeight: "none",
				},
			},
		});

		publishBundle({
			"strict-idb-capability.json": strictIdb,
			"substrate-measurement.json": measurement,
			"bucket-clear-control.json": clearControl,
			"storage-substrate-decision-v1.json": decision,
			"storage-substrate-decision-v1.md": markdown,
			"phase-2d-storage-substrate-decision-link-v1.json": link,
		});
	} finally {
		await context.close();
	}
});
