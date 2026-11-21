// Measurement only (tests/fixtures/realtime-probe/cpu-throttle.ts, mode "process"). Duty-cycles the
// browser's renderer processes with SIGSTOP/SIGCONT so every thread in them (the page's main thread,
// its dedicated workers, the compositor) gets 1/rate of each quantum: a slower CPU for the whole
// renderer, which DevTools' Emulation.setCPUThrottlingRate cannot give a worker (it throttles one
// thread per process and refuses worker targets).
//
// usage: node process-throttle-helper.mjs <rate> <quantumMs>
// stdin lines: "pid <n>" adds a process to throttle. stdin closing, SIGTERM, SIGINT or the parent's
// death resumes every process and exits. The duty cycle runs on a worker thread whose sleeps are
// Atomics.wait (sub-millisecond, independent of this thread's event loop).
import { createInterface } from "node:readline";
import { isMainThread, MessageChannel, receiveMessageOnPort, Worker, workerData } from "node:worker_threads";

if (isMainThread) {
	const rate = Number(process.argv[2]);
	const quantumMs = Number(process.argv[3] ?? 4);
	if (!(Number.isFinite(rate) && rate > 1) || !(Number.isFinite(quantumMs) && quantumMs >= 1))
		throw new Error("process-throttle-helper: <rate> > 1 and <quantumMs> >= 1");
	const { port1, port2 } = new MessageChannel();
	const stop = new Int32Array(new SharedArrayBuffer(4));
	const pids = new Set();
	const worker = new Worker(new URL(import.meta.url), {
		workerData: { rate, quantumMs, port: port2, stop },
		transferList: [port2],
	});
	const resumeAll = () => {
		for (const pid of pids)
			try {
				process.kill(pid, "SIGCONT");
			} catch {
				// gone
			}
	};
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		Atomics.store(stop, 0, 1);
		Atomics.notify(stop, 0);
		worker.once("exit", () => {
			resumeAll();
			process.exit(0);
		});
		// The worker resumes every process before it exits; this is the fallback.
		setTimeout(() => {
			resumeAll();
			process.exit(0);
		}, 1_000).unref();
	};
	createInterface({ input: process.stdin }).on("line", (line) => {
		const [kind, value] = line.trim().split(/\s+/u);
		const pid = Number(value);
		if (kind === "pid" && Number.isSafeInteger(pid) && pid > 0 && !pids.has(pid)) {
			pids.add(pid);
			port1.postMessage(pid);
		}
	});
	process.stdin.on("end", end);
	process.on("SIGTERM", end);
	process.on("SIGINT", end);
	const parent = process.ppid;
	setInterval(() => {
		if (process.ppid !== parent) end();
	}, 250).unref();
	worker.on("error", (error) => {
		console.error("process-throttle-helper worker failed", error);
		end();
	});
} else {
	const { rate, quantumMs, port, stop } = workerData;
	const pids = new Set();
	const sleep = (ms) => Atomics.wait(stop, 0, 0, ms);
	const signal = (name) => {
		for (const pid of pids)
			try {
				process.kill(pid, name);
			} catch {
				pids.delete(pid);
			}
	};
	const runMs = quantumMs / rate;
	const stopMs = quantumMs - runMs;
	try {
		while (Atomics.load(stop, 0) === 0) {
			for (let message = receiveMessageOnPort(port); message !== undefined; message = receiveMessageOnPort(port))
				pids.add(message.message);
			signal("SIGCONT");
			if (sleep(runMs) !== "timed-out") break;
			signal("SIGSTOP");
			if (sleep(stopMs) !== "timed-out") break;
		}
	} finally {
		signal("SIGCONT");
	}
}
