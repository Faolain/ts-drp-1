import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { phase2hStableEvidenceJson } from "./phase-2h-a-evidence-digest.js";
import { type Phase2hValidationRecord, validatePhase2hRecord } from "./phase-2h-a-record.js";
import {
	type Phase2hEngineName,
	phase2hTuple,
	PHASE_2H_ENGINES,
	PHASE_2H_KILL_TUPLE_IDS,
	PHASE_2H_REQUIRED_TUPLE_IDS,
} from "./phase-2h-a-registry.js";

export const PHASE_2H_SCOPES = Object.freeze([
	"run-root",
	"records-root",
	"collisions-root",
	"records/chromium",
	"records/firefox",
	"records/webkit",
	"collisions/chromium",
	"collisions/firefox",
	"collisions/webkit",
] as const);
export type Phase2hScope = (typeof PHASE_2H_SCOPES)[number];

export const PHASE_2H_ENTRY_REASONS = Object.freeze([
	"wrong-layout",
	"subdirectory",
	"nonregular",
	"overlong-name",
	"invalid-name-utf8",
	"nonascii-encoded-name",
	"wrong-extension",
	"malformed-percent",
	"invalid-identity-utf8",
	"empty-identity",
	"overlong-identity",
	"invalid-collision-marker",
	"record-attempt-bound",
	"directory-entry-bound",
] as const);
export type Phase2hEntryReason = (typeof PHASE_2H_ENTRY_REASONS)[number];

export type Phase2hDiagnosticIdentity = string;
export type Phase2hRawEntryKind = "directory" | "fifo" | "file" | "other" | "socket" | "symlink";

export interface Phase2hRawEntry {
	readonly basename: Uint8Array;
	readonly body?: Uint8Array;
	readonly bodyDisposition?: "overlong" | "read-failed";
	readonly kind: Phase2hRawEntryKind;
	readonly scope: Phase2hScope;
}

export interface Phase2hSubmissionCensus {
	readonly duplicateIdentities: readonly Phase2hDiagnosticIdentity[];
	readonly invalidIdentities: readonly Phase2hDiagnosticIdentity[];
}

export interface Phase2hAggregate {
	readonly artifactKind: "ts-drp/ahe-storage-validation/v1";
	readonly duplicateTupleIds: readonly Phase2hDiagnosticIdentity[];
	readonly extraTupleIds: readonly Phase2hDiagnosticIdentity[];
	readonly gitSha: string;
	readonly invalidRecordIds: readonly Phase2hDiagnosticIdentity[];
	readonly missingKillPoints: readonly string[];
	readonly missingTupleIds: readonly string[];
	readonly records: readonly Phase2hValidationRecord[];
	readonly requiredTupleIds: readonly string[];
	readonly runId: string;
	readonly schemaVersion: 1;
	readonly verdict: "fail" | "pass";
}

export interface Phase2hAggregationInput {
	readonly census?: Phase2hSubmissionCensus;
	readonly directoryEntryOverflow?: boolean;
	readonly entries: readonly Phase2hRawEntry[];
	readonly gitSha: string;
	readonly runId: string;
}

export interface Phase2hRunScan {
	readonly directoryEntryOverflow: boolean;
	readonly entries: readonly Phase2hRawEntry[];
}

interface AttributedRecord {
	readonly canonical: boolean;
	readonly diagnosticIdentity: Phase2hDiagnosticIdentity;
	readonly invalid: boolean;
	readonly record: Phase2hValidationRecord | null;
}

interface DecodedFilename {
	readonly canonical: boolean;
	readonly diagnosticIdentity: Phase2hDiagnosticIdentity;
	readonly extra: boolean;
	readonly requiredTupleId: string | null;
}

const STRUCTURAL = Object.freeze({
	"collisions-root": Object.freeze(["chromium", "firefox", "webkit"]),
	"records-root": Object.freeze(["chromium", "firefox", "webkit"]),
	"run-root": Object.freeze(["records", "collisions"]),
} as const);

const PROJECT_BY_SCOPE = Object.freeze({
	"records/chromium": "chromium",
	"records/firefox": "firefox",
	"records/webkit": "webkit",
} as const satisfies Readonly<Record<`records/${Phase2hEngineName}`, Phase2hEngineName>>);

const RECORD_BODY_LIMIT = 4_194_304;
const RAW_NAME_LIMIT = 512;
const DECODED_IDENTITY_LIMIT = 512;
const ENTRY_LIMIT = 1_024;
const ENTRY_TAG = new TextEncoder().encode("ts-drp/phase-2h-diagnostic-entry/v1\0");
const EXTRA_TAG = new TextEncoder().encode("ts-drp/phase-2h-diagnostic-extra/v1\0");
const NUL = Uint8Array.of(0);

function bytes(...parts: readonly Uint8Array[]): Uint8Array {
	const length = parts.reduce((total, part) => total + part.byteLength, 0);
	const result = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function digest(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function compareRaw(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.byteLength, right.byteLength);
	for (let index = 0; index < length; index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return left.byteLength - right.byteLength;
}

function compareText(left: string, right: string): number {
	return compareRaw(utf8(left), utf8(right));
}

function sortedUnique(values: Iterable<string>): readonly string[] {
	return Object.freeze([...new Set(values)].sort(compareText));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function scopeIndex(scope: Phase2hScope): number {
	return PHASE_2H_SCOPES.indexOf(scope);
}

function entryIdentity(reason: Phase2hEntryReason, scope: Phase2hScope, basename: Uint8Array): string {
	return `entry-${reason}-sha256:${digest(bytes(ENTRY_TAG, utf8(reason), NUL, utf8(scope), NUL, basename))}`;
}

/**
 * Computes the exact global overflow diagnostic identity.
 * @param reason - One of the two bounded-overflow reasons.
 * @param runId - Current invocation RunId.
 * @returns Closed bounded identity with the frozen NUL-separated preimage.
 */
export function phase2hOverflowIdentity(
	reason: "directory-entry-bound" | "record-attempt-bound",
	runId: string
): Phase2hDiagnosticIdentity {
	return `entry-${reason}-sha256:${digest(bytes(ENTRY_TAG, utf8(reason), NUL, utf8("run-root"), NUL, utf8(runId)))}`;
}

/**
 * Computes one registry-nonmember identity without exposing its raw spelling.
 * @param decoded - Successfully decoded bounded identity.
 * @returns Domain-separated bounded extra identity.
 */
export function phase2hExtraIdentity(decoded: string): Phase2hDiagnosticIdentity {
	return `extra-sha256:${digest(bytes(EXTRA_TAG, utf8(decoded)))}`;
}

/**
 * Exercises the defensive decoded-identity length branch directly.
 * @param decoded - Already decoded identity from the seam.
 * @returns The defensive reason, or null for a bounded nonempty identity.
 */
export function phase2hDecodedIdentityReason(decoded: string): "empty-identity" | "overlong-identity" | null {
	if (decoded.length === 0) return "empty-identity";
	return utf8(decoded).byteLength > DECODED_IDENTITY_LIMIT ? "overlong-identity" : null;
}

function fallback(reason: Phase2hEntryReason, entry: Phase2hRawEntry): DecodedFilename {
	return Object.freeze({
		canonical: false,
		diagnosticIdentity: entryIdentity(reason, entry.scope, entry.basename),
		extra: false,
		requiredTupleId: null,
	});
}

function decodeFilename(entry: Phase2hRawEntry): DecodedFilename {
	if (entry.basename.byteLength > RAW_NAME_LIMIT) return fallback("overlong-name", entry);
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true }).decode(entry.basename);
	} catch {
		return fallback("invalid-name-utf8", entry);
	}
	if ([...raw].some((character) => character.charCodeAt(0) > 0x7f)) return fallback("nonascii-encoded-name", entry);
	if (!raw.endsWith(".json")) return fallback("wrong-extension", entry);
	const stem = raw.slice(0, -5);
	if (/%(?![0-9a-fA-F]{2})/u.test(stem)) return fallback("malformed-percent", entry);
	let decoded: string;
	try {
		decoded = decodeURIComponent(stem);
	} catch {
		return fallback("invalid-identity-utf8", entry);
	}
	const decodedReason = phase2hDecodedIdentityReason(decoded);
	if (decodedReason !== null) return fallback(decodedReason, entry);
	const tuple = phase2hTuple(decoded);
	const diagnosticIdentity = tuple === undefined ? phase2hExtraIdentity(decoded) : tuple.tupleId;
	return Object.freeze({
		canonical: `${encodeURIComponent(decoded)}.json` === raw,
		diagnosticIdentity,
		extra: tuple === undefined,
		requiredTupleId: tuple?.tupleId ?? null,
	});
}

function structuralDisposition(entry: Phase2hRawEntry): Phase2hEntryReason | "structural" | null {
	if (entry.scope !== "run-root" && entry.scope !== "records-root" && entry.scope !== "collisions-root") return null;
	let name: string;
	try {
		name = new TextDecoder("utf-8", { fatal: true }).decode(entry.basename);
	} catch {
		return "wrong-layout";
	}
	const expected = STRUCTURAL[entry.scope];
	if (!(expected as readonly string[]).includes(name)) return "wrong-layout";
	return entry.kind === "directory" ? "structural" : "nonregular";
}

function projectScope(scope: Phase2hScope): Phase2hEngineName | undefined {
	return Reflect.get(PROJECT_BY_SCOPE, scope) as Phase2hEngineName | undefined;
}

function bodyValue(entry: Phase2hRawEntry): unknown {
	if (
		entry.bodyDisposition !== undefined ||
		entry.body === undefined ||
		entry.body.byteLength === 0 ||
		entry.body.byteLength > RECORD_BODY_LIMIT
	)
		return undefined;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(entry.body);
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function attributedRecord(
	entry: Phase2hRawEntry,
	filename: DecodedFilename,
	gitSha: string,
	runId: string
): AttributedRecord {
	const project = projectScope(entry.scope);
	if (
		project === undefined ||
		entry.kind !== "file" ||
		filename.requiredTupleId === null ||
		filename.extra ||
		!filename.canonical
	)
		return Object.freeze({
			canonical: filename.canonical,
			diagnosticIdentity: filename.diagnosticIdentity,
			invalid: true,
			record: null,
		});
	const value = bodyValue(entry);
	if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
		return Object.freeze({
			canonical: true,
			diagnosticIdentity: filename.diagnosticIdentity,
			invalid: true,
			record: null,
		});
	}
	const claimedTupleId = Reflect.get(value, "tupleId");
	if (claimedTupleId !== filename.requiredTupleId) {
		return Object.freeze({
			canonical: true,
			diagnosticIdentity: filename.diagnosticIdentity,
			invalid: true,
			record: null,
		});
	}
	const validation = validatePhase2hRecord(value, { gitSha, project, runId });
	return Object.freeze({
		canonical: true,
		diagnosticIdentity: filename.diagnosticIdentity,
		invalid: validation.record === null || validation.record.verdict !== "pass",
		record: validation.record,
	});
}

function diagnosticIdentity(value: unknown): value is Phase2hDiagnosticIdentity {
	return (
		(typeof value === "string" && phase2hTuple(value) !== undefined) ||
		(typeof value === "string" && /^extra-sha256:[0-9a-f]{64}$/u.test(value)) ||
		(typeof value === "string" && /^entry-[a-z-]+-sha256:[0-9a-f]{64}$/u.test(value))
	);
}

function collisionMarkerDigest(basename: Uint8Array): string | null {
	let name: string;
	try {
		name = new TextDecoder("utf-8", { fatal: true }).decode(basename);
	} catch {
		return null;
	}
	return /^([0-9a-f]{64})\.collision\.json$/u.exec(name)?.[1] ?? null;
}

function collisionMarker(entry: Phase2hRawEntry, gitSha: string, runId: string): Phase2hDiagnosticIdentity | undefined {
	if (entry.kind !== "file") return undefined;
	const markerDigest = collisionMarkerDigest(entry.basename);
	const value = bodyValue(entry);
	const project = entry.scope.startsWith("collisions/") ? entry.scope.slice("collisions/".length) : "";
	if (
		markerDigest === null ||
		(project !== "chromium" && project !== "firefox" && project !== "webkit") ||
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).sort().join("\0") !== "artifactKind\0diagnosticIdentity\0gitSha\0project\0runId\0schemaVersion"
	)
		return undefined;
	const marker = value as Record<string, unknown>;
	if (
		marker.schemaVersion !== 1 ||
		marker.artifactKind !== "ts-drp/ahe-storage-validation-collision/v1" ||
		marker.gitSha !== gitSha ||
		marker.runId !== runId ||
		marker.project !== project ||
		!diagnosticIdentity(marker.diagnosticIdentity) ||
		digest(utf8(marker.diagnosticIdentity)) !== markerDigest
	)
		return undefined;
	return marker.diagnosticIdentity;
}

/**
 * Returns the exact eight structural directory entries for synthetic scanner fixtures.
 * @returns Frozen raw-entry topology.
 */
export function phase2hStructuralEntries(): readonly Phase2hRawEntry[] {
	const encoder = new TextEncoder();
	return Object.freeze([
		...STRUCTURAL["run-root"].map((name) => ({
			basename: encoder.encode(name),
			kind: "directory" as const,
			scope: "run-root" as const,
		})),
		...STRUCTURAL["records-root"].map((name) => ({
			basename: encoder.encode(name),
			kind: "directory" as const,
			scope: "records-root" as const,
		})),
		...STRUCTURAL["collisions-root"].map((name) => ({
			basename: encoder.encode(name),
			kind: "directory" as const,
			scope: "collisions-root" as const,
		})),
	]);
}

function requireStructuralDirectories(entries: readonly Phase2hRawEntry[]): void {
	for (const [scope, names] of Object.entries(STRUCTURAL) as readonly [keyof typeof STRUCTURAL, readonly string[]][]) {
		for (const name of names) {
			const encoded = utf8(name);
			const matches = entries.filter((entry) => entry.scope === scope && compareRaw(entry.basename, encoded) === 0);
			if (matches.length !== 1 || matches[0]?.kind !== "directory") {
				throw new TypeError(`Phase 2h expected structural directory is absent or invalid: ${scope}/${name}`);
			}
		}
	}
}

/**
 * Aggregates one bounded raw-entry census into the closed Phase 2h artifact.
 * @param input - Current invocation identity, entries and publisher census.
 * @returns Closed pass/fail aggregate.
 */
export function aggregatePhase2h(input: Phase2hAggregationInput): Phase2hAggregate {
	requireStructuralDirectories(input.entries);
	const entries = [...input.entries].sort((left, right) => {
		const scopeDifference = scopeIndex(left.scope) - scopeIndex(right.scope);
		return scopeDifference === 0 ? compareRaw(left.basename, right.basename) : scopeDifference;
	});
	const invalid = new Set<Phase2hDiagnosticIdentity>(input.census?.invalidIdentities ?? []);
	const duplicate = new Set<Phase2hDiagnosticIdentity>(input.census?.duplicateIdentities ?? []);
	const extra = new Set<Phase2hDiagnosticIdentity>();
	const markerDuplicates = new Set<Phase2hDiagnosticIdentity>();
	const attributions = new Map<Phase2hDiagnosticIdentity, number>();
	const candidates = new Map<string, Phase2hValidationRecord[]>();
	let nonStructuralCount = 0;

	for (const entry of entries) {
		const structural = structuralDisposition(entry);
		if (structural === "structural") continue;
		if (structural !== null) {
			nonStructuralCount += 1;
			if (nonStructuralCount > ENTRY_LIMIT) break;
			invalid.add(entryIdentity(structural, entry.scope, entry.basename));
			continue;
		}
		nonStructuralCount += 1;
		if (nonStructuralCount > ENTRY_LIMIT) break;
		if (entry.scope.startsWith("collisions/")) {
			const markerIdentity = collisionMarker(entry, input.gitSha, input.runId);
			if (markerIdentity === undefined)
				invalid.add(entryIdentity("invalid-collision-marker", entry.scope, entry.basename));
			else markerDuplicates.add(markerIdentity);
			continue;
		}
		if (entry.kind === "directory") {
			invalid.add(entryIdentity("subdirectory", entry.scope, entry.basename));
			continue;
		}
		if (entry.kind !== "file") {
			invalid.add(entryIdentity("nonregular", entry.scope, entry.basename));
			continue;
		}
		const filename = decodeFilename(entry);
		attributions.set(filename.diagnosticIdentity, (attributions.get(filename.diagnosticIdentity) ?? 0) + 1);
		if (filename.extra) extra.add(filename.diagnosticIdentity);
		const attributed = attributedRecord(entry, filename, input.gitSha, input.runId);
		if (attributed.invalid || filename.extra || filename.requiredTupleId === null)
			invalid.add(filename.diagnosticIdentity);
		if (attributed.record !== null && attributed.record.verdict === "pass" && !attributed.invalid) {
			const values = candidates.get(attributed.record.tupleId) ?? [];
			values.push(attributed.record);
			candidates.set(attributed.record.tupleId, values);
		}
	}

	if (nonStructuralCount > ENTRY_LIMIT || input.directoryEntryOverflow === true)
		invalid.add(phase2hOverflowIdentity("directory-entry-bound", input.runId));
	for (const [identity, count] of attributions) if (count >= 2) duplicate.add(identity);
	for (const identity of markerDuplicates) duplicate.add(identity);
	for (const identity of duplicate) invalid.add(identity);

	const accepted = new Map<string, Phase2hValidationRecord>();
	for (const tupleId of PHASE_2H_REQUIRED_TUPLE_IDS) {
		const values = candidates.get(tupleId) ?? [];
		const [only] = values;
		if (values.length === 1 && only !== undefined && !invalid.has(tupleId) && !duplicate.has(tupleId))
			accepted.set(tupleId, only);
	}

	for (const engine of PHASE_2H_ENGINES) {
		const capacity = accepted.get(`capacity/${engine}`);
		if (capacity === undefined) continue;
		for (const [tupleId, record] of [...accepted]) {
			if (
				record.engine.name === engine &&
				(record.webLocksMode !== capacity.webLocksMode || record.persistenceMode !== capacity.persistenceMode)
			) {
				accepted.delete(tupleId);
				invalid.add(tupleId);
			}
		}
	}

	for (const engine of PHASE_2H_ENGINES) {
		const processRecords: [string, Phase2hValidationRecord][] = [];
		const armingMeasurements = new Set<string>();
		for (const entry of accepted) {
			const [, record] = entry;
			if (record.engine.name !== engine || record.hardKillEvidence === null) continue;
			processRecords.push(entry);
			armingMeasurements.add(phase2hStableEvidenceJson(record.hardKillEvidence.armingMeasurement));
		}
		if (armingMeasurements.size <= 1) continue;
		for (const [tupleId] of processRecords) {
			accepted.delete(tupleId);
			invalid.add(tupleId);
		}
	}

	const records = Object.freeze(
		PHASE_2H_REQUIRED_TUPLE_IDS.flatMap((tupleId) => {
			const record = accepted.get(tupleId);
			return record === undefined ? [] : [record];
		})
	);
	const missingTupleIds = sortedUnique(PHASE_2H_REQUIRED_TUPLE_IDS.filter((tupleId) => !accepted.has(tupleId)));
	const missingKillPoints = sortedUnique(PHASE_2H_KILL_TUPLE_IDS.filter((tupleId) => !accepted.has(tupleId)));
	const duplicateTupleIds = sortedUnique(duplicate);
	const extraTupleIds = sortedUnique(extra);
	const invalidRecordIds = sortedUnique(invalid);
	const verdict =
		records.length === 69 &&
		missingTupleIds.length === 0 &&
		missingKillPoints.length === 0 &&
		duplicateTupleIds.length === 0 &&
		extraTupleIds.length === 0 &&
		invalidRecordIds.length === 0
			? "pass"
			: "fail";
	return Object.freeze({
		artifactKind: "ts-drp/ahe-storage-validation/v1",
		duplicateTupleIds,
		extraTupleIds,
		gitSha: input.gitSha,
		invalidRecordIds,
		missingKillPoints,
		missingTupleIds,
		records,
		requiredTupleIds: PHASE_2H_REQUIRED_TUPLE_IDS,
		runId: input.runId,
		schemaVersion: 1,
		verdict,
	});
}

/**
 * Requires a present aggregate bound to the current invocation.
 * @param value - Parsed aggregate or absence.
 * @param current - Trusted current GitSha and RunId.
 * @returns The bound aggregate.
 */
export function consumeCurrentPhase2hAggregate(
	value: unknown,
	current: Readonly<{ gitSha: string; runId: string }>
): Phase2hAggregate {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).sort().join("\0") !==
			"artifactKind\0duplicateTupleIds\0extraTupleIds\0gitSha\0invalidRecordIds\0missingKillPoints\0missingTupleIds\0records\0requiredTupleIds\0runId\0schemaVersion\0verdict"
	)
		throw new TypeError("current Phase 2h aggregate is absent or not closed");
	const aggregate = value as Phase2hAggregate;
	if (
		aggregate.schemaVersion !== 1 ||
		aggregate.artifactKind !== "ts-drp/ahe-storage-validation/v1" ||
		aggregate.gitSha !== current.gitSha ||
		aggregate.runId !== current.runId ||
		!sameStrings(aggregate.requiredTupleIds, PHASE_2H_REQUIRED_TUPLE_IDS)
	)
		throw new TypeError("Phase 2h aggregate is stale or bound to another invocation");
	return aggregate;
}

function kind(stat: fs.Stats): Phase2hRawEntryKind {
	if (stat.isDirectory()) return "directory";
	if (stat.isFile()) return "file";
	if (stat.isSymbolicLink()) return "symlink";
	if (stat.isFIFO()) return "fifo";
	if (stat.isSocket()) return "socket";
	return "other";
}

const READ_CHUNK_SIZE = 64 * 1_024;

function listedNames(directory: string): readonly Buffer[] {
	return fs.readdirSync(directory, { encoding: "buffer" }).sort(compareRaw);
}

function entryPath(directory: string, basename: Uint8Array): Buffer {
	return Buffer.concat([Buffer.from(`${directory}${path.sep}`), Buffer.from(basename)]);
}

function boundedBody(file: Buffer, observed: fs.Stats): Pick<Phase2hRawEntry, "body" | "bodyDisposition"> {
	if (observed.size > RECORD_BODY_LIMIT) return Object.freeze({ bodyDisposition: "overlong" });
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const opened = fs.fstatSync(descriptor);
		if (!opened.isFile()) return Object.freeze({ bodyDisposition: "read-failed" });
		if (opened.size > RECORD_BODY_LIMIT) return Object.freeze({ bodyDisposition: "overlong" });
		const chunks: Buffer[] = [];
		let total = 0;
		while (total <= RECORD_BODY_LIMIT) {
			const remaining = RECORD_BODY_LIMIT + 1 - total;
			const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_SIZE, remaining));
			const count = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null);
			if (count === 0) break;
			chunks.push(chunk.subarray(0, count));
			total += count;
		}
		if (total > RECORD_BODY_LIMIT) return Object.freeze({ bodyDisposition: "overlong" });
		return Object.freeze({ body: Uint8Array.from(Buffer.concat(chunks, total)) });
	} catch {
		return Object.freeze({ bodyDisposition: "read-failed" });
	} finally {
		if (descriptor !== undefined) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// The bounded read disposition is already fixed; close failure cannot make bytes valid.
			}
		}
	}
}

function shouldReadBody(entry: Phase2hRawEntry): boolean {
	if (entry.kind !== "file") return false;
	if (entry.scope.startsWith("collisions/")) return collisionMarkerDigest(entry.basename) !== null;
	const project = projectScope(entry.scope);
	if (project === undefined) return false;
	const filename = decodeFilename(entry);
	if (!filename.canonical || filename.extra || filename.requiredTupleId === null) return false;
	return phase2hTuple(filename.requiredTupleId)?.engine === project;
}

function liveEntry(scope: Phase2hScope, directory: string, basename: Buffer): Phase2hRawEntry {
	const complete = entryPath(directory, basename);
	const stat = fs.lstatSync(complete);
	const entry: Phase2hRawEntry = Object.freeze({
		basename: Uint8Array.from(basename),
		kind: kind(stat),
		scope,
	});
	if (!shouldReadBody(entry)) return entry;
	return Object.freeze({ ...entry, ...boundedBody(complete, stat) });
}

function scanResult(entries: readonly Phase2hRawEntry[], directoryEntryOverflow: boolean): Phase2hRunScan {
	return Object.freeze({ directoryEntryOverflow, entries: Object.freeze(entries) });
}

/**
 * Reads the exact nine-scope filesystem layout through raw basename bytes.
 * @param runRoot - Fresh current RunId root.
 * @returns Bounded raw-entry scanner input plus global overflow disposition.
 */
export function readPhase2hRunEntries(runRoot: string): Phase2hRunScan {
	const recordsRoot = path.join(runRoot, "records");
	const collisionsRoot = path.join(runRoot, "collisions");
	const structuralScopes = Object.freeze([
		Object.freeze({ directory: runRoot, scope: "run-root" as const }),
		Object.freeze({ directory: recordsRoot, scope: "records-root" as const }),
		Object.freeze({ directory: collisionsRoot, scope: "collisions-root" as const }),
	]);
	const listings = new Map<keyof typeof STRUCTURAL, readonly Buffer[]>();
	const entries: Phase2hRawEntry[] = [];

	for (const { directory, scope } of structuralScopes) {
		const names = listedNames(directory);
		listings.set(scope, names);
		for (const expected of STRUCTURAL[scope]) {
			const basename = names.find((candidate) => compareRaw(candidate, utf8(expected)) === 0);
			if (basename === undefined)
				throw new TypeError(`Phase 2h expected structural directory is absent or invalid: ${scope}/${expected}`);
			const stat = fs.lstatSync(entryPath(directory, basename));
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new TypeError(`Phase 2h expected structural directory is absent or invalid: ${scope}/${expected}`);
			entries.push(Object.freeze({ basename: Uint8Array.from(basename), kind: "directory" as const, scope }));
		}
	}

	let processed = 0;
	for (const { directory, scope } of structuralScopes) {
		const expected = STRUCTURAL[scope];
		for (const basename of listings.get(scope) ?? []) {
			if (expected.some((name) => compareRaw(basename, utf8(name)) === 0)) continue;
			if (processed >= ENTRY_LIMIT) return scanResult(entries, true);
			entries.push(liveEntry(scope, directory, basename));
			processed += 1;
		}
	}

	const projectScopes = [
		...PHASE_2H_ENGINES.map((project) => ({
			directory: path.join(recordsRoot, project),
			scope: `records/${project}` as const,
		})),
		...PHASE_2H_ENGINES.map((project) => ({
			directory: path.join(collisionsRoot, project),
			scope: `collisions/${project}` as const,
		})),
	] as const;
	for (const { directory, scope } of projectScopes) {
		for (const basename of listedNames(directory)) {
			if (processed >= ENTRY_LIMIT) return scanResult(entries, true);
			entries.push(liveEntry(scope, directory, basename));
			processed += 1;
		}
	}
	requireStructuralDirectories(entries);
	return scanResult(entries, false);
}
