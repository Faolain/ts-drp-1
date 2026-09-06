import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PHASE_2E6_DECLARED_EDGES } from "./fixtures/phase-2e6-real-process-death-contract.js";
import {
	aggregatePhase2h,
	consumeCurrentPhase2hAggregate,
	type Phase2hAggregate,
	phase2hDecodedIdentityReason,
	phase2hExtraIdentity,
	phase2hOverflowIdentity,
	type Phase2hRawEntry,
	phase2hStructuralEntries,
	readPhase2hRunEntries,
} from "./fixtures/phase-2h-a-aggregate.js";
import {
	phase2hControlEntries,
	phase2hControlRecords,
	phase2hRecordEntry,
	PHASE_2H_CONTROL_BROWSER_VERSIONS,
	PHASE_2H_CONTROL_GIT_SHA,
	PHASE_2H_CONTROL_RUN_ID,
	PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
} from "./fixtures/phase-2h-a-controls.js";
import { createPhase2hPublisher, preparePhase2hRun } from "./fixtures/phase-2h-a-publication.js";
import { validatePhase2hRecord } from "./fixtures/phase-2h-a-record.js";
import type { Phase2hValidationRecord } from "./fixtures/phase-2h-a-record.js";
import {
	PHASE_2H_CONTRACT_EDGE_IDS,
	PHASE_2H_KILL_TUPLE_IDS,
	PHASE_2H_REQUIRED_TUPLE_IDS,
	PHASE_2H_TUPLES,
} from "./fixtures/phase-2h-a-registry.js";

type CoverageArea =
	| "aggregate"
	| "binding"
	| "diagnostic"
	| "filename"
	| "finite-bound"
	| "marker"
	| "publication"
	| "record"
	| "registry"
	| "topology";

const COVERAGE_LEDGER = Object.freeze([
	["registry", "18 authoritative edges project mechanically to 54 kill and 69 total tuples"],
	["record", "closed positive records and finite wrong-field/evidence mutants"],
	["aggregate", "inert, missing, pass-only, duplicate, extra, invalid and five-array pass predicate"],
	["binding", "current GitSha/RunId only; absent and stale aggregates fail"],
	["filename", "filename-owned attribution, canonical aliases, extension and portable raw-entry seam"],
	["diagnostic", "bounded domain-separated extra/entry/overflow identities with one NUL byte"],
	["topology", "nine scopes, structural precedence, missing directories fatal and collision grammar isolated"],
	["publication", "trusted project, create-only first bytes and one-attribution semantics"],
	["marker", "valid marker duplicate, invalid marker fallback and marker-write failure census"],
	["finite-bound", "513th attempt and 1,025th entry have one global run-root overflow identity"],
] as const satisfies readonly (readonly [CoverageArea, string])[]);

function compareUtf8(left: string, right: string): number {
	const leftBytes = new TextEncoder().encode(left);
	const rightBytes = new TextEncoder().encode(right);
	const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
	for (let index = 0; index < length; index++) {
		const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftBytes.byteLength - rightBytes.byteLength;
}

function ascendingUtf8(values: readonly string[]): readonly string[] {
	return Object.freeze([...values].sort(compareUtf8));
}

function aggregate(
	entries: readonly Phase2hRawEntry[],
	census?: Readonly<{ duplicateIdentities: readonly string[]; invalidIdentities: readonly string[] }>
): Phase2hAggregate {
	return aggregatePhase2h({
		browserVersions: PHASE_2H_CONTROL_BROWSER_VERSIONS,
		census,
		entries,
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		playwrightVersion: PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
		runId: PHASE_2H_CONTROL_RUN_ID,
	});
}

function controlRecord(tupleId: string): Phase2hValidationRecord {
	const record = phase2hControlRecords().find((candidate) => candidate.tupleId === tupleId);
	if (record === undefined) throw new TypeError(`missing control record: ${tupleId}`);
	return record;
}

function oneRecordAggregate(record: unknown, options: Parameters<typeof phase2hRecordEntry>[1] = {}): Phase2hAggregate {
	return aggregate([...phase2hStructuralEntries(), phase2hRecordEntry(record, options)]);
}

function fallbackIdentity(reason: string, scope: string, raw: Uint8Array): string {
	const preimage = Buffer.concat([
		Buffer.from("ts-drp/phase-2h-diagnostic-entry/v1\0", "utf8"),
		Buffer.from(reason, "utf8"),
		Buffer.from([0]),
		Buffer.from(scope, "utf8"),
		Buffer.from([0]),
		Buffer.from(raw),
	]);
	return `entry-${reason}-sha256:${createHash("sha256").update(preimage).digest("hex")}`;
}

describe("Phase 2h-a frozen contract controls", () => {
	it("has a complete finite coverage ledger rather than a parser or fuzz matrix", () => {
		expect(COVERAGE_LEDGER.map(([area]) => area)).toEqual([
			"registry",
			"record",
			"aggregate",
			"binding",
			"filename",
			"diagnostic",
			"topology",
			"publication",
			"marker",
			"finite-bound",
		]);
		expect(new Set(COVERAGE_LEDGER.map(([area]) => area)).size).toBe(COVERAGE_LEDGER.length);
	});

	it("derives the exact registry from PHASE_2E6_DECLARED_EDGES without a handwritten 54", () => {
		expect(PHASE_2E6_DECLARED_EDGES.map(({ id }) => id)).toEqual(PHASE_2H_CONTRACT_EDGE_IDS);
		expect(PHASE_2H_REQUIRED_TUPLE_IDS).toHaveLength(69);
		expect(PHASE_2H_KILL_TUPLE_IDS).toHaveLength(54);
		expect(PHASE_2H_REQUIRED_TUPLE_IDS.slice(15)).toEqual(
			PHASE_2E6_DECLARED_EDGES.flatMap(({ id }) => [`${id}/chromium`, `${id}/firefox`, `${id}/webkit`])
		);
	});

	it("accepts every complete controlled record through source-owned evidence validators", () => {
		const records = phase2hControlRecords();
		expect(records).toHaveLength(69);
		for (const [index, record] of records.entries()) {
			const tuple = PHASE_2H_TUPLES[index];
			if (tuple === undefined) throw new TypeError("control tuple missing");
			expect(
				validatePhase2hRecord(record, {
					browserVersions: PHASE_2H_CONTROL_BROWSER_VERSIONS,
					gitSha: PHASE_2H_CONTROL_GIT_SHA,
					playwrightVersion: PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
					project: tuple.engine,
					runId: PHASE_2H_CONTROL_RUN_ID,
				}).errors,
				record.tupleId
			).toEqual([]);
		}
	});

	it("passes the complete controlled 69-record fixture", () => {
		const observed = aggregate(phase2hControlEntries());
		expect(observed).toMatchObject({
			duplicateTupleIds: [],
			extraTupleIds: [],
			invalidRecordIds: [],
			missingKillPoints: [],
			missingTupleIds: [],
			verdict: "pass",
		});
		expect(observed.records.map(({ tupleId }) => tupleId)).toEqual(PHASE_2H_REQUIRED_TUPLE_IDS);
	});

	it("reports the authorized inert campaign as the exact 69/54 failure census", () => {
		const observed = aggregate(phase2hStructuralEntries());
		expect(observed.records).toEqual([]);
		expect(observed.requiredTupleIds).toEqual(PHASE_2H_REQUIRED_TUPLE_IDS);
		expect(observed.missingKillPoints).toEqual(ascendingUtf8(PHASE_2H_KILL_TUPLE_IDS));
		expect(observed.missingTupleIds).toEqual(ascendingUtf8(PHASE_2H_REQUIRED_TUPLE_IDS));
		expect(observed.verdict).toBe("fail");
	});

	it("RED: invalidates one engine's complete process campaign when one individually valid arming measurement drifts", () => {
		const engine = "webkit";
		const affectedTupleIds = PHASE_2H_KILL_TUPLE_IDS.filter((tupleId) => tupleId.endsWith(`/${engine}`));
		const [mutatedTupleId] = affectedTupleIds;
		if (mutatedTupleId === undefined) throw new TypeError("WebKit process-death control registry is empty");
		const records = phase2hControlRecords();
		const mutatedRecords = records.map((record) => {
			if (record.tupleId !== mutatedTupleId) return record;
			if (record.hardKillEvidence === null) throw new TypeError("process-death control lacks hard-kill evidence");
			return {
				...record,
				hardKillEvidence: {
					...record.hardKillEvidence,
					armingMeasurement: { ...record.hardKillEvidence.armingMeasurement, blockedForMs: 101 },
				},
			};
		});
		const mutated = mutatedRecords.find(({ tupleId }) => tupleId === mutatedTupleId);
		if (mutated === undefined) throw new TypeError("mutated process-death control is absent");
		expect(mutatedRecords.filter((record, index) => record !== records[index])).toHaveLength(1);
		expect(
			validatePhase2hRecord(mutated, {
				browserVersions: PHASE_2H_CONTROL_BROWSER_VERSIONS,
				gitSha: PHASE_2H_CONTROL_GIT_SHA,
				playwrightVersion: PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
				project: engine,
				runId: PHASE_2H_CONTROL_RUN_ID,
			}).errors
		).toEqual([]);

		const observed = aggregate([
			...phase2hStructuralEntries(),
			...mutatedRecords.map((record) => phase2hRecordEntry(record)),
		]);
		const affected = new Set(affectedTupleIds);
		const recordIds = observed.records.map(({ tupleId }) => tupleId);
		expect(affectedTupleIds).toHaveLength(18);
		expect(observed.verdict).toBe("fail");
		expect(recordIds).toEqual(PHASE_2H_REQUIRED_TUPLE_IDS.filter((tupleId) => !affected.has(tupleId)));
		expect(observed.missingTupleIds).toEqual(ascendingUtf8(affectedTupleIds));
		expect(observed.missingKillPoints).toEqual(ascendingUtf8(affectedTupleIds));
		expect(observed.invalidRecordIds).toEqual(ascendingUtf8(affectedTupleIds));
		for (const tupleId of PHASE_2H_KILL_TUPLE_IDS.filter((candidate) => !affected.has(candidate))) {
			expect(recordIds).toContain(tupleId);
			expect(observed.missingTupleIds).not.toContain(tupleId);
			expect(observed.invalidRecordIds).not.toContain(tupleId);
		}
	});

	it("rejects the finite v2 record mutants without changing their filename owner", () => {
		const capacity = controlRecord("capacity/webkit");
		const [firstKillTupleId] = PHASE_2H_KILL_TUPLE_IDS;
		if (firstKillTupleId === undefined) throw new TypeError("derived kill registry is empty");
		const process = controlRecord(firstKillTupleId);
		const responsive = controlRecord("worker-responsiveness/chromium");
		const mutants = [
			{ label: "extra top-level key", value: { ...capacity, extra: true } },
			{
				label: "wrong engine brand",
				value: { ...capacity, engine: { ...capacity.engine, brand: "Playwright Chromium" } },
			},
			{ label: "wrong git SHA", value: { ...capacity, gitSha: "b".repeat(40) } },
			{
				label: "wrong run ID",
				value: { ...capacity, runId: `phase-2h/${PHASE_2H_CONTROL_GIT_SHA}/10000000-0000-4000-8000-000000000000` },
			},
			{
				label: "wrong scenario tag",
				value: { ...capacity, scenarioEvidence: { ...capacity.scenarioEvidence, tag: "crypto-digest" } },
			},
			{ label: "non-pass verdict", value: { ...capacity, verdict: "fail" } },
			{
				label: "zero heartbeat",
				value: { ...responsive, scenarioEvidence: { ...responsive.scenarioEvidence, sampleCount: 0 } },
			},
			{
				label: "unbound heartbeat window",
				value: { ...responsive, scenarioEvidence: { ...responsive.scenarioEvidence, windowMs: 10 } },
			},
			{ label: "absent hard kill", value: { ...process, hardKillEvidence: null } },
			{
				label: "graceful hard kill",
				value: {
					...process,
					hardKillEvidence: { ...process.hardKillEvidence, mechanism: "browser-close" },
				},
			},
		] as const;
		for (const mutant of mutants) {
			const observed = oneRecordAggregate(mutant.value);
			expect(observed.invalidRecordIds, mutant.label).toContain(
				capacity.tupleId === Reflect.get(mutant.value, "tupleId")
					? capacity.tupleId
					: process.tupleId === Reflect.get(mutant.value, "tupleId")
						? process.tupleId
						: responsive.tupleId
			);
			expect(observed.records, mutant.label).toEqual([]);
		}
	});

	it("attributes body defects only to the filename identity and leaves it missing", () => {
		const record = controlRecord("capacity/webkit");
		const bodies = [
			{ ...record, tupleId: "capacity/chromium" },
			Object.fromEntries(Object.entries(record).filter(([key]) => key !== "tupleId")),
			{ ...record, tupleId: 7 },
			{ ...record, tupleId: "malformed" },
		];
		for (const body of bodies) {
			const observed = oneRecordAggregate(body, { filenameIdentity: "capacity/webkit", project: "webkit" });
			expect(observed.invalidRecordIds).toContain("capacity/webkit");
			expect(observed.missingTupleIds).toContain("capacity/webkit");
			expect(observed.invalidRecordIds).not.toContain("capacity/chromium");
		}
	});

	it("keeps malformed bodies out of records and under the decoded filename owner", () => {
		for (const body of ["{", "null", "[]", "7"]) {
			const entry: Phase2hRawEntry = Object.freeze({
				basename: new TextEncoder().encode("capacity%2Fwebkit.json"),
				body: new TextEncoder().encode(body),
				kind: "file",
				scope: "records/webkit",
			});
			const observed = aggregate([...phase2hStructuralEntries(), entry]);
			expect(observed.records).toEqual([]);
			expect(observed.invalidRecordIds).toContain("capacity/webkit");
		}
	});

	it("hashes canonical extras and never emits their raw spelling", () => {
		const extraRecord = { ...controlRecord("capacity/webkit"), tupleId: "extra-secret-value" };
		const observed = oneRecordAggregate(extraRecord, { filenameIdentity: "extra-secret-value", project: "webkit" });
		const identity = phase2hExtraIdentity("extra-secret-value");
		expect(observed.extraTupleIds).toEqual([identity]);
		expect(observed.invalidRecordIds).toEqual([identity]);
		expect(JSON.stringify(observed)).not.toContain("extra-secret-value");
	});

	it("freezes malformed raw-name reasons and the direct defensive overlong-identity branch", () => {
		const cases = [
			{ raw: new TextEncoder().encode("%zz.json"), reason: "malformed-percent" },
			{ raw: new TextEncoder().encode(".json"), reason: "empty-identity" },
			{ raw: Uint8Array.of(0xff, 0x2e, 0x6a, 0x73, 0x6f, 0x6e), reason: "invalid-name-utf8" },
			{ raw: new TextEncoder().encode("%ED%A0%80.json"), reason: "invalid-identity-utf8" },
			{ raw: new TextEncoder().encode(`${"a".repeat(513)}.json`), reason: "overlong-name" },
		] as const;
		for (const item of cases) {
			const entry: Phase2hRawEntry = Object.freeze({
				basename: item.raw,
				body: Uint8Array.of(1),
				kind: "file",
				scope: "records/chromium",
			});
			const observed = aggregate([...phase2hStructuralEntries(), entry]);
			expect(observed.invalidRecordIds).toEqual([fallbackIdentity(item.reason, entry.scope, entry.basename)]);
		}
		expect(phase2hDecodedIdentityReason("x".repeat(513))).toBe("overlong-identity");
	});

	it("rejects extension/layout/nonregular cases while permitting dotted stems", () => {
		const invalidEntries: readonly Readonly<{ entry: Phase2hRawEntry; reason: string }>[] = [
			{
				entry: { basename: new TextEncoder().encode("capacity%2Fwebkit.JSON"), kind: "file", scope: "records/webkit" },
				reason: "wrong-extension",
			},
			{
				entry: {
					basename: new TextEncoder().encode("capacity%2Fwebkit.json.bak"),
					kind: "file",
					scope: "records/webkit",
				},
				reason: "wrong-extension",
			},
			{
				entry: { basename: new TextEncoder().encode("unexpected"), kind: "file", scope: "run-root" },
				reason: "wrong-layout",
			},
			{
				entry: { basename: new TextEncoder().encode("nested"), kind: "directory", scope: "records/webkit" },
				reason: "subdirectory",
			},
			{
				entry: { basename: new TextEncoder().encode("link"), kind: "symlink", scope: "records/webkit" },
				reason: "nonregular",
			},
			{
				entry: { basename: new TextEncoder().encode("pipe"), kind: "fifo", scope: "records/webkit" },
				reason: "nonregular",
			},
		];
		for (const { entry, reason } of invalidEntries) {
			const observed = aggregate([...phase2hStructuralEntries(), entry]);
			expect(observed.invalidRecordIds).toContain(fallbackIdentity(reason, entry.scope, entry.basename));
		}
		const dotted = { ...controlRecord("capacity/webkit"), tupleId: "name.part" };
		const dottedObserved = oneRecordAggregate(dotted, { filenameIdentity: "name.part", project: "webkit" });
		expect(dottedObserved.extraTupleIds).toEqual([phase2hExtraIdentity("name.part")]);
	});

	it("rejects noncanonical aliases without normalization and makes aliases duplicates", () => {
		const canonical = phase2hRecordEntry(controlRecord("capacity/webkit"));
		const aliases = [
			new TextEncoder().encode("capacity%2fwebkit.json"),
			new TextEncoder().encode("%63apacity%2Fwebkit.json"),
		];
		for (const rawName of aliases) {
			const alias = { ...canonical, basename: rawName };
			const observed = aggregate([...phase2hStructuralEntries(), canonical, alias]);
			expect(observed.duplicateTupleIds).toContain("capacity/webkit");
			expect(observed.invalidRecordIds).toContain("capacity/webkit");
			expect(observed.records).toEqual([]);
		}
		const doubleEncoded = { ...canonical, basename: new TextEncoder().encode("capacity%252Fwebkit.json") };
		const doubleObserved = aggregate([...phase2hStructuralEntries(), doubleEncoded]);
		expect(doubleObserved.extraTupleIds).toEqual([phase2hExtraIdentity("capacity%2Fwebkit")]);
		expect(doubleObserved.records).toEqual([]);
		expect(phase2hExtraIdentity("é")).not.toBe(phase2hExtraIdentity("é"));
	});

	it("isolates collision-marker grammar from record filename attribution", () => {
		const identity = "capacity/webkit";
		const hash = createHash("sha256").update(identity, "utf8").digest("hex");
		const marker = {
			artifactKind: "ts-drp/ahe-storage-validation-collision/v1",
			diagnosticIdentity: identity,
			gitSha: PHASE_2H_CONTROL_GIT_SHA,
			project: "webkit",
			runId: PHASE_2H_CONTROL_RUN_ID,
			schemaVersion: 1,
		};
		const markerEntry: Phase2hRawEntry = {
			basename: new TextEncoder().encode(`${hash}.collision.json`),
			body: new TextEncoder().encode(JSON.stringify(marker)),
			kind: "file",
			scope: "collisions/webkit",
		};
		const observed = aggregate([
			...phase2hStructuralEntries(),
			phase2hRecordEntry(controlRecord(identity)),
			markerEntry,
		]);
		expect(observed.duplicateTupleIds).toEqual([identity]);
		expect(observed.invalidRecordIds).toEqual([identity]);
		expect(observed.extraTupleIds).toEqual([]);
		expect(observed.records).toEqual([]);
	});

	it("publishes create-only under the trusted project and counts first receipt plus its file once", () => {
		const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2h-publisher-"));
		try {
			const layout = preparePhase2hRun({
				browserVersions: PHASE_2H_CONTROL_BROWSER_VERSIONS,
				gitSha: PHASE_2H_CONTROL_GIT_SHA,
				outputBase: temporary,
				playwrightVersion: PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
				uuid: "00000000-0000-4000-8000-000000000000",
			});
			const publisher = createPhase2hPublisher(layout);
			const record = controlRecord("capacity/webkit");
			expect(publisher.submit({ project: "webkit", record })).toBe("accepted");
			expect(publisher.census()).toEqual({ duplicateIdentities: [], invalidIdentities: [] });
			const firstBytes = fs.readFileSync(path.join(layout.runRoot, "records/webkit/capacity%2Fwebkit.json"));
			expect(publisher.submit({ project: "chromium", record })).toBe("duplicate");
			expect(fs.readFileSync(path.join(layout.runRoot, "records/webkit/capacity%2Fwebkit.json"))).toEqual(firstBytes);
			expect(publisher.census().duplicateIdentities).toEqual([record.tupleId]);
			expect(fs.readdirSync(path.join(layout.runRoot, "records/chromium"))).toEqual([]);
			const observed = aggregatePhase2h({
				browserVersions: layout.browserVersions,
				census: publisher.census(),
				...readPhase2hRunEntries(layout.runRoot),
				gitSha: layout.gitSha,
				playwrightVersion: layout.playwrightVersion,
				runId: layout.runId,
			});
			expect(observed.duplicateTupleIds).toEqual([record.tupleId]);
			expect(observed.records).toEqual([]);
		} finally {
			fs.rmSync(temporary, { force: true, recursive: true });
		}
	});

	it("bounds submissions and directory entries with exactly one global run-root identity", () => {
		const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2h-bound-"));
		try {
			const layout = preparePhase2hRun({
				browserVersions: PHASE_2H_CONTROL_BROWSER_VERSIONS,
				gitSha: PHASE_2H_CONTROL_GIT_SHA,
				outputBase: temporary,
				playwrightVersion: PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
				uuid: "00000000-0000-4000-8000-000000000000",
			});
			const publisher = createPhase2hPublisher(layout);
			const record = controlRecord("capacity/webkit");
			for (let index = 0; index < 512; index++) {
				const distinct = { ...record, tupleId: `extra-${index}` } as typeof record;
				publisher.submit({ project: "webkit", record: distinct });
			}
			expect(publisher.submit({ project: "webkit", record })).toBe("rejected-bound");
			expect(publisher.census().invalidIdentities).toContain(
				phase2hOverflowIdentity("record-attempt-bound", layout.runId)
			);
		} finally {
			fs.rmSync(temporary, { force: true, recursive: true });
		}

		const entries = [...phase2hStructuralEntries()];
		for (let index = 0; index < 1_025; index++) {
			entries.push({
				basename: new TextEncoder().encode(`unexpected-${String(index).padStart(4, "0")}`),
				kind: "file",
				scope: "run-root",
			});
		}
		const observed = aggregate(entries);
		expect(observed.invalidRecordIds).toContain(
			phase2hOverflowIdentity("directory-entry-bound", PHASE_2H_CONTROL_RUN_ID)
		);
		expect(observed.invalidRecordIds.filter((identity) => identity.includes("directory-entry-bound"))).toHaveLength(1);
	});

	it("hard-fails absent structural directories and absent/stale current aggregates", () => {
		expect(() => aggregate([])).toThrow(/structural directory/u);
		const invocation = {
			browserVersions: PHASE_2H_CONTROL_BROWSER_VERSIONS,
			playwrightVersion: PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
			runId: PHASE_2H_CONTROL_RUN_ID,
		};
		expect(() =>
			consumeCurrentPhase2hAggregate(undefined, { ...invocation, gitSha: PHASE_2H_CONTROL_GIT_SHA })
		).toThrow(/absent/u);
		const current = aggregate(phase2hControlEntries());
		expect(() => consumeCurrentPhase2hAggregate(current, { ...invocation, gitSha: "b".repeat(40) })).toThrow(/stale/u);
		expect(consumeCurrentPhase2hAggregate(current, { ...invocation, gitSha: PHASE_2H_CONTROL_GIT_SHA })).toBe(current);
	});

	it("uses one literal NUL byte in ordinary and overflow hash preimages", () => {
		const extra = phase2hExtraIdentity("bounded");
		const expectedExtra = `extra-sha256:${createHash("sha256")
			.update(
				Buffer.concat([
					Buffer.from("ts-drp/phase-2h-diagnostic-extra/v1", "utf8"),
					Buffer.from([0]),
					Buffer.from("bounded", "utf8"),
				])
			)
			.digest("hex")}`;
		expect(extra).toBe(expectedExtra);
		const overflow = phase2hOverflowIdentity("record-attempt-bound", PHASE_2H_CONTROL_RUN_ID);
		const expectedOverflow = fallbackIdentity(
			"record-attempt-bound",
			"run-root",
			new TextEncoder().encode(PHASE_2H_CONTROL_RUN_ID)
		);
		expect(overflow).toBe(expectedOverflow);
	});
});
