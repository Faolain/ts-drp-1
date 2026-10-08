/* eslint-disable @typescript-eslint/explicit-function-return-type -- Bounded synthetic subprocess fixture. */

const mode = process.argv[2] ?? "normal";
const phases = Object.freeze([
	"fixture-open",
	"workload-complete",
	"creator-close-complete",
	"reclamation-complete",
	"successor-published",
]);
let lastMonotonicMicroseconds = -1;

function monotonicMicroseconds() {
	const observed = Number(process.hrtime.bigint() / 1_000n);
	lastMonotonicMicroseconds = Math.max(observed, lastMonotonicMicroseconds + 1);
	return lastMonotonicMicroseconds;
}

function memory(index) {
	const arrayBuffers = 2_000 + index;
	const heapUsed = 10_000 + index * 100;
	return Object.freeze({
		arrayBuffers,
		external: arrayBuffers + 1_000,
		heapUsed,
		ownedBytes: heapUsed + arrayBuffers,
		rss: 50_000 + index * 100,
	});
}

async function send(message) {
	await new Promise((resolvePromise, reject) => {
		if (process.send === undefined) return reject(new TypeError("D110AX_SYNTHETIC_IPC_MISSING"));
		process.send(message, (error) => (error === undefined || error === null ? resolvePromise() : reject(error)));
	});
}

async function sendProgress(record) {
	await send(
		Object.freeze({
			...record,
			kind: "progress",
			workerMonotonicMicroseconds: monotonicMicroseconds(),
		})
	);
}

async function sendBaseline() {
	await sendProgress({
		activeSuccessors: 0,
		appliedWorkloadOperations: 0,
		completedObjectEpochs: 0,
		memory: memory(-1),
		objectIndex: null,
		recordKind: "baseline",
	});
}

async function sendObject(index) {
	for (const [phaseIndex, phase] of phases.entries()) {
		await sendProgress({
			activeSuccessors: phase === "successor-published" ? Math.min(index, 20) + 1 : Math.min(index, 20),
			appliedWorkloadOperations: phaseIndex === 0 ? index * 15_625 : (index + 1) * 15_625,
			completedObjectEpochs: index,
			objectIndex: index,
			phase,
			recordKind: "lifecycle-phase",
		});
	}
	await sendProgress({
		activeSuccessors: Math.min(index + 1, 20),
		appliedWorkloadOperations: (index + 1) * 15_625,
		completedObjectEpochs: index + 1,
		memory: memory(index),
		objectIndex: index,
		recordKind: "completed-sample",
	});
}

function proof(objectEpochs) {
	return Object.freeze({
		baseline: memory(-1),
		samples: Object.freeze(
			Array.from({ length: objectEpochs }, (_, index) =>
				Object.freeze({
					activeSuccessors: Math.min(index + 1, 20),
					appliedWorkloadOperations: (index + 1) * 15_625,
					completedObjectEpochs: index + 1,
					index,
					memory: memory(index),
				})
			)
		),
	});
}

async function write(stream, value) {
	await new Promise((resolvePromise, reject) => {
		stream.write(value, (error) => (error === undefined || error === null ? resolvePromise() : reject(error)));
	});
}

async function main() {
	if (mode === "normal") {
		await write(process.stdout, "synthetic stdout complete\n");
		await write(process.stderr, "synthetic stderr complete\n");
		await sendBaseline();
		await sendObject(0);
		await sendObject(1);
		await send(Object.freeze({ kind: "result", result: proof(2) }));
		return;
	}
	if (mode === "controlled-failure") {
		await sendBaseline();
		await sendObject(0);
		await sendProgress({
			activeSuccessors: 1,
			appliedWorkloadOperations: 15_625,
			completedObjectEpochs: 1,
			objectIndex: 1,
			phase: "fixture-open",
			recordKind: "lifecycle-phase",
		});
		await write(process.stdout, "stdout before controlled failure\n");
		await write(process.stderr, "stderr before controlled failure\n");
		await send(Object.freeze({ kind: "child-error", message: "D110AX_SYNTHETIC_CONTROLLED_FAILURE" }));
		process.exitCode = 1;
		return;
	}
	if (mode === "watchdog") {
		await sendBaseline();
		await write(process.stdout, "stdout before watchdog");
		await write(process.stderr, "stderr before watchdog");
		setInterval(() => undefined, 10_000);
		return;
	}
	if (mode === "child-error") {
		await send(Object.freeze({ kind: "child-error", message: "D110AX_SYNTHETIC_CHILD_ERROR" }));
		process.exitCode = 1;
		return;
	}
	if (mode === "partial-io") {
		await write(process.stdout, "partial-stdout-without-newline");
		await write(process.stderr, "partial-stderr-without-newline");
		await send(Object.freeze({ kind: "child-error", message: "D110AX_SYNTHETIC_PARTIAL_IO" }));
		process.exitCode = 1;
		return;
	}
	if (mode === "large-stderr") {
		await write(process.stderr, "x".repeat(512 * 1024));
		await send(Object.freeze({ kind: "child-error", message: "D110AX_SYNTHETIC_LARGE_STDERR" }));
		process.exitCode = 1;
		return;
	}
	throw new TypeError(`D110AX_SYNTHETIC_MODE_INVALID:${mode}`);
}

await main();
