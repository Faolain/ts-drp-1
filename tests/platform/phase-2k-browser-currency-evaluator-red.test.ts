import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	channel,
	coverage,
	currencyInput,
	loadPhase2kOwner,
	PHASE_2K_CHANNEL_IDS,
	PHASE_2K_COVERAGE_IDS,
	PHASE_2K_POLICY,
	PHASE_2K_RAW_SOURCES,
	sourceSnapshot,
} from "./fixtures/phase-2k-browser-currency-red-controls.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("Phase 2k pure browser-currency evaluator RED", () => {
	it("freezes the exact four-value policy", async () => {
		const owner = await loadPhase2kOwner();
		expect(owner.POLICY).toEqual(PHASE_2K_POLICY);
		expect(Object.keys(owner.POLICY).sort()).toEqual(Object.keys(PHASE_2K_POLICY).sort());
	});

	it("uses UTC calendar-month clamping and preserves the exact boundary millisecond", async () => {
		const owner = await loadPhase2kOwner();
		for (const [input, expected] of [
			["2023-01-31T23:45:12.345Z", "2023-02-28T23:45:12.345Z"],
			["2024-01-31T23:45:12.345Z", "2024-02-29T23:45:12.345Z"],
			["2024-02-29T23:45:12.345Z", "2024-03-29T23:45:12.345Z"],
			["2025-12-31T23:45:12.345Z", "2026-01-31T23:45:12.345Z"],
		] as const) {
			expect(owner.addUtcCalendarMonths(input, 1), input).toBe(expected);
		}

		const atBoundary = owner.evaluateBrowserCurrency(currencyInput({ nowUtc: "2026-08-11T12:00:00.000Z" }));
		const afterBoundary = owner.evaluateBrowserCurrency(currencyInput({ nowUtc: "2026-08-11T12:00:00.001Z" }));
		expect(atBoundary.warnings).not.toContain("chromium:continuous-month-behind");
		expect(afterBoundary.warnings).toContain("chromium:continuous-month-behind");
	});

	it("warns only after the exact 180-day Safari review boundary", async () => {
		const owner = await loadPhase2kOwner();
		const safariReview = {
			currentVersion: "26.6",
			indexUrl: "https://developer.apple.com/documentation/safari-release-notes",
			observedAtUtc: "2026-02-12T12:00:00.000Z",
			permanentVersionUrl: "https://developer.apple.com/documentation/safari-release-notes/safari-26_6-release-notes",
			previousVersion: "26.5",
		};
		const atBoundary = owner.evaluateBrowserCurrency(
			currencyInput({ nowUtc: "2026-08-11T12:00:00.000Z", safariReview })
		);
		const afterBoundary = owner.evaluateBrowserCurrency(
			currencyInput({ nowUtc: "2026-08-11T12:00:00.001Z", safariReview })
		);
		expect(atBoundary.warnings).not.toContain("safari-macos:review-older-than-180-days");
		expect(afterBoundary.warnings).toContain("safari-macos:review-older-than-180-days");
	});

	it("preserves Apple train discontinuities instead of deriving a previous Safari version", async () => {
		const owner = await loadPhase2kOwner();
		const artifact = owner.evaluateBrowserCurrency(
			currencyInput({
				safariReview: {
					currentVersion: "26.0",
					indexUrl: "https://developer.apple.com/documentation/safari-release-notes",
					observedAtUtc: "2026-08-01T00:00:00.000Z",
					permanentVersionUrl: "https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes",
					previousVersion: "18",
				},
			})
		);
		expect(channel(artifact, "safari-macos")).toMatchObject({
			currentVersion: "26.0",
			previousVersion: "18",
			previousVersionSource: "apple-release-notes-index-human-reviewed",
		});
		expect(channel(artifact, "safari-macos")).not.toMatchObject({ previousVersion: "25" });
	});

	it("parses only anchored dotted integers and compares components as integers", async () => {
		const owner = await loadPhase2kOwner();
		for (const [channelId, value, expected] of [
			["chromium", "151.0.7922.77", [151, 0, 7922, 77]],
			["firefox", "153.0.4", [153, 0, 4]],
			["webkit", "26.5", [26, 5]],
			["playwright", "1.62.1", [1, 62, 1]],
		] as const) {
			expect(owner.parseDottedVersion(channelId, value), `${channelId}:${value}`).toEqual(expected);
		}
		for (const value of ["151", " 151.0", "151.0 ", "+151.0", "151.0x", "151..0", "151.0e2"]) {
			expect(owner.parseDottedVersion("chromium", value), value).toBeNull();
		}
		expect(owner.compareDottedVersions("chromium", "9.10.0", "10.0.0")).toBeLessThan(0);
		expect(owner.compareDottedVersions("firefox", "153.0.10", "153.0.2")).toBeGreaterThan(0);
		expect(owner.compareDottedVersions("playwright", "1.62.1", "1.62.1")).toBe(0);
	});

	it("re-derives every raw hash, pointer and asserted value and enforces the fourteen-day boundary", async () => {
		const owner = await loadPhase2kOwner();
		const snapshot = sourceSnapshot("2026-07-28T12:00:00.000Z");
		const valid = { nowUtc: "2026-08-11T12:00:00.000Z", rawSources: PHASE_2K_RAW_SOURCES, snapshot };
		expect(owner.validateSourceCustody(valid)).toEqual({ errors: [], sources: snapshot });

		const chromeFile = "chrome-for-testing-last-known-good-versions.json";
		const chrome = snapshot.find(({ file }) => file === chromeFile);
		expect(chrome).toBeDefined();
		const mutants = [
			{ ...valid, nowUtc: "2026-08-11T12:00:00.001Z" },
			{ ...valid, rawSources: { ...PHASE_2K_RAW_SOURCES, [chromeFile]: "{}\n" } },
			{
				...valid,
				rawSources: Object.fromEntries(Object.entries(PHASE_2K_RAW_SOURCES).filter(([file]) => file !== chromeFile)),
			},
			{
				...valid,
				snapshot: snapshot.map((row) =>
					row.file === chromeFile ? { ...row, pointer: "/channels/Beta/version" } : row
				),
			},
			{
				...valid,
				snapshot: snapshot.map((row) => (row.file === chromeFile ? { ...row, assertedValue: "150.0.0.0" } : row)),
			},
			{
				...valid,
				snapshot: snapshot.map((row) =>
					row.file === chromeFile ? { ...row, sha256: createHash("sha256").update("other").digest("hex") } : row
				),
			},
		];
		for (const mutant of mutants) expect(owner.validateSourceCustody(mutant).errors.length).toBeGreaterThan(0);
	});

	it("authenticates the checked root snapshot against all five recoverable source files", async () => {
		const owner = await loadPhase2kOwner();
		const snapshotPath = path.join(repositoryRoot, "browser-currency-sources.json");
		const snapshot = fs.existsSync(snapshotPath) ? (JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as unknown) : {};
		const rawSources = Object.fromEntries(
			Object.keys(PHASE_2K_RAW_SOURCES).flatMap((file) => {
				const sourcePath = path.join(repositoryRoot, "tests/fixtures/phase-2k/sources", file);
				return fs.existsSync(sourcePath) ? [[file, fs.readFileSync(sourcePath, "utf8")]] : [];
			})
		);
		const observed = owner.validateSourceCustody({ rawSources, snapshot });
		expect(observed.errors).toEqual([]);
		expect(observed.sources).toHaveLength(5);
	});

	it("derives asymmetric channel truth without turning Playwright WebKit into Safari", async () => {
		const owner = await loadPhase2kOwner();
		const artifact = owner.evaluateBrowserCurrency(currencyInput());
		expect(artifact.requiredChannelIds).toEqual(PHASE_2K_CHANNEL_IDS);
		expect(artifact.channels.map((row) => row.channelId)).toEqual(PHASE_2K_CHANNEL_IDS);
		expect(channel(artifact, "chromium")).toMatchObject({
			majorDelta: 2,
			previousStableReason: "no-official-machine-readable-source",
			previousStableVersion: null,
			releaseBlocking: true,
		});
		expect(channel(artifact, "firefox")).toMatchObject({
			branded: false,
			majorDelta: 2,
			previousStableVersion: "152.0",
			releaseBlocking: true,
			stableVersion: "153.0.4",
		});
		expect(channel(artifact, "webkit")).toMatchObject({
			branded: false,
			coverageStatus: "engine-only",
			safariClaim: false,
			stableVersion: null,
		});
		expect(channel(artifact, "webkit")).not.toHaveProperty("safariVersion");
	});

	it("blocks an exact two-major delta but leaves the adjacent one-major control nonblocking", async () => {
		const owner = await loadPhase2kOwner();
		const deltaTwo = owner.evaluateBrowserCurrency(currencyInput());
		const deltaOne = owner.evaluateBrowserCurrency(
			currencyInput({ stableChannels: { chromium: "150.0.1.1", firefox: "152.0.4" } })
		);
		expect(channel(deltaTwo, "chromium")).toMatchObject({ majorDelta: 2, releaseBlocking: true });
		expect(channel(deltaTwo, "firefox")).toMatchObject({ majorDelta: 2, releaseBlocking: true });
		expect(channel(deltaOne, "chromium")).toMatchObject({ majorDelta: 1, releaseBlocking: false });
		expect(channel(deltaOne, "firefox")).toMatchObject({ majorDelta: 1, releaseBlocking: false });
	});

	it("keeps all six physical AHE obligations explicitly unmet under pre-release ownership", async () => {
		const owner = await loadPhase2kOwner();
		const artifact = owner.evaluateBrowserCurrency(currencyInput());
		expect(artifact.coverageObligations.map((row) => row.obligationId)).toEqual(PHASE_2K_COVERAGE_IDS);
		for (const obligationId of PHASE_2K_COVERAGE_IDS) {
			expect(coverage(artifact, obligationId)).toEqual({
				evidence: null,
				obligationId,
				owner: "pre-release-tier",
				status: "unmet",
			});
		}
		expect(artifact.warnings).toEqual([...artifact.warnings].sort());
		expect(artifact.verdict).toBe("warn");
	});

	it("records a newest-supported tooling ceiling as not-covered and never as coverage", async () => {
		const owner = await loadPhase2kOwner();
		const artifact = owner.evaluateBrowserCurrency(
			currencyInput({
				firstObservedBehindAtUtc: {},
				launches: [
					{ browserVersion: "151.0.7922.34", channelId: "chromium", engine: "chromium" },
					{ browserVersion: "153.0", channelId: "firefox", engine: "firefox" },
					{ browserVersion: "26.5", channelId: "webkit", engine: "webkit" },
				],
				playwright: {
					browsers: { chromium: "151.0.7922.34", firefox: "153.0", webkit: "26.5" },
					newestStableBrowsers: { chromium: "151.0.7922.34", firefox: "153.0", webkit: "26.5" },
					newestStableVersion: "1.62.1",
					version: "1.62.1",
				},
				stableChannels: { chromium: "153.0.1.1", firefox: "153.0.4" },
			})
		);
		expect(channel(artifact, "chromium")).toMatchObject({
			coverageReason: "tooling-ceiling",
			coverageStatus: "not-covered",
			releaseBlocking: false,
		});
		expect(coverage(artifact, "chrome-current")).toMatchObject({ status: "unmet" });
		expect(artifact.warnings).toContain("chromium:tooling-ceiling");
	});

	it("lets honest warnings report with exit zero but fails structural dishonesty before release initialization", async () => {
		const owner = await loadPhase2kOwner();
		const artifact = owner.evaluateBrowserCurrency(currencyInput());
		const honestReport = owner.evaluateReleaseCandidate({ artifact, mode: "report" });
		expect(honestReport).toMatchObject({ boundary: "report-complete", exitCode: 0 });
		const blockedRelease = owner.evaluateReleaseCandidate({ artifact, mode: "release" });
		expect(blockedRelease.exitCode).not.toBe(0);
		expect(blockedRelease.boundary).toBe("before-release-init");
		expect(blockedRelease.reasons).toEqual(expect.arrayContaining(["chromium:major-delta-2", "firefox:major-delta-2"]));
		const unknownStable = owner.evaluateReleaseCandidate({
			artifact: {
				...artifact,
				channels: artifact.channels.map((row) => (row.channelId === "firefox" ? { ...row, stableVersion: null } : row)),
			},
			mode: "release",
		});
		expect(unknownStable.exitCode).not.toBe(0);
		expect(unknownStable.reasons).toContain("firefox:stable-unknown");

		const falseCoverage = {
			...artifact,
			coverageObligations: artifact.coverageObligations.map((row, index) =>
				index === 0 ? { ...row, evidence: null, status: "met" } : row
			),
		};
		const dishonest = owner.evaluateReleaseCandidate({ artifact: falseCoverage, mode: "release" });
		expect(dishonest.exitCode).not.toBe(0);
		expect(dishonest.boundary).toBe("before-release-init");
		expect(dishonest.reasons).toContain("false-coverage-claim");
	});
});
