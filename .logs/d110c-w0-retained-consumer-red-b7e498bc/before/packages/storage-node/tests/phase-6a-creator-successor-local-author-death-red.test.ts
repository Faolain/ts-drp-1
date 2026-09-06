import "fake-indexeddb/auto";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createD108d1PackedDurableMaterial } from "../../../tests/fixtures/phase-6a-v3/creator-successor-activation-contract.js";
import {
	D108D1B_CHILD_BEHAVIORS,
	d108d1bChatAuthorities,
	D108E2D_CHILD_BEHAVIORS,
	D108E2E_CHILD_BEHAVIORS,
	D108E4_CHILD_BEHAVIORS,
	openD108d1bMultiWriterFixture,
	runD108d1bLocalAuthorChild,
	runD108e2eSkipBudgetChild,
} from "../../../tests/fixtures/phase-6a-v3/creator-successor-local-author-contract.js";

const childPath = new URL("./fixtures/phase-6a-creator-successor-local-author-child.mjs", import.meta.url);
const directories: string[] = [];
const D108E4L_PHASE_NAMES = Object.freeze([
	"preflight-and-store-open",
	"current-row",
	"genuine-future",
	"authenticated-future-appends",
	"maximum-page-probe",
	"equality-materialization-and-facades",
	"over-budget-preparation",
	"mismatch-preparation",
	"concurrent-recoveries",
	"proof-assembly",
]);
const D108E4L_PHASE_COUNTS = Object.freeze([
	{ storeOpenCount: 2 },
	{ appendCount: 1 },
	{ genuineFutureCount: 1 },
	{ appendCount: 8_191 },
	{ maximumPageLimit: 128, probeCount: 1 },
	{ facadeCount: 2, materializedRowCount: 8_193 },
	{ appendCount: 2, authenticatedSuffixCount: 2, materializedRowCount: 8_195 },
	{ appendCount: 2, materializedRowCount: 2 },
	{ recoveryCount: 5 },
	{ proofCount: 1 },
]);
const D108E4L_MEMBER_NAMES = Object.freeze(["equality", "reuse-0", "reuse-1", "over-budget", "mismatch"]);
const D108E4L_MEMBER_COUNTS = Object.freeze([
	{ pageCount: 8_194, returnedSequenceCount: 8_193 },
	{ capturedIssuedCount: 8_190, successorPageFaultCount: 1 },
	{ capturedIssuedCount: 8_190, successorPageFaultCount: 1 },
	{ pageCount: 8_195, returnedSequenceCount: 8_195 },
	{ pageCount: 2, returnedSequenceCount: 2 },
]);
const D108E4L_STEP_NAMES = Object.freeze(["context-seed", "reopen-and-evidence", "close-context"]);
const D108E4M_FACADE_METHODS = Object.freeze([
	"close",
	"compareAndMarkOutboxPublished",
	"readIssued",
	"readLineage",
	"readOutboxPage",
	"transactIssue",
]);
const D108E4M_MEMBER_NAMES = Object.freeze(["equality", "reuse-0", "reuse-1", "over-budget", "mismatch"]);
const D108E4M_LEAF_CLASSES = Object.freeze([
	"root",
	"program",
	"idle",
	"garbage-collector",
	"native",
	"third-party",
	"test-fixture",
	"node-product",
	"storage-node-product",
	"workspace-dependency",
	"runtime-or-native",
	"other",
]);
const D108E4M_NEAREST_OWNER_CLASSES = Object.freeze([
	"test-fixture",
	"node-product",
	"storage-node-product",
	"workspace-dependency",
	"third-party",
	"runtime-or-native",
	"other",
	"unattributed-runtime",
	"unattributed-gc",
]);
const D108E4M_PROFILE_KEYS = Object.freeze(
	[
		"concurrentDurationMs",
		"deltaCount",
		"dominance",
		"facades",
		"idleMicros",
		"idleSampleCount",
		"leafTotals",
		"nearestOwnerTotals",
		"outcome",
		"pid",
		"profileCoverageRatio",
		"profileDurationMicros",
		"profileEndTimeMicros",
		"profileStartTimeMicros",
		"sampleCount",
		"sampledMicros",
		"samplingIntervalMicros",
		"schema",
		"topFrames",
		"unsampledMicros",
		"zeroDeltaCount",
	].sort()
);
const D108E4M_UNAVAILABLE_KEYS = Object.freeze(
	["classification", "message", "outcome", "pid", "profileStarted", "profileStopped", "schema"].sort()
);
const D108E4M_UNAVAILABLE_CLASSIFICATIONS = Object.freeze([
	"inspector-start-failed",
	"inspector-stop-failed",
	"profile-structural-malformation",
	"missing-terminal-proof",
	"launcher-or-child-error",
]);

function d108e4mProfileEnabled(value: string | undefined): boolean {
	return value === "1";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonnegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function ordinalCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function validateSpan(
	errors: string[],
	value: unknown,
	expectedName: string,
	minimumOffset: number,
	maximumOffset: number
): Readonly<Record<string, unknown>> | undefined {
	if (!isRecord(value)) {
		errors.push(`${expectedName}:record`);
		return undefined;
	}
	if (value.name !== expectedName) errors.push(`${expectedName}:name`);
	if (!isNonnegativeNumber(value.startOffsetMs)) errors.push(`${expectedName}:start`);
	if (!isNonnegativeNumber(value.endOffsetMs)) errors.push(`${expectedName}:end`);
	if (!isNonnegativeNumber(value.durationMs)) errors.push(`${expectedName}:duration`);
	if (
		isNonnegativeNumber(value.startOffsetMs) &&
		isNonnegativeNumber(value.endOffsetMs) &&
		isNonnegativeNumber(value.durationMs)
	) {
		if (value.startOffsetMs < minimumOffset || value.endOffsetMs > maximumOffset) {
			errors.push(`${expectedName}:bounds`);
		}
		if (value.endOffsetMs < value.startOffsetMs) errors.push(`${expectedName}:order`);
		if (value.durationMs !== value.endOffsetMs - value.startOffsetMs) errors.push(`${expectedName}:arithmetic`);
	}
	return value;
}

function d108e4lValidation(result: unknown): Readonly<{ errors: string[]; memberCountErrors: string[] }> {
	const errors: string[] = [];
	const memberCountErrors: string[] = [];
	const message = isRecord(result) ? result : undefined;
	const proof = isRecord(message?.proof) ? message.proof : undefined;
	const timing = isRecord(proof?.timing) ? proof.timing : undefined;
	if (timing === undefined) return { errors: ["timing:record"], memberCountErrors };
	if (timing.schema !== "d108e4l-v1") errors.push("timing:schema");
	if (timing.outcome !== "proof") errors.push("timing:outcome");
	if (timing.nodeVersion !== process.version) errors.push("timing:nodeVersion");
	if (timing.platform !== process.platform) errors.push("timing:platform");
	if (timing.arch !== process.arch) errors.push("timing:arch");
	if (
		typeof timing.availableParallelism !== "number" ||
		!Number.isInteger(timing.availableParallelism) ||
		timing.availableParallelism <= 0
	) {
		errors.push("timing:availableParallelism");
	}
	if (
		typeof timing.pid !== "number" ||
		!Number.isInteger(timing.pid) ||
		timing.pid === process.pid ||
		timing.pid !== proof?.pid
	)
		errors.push("timing:pid");
	if (!isNonnegativeNumber(timing.wallTimeMs) || timing.wallTimeMs !== proof?.wallTimeMs) {
		errors.push("timing:wallTimeMs");
	}

	const wallTimeMs = isNonnegativeNumber(timing.wallTimeMs) ? timing.wallTimeMs : 0;
	const phases = Array.isArray(timing.phases) ? timing.phases : [];
	if (
		!sameJson(
			phases.map((phase) => (isRecord(phase) ? phase.name : undefined)),
			D108E4L_PHASE_NAMES
		)
	) {
		errors.push("phases:roster");
	}
	let expectedStart = 0;
	for (const [index, expectedName] of D108E4L_PHASE_NAMES.entries()) {
		const phase = validateSpan(errors, phases[index], expectedName, 0, wallTimeMs);
		if (phase === undefined) continue;
		if (phase.startOffsetMs !== expectedStart) errors.push(`${expectedName}:contiguous`);
		if (isNonnegativeNumber(phase.endOffsetMs)) expectedStart = phase.endOffsetMs;
		if (!sameJson(phase.counts, D108E4L_PHASE_COUNTS[index])) errors.push(`${expectedName}:counts`);
		if (!isNonnegativeNumber(phase.maxRssKiB)) errors.push(`${expectedName}:maxRssKiB`);
		const resourceDelta = isRecord(phase.resourceDelta) ? phase.resourceDelta : undefined;
		for (const field of ["userCPUTime", "systemCPUTime", "fsRead", "fsWrite", "involuntaryContextSwitches"]) {
			if (!isNonnegativeNumber(resourceDelta?.[field])) errors.push(`${expectedName}:resourceDelta:${field}`);
		}
	}
	if (expectedStart !== wallTimeMs) errors.push("phases:final-boundary");

	const concurrent = isRecord(phases[8]) ? phases[8] : undefined;
	const concurrentStart = isNonnegativeNumber(concurrent?.startOffsetMs) ? concurrent.startOffsetMs : 0;
	const concurrentEnd = isNonnegativeNumber(concurrent?.endOffsetMs) ? concurrent.endOffsetMs : wallTimeMs;
	const members = Array.isArray(timing.members) ? timing.members : [];
	if (
		!sameJson(
			members.map((member) => (isRecord(member) ? member.name : undefined)),
			D108E4L_MEMBER_NAMES
		)
	) {
		errors.push("members:roster");
	}
	for (const [index, expectedName] of D108E4L_MEMBER_NAMES.entries()) {
		const member = validateSpan(errors, members[index], expectedName, concurrentStart, concurrentEnd);
		if (member === undefined) continue;
		if (!sameJson(member.counts, D108E4L_MEMBER_COUNTS[index])) memberCountErrors.push(`${expectedName}:counts`);
		const steps = Array.isArray(member.steps) ? member.steps : [];
		if (
			!sameJson(
				steps.map((step) => (isRecord(step) ? step.name : undefined)),
				D108E4L_STEP_NAMES
			)
		) {
			errors.push(`${expectedName}:steps`);
		}
		let stepStart = isNonnegativeNumber(member.startOffsetMs) ? member.startOffsetMs : concurrentStart;
		for (const [stepIndex, stepName] of D108E4L_STEP_NAMES.entries()) {
			const step = validateSpan(errors, steps[stepIndex], stepName, concurrentStart, concurrentEnd);
			if (step === undefined) continue;
			if (step.startOffsetMs !== stepStart) errors.push(`${expectedName}:${stepName}:contiguous`);
			if (isNonnegativeNumber(step.endOffsetMs)) stepStart = step.endOffsetMs;
		}
		if (stepStart !== member.endOffsetMs) errors.push(`${expectedName}:steps-final-boundary`);
	}
	const reuseZero = isRecord(members[1]) ? members[1] : undefined;
	const reuseOne = isRecord(members[2]) ? members[2] : undefined;
	const reuseZeroEnd = reuseZero?.endOffsetMs;
	const reuseOneStart = reuseOne?.startOffsetMs;
	if (!isNonnegativeNumber(reuseZeroEnd) || !isNonnegativeNumber(reuseOneStart) || reuseZeroEnd > reuseOneStart) {
		errors.push("members:reuse-order");
	}
	return { errors, memberCountErrors };
}

function isNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function d108e4mCounterValidation(
	errors: string[],
	value: unknown,
	expectedNames: readonly string[],
	label: string
): Readonly<{ micros: number; sampleCount: number }> {
	const counters = Array.isArray(value) ? value : [];
	if (
		!sameJson(
			counters.map((counter) => (isRecord(counter) ? counter.name : undefined)),
			expectedNames
		)
	) {
		errors.push(`${label}:roster`);
	}
	let micros = 0;
	let sampleCount = 0;
	for (const [index, name] of expectedNames.entries()) {
		const counter = isRecord(counters[index]) ? counters[index] : undefined;
		if (!sameJson(Object.keys(counter ?? {}).sort(), ["micros", "name", "sampleCount"])) {
			errors.push(`${label}:${name}:keys`);
		}
		if (!isNonnegativeInteger(counter?.micros)) errors.push(`${label}:${name}:micros`);
		else micros += counter.micros;
		if (!isNonnegativeInteger(counter?.sampleCount)) errors.push(`${label}:${name}:sampleCount`);
		else sampleCount += counter.sampleCount;
	}
	return { micros, sampleCount };
}

function d108e4mValidation(
	result: unknown
): Readonly<{ errors: string[]; record?: Readonly<Record<string, unknown>> }> {
	const errors: string[] = [];
	const message = isRecord(result) ? result : undefined;
	const proof = isRecord(message?.proof) ? message.proof : undefined;
	const record = isRecord(proof?.d108e4m) ? proof.d108e4m : undefined;
	if (!d108e4mProfileEnabled(process.env.TS_DRP_D108E4M_PROFILE)) {
		if (record !== undefined) errors.push("ordinary-mode:unexpected-record");
		return { errors, record };
	}
	if (record === undefined) return { errors: ["d108e4m:record"] };
	if (record.schema !== "d108e4m-v1") errors.push("d108e4m:schema");
	if (!isNonnegativeInteger(record.pid) || record.pid === process.pid || record.pid !== proof?.pid) {
		errors.push("d108e4m:pid");
	}
	if (record.outcome === "unavailable") {
		if (!sameJson(Object.keys(record).sort(), D108E4M_UNAVAILABLE_KEYS)) errors.push("unavailable:keys");
		if (!D108E4M_UNAVAILABLE_CLASSIFICATIONS.includes(String(record.classification))) {
			errors.push("unavailable:classification");
		}
		if (typeof record.message !== "string" || record.message.length > 512) errors.push("unavailable:message");
		if (typeof record.profileStarted !== "boolean") errors.push("unavailable:profileStarted");
		if (typeof record.profileStopped !== "boolean") errors.push("unavailable:profileStopped");
		if (record.profileStopped === true && record.profileStarted !== true) errors.push("unavailable:stop-before-start");
		errors.push(`unavailable:${String(record.classification)}`);
		return { errors, record };
	}
	if (record.outcome !== "profile") errors.push("profile:outcome");
	if (!sameJson(Object.keys(record).sort(), D108E4M_PROFILE_KEYS)) errors.push("profile:keys");
	for (const field of [
		"profileStartTimeMicros",
		"profileEndTimeMicros",
		"profileDurationMicros",
		"sampledMicros",
		"unsampledMicros",
		"sampleCount",
		"deltaCount",
		"zeroDeltaCount",
		"idleMicros",
		"idleSampleCount",
	]) {
		if (!isNonnegativeInteger(record[field])) errors.push(`profile:${field}`);
	}
	if (record.samplingIntervalMicros !== 1_000) errors.push("profile:samplingIntervalMicros");
	if (!isNonnegativeNumber(record.concurrentDurationMs) || record.concurrentDurationMs === 0) {
		errors.push("profile:concurrentDurationMs");
	}
	if (
		!isNonnegativeNumber(record.profileCoverageRatio) ||
		record.profileCoverageRatio === 0 ||
		record.profileCoverageRatio > 1
	) {
		errors.push("profile:profileCoverageRatio");
	}
	if (
		isNonnegativeInteger(record.profileStartTimeMicros) &&
		isNonnegativeInteger(record.profileEndTimeMicros) &&
		isNonnegativeInteger(record.profileDurationMicros) &&
		record.profileDurationMicros !== record.profileEndTimeMicros - record.profileStartTimeMicros
	) {
		errors.push("profile:duration-arithmetic");
	}
	if (
		isNonnegativeInteger(record.profileDurationMicros) &&
		isNonnegativeInteger(record.sampledMicros) &&
		isNonnegativeInteger(record.unsampledMicros) &&
		record.profileDurationMicros !== record.sampledMicros + record.unsampledMicros
	) {
		errors.push("profile:sampled-arithmetic");
	}
	if (
		isNonnegativeInteger(record.sampleCount) &&
		isNonnegativeInteger(record.deltaCount) &&
		record.sampleCount !== record.deltaCount
	) {
		errors.push("profile:sample-delta-count");
	}
	if (
		isNonnegativeInteger(record.zeroDeltaCount) &&
		isNonnegativeInteger(record.deltaCount) &&
		record.zeroDeltaCount > record.deltaCount
	) {
		errors.push("profile:zeroDeltaCount");
	}
	if (
		isNonnegativeInteger(record.profileDurationMicros) &&
		isNonnegativeNumber(record.concurrentDurationMs) &&
		isNonnegativeNumber(record.profileCoverageRatio) &&
		record.profileCoverageRatio !== record.profileDurationMicros / (record.concurrentDurationMs * 1_000)
	) {
		errors.push("profile:coverage-arithmetic");
	}

	const leafTotals = d108e4mCounterValidation(errors, record.leafTotals, D108E4M_LEAF_CLASSES, "leafTotals");
	const nearestTotals = d108e4mCounterValidation(
		errors,
		record.nearestOwnerTotals,
		D108E4M_NEAREST_OWNER_CLASSES,
		"nearestOwnerTotals"
	);
	if (isNonnegativeInteger(record.sampledMicros) && leafTotals.micros !== record.sampledMicros) {
		errors.push("leafTotals:micros-sum");
	}
	if (isNonnegativeInteger(record.sampleCount) && leafTotals.sampleCount !== record.sampleCount) {
		errors.push("leafTotals:sampleCount-sum");
	}
	if (
		isNonnegativeInteger(record.sampledMicros) &&
		isNonnegativeInteger(record.idleMicros) &&
		nearestTotals.micros + record.idleMicros !== record.sampledMicros
	) {
		errors.push("nearestOwnerTotals:micros-sum");
	}
	if (
		isNonnegativeInteger(record.sampleCount) &&
		isNonnegativeInteger(record.idleSampleCount) &&
		nearestTotals.sampleCount + record.idleSampleCount !== record.sampleCount
	) {
		errors.push("nearestOwnerTotals:sampleCount-sum");
	}
	const leafArray = Array.isArray(record.leafTotals) ? record.leafTotals : [];
	const idleCounter = isRecord(leafArray[2]) ? leafArray[2] : undefined;
	if (idleCounter?.micros !== record.idleMicros || idleCounter?.sampleCount !== record.idleSampleCount) {
		errors.push("profile:idle-counter");
	}

	const dominance = isRecord(record.dominance) ? record.dominance : undefined;
	const dominanceKeys = [
		"denominatorMicros",
		"runnerUp",
		"runnerUpBasisPoints",
		"runnerUpMicros",
		"winner",
		"winnerBasisPoints",
		"winnerMicros",
	].sort();
	if (!sameJson(Object.keys(dominance ?? {}).sort(), dominanceKeys)) errors.push("dominance:keys");
	const nearestArray = Array.isArray(record.nearestOwnerTotals)
		? (record.nearestOwnerTotals.filter(isRecord) as Readonly<Record<string, unknown>>[])
		: [];
	const ranked = [...nearestArray].sort((left, right) => {
		const leftMicros = isNonnegativeInteger(left.micros) ? left.micros : 0;
		const rightMicros = isNonnegativeInteger(right.micros) ? right.micros : 0;
		return rightMicros - leftMicros || ordinalCompare(String(left.name), String(right.name));
	});
	const leading = ranked[0];
	const runnerUp = ranked[1];
	if (leading !== undefined && runnerUp !== undefined && nearestTotals.micros > 0) {
		const leadingMicros = isNonnegativeInteger(leading.micros) ? leading.micros : 0;
		const runnerUpMicros = isNonnegativeInteger(runnerUp.micros) ? runnerUp.micros : 0;
		const dominant =
			leadingMicros * 2 > nearestTotals.micros && (leadingMicros - runnerUpMicros) * 10 >= nearestTotals.micros;
		if (dominance?.denominatorMicros !== nearestTotals.micros) errors.push("dominance:denominatorMicros");
		if (dominance?.winner !== (dominant ? leading.name : "mixed")) errors.push("dominance:winner");
		if (dominance?.winnerMicros !== leadingMicros) errors.push("dominance:winnerMicros");
		if (dominance?.runnerUp !== runnerUp.name) errors.push("dominance:runnerUp");
		if (dominance?.runnerUpMicros !== runnerUpMicros) errors.push("dominance:runnerUpMicros");
		if (dominance?.winnerBasisPoints !== Math.floor((leadingMicros * 10_000) / nearestTotals.micros)) {
			errors.push("dominance:winnerBasisPoints");
		}
		if (dominance?.runnerUpBasisPoints !== Math.floor((runnerUpMicros * 10_000) / nearestTotals.micros)) {
			errors.push("dominance:runnerUpBasisPoints");
		}
	} else errors.push("dominance:ranking");

	const topFrames = Array.isArray(record.topFrames) ? record.topFrames : [];
	if (topFrames.length > 40) errors.push("topFrames:length");
	let precedingFrame: Readonly<Record<string, unknown>> | undefined;
	for (const [index, value] of topFrames.entries()) {
		const frame = isRecord(value) ? value : undefined;
		if (frame === undefined) {
			errors.push(`topFrames:${index}:record`);
			continue;
		}
		if (
			!sameJson(Object.keys(frame).sort(), [
				"columnNumber",
				"functionName",
				"leafClass",
				"lineNumber",
				"nearestOwner",
				"sampleCount",
				"selfMicros",
				"url",
			])
		) {
			errors.push(`topFrames:${index}:keys`);
		}
		if (!D108E4M_LEAF_CLASSES.includes(String(frame.leafClass))) errors.push(`topFrames:${index}:leafClass`);
		if (typeof frame.functionName !== "string") errors.push(`topFrames:${index}:functionName`);
		if (typeof frame.url !== "string" || frame.url.startsWith("file:") || frame.url.includes("/Users/")) {
			errors.push(`topFrames:${index}:url`);
		}
		if (
			typeof frame.lineNumber !== "number" ||
			!Number.isSafeInteger(frame.lineNumber) ||
			typeof frame.columnNumber !== "number" ||
			!Number.isSafeInteger(frame.columnNumber)
		) {
			errors.push(`topFrames:${index}:coordinates`);
		}
		if (!isNonnegativeInteger(frame.sampleCount)) errors.push(`topFrames:${index}:sampleCount`);
		if (!isNonnegativeInteger(frame.selfMicros)) errors.push(`topFrames:${index}:selfMicros`);
		if (precedingFrame !== undefined) {
			const precedingMicros = Number(precedingFrame.selfMicros);
			const currentMicros = Number(frame.selfMicros);
			const precedingIdentity = `${String(precedingFrame.url)}\u0000${String(precedingFrame.functionName)}\u0000${String(precedingFrame.lineNumber)}\u0000${String(precedingFrame.columnNumber)}`;
			const currentIdentity = `${String(frame.url)}\u0000${String(frame.functionName)}\u0000${String(frame.lineNumber)}\u0000${String(frame.columnNumber)}`;
			if (
				precedingMicros < currentMicros ||
				(precedingMicros === currentMicros && precedingIdentity > currentIdentity)
			) {
				errors.push(`topFrames:${index}:order`);
			}
		}
		precedingFrame = frame;
	}

	const facades = Array.isArray(record.facades) ? record.facades : [];
	if (
		!sameJson(
			facades.map((facade) => (isRecord(facade) ? facade.name : undefined)),
			D108E4M_MEMBER_NAMES
		)
	) {
		errors.push("facades:roster");
	}
	for (const [index, name] of D108E4M_MEMBER_NAMES.entries()) {
		const facade = isRecord(facades[index]) ? facades[index] : undefined;
		if (!sameJson(Object.keys(facade ?? {}).sort(), ["methods", "name"])) errors.push(`facades:${name}:keys`);
		const methods = Array.isArray(facade?.methods) ? facade.methods : [];
		if (
			!sameJson(
				methods.map((method) => (isRecord(method) ? method.method : undefined)),
				D108E4M_FACADE_METHODS
			)
		) {
			errors.push(`facades:${name}:methods`);
		}
		for (const [methodIndex, methodName] of D108E4M_FACADE_METHODS.entries()) {
			const method = isRecord(methods[methodIndex]) ? methods[methodIndex] : undefined;
			if (!sameJson(Object.keys(method ?? {}).sort(), ["callCount", "method", "syncBodyMs"])) {
				errors.push(`facades:${name}:${methodName}:keys`);
			}
			if (!isNonnegativeInteger(method?.callCount)) errors.push(`facades:${name}:${methodName}:callCount`);
			if (!isNonnegativeNumber(method?.syncBodyMs)) errors.push(`facades:${name}:${methodName}:syncBodyMs`);
		}
	}
	return { errors, record };
}

function emitD108e4lProof(result: unknown): void {
	const message = isRecord(result) ? result : undefined;
	const proof = isRecord(message?.proof) ? message.proof : undefined;
	const d108e4m = d108e4mValidation(result);
	const validation = d108e4lValidation(result);
	if (d108e4mProfileEnabled(process.env.TS_DRP_D108E4M_PROFILE)) {
		const profile =
			d108e4m.record === undefined
				? Object.freeze({
						outcome: "invalid-envelope",
						proofKeys: Object.freeze(Object.keys(proof ?? {}).sort()),
						schema: "d108e4m-v1",
					})
				: d108e4m.record;
		console.log(
			`D108E4M_PROFILE ${JSON.stringify(Object.freeze({ ...profile, validationErrors: Object.freeze(d108e4m.errors) }))}`
		);
	}
	const timing = isRecord(proof?.timing)
		? Object.freeze({ ...proof.timing, memberCountErrors: Object.freeze(validation.memberCountErrors) })
		: Object.freeze({
				outcome: "invalid-proof",
				proofKeys: Object.freeze(Object.keys(proof ?? {}).sort()),
				schema: "d108e4l-v1",
			});
	console.log(`D108E4L_TIMING ${JSON.stringify(timing)}`);
	expect(validation.errors).toEqual([]);
	if (d108e4mProfileEnabled(process.env.TS_DRP_D108E4M_PROFILE)) expect.soft(d108e4m.errors).toEqual([]);
	else expect(d108e4m.errors).toEqual([]);
}

function emitD108e4mUnavailable(error: unknown): void {
	if (!d108e4mProfileEnabled(process.env.TS_DRP_D108E4M_PROFILE)) return;
	const message = error instanceof Error ? error.message : String(error);
	const classification = message.includes("child failed") ? "missing-terminal-proof" : "launcher-or-child-error";
	console.log(
		`D108E4M_PROFILE ${JSON.stringify({ classification, message: message.slice(0, 512), outcome: "unavailable", pid: null, profileStarted: false, profileStopped: false, schema: "d108e4m-v1", validationErrors: [`unavailable:${classification}`] })}`
	);
}

function emitD108e4lUnavailable(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const classification = message.includes("child timeout")
		? "timeout"
		: message.includes("child failed")
			? "missing-terminal-proof"
			: "unclassified-child-or-launcher-error";
	console.log(
		`D108E4L_TIMING ${JSON.stringify({ classification, launcherContractErasedKind: true, message, outcome: "unavailable", schema: "d108e4l-v1" })}`
	);
}

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

afterAll(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

async function durableMaterial(directory: string): Promise<unknown> {
	const fixture = await openD108d1bMultiWriterFixture();
	try {
		return await createD108d1PackedDurableMaterial(fixture, directory);
	} finally {
		await fixture.close();
	}
}

let sharedChildResult: ReturnType<typeof runD108d1bLocalAuthorChild> | undefined;

function runSharedChild(): ReturnType<typeof runD108d1bLocalAuthorChild> {
	if (sharedChildResult !== undefined) return sharedChildResult;
	const directory = mkdtempSync(join(tmpdir(), "ts-drp-d108d1b-local-author-"));
	directories.push(directory);
	sharedChildResult = durableMaterial(directory).then((material) => runD108d1bLocalAuthorChild(material));
	return sharedChildResult;
}

let skipBudgetChildResult: ReturnType<typeof runD108e2eSkipBudgetChild> | undefined;

function runSkipBudgetChild(): ReturnType<typeof runD108e2eSkipBudgetChild> {
	if (skipBudgetChildResult !== undefined) return skipBudgetChildResult;
	const directory = mkdtempSync(join(tmpdir(), "ts-drp-d108e2e-skip-budget-"));
	directories.push(directory);
	const launched = durableMaterial(directory).then((material) => runD108e2eSkipBudgetChild(material));
	skipBudgetChildResult = launched.then(
		(result) => {
			emitD108e4lProof(result);
			return result;
		},
		(error: unknown) => {
			emitD108e4mUnavailable(error);
			emitD108e4lUnavailable(error);
			throw error;
		}
	);
	return skipBudgetChildResult;
}

describe("D.108d1b authenticated peer-local fresh-process issuance RED", () => {
	it("pins the complete child inventory to the genuine built-package launcher", () => {
		expect(D108D1B_CHILD_BEHAVIORS).toEqual([
			"fresh Node binds established and fresh chat peers while every ambiguous or unauthenticated cold reopen fails before live effects",
		]);
		expect(D108E2D_CHILD_BEHAVIORS).toEqual([
			"fresh Node predecessor recovery terminates with one issued-record read per distinct current or authenticated-future row",
		]);
		expect(D108E2E_CHILD_BEHAVIORS).toEqual([
			"fresh Node predecessor recovery enforces one cumulative authenticated future-row skip budget per recovery",
		]);
		expect(D108E4_CHILD_BEHAVIORS).toEqual([
			"fresh Node closes the D.108e4 authenticated oracle and per-reopen budget debt",
		]);
		expect(d108e4mProfileEnabled(undefined)).toBe(false);
		expect(d108e4mProfileEnabled("")).toBe(false);
		expect(d108e4mProfileEnabled("true")).toBe(false);
		expect(d108e4mProfileEnabled("0")).toBe(false);
		expect(d108e4mProfileEnabled("1")).toBe(true);
		expect(childPath.pathname.endsWith("phase-6a-creator-successor-local-author-child.mjs")).toBe(true);
	});

	it(D108D1B_CHILD_BEHAVIORS[0], async () => {
		const result = await runSharedChild();
		const proof = result.proof as
			| Readonly<{
					readonly authors?: Readonly<Record<string, string>>;
					readonly oracle?: Readonly<Record<string, unknown>>;
					readonly pid?: number;
					readonly results?: readonly Readonly<Record<string, unknown>>[];
			  }>
			| undefined;
		expect(proof?.pid).toEqual(expect.any(Number));
		expect(proof?.pid).not.toBe(process.pid);
		const expectedAcl = d108d1bChatAuthorities()
			.map(({ author, groups }) => ({ author, groups: [...groups] }))
			.sort((left, right) => left.author.localeCompare(right.author));
		const oracle = proof?.oracle as
			| Readonly<{
					readonly malformedMemberControl?: Readonly<Record<string, unknown>>;
					readonly aclMembers?: readonly Readonly<{ readonly author: string; readonly groups: readonly string[] }>[];
					readonly bobCarrier?: Readonly<Record<string, unknown>>;
			  }>
			| undefined;
		expect([...(oracle?.aclMembers ?? [])].sort((left, right) => left.author.localeCompare(right.author))).toEqual(
			expectedAcl
		);
		expect(oracle?.aclMembers?.filter(({ groups }) => groups.includes("writer"))).toHaveLength(7);
		expect(oracle?.aclMembers?.find(({ author }) => author === proof?.authors?.dave)?.groups).toEqual(["finality"]);
		expect(oracle?.bobCarrier).toMatchObject({
			exactlyOnce: true,
			preimageMatches: true,
			scopeMatches: true,
			signatureMatches: true,
			sourceKind: "received",
		});
		expect.soft(oracle?.malformedMemberControl).toEqual({
			canonical: true,
			digestMatches: true,
			result: { ok: false, reason: "snapshot-mismatch" },
		});
		const results = proof?.results ?? [];
		expect
			.soft(results.map(({ name }) => name))
			.toEqual([
				"established-bob",
				"fresh-carol",
				"forged-future-outbox",
				"malformed-future-outbox",
				"future-outbox-read-failure",
				"current-outbox-read-failure",
				"current-outbox-issued-mismatch",
				"copied-creator-lineage",
				"wrong-author-right-signer",
				"right-author-wrong-signer",
				"two-nonzero-lineages",
				"anchor-replay",
				"signer-mutation",
				"signature-alias",
				"signer-throw",
				"signer-reject",
				"non-writer",
				"selected-exhausted-lineage",
				"foreign-exhausted-lineage",
				"malformed-exhausted-lineage",
				"missing-webcrypto",
				"ed25519-unavailable",
				"negative-lineage-next",
				"unsafe-lineage-next",
			]);
		const [
			established,
			fresh,
			forgedFuture,
			malformedFuture,
			backingFailure,
			currentBackingFailure,
			currentMismatch,
			...rejected
		] = results;
		expect(established).toMatchObject({
			issued: {
				acceptedJournalAuthor: proof?.authors?.bob,
				author: proof?.authors?.bob,
				authorSequence: 1,
				issuedRowAuthor: proof?.authors?.bob,
				outboxRowAuthor: proof?.authors?.bob,
			},
			result: { lifecycle: "active", ok: true, recovery: "active-new" },
			repeat: {
				issued: {
					acceptedJournalAuthor: proof?.authors?.bob,
					author: proof?.authors?.bob,
					authorSequence: 2,
					issuedRowAuthor: proof?.authors?.bob,
					outboxRowAuthor: proof?.authors?.bob,
				},
				result: { lifecycle: "active", ok: true, recovery: "active-new" },
			},
		});
		expect(fresh).toMatchObject({
			issued: {
				acceptedJournalAuthor: proof?.authors?.carol,
				author: proof?.authors?.carol,
				authorSequence: 0,
				issuedRowAuthor: proof?.authors?.carol,
				outboxRowAuthor: proof?.authors?.carol,
			},
			result: { lifecycle: "active", ok: true, recovery: "active-new" },
		});
		for (const [control, detail] of [
			[forgedFuture, "creator predecessor recovery failed: admission-rejected"],
			[malformedFuture, "creator predecessor recovery failed: admission-rejected"],
			[backingFailure, "creator predecessor recovery failed: issuance-rejected"],
		] as const) {
			expect(control).toMatchObject({
				effects: {
					adoptionSwapCount: 0,
					aheRecoverCount: 2,
					installEpochAnchorCount: 1,
					issuanceStoreShape: true,
					publicationCount: 0,
					snapshotOpenCount: 2,
					subscribeCount: 1,
					transactIssueCount: 1,
				},
				issued: { author: proof?.authors?.bob, authorSequence: 1 },
				repeat: { result: { detail, kind: "recovery-rejected", ok: false } },
				result: { lifecycle: "active", ok: true, recovery: "active-new" },
			});
		}
		for (const control of [currentBackingFailure, currentMismatch]) {
			expect(control).toMatchObject({
				effects: {
					adoptionSwapCount: 0,
					aheRecoverCount: 1,
					installEpochAnchorCount: 0,
					issuanceStoreShape: true,
					publicationCount: 0,
					snapshotOpenCount: 1,
					subscribeCount: 0,
					transactIssueCount: 0,
				},
				result: {
					detail: "creator predecessor recovery failed: issuance-rejected",
					kind: "recovery-rejected",
					ok: false,
				},
			});
		}
		const writerAuthors = d108d1bChatAuthorities()
			.filter(({ groups }) => groups.includes("writer"))
			.map(({ author }) => author)
			.sort();
		for (const [accepted, reopenCount] of [
			[established, 2],
			[fresh, 1],
		] as const) {
			const effects = accepted?.effects as
				| Readonly<{
						readonly aheRecoverCount?: number;
						readonly authorityEvents?: readonly Readonly<{
							readonly attempt: number;
							readonly author?: string;
							readonly kind: string;
						}>[];
						readonly issuanceStoreShape?: boolean;
						readonly lineageReads?: readonly string[];
						readonly order?: readonly string[];
						readonly snapshotOpenCount?: number;
				  }>
				| undefined;
			expect(effects?.aheRecoverCount).toBe(reopenCount);
			expect(effects?.snapshotOpenCount).toBe(reopenCount);
			expect(effects?.issuanceStoreShape).toBe(true);
			const reads = effects?.lineageReads ?? [];
			expect(reads).toHaveLength(7 * reopenCount);
			for (let offset = 0; offset < reads.length; offset += 7) {
				expect([...reads.slice(offset, offset + 7)].sort()).toEqual(writerAuthors);
			}
			const signerCalls = accepted?.signerCalls as readonly Readonly<{
				bytes: string;
				matchesDurableCarrier: boolean;
				ordinary: boolean;
				use: string;
			}>[];
			expect(signerCalls).toHaveLength(2 * reopenCount);
			expect(signerCalls.every(({ bytes, ordinary }) => ordinary && bytes.length === 64)).toBe(true);
			const possessions = signerCalls.filter(({ use }) => use === "possession");
			expect(possessions).toHaveLength(reopenCount);
			expect(possessions.every(({ matchesDurableCarrier }) => !matchesDurableCarrier)).toBe(true);
			const order = effects?.order ?? [];
			const possessionIndices = order.flatMap((entry, index) => (entry === "possession:signer" ? [index] : []));
			expect(possessionIndices).toHaveLength(reopenCount);
			for (const [positionIndex, position] of possessionIndices.entries()) {
				const end = possessionIndices[positionIndex + 1] ?? order.length;
				const selected = order.slice(position + 1, end).filter((entry) => entry.startsWith("lineage:"));
				expect(selected).toHaveLength(7);
			}
			const authorityEvents = effects?.authorityEvents ?? [];
			expect.soft(authorityEvents).toHaveLength(8 * reopenCount);
			for (let attempt = 0; attempt < reopenCount; attempt += 1) {
				const window = authorityEvents.filter((event) => event.attempt === attempt);
				expect.soft(window[0]).toEqual({ attempt, kind: "possession-signer" });
				expect
					.soft(window.slice(1).map(({ author, kind }) => ({ author, kind })))
					.toEqual(writerAuthors.map((author) => ({ author, kind: "lineage-read" })));
			}
		}
		const establishedPossessions = (
			established?.signerCalls as readonly Readonly<{ bytes: string; use: string }>[]
		).filter(({ use }) => use === "possession");
		const freshPossessions = (fresh?.signerCalls as readonly Readonly<{ bytes: string; use: string }>[]).filter(
			({ use }) => use === "possession"
		);
		expect(new Set([...establishedPossessions, ...freshPossessions].map(({ bytes }) => bytes)).size).toBe(3);
		for (const failure of rejected) {
			expect(failure).toMatchObject({
				effects: {
					adoptionSwapCount: 0,
					aheRecoverCount: 1,
					installEpochAnchorCount: 0,
					issuanceStoreShape: true,
					publicationCount: 0,
					snapshotOpenCount: 1,
					subscribeCount: 0,
					transactIssueCount: 0,
				},
				result: { kind: "chain-invalid", ok: false },
			});
		}
		for (const name of [
			"wrong-author-right-signer",
			"right-author-wrong-signer",
			"anchor-replay",
			"signer-mutation",
			"signature-alias",
			"signer-throw",
			"signer-reject",
			"missing-webcrypto",
			"ed25519-unavailable",
		]) {
			const failure = rejected.find((candidate) => candidate.name === name);
			const effects = failure?.effects as Readonly<{ readonly lineageReads?: readonly string[] }> | undefined;
			expect(effects?.lineageReads).toEqual([]);
			expect(failure?.result).toEqual({
				detail: "creator issuance possession proof failed",
				kind: "chain-invalid",
				ok: false,
			});
		}
		const nonWriter = rejected.find((candidate) => candidate.name === "non-writer");
		expect(nonWriter?.result).toEqual({
			detail: "creator issuance ACL authority is invalid",
			kind: "chain-invalid",
			ok: false,
		});
		for (const name of [
			"copied-creator-lineage",
			"two-nonzero-lineages",
			"selected-exhausted-lineage",
			"foreign-exhausted-lineage",
			"malformed-exhausted-lineage",
			"negative-lineage-next",
			"unsafe-lineage-next",
		]) {
			const failure = rejected.find((candidate) => candidate.name === name);
			expect(failure?.result).toEqual({
				detail: "creator issuance lineage is invalid",
				kind: "chain-invalid",
				ok: false,
			});
		}
		for (const candidate of results) {
			const possessionCalls = (
				candidate.signerCalls as readonly Readonly<{ readonly use?: string }>[] | undefined
			)?.filter(({ use }) => use === "possession").length;
			if (possessionCalls === undefined || possessionCalls === 0) continue;
			const events = (
				candidate.effects as
					| Readonly<{
							readonly authorityEvents?: readonly Readonly<{
								readonly attempt: number;
								readonly kind: string;
							}>[];
					  }>
					| undefined
			)?.authorityEvents;
			expect.soft(events?.filter(({ kind }) => kind === "possession-signer")).toHaveLength(possessionCalls);
			for (const lineage of events?.filter(({ kind }) => kind === "lineage-read") ?? []) {
				const signerIndex =
					events?.findIndex((event) => event.attempt === lineage.attempt && event.kind === "possession-signer") ?? -1;
				expect.soft(signerIndex).toBeGreaterThanOrEqual(0);
				expect.soft(signerIndex).toBeLessThan(events?.indexOf(lineage) ?? -1);
			}
		}
	});

	it(
		D108E4_CHILD_BEHAVIORS[0],
		async () => {
			const localAuthorResult = await runSharedChild();
			const localAuthorProof = localAuthorResult.proof as
				| Readonly<{
						readonly oracle?: Readonly<Record<string, unknown>>;
						readonly results?: readonly Readonly<Record<string, unknown>>[];
				  }>
				| undefined;
			expect.soft(localAuthorProof?.oracle?.authenticatedAclControl).toEqual({
				anchorDigestMatches: true,
				bytesMatch: true,
				digestMatches: true,
			});
			const writerAuthors = d108d1bChatAuthorities()
				.filter(({ groups }) => groups.includes("writer"))
				.map(({ author }) => author)
				.sort();
			for (const [name, windowCount] of [
				["established-bob", 2],
				["fresh-carol", 1],
			] as const) {
				const candidate = localAuthorProof?.results?.find((result) => result.name === name);
				const events = (
					candidate?.effects as
						| Readonly<{
								readonly authorityEvents?: readonly Readonly<{
									readonly attempt: number;
									readonly author?: string;
									readonly kind: string;
								}>[];
						  }>
						| undefined
				)?.authorityEvents;
				expect.soft(events, name).toHaveLength(windowCount * 8);
				for (let attempt = 0; attempt < windowCount; attempt += 1) {
					const window = events?.slice(attempt * 8, attempt * 8 + 8) ?? [];
					expect.soft(window[0], `${name}:${attempt}:possession`).toEqual({
						attempt,
						kind: "possession-signer",
					});
					expect
						.soft(
							window.slice(1).map(({ attempt: observedAttempt, author, kind }) => ({
								attempt: observedAttempt,
								author,
								kind,
							})),
							`${name}:${attempt}:lineage`
						)
						.toEqual(writerAuthors.map((author) => ({ attempt, author, kind: "lineage-read" })));
				}
			}
			const currentMismatch = localAuthorProof?.results?.find(({ name }) => name === "current-outbox-issued-mismatch");
			expect.soft(currentMismatch).toMatchObject({
				effects: {
					aheRecoverCount: 1,
					installEpochAnchorCount: 0,
					snapshotOpenCount: 1,
				},
				issuedMismatchEvidence: {
					digestEqual: false,
					issuedSignatureValid: true,
					outboxSignatureValid: true,
					preimageEqual: false,
					scopeAndSequenceEqual: true,
				},
			});

			const skipBudgetResult = await runSkipBudgetChild();
			const skipBudgetProof = skipBudgetResult.proof as
				| Readonly<{ readonly reuse?: Readonly<Record<string, unknown>> }>
				| undefined;
			expect.soft(skipBudgetProof?.reuse).toMatchObject({
				allowance: 8_192,
				facadeObjectIsIdentical: true,
				materializedRows: 8_191,
				windows: [
					{
						capturedIssuedCount: 8_190,
						installEpochAnchorCount: 1,
						result: {
							detail: "creator successor recovery failed: issuance-rejected",
							kind: "recovery-rejected",
							ok: false,
						},
						successorPageFaultCount: 1,
						terminalEmpty: true,
					},
					{
						capturedIssuedCount: 8_190,
						installEpochAnchorCount: 1,
						result: {
							detail: "creator successor recovery failed: issuance-rejected",
							kind: "recovery-rejected",
							ok: false,
						},
						successorPageFaultCount: 1,
						terminalEmpty: true,
					},
				],
			});
		},
		150_000
	);

	it(D108E2D_CHILD_BEHAVIORS[0], async () => {
		const result = await runSharedChild();
		const proof = result.proof as
			| Readonly<{
					readonly results?: readonly Readonly<Record<string, unknown>>[];
			  }>
			| undefined;
		const established = proof?.results?.find(({ name }) => name === "established-bob");
		const windows = (
			established?.effects as
				| Readonly<{
						readonly predecessorWindows?: readonly Readonly<Record<string, unknown>>[];
				  }>
				| undefined
		)?.predecessorWindows;
		expect(windows).toHaveLength(2);
		expect.soft(windows?.[0]).toEqual({
			attempt: 0,
			complete: true,
			issuedReads: [{ authorSequence: 0, scopeIdentity: "copied" }],
			pages: [
				{ afterSequence: null, returnedSequences: [0] },
				{ afterSequence: 0, returnedSequences: [] },
			],
		});
		expect.soft(windows?.[1]).toEqual({
			attempt: 1,
			complete: true,
			issuedReads: [
				{ authorSequence: 0, scopeIdentity: "copied" },
				{ authorSequence: 1, scopeIdentity: "captured" },
			],
			pages: [
				{ afterSequence: null, returnedSequences: [0] },
				{ afterSequence: 0, returnedSequences: [1] },
				{ afterSequence: 1, returnedSequences: [] },
			],
		});
	});

	it(
		D108E2E_CHILD_BEHAVIORS[0],
		async () => {
			const result = await runSkipBudgetChild();
			const proof = result.proof as
				| Readonly<{
						equality?: Readonly<Record<string, unknown>>;
						maxCanonicalPreimageBytes?: number;
						maxEpochVertices?: number;
						mismatch?: Readonly<Record<string, unknown>>;
						overBudget?: Readonly<Record<string, unknown>>;
						pid?: number;
						realStore?: Readonly<Record<string, unknown>>;
				  }>
				| undefined;
			expect(proof?.pid).toEqual(expect.any(Number));
			expect(proof?.pid).not.toBe(process.pid);
			expect(proof?.maxEpochVertices).toBe(8_192);
			expect(proof?.maxCanonicalPreimageBytes).toBeLessThan(1_024);
			expect(proof?.realStore).toEqual({
				boundedStoreShape: true,
				equalityMaterializedRows: 8_193,
				maximumPageLimit: 128,
				overBudgetMaterializedRows: 8_195,
			});

			const equality = proof?.equality as
				| Readonly<{
						effects?: Readonly<Record<string, unknown>>;
						result?: Readonly<Record<string, unknown>>;
						telemetry?: Readonly<Record<string, unknown>>;
				  }>
				| undefined;
			expect(equality?.result).toEqual({
				detail: "creator successor recovery failed: issuance-rejected",
				kind: "recovery-rejected",
				ok: false,
			});
			expect(equality?.effects).toMatchObject({
				adoptionSwapCount: 0,
				aheRecoverCount: 1,
				installEpochAnchorCount: 1,
				publicationCount: 0,
				snapshotOpenCount: 1,
				subscribeCount: 0,
			});
			expect(equality?.telemetry).toEqual({
				capturedIssuedCount: 8_192,
				capturedIssuedFirst: 1,
				capturedIssuedLast: 8_192,
				capturedIssuedStrictlyIncreasing: true,
				capturedIssuedSum: 33_558_528,
				copiedIssuedSequences: [0],
				firstReturnedSequence: 0,
				lastReturnedSequence: 8_192,
				pageCount: 8_194,
				returnedSequenceCount: 8_193,
				returnedSequencesStrictlyIncreasing: true,
				successorPageFaultCount: 1,
				terminalEmpty: true,
			});

			const mismatch = proof?.mismatch as
				| Readonly<{
						effects?: Readonly<Record<string, unknown>>;
						result?: Readonly<Record<string, unknown>>;
						telemetry?: Readonly<Record<string, unknown>>;
				  }>
				| undefined;
			expect(mismatch?.result).toEqual({
				detail: "creator predecessor recovery failed: admission-rejected",
				kind: "recovery-rejected",
				ok: false,
			});
			expect(mismatch?.effects).toMatchObject({
				adoptionSwapCount: 0,
				aheRecoverCount: 1,
				installEpochAnchorCount: 0,
				publicationCount: 0,
				snapshotOpenCount: 1,
				subscribeCount: 0,
			});
			expect(mismatch?.telemetry).toEqual({
				capturedIssuedCount: 1,
				capturedIssuedFirst: 1,
				capturedIssuedLast: 1,
				capturedIssuedStrictlyIncreasing: true,
				capturedIssuedSum: 1,
				copiedIssuedSequences: [0, 1],
				firstReturnedSequence: 0,
				lastReturnedSequence: 1,
				pageCount: 2,
				returnedSequenceCount: 2,
				returnedSequencesStrictlyIncreasing: true,
				successorPageFaultCount: 0,
				terminalEmpty: false,
			});

			const overBudget = proof?.overBudget as
				| Readonly<{
						effects?: Readonly<Record<string, unknown>>;
						result?: Readonly<Record<string, unknown>>;
						separatorJournalAppended?: boolean;
						telemetry?: Readonly<Record<string, unknown>>;
				  }>
				| undefined;
			expect(overBudget?.separatorJournalAppended).toBe(true);
			expect(overBudget?.effects).toMatchObject({
				adoptionSwapCount: 0,
				aheRecoverCount: 1,
				publicationCount: 0,
				snapshotOpenCount: 1,
			});
			expect(overBudget?.telemetry).toMatchObject({
				capturedIssuedCount: 8_193,
				capturedIssuedFirst: 1,
				capturedIssuedLast: 8_194,
				capturedIssuedStrictlyIncreasing: true,
				capturedIssuedSum: 33_566_722,
				firstReturnedSequence: 0,
				lastReturnedSequence: 8_194,
				returnedSequenceCount: 8_195,
				returnedSequencesStrictlyIncreasing: true,
			});
			expect(overBudget?.result).toEqual({
				detail: "creator predecessor recovery failed: admission-rejected",
				kind: "recovery-rejected",
				ok: false,
			});
			expect(overBudget?.effects).toMatchObject({
				adoptionSwapCount: 0,
				aheRecoverCount: 1,
				installEpochAnchorCount: 0,
				publicationCount: 0,
				snapshotOpenCount: 1,
				subscribeCount: 0,
			});
			expect(overBudget?.telemetry).toEqual({
				capturedIssuedCount: 8_193,
				capturedIssuedFirst: 1,
				capturedIssuedLast: 8_194,
				capturedIssuedStrictlyIncreasing: true,
				capturedIssuedSum: 33_566_722,
				copiedIssuedSequences: [0, 8_193, 8_194],
				firstReturnedSequence: 0,
				lastReturnedSequence: 8_194,
				pageCount: 8_195,
				returnedSequenceCount: 8_195,
				returnedSequencesStrictlyIncreasing: true,
				successorPageFaultCount: 0,
				terminalEmpty: false,
			});
		},
		150_000
	);
});
