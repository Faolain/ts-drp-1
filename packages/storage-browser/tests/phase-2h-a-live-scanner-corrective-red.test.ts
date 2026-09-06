import { assert, jsonValue, property } from "fast-check";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
	aggregatePhase2h,
	type Phase2hRawEntry,
	phase2hStructuralEntries,
	readPhase2hRunEntries,
} from "./fixtures/phase-2h-a-aggregate.js";
import {
	phase2hControlRecords,
	PHASE_2H_CONTROL_BROWSER_VERSIONS,
	PHASE_2H_CONTROL_GIT_SHA,
	PHASE_2H_CONTROL_RUN_ID,
	PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
} from "./fixtures/phase-2h-a-controls.js";
import { createPhase2hPublisher, type Phase2hRunLayout, preparePhase2hRun } from "./fixtures/phase-2h-a-publication.js";
import {
	type Phase2hRecordValidation,
	type Phase2hValidationRecord,
	validatePhase2hRecord,
} from "./fixtures/phase-2h-a-record.js";

const RECORD_BODY_LIMIT = 4_194_304;
const TOTALITY_SEED = 0x2_0c_2026; // Decimal 34,349,094.
const temporaryDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

function controlRecord(tupleId: string): Phase2hValidationRecord {
	const record = phase2hControlRecords().find((candidate) => candidate.tupleId === tupleId);
	if (record === undefined) throw new TypeError(`missing corrective control record: ${tupleId}`);
	return record;
}

function freshLayout(prefix: string): Phase2hRunLayout {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(temporary);
	return preparePhase2hRun({
		browserVersions: PHASE_2H_CONTROL_BROWSER_VERSIONS,
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		outputBase: path.join(temporary, "phase-2h"),
		playwrightVersion: PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
		uuid: "00000000-0000-4000-8000-000000000000",
	});
}

function readTarget(value: unknown): string {
	return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function expectBodyWasNotOpened(openSpy: MockInstance, target: string): void {
	expect(openSpy.mock.calls.filter(([candidate]) => readTarget(candidate) === target)).toEqual([]);
}

function expectBodyWasNotRead(openSpy: MockInstance, readSpy: MockInstance, target: string): void {
	const descriptors = openSpy.mock.calls
		.flatMap(([candidate], index) => (readTarget(candidate) === target ? [openSpy.mock.results[index]?.value] : []))
		.filter((descriptor): descriptor is number => typeof descriptor === "number");
	for (const descriptor of descriptors)
		expect(readSpy.mock.calls.some(([candidate]) => candidate === descriptor)).toBe(false);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function fakeStats(entryKind: "directory" | "file" | "symlink", size = 0): fs.Stats {
	return {
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isDirectory: () => entryKind === "directory",
		isFIFO: () => false,
		isFile: () => entryKind === "file",
		isSocket: () => false,
		isSymbolicLink: () => entryKind === "symlink",
		size,
	} as fs.Stats;
}

function validate(record: unknown, project: "chromium" | "firefox" | "webkit"): Phase2hRecordValidation {
	return validatePhase2hRecord(record, {
		browserVersions: PHASE_2H_CONTROL_BROWSER_VERSIONS,
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		playwrightVersion: PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
		project,
		runId: PHASE_2H_CONTROL_RUN_ID,
	});
}

function invalidMarkerIdentity(scope: string, basename: Uint8Array): string {
	const bytes = Buffer.concat([
		Buffer.from("ts-drp/phase-2h-diagnostic-entry/v1\0", "utf8"),
		Buffer.from("invalid-collision-marker", "utf8"),
		Buffer.from([0]),
		Buffer.from(scope, "utf8"),
		Buffer.from([0]),
		Buffer.from(basename),
	]);
	return `entry-invalid-collision-marker-sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("Phase 2h-a live scanner corrective RED", () => {
	it("RED: attributes an invalid regular filename before reading its body", () => {
		const layout = freshLayout("phase-2h-invalid-name-");
		const invalidPath = path.join(layout.runRoot, "records/chromium/%zz.json");
		fs.writeFileSync(invalidPath, "body-must-not-be-read");
		const openSpy = vi.spyOn(fs, "openSync");
		const readSpy = vi.spyOn(fs, "readSync");
		const scan = readPhase2hRunEntries(layout.runRoot);
		const observed = aggregatePhase2h({
			...scan,
			browserVersions: layout.browserVersions,
			gitSha: layout.gitSha,
			playwrightVersion: layout.playwrightVersion,
			runId: layout.runId,
		});
		expect(observed.verdict).toBe("fail");
		expectBodyWasNotOpened(openSpy, invalidPath);
		expect(readSpy).not.toHaveBeenCalled();
	});

	it("RED: stops globally before reading a valid-looking entry after the 1,025th non-structural entry", () => {
		const layout = freshLayout("phase-2h-global-bound-");
		const targetName = "capacity%2Fchromium.json";
		const targetPath = path.join(layout.runRoot, "records/chromium", targetName);
		const preceding = Array.from({ length: 1_025 }, (_, index) =>
			Buffer.from(`00-skipped-${String(index).padStart(4, "0")}`, "utf8")
		);
		const directoryListings = [
			[Buffer.from("collisions"), Buffer.from("records")],
			[Buffer.from("chromium"), Buffer.from("firefox"), Buffer.from("webkit")],
			[Buffer.from("chromium"), Buffer.from("firefox"), Buffer.from("webkit")],
			[...preceding, Buffer.from(targetName)],
			[],
			[],
			[],
			[],
			[],
		];
		const readdirSpy = vi.spyOn(fs, "readdirSync");
		for (const listing of directoryListings) readdirSpy.mockReturnValueOnce(listing as never);
		vi.spyOn(fs, "lstatSync").mockImplementation((target) => {
			const basename = path.basename(readTarget(target));
			if (["records", "collisions", "chromium", "firefox", "webkit"].includes(basename)) return fakeStats("directory");
			return fakeStats(basename === targetName ? "file" : "symlink");
		});
		const openSpy = vi.spyOn(fs, "openSync");
		const readSpy = vi.spyOn(fs, "readSync");
		readPhase2hRunEntries(layout.runRoot);
		expectBodyWasNotOpened(openSpy, targetPath);
		expect(readSpy).not.toHaveBeenCalled();
	});

	it("RED: detects byte 4,194,305 without an unbounded whole-file read", () => {
		const layout = freshLayout("phase-2h-body-bound-");
		const recordPath = path.join(layout.runRoot, "records/chromium/capacity%2Fchromium.json");
		const descriptor = fs.openSync(recordPath, "w");
		try {
			fs.ftruncateSync(descriptor, RECORD_BODY_LIMIT + 1);
		} finally {
			fs.closeSync(descriptor);
		}
		const openSpy = vi.spyOn(fs, "openSync");
		const readSpy = vi.spyOn(fs, "readSync");
		const observed = aggregatePhase2h({
			...readPhase2hRunEntries(layout.runRoot),
			browserVersions: layout.browserVersions,
			gitSha: layout.gitSha,
			playwrightVersion: layout.playwrightVersion,
			runId: layout.runId,
		});
		expect(observed.invalidRecordIds).toContain("capacity/chromium");
		expectBodyWasNotRead(openSpy, readSpy, recordPath);
	});

	it("RED: rejects an expected structural symlink without descending into its target", () => {
		const layout = freshLayout("phase-2h-structural-link-");
		const external = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2h-external-target-"));
		temporaryDirectories.push(external);
		const projectPath = path.join(layout.runRoot, "records/chromium");
		fs.rmSync(projectPath, { recursive: true });
		fs.writeFileSync(path.join(external, "capacity%2Fchromium.json"), "outside-root-body");
		fs.symlinkSync(external, projectPath);
		const readSpy = vi.spyOn(fs, "readFileSync");
		expect(() => readPhase2hRunEntries(layout.runRoot)).toThrow(/structural directory/u);
		expect(
			readSpy.mock.calls
				.map(([target]) => readTarget(target))
				.filter((target) => target.startsWith(`${projectPath}${path.sep}`))
		).toEqual([]);
	});

	it("RED: attributes a canonical body-read failure to its filename identity without throwing", () => {
		const layout = freshLayout("phase-2h-read-failure-");
		const record = controlRecord("capacity/chromium");
		const recordPath = path.join(layout.runRoot, "records/chromium/capacity%2Fchromium.json");
		fs.writeFileSync(recordPath, JSON.stringify(record));
		const realLstat = fs.lstatSync.bind(fs);
		let removed = false;
		vi.spyOn(fs, "lstatSync").mockImplementation((target) => {
			const stat = realLstat(target);
			if (!removed && readTarget(target) === recordPath) {
				fs.unlinkSync(recordPath);
				removed = true;
			}
			return stat;
		});
		let observed: ReturnType<typeof aggregatePhase2h> | undefined;
		expect(() => {
			observed = aggregatePhase2h({
				...readPhase2hRunEntries(layout.runRoot),
				browserVersions: layout.browserVersions,
				gitSha: layout.gitSha,
				playwrightVersion: layout.playwrightVersion,
				runId: layout.runId,
			});
		}).not.toThrow();
		expect(observed?.invalidRecordIds).toContain(record.tupleId);
	});
});

describe("Phase 2h-a validator-totality corrective RED", () => {
	it("RED: rejects null browser-store operationSequence without throwing", () => {
		const record = controlRecord("browser-store/chromium");
		if (record.scenarioEvidence.tag !== "browser-store") throw new TypeError("browser-store control drifted");
		const malformed = {
			...record,
			scenarioEvidence: { ...record.scenarioEvidence, operationSequence: null },
		};
		let observed: Phase2hRecordValidation | undefined;
		expect(() => {
			observed = validate(malformed, "chromium");
		}).not.toThrow();
		expect(observed?.record).toBeNull();
		expect(observed?.errors.length).toBeGreaterThan(0);
	});

	it("RED: rejects null process-death scenarioEvidence without throwing", () => {
		const record = controlRecord("swap-head-certificate-match/request-05-put-objects/after/webkit");
		let observed: Phase2hRecordValidation | undefined;
		expect(() => {
			observed = validate({ ...record, scenarioEvidence: null }, "webkit");
		}).not.toThrow();
		expect(observed?.record).toBeNull();
		expect(observed?.errors.length).toBeGreaterThan(0);
	});

	it("RED: is total and fail-closed over bounded untrusted JSON scenario evidence", () => {
		const browserStore = controlRecord("browser-store/chromium");
		const processDeath = controlRecord("swap-head-certificate-match/request-05-put-objects/after/webkit");
		const started = performance.now();
		assert(
			property(jsonValue(), (scenarioEvidence) => {
				for (const [record, project] of [
					[browserStore, "chromium"],
					[processDeath, "webkit"],
				] as const) {
					try {
						const observed = validate({ ...record, scenarioEvidence }, project);
						const sameAsClosedEvidence = stableJson(scenarioEvidence) === stableJson(record.scenarioEvidence);
						if (sameAsClosedEvidence) {
							if (observed.record === null || observed.errors.length !== 0) return false;
						} else if (observed.record !== null || observed.errors.length === 0) return false;
					} catch {
						return false;
					}
				}
				return true;
			}),
			{ endOnFailure: true, numRuns: 200, seed: TOTALITY_SEED }
		);
		expect(performance.now() - started).toBeLessThan(3_000);
	});

	it("RED: binds process-death recoveredImageDigest to caseEvidence.recoveredImage", () => {
		const record = controlRecord("swap-head-certificate-match/request-05-put-objects/after/webkit");
		if (record.scenarioEvidence.tag !== "process-death") throw new TypeError("process-death control drifted");
		const replacement =
			record.scenarioEvidence.recoveredImageDigest === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
		const observed = validate(
			{
				...record,
				scenarioEvidence: { ...record.scenarioEvidence, recoveredImageDigest: replacement },
			},
			"webkit"
		);
		expect(observed.record === null && observed.errors.length > 0).toBe(true);
	});
});

describe("Phase 2h-a missing marker controls", () => {
	it("keeps the independently image-digested process control valid", () => {
		const record = controlRecord("swap-head-certificate-match/request-05-put-objects/after/webkit");
		expect(validate(record, "webkit").errors).toEqual([]);
	});

	it("attributes an invalid collision marker to the exact bounded marker fallback", () => {
		const basename = new TextEncoder().encode("malformed.collision.json");
		const entry: Phase2hRawEntry = {
			basename,
			body: new TextEncoder().encode("{}"),
			kind: "file",
			scope: "collisions/webkit",
		};
		const observed = aggregatePhase2h({
			browserVersions: PHASE_2H_CONTROL_BROWSER_VERSIONS,
			entries: [...phase2hStructuralEntries(), entry],
			gitSha: PHASE_2H_CONTROL_GIT_SHA,
			playwrightVersion: PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
			runId: PHASE_2H_CONTROL_RUN_ID,
		});
		expect(observed.invalidRecordIds).toEqual([invalidMarkerIdentity(entry.scope, basename)]);
		expect(observed.extraTupleIds).toEqual([]);
	});

	it("retains duplicate and invalid census when collision-marker publication fails", () => {
		const layout = freshLayout("phase-2h-marker-failure-");
		const publisher = createPhase2hPublisher(layout, { failMarkerWrite: true });
		const record = controlRecord("capacity/webkit");
		expect(publisher.submit({ project: "webkit", record })).toBe("accepted");
		expect(publisher.submit({ project: "webkit", record })).toBe("duplicate");
		expect(publisher.census()).toEqual({
			duplicateIdentities: [record.tupleId],
			invalidIdentities: [record.tupleId],
		});
		expect(fs.readdirSync(path.join(layout.runRoot, "collisions/webkit"))).toEqual([]);
		const observed = aggregatePhase2h({
			browserVersions: layout.browserVersions,
			census: publisher.census(),
			...readPhase2hRunEntries(layout.runRoot),
			gitSha: layout.gitSha,
			playwrightVersion: layout.playwrightVersion,
			runId: layout.runId,
		});
		expect(observed.duplicateTupleIds).toContain(record.tupleId);
		expect(observed.invalidRecordIds).toContain(record.tupleId);
	});
});
