import { describe, expect, it } from "vitest";

import { orderedKillPoints } from "../src/killpoints.js";
import { FIXTURE_OBJECT_ID } from "./fixtures/fixture-records.js";
import { expectedHitDurability } from "./fixtures/inert-campaign.js";
import {
	parentFailureCodeForWorker,
	parseBrowserSmokeChildMessage,
	parseWorkerRunMessage,
	parseWorkerToPageMessage,
} from "./fixtures/worker-protocol.js";

describe("Phase 2b closed Worker protocol controls", () => {
	it("accepts only the exact creator-bound run shape", () => {
		const signal = new SharedArrayBuffer(4);
		const input = {
			kind: "run",
			version: 1,
			databaseName: "phase-2b-control",
			objectId: FIXTURE_OBJECT_ID,
			armed: { id: "left-write", edge: "before" },
			signal,
		};
		expect(parseWorkerRunMessage(input)).toEqual(input);
		for (const malformed of [
			{ ...input, extra: true },
			{ ...input, version: 2 },
			{ ...input, armed: { id: "unknown", edge: "before" } },
			{ ...input, armed: { id: "left-write", edge: "during" } },
			{ ...input, signal: new ArrayBuffer(4) },
			{ ...input, signal: new SharedArrayBuffer(0) },
			{ ...input, signal: new SharedArrayBuffer(8) },
		]) {
			expect(parseWorkerRunMessage(malformed)).toBeUndefined();
		}
	});

	it("maps every unknown failure code only to UNKNOWN_FAILURE_CODE", () => {
		expect(parentFailureCodeForWorker("DRIVER_NOT_IMPLEMENTED")).toBe("DRIVER_NOT_IMPLEMENTED");
		expect(parentFailureCodeForWorker("future-code")).toBe("UNKNOWN_FAILURE_CODE");
		expect(parentFailureCodeForWorker(null)).toBe("UNKNOWN_FAILURE_CODE");
	});

	it("parses all Worker variants and preserves the exact 3/11 durability sequence", () => {
		expect(parseWorkerToPageMessage({ kind: "ready", version: 1 })).toEqual({ kind: "ready", version: 1 });
		const hits = orderedKillPoints().map((point) => ({
			kind: "hit" as const,
			version: 1 as const,
			...point,
			transactionDurability: expectedHitDurability(point),
		}));
		const parsedHits = hits.map(parseWorkerToPageMessage);
		expect(parsedHits).toEqual(hits);
		expect(parsedHits.filter((hit) => hit?.kind === "hit" && hit.transactionDurability === "not-reached")).toHaveLength(
			3
		);
		expect(parsedHits.filter((hit) => hit?.kind === "hit" && hit.transactionDurability === "strict")).toHaveLength(11);
		const observed = hits.map(({ id, edge, transactionDurability }) => ({ id, edge, transactionDurability }));
		const complete = parseWorkerToPageMessage({
			kind: "complete",
			version: 1,
			observed,
			transactionDurability: "strict",
		});
		expect(complete).toEqual({ kind: "complete", version: 1, observed, transactionDurability: "strict" });
		const failure = parseWorkerToPageMessage({
			kind: "failure",
			version: 1,
			code: "DRIVER_NOT_IMPLEMENTED",
			detail: "inert RED driver",
		});
		expect(failure).toEqual({
			kind: "failure",
			version: 1,
			code: "DRIVER_NOT_IMPLEMENTED",
			detail: "inert RED driver",
		});
		expect(parseBrowserSmokeChildMessage({ kind: "smoke-result", version: 1, result: failure })).toEqual({
			kind: "smoke-result",
			version: 1,
			result: failure,
		});
	});

	it("rejects extra, missing, accessor, unknown and malformed Worker or child messages", () => {
		const accessor = Object.defineProperties(
			{},
			{
				kind: { enumerable: true, get: (): string => "ready" },
				version: { enumerable: true, value: 1 },
			}
		);
		const malformed: readonly unknown[] = [
			{ kind: "ready" },
			{ kind: "ready", version: 1, extra: true },
			accessor,
			{ kind: "unknown", version: 1 },
			{ kind: "hit", version: 1, id: "unknown", edge: "before", transactionDurability: "strict" },
			{ kind: "hit", version: 1, id: "left-write", edge: "during", transactionDurability: "strict" },
			{ kind: "hit", version: 1, id: "left-write", edge: "before", transactionDurability: "guessed" },
			{
				kind: "complete",
				version: 1,
				observed: [{ id: "left-write", edge: "before", transactionDurability: "guessed" }],
				transactionDurability: "strict",
			},
			{ kind: "complete", version: 1, observed: [], transactionDurability: "not-reached" },
			{ kind: "failure", version: 1, code: "future-code", detail: "unknown" },
			{ kind: "failure", version: 1, code: "REQUEST_ERROR", detail: "x".repeat(257) },
		];
		for (const candidate of malformed) expect(parseWorkerToPageMessage(candidate)).toBeUndefined();
		expect(
			parseBrowserSmokeChildMessage({
				kind: "smoke-result",
				version: 1,
				result: { kind: "failure", version: 1, code: "future-code", detail: "unknown" },
			})
		).toBeUndefined();
		expect(
			parseBrowserSmokeChildMessage({ kind: "smoke-error", version: 1, detail: "bounded", extra: true })
		).toBeUndefined();
	});
});
