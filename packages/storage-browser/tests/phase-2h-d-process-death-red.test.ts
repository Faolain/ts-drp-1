import { decodeHeadRecordV1, encodeHeadRecordV1, type ExpectedHead, parseStorageObjectId } from "@ts-drp/storage";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { phase2e6CaseErrors } from "./fixtures/phase-2e6-real-process-death-validator.js";
import { aggregatePhase2h, phase2hExtraIdentity, phase2hStructuralEntries } from "./fixtures/phase-2h-a-aggregate.js";
import {
	phase2hControlEntries,
	phase2hControlRecords,
	phase2hRecordEntry,
	PHASE_2H_CONTROL_GIT_SHA,
	PHASE_2H_CONTROL_RUN_ID,
} from "./fixtures/phase-2h-a-controls.js";
import { createPhase2hPublisher, preparePhase2hRun } from "./fixtures/phase-2h-a-publication.js";
import { type Phase2hValidationRecord, validatePhase2hRecord } from "./fixtures/phase-2h-a-record.js";
import { PHASE_2H_ENGINES, PHASE_2H_KILL_TUPLE_IDS, PHASE_2H_TUPLES } from "./fixtures/phase-2h-a-registry.js";

const CONTENT_PROCESS_CLASS = Object.freeze({
	chromium: "chromium-renderer",
	firefox: "firefox-contentproc",
	webkit: "webkit-webcontent",
} as const);

function controlRecord(tupleId: string): Phase2hValidationRecord {
	const record = phase2hControlRecords().find((candidate) => candidate.tupleId === tupleId);
	if (record === undefined) throw new TypeError(`missing Phase 2h-d control record ${tupleId}`);
	return record;
}

function validate(
	record: unknown,
	project: "chromium" | "firefox" | "webkit"
): ReturnType<typeof validatePhase2hRecord> {
	return validatePhase2hRecord(record, {
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		project,
		runId: PHASE_2H_CONTROL_RUN_ID,
	});
}

function aggregateRecords(records: readonly Phase2hValidationRecord[]): ReturnType<typeof aggregatePhase2h> {
	return aggregatePhase2h({
		entries: [...phase2hStructuralEntries(), ...records.map((record) => phase2hRecordEntry(record))],
		gitSha: PHASE_2H_CONTROL_GIT_SHA,
		runId: PHASE_2H_CONTROL_RUN_ID,
	});
}

function replaceCaseEvidence(
	record: Phase2hValidationRecord,
	patch: Partial<NonNullable<Phase2hValidationRecord["hardKillEvidence"]>["caseEvidence"]>
): Phase2hValidationRecord {
	if (record.scenarioEvidence.tag !== "process-death" || record.hardKillEvidence === null)
		throw new TypeError("process-death control is incomplete");
	const caseEvidence = Object.freeze({ ...record.scenarioEvidence.caseEvidence, ...patch });
	return Object.freeze({
		...record,
		hardKillEvidence: Object.freeze({ ...record.hardKillEvidence, caseEvidence }),
		scenarioEvidence: Object.freeze({ ...record.scenarioEvidence, caseEvidence }),
	});
}

function aggregateControlRecords(): readonly Phase2hValidationRecord[] {
	return phase2hControlRecords().map((record) => {
		if (
			record.scenarioEvidence.tag !== "process-death" ||
			record.hardKillEvidence === null ||
			record.engine.name === "chromium"
		)
			return record;
		const evidence = record.hardKillEvidence.caseEvidence;
		const pid = evidence.browserRoot.pid + 9_000;
		const auxiliary = Object.freeze({
			birthToken: `legacy-broad-control-${pid}`,
			command: record.engine.name === "webkit" ? "diagnostic WebContent renderer marker" : "diagnostic renderer marker",
			pgid: evidence.browserRoot.pgid,
			pid,
			ppid: evidence.browserRoot.pid,
			state: "T",
		});
		return replaceCaseEvidence(record, {
			frozenForest: [...evidence.frozenForest, auxiliary],
			initialForest: [...evidence.initialForest, auxiliary],
			recordedProcessDeaths: [
				...evidence.recordedProcessDeaths,
				{ birthToken: auxiliary.birthToken, currentBirthToken: null, outcome: "absent", pid },
			],
		});
	});
}

function hostileHardKillRecord(kind: "cycle" | "deep"): Phase2hValidationRecord {
	const record = controlRecord(PHASE_2H_KILL_TUPLE_IDS[0] ?? "");
	if (record.hardKillEvidence === null || record.scenarioEvidence.tag !== "process-death")
		throw new TypeError("process-death control is incomplete");
	const hostile: Record<string, unknown> = { ...record.hardKillEvidence.caseEvidence };
	if (kind === "cycle") hostile.hostile = hostile;
	else {
		let nested: Record<string, unknown> = {};
		for (let index = 0; index < 12_000; index++) nested = { nested };
		hostile.hostile = nested;
	}
	return {
		...record,
		hardKillEvidence: { ...record.hardKillEvidence, caseEvidence: hostile as never },
	};
}

function physical(value: unknown): unknown {
	if (value instanceof Uint8Array) return { $bytes: [...value] };
	if (Array.isArray(value)) return value.map(physical);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, physical(nested)])
	);
}

function physicalHex(value: unknown): string {
	return Buffer.from(JSON.stringify(physical(value)), "utf8").toString("hex");
}

function decodePhysical(hex: string): unknown {
	return JSON.parse(Buffer.from(hex, "hex").toString("utf8")) as unknown;
}

function uniqueOldPresentHead(record: Phase2hValidationRecord): ExpectedHead {
	if (record.scenarioEvidence.tag !== "quota-fault") throw new TypeError("not quota evidence");
	const rows = record.scenarioEvidence.caseEvidence.before.stores.objects;
	if (rows.length !== 1) throw new TypeError("quota old image does not have one unique present head");
	const row = rows[0];
	if (row === undefined) throw new TypeError("quota old-image head row is absent");
	const key = decodePhysical(row.keyBytesHex);
	const decodedRow = decodePhysical(row.valueBytesHex) as Readonly<Record<string, unknown>>;
	const encoded = Reflect.get(decodedRow, "record") as Readonly<Record<string, unknown>>;
	const bytes = Reflect.get(encoded, "$bytes");
	if (!Array.isArray(bytes)) throw new TypeError("quota old-image head bytes are absent");
	const decoded = decodeHeadRecordV1(Uint8Array.from(bytes as number[]));
	if (!decoded.ok || decoded.value.kind !== "present" || decoded.value.objectId !== key)
		throw new TypeError("quota old image does not bind its unique present head");
	return decoded.value;
}

function quotaRecordWithSourceOwnedHead(): Phase2hValidationRecord {
	const base = controlRecord("quota-fault/chromium");
	if (base.recoveredHead?.kind !== "present" || base.scenarioEvidence.tag !== "quota-fault")
		throw new TypeError("quota control lacks a present recovered head");
	const row = Object.freeze({
		keyBytesHex: physicalHex(base.recoveredHead.objectId),
		valueBytesHex: physicalHex({
			objectId: base.recoveredHead.objectId,
			record: encodeHeadRecordV1(base.recoveredHead),
		}),
	});
	const oldImage = Object.freeze({
		...base.scenarioEvidence.caseEvidence.before,
		stores: Object.freeze({
			...base.scenarioEvidence.caseEvidence.before.stores,
			objects: Object.freeze([row]),
		}),
	});
	return Object.freeze({
		...base,
		scenarioEvidence: Object.freeze({
			...base.scenarioEvidence,
			caseEvidence: Object.freeze({
				...base.scenarioEvidence.caseEvidence,
				afterReopen: oldImage,
				before: oldImage,
			}),
		}),
	});
}

describe("Phase 2h-d finite process-death RED contract", () => {
	it("RED(baseline fabricated renderer-everywhere controls -> current exact Linux engine forests): freezes the exact 18x3 projection", () => {
		const processTuples = PHASE_2H_TUPLES.filter(({ scenario }) => scenario === "process-death");
		expect(processTuples.map(({ tupleId }) => tupleId)).toEqual(PHASE_2H_KILL_TUPLE_IDS);
		expect(processTuples).toHaveLength(54);
		for (let edgeIndex = 0; edgeIndex < 18; edgeIndex++) {
			const edgeTuples = processTuples.slice(edgeIndex * PHASE_2H_ENGINES.length, (edgeIndex + 1) * 3);
			expect(edgeTuples.map(({ engine }) => engine)).toEqual(PHASE_2H_ENGINES);
			for (const tuple of edgeTuples) {
				const record = controlRecord(tuple.tupleId);
				const result = validate(record, tuple.engine);
				expect(result.errors, tuple.tupleId).toEqual([]);
				expect(result.record, tuple.tupleId).toBe(record);
				if (record.scenarioEvidence.tag !== "process-death" || record.hardKillEvidence === null)
					throw new TypeError(`incomplete positive process evidence ${tuple.tupleId}`);
				expect(record.scenarioEvidence.caseEvidence.unsupported).toBe(false);
				expect(record.scenarioEvidence.armReachCount).toBe(1);
				expect(record.hardKillEvidence.caseEvidence).toBe(record.scenarioEvidence.caseEvidence);
				expect(record.hardKillEvidence.armingMeasurement.engine).toBe(tuple.engine);
				expect(record.hardKillEvidence.contentProcessClass).toBe(
					{ chromium: "chromium-renderer", firefox: "firefox-contentproc", webkit: "webkit-webcontent" }[tuple.engine]
				);
				if (tuple.edge === null) throw new TypeError("process tuple lacks its authoritative edge");
				expect(
					phase2e6CaseErrors(tuple.edge, record.scenarioEvidence.caseEvidence, {
						contentProcessClass: CONTENT_PROCESS_CLASS[tuple.engine],
						platform: record.os.platform,
						scope: "phase2h",
					})
				).toEqual([]);
			}
		}
	});

	it.each(["cycle", "deep"] as const)(
		"RED: hard-kill validation is total and fail-closed for hostile %s caseEvidence",
		(kind) => {
			const record = hostileHardKillRecord(kind);
			let observed: ReturnType<typeof validatePhase2hRecord> | undefined;
			expect(() => {
				observed = validate(record, "chromium");
			}).not.toThrow();
			expect(observed?.record).toBeNull();
			expect(observed?.errors).not.toEqual([]);
		}
	);

	it("RED: publisher census hashes a registry-nonmember typed bypass and publishes no raw identity", () => {
		const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2h-d-publisher-"));
		try {
			const layout = preparePhase2hRun({
				gitSha: PHASE_2H_CONTROL_GIT_SHA,
				outputBase: temporary,
				uuid: "00000000-0000-4000-8000-000000000000",
			});
			const publisher = createPhase2hPublisher(layout);
			const rawIdentity = "not-a-phase-2h-registry-member";
			const bypass = { ...controlRecord("capacity/webkit"), tupleId: rawIdentity } as Phase2hValidationRecord;
			publisher.submit({ project: "webkit", record: bypass });
			expect(fs.readdirSync(path.join(layout.runRoot, "records/webkit"))).toEqual([]);
			expect(publisher.census()).toEqual({
				duplicateIdentities: [],
				invalidIdentities: [phase2hExtraIdentity(rawIdentity)],
			});
			expect(JSON.stringify(publisher.census())).not.toContain(rawIdentity);
		} finally {
			fs.rmSync(temporary, { force: true, recursive: true });
		}
	});

	it("RED: quota recoveredHead is the unique present head derived from the old source-owned image", () => {
		const record = quotaRecordWithSourceOwnedHead();
		const sourceHead = uniqueOldPresentHead(record);
		expect(record.recoveredHead).toEqual(sourceHead);
		expect(validate(record, "chromium").errors).toEqual([]);
		const parsed = parseStorageObjectId(`phase-2h-wrong:${"f".repeat(32)}`);
		if (!parsed.ok || record.recoveredHead?.kind !== "present") throw new TypeError("invalid quota mutant fixture");
		const mutant: Phase2hValidationRecord = {
			...record,
			recoveredHead: { ...record.recoveredHead, objectId: parsed.value },
		};
		const observed = validate(mutant, "chromium");
		expect(observed.record).toBeNull();
		expect(observed.errors).not.toEqual([]);
	});

	it("RED(baseline Darwin record accepted -> current pre-construction host rejection): Phase 2h never grants any Darwin engine", () => {
		for (const engine of PHASE_2H_ENGINES) {
			const tuple = PHASE_2H_TUPLES.find(
				(candidate) => candidate.engine === engine && candidate.scenario === "process-death"
			);
			if (tuple === undefined) throw new TypeError(`missing ${engine} process-death tuple`);
			const record = controlRecord(tuple.tupleId);
			const darwin: Phase2hValidationRecord = {
				...record,
				os: { ...record.os, platform: "darwin", release: "23.6.0" },
			};
			const result = validate(darwin, engine);
			expect.soft(result.record, engine).toBeNull();
			expect.soft(result.errors, engine).toContain("process-death records require Linux host authority");
		}
	});

	it("RED(baseline broad renderer accepted -> current exact record classifier): wrong profile/role evidence rejects", () => {
		const base = controlRecord(PHASE_2H_KILL_TUPLE_IDS[0] ?? "");
		if (base.hardKillEvidence === null) throw new TypeError("Chromium process control is incomplete");
		const caseEvidence = base.hardKillEvidence.caseEvidence;
		const wrongProfile = caseEvidence.initialForest.map((row) =>
			row.pid === caseEvidence.browserRoot.pid + 2
				? { ...row, command: row.command.replace(caseEvidence.profilePath, `${caseEvidence.profilePath}2`) }
				: row
		);
		const substringRole = caseEvidence.initialForest.map((row) =>
			row.pid === caseEvidence.browserRoot.pid + 2
				? { ...row, command: row.command.replace("--type=renderer", "--type=renderer-helper") }
				: row
		);
		for (const forest of [wrongProfile, substringRole]) {
			const mutant = replaceCaseEvidence(base, { frozenForest: forest, initialForest: forest });
			const result = validate(mutant, "chromium");
			expect.soft(result.record).toBeNull();
			expect.soft(result.errors).not.toEqual([]);
		}
	});

	it("record validation rejects wrong-PGID and out-of-closure renderer evidence", () => {
		const base = controlRecord(PHASE_2H_KILL_TUPLE_IDS[0] ?? "");
		if (base.hardKillEvidence === null) throw new TypeError("Chromium process control is incomplete");
		const evidence = base.hardKillEvidence.caseEvidence;
		const wrongPgid = evidence.initialForest.map((row) =>
			row.pid === evidence.browserRoot.pid + 2 ? { ...row, pgid: row.pgid + 1000 } : row
		);
		const outOfClosure = evidence.initialForest.map((row) =>
			row.pid === evidence.browserRoot.pid + 2 ? { ...row, ppid: 999_999 } : row
		);
		for (const forest of [wrongPgid, outOfClosure]) {
			const result = validate(replaceCaseEvidence(base, { frozenForest: forest, initialForest: forest }), "chromium");
			expect(result.record).toBeNull();
			expect(result.errors).not.toEqual([]);
		}
	});

	it("RED(baseline per-record-only OS validation -> current all-69 Linux OS authority): rejects every OS mutant", () => {
		const linux = aggregateControlRecords();
		const controlAggregate = aggregateRecords(linux);
		expect(
			controlAggregate.verdict,
			JSON.stringify({ invalid: controlAggregate.invalidRecordIds, missing: controlAggregate.missingTupleIds })
		).toBe("pass");
		for (const osValue of [
			{ arch: "arm64", platform: "linux", release: "6.11.0" },
			{ arch: "x64", platform: "linux", release: "6.12.0" },
		] as const) {
			const uniform = aggregateRecords(linux.map((record) => ({ ...record, os: osValue })));
			expect.soft(uniform.verdict, JSON.stringify(osValue)).toBe("pass");
			expect.soft(uniform.invalidRecordIds, JSON.stringify(osValue)).toEqual([]);
		}
		const firstProcess = linux.findIndex(({ scenario }) => scenario === "process-death");
		if (firstProcess < 0) throw new TypeError("process-death control is absent");
		const replaceOs = (index: number, osValue: Phase2hValidationRecord["os"]): readonly Phase2hValidationRecord[] =>
			linux.map((record, ordinal) => (ordinal === index ? { ...record, os: osValue } : record));
		const mutants = [
			replaceOs(firstProcess, { arch: "x64", platform: "darwin", release: "23.6.0" }),
			replaceOs(0, { arch: "x64", platform: "darwin", release: "control-os-1" }),
			replaceOs(0, { arch: "arm64", platform: "linux", release: "control-os-1" }),
			replaceOs(0, { arch: "x64", platform: "linux", release: "different-release" }),
			linux.map((record) => ({
				...record,
				os: { arch: "x64" as const, platform: "darwin" as const, release: "23.6.0" },
			})),
		];
		for (const mutant of mutants) {
			const aggregate = aggregateRecords(mutant);
			expect.soft(aggregate.verdict).toBe("fail");
			expect.soft(aggregate.invalidRecordIds).not.toEqual([]);
		}
	});

	it("preserves the closed evidence/provenance key sets without a new platform key", () => {
		const records = phase2hControlRecords();
		const processRecord = records.find(({ scenario }) => scenario === "process-death");
		if (processRecord?.hardKillEvidence === null || processRecord === undefined)
			throw new TypeError("process-death control is absent");
		expect(Object.keys(processRecord.hardKillEvidence.caseEvidence).sort()).toEqual([
			"armReachCount",
			"browserExecutable",
			"browserRoot",
			"child",
			"childExit",
			"controllerPgid",
			"databaseCreateCountAfterSeed",
			"databaseDeleteCount",
			"databaseIdentityPreserved",
			"databaseName",
			"edgeId",
			"expectedState",
			"frozenForest",
			"head",
			"initialForest",
			"killedGroups",
			"operationTransactionCount",
			"profilePath",
			"reachedRequestedArm",
			"recordedProcessDeaths",
			"recoveredDatabaseName",
			"recoveredImage",
			"recoveryResult",
			"scenarioOperation",
			"sentinelRetained",
			"tracePrefix",
			"unsupported",
			"workerCrossOriginIsolated",
			"workerRealm",
			"writeRequestCount",
		]);
		expect(Object.keys(processRecord).sort()).toEqual(Object.keys(controlRecord("capacity/chromium")).sort());
		expect(phase2hControlEntries()).toHaveLength(77);
	});
});
