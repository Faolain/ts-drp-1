/* eslint-disable @typescript-eslint/explicit-function-return-type -- Tests-only parent recorder is plain JavaScript. */
/* eslint-disable jsdoc/require-jsdoc -- Export intent is covered by the bounded forensic specification. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";

export const D110A_FULL_EVIDENCE_RELATIVE_ROOT = ".logs/phase-6c-d110a-full";

const FORENSIC_PHASES = Object.freeze([
	"fixture-open",
	"workload-complete",
	"creator-close-complete",
	"reclamation-complete",
	"successor-published",
]);

function fail(code) {
	throw new TypeError(code);
}

function plainRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}

function finiteNonnegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function writeExclusiveJson(path, value) {
	const descriptor = openSync(path, "wx");
	try {
		writeSync(descriptor, `${JSON.stringify(value)}\n`, null, "utf8");
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function writeFlushed(descriptor, value) {
	writeSync(descriptor, value, null, "utf8");
	fsyncSync(descriptor);
}

function monotonicNanoseconds() {
	return process.hrtime.bigint().toString();
}

function memoryReading(value) {
	return (
		plainRecord(value) &&
		finiteNonnegative(value.arrayBuffers) &&
		finiteNonnegative(value.external) &&
		finiteNonnegative(value.heapUsed) &&
		finiteNonnegative(value.ownedBytes) &&
		finiteNonnegative(value.rss) &&
		value.ownedBytes === value.heapUsed + value.arrayBuffers
	);
}

function sameMemory(left, right) {
	return (
		memoryReading(left) &&
		memoryReading(right) &&
		left.arrayBuffers === right.arrayBuffers &&
		left.external === right.external &&
		left.heapUsed === right.heapUsed &&
		left.ownedBytes === right.ownedBytes &&
		left.rss === right.rss
	);
}

export function createD110aFullForensicConfiguration(input) {
	if (
		!plainRecord(input) ||
		typeof input.repositoryRoot !== "string" ||
		input.repositoryRoot.length === 0 ||
		typeof input.childPath !== "string" ||
		input.childPath.length === 0 ||
		!positiveInteger(input.deadlineMs)
	) {
		fail("D110AX_FORENSIC_CONFIGURATION_INVALID");
	}
	return Object.freeze({
		childPath: resolve(input.childPath),
		deadlineMs: input.deadlineMs,
		evidenceRoot: resolve(input.repositoryRoot, D110A_FULL_EVIDENCE_RELATIVE_ROOT),
	});
}

export function createD110aForensicConfiguration(input) {
	if (
		!plainRecord(input) ||
		typeof input.evidenceRoot !== "string" ||
		input.evidenceRoot.length === 0 ||
		typeof input.childPath !== "string" ||
		input.childPath.length === 0 ||
		!positiveInteger(input.deadlineMs)
	) {
		fail("D110AX_FORENSIC_CONFIGURATION_INVALID");
	}
	return Object.freeze({
		childPath: resolve(input.childPath),
		deadlineMs: input.deadlineMs,
		evidenceRoot: resolve(input.evidenceRoot),
	});
}

export function createD110aForensicRecorder(input) {
	if (!plainRecord(input) || !plainRecord(input.configuration) || !plainRecord(input.identity)) {
		fail("D110AX_FORENSIC_RECORDER_INPUT_INVALID");
	}
	const { configuration, identity } = input;
	mkdirSync(configuration.evidenceRoot);
	writeExclusiveJson(`${configuration.evidenceRoot}/invocation-consumed.json`, {
		command: identity.command,
		kind: "d110ax-full-invocation-consumed-v1",
		sourceCommit: identity.sourceCommit,
	});
	writeExclusiveJson(`${configuration.evidenceRoot}/source-runtime-identity.json`, identity);

	const stdoutFd = openSync(`${configuration.evidenceRoot}/child.stdout`, "wx");
	const stderrFd = openSync(`${configuration.evidenceRoot}/child.stderr`, "wx");
	const progressFd = openSync(`${configuration.evidenceRoot}/progress.jsonl`, "wx");
	const launcherFd = openSync(`${configuration.evidenceRoot}/launcher-events.jsonl`, "wx");
	const startedAt = new Date().toISOString();
	const deadlineAt = new Date(Date.parse(startedAt) + configuration.deadlineMs).toISOString();
	const startedMonotonicNanoseconds = monotonicNanoseconds();
	const progressRecords = [];
	let progressSequence = 0;
	let launcherSequence = 0;
	let terminal;
	let finished = false;

	const launcherEvent = (event, details = {}) => {
		const record = Object.freeze({
			...details,
			event,
			parentMonotonicNanoseconds: monotonicNanoseconds(),
			sequence: launcherSequence++,
			wallTime: new Date().toISOString(),
		});
		writeFlushed(launcherFd, `${JSON.stringify(record)}\n`);
		return record;
	};
	launcherEvent("evidence-created", { deadlineAt, deadlineMs: configuration.deadlineMs });
	launcherEvent("identity-persisted");

	return Object.freeze({
		appendStderr(value) {
			writeFlushed(stderrFd, String(value));
		},
		appendStdout(value) {
			writeFlushed(stdoutFd, String(value));
		},
		configuration,
		finish(inputFinish) {
			if (finished || !plainRecord(inputFinish) || !plainRecord(inputFinish.capture)) {
				fail("D110AX_FORENSIC_FINISH_INVALID");
			}
			finished = true;
			const finishedAt = new Date().toISOString();
			const finishedMonotonicNanoseconds = monotonicNanoseconds();
			const elapsedMilliseconds = Number(
				(BigInt(finishedMonotonicNanoseconds) - BigInt(startedMonotonicNanoseconds)) / 1_000_000n
			);
			launcherEvent("parent-finish", { parentStatus: inputFinish.parentStatus });
			for (const descriptor of [stdoutFd, stderrFd, progressFd, launcherFd]) {
				fsyncSync(descriptor);
				closeSync(descriptor);
			}
			if (inputFinish.parentResult !== undefined) {
				writeExclusiveJson(`${configuration.evidenceRoot}/parent.json`, inputFinish.parentResult);
			}
			const status = Object.freeze({
				childPid: inputFinish.capture.childPid ?? null,
				deadlineAt,
				deadlineMs: configuration.deadlineMs,
				elapsedMilliseconds,
				exitCode: inputFinish.capture.exitCode ?? null,
				exitSignal: inputFinish.capture.exitSignal ?? null,
				failureClassification: inputFinish.failureClassification ?? null,
				failureMessage: inputFinish.failureMessage ?? null,
				finishedAt,
				finishedMonotonicNanoseconds,
				kind: "d110ax-full-execution-status-v1",
				parentStatus: inputFinish.parentStatus,
				startedAt,
				startedMonotonicNanoseconds,
				terminalResultReceived: inputFinish.capture.terminalResultReceived === true,
				watchdogFired: inputFinish.capture.watchdogFired === true,
			});
			writeExclusiveJson(`${configuration.evidenceRoot}/execution-status.json`, status);
			return status;
		},
		launcherEvent,
		progressRecords() {
			return Object.freeze([...progressRecords]);
		},
		recordProgress(message) {
			if (!plainRecord(message) || message.kind !== "progress") {
				fail("D110AX_FORENSIC_PROGRESS_MALFORMED");
			}
			const { kind: _kind, ...progress } = message;
			const record = Object.freeze({
				...progress,
				parentMonotonicNanoseconds: monotonicNanoseconds(),
				sequence: progressSequence++,
			});
			writeFlushed(progressFd, `${JSON.stringify(record)}\n`);
			progressRecords.push(record);
			return record;
		},
		recordTerminal(message) {
			if (terminal !== undefined) fail("D110AX_FORENSIC_TERMINAL_DUPLICATE");
			terminal = message;
			writeExclusiveJson(`${configuration.evidenceRoot}/terminal.json`, message);
			launcherEvent("terminal-received", {
				terminalKind: plainRecord(message) ? (message.kind ?? null) : null,
			});
		},
		startedAt,
		startedMonotonicNanoseconds,
	});
}

export async function captureD110aForensicChild(input) {
	if (!plainRecord(input) || !plainRecord(input.child) || !plainRecord(input.recorder)) {
		fail("D110AX_FORENSIC_CAPTURE_INPUT_INVALID");
	}
	const { child, recorder } = input;
	const childPid = child.pid ?? null;
	let childError;
	let exitCode = null;
	let exitSignal = null;
	let recordingError;
	let terminal;
	let watchdogFired = false;
	let stdout = "";
	let stderr = "";

	const stdoutEnded = new Promise((resolvePromise) => {
		if (child.stdout === null || child.stdout === undefined) return resolvePromise();
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (value) => {
			stdout += value;
			try {
				recorder.appendStdout(value);
			} catch (error) {
				recordingError = error;
				child.kill("SIGKILL");
			}
		});
		child.stdout.once("end", resolvePromise);
	});
	const stderrEnded = new Promise((resolvePromise) => {
		if (child.stderr === null || child.stderr === undefined) return resolvePromise();
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (value) => {
			stderr += value;
			try {
				recorder.appendStderr(value);
			} catch (error) {
				recordingError = error;
				child.kill("SIGKILL");
			}
		});
		child.stderr.once("end", resolvePromise);
	});
	const ipcDisconnected = new Promise((resolvePromise) => {
		if (child.connected !== true) return resolvePromise();
		child.once("disconnect", resolvePromise);
	});

	child.on("message", (message) => {
		try {
			if (message?.kind === "progress") recorder.recordProgress(message);
			else {
				recorder.recordTerminal(message);
				terminal = message;
			}
		} catch (error) {
			recordingError = error;
			child.kill("SIGKILL");
		}
	});
	child.once("error", (error) => {
		childError = error;
		try {
			recorder.launcherEvent("child-error", { message: error instanceof Error ? error.message : String(error) });
		} catch (recordError) {
			recordingError = recordError;
		}
	});
	child.once("exit", (code, signal) => {
		exitCode = code;
		exitSignal = signal;
		try {
			recorder.launcherEvent("child-exit", { exitCode: code, exitSignal: signal });
		} catch (error) {
			recordingError = error;
		}
	});
	recorder.launcherEvent("child-spawned", { childPid });
	const timer = setTimeout(() => {
		watchdogFired = true;
		try {
			recorder.launcherEvent("watchdog-fired", {
				childPid,
				deadlineMs: recorder.configuration.deadlineMs,
			});
		} catch (error) {
			recordingError = error;
		}
		child.kill("SIGKILL");
	}, recorder.configuration.deadlineMs);

	await new Promise((resolvePromise) => child.once("close", resolvePromise));
	clearTimeout(timer);
	await Promise.all([stdoutEnded, stderrEnded, ipcDisconnected]);
	recorder.launcherEvent("child-close", { exitCode, exitSignal });

	return Object.freeze({
		childError,
		childPid,
		exitCode,
		exitSignal,
		recordingError,
		stderr,
		stdout,
		terminal,
		terminalResultReceived: terminal?.kind === "result" && terminal?.result !== undefined,
		watchdogFired,
	});
}

export function requireSuccessfulD110aForensicCapture(capture) {
	if (!plainRecord(capture)) fail("D110AX_FORENSIC_CAPTURE_INVALID");
	if (capture.recordingError !== undefined) fail("D110AX_FORENSIC_RECORDING_FAILED");
	if (capture.watchdogFired === true) fail("D110AX_FORENSIC_WATCHDOG_FIRED");
	if (capture.childError !== undefined) fail("D110AX_FORENSIC_CHILD_PROCESS_ERROR");
	if (capture.terminal?.kind === "child-error") fail("D110AX_FORENSIC_CHILD_ERROR");
	if (capture.exitCode !== 0 || capture.exitSignal !== null) fail("D110A_CHILD_FAILED");
	if (capture.terminal?.kind !== "result" || capture.terminal.result === undefined) {
		fail("D110AX_FORENSIC_TERMINAL_MISSING");
	}
	return capture.terminal;
}

export function readD110aForensicJournal(evidenceRoot) {
	const source = readFileSync(`${evidenceRoot}/progress.jsonl`, "utf8");
	if (source.length === 0) return Object.freeze([]);
	try {
		return Object.freeze(
			source
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line))
		);
	} catch {
		fail("D110AX_FORENSIC_JOURNAL_MALFORMED");
	}
}

export function validateD110aForensicJournal(input) {
	if (
		!plainRecord(input) ||
		!Array.isArray(input.records) ||
		!plainRecord(input.proof) ||
		!positiveInteger(input.expectedObjectEpochs)
	) {
		fail("D110AX_FORENSIC_VALIDATION_INPUT_INVALID");
	}
	const { expectedObjectEpochs, proof, records } = input;
	if (
		records.some(
			(record, index) =>
				!plainRecord(record) ||
				record.sequence !== index ||
				typeof record.parentMonotonicNanoseconds !== "string" ||
				!/^(?:0|[1-9]\d*)$/u.test(record.parentMonotonicNanoseconds) ||
				(index > 0 &&
					BigInt(record.parentMonotonicNanoseconds) <= BigInt(records[index - 1].parentMonotonicNanoseconds))
		)
	) {
		fail("D110AX_FORENSIC_JOURNAL_ORDER_INVALID");
	}
	if (
		records.length === 0 ||
		records[0].recordKind !== "baseline" ||
		records[0].objectIndex !== null ||
		records[0].completedObjectEpochs !== 0 ||
		records[0].appliedWorkloadOperations !== 0 ||
		records[0].activeSuccessors !== 0 ||
		!positiveInteger(records[0].workerMonotonicMicroseconds) ||
		!sameMemory(records[0].memory, proof.baseline)
	) {
		fail("D110AX_FORENSIC_BASELINE_MISMATCH");
	}
	if (
		records.some(
			(record, index) =>
				!positiveInteger(record.workerMonotonicMicroseconds) ||
				(index > 0 && record.workerMonotonicMicroseconds <= records[index - 1].workerMonotonicMicroseconds) ||
				(record.recordKind !== "baseline" &&
					record.recordKind !== "lifecycle-phase" &&
					record.recordKind !== "completed-sample")
		)
	) {
		fail("D110AX_FORENSIC_JOURNAL_MALFORMED");
	}
	const samples = records.filter(({ recordKind }) => recordKind === "completed-sample");
	if (
		!Array.isArray(proof.samples) ||
		samples.length !== expectedObjectEpochs ||
		proof.samples.length !== expectedObjectEpochs
	) {
		fail("D110AX_FORENSIC_SAMPLE_COUNT_INVALID");
	}
	for (let index = 0; index < expectedObjectEpochs; index += 1) {
		const sampleRecord = samples[index];
		const sample = proof.samples[index];
		if (
			sampleRecord.objectIndex !== index ||
			sampleRecord.completedObjectEpochs !== index + 1 ||
			sampleRecord.appliedWorkloadOperations !== (index + 1) * 15_625 ||
			sampleRecord.activeSuccessors !== Math.min(index + 1, 20) ||
			sample.index !== index ||
			sample.completedObjectEpochs !== sampleRecord.completedObjectEpochs ||
			sample.appliedWorkloadOperations !== sampleRecord.appliedWorkloadOperations ||
			sample.activeSuccessors !== sampleRecord.activeSuccessors ||
			!sameMemory(sampleRecord.memory, sample.memory)
		) {
			fail("D110AX_FORENSIC_SAMPLE_MISMATCH");
		}
		const objectRecords = records.filter(({ objectIndex }) => objectIndex === index);
		const phases = objectRecords.filter(({ recordKind }) => recordKind === "lifecycle-phase");
		if (
			phases.length !== FORENSIC_PHASES.length ||
			phases.some(
				(record, phaseIndex) =>
					record.phase !== FORENSIC_PHASES[phaseIndex] ||
					record.completedObjectEpochs !== index ||
					record.appliedWorkloadOperations !== (phaseIndex === 0 ? index * 15_625 : (index + 1) * 15_625) ||
					record.activeSuccessors !==
						(phaseIndex === FORENSIC_PHASES.length - 1 ? Math.min(index, 20) + 1 : Math.min(index, 20))
			) ||
			objectRecords.at(-1) !== sampleRecord ||
			sampleRecord.workerMonotonicMicroseconds <= phases.at(-1).workerMonotonicMicroseconds
		) {
			fail("D110AX_FORENSIC_PHASE_ORDER_INVALID");
		}
	}
	const expectedRecordCount = 1 + expectedObjectEpochs * (FORENSIC_PHASES.length + 1);
	if (records.length !== expectedRecordCount) fail("D110AX_FORENSIC_JOURNAL_MALFORMED");
	return Object.freeze({ baselineRecords: 1, completedSampleRecords: samples.length, recordCount: records.length });
}
