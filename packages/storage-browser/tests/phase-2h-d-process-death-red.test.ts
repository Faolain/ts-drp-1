import { decodeHeadRecordV1, encodeHeadRecordV1, type ExpectedHead, parseStorageObjectId } from "@ts-drp/storage";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { phase2e6CaseErrors } from "./fixtures/phase-2e6-real-process-death-validator.js";
import { phase2hExtraIdentity } from "./fixtures/phase-2h-a-aggregate.js";
import {
	phase2hControlRecords,
	PHASE_2H_CONTROL_GIT_SHA,
	PHASE_2H_CONTROL_RUN_ID,
} from "./fixtures/phase-2h-a-controls.js";
import { createPhase2hPublisher, preparePhase2hRun } from "./fixtures/phase-2h-a-publication.js";
import { type Phase2hValidationRecord, validatePhase2hRecord } from "./fixtures/phase-2h-a-record.js";
import { PHASE_2H_ENGINES, PHASE_2H_KILL_TUPLE_IDS, PHASE_2H_TUPLES } from "./fixtures/phase-2h-a-registry.js";

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
	it("freezes the exact authoritative 18-edge by three-engine projection and positive evidence shape", () => {
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
				expect(phase2e6CaseErrors(tuple.edge, record.scenarioEvidence.caseEvidence)).toEqual([]);
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
});
