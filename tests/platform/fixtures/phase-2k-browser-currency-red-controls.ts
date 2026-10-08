/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- compact RED control builders are self-typed */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PHASE_2K_POLICY = Object.freeze({
	blockingMajorDelta: 2,
	freshnessMonths: 1,
	jsonSourceMaxAgeDays: 14,
	safariReviewMaxAgeDays: 180,
} as const);

export const PHASE_2K_GIT_SHA = "a".repeat(40);
export const PHASE_2K_UUID = "00000000-0000-4000-8000-000000000000";
export const PHASE_2K_RUN_ID = `phase-2k/${PHASE_2K_GIT_SHA}/${PHASE_2K_UUID}`;
export const PHASE_2K_CHANNEL_IDS = Object.freeze(["chromium", "firefox", "webkit", "safari-macos"] as const);
export const PHASE_2K_COVERAGE_IDS = Object.freeze([
	"chrome-current",
	"chrome-previous",
	"firefox-current",
	"firefox-previous",
	"safari-macos-current",
	"safari-macos-previous",
] as const);
export const PHASE_2K_ARTIFACT_KEYS = Object.freeze([
	"artifactKind",
	"channels",
	"coverageObligations",
	"electron",
	"evaluatedAtUtc",
	"gitSha",
	"invalidRowIds",
	"missingChannelIds",
	"playwright",
	"policy",
	"requiredChannelIds",
	"runId",
	"schemaVersion",
	"sources",
	"verdict",
	"warnings",
] as const);

export const PHASE_2K_RAW_SOURCES = Object.freeze({
	"chrome-for-testing-last-known-good-versions.json": `${JSON.stringify({ channels: { Stable: { version: "151.0.7922.77" } } })}\n`,
	"mozilla-firefox-history-major-releases.json": `${JSON.stringify({ "152.0": "2026-07-21", "153.0": "2026-08-11", "154.0beta": "2026-08-11" })}\n`,
	"mozilla-firefox-versions.json": `${JSON.stringify({ FIREFOX_ESR: "140.0.4", LATEST_FIREFOX_VERSION: "153.0.4" })}\n`,
	"npm-playwright-test-dist-tags.json": `${JSON.stringify({ latest: "1.62.1", next: "1.63.0-beta-1" })}\n`,
	"playwright-browsers.json": `${JSON.stringify({
		browsers: [
			{ name: "chromium", browserVersion: "151.0.7922.34", installByDefault: true },
			{ name: "firefox", browserVersion: "153.0", installByDefault: true },
			{ name: "webkit", browserVersion: "26.5", installByDefault: true },
		],
	})}\n`,
} as const);

type ChannelId = (typeof PHASE_2K_CHANNEL_IDS)[number];
type CoverageId = (typeof PHASE_2K_COVERAGE_IDS)[number];

export interface SourceSnapshotRow {
	readonly assertedValue: string;
	readonly fetchedAtUtc: string;
	readonly file: keyof typeof PHASE_2K_RAW_SOURCES;
	readonly pointer: string;
	readonly sha256: string;
	readonly url: string;
}

export interface Phase2kArtifact {
	readonly artifactKind: "ts-drp/browser-matrix-currency/v1";
	readonly channels: readonly Record<string, unknown>[];
	readonly coverageObligations: readonly Record<string, unknown>[];
	readonly electron: Record<string, unknown>;
	readonly evaluatedAtUtc: string;
	readonly gitSha: string;
	readonly invalidRowIds: readonly string[];
	readonly missingChannelIds: readonly ChannelId[];
	readonly playwright: Record<string, unknown>;
	readonly policy: typeof PHASE_2K_POLICY;
	readonly requiredChannelIds: readonly ChannelId[];
	readonly runId: string;
	readonly schemaVersion: 1;
	readonly sources: readonly SourceSnapshotRow[];
	readonly verdict: "fail" | "pass" | "warn";
	readonly warnings: readonly string[];
}

export interface Phase2kOwner {
	readonly POLICY: typeof PHASE_2K_POLICY;
	addUtcCalendarMonths(timestamp: string, months: number): string;
	auditPlaywrightGraph(input: unknown): { errors: readonly string[]; versions: Record<string, readonly string[]> };
	auditReleaseWorkflow(input: unknown): { errors: readonly string[]; publicationJobs: readonly string[] };
	auditWorkflow(input: unknown): { errors: readonly string[] };
	compareDottedVersions(channelId: ChannelId | "playwright", left: string, right: string): number;
	createArtifactPublication(input: { gitSha: string; outputBase: string; uuid: string }): {
		readonly aggregatePath: string;
		finalize(artifact: unknown): Phase2kArtifact;
	};
	evaluateBrowserCurrency(input: unknown): Phase2kArtifact;
	evaluateElectron(input: unknown): Record<string, unknown>;
	evaluateReleaseCandidate(input: unknown): { boundary: string; exitCode: number; reasons: readonly string[] };
	parseDottedVersion(channelId: ChannelId | "playwright", value: string): readonly number[] | null;
	planAtomicRefresh(input: unknown): {
		changes: readonly Record<string, unknown>[];
		errors: readonly string[];
		status: string;
	};
	validateArtifact(
		value: unknown,
		current: { gitSha: string; runId: string }
	): { artifact: Phase2kArtifact | null; errors: readonly string[] };
	validateRuntimeIdentity(input: unknown): { errors: readonly string[] };
	validateSourceCustody(input: unknown): { errors: readonly string[]; sources: readonly SourceSnapshotRow[] };
}

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const ownerPath = path.join(repositoryRoot, "scripts/phase-2k-browser-currency.mjs");

const fallback: Phase2kOwner = {
	POLICY: Object.freeze({
		blockingMajorDelta: 0,
		freshnessMonths: 0,
		jsonSourceMaxAgeDays: 0,
		safariReviewMaxAgeDays: 0,
	}) as unknown as typeof PHASE_2K_POLICY,
	addUtcCalendarMonths: (timestamp) => timestamp,
	auditPlaywrightGraph: () => ({ errors: ["phase-2k dependency owner absent"], versions: {} }),
	auditReleaseWorkflow: () => ({ errors: ["phase-2k release-DAG owner absent"], publicationJobs: [] }),
	auditWorkflow: () => ({ errors: ["phase-2k workflow owner absent"] }),
	compareDottedVersions: () => 0,
	createArtifactPublication: ({ outputBase }) => ({
		aggregatePath: path.join(outputBase, "browser-matrix-currency.json"),
		finalize: (): never => {
			throw new TypeError("phase-2k create-only publication owner absent");
		},
	}),
	evaluateBrowserCurrency: () => emptyArtifact(),
	evaluateElectron: () => ({ status: "unknown" }),
	evaluateReleaseCandidate: () => ({ boundary: "unknown", exitCode: 1, reasons: ["phase-2k release owner absent"] }),
	parseDottedVersion: () => null,
	planAtomicRefresh: () => ({ changes: [], errors: ["phase-2k refresh owner absent"], status: "failed" }),
	validateArtifact: () => ({ artifact: null, errors: ["phase-2k artifact owner absent"] }),
	validateRuntimeIdentity: () => ({ errors: ["phase-2k launch identity owner absent"] }),
	validateSourceCustody: () => ({ errors: ["phase-2k custody owner absent"], sources: [] }),
};

function emptyArtifact(): Phase2kArtifact {
	return {
		artifactKind: "ts-drp/browser-matrix-currency/v1",
		channels: [],
		coverageObligations: [],
		electron: {},
		evaluatedAtUtc: "1970-01-01T00:00:00.000Z",
		gitSha: PHASE_2K_GIT_SHA,
		invalidRowIds: [],
		missingChannelIds: [...PHASE_2K_CHANNEL_IDS],
		playwright: {},
		policy: PHASE_2K_POLICY,
		requiredChannelIds: PHASE_2K_CHANNEL_IDS,
		runId: PHASE_2K_RUN_ID,
		schemaVersion: 1,
		sources: [],
		verdict: "fail",
		warnings: [],
	};
}

/** Loads the future owner or an assertion-causal RED scaffold. */
export async function loadPhase2kOwner(): Promise<Phase2kOwner> {
	if (!fs.existsSync(ownerPath)) return fallback;
	return (await import(/* @vite-ignore */ pathToFileURL(ownerPath).href)) as Phase2kOwner;
}

/** Builds a recoverable five-source snapshot over the exact control bytes. */
export function sourceSnapshot(fetchedAtUtc = "2026-08-11T12:00:00.000Z"): readonly SourceSnapshotRow[] {
	const definitions = {
		"chrome-for-testing-last-known-good-versions.json": {
			assertedValue: "151.0.7922.77",
			pointer: "/channels/Stable/version",
			url: "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json",
		},
		"mozilla-firefox-history-major-releases.json": {
			assertedValue: "152.0",
			pointer: "/second-highest-normalized-stable",
			url: "https://product-details.mozilla.org/1.0/firefox_history_major_releases.json",
		},
		"mozilla-firefox-versions.json": {
			assertedValue: "153.0.4",
			pointer: "/LATEST_FIREFOX_VERSION",
			url: "https://product-details.mozilla.org/1.0/firefox_versions.json",
		},
		"npm-playwright-test-dist-tags.json": {
			assertedValue: "1.62.1",
			pointer: "/latest",
			url: "https://registry.npmjs.org/-/package/@playwright/test/dist-tags",
		},
		"playwright-browsers.json": {
			assertedValue: '{"chromium":"151.0.7922.34","firefox":"153.0","webkit":"26.5"}',
			pointer: "/browsers[installByDefault=true,name=chromium|firefox|webkit]/browserVersion",
			url: "https://raw.githubusercontent.com/microsoft/playwright/v1.62.1/packages/playwright-core/browsers.json",
		},
	} as const;
	return Object.entries(definitions).map(([file, definition]) => ({
		...definition,
		fetchedAtUtc,
		file: file as keyof typeof PHASE_2K_RAW_SOURCES,
		sha256: createHash("sha256")
			.update(PHASE_2K_RAW_SOURCES[file as keyof typeof PHASE_2K_RAW_SOURCES])
			.digest("hex"),
	}));
}

/** Returns one bounded stale-but-honest evaluator input. */
export function currencyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		coverageEvidence: [],
		electron: {
			manifest: {
				schemaVersion: 1,
				shippingTargets: [{ id: "electron-desktop", runtime: "electron", state: "inactive", versions: [] }],
			},
			receipts: [],
		},
		firstObservedBehindAtUtc: { chromium: "2026-07-11T12:00:00.000Z", firefox: "2026-07-11T12:00:00.000Z" },
		gitSha: PHASE_2K_GIT_SHA,
		launches: [
			{ browserVersion: "149.0.7827.55", channelId: "chromium", engine: "chromium" },
			{ browserVersion: "151.0", channelId: "firefox", engine: "firefox" },
			{ browserVersion: "26.5", channelId: "webkit", engine: "webkit" },
		],
		nowUtc: "2026-08-11T12:00:00.001Z",
		playwright: {
			browsers: { chromium: "149.0.7827.55", firefox: "151.0", webkit: "26.5" },
			newestStableBrowsers: { chromium: "151.0.7922.34", firefox: "153.0", webkit: "26.5" },
			newestStableVersion: "1.62.1",
			version: "1.61.1",
		},
		runId: PHASE_2K_RUN_ID,
		safariReview: {
			currentVersion: "26.6",
			indexUrl: "https://developer.apple.com/documentation/safari-release-notes",
			observedAtUtc: "2026-08-01T00:00:00.000Z",
			permanentVersionUrl: "https://developer.apple.com/documentation/safari-release-notes/safari-26_6-release-notes",
			previousVersion: "26.5",
		},
		snapshot: sourceSnapshot(),
		sourceBytes: PHASE_2K_RAW_SOURCES,
		stableChannels: { chromium: "151.0.7922.77", firefox: "153.0.4" },
		...overrides,
	};
}

/** Selects one required channel row for readable assertions. */
export function channel(artifact: Phase2kArtifact, channelId: ChannelId): Record<string, unknown> {
	return artifact.channels.find((row) => row.channelId === channelId) ?? {};
}

/** Selects one required physical-coverage obligation for readable assertions. */
export function coverage(artifact: Phase2kArtifact, obligationId: CoverageId): Record<string, unknown> {
	return artifact.coverageObligations.find((row) => row.obligationId === obligationId) ?? {};
}
