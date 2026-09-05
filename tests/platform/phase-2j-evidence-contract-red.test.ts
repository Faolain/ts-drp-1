import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const GIT_SHA = "a".repeat(40);
const UUID = "00000000-0000-4000-8000-000000000000";
const RUN_ID = `phase-2j/${GIT_SHA}/${UUID}`;
const PROJECT_IDS = Object.freeze([
	"chromium",
	"firefox",
	"webkit",
	"ios-safari-emulation",
	"android-chrome-emulation",
] as const);
const PROBE_IDS = Object.freeze(["ed25519", "ecdsa-p256", "ecdsa-k256"] as const);

type ProjectId = (typeof PROJECT_IDS)[number];
type ProbeId = (typeof PROBE_IDS)[number];
type Outcome = "extractable" | "non-extractable" | "probe-error" | "unsupported";

interface ProbeObservation {
	readonly exceptionName: null | string;
	readonly failureKind: "not-supported" | "probe-error" | null;
	readonly observedOutcome: Outcome;
}

interface Phase2jRecord {
	readonly artifactKind: "ts-drp/webcrypto-capability-record/v1";
	readonly device: {
		readonly emulated: boolean;
		readonly profile: string;
		readonly profileUserAgentMatch: boolean;
		readonly realDevice: false;
	};
	readonly engine: {
		readonly brand: string;
		readonly browserVersion: string;
		readonly name: "chromium" | "firefox" | "webkit";
		readonly playwrightVersion: string;
	};
	readonly evidenceClass: "desktop-engine-mobile-emulation" | "desktop-playwright";
	readonly gitSha: string;
	readonly os: {
		readonly arch: "arm64" | "x64";
		readonly platform: "darwin" | "linux";
		readonly release: string;
	};
	readonly probes: readonly Phase2jProbe[];
	readonly projectId: ProjectId;
	readonly runId: string;
	readonly schemaVersion: 1;
	readonly verdict: "fail" | "pass";
}

interface Phase2jProbe extends ProbeObservation {
	readonly algorithmName: "ECDSA" | "Ed25519";
	readonly namedCurve: "K-256" | "P-256" | null;
	readonly operation: "generateKey";
	readonly probeId: ProbeId;
	readonly requestedExtractable: false;
	readonly requestedUsages: readonly ["sign", "verify"];
}

interface Phase2jAggregate {
	readonly artifactKind: "ts-drp/webcrypto-capability-matrix/v1";
	readonly changedProbeIds: readonly string[];
	readonly duplicateProjectIds: readonly ProjectId[];
	readonly gitSha: string;
	readonly invalidRecordIds: readonly ProjectId[];
	readonly missingProjectIds: readonly ProjectId[];
	readonly records: readonly Phase2jRecord[];
	readonly requiredProbeIds: readonly ProbeId[];
	readonly requiredProjectIds: readonly ProjectId[];
	readonly runId: string;
	readonly schemaVersion: 1;
	readonly verdict: "fail" | "pass";
}

interface PublicationOwner {
	readonly layout: {
		readonly aggregatePath: string;
		readonly gitSha: string;
		readonly runId: string;
		readonly runRoot: string;
	};
	finalize(): Phase2jAggregate;
	publish(projectId: ProjectId, record: unknown): "accepted";
}

interface Phase2jEvidenceModule {
	aggregatePhase2j(
		input: Readonly<{
			duplicateProjectIds?: readonly ProjectId[];
			gitSha: string;
			records: readonly unknown[];
			runId: string;
		}>
	): Phase2jAggregate;
	classifyPhase2jProbe(
		input: Readonly<{
			domExceptionConstructor: typeof DOMException;
			error?: unknown;
			keyPair?: unknown;
		}>
	): ProbeObservation;
	consumeCurrentPhase2jAggregate(
		value: unknown,
		current: Readonly<{ gitSha: string; runId: string }>
	): Phase2jAggregate;
	preparePhase2jPublication(
		input: Readonly<{
			gitSha: string;
			outputBase: string;
			uuid?: string;
		}>
	): PublicationOwner;
	validatePhase2jRecord(
		value: unknown,
		expected: Readonly<{ gitSha: string; projectId: ProjectId; runId: string }>
	): Readonly<{ errors: readonly string[]; record: Phase2jRecord | null }>;
}

const temporaryDirectories = new Set<string>();

afterEach(() => {
	for (const directory of temporaryDirectories) fs.rmSync(directory, { force: true, recursive: true });
	temporaryDirectories.clear();
});

async function evidenceModule(): Promise<Phase2jEvidenceModule> {
	const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "fixtures/phase-2j-webcrypto-evidence.js")).href;
	try {
		return (await import(/* @vite-ignore */ moduleUrl)) as Phase2jEvidenceModule;
	} catch (error) {
		throw new TypeError("Phase 2j evidence owner is not implemented", { cause: error });
	}
}

function probe(probeId: ProbeId, observedOutcome?: Outcome, exceptionName: null | string = null): Phase2jProbe {
	const fixed = {
		"ed25519": { algorithmName: "Ed25519", namedCurve: null, outcome: "non-extractable" },
		"ecdsa-p256": { algorithmName: "ECDSA", namedCurve: "P-256", outcome: "non-extractable" },
		"ecdsa-k256": { algorithmName: "ECDSA", namedCurve: "K-256", outcome: "unsupported" },
	} as const;
	const selected = fixed[probeId];
	const outcome = observedOutcome ?? selected.outcome;
	return {
		algorithmName: selected.algorithmName,
		exceptionName: outcome === "unsupported" ? "NotSupportedError" : exceptionName,
		failureKind: outcome === "unsupported" ? "not-supported" : outcome === "probe-error" ? "probe-error" : null,
		namedCurve: selected.namedCurve,
		observedOutcome: outcome,
		operation: "generateKey",
		probeId,
		requestedExtractable: false,
		requestedUsages: ["sign", "verify"],
	};
}

function record(
	projectId: ProjectId,
	options: Readonly<{
		browserVersion?: string;
		gitSha?: string;
		probeOverrides?: Partial<Record<ProbeId, Outcome>>;
		profileUserAgentMatch?: boolean;
		runId?: string;
		verdict?: "fail" | "pass";
	}> = {}
): Phase2jRecord {
	const mapping = {
		"chromium": {
			brand: "Playwright Chromium",
			emulated: false,
			engine: "chromium",
			evidenceClass: "desktop-playwright",
			profile: "Desktop Chrome",
		},
		"firefox": {
			brand: "Playwright Firefox",
			emulated: false,
			engine: "firefox",
			evidenceClass: "desktop-playwright",
			profile: "Desktop Firefox",
		},
		"webkit": {
			brand: "Playwright WebKit",
			emulated: false,
			engine: "webkit",
			evidenceClass: "desktop-playwright",
			profile: "Desktop Safari",
		},
		"ios-safari-emulation": {
			brand: "Playwright WebKit",
			emulated: true,
			engine: "webkit",
			evidenceClass: "desktop-engine-mobile-emulation",
			profile: "iPhone 15",
		},
		"android-chrome-emulation": {
			brand: "Playwright Chromium",
			emulated: true,
			engine: "chromium",
			evidenceClass: "desktop-engine-mobile-emulation",
			profile: "Pixel 7",
		},
	} as const;
	const selected = mapping[projectId];
	const probes = PROBE_IDS.map((probeId) => probe(probeId, options.probeOverrides?.[probeId]));
	const changed = probes.some(({ observedOutcome }, index) => {
		const expected = ["non-extractable", "non-extractable", "unsupported"] as const;
		return observedOutcome !== expected[index];
	});
	return {
		artifactKind: "ts-drp/webcrypto-capability-record/v1",
		device: {
			emulated: selected.emulated,
			profile: selected.profile,
			profileUserAgentMatch: options.profileUserAgentMatch ?? true,
			realDevice: false,
		},
		engine: {
			brand: selected.brand,
			browserVersion: options.browserVersion ?? "149.0.0",
			name: selected.engine,
			playwrightVersion: "1.61.1",
		},
		evidenceClass: selected.evidenceClass,
		gitSha: options.gitSha ?? GIT_SHA,
		os: { arch: "arm64", platform: "darwin", release: "25.6.0" },
		probes,
		projectId,
		runId: options.runId ?? RUN_ID,
		schemaVersion: 1,
		verdict: options.verdict ?? (changed ? "fail" : "pass"),
	};
}

function passingRecords(): readonly Phase2jRecord[] {
	return PROJECT_IDS.map((projectId) => record(projectId));
}

describe("Phase 2j probe and record contract RED", () => {
	it("classifies only a same-realm NotSupportedError as unsupported", async () => {
		const owner = await evidenceModule();
		const unsupported = new DOMException("not carried", "NotSupportedError");
		expect(owner.classifyPhase2jProbe({ domExceptionConstructor: DOMException, error: unsupported })).toEqual({
			exceptionName: "NotSupportedError",
			failureKind: "not-supported",
			observedOutcome: "unsupported",
		});

		class ForeignDOMException extends Error {
			public override readonly name = "NotSupportedError";
		}
		for (const error of [
			new ForeignDOMException("foreign-sensitive-message"),
			new DOMException("operation-sensitive-message", "OperationError"),
			new TypeError("K-256"),
		]) {
			const observed = owner.classifyPhase2jProbe({ domExceptionConstructor: DOMException, error });
			expect(observed.observedOutcome).toBe("probe-error");
			expect(observed.failureKind).toBe("probe-error");
			expect(observed.exceptionName).toBe(error.name);
			expect(JSON.stringify(observed)).not.toContain(error.message);
		}
	});

	it("classifies success from the returned private key and rejects malformed success", async () => {
		const owner = await evidenceModule();
		expect(
			owner.classifyPhase2jProbe({
				domExceptionConstructor: DOMException,
				keyPair: { privateKey: { extractable: false } },
			})
		).toEqual({ exceptionName: null, failureKind: null, observedOutcome: "non-extractable" });
		expect(
			owner.classifyPhase2jProbe({
				domExceptionConstructor: DOMException,
				keyPair: { privateKey: { extractable: true } },
			})
		).toEqual({ exceptionName: null, failureKind: null, observedOutcome: "extractable" });
		expect(owner.classifyPhase2jProbe({ domExceptionConstructor: DOMException, keyPair: {} }).observedOutcome).toBe(
			"probe-error"
		);
	});

	it("accepts only the exact closed schema, ordered probes and trusted five-row provenance", async () => {
		const owner = await evidenceModule();
		for (const projectId of PROJECT_IDS) {
			const valid = record(projectId);
			const observed = owner.validatePhase2jRecord(valid, { gitSha: GIT_SHA, projectId, runId: RUN_ID });
			expect(observed).toEqual({ errors: [], record: valid });
		}

		const ios = record("ios-safari-emulation");
		for (const mutant of [
			{ ...ios, device: { ...ios.device, emulated: false } },
			{ ...ios, device: { ...ios.device, profile: "Desktop Safari" } },
			{ ...ios, device: { ...ios.device, profileUserAgentMatch: false } },
			{ ...ios, device: { ...ios.device, realDevice: true } },
			{ ...ios, engine: { ...ios.engine, name: "chromium" } },
			{ ...ios, evidenceClass: "desktop-playwright" },
			{ ...ios, extra: true },
		]) {
			expect(
				owner.validatePhase2jRecord(mutant, {
					gitSha: GIT_SHA,
					projectId: "ios-safari-emulation",
					runId: RUN_ID,
				}).record
			).toBeNull();
		}
	});

	it("rejects stale identity and body-controlled expectations or verdicts", async () => {
		const owner = await evidenceModule();
		const base = record("chromium");
		for (const mutant of [
			{ ...base, gitSha: "b".repeat(40) },
			{ ...base, runId: `phase-2j/${GIT_SHA}/10000000-0000-4000-8000-000000000000` },
			{ ...base, projectId: "firefox" },
			{ ...base, expectedOutcome: "unsupported" },
			{ ...base, verdict: "fail" },
		]) {
			expect(
				owner.validatePhase2jRecord(mutant, { gitSha: GIT_SHA, projectId: "chromium", runId: RUN_ID }).record
			).toBeNull();
		}
	});
});

describe("Phase 2j aggregate contract RED", () => {
	it("passes only the exact complete five-by-three matrix in registry order", async () => {
		const owner = await evidenceModule();
		const observed = owner.aggregatePhase2j({ gitSha: GIT_SHA, records: passingRecords(), runId: RUN_ID });
		expect(observed).toEqual({
			artifactKind: "ts-drp/webcrypto-capability-matrix/v1",
			changedProbeIds: [],
			duplicateProjectIds: [],
			gitSha: GIT_SHA,
			invalidRecordIds: [],
			missingProjectIds: [],
			records: passingRecords(),
			requiredProbeIds: PROBE_IDS,
			requiredProjectIds: PROJECT_IDS,
			runId: RUN_ID,
			schemaVersion: 1,
			verdict: "pass",
		});
	});

	it("retains changed observations and fails both an improvement and regression", async () => {
		const owner = await evidenceModule();
		for (const changed of [
			record("android-chrome-emulation", { probeOverrides: { "ecdsa-k256": "extractable" } }),
			record("firefox", { probeOverrides: { ed25519: "extractable" } }),
			record("webkit", { probeOverrides: { "ecdsa-k256": "probe-error" } }),
		]) {
			const records = passingRecords().map((candidate) =>
				candidate.projectId === changed.projectId ? changed : candidate
			);
			const observed = owner.aggregatePhase2j({ gitSha: GIT_SHA, records, runId: RUN_ID });
			expect(observed.verdict).toBe("fail");
			expect(observed.changedProbeIds).toEqual([
				`${changed.projectId}/${
					changed.probes.find(({ observedOutcome }, index) => {
						const expected = ["non-extractable", "non-extractable", "unsupported"] as const;
						return observedOutcome !== expected[index];
					})?.probeId
				}`,
			]);
			expect(observed.records.find(({ projectId }) => projectId === changed.projectId)).toEqual(changed);
		}
	});

	it("excludes invalid and duplicate records while reporting bounded diagnostics", async () => {
		const owner = await evidenceModule();
		const invalid = { ...record("firefox"), gitSha: "b".repeat(40) };
		const observed = owner.aggregatePhase2j({
			duplicateProjectIds: ["webkit", "webkit"],
			gitSha: GIT_SHA,
			records: passingRecords().map((candidate) => (candidate.projectId === "firefox" ? invalid : candidate)),
			runId: RUN_ID,
		});
		expect(observed.verdict).toBe("fail");
		expect(observed.duplicateProjectIds).toEqual(["webkit"]);
		expect(observed.invalidRecordIds).toEqual(["firefox", "webkit"]);
		expect(observed.missingProjectIds).toEqual(["firefox", "webkit"]);
		expect(observed.records.map(({ projectId }) => projectId)).toEqual([
			"chromium",
			"ios-safari-emulation",
			"android-chrome-emulation",
		]);
	});

	it("requires a closed current aggregate and permits build strings to change", async () => {
		const owner = await evidenceModule();
		const aggregate = owner.aggregatePhase2j({
			gitSha: GIT_SHA,
			records: PROJECT_IDS.map((projectId, index) => record(projectId, { browserVersion: `build-${index}` })),
			runId: RUN_ID,
		});
		expect(aggregate.verdict).toBe("pass");
		expect(owner.consumeCurrentPhase2jAggregate(aggregate, { gitSha: GIT_SHA, runId: RUN_ID })).toEqual(aggregate);
		for (const mutant of [
			undefined,
			{ ...aggregate, extra: true },
			{ ...aggregate, artifactKind: "ts-drp/ahe-storage-validation/v1" },
			{ ...aggregate, schemaVersion: 2 },
			{ ...aggregate, gitSha: "b".repeat(40) },
			{ ...aggregate, runId: `phase-2j/${GIT_SHA}/10000000-0000-4000-8000-000000000000` },
		]) {
			expect(() => owner.consumeCurrentPhase2jAggregate(mutant, { gitSha: GIT_SHA, runId: RUN_ID })).toThrow();
		}
	});
});

describe("Phase 2j fixed-path publication RED", () => {
	it("removes stale stable evidence, creates a fresh closure-held run and finalizes partial runs", async () => {
		const ownerModule = await evidenceModule();
		const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2j-red-"));
		temporaryDirectories.add(temporary);
		const outputBase = path.join(temporary, "phase-2j");
		fs.mkdirSync(outputBase);
		const aggregatePath = path.join(outputBase, "webcrypto-capability-matrix.json");
		fs.writeFileSync(aggregatePath, '{"verdict":"pass","stale":true}\n', "utf8");

		const owner = ownerModule.preparePhase2jPublication({ gitSha: GIT_SHA, outputBase, uuid: UUID });
		expect(fs.existsSync(aggregatePath)).toBe(false);
		expect(owner.layout).toMatchObject({ aggregatePath, gitSha: GIT_SHA, runId: RUN_ID });
		owner.publish("chromium", record("chromium"));
		const partial = owner.finalize();
		expect(partial.verdict).toBe("fail");
		expect(partial.missingProjectIds).toEqual(PROJECT_IDS.slice(1));
		expect(JSON.parse(fs.readFileSync(aggregatePath, "utf8"))).toEqual(partial);
	});

	it("publishes create-only, preserves first bytes and excludes a duplicated identity", async () => {
		const ownerModule = await evidenceModule();
		const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2j-red-"));
		temporaryDirectories.add(temporary);
		const owner = ownerModule.preparePhase2jPublication({
			gitSha: GIT_SHA,
			outputBase: path.join(temporary, "phase-2j"),
			uuid: UUID,
		});
		const first = record("chromium", { browserVersion: "first" });
		owner.publish("chromium", first);
		const recordPath = path.join(owner.layout.runRoot, "records/chromium.json");
		const firstBytes = fs.readFileSync(recordPath);
		expect(() => owner.publish("chromium", record("chromium", { browserVersion: "second" }))).toThrow();
		expect(fs.readFileSync(recordPath)).toEqual(firstBytes);
		expect(fs.existsSync(path.join(owner.layout.runRoot, "duplicates/chromium.duplicate.json"))).toBe(true);
		const aggregate = owner.finalize();
		expect(aggregate.duplicateProjectIds).toEqual(["chromium"]);
		expect(aggregate.invalidRecordIds).toEqual(["chromium"]);
		expect(aggregate.missingProjectIds).toContain("chromium");
		expect(aggregate.records).not.toContainEqual(first);
	});

	it("reads only the five record and five duplicate paths and refuses stale write identity", async () => {
		const ownerModule = await evidenceModule();
		const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2j-red-"));
		temporaryDirectories.add(temporary);
		const owner = ownerModule.preparePhase2jPublication({
			gitSha: GIT_SHA,
			outputBase: path.join(temporary, "phase-2j"),
			uuid: UUID,
		});
		for (const projectId of PROJECT_IDS) owner.publish(projectId, record(projectId));
		fs.writeFileSync(path.join(owner.layout.runRoot, "untrusted-pass.json"), '{"verdict":"pass"}\n', "utf8");
		fs.mkdirSync(path.join(owner.layout.runRoot, "records/untrusted"));
		expect(owner.finalize().verdict).toBe("pass");

		const staleOwner = ownerModule.preparePhase2jPublication({
			gitSha: GIT_SHA,
			outputBase: path.join(temporary, "phase-2j-stale"),
			uuid: "10000000-0000-4000-8000-000000000000",
		});
		staleOwner.publish("chromium", record("chromium", { runId: RUN_ID }));
		expect(staleOwner.finalize().invalidRecordIds).toEqual(["chromium"]);
	});
});
