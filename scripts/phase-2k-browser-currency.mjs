/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc -- JavaScript policy owner */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const POLICY = Object.freeze({
	blockingMajorDelta: 2,
	freshnessMonths: 1,
	jsonSourceMaxAgeDays: 14,
	safariReviewMaxAgeDays: 180,
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANNEL_IDS = Object.freeze(["chromium", "firefox", "webkit", "safari-macos"]);
const COVERAGE_IDS = Object.freeze([
	"chrome-current",
	"chrome-previous",
	"firefox-current",
	"firefox-previous",
	"safari-macos-current",
	"safari-macos-previous",
]);
const ARTIFACT_KEYS = Object.freeze([
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
]);
export const SOURCE_AUTHORITIES = Object.freeze({
	"chrome-for-testing-last-known-good-versions.json": Object.freeze({
		pointer: "/channels/Stable/version",
		url: "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json",
	}),
	"mozilla-firefox-history-major-releases.json": Object.freeze({
		pointer: "/second-highest-normalized-stable",
		url: "https://product-details.mozilla.org/1.0/firefox_history_major_releases.json",
	}),
	"mozilla-firefox-versions.json": Object.freeze({
		pointer: "/LATEST_FIREFOX_VERSION",
		url: "https://product-details.mozilla.org/1.0/firefox_versions.json",
	}),
	"npm-playwright-test-dist-tags.json": Object.freeze({
		pointer: "/latest",
		url: "https://registry.npmjs.org/-/package/@playwright/test/dist-tags",
	}),
	"playwright-browsers.json": Object.freeze({
		pointer: "/browsers[installByDefault=true,name=chromium|firefox|webkit]/browserVersion",
		urlPrefix: "https://raw.githubusercontent.com/microsoft/playwright/v",
		urlSuffix: "/packages/playwright-core/browsers.json",
	}),
});
export const SOURCE_FILES = Object.freeze(Object.keys(SOURCE_AUTHORITIES));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys) {
	return isRecord(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function sameKeySet(value, keys) {
	return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonicalTimestamp(value) {
	if (typeof value !== "string") return null;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function sourceRows(snapshot) {
	if (Array.isArray(snapshot)) return snapshot;
	return isRecord(snapshot) && Array.isArray(snapshot.sources) ? snapshot.sources : [];
}

function sourceValue(file, parsed) {
	if (!isRecord(parsed)) return null;
	if (file === "chrome-for-testing-last-known-good-versions.json") {
		return isRecord(parsed.channels) && isRecord(parsed.channels.Stable) ? parsed.channels.Stable.version : null;
	}
	if (file === "mozilla-firefox-versions.json") return parsed.LATEST_FIREFOX_VERSION;
	if (file === "npm-playwright-test-dist-tags.json") return parsed.latest;
	if (file === "mozilla-firefox-history-major-releases.json") {
		const releases = Object.keys(parsed)
			.filter((version) => parseDottedVersion("firefox", version) !== null)
			.sort((left, right) => compareDottedVersions("firefox", right, left));
		return releases[1] ?? null;
	}
	if (file === "playwright-browsers.json" && Array.isArray(parsed.browsers)) {
		const selected = {};
		for (const engine of ["chromium", "firefox", "webkit"]) {
			const matches = parsed.browsers.filter(
				(row) => isRecord(row) && row.name === engine && row.installByDefault === true
			);
			if (matches.length !== 1 || typeof matches[0].browserVersion !== "string") return null;
			selected[engine] = matches[0].browserVersion;
		}
		return JSON.stringify(selected);
	}
	return null;
}

function sourceMap(rows) {
	return Object.fromEntries(rows.map((row) => [row.file, row.assertedValue]));
}

function sourceGrammarErrors(file, assertedValue) {
	if (file === "chrome-for-testing-last-known-good-versions.json")
		return parseDottedVersion("chromium", assertedValue) === null ? [`${file}:version-grammar`] : [];
	if (file === "mozilla-firefox-history-major-releases.json" || file === "mozilla-firefox-versions.json")
		return parseDottedVersion("firefox", assertedValue) === null ? [`${file}:version-grammar`] : [];
	if (file === "npm-playwright-test-dist-tags.json")
		return parseDottedVersion("playwright", assertedValue) === null ? [`${file}:version-grammar`] : [];
	if (file === "playwright-browsers.json") {
		try {
			const selected = JSON.parse(assertedValue);
			if (
				!exactKeys(selected, ["chromium", "firefox", "webkit"]) ||
				parseDottedVersion("chromium", selected.chromium) === null ||
				parseDottedVersion("firefox", selected.firefox) === null ||
				parseDottedVersion("webkit", selected.webkit) === null
			)
				return [`${file}:version-grammar`];
		} catch {
			return [`${file}:version-grammar`];
		}
	}
	return [];
}

export function parseDottedVersion(channelId, value) {
	if (typeof value !== "string") return null;
	const patterns = {
		"chromium": /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/u,
		"firefox": /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/u,
		"playwright": /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u,
		"safari-macos": /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/u,
		"webkit": /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u,
	};
	const pattern = patterns[channelId];
	if (pattern === undefined || !pattern.test(value)) return null;
	const components = value.split(".").map((component) => Number(component));
	return components.every(Number.isSafeInteger) ? components : null;
}

export function compareDottedVersions(channelId, left, right) {
	const parsedLeft = parseDottedVersion(channelId, left);
	const parsedRight = parseDottedVersion(channelId, right);
	if (parsedLeft === null || parsedRight === null) throw new TypeError(`invalid ${channelId} dotted version`);
	for (let index = 0; index < Math.max(parsedLeft.length, parsedRight.length); index += 1) {
		const comparison = (parsedLeft[index] ?? 0) - (parsedRight[index] ?? 0);
		if (comparison !== 0) return comparison < 0 ? -1 : 1;
	}
	return 0;
}

export function addUtcCalendarMonths(timestamp, months) {
	const milliseconds = canonicalTimestamp(timestamp);
	if (milliseconds === null || !Number.isSafeInteger(months)) throw new TypeError("invalid UTC calendar input");
	const input = new Date(milliseconds);
	const target = new Date(milliseconds);
	target.setUTCDate(1);
	target.setUTCMonth(target.getUTCMonth() + months);
	const lastDay = new Date(
		Date.UTC(
			target.getUTCFullYear(),
			target.getUTCMonth() + 1,
			0,
			input.getUTCHours(),
			input.getUTCMinutes(),
			input.getUTCSeconds(),
			input.getUTCMilliseconds()
		)
	).getUTCDate();
	target.setUTCDate(Math.min(input.getUTCDate(), lastDay));
	return target.toISOString();
}

export function validateSourceCustody(input) {
	const errors = [];
	if (!isRecord(input)) return { errors: ["source-custody:invalid-input"], sources: [] };
	const rows = sourceRows(input.snapshot);
	const rawSources = isRecord(input.rawSources) ? input.rawSources : {};
	if (input.nowUtc !== undefined && canonicalTimestamp(input.nowUtc) === null)
		errors.push("source-custody:invalid-now");
	if (rows.length !== SOURCE_FILES.length) errors.push("source-custody:wrong-row-count");
	if (Object.keys(rawSources).sort().join("\0") !== [...SOURCE_FILES].sort().join("\0"))
		errors.push("source-custody:wrong-file-set");
	const byFile = new Map();
	let totalBytes = 0;
	for (const row of rows) {
		if (!isRecord(row) || typeof row.file !== "string" || byFile.has(row.file)) {
			errors.push("source-custody:duplicate-or-invalid-row");
			continue;
		}
		byFile.set(row.file, row);
	}
	const parsedByFile = {};
	for (const file of SOURCE_FILES) {
		const definition = SOURCE_AUTHORITIES[file];
		const row = byFile.get(file);
		const bytes = rawSources[file];
		if (!isRecord(row) || typeof bytes !== "string") {
			errors.push(`${file}:missing-bytes-or-row`);
			continue;
		}
		if (!sameKeySet(row, ["assertedValue", "fetchedAtUtc", "file", "pointer", "sha256", "url"]))
			errors.push(`${file}:row-schema`);
		const byteLength = Buffer.byteLength(bytes, "utf8");
		totalBytes += byteLength;
		if (Buffer.from(bytes, "utf8").toString("utf8") !== bytes) errors.push(`${file}:invalid-utf8`);
		if (row.sha256 !== createHash("sha256").update(bytes).digest("hex")) errors.push(`${file}:sha256-mismatch`);
		if (row.pointer !== definition.pointer) errors.push(`${file}:pointer-mismatch`);
		if (file !== "playwright-browsers.json" && row.url !== definition.url) errors.push(`${file}:url-mismatch`);
		const fetched = canonicalTimestamp(row.fetchedAtUtc);
		if (fetched === null) errors.push(`${file}:invalid-fetched-at`);
		const now = canonicalTimestamp(input.nowUtc);
		if (now !== null && fetched !== null && now - fetched > POLICY.jsonSourceMaxAgeDays * DAY_MILLISECONDS)
			errors.push(`${file}:source-older-than-14-days`);
		try {
			parsedByFile[file] = JSON.parse(bytes);
		} catch {
			errors.push(`${file}:invalid-json`);
			continue;
		}
		const assertedValue = sourceValue(file, parsedByFile[file]);
		if (assertedValue === null || row.assertedValue !== assertedValue) errors.push(`${file}:asserted-value-mismatch`);
		else errors.push(...sourceGrammarErrors(file, assertedValue));
	}
	if (totalBytes >= 10 * 1024) errors.push("source-custody:size-limit");
	const npmRow = byFile.get("npm-playwright-test-dist-tags.json");
	const browsersRow = byFile.get("playwright-browsers.json");
	if (isRecord(npmRow)) {
		const version = npmRow.assertedValue;
		if (parseDottedVersion("playwright", version) === null || !version.startsWith("1."))
			errors.push("playwright:stable-must-be-1.x");
		const expectedUrl = `${SOURCE_AUTHORITIES["playwright-browsers.json"].urlPrefix}${version}${SOURCE_AUTHORITIES["playwright-browsers.json"].urlSuffix}`;
		if (!isRecord(browsersRow) || browsersRow.url !== expectedUrl)
			errors.push("playwright-browsers.json:tag-url-mismatch");
	}
	return { errors: [...new Set(errors)].sort(), sources: rows };
}

function majorDelta(channelId, stableVersion, launchedVersion) {
	const stable = parseDottedVersion(channelId, stableVersion);
	const launched = parseDottedVersion(channelId, launchedVersion);
	return stable === null || launched === null ? null : Math.max(0, stable[0] - launched[0]);
}

function launchVersion(input, channelId) {
	return Array.isArray(input.launches)
		? (input.launches.find((row) => isRecord(row) && row.channelId === channelId)?.browserVersion ?? null)
		: null;
}

function continuousBehindWarning(input, channelId, observedMajor, stableMajor, nowUtc) {
	if (observedMajor >= stableMajor || !isRecord(input.firstObservedBehindAtUtc)) return false;
	const first = input.firstObservedBehindAtUtc[channelId];
	if (typeof first !== "string") return false;
	const deadline = canonicalTimestamp(addUtcCalendarMonths(first, POLICY.freshnessMonths));
	const now = canonicalTimestamp(nowUtc);
	return deadline !== null && now !== null && now > deadline;
}

export function validateRuntimeIdentity(input) {
	const errors = [];
	if (!isRecord(input) || input.manifestOwner !== "resolved-root-playwright-core" || !isRecord(input.manifest))
		return { errors: ["runtime-identity:manifest-owner"] };
	if (!Array.isArray(input.launches) || input.launches.length !== 3) errors.push("runtime-identity:launch-count");
	for (const engine of ["chromium", "firefox", "webkit"]) {
		const rows = Array.isArray(input.launches)
			? input.launches.filter((row) => isRecord(row) && row.engine === engine)
			: [];
		if (rows.length !== 1 || rows[0].browserVersion !== input.manifest[engine])
			errors.push(`runtime-identity:${engine}`);
	}
	return { errors: errors.sort() };
}

export function evaluateElectron(input) {
	if (!isRecord(input) || !isRecord(input.shippingManifest)) throw new TypeError("invalid shipping manifest");
	const manifest = input.shippingManifest;
	if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.shippingTargets))
		throw new TypeError("invalid shipping manifest");
	const targets = manifest.shippingTargets.filter(
		(target) => isRecord(target) && target.id === "electron-desktop" && target.runtime === "electron"
	);
	if (targets.length !== 1) throw new TypeError("missing exact Electron shipping target");
	const target = targets[0];
	if (target.state === "inactive" && Array.isArray(target.versions) && target.versions.length === 0)
		return { activated: false, chromeVersion: null, executions: 0, status: "inactive" };
	if (target.state !== "shipped" || !Array.isArray(target.versions) || target.versions.length === 0)
		throw new TypeError("invalid Electron target lifecycle");
	if (!Array.isArray(input.receipts) || input.receipts.length !== target.versions.length)
		throw new TypeError("missing Electron runtime observation");
	for (const version of target.versions) {
		if (!isRecord(version) || typeof version.version !== "string" || typeof version.runner !== "string")
			throw new TypeError("invalid shipped Electron version");
		const receipt = input.receipts.find((candidate) => isRecord(candidate) && candidate.version === version.version);
		const keys = ["artifactKind", "chromeVersion", "processVersions", "runtime", "targetId", "version"];
		if (
			!exactKeys(receipt, keys) ||
			receipt.artifactKind !== "ts-drp/electron-runtime-observation/v1" ||
			receipt.runtime !== "electron" ||
			receipt.targetId !== "electron-desktop" ||
			!isRecord(receipt.processVersions) ||
			receipt.processVersions.chrome !== receipt.chromeVersion ||
			receipt.processVersions.electron !== receipt.version ||
			parseDottedVersion("chromium", receipt.chromeVersion) === null
		)
			throw new TypeError("invalid Electron runtime observation");
	}
	return {
		activated: true,
		chromeVersion: input.receipts[0].chromeVersion,
		executions: input.receipts.length,
		status: "observed",
	};
}

export function evaluateBrowserCurrency(input) {
	if (!isRecord(input)) throw new TypeError("invalid browser-currency input");
	const nowUtc = input.nowUtc;
	if (canonicalTimestamp(nowUtc) === null) throw new TypeError("nowUtc must be canonical millisecond UTC");
	const custody = validateSourceCustody({ nowUtc, rawSources: input.sourceBytes, snapshot: input.snapshot });
	const values = sourceMap(custody.sources);
	const launches = Array.isArray(input.launches) ? input.launches : [];
	const runtime = validateRuntimeIdentity({
		launches: launches.map((row) => ({ browserVersion: row.browserVersion, engine: row.engine })),
		manifest: isRecord(input.playwright) ? input.playwright.browsers : null,
		manifestOwner: "resolved-root-playwright-core",
	});
	const invalidRowIds = [...custody.errors, ...runtime.errors].sort();
	const warnings = [];
	const stableChannels = isRecord(input.stableChannels) ? input.stableChannels : {};
	const playwright = isRecord(input.playwright) ? input.playwright : {};
	const chromiumVersion = launchVersion(input, "chromium");
	const firefoxVersion = launchVersion(input, "firefox");
	const webkitVersion = launchVersion(input, "webkit");
	const chromiumStable = stableChannels.chromium ?? values["chrome-for-testing-last-known-good-versions.json"] ?? null;
	const firefoxStable = stableChannels.firefox ?? values["mozilla-firefox-versions.json"] ?? null;
	for (const [channelId, version] of [
		["chromium", chromiumVersion],
		["chromium", chromiumStable],
		["firefox", firefoxVersion],
		["firefox", firefoxStable],
		["webkit", webkitVersion],
	]) {
		if (parseDottedVersion(channelId, version) === null) invalidRowIds.push(`${channelId}:version-grammar`);
	}
	if (
		playwright.newestStableVersion !== values["npm-playwright-test-dist-tags.json"] ||
		parseDottedVersion("playwright", playwright.version) === null ||
		parseDottedVersion("playwright", playwright.newestStableVersion) === null
	)
		invalidRowIds.push("playwright:source-or-version-mismatch");
	try {
		if (JSON.stringify(playwright.newestStableBrowsers) !== values["playwright-browsers.json"])
			invalidRowIds.push("playwright:browsers-source-mismatch");
	} catch {
		invalidRowIds.push("playwright:browsers-source-mismatch");
	}
	const chromiumDelta = majorDelta("chromium", chromiumStable, chromiumVersion);
	const firefoxDelta = majorDelta("firefox", firefoxStable, firefoxVersion);
	const newestPlaywright = playwright.version === playwright.newestStableVersion;
	const chromiumCeiling = chromiumDelta !== null && chromiumDelta >= POLICY.blockingMajorDelta && newestPlaywright;
	const firefoxCeiling = firefoxDelta !== null && firefoxDelta >= POLICY.blockingMajorDelta && newestPlaywright;
	const chromiumRow = {
		channelId: "chromium",
		coverageReason: chromiumCeiling ? "tooling-ceiling" : null,
		coverageStatus: chromiumCeiling ? "not-covered" : "playwright-engine",
		launchedVersion: chromiumVersion,
		majorDelta: chromiumDelta,
		previousStableReason: "no-official-machine-readable-source",
		previousStableVersion: null,
		releaseBlocking: chromiumCeiling ? false : chromiumDelta !== null && chromiumDelta >= POLICY.blockingMajorDelta,
		stableVersion: chromiumStable,
	};
	const firefoxRow = {
		branded: false,
		channelId: "firefox",
		coverageReason: firefoxCeiling ? "tooling-ceiling" : null,
		coverageStatus: firefoxCeiling ? "not-covered" : "playwright-engine",
		launchedVersion: firefoxVersion,
		majorDelta: firefoxDelta,
		previousStableVersion: values["mozilla-firefox-history-major-releases.json"] ?? null,
		releaseBlocking: firefoxCeiling ? false : firefoxDelta !== null && firefoxDelta >= POLICY.blockingMajorDelta,
		stableVersion: firefoxStable,
	};
	const webkitRow = {
		branded: false,
		channelId: "webkit",
		coverageStatus: "engine-only",
		launchedVersion: webkitVersion,
		safariClaim: false,
		stableVersion: null,
	};
	const safariReview = isRecord(input.safariReview) ? input.safariReview : {};
	const safariObserved = canonicalTimestamp(safariReview.observedAtUtc);
	if (
		parseDottedVersion("safari-macos", safariReview.currentVersion) === null ||
		parseDottedVersion("safari-macos", safariReview.previousVersion) === null ||
		safariObserved === null ||
		safariReview.indexUrl !== "https://developer.apple.com/documentation/safari-release-notes" ||
		typeof safariReview.permanentVersionUrl !== "string" ||
		!safariReview.permanentVersionUrl.startsWith("https://developer.apple.com/documentation/safari-release-notes/")
	)
		invalidRowIds.push("safari-macos:invalid-human-review");
	const safariRow = {
		channelId: "safari-macos",
		currentVersion: safariReview.currentVersion ?? null,
		indexUrl: safariReview.indexUrl ?? null,
		observedAtUtc: safariReview.observedAtUtc ?? null,
		permanentVersionUrl: safariReview.permanentVersionUrl ?? null,
		previousVersion: safariReview.previousVersion ?? null,
		previousVersionSource: "apple-release-notes-index-human-reviewed",
	};
	for (const [channelId, row, delta, version] of [
		["chromium", chromiumRow, chromiumDelta, chromiumVersion],
		["firefox", firefoxRow, firefoxDelta, firefoxVersion],
	]) {
		if (delta !== null && delta >= POLICY.blockingMajorDelta)
			warnings.push(
				`${channelId}:${row.coverageReason === "tooling-ceiling" ? "tooling-ceiling" : `major-delta-${delta}`}`
			);
		const stable = parseDottedVersion(channelId, row.stableVersion);
		const observed = parseDottedVersion(channelId, version);
		if (
			stable !== null &&
			observed !== null &&
			continuousBehindWarning(input, channelId, observed[0], stable[0], nowUtc)
		)
			warnings.push(`${channelId}:continuous-month-behind`);
	}
	if (safariObserved !== null && Date.parse(nowUtc) - safariObserved > POLICY.safariReviewMaxAgeDays * DAY_MILLISECONDS)
		warnings.push("safari-macos:review-older-than-180-days");
	if (playwright.version !== playwright.newestStableVersion) warnings.push("playwright:older-than-stable");
	const coverageObligations = COVERAGE_IDS.map((obligationId) => ({
		evidence: null,
		obligationId,
		owner: "pre-release-tier",
		status: "unmet",
	}));
	for (const obligationId of COVERAGE_IDS) warnings.push(`${obligationId}:unmet-pre-release-obligation`);
	const channels = [chromiumRow, firefoxRow, webkitRow, safariRow];
	const missingChannelIds = CHANNEL_IDS.filter((channelId) => !channels.some((row) => row.channelId === channelId));
	const electron = evaluateElectron({
		receipts: isRecord(input.electron) ? input.electron.receipts : [],
		shippingManifest: isRecord(input.electron) ? input.electron.manifest : null,
	});
	invalidRowIds.sort();
	const sortedWarnings = [...new Set(warnings)].sort();
	const verdict =
		invalidRowIds.length > 0 || missingChannelIds.length > 0 ? "fail" : sortedWarnings.length > 0 ? "warn" : "pass";
	return {
		artifactKind: "ts-drp/browser-matrix-currency/v1",
		channels,
		coverageObligations,
		electron,
		evaluatedAtUtc: nowUtc,
		gitSha: input.gitSha,
		invalidRowIds,
		missingChannelIds,
		playwright: {
			browsers: playwright.browsers ?? null,
			newestStableBrowsers: playwright.newestStableBrowsers ?? null,
			newestStableVersion: playwright.newestStableVersion ?? null,
			version: playwright.version ?? null,
		},
		policy: POLICY,
		requiredChannelIds: CHANNEL_IDS,
		runId: input.runId,
		schemaVersion: 1,
		sources: custody.sources,
		verdict,
		warnings: sortedWarnings,
	};
}

function artifactStructuralErrors(value, current) {
	const errors = [];
	if (!exactKeys(value, ARTIFACT_KEYS)) return ["artifact:top-level-schema"];
	if (value.artifactKind !== "ts-drp/browser-matrix-currency/v1" || value.schemaVersion !== 1)
		errors.push("artifact:identity");
	if (JSON.stringify(value.policy) !== JSON.stringify(POLICY)) errors.push("artifact:policy");
	if (canonicalTimestamp(value.evaluatedAtUtc) === null) errors.push("artifact:evaluated-at");
	if (value.gitSha !== current.gitSha || !GIT_SHA.test(value.gitSha)) errors.push("artifact:git-sha");
	const expectedRun = `phase-2k/${value.gitSha}/`;
	const uuid =
		typeof value.runId === "string" && value.runId.startsWith(expectedRun) ? value.runId.slice(expectedRun.length) : "";
	if (value.runId !== current.runId || !UUID_V4.test(uuid)) errors.push("artifact:run-id");
	if (JSON.stringify(value.requiredChannelIds) !== JSON.stringify(CHANNEL_IDS))
		errors.push("artifact:required-channels");
	if (
		!Array.isArray(value.channels) ||
		JSON.stringify(value.channels.map((row) => row.channelId)) !== JSON.stringify(CHANNEL_IDS)
	)
		errors.push("artifact:channels");
	else {
		for (const row of value.channels) {
			if (!isRecord(row)) {
				errors.push("artifact:channel-row");
				continue;
			}
			if (row.channelId === "chromium" || row.channelId === "firefox") {
				const delta = majorDelta(row.channelId, row.stableVersion, row.launchedVersion);
				const ceiling =
					delta !== null &&
					delta >= POLICY.blockingMajorDelta &&
					isRecord(value.playwright) &&
					value.playwright.version === value.playwright.newestStableVersion;
				if (
					delta === null ||
					row.majorDelta !== delta ||
					row.releaseBlocking !== (!ceiling && delta >= POLICY.blockingMajorDelta) ||
					(ceiling && (row.coverageStatus !== "not-covered" || row.coverageReason !== "tooling-ceiling"))
				)
					errors.push(`artifact:${row.channelId}-derivation`);
			}
			if (
				row.channelId === "webkit" &&
				(row.branded !== false ||
					row.coverageStatus !== "engine-only" ||
					row.safariClaim !== false ||
					row.stableVersion !== null ||
					Object.hasOwn(row, "safariVersion"))
			)
				errors.push("artifact:webkit-safari-claim");
		}
	}
	if (
		!Array.isArray(value.coverageObligations) ||
		JSON.stringify(value.coverageObligations.map((row) => row.obligationId)) !== JSON.stringify(COVERAGE_IDS)
	)
		errors.push("artifact:coverage-obligations");
	if (Array.isArray(value.coverageObligations)) {
		for (const row of value.coverageObligations) {
			if (!isRecord(row) || row.owner !== "pre-release-tier" || row.status !== "unmet" || row.evidence !== null)
				errors.push("false-coverage-claim");
		}
	}
	if (!Array.isArray(value.invalidRowIds) || !Array.isArray(value.missingChannelIds) || !Array.isArray(value.warnings))
		errors.push("artifact:diagnostics");
	else {
		if (JSON.stringify(value.warnings) !== JSON.stringify([...new Set(value.warnings)].sort()))
			errors.push("artifact:warning-order");
		if (JSON.stringify(value.invalidRowIds) !== JSON.stringify([...new Set(value.invalidRowIds)].sort()))
			errors.push("artifact:invalid-row-order");
		if (
			JSON.stringify(value.missingChannelIds) !==
			JSON.stringify(CHANNEL_IDS.filter((id) => value.missingChannelIds.includes(id)))
		)
			errors.push("artifact:missing-channel-order");
	}
	if (!Array.isArray(value.sources) || value.sources.length !== SOURCE_FILES.length) errors.push("artifact:sources");
	if (
		!isRecord(value.electron) ||
		!sameKeySet(value.electron, ["activated", "chromeVersion", "executions", "status"]) ||
		(value.electron.status === "inactive" &&
			(value.electron.activated !== false || value.electron.chromeVersion !== null || value.electron.executions !== 0))
	)
		errors.push("artifact:electron");
	const derived =
		Array.isArray(value.invalidRowIds) &&
		Array.isArray(value.missingChannelIds) &&
		(value.invalidRowIds.length > 0 || value.missingChannelIds.length > 0)
			? "fail"
			: Array.isArray(value.warnings) && value.warnings.length > 0
				? "warn"
				: "pass";
	if (value.verdict !== derived) errors.push("artifact:verdict");
	return [...new Set(errors)].sort();
}

export function validateArtifact(value, current) {
	if (!isRecord(value) || !isRecord(current)) return { artifact: null, errors: ["artifact:invalid-input"] };
	const errors = artifactStructuralErrors(value, current);
	return { artifact: errors.length === 0 ? value : null, errors };
}

export function createArtifactPublication({ gitSha, outputBase, uuid }) {
	if (!GIT_SHA.test(gitSha) || !UUID_V4.test(uuid)) throw new TypeError("invalid publication identity");
	const runId = `phase-2k/${gitSha}/${uuid}`;
	const aggregatePath = path.join(outputBase, "browser-matrix-currency.json");
	return Object.freeze({
		aggregatePath,
		finalize(artifact) {
			const validated = validateArtifact(artifact, { gitSha, runId });
			if (validated.artifact === null) throw new TypeError(validated.errors.join(","));
			fs.mkdirSync(outputBase, { recursive: true });
			const descriptor = fs.openSync(aggregatePath, "wx");
			try {
				fs.writeFileSync(descriptor, `${JSON.stringify(validated.artifact, null, 2)}\n`, "utf8");
			} finally {
				fs.closeSync(descriptor);
			}
			return validated.artifact;
		},
	});
}

export function evaluateReleaseCandidate(input) {
	if (!isRecord(input) || !isRecord(input.artifact))
		return { boundary: "before-release-init", exitCode: 1, reasons: ["artifact:invalid-input"] };
	const artifact = input.artifact;
	const validation = validateArtifact(artifact, { gitSha: artifact.gitSha, runId: artifact.runId });
	const reasons = [...validation.errors];
	if (Array.isArray(artifact.invalidRowIds)) reasons.push(...artifact.invalidRowIds);
	if (Array.isArray(artifact.missingChannelIds))
		reasons.push(...artifact.missingChannelIds.map((id) => `${id}:missing`));
	if (input.mode === "report") {
		const reportReasons = [...new Set(reasons)].sort();
		return {
			boundary: reportReasons.length === 0 ? "report-complete" : "before-report-complete",
			exitCode: reportReasons.length === 0 ? 0 : 1,
			reasons: reportReasons,
		};
	}
	if (Array.isArray(artifact.channels)) {
		for (const row of artifact.channels) {
			if (!isRecord(row) || (row.channelId !== "chromium" && row.channelId !== "firefox")) continue;
			if (row.stableVersion === null) reasons.push(`${row.channelId}:stable-unknown`);
			if (row.releaseBlocking === true) reasons.push(`${row.channelId}:major-delta-${row.majorDelta}`);
		}
	}
	const uniqueReasons = [...new Set(reasons)].sort();
	return {
		boundary: "before-release-init",
		exitCode: uniqueReasons.length === 0 ? 0 : 1,
		reasons: uniqueReasons,
	};
}

export function auditPlaywrightGraph(input) {
	const errors = [];
	const versions = isRecord(input) && isRecord(input.installedVersions) ? input.installedVersions : {};
	if (!isRecord(input) || parseDottedVersion("playwright", input.rootPin) === null)
		errors.push("playwright-graph:root-pin");
	for (const packageName of ["@playwright/test", "playwright", "playwright-core"]) {
		const installed = Array.isArray(versions[packageName]) ? [...new Set(versions[packageName])] : [];
		if (installed.length !== 1 || installed[0] !== input.rootPin) errors.push(`playwright-graph:${packageName}`);
	}
	if (!Array.isArray(input.installedPackageEntries) || input.installedPackageEntries.length !== 3)
		errors.push("playwright-graph:installed-entries");
	if (!isRecord(input.manifests) || !isRecord(input.manifests["package.json"]))
		errors.push("playwright-graph:manifests");
	else {
		const root = input.manifests["package.json"];
		if (!isRecord(root.devDependencies) || root.devDependencies["@playwright/test"] !== input.rootPin)
			errors.push("playwright-graph:root-manifest");
		for (const [manifestPath, manifest] of Object.entries(input.manifests)) {
			if (!isRecord(manifest) || !isRecord(manifest.devDependencies)) continue;
			const declaration = manifest.devDependencies["@playwright/test"];
			if (declaration !== undefined && declaration !== input.rootPin)
				errors.push(`playwright-graph:divergent:${manifestPath}`);
		}
	}
	if (!isRecord(input.lockImporters) || !isRecord(input.lockImporters["."])) errors.push("playwright-graph:lock-root");
	else {
		for (const [importerPath, importer] of Object.entries(input.lockImporters)) {
			if (!isRecord(importer) || !isRecord(importer.devDependencies)) continue;
			const declaration = importer.devDependencies["@playwright/test"];
			if (declaration !== undefined && (!isRecord(declaration) || declaration.specifier !== input.rootPin))
				errors.push(`playwright-graph:lock-divergent:${importerPath}`);
		}
	}
	return { errors: [...new Set(errors)].sort(), versions };
}

export function planAtomicRefresh(input) {
	const failure = isRecord(input) ? input.forcedFailure : "invalid-input";
	if (failure !== undefined) return { changes: [], errors: [`refresh:${failure}`], status: "failed" };
	if (!isRecord(input) || input.requestedChanges !== undefined)
		return { changes: [], errors: ["refresh:fixed-paths-only"], status: "failed" };
	const custody = validateSourceCustody({ rawSources: input.rawSources, snapshot: input.snapshot });
	const current = parseDottedVersion("playwright", input.currentPlaywrightVersion);
	const next = parseDottedVersion("playwright", input.nextPlaywrightVersion);
	const values = sourceMap(custody.sources);
	const errors = [...custody.errors];
	if (current === null || next === null || current[0] !== 1 || next[0] !== 1) errors.push("refresh:playwright-major");
	if (values["npm-playwright-test-dist-tags.json"] !== input.nextPlaywrightVersion)
		errors.push("refresh:cross-source-version");
	if (errors.length > 0) return { changes: [], errors: [...new Set(errors)].sort(), status: "failed" };
	const paths = [
		"browser-currency-sources.json",
		"package.json",
		"pnpm-lock.yaml",
		...SOURCE_FILES.map((file) => `tests/fixtures/phase-2k/sources/${file}`),
	];
	return {
		changes: paths.map((changedPath) => ({ path: changedPath })),
		errors: [],
		status: "ready",
	};
}

function workflowSteps(job) {
	return isRecord(job) && Array.isArray(job.steps) ? job.steps : [];
}

function hasMaskedRun(step) {
	return (
		isRecord(step) &&
		typeof step.run === "string" &&
		(/\|\|\s*true/u.test(step.run) || /(^|\n)\s*set \+e/u.test(step.run))
	);
}

export function auditWorkflow(input) {
	const errors = [];
	if (!isRecord(input) || !isRecord(input.currency) || !isRecord(input.refresh))
		return { errors: ["workflow:missing"] };
	const currency = input.currency;
	const currencyJob = isRecord(currency.jobs) ? currency.jobs["browser-currency"] : null;
	const currencySteps = workflowSteps(currencyJob);
	if (!isRecord(currencyJob) || currencyJob["continue-on-error"] === true) errors.push("workflow:currency-job");
	if (currencySteps.some(hasMaskedRun)) errors.push("workflow:masking");
	if (
		!currencySteps.some(
			(step) =>
				isRecord(step) && typeof step.run === "string" && step.run.includes("playwright.browser-currency.config.ts")
		)
	)
		errors.push("workflow:launch-step");
	if (
		!currencySteps.some(
			(step) =>
				isRecord(step) &&
				step.if === "always()" &&
				step.uses === "actions/upload-artifact@v4" &&
				isRecord(step.with) &&
				step.with["if-no-files-found"] === "error"
		)
	)
		errors.push("workflow:upload");
	const refresh = input.refresh;
	if (
		!isRecord(refresh.concurrency) ||
		refresh.concurrency.group !== "phase-2k-browser-currency-refresh" ||
		refresh.concurrency["cancel-in-progress"] !== false
	)
		errors.push("workflow:refresh-concurrency");
	const schedule = isRecord(refresh.on) && Array.isArray(refresh.on.schedule) ? refresh.on.schedule : [];
	if (schedule.length !== 1 || !isRecord(schedule[0]) || schedule[0].cron !== "23 5 * * 1")
		errors.push("workflow:refresh-schedule");
	const refreshJob = isRecord(refresh.jobs) ? refresh.jobs.refresh : null;
	const refreshSteps = workflowSteps(refreshJob);
	if (
		!refreshSteps.some(
			(step) => isRecord(step) && typeof step.run === "string" && step.run.includes("chore/phase-2k-browser-currency")
		)
	)
		errors.push("workflow:fixed-branch");
	if (
		!refreshSteps.some(
			(step) =>
				isRecord(step) &&
				step.uses === "peter-evans/create-pull-request@v7" &&
				isRecord(step.with) &&
				step.with.branch === "chore/phase-2k-browser-currency" &&
				step.with["auto-merge"] !== true
		)
	)
		errors.push("workflow:human-merge");
	return { errors: [...new Set(errors)].sort() };
}

function reachesJob(jobs, start, target, seen = new Set()) {
	if (start === target) return true;
	if (seen.has(start) || !isRecord(jobs[start])) return false;
	seen.add(start);
	const needs = jobs[start].needs;
	const dependencies = typeof needs === "string" ? [needs] : Array.isArray(needs) ? needs : [];
	return dependencies.some((dependency) => reachesJob(jobs, dependency, target, seen));
}

export function auditReleaseWorkflow(input) {
	const publicationJobs = ["npm_publish", "publish_buf_registry", "build_docker_images"];
	const errors = [];
	if (!isRecord(input) || !isRecord(input.packageManifest) || !isRecord(input.workflow))
		return { errors: ["release:invalid-input"], publicationJobs };
	const releaseIt = input.packageManifest["release-it"];
	if (
		!isRecord(releaseIt) ||
		!isRecord(releaseIt.hooks) ||
		releaseIt.hooks["before:init"] !== "node scripts/phase-2k-browser-currency.mjs release-gate"
	)
		errors.push("release:before-init-hook");
	const jobs = isRecord(input.workflow.jobs) ? input.workflow.jobs : {};
	if (!isRecord(jobs["phase-2k-browser-currency"])) errors.push("release:launch-gate");
	for (const job of publicationJobs)
		if (!reachesJob(jobs, job, "phase-2k-browser-currency")) errors.push(`release:bypass:${job}`);
	return { errors: errors.sort(), publicationJobs };
}

function readJson(relativePath) {
	return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

export function resolveInstalledBrowserManifestPath(repositoryRoot = ROOT) {
	const entries = fs
		.readdirSync(path.join(repositoryRoot, "node_modules/.pnpm"))
		.filter((entry) => entry.startsWith("playwright-core@"));
	if (entries.length !== 1) throw new TypeError("expected exactly one installed root playwright-core");
	return path.join(repositoryRoot, "node_modules/.pnpm", entries[0], "node_modules/playwright-core/browsers.json");
}

function checkedInput() {
	const snapshot = readJson("browser-currency-sources.json");
	const rows = sourceRows(snapshot);
	const rawSources = Object.fromEntries(
		SOURCE_FILES.map((file) => [
			file,
			fs.readFileSync(path.join(ROOT, "tests/fixtures/phase-2k/sources", file), "utf8"),
		])
	);
	const values = sourceMap(rows);
	const packageManifest = readJson("package.json");
	const installedBrowsers = JSON.parse(fs.readFileSync(resolveInstalledBrowserManifestPath(), "utf8"));
	const browserValue = sourceValue("playwright-browsers.json", installedBrowsers);
	const browsers = browserValue === null ? {} : JSON.parse(browserValue);
	const gitSha =
		process.env.PHASE_2K_GIT_SHA ??
		process.env.GITHUB_SHA ??
		execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
	const uuid = process.env.PHASE_2K_UUID ?? randomUUID();
	return {
		coverageEvidence: [],
		electron: {
			manifest: readJson("tests/fixtures/phase-0j-d-v3/current-inactive-shipping-targets.json"),
			receipts: [],
		},
		firstObservedBehindAtUtc: snapshot.firstObservedBehindAtUtc ?? {},
		gitSha,
		launches: [
			{ browserVersion: browsers.chromium, channelId: "chromium", engine: "chromium" },
			{ browserVersion: browsers.firefox, channelId: "firefox", engine: "firefox" },
			{ browserVersion: browsers.webkit, channelId: "webkit", engine: "webkit" },
		],
		nowUtc: new Date().toISOString(),
		playwright: {
			browsers,
			newestStableBrowsers: JSON.parse(values["playwright-browsers.json"]),
			newestStableVersion: values["npm-playwright-test-dist-tags.json"],
			version: packageManifest.devDependencies["@playwright/test"],
		},
		runId: `phase-2k/${gitSha}/${uuid}`,
		safariReview: snapshot.safariReview,
		snapshot,
		sourceBytes: rawSources,
		stableChannels: {
			chromium: values["chrome-for-testing-last-known-good-versions.json"],
			firefox: values["mozilla-firefox-versions.json"],
		},
	};
}

function checkedDependencyInput() {
	const lock = YAML.parse(fs.readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8"));
	const versions = { "@playwright/test": [], "playwright": [], "playwright-core": [] };
	for (const key of Object.keys(lock.packages)) {
		for (const packageName of Object.keys(versions)) {
			const prefix = `${packageName}@`;
			if (key.startsWith(prefix)) versions[packageName].push(key.slice(prefix.length));
		}
	}
	const manifests = {};
	for (const importerPath of Object.keys(lock.importers)) {
		const manifestPath = importerPath === "." ? "package.json" : `${importerPath}/package.json`;
		const absolute = path.join(ROOT, manifestPath);
		if (fs.existsSync(absolute)) manifests[manifestPath] = readJson(manifestPath);
	}
	const packageManifest = manifests["package.json"];
	return {
		installedPackageEntries: fs
			.readdirSync(path.join(ROOT, "node_modules/.pnpm"))
			.filter(
				(entry) =>
					entry.startsWith("@playwright+test@") ||
					entry.startsWith("playwright@") ||
					entry.startsWith("playwright-core@")
			),
		installedVersions: versions,
		lockImporters: lock.importers,
		manifests,
		rootPin: packageManifest.devDependencies["@playwright/test"],
	};
}

function runCli() {
	const command = process.argv[2];
	if (command !== "release-gate" && command !== "report") return;
	const input = checkedInput();
	const artifact = evaluateBrowserCurrency(input);
	const decision = evaluateReleaseCandidate({ artifact, mode: command === "report" ? "report" : "release" });
	const graph = auditPlaywrightGraph(checkedDependencyInput());
	if (graph.errors.length > 0) {
		decision.boundary = command === "report" ? "before-report-complete" : "before-release-init";
		decision.exitCode = 1;
		decision.reasons = [...new Set([...decision.reasons, ...graph.errors])].sort();
	}
	if (command === "report") {
		const outputBase = path.join(ROOT, "test-results/phase-2k");
		createArtifactPublication({
			gitSha: input.gitSha,
			outputBase,
			uuid: input.runId.slice(input.runId.lastIndexOf("/") + 1),
		}).finalize(artifact);
	}
	for (const warning of artifact.warnings)
		process.stderr.write(`::warning title=Phase 2k browser currency::${warning}\n`);
	if (decision.exitCode !== 0) process.stderr.write(`Phase 2k blocked: ${decision.reasons.join(", ")}\n`);
	process.exitCode = decision.exitCode;
}

runCli();
