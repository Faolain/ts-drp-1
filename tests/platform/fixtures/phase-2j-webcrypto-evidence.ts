import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PHASE_2J_PROJECT_IDS = Object.freeze([
	"chromium",
	"firefox",
	"webkit",
	"ios-safari-emulation",
	"android-chrome-emulation",
] as const);
export type Phase2jProjectId = (typeof PHASE_2J_PROJECT_IDS)[number];

export const PHASE_2J_PROBE_IDS = Object.freeze(["ed25519", "ecdsa-p256", "ecdsa-k256"] as const);
export type Phase2jProbeId = (typeof PHASE_2J_PROBE_IDS)[number];
export type Phase2jOutcome = "extractable" | "non-extractable" | "probe-error" | "unsupported";

export interface Phase2jProbeObservation {
	readonly exceptionName: null | string;
	readonly failureKind: "not-supported" | "probe-error" | null;
	readonly observedOutcome: Phase2jOutcome;
}

export interface Phase2jProbe extends Phase2jProbeObservation {
	readonly algorithmName: "ECDSA" | "Ed25519";
	readonly namedCurve: "K-256" | "P-256" | null;
	readonly operation: "generateKey";
	readonly probeId: Phase2jProbeId;
	readonly requestedExtractable: false;
	readonly requestedUsages: readonly ["sign", "verify"];
}

export interface Phase2jRecord {
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
	readonly projectId: Phase2jProjectId;
	readonly runId: string;
	readonly schemaVersion: 1;
	readonly verdict: "fail" | "pass";
}

export interface Phase2jAggregate {
	readonly artifactKind: "ts-drp/webcrypto-capability-matrix/v1";
	readonly changedProbeIds: readonly string[];
	readonly duplicateProjectIds: readonly Phase2jProjectId[];
	readonly gitSha: string;
	readonly invalidRecordIds: readonly Phase2jProjectId[];
	readonly missingProjectIds: readonly Phase2jProjectId[];
	readonly records: readonly Phase2jRecord[];
	readonly requiredProbeIds: readonly Phase2jProbeId[];
	readonly requiredProjectIds: readonly Phase2jProjectId[];
	readonly runId: string;
	readonly schemaVersion: 1;
	readonly verdict: "fail" | "pass";
}

export interface Phase2jPublicationLayout {
	readonly aggregatePath: string;
	readonly gitSha: string;
	readonly outputBase: string;
	readonly runId: string;
	readonly runRoot: string;
}

export interface Phase2jPublicationOwner {
	readonly layout: Phase2jPublicationLayout;
	finalize(): Phase2jAggregate;
	publish(projectId: Phase2jProjectId, record: unknown): "accepted";
}

interface ProjectDescriptor {
	readonly brand: string;
	readonly emulated: boolean;
	readonly engineName: "chromium" | "firefox" | "webkit";
	readonly evidenceClass: "desktop-engine-mobile-emulation" | "desktop-playwright";
	readonly profile: string;
}

interface ProbeDescriptor {
	readonly algorithmName: "ECDSA" | "Ed25519";
	readonly expectedOutcome: "non-extractable" | "unsupported";
	readonly namedCurve: "K-256" | "P-256" | null;
}

const PROJECTS = Object.freeze({
	"chromium": Object.freeze({
		brand: "Playwright Chromium",
		emulated: false,
		engineName: "chromium",
		evidenceClass: "desktop-playwright",
		profile: "Desktop Chrome",
	}),
	"firefox": Object.freeze({
		brand: "Playwright Firefox",
		emulated: false,
		engineName: "firefox",
		evidenceClass: "desktop-playwright",
		profile: "Desktop Firefox",
	}),
	"webkit": Object.freeze({
		brand: "Playwright WebKit",
		emulated: false,
		engineName: "webkit",
		evidenceClass: "desktop-playwright",
		profile: "Desktop Safari",
	}),
	"ios-safari-emulation": Object.freeze({
		brand: "Playwright WebKit",
		emulated: true,
		engineName: "webkit",
		evidenceClass: "desktop-engine-mobile-emulation",
		profile: "iPhone 15",
	}),
	"android-chrome-emulation": Object.freeze({
		brand: "Playwright Chromium",
		emulated: true,
		engineName: "chromium",
		evidenceClass: "desktop-engine-mobile-emulation",
		profile: "Pixel 7",
	}),
} as const satisfies Readonly<Record<Phase2jProjectId, ProjectDescriptor>>);

const PROBES = Object.freeze({
	"ed25519": Object.freeze({ algorithmName: "Ed25519", expectedOutcome: "non-extractable", namedCurve: null }),
	"ecdsa-p256": Object.freeze({ algorithmName: "ECDSA", expectedOutcome: "non-extractable", namedCurve: "P-256" }),
	"ecdsa-k256": Object.freeze({ algorithmName: "ECDSA", expectedOutcome: "unsupported", namedCurve: "K-256" }),
} as const satisfies Readonly<Record<Phase2jProbeId, ProbeDescriptor>>);

const RECORD_KEYS = Object.freeze([
	"artifactKind",
	"device",
	"engine",
	"evidenceClass",
	"gitSha",
	"os",
	"probes",
	"projectId",
	"runId",
	"schemaVersion",
	"verdict",
]);
const DEVICE_KEYS = Object.freeze(["emulated", "profile", "profileUserAgentMatch", "realDevice"]);
const ENGINE_KEYS = Object.freeze(["brand", "browserVersion", "name", "playwrightVersion"]);
const OS_KEYS = Object.freeze(["arch", "platform", "release"]);
const PROBE_KEYS = Object.freeze([
	"algorithmName",
	"exceptionName",
	"failureKind",
	"namedCurve",
	"observedOutcome",
	"operation",
	"probeId",
	"requestedExtractable",
	"requestedUsages",
]);
const AGGREGATE_KEYS = Object.freeze([
	"artifactKind",
	"changedProbeIds",
	"duplicateProjectIds",
	"gitSha",
	"invalidRecordIds",
	"missingProjectIds",
	"records",
	"requiredProbeIds",
	"requiredProjectIds",
	"runId",
	"schemaVersion",
	"verdict",
]);
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TEXT_LIMIT = 256;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const required = [...expected].sort();
	return keys.length === required.length && keys.every((key, index) => key === required[index]);
}

function isBoundedText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= TEXT_LIMIT;
}

function isProjectId(value: unknown): value is Phase2jProjectId {
	return typeof value === "string" && (PHASE_2J_PROJECT_IDS as readonly string[]).includes(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function orderedProjectIds(values: Iterable<Phase2jProjectId>): readonly Phase2jProjectId[] {
	const set = new Set(values);
	return Object.freeze(PHASE_2J_PROJECT_IDS.filter((projectId) => set.has(projectId)));
}

function recordPath(layout: Phase2jPublicationLayout, projectId: Phase2jProjectId): string {
	return path.join(layout.runRoot, "records", `${projectId}.json`);
}

function duplicatePath(layout: Phase2jPublicationLayout, projectId: Phase2jProjectId): string {
	return path.join(layout.runRoot, "duplicates", `${projectId}.duplicate.json`);
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * Returns the exact checked-out commit used by this evidence invocation.
 * @param cwd - Repository root.
 * @returns Forty-character lowercase commit identity.
 */
export function phase2jGitSha(cwd: string): string {
	const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	if (!GIT_SHA_PATTERN.test(gitSha)) throw new TypeError("Phase 2j GitSha is malformed");
	return gitSha;
}

/**
 * Classifies a generateKey result without accepting cross-realm lookalikes as unsupported.
 * @param input - Same-realm constructor and either the returned pair or thrown value.
 * @returns Bounded capability observation.
 */
export function classifyPhase2jProbe(
	input: Readonly<{
		domExceptionConstructor: typeof DOMException;
		error?: unknown;
		keyPair?: unknown;
	}>
): Phase2jProbeObservation {
	if (input.error !== undefined) {
		if (input.error instanceof input.domExceptionConstructor && input.error.name === "NotSupportedError") {
			return Object.freeze({
				exceptionName: "NotSupportedError",
				failureKind: "not-supported",
				observedOutcome: "unsupported",
			});
		}
		const name = isObject(input.error) && isBoundedText(input.error.name) ? input.error.name : null;
		return Object.freeze({ exceptionName: name, failureKind: "probe-error", observedOutcome: "probe-error" });
	}
	if (
		isObject(input.keyPair) &&
		isObject(input.keyPair.privateKey) &&
		typeof input.keyPair.privateKey.extractable === "boolean"
	) {
		return Object.freeze({
			exceptionName: null,
			failureKind: null,
			observedOutcome: input.keyPair.privateKey.extractable ? "extractable" : "non-extractable",
		});
	}
	return Object.freeze({ exceptionName: null, failureKind: "probe-error", observedOutcome: "probe-error" });
}

function validProbe(value: unknown, probeId: Phase2jProbeId): value is Phase2jProbe {
	if (!isObject(value) || !hasExactKeys(value, PROBE_KEYS)) return false;
	const descriptor = PROBES[probeId];
	if (
		value.probeId !== probeId ||
		value.operation !== "generateKey" ||
		value.algorithmName !== descriptor.algorithmName ||
		value.namedCurve !== descriptor.namedCurve ||
		value.requestedExtractable !== false ||
		!Array.isArray(value.requestedUsages) ||
		!sameStrings(value.requestedUsages as string[], ["sign", "verify"])
	)
		return false;
	if (value.observedOutcome === "unsupported")
		return value.failureKind === "not-supported" && value.exceptionName === "NotSupportedError";
	if (value.observedOutcome === "probe-error")
		return value.failureKind === "probe-error" && (value.exceptionName === null || isBoundedText(value.exceptionName));
	if (value.observedOutcome === "extractable" || value.observedOutcome === "non-extractable")
		return value.failureKind === null && value.exceptionName === null;
	return false;
}

/**
 * Validates one exact record against setup/config-owned identity and expectations.
 * @param value - Untrusted candidate record.
 * @param expected - Setup/config-owned identity.
 * @returns Closed errors and the accepted record, if any.
 */
export function validatePhase2jRecord(
	value: unknown,
	expected: Readonly<{ gitSha: string; projectId: Phase2jProjectId; runId: string }>
): Readonly<{ errors: readonly string[]; record: Phase2jRecord | null }> {
	const errors: string[] = [];
	const fail = (reason: string): void => {
		if (errors.length < 16) errors.push(reason);
	};
	if (!isObject(value) || !hasExactKeys(value, RECORD_KEYS)) {
		fail("record-schema");
		return Object.freeze({ errors: Object.freeze(errors), record: null });
	}
	const descriptor = PROJECTS[expected.projectId];
	if (value.schemaVersion !== 1 || value.artifactKind !== "ts-drp/webcrypto-capability-record/v1") fail("identity");
	if (value.gitSha !== expected.gitSha || value.runId !== expected.runId || value.projectId !== expected.projectId)
		fail("run-identity");
	if (
		!isObject(value.engine) ||
		!hasExactKeys(value.engine, ENGINE_KEYS) ||
		value.engine.name !== descriptor.engineName ||
		value.engine.brand !== descriptor.brand ||
		!isBoundedText(value.engine.browserVersion) ||
		!isBoundedText(value.engine.playwrightVersion)
	)
		fail("engine");
	if (
		!isObject(value.os) ||
		!hasExactKeys(value.os, OS_KEYS) ||
		!(value.os.platform === "darwin" || value.os.platform === "linux") ||
		!(value.os.arch === "arm64" || value.os.arch === "x64") ||
		!isBoundedText(value.os.release)
	)
		fail("os");
	if (
		!isObject(value.device) ||
		!hasExactKeys(value.device, DEVICE_KEYS) ||
		value.device.profile !== descriptor.profile ||
		value.device.emulated !== descriptor.emulated ||
		value.device.realDevice !== false ||
		value.device.profileUserAgentMatch !== true
	)
		fail("device");
	if (value.evidenceClass !== descriptor.evidenceClass) fail("evidence-class");
	const candidateProbes = Array.isArray(value.probes) ? value.probes : [];
	if (
		!Array.isArray(value.probes) ||
		candidateProbes.length !== PHASE_2J_PROBE_IDS.length ||
		!PHASE_2J_PROBE_IDS.every((probeId, index) => validProbe(candidateProbes[index], probeId))
	)
		fail("probes");
	const probes = candidateProbes as readonly Phase2jProbe[];
	const changed =
		probes.length !== PHASE_2J_PROBE_IDS.length ||
		PHASE_2J_PROBE_IDS.some((probeId, index) => probes[index]?.observedOutcome !== PROBES[probeId].expectedOutcome);
	if (value.verdict !== (changed ? "fail" : "pass")) fail("verdict");
	return Object.freeze({
		errors: Object.freeze(errors),
		record: errors.length === 0 ? (value as unknown as Phase2jRecord) : null,
	});
}

function aggregateCandidates(
	input: Readonly<{
		candidates: readonly Readonly<{ projectId: Phase2jProjectId; value: unknown }>[];
		duplicateProjectIds?: readonly Phase2jProjectId[];
		gitSha: string;
		runId: string;
	}>
): Phase2jAggregate {
	const duplicateProjectIds = orderedProjectIds(input.duplicateProjectIds ?? []);
	const invalid = new Set<Phase2jProjectId>(duplicateProjectIds);
	const seen = new Set<Phase2jProjectId>();
	const validByProject = new Map<Phase2jProjectId, Phase2jRecord>();
	for (const candidate of input.candidates) {
		if (seen.has(candidate.projectId)) {
			invalid.add(candidate.projectId);
			validByProject.delete(candidate.projectId);
			continue;
		}
		seen.add(candidate.projectId);
		const validation = validatePhase2jRecord(candidate.value, {
			gitSha: input.gitSha,
			projectId: candidate.projectId,
			runId: input.runId,
		});
		if (validation.record === null) invalid.add(candidate.projectId);
		else validByProject.set(candidate.projectId, validation.record);
	}
	for (const projectId of duplicateProjectIds) validByProject.delete(projectId);
	const records = Object.freeze(
		PHASE_2J_PROJECT_IDS.flatMap((projectId) => {
			const record = validByProject.get(projectId);
			return record === undefined ? [] : [record];
		})
	);
	const invalidRecordIds = orderedProjectIds(invalid);
	const missingProjectIds = Object.freeze(PHASE_2J_PROJECT_IDS.filter((projectId) => !validByProject.has(projectId)));
	const changedProbeIds = Object.freeze(
		records.flatMap((record) =>
			record.probes.flatMap((probe, index) =>
				probe.observedOutcome === PROBES[PHASE_2J_PROBE_IDS[index] ?? "ed25519"].expectedOutcome
					? []
					: [`${record.projectId}/${probe.probeId}`]
			)
		)
	);
	const verdict =
		records.length === PHASE_2J_PROJECT_IDS.length &&
		missingProjectIds.length === 0 &&
		duplicateProjectIds.length === 0 &&
		invalidRecordIds.length === 0 &&
		changedProbeIds.length === 0 &&
		records.every((record) => record.verdict === "pass")
			? "pass"
			: "fail";
	return Object.freeze({
		artifactKind: "ts-drp/webcrypto-capability-matrix/v1",
		changedProbeIds,
		duplicateProjectIds,
		gitSha: input.gitSha,
		invalidRecordIds,
		missingProjectIds,
		records,
		requiredProbeIds: PHASE_2J_PROBE_IDS,
		requiredProjectIds: PHASE_2J_PROJECT_IDS,
		runId: input.runId,
		schemaVersion: 1,
		verdict,
	});
}

/**
 * Builds the closed aggregate without trusting body-owned expected values or verdicts.
 * @param input - Current identity, candidates and duplicate census.
 * @returns Derived closed aggregate.
 */
export function aggregatePhase2j(
	input: Readonly<{
		duplicateProjectIds?: readonly Phase2jProjectId[];
		gitSha: string;
		records: readonly unknown[];
		runId: string;
	}>
): Phase2jAggregate {
	const candidates: Array<Readonly<{ projectId: Phase2jProjectId; value: unknown }>> = [];
	const unknownByPosition = input.records.length === PHASE_2J_PROJECT_IDS.length;
	for (const [index, value] of input.records.entries()) {
		const claimed = isObject(value) && isProjectId(value.projectId) ? value.projectId : undefined;
		const projectId = claimed ?? (unknownByPosition ? PHASE_2J_PROJECT_IDS[index] : undefined);
		if (projectId !== undefined) candidates.push(Object.freeze({ projectId, value }));
	}
	return aggregateCandidates({ ...input, candidates });
}

/**
 * Requires a closed, current aggregate and verifies all derived fields.
 * @param value - Untrusted aggregate candidate.
 * @param current - Independently held current identity.
 * @returns Validated current aggregate.
 */
export function consumeCurrentPhase2jAggregate(
	value: unknown,
	current: Readonly<{ gitSha: string; runId: string }>
): Phase2jAggregate {
	if (!isObject(value) || !hasExactKeys(value, AGGREGATE_KEYS)) throw new TypeError("Phase 2j aggregate is not closed");
	if (
		value.schemaVersion !== 1 ||
		value.artifactKind !== "ts-drp/webcrypto-capability-matrix/v1" ||
		value.gitSha !== current.gitSha ||
		value.runId !== current.runId ||
		!Array.isArray(value.requiredProjectIds) ||
		!sameStrings(value.requiredProjectIds as string[], PHASE_2J_PROJECT_IDS) ||
		!Array.isArray(value.requiredProbeIds) ||
		!sameStrings(value.requiredProbeIds as string[], PHASE_2J_PROBE_IDS) ||
		!Array.isArray(value.records) ||
		!Array.isArray(value.missingProjectIds) ||
		!Array.isArray(value.duplicateProjectIds) ||
		!Array.isArray(value.invalidRecordIds) ||
		!Array.isArray(value.changedProbeIds)
	)
		throw new TypeError("Phase 2j aggregate identity is invalid");
	const expected = aggregatePhase2j({
		duplicateProjectIds: value.duplicateProjectIds.filter(isProjectId),
		gitSha: current.gitSha,
		records: value.records,
		runId: current.runId,
	});
	for (const field of ["changedProbeIds", "duplicateProjectIds", "invalidRecordIds", "missingProjectIds"] as const) {
		if (!sameStrings(value[field] as string[], expected[field])) throw new TypeError(`Phase 2j ${field} is invalid`);
	}
	if (value.verdict !== expected.verdict || JSON.stringify(value.records) !== JSON.stringify(expected.records))
		throw new TypeError("Phase 2j aggregate derivation is invalid");
	return value as unknown as Phase2jAggregate;
}

/**
 * Publishes one fixed-path record create-only and marks a duplicate without replacing first bytes.
 * @param layout - Setup-owned run layout.
 * @param projectId - Fixed project path selector.
 * @param record - Observation to publish.
 * @returns Accepted marker for the first publication.
 */
export function publishPhase2jRecord(
	layout: Phase2jPublicationLayout,
	projectId: Phase2jProjectId,
	record: unknown
): "accepted" {
	const target = recordPath(layout, projectId);
	try {
		fs.writeFileSync(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
		return "accepted";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const marker = Object.freeze({
			artifactKind: "ts-drp/webcrypto-capability-duplicate/v1",
			gitSha: layout.gitSha,
			projectId,
			runId: layout.runId,
			schemaVersion: 1,
		});
		try {
			fs.writeFileSync(duplicatePath(layout, projectId), `${JSON.stringify(marker)}\n`, {
				encoding: "utf8",
				flag: "wx",
			});
		} catch (markerError) {
			if ((markerError as NodeJS.ErrnoException).code !== "EEXIST") throw markerError;
		}
		throw new TypeError(`duplicate Phase 2j publication for ${projectId}`);
	}
}

/**
 * Creates one fresh fixed-path publication run and its closure-held finalizer.
 * @param input - Current commit, output root and optional deterministic test UUID.
 * @returns Create-only publisher and sole aggregate finalizer.
 */
export function preparePhase2jPublication(
	input: Readonly<{ gitSha: string; outputBase: string; uuid?: string }>
): Phase2jPublicationOwner {
	if (!GIT_SHA_PATTERN.test(input.gitSha)) throw new TypeError("Phase 2j GitSha is malformed");
	const uuid = input.uuid ?? randomUUID();
	if (!UUID_PATTERN.test(uuid)) throw new TypeError("Phase 2j UUID is not lowercase UUID-v4");
	const runId = `phase-2j/${input.gitSha}/${uuid}`;
	const layout = Object.freeze({
		aggregatePath: path.join(input.outputBase, "webcrypto-capability-matrix.json"),
		gitSha: input.gitSha,
		outputBase: input.outputBase,
		runId,
		runRoot: path.join(input.outputBase, runId),
	});
	fs.mkdirSync(input.outputBase, { recursive: true });
	fs.rmSync(layout.aggregatePath, { force: true });
	fs.mkdirSync(path.dirname(layout.runRoot), { recursive: true });
	fs.mkdirSync(layout.runRoot);
	fs.mkdirSync(path.join(layout.runRoot, "records"));
	fs.mkdirSync(path.join(layout.runRoot, "duplicates"));
	return Object.freeze({
		layout,
		finalize(): Phase2jAggregate {
			const candidates: Array<Readonly<{ projectId: Phase2jProjectId; value: unknown }>> = [];
			const duplicateProjectIds: Phase2jProjectId[] = [];
			for (const projectId of PHASE_2J_PROJECT_IDS) {
				const target = recordPath(layout, projectId);
				if (fs.existsSync(target)) candidates.push(Object.freeze({ projectId, value: readJson(target) }));
				if (fs.existsSync(duplicatePath(layout, projectId))) duplicateProjectIds.push(projectId);
			}
			const aggregate = aggregateCandidates({ candidates, duplicateProjectIds, gitSha: layout.gitSha, runId });
			fs.writeFileSync(layout.aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
			return aggregate;
		},
		publish(projectId: Phase2jProjectId, record: unknown): "accepted" {
			return publishPhase2jRecord(layout, projectId, record);
		},
	});
}

/**
 * Returns the trusted project descriptor without accepting a record-body selector.
 * @param projectId - Trusted config project identity.
 * @returns Fixed engine/profile provenance.
 */
export function phase2jProjectDescriptor(projectId: Phase2jProjectId): ProjectDescriptor {
	return PROJECTS[projectId];
}

/**
 * Returns the validator-owned expected outcome for one fixed probe.
 * @param probeId - Fixed probe identity.
 * @returns Algorithm input and expected outcome.
 */
export function phase2jProbeDescriptor(probeId: Phase2jProbeId): ProbeDescriptor {
	return PROBES[probeId];
}
