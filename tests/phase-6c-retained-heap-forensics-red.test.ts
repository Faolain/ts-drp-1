import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { D110A_FULL_TIMEOUT_MS, requireD110axFailureForensics } from "./fixtures/phase-6c/retained-heap-contract.js";
import {
	captureD110aForensicChild,
	createD110aForensicConfiguration,
	createD110aForensicRecorder,
	createD110aFullForensicConfiguration,
	readD110aForensicJournal,
	requireSuccessfulD110aForensicCapture,
	validateD110aForensicJournal,
} from "./fixtures/phase-6c/retained-heap-forensics.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SYNTHETIC_CHILD = resolve(import.meta.dirname, "fixtures/phase-6c/retained-heap-forensics-child.mjs");
const FULL_CHILD = resolve(import.meta.dirname, "fixtures/phase-6c/retained-heap-child.mjs");
const temporaryRoots: string[] = [];

type JournalRecord = Readonly<{
	objectIndex?: number | null;
	parentMonotonicNanoseconds: string;
	phase?: string;
	recordKind?: string;
	sequence: number;
	workerMonotonicMicroseconds: number;
}>;

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "d110ax-forensics-"));
	temporaryRoots.push(root);
	return root;
}

function identity(mode: string): Readonly<Record<string, unknown>> {
	return Object.freeze({
		command: Object.freeze({ arguments: Object.freeze([SYNTHETIC_CHILD, mode]), execPath: process.execPath }),
		kind: "d110ax-synthetic-identity-v1",
		sourceCommit: "synthetic",
	});
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Inferred from the plain-JavaScript recorder fixture.
async function capture(mode: string, deadlineMs = 2_000) {
	const root = temporaryRoot();
	const configuration = createD110aForensicConfiguration({
		childPath: SYNTHETIC_CHILD,
		deadlineMs,
		evidenceRoot: join(root, "evidence"),
	});
	const recorder = createD110aForensicRecorder({ configuration, identity: identity(mode) });
	const child = spawn(process.execPath, [configuration.childPath, mode], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	return Object.freeze({
		capture: await captureD110aForensicChild({ child, recorder }),
		configuration,
		recorder,
	});
}

function failureCode(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new TypeError("D110AX_EXPECTED_FAILURE_MISSING");
}

function journal(evidenceRoot: string): readonly JournalRecord[] {
	const records: unknown = readD110aForensicJournal(evidenceRoot);
	if (!Array.isArray(records)) throw new TypeError("D110AX_TEST_JOURNAL_MISSING");
	return records as readonly JournalRecord[];
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("D.110a-x retained-heap failure forensics", () => {
	it("uses the actual full launcher's frozen root, worker path, and seven-hour deadline", () => {
		const configuration = createD110aFullForensicConfiguration({
			childPath: FULL_CHILD,
			deadlineMs: D110A_FULL_TIMEOUT_MS,
			repositoryRoot: REPOSITORY_ROOT,
		});
		expect(configuration).toEqual({
			childPath: FULL_CHILD,
			deadlineMs: 25_200_000,
			evidenceRoot: resolve(REPOSITORY_ROOT, ".logs/phase-6c-d110a-full"),
		});
		requireD110axFailureForensics();
	});

	it("durably completes a normal miniature child and exactly reconciles its journal", async () => {
		const run = await capture("normal");
		const terminal = requireSuccessfulD110aForensicCapture(run.capture);
		const records = journal(run.configuration.evidenceRoot);
		const validation = validateD110aForensicJournal({
			expectedObjectEpochs: 2,
			proof: terminal.result,
			records,
		});
		expect(validation).toEqual({ baselineRecords: 1, completedSampleRecords: 2, recordCount: 13 });
		expect(readFileSync(`${run.configuration.evidenceRoot}/child.stdout`, "utf8")).toBe("synthetic stdout complete\n");
		expect(readFileSync(`${run.configuration.evidenceRoot}/child.stderr`, "utf8")).toBe("synthetic stderr complete\n");
		expect(JSON.parse(readFileSync(`${run.configuration.evidenceRoot}/terminal.json`, "utf8"))).toEqual(terminal);
		const status = run.recorder.finish({
			capture: run.capture,
			parentResult: Object.freeze({ kind: "synthetic-parent-success", proof: terminal.result }),
			parentStatus: "success",
		});
		expect(status).toMatchObject({
			exitCode: 0,
			exitSignal: null,
			parentStatus: "success",
			terminalResultReceived: true,
			watchdogFired: false,
		});
		expect(existsSync(`${run.configuration.evidenceRoot}/parent.json`)).toBe(true);
	});

	it("retains completed progress and partial lifecycle evidence after controlled failure", async () => {
		const run = await capture("controlled-failure");
		expect(failureCode(() => requireSuccessfulD110aForensicCapture(run.capture))).toBe("D110AX_FORENSIC_CHILD_ERROR");
		const records = journal(run.configuration.evidenceRoot);
		expect(records.filter(({ recordKind }) => recordKind === "completed-sample")).toHaveLength(1);
		expect(records.at(-1)).toMatchObject({ objectIndex: 1, phase: "fixture-open" });
		expect(readFileSync(`${run.configuration.evidenceRoot}/child.stdout`, "utf8")).toContain(
			"stdout before controlled failure"
		);
		expect(readFileSync(`${run.configuration.evidenceRoot}/child.stderr`, "utf8")).toContain(
			"stderr before controlled failure"
		);
		const status = run.recorder.finish({
			capture: run.capture,
			failureClassification: "D110AX_FORENSIC_CHILD_ERROR",
			failureMessage: "controlled",
			parentStatus: "failure",
		});
		expect(status).toMatchObject({ parentStatus: "failure", terminalResultReceived: false });
		expect(existsSync(`${run.configuration.evidenceRoot}/parent.json`)).toBe(false);
	});

	it("records an explicit watchdog firing and preserves pre-kill output", async () => {
		const run = await capture("watchdog", 1_000);
		expect(failureCode(() => requireSuccessfulD110aForensicCapture(run.capture))).toBe(
			"D110AX_FORENSIC_WATCHDOG_FIRED"
		);
		expect(run.capture).toMatchObject({ exitSignal: "SIGKILL", watchdogFired: true });
		expect(readFileSync(`${run.configuration.evidenceRoot}/child.stdout`, "utf8")).toBe("stdout before watchdog");
		expect(readFileSync(`${run.configuration.evidenceRoot}/child.stderr`, "utf8")).toBe("stderr before watchdog");
		const status = run.recorder.finish({
			capture: run.capture,
			failureClassification: "D110AX_FORENSIC_WATCHDOG_FIRED",
			failureMessage: "watchdog",
			parentStatus: "failure",
		});
		expect(status).toMatchObject({ exitSignal: "SIGKILL", watchdogFired: true });
	});

	it("fails closed for an explicit child error with a durable terminal record", async () => {
		const run = await capture("child-error");
		expect(failureCode(() => requireSuccessfulD110aForensicCapture(run.capture))).toBe("D110AX_FORENSIC_CHILD_ERROR");
		expect(JSON.parse(readFileSync(`${run.configuration.evidenceRoot}/terminal.json`, "utf8"))).toEqual({
			kind: "child-error",
			message: "D110AX_SYNTHETIC_CHILD_ERROR",
		});
		run.recorder.finish({
			capture: run.capture,
			failureClassification: "D110AX_FORENSIC_CHILD_ERROR",
			failureMessage: "child-error",
			parentStatus: "failure",
		});
	});

	it("flushes partial stdout and stderr without requiring newline termination", async () => {
		const run = await capture("partial-io");
		expect(readFileSync(`${run.configuration.evidenceRoot}/child.stdout`, "utf8")).toBe(
			"partial-stdout-without-newline"
		);
		expect(readFileSync(`${run.configuration.evidenceRoot}/child.stderr`, "utf8")).toBe(
			"partial-stderr-without-newline"
		);
		expect(failureCode(() => requireSuccessfulD110aForensicCapture(run.capture))).toBe("D110AX_FORENSIC_CHILD_ERROR");
		run.recorder.finish({
			capture: run.capture,
			failureClassification: "D110AX_FORENSIC_CHILD_ERROR",
			failureMessage: "partial-io",
			parentStatus: "failure",
		});
	});

	it("drains a large final stderr burst before classifying child failure", async () => {
		const run = await capture("large-stderr");
		expect(readFileSync(`${run.configuration.evidenceRoot}/child.stderr`)).toHaveLength(512 * 1024);
		expect(failureCode(() => requireSuccessfulD110aForensicCapture(run.capture))).toBe("D110AX_FORENSIC_CHILD_ERROR");
		run.recorder.finish({
			capture: run.capture,
			failureClassification: "D110AX_FORENSIC_CHILD_ERROR",
			failureMessage: "large-stderr",
			parentStatus: "failure",
		});
	});

	it("rejects missing, duplicate, malformed, and out-of-order journal records", async () => {
		const run = await capture("normal");
		const terminal = requireSuccessfulD110aForensicCapture(run.capture);
		const records = [...journal(run.configuration.evidenceRoot)];
		// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Inferred from the plain-JavaScript validator fixture.
		const validate = (candidate: readonly Readonly<Record<string, unknown>>[]) =>
			validateD110aForensicJournal({ expectedObjectEpochs: 2, proof: terminal.result, records: candidate });

		expect(failureCode(() => validate(records.slice(0, -1)))).toBe("D110AX_FORENSIC_SAMPLE_COUNT_INVALID");
		const duplicateRecord = {
			...records[5],
			parentMonotonicNanoseconds: (BigInt(records[5].parentMonotonicNanoseconds) + BigInt(1)).toString(),
			workerMonotonicMicroseconds: records[5].workerMonotonicMicroseconds + 1,
		};
		const duplicate = records.toSpliced(6, 0, duplicateRecord).map((record, sequence) => ({
			...record,
			sequence,
		}));
		expect(failureCode(() => validate(duplicate))).toBe("D110AX_FORENSIC_PHASE_ORDER_INVALID");
		const malformed = records.with(3, { ...records[3], recordKind: "unknown" });
		expect(failureCode(() => validate(malformed))).toBe("D110AX_FORENSIC_JOURNAL_MALFORMED");
		const outOfOrder = records.with(4, { ...records[4], sequence: 99 });
		expect(failureCode(() => validate(outOfOrder))).toBe("D110AX_FORENSIC_JOURNAL_ORDER_INVALID");
		run.recorder.finish({
			capture: run.capture,
			parentResult: Object.freeze({ kind: "synthetic-validation-complete" }),
			parentStatus: "success",
		});
	});

	it("rejects terminal-proof and completed-sample memory disagreement", async () => {
		const run = await capture("normal");
		const terminal = requireSuccessfulD110aForensicCapture(run.capture);
		const proof = structuredClone(terminal.result);
		proof.samples[1].memory.heapUsed += 1;
		proof.samples[1].memory.ownedBytes += 1;
		expect(
			failureCode(() =>
				validateD110aForensicJournal({
					expectedObjectEpochs: 2,
					proof,
					records: journal(run.configuration.evidenceRoot),
				})
			)
		).toBe("D110AX_FORENSIC_SAMPLE_MISMATCH");
		run.recorder.finish({
			capture: run.capture,
			failureClassification: "D110AX_FORENSIC_SAMPLE_MISMATCH",
			failureMessage: "terminal-proof-journal-mismatch",
			parentStatus: "failure",
		});
	});
});
