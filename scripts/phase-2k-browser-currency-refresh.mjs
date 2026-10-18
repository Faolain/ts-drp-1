/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript workflow CLI */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
	compareDottedVersions,
	parseDottedVersion,
	planAtomicRefresh,
	SOURCE_AUTHORITIES,
} from "./phase-2k-browser-currency.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_BRANCH = "chore/phase-2k-browser-currency";
const MAX_SOURCE_BYTES = 10 * 1024;
const FIXED_SOURCES = Object.freeze(
	Object.fromEntries(Object.entries(SOURCE_AUTHORITIES).filter(([file]) => file !== "playwright-browsers.json"))
);

async function fetchUtf8(url) {
	const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new TypeError(`source HTTP ${response.status}: ${url}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength === 0 || bytes.byteLength >= MAX_SOURCE_BYTES) throw new TypeError(`source size: ${url}`);
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseJson(bytes, file) {
	try {
		return JSON.parse(bytes);
	} catch {
		throw new TypeError(`source JSON: ${file}`);
	}
}

function selectedValues(rawSources) {
	const chrome = parseJson(rawSources["chrome-for-testing-last-known-good-versions.json"], "chrome");
	const firefox = parseJson(rawSources["mozilla-firefox-versions.json"], "firefox");
	const history = parseJson(rawSources["mozilla-firefox-history-major-releases.json"], "firefox-history");
	const npm = parseJson(rawSources["npm-playwright-test-dist-tags.json"], "npm");
	const browserManifest = parseJson(rawSources["playwright-browsers.json"], "playwright-browsers");
	const historyVersions = Object.keys(history)
		.filter((version) => parseDottedVersion("firefox", version) !== null)
		.sort((left, right) => compareDottedVersions("firefox", right, left));
	const browsers = Object.fromEntries(
		["chromium", "firefox", "webkit"].map((engine) => {
			const rows = browserManifest.browsers.filter((row) => row.name === engine && row.installByDefault === true);
			if (rows.length !== 1 || typeof rows[0].browserVersion !== "string")
				throw new TypeError(`Playwright manifest: ${engine}`);
			return [engine, rows[0].browserVersion];
		})
	);
	return {
		browsers,
		chrome: chrome.channels?.Stable?.version,
		firefox: firefox.LATEST_FIREFOX_VERSION,
		firefoxPrevious: historyVersions[1],
		playwright: npm.latest,
	};
}

function writeAtomic(file, bytes) {
	const temporary = `${file}.phase-2k-${process.pid}`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(temporary, bytes, "utf8");
	fs.renameSync(temporary, file);
}

function sourceSnapshot(rawSources, values, previous, fetchedAtUtc) {
	const browsersUrl = `https://raw.githubusercontent.com/microsoft/playwright/v${values.playwright}/packages/playwright-core/browsers.json`;
	const definitions = {
		...FIXED_SOURCES,
		"playwright-browsers.json": {
			pointer: "/browsers[installByDefault=true,name=chromium|firefox|webkit]/browserVersion",
			url: browsersUrl,
		},
	};
	const asserted = {
		"chrome-for-testing-last-known-good-versions.json": values.chrome,
		"mozilla-firefox-history-major-releases.json": values.firefoxPrevious,
		"mozilla-firefox-versions.json": values.firefox,
		"npm-playwright-test-dist-tags.json": values.playwright,
		"playwright-browsers.json": JSON.stringify(values.browsers),
	};
	const firstObservedBehindAtUtc = {};
	const observedBehindMajors = {};
	for (const [channelId, stable, launched] of [
		["chromium", values.chrome, values.browsers.chromium],
		["firefox", values.firefox, values.browsers.firefox],
	]) {
		const stableMajor = Number(stable.split(".")[0]);
		const launchedMajor = Number(launched.split(".")[0]);
		if (launchedMajor < stableMajor) {
			const prior = previous.firstObservedBehindAtUtc?.[channelId];
			const sameObservedMajor = previous.observedBehindMajors?.[channelId] === launchedMajor;
			firstObservedBehindAtUtc[channelId] = sameObservedMajor && typeof prior === "string" ? prior : fetchedAtUtc;
			observedBehindMajors[channelId] = launchedMajor;
		}
	}
	return {
		firstObservedBehindAtUtc,
		observedBehindMajors,
		safariReview: previous.safariReview,
		sources: Object.entries(definitions).map(([file, definition]) => ({
			assertedValue: asserted[file],
			fetchedAtUtc,
			file,
			pointer: definition.pointer,
			sha256: createHash("sha256").update(rawSources[file]).digest("hex"),
			url: definition.url,
		})),
	};
}

async function main() {
	if (process.argv.length !== 4 || process.argv[2] !== "--branch" || process.argv[3] !== FIXED_BRANCH)
		throw new TypeError(`only --branch ${FIXED_BRANCH} is accepted`);
	const rawSources = {};
	for (const [file, definition] of Object.entries(FIXED_SOURCES)) rawSources[file] = await fetchUtf8(definition.url);
	const npm = parseJson(rawSources["npm-playwright-test-dist-tags.json"], "npm");
	if (typeof npm.latest !== "string" || parseDottedVersion("playwright", npm.latest)?.[0] !== 1)
		throw new TypeError("latest Playwright is not stable 1.x");
	const browserUrl = `https://raw.githubusercontent.com/microsoft/playwright/v${npm.latest}/packages/playwright-core/browsers.json`;
	rawSources["playwright-browsers.json"] = await fetchUtf8(browserUrl);
	if (
		Object.values(rawSources).reduce((total, bytes) => total + Buffer.byteLength(bytes, "utf8"), 0) >= MAX_SOURCE_BYTES
	)
		throw new TypeError("combined source size exceeds limit");
	const values = selectedValues(rawSources);
	const packageManifest = parseJson(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"), "package.json");
	const currentPlaywrightVersion = packageManifest.devDependencies["@playwright/test"];
	const previousSnapshot = parseJson(
		fs.readFileSync(path.join(ROOT, "browser-currency-sources.json"), "utf8"),
		"snapshot"
	);
	const snapshot = sourceSnapshot(rawSources, values, previousSnapshot, new Date().toISOString());
	const plan = planAtomicRefresh({
		currentPlaywrightVersion,
		nextPlaywrightVersion: values.playwright,
		rawSources,
		snapshot,
	});
	if (plan.status !== "ready") throw new TypeError(plan.errors.join(","));
	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ts-drp-phase-2k-refresh-"));
	const worktree = path.join(temporaryRoot, "candidate");
	try {
		execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: ROOT, stdio: "inherit" });
		for (const [file, bytes] of Object.entries(rawSources))
			writeAtomic(path.join(worktree, "tests/fixtures/phase-2k/sources", file), bytes);
		writeAtomic(path.join(worktree, "browser-currency-sources.json"), `${JSON.stringify(snapshot, null, "\t")}\n`);
		packageManifest.devDependencies["@playwright/test"] = values.playwright;
		writeAtomic(path.join(worktree, "package.json"), `${JSON.stringify(packageManifest, null, "\t")}\n`);
		execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: worktree, stdio: "inherit" });
		const changed = execFileSync("git", ["diff", "--name-only"], { cwd: worktree, encoding: "utf8" })
			.trim()
			.split("\n")
			.filter(Boolean)
			.sort();
		const expected = plan.changes.map((change) => change.path).sort();
		if (JSON.stringify(changed) !== JSON.stringify(expected))
			throw new TypeError(`refresh changed unexpected paths: ${changed.join(",")}`);
		const patch = execFileSync("git", ["diff", "--binary", "--", ...expected], {
			cwd: worktree,
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
		});
		execFileSync("git", ["apply", "--index", "--whitespace=nowarn", "-"], {
			cwd: ROOT,
			input: patch,
			stdio: ["pipe", "inherit", "inherit"],
		});
	} finally {
		try {
			execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: ROOT, stdio: "ignore" });
		} finally {
			fs.rmSync(temporaryRoot, { force: true, recursive: true });
		}
	}
}

await main();
