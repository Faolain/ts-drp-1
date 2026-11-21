import type { Browser, BrowserContext, CDPSession, Page, Worker } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Measurement only: the FPS harness's slow-CPU emulation and its self-check.
//
// Modes (BROWSER_FPS_CPU_THROTTLE_MODE):
// - "process" (default): every renderer process of the browser is duty-cycled with SIGSTOP/SIGCONT
//   (process-throttle-helper.mjs), so each of its threads (the page's main thread, the room worker,
//   the compositor) runs 1/rate of each quantum. Chromium only (the renderer pids come from CDP
//   SystemInfo.getProcessInfo).
// - "cdp": DevTools Emulation.setCPUThrottlingRate on each page target, as the harness did before.
//   Chromium's throttler (blink ThreadCPUThrottler) is one per process and slows only the thread that
//   first set it, and InspectorEmulationAgent refuses the command on worker targets ("Operation is
//   only supported for pages, not workers"): a dedicated worker in this mode runs at full speed, and
//   the self-check below fails the run.
//
// Self-check: before throttling, a fixed integer loop is timed on an unthrottled page's main thread
// and in an unthrottled dedicated worker (the references). After the pages open, the same loop is
// timed on every page's main thread and in every dedicated worker the pages run. A target counts as
// throttled when its time is at least half the rate times its reference (and at least 1.5x): a target
// that is not slowed (ratio about 1) cannot pass. Every target must count as throttled.

export type ThrottleMode = "process" | "cdp";

export interface ThrottleTarget {
	readonly role: string;
	readonly kind: "page" | "worker";
	readonly url: string;
	/** The loop's fastest of three runs on this target (ms). */
	readonly loopMs: number;
	/** The same loop's reference on an unthrottled target of the same kind (ms). */
	readonly referenceMs: number;
	readonly ratio: number;
	readonly throttled: boolean;
	/** When it was measured: at open, or a worker that appeared later. */
	readonly at: "open" | "later";
}

export interface ThrottleReport {
	readonly rate: number;
	readonly mode: ThrottleMode;
	readonly quantumMs: number | null;
	readonly rule: string;
	readonly reference: Readonly<{ pageMs: number; workerMs: number }>;
	readonly targets: readonly ThrottleTarget[];
	readonly pages: number;
	readonly workers: number;
	readonly throttledPages: number;
	readonly throttledWorkers: number;
	/** Renderer pids the process mode throttled. */
	readonly rendererPids: readonly number[];
	readonly passed: boolean;
	readonly failures: readonly string[];
}

/**
 * The loop (runs in a page or a worker): fixed integer work, timed. Self-contained.
 * @param iterations
 */
function calibrationLoop(iterations: number): number {
	const started = performance.now();
	let value = 0;
	for (let index = 0; index < iterations; index++) value = (Math.imul(value, 31) + index) | 0;
	const spent = performance.now() - started;
	// Keeps the loop's result observable (it is never this value in practice).
	if (value === 0x7fffffff) return -1;
	return spent;
}

const LOOP_ITERATIONS = 20_000_000;
const LOOP_RUNS = 3;

async function fastest(run: () => Promise<number>): Promise<number> {
	let best = Number.POSITIVE_INFINITY;
	for (let index = 0; index < LOOP_RUNS; index++) best = Math.min(best, await run());
	return Math.round(best * 1000) / 1000;
}

/**
 * Runs the loop in a fresh blob worker of the page (the unthrottled worker reference).
 * @param page
 */
async function blobWorkerLoop(page: Page): Promise<number> {
	return page.evaluate(
		async ({ source, iterations, runs }) => {
			const url = URL.createObjectURL(
				new Blob([`const loop = ${source};\nonmessage = () => postMessage(loop(${iterations}));`], {
					type: "text/javascript",
				})
			);
			const worker = new Worker(url);
			try {
				let best = Number.POSITIVE_INFINITY;
				for (let index = 0; index < runs; index++)
					best = Math.min(
						best,
						await new Promise<number>((resolve, reject) => {
							worker.onmessage = (event: MessageEvent<number>): void => resolve(event.data);
							worker.onerror = (event): void => reject(new Error(event.message));
							worker.postMessage(null);
						})
					);
				return best;
			} finally {
				worker.terminate();
				URL.revokeObjectURL(url);
			}
		},
		{ source: calibrationLoop.toString(), iterations: LOOP_ITERATIONS, runs: LOOP_RUNS }
	);
}

const pageLoop = (page: Page): Promise<number> => fastest(() => page.evaluate(calibrationLoop, LOOP_ITERATIONS));
const workerLoop = (worker: Worker): Promise<number> =>
	fastest(() => worker.evaluate(calibrationLoop, LOOP_ITERATIONS));

export interface CpuThrottle {
	readonly rate: number;
	readonly mode: ThrottleMode;
	/** Measures every page and dedicated worker the pages run now, and watches for later workers. */
	measure(pages: ReadonlyMap<string, Page>): Promise<void>;
	/** The self-check report (call after measure). */
	report(): ThrottleReport;
	stop(): Promise<void>;
}

/**
 * Applies the slow-CPU emulation to a run's pages (before they navigate) and returns its self-check.
 * @param browser - The run's browser.
 * @param browserName - Its engine.
 * @param pages - The run's pages by role, still blank (the references are measured on the first).
 * @param contexts - Their contexts, by role.
 * @param rate - The slowdown (> 1).
 * @param mode - The mechanism.
 * @param quantumMs - The process mode's duty-cycle quantum.
 * @returns The throttle.
 */
export async function applyCpuThrottle(
	browser: Browser,
	browserName: string,
	pages: ReadonlyMap<string, Page>,
	contexts: ReadonlyMap<string, BrowserContext>,
	rate: number,
	mode: ThrottleMode,
	quantumMs: number
): Promise<CpuThrottle> {
	if (browserName !== "chromium")
		throw new Error(
			`BROWSER_FPS_CPU_THROTTLE=${rate} is not supported on ${browserName}: only chromium can be throttled, and an unthrottled run must not be reported as a throttled one`
		);
	const first = pages.values().next().value as Page;
	// References first, unthrottled.
	const reference = { pageMs: await pageLoop(first), workerMs: await blobWorkerLoop(first) };
	const targets: ThrottleTarget[] = [];
	const failures: string[] = [];
	const rendererPids = new Set<number>();
	let helper: ChildProcess | undefined;
	let browserSession: CDPSession | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	const minimumRatio = Math.max(1.5, rate / 2);
	const record = (role: string, kind: "page" | "worker", url: string, loopMs: number, at: "open" | "later"): void => {
		const referenceMs = kind === "page" ? reference.pageMs : reference.workerMs;
		const ratio = Math.round((loopMs / Math.max(1e-6, referenceMs)) * 100) / 100;
		targets.push({ role, kind, url, loopMs, referenceMs, ratio, throttled: ratio >= minimumRatio, at });
	};
	if (mode === "cdp") {
		for (const [role, page] of pages)
			await (
				await (contexts.get(role) as BrowserContext).newCDPSession(page)
			).send("Emulation.setCPUThrottlingRate", {
				rate,
			});
	} else {
		browserSession = await browser.newBrowserCDPSession();
		const session = browserSession;
		helper = spawn(
			process.execPath,
			[fileURLToPath(new URL("./process-throttle-helper.mjs", import.meta.url)), String(rate), String(quantumMs)],
			{ stdio: ["pipe", "inherit", "inherit"] }
		);
		const child = helper;
		const discover = async (): Promise<void> => {
			const { processInfo } = (await session.send("SystemInfo.getProcessInfo")) as {
				processInfo: readonly Readonly<{ type: string; id: number }>[];
			};
			for (const info of processInfo)
				if (info.type === "renderer" && !rendererPids.has(info.id)) {
					rendererPids.add(info.id);
					child.stdin?.write(`pid ${info.id}\n`);
				}
		};
		await discover();
		// Navigation can move a page to a new renderer process: keep adding them.
		poll = setInterval(() => void discover().catch(() => undefined), 250);
	}
	const measuredWorkers = new WeakSet<Worker>();
	const later: Promise<void>[] = [];
	const measureWorker = async (role: string, worker: Worker, at: "open" | "later"): Promise<void> => {
		if (measuredWorkers.has(worker)) return;
		measuredWorkers.add(worker);
		try {
			record(role, "worker", worker.url(), await workerLoop(worker), at);
		} catch (error) {
			// A worker that closed before it could be measured is not a target any more.
			if (!String(error).includes("closed") && !String(error).includes("destroyed"))
				failures.push(`worker ${role} ${worker.url()} could not be measured: ${String(error).slice(0, 300)}`);
		}
	};
	let measuredPages = 0;
	return {
		rate,
		mode,
		async measure(selected): Promise<void> {
			for (const [role, page] of selected) {
				record(role, "page", page.url(), await pageLoop(page), "open");
				measuredPages++;
				for (const worker of page.workers()) await measureWorker(role, worker, "open");
				page.on("worker", (worker) => later.push(measureWorker(role, worker, "later")));
			}
		},
		report(): ThrottleReport {
			const pagesMeasured = targets.filter((target) => target.kind === "page");
			const workers = targets.filter((target) => target.kind === "worker");
			const throttledPages = pagesMeasured.filter((target) => target.throttled).length;
			const throttledWorkers = workers.filter((target) => target.throttled).length;
			const all = [...failures];
			if (measuredPages === 0) all.push("no page was measured");
			for (const target of targets)
				if (!target.throttled)
					all.push(
						`${target.role} ${target.kind} ${target.url} is not throttled: its loop took ${target.ratio}x its unthrottled reference, below ${minimumRatio}x (rate ${rate}, mode ${mode})`
					);
			return {
				rate,
				mode,
				quantumMs: mode === "process" ? quantumMs : null,
				rule: `every page main thread and every dedicated worker the pages run is timed on a fixed loop (fastest of ${LOOP_RUNS}); it is throttled when that takes at least max(1.5, rate/2) = ${minimumRatio}x the same loop on an unthrottled page (main thread) or unthrottled dedicated worker measured before throttling`,
				reference,
				targets: [...targets],
				pages: pagesMeasured.length,
				workers: workers.length,
				throttledPages,
				throttledWorkers,
				rendererPids: [...rendererPids],
				passed: all.length === 0 && throttledWorkers === workers.length && throttledPages === pagesMeasured.length,
				failures: all,
			};
		},
		async stop(): Promise<void> {
			await Promise.allSettled(later);
			if (poll !== undefined) clearInterval(poll);
			if (helper !== undefined) {
				helper.stdin?.end();
				helper.kill("SIGTERM");
			}
			// Never leave a renderer stopped, whatever happened to the helper.
			for (const pid of rendererPids)
				try {
					process.kill(pid, "SIGCONT");
				} catch {
					// gone
				}
			await browserSession?.detach().catch(() => undefined);
		},
	};
}

// ---------------------------------------------------------------------------------------------
// The dedicated workers' own timeline (every engine): a 10 ms heartbeat in each worker whose
// lateness is the worker's event loop being blocked. Late by 50 ms or more is a worker long task (the
// longtask entry type does not exist in workers); the sum of lateness is the worker's lag.

export interface WorkerTimelineReading {
	readonly url: string;
	readonly intervalMs: number;
	readonly ticks: number;
	readonly lagMs: number;
	readonly over50: number;
	readonly over100: number;
	readonly longestMs: number;
	/** [startedAt (timeOrigin + now), duration] of each stall of 50 ms or more (bounded). */
	readonly stalls: readonly (readonly [number, number])[];
	readonly droppedStalls: number;
	readonly elapsedMs: number;
}

function workerTimelineInstall(): void {
	const key = "__TS_DRP_WORKER_TIMELINE__";
	if (Reflect.get(globalThis, key) !== undefined) return;
	const INTERVAL = 10;
	const LIMIT = 20_000;
	let running = false;
	let last = performance.now();
	let startedAt = 0;
	let ticks = 0;
	let lagMs = 0;
	let over50 = 0;
	let over100 = 0;
	let longestMs = 0;
	let dropped = 0;
	const stalls: [number, number][] = [];
	setInterval(() => {
		const now = performance.now();
		const late = now - last - INTERVAL;
		last = now;
		if (!running) return;
		ticks++;
		if (late <= 0) return;
		lagMs += late;
		if (late < 50) return;
		over50++;
		if (late >= 100) over100++;
		longestMs = Math.max(longestMs, late);
		if (stalls.length < LIMIT) stalls.push([performance.timeOrigin + now - late, late]);
		else dropped++;
	}, INTERVAL);
	Reflect.set(
		globalThis,
		key,
		Object.freeze({
			start(): void {
				running = true;
				last = performance.now();
				startedAt = last;
				ticks = 0;
				lagMs = 0;
				over50 = 0;
				over100 = 0;
				longestMs = 0;
				dropped = 0;
				stalls.length = 0;
			},
			read() {
				return {
					url: String(globalThis.location?.href ?? ""),
					intervalMs: INTERVAL,
					ticks,
					lagMs,
					over50,
					over100,
					longestMs,
					stalls: stalls.slice(),
					droppedStalls: dropped,
					elapsedMs: running ? performance.now() - startedAt : 0,
				};
			},
		})
	);
}

export interface WorkerTimelines {
	/** Starts every installed worker's timeline (with the page probe). */
	start(): Promise<void>;
	read(): Promise<readonly Readonly<{ role: string; reading: WorkerTimelineReading | null }>[]>;
}

/**
 * Installs the timeline in every dedicated worker the pages run now or later.
 * @param pages - The run's pages by role (after they opened).
 * @returns The timelines.
 */
export function installWorkerTimelines(pages: ReadonlyMap<string, Page>): WorkerTimelines {
	const workers: { role: string; worker: Worker; installed: Promise<boolean> }[] = [];
	let started = false;
	const add = (role: string, worker: Worker): void => {
		const installed = worker
			.evaluate(workerTimelineInstall)
			.then(async () => {
				if (started)
					await worker.evaluate(() =>
						(Reflect.get(globalThis, "__TS_DRP_WORKER_TIMELINE__") as { start(): void }).start()
					);
				return true;
			})
			.catch(() => false);
		workers.push({ role, worker, installed });
	};
	for (const [role, page] of pages) {
		for (const worker of page.workers()) add(role, worker);
		page.on("worker", (worker) => add(role, worker));
	}
	return {
		async start(): Promise<void> {
			started = true;
			await Promise.all(
				workers.map(async ({ worker, installed }) => {
					if (!(await installed)) return;
					await worker
						.evaluate(() => (Reflect.get(globalThis, "__TS_DRP_WORKER_TIMELINE__") as { start(): void }).start())
						.catch(() => undefined);
				})
			);
		},
		async read(): ReturnType<WorkerTimelines["read"]> {
			return Promise.all(
				workers.map(async ({ role, worker, installed }) => ({
					role,
					reading: !(await installed)
						? null
						: await worker
								.evaluate(() =>
									(Reflect.get(globalThis, "__TS_DRP_WORKER_TIMELINE__") as { read(): WorkerTimelineReading }).read()
								)
								.catch(() => null),
				}))
			);
		},
	};
}
