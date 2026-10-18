import { createHash } from "node:crypto";

import type {
	Phase3ExitAction,
	Phase3ExitOutcomeProjection,
	Phase3ExitSchedule,
	Phase3ExitScheduleFamily,
} from "./model-contract.js";
import { runPhase3ExitSchedule } from "./oracle.js";
import {
	corpusHash,
	enumerateCorpus,
	hashForIndex,
	makeGraph,
	referenceOrder,
} from "../../../packages/compaction/tests/corpus.js";

export const PHASE3_EXIT_ORDINARY_CORPUS_COUNT = 10;
export const PHASE3_EXIT_ORDINARY_CORPUS_SHA256 = "28bce9a70097d7c5a7bb201ea12aa99545b9e3a15e3a6c9cbf26fdc2a7928756";
export const PHASE3_EXIT_ORDINARY_SCHEDULE_COUNT = 226;
export const PHASE3_EXIT_ORDINARY_SCHEDULE_SHA256 = "d23a995b26c33c48ac2f65ebd0d3f61bbd693c162fe4b2e967f6e60a30add884";
export const PHASE3_EXIT_ORDINARY_OUTCOME_SHA256 = "3eadee6cf46b8d1f1bc98f8036f91a5e1cd23759bbbc2993a653ae4af0ea53f6";
export const PHASE3_EXIT_CERTIFICATION_CORPUS_COUNT = 407;
export const PHASE3_EXIT_CERTIFICATION_CORPUS_SHA256 =
	"70388c6d344b32ceb693995855ab05ee20d729bf67c75807dfb0489d47e071f3";
export const PHASE3_EXIT_CERTIFICATION_SCHEDULE_COUNT = 266_009;
export const PHASE3_EXIT_CERTIFICATION_SCHEDULE_SHA256 =
	"a95c0fee3d70b05fcd773da2d10d5b33bb631bc818388d08374d3a81d30eb819";
export const PHASE3_EXIT_CERTIFICATION_OUTCOME_SHA256 =
	"7eee1dd0cc6cd6ab0708aee1f470ea91df89f5309257ed5261664574656574ce";

function permutations(values: readonly number[]): number[][] {
	if (values.length === 0) return [[]];
	const output: number[][] = [];
	for (let index = 0; index < values.length; index += 1) {
		const head = values[index] as number;
		const tail = [...values.slice(0, index), ...values.slice(index + 1)];
		for (const suffix of permutations(tail)) output.push([head, ...suffix]);
	}
	return output;
}

/**
 * Enumerate the canonical shape-major Phase 3 exit schedule corpus.
 * @param maximumVertexCount - Cumulative corpus vertex bound including bootstrap.
 * @returns Frozen canonical schedules in exact emission order.
 */
export function enumeratePhase3ExitSchedules(maximumVertexCount: number): readonly Phase3ExitSchedule[] {
	const output: Phase3ExitSchedule[] = [];
	for (const shape of enumerateCorpus(maximumVertexCount)) {
		const dependencies = Object.freeze(shape.dependencies.map((row) => Object.freeze([...row])));
		const ordinary = Array.from({ length: shape.dependencies.length - 1 }, (_, index) => index + 1);
		const reference = referenceOrder(makeGraph(shape)).map((hash) =>
			Array.from({ length: shape.dependencies.length }, (_, index) => hashForIndex(index)).indexOf(hash)
		);
		const referenceOrdinary = reference.filter((index) => index !== 0);
		const eligible = ordinary.filter((index) =>
			(shape.dependencies[index] ?? []).some((dependency) => dependency !== 0)
		);
		for (const permutation of permutations(ordinary)) {
			output.push(
				Object.freeze([
					dependencies,
					"delivery" as const,
					Object.freeze([
						...permutation.map((label) => Object.freeze(["deliver", label, "normal"] as const)),
						Object.freeze(["query-commitment"] as const),
					]),
				])
			);
			for (const label of ordinary) {
				output.push(
					Object.freeze([
						dependencies,
						"accepted-duplicate" as const,
						Object.freeze([
							...permutation.map((candidate) => Object.freeze(["deliver", candidate, "normal"] as const)),
							Object.freeze(["redeliver", label] as const),
							Object.freeze(["query-commitment"] as const),
						]),
					])
				);
			}
		}
		for (const label of eligible) {
			const remaining = referenceOrdinary.filter((candidate) => candidate !== label);
			for (const family of ["pending-duplicate", "pending-crash"] as const) {
				const prefix: Phase3ExitAction[] = [Object.freeze(["deliver", label, "normal"] as const)];
				if (family === "pending-duplicate") prefix.push(Object.freeze(["redeliver", label] as const));
				else prefix.push(Object.freeze(["crash-restart"] as const), Object.freeze(["redeliver", label] as const));
				output.push(
					Object.freeze([
						dependencies,
						family,
						Object.freeze([
							...prefix,
							...remaining.map((candidate) => Object.freeze(["deliver", candidate, "normal"] as const)),
							Object.freeze(["query-commitment"] as const),
						]),
					])
				);
			}
		}
		for (const label of ordinary) {
			const actions: Phase3ExitAction[] = [];
			for (const candidate of referenceOrdinary) {
				actions.push(Object.freeze(["deliver", candidate, candidate === label ? "commit-then-throw" : "normal"]));
				if (candidate === label) actions.push(Object.freeze(["crash-restart"]));
			}
			actions.push(Object.freeze(["query-commitment"]));
			output.push(Object.freeze([dependencies, "post-append-crash", Object.freeze(actions)]));
		}
	}
	return Object.freeze(output);
}

/**
 * Compute exact corpus, schedule, family, and outcome evidence.
 * @param maximumVertexCount - Cumulative corpus vertex bound including bootstrap.
 * @returns Frozen count and SHA-256 evidence.
 */
export function phase3ExitScheduleEvidence(maximumVertexCount: number): Readonly<{
	readonly corpusCount: number;
	readonly corpusSha256: string;
	readonly familyCounts: Readonly<Record<Phase3ExitScheduleFamily, number>>;
	readonly outcomeSha256: string;
	readonly scheduleCount: number;
	readonly scheduleSha256: string;
}> {
	const corpus = enumerateCorpus(maximumVertexCount);
	const schedules = enumeratePhase3ExitSchedules(maximumVertexCount);
	const scheduleHash = createHash("sha256");
	const outcomeHash = createHash("sha256");
	const familyCounts: Record<Phase3ExitScheduleFamily, number> = {
		"accepted-duplicate": 0,
		"delivery": 0,
		"pending-crash": 0,
		"pending-duplicate": 0,
		"post-append-crash": 0,
	};
	for (const schedule of schedules) {
		const scheduleString = JSON.stringify(schedule);
		if (scheduleString.includes("\n")) throw new TypeError("Phase 3 exit schedule contains an LF");
		scheduleHash.update(`${scheduleString}\n`);
		const projection: Phase3ExitOutcomeProjection = runPhase3ExitSchedule(schedule).projection;
		outcomeHash.update(`${JSON.stringify([scheduleString, projection])}\n`);
		familyCounts[schedule[1]] += 1;
	}
	return Object.freeze({
		corpusCount: corpus.length,
		corpusSha256: corpusHash(corpus),
		familyCounts: Object.freeze({ ...familyCounts }),
		outcomeSha256: outcomeHash.digest("hex"),
		scheduleCount: schedules.length,
		scheduleSha256: scheduleHash.digest("hex"),
	});
}
