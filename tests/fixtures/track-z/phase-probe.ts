import type { BrowserContext, Page } from "@playwright/test";

// Track Z (measurement only): attributes the shipped pages' seal, adoption, install and lull to the work inside them,
// for the long-room harnesses tests/track-x-shipped-app-long-room.pw.ts and tests/track-v-grid-long-room.pw.ts.
// Everything here observes; nothing changes what the page does.
//
// `installPhaseProbe` adds an init script to a browser context that keeps, with absolute page times
// (performance.timeOrigin + performance.now()):
// - every diagnostic proof event the library reports through `__warmProofEvent` (chained to any observer already
//   installed), as its kind and, where the event carries them, its `ms` and its outcome or reason;
// - wall-clock spans that a temporary instrumented build may report through `__trackZSpan(name, start, end)`
//   (nothing in the library calls it);
// - outcomes that a measurement build's automatic lull may report through `__trackZAutoLull(outcome)`;
// - every IndexedDB transaction: database, mode, creation and completion (or abort) time;
// - long tasks (PerformanceObserver "longtask", Chromium).
// With TRACK_Z_PAGE_GLOBALS (a JSON object) it also sets those page globals before any page script runs. Nothing at
// the base reads them; a scratch measurement build may.
//
// `takePhases` drains one page's records. `summarizePhases` assigns each record to the window that holds its start
// time, and reports per window: span time by name, proof-event counts (and summed `ms`) by kind, IndexedDB
// transactions (count, read-write count, per database, and the wall time with at least one transaction open), and
// long tasks.

/** One measured interval in absolute page time (ms). */
export interface PhaseWindow {
	readonly name: string;
	readonly start: number;
	readonly end: number;
}

/** One page's records since the previous take. Tuples keep the transfer small. */
export interface RawPhases {
	/** [time, kind, ms or null, outcome or reason or null] */
	readonly proof: readonly (readonly [number, string, number | null, string | null])[];
	/** [name, start, end] */
	readonly spans: readonly (readonly [string, number, number])[];
	/** [database, mode, start, end] */
	readonly idb: readonly (readonly [string, string, number, number])[];
	/** [start, duration] */
	readonly tasks: readonly (readonly [number, number])[];
	readonly auto: readonly Readonly<Record<string, unknown>>[];
	readonly dropped: number;
	readonly openTransactions: number;
}

export interface WindowSummary {
	ms: number;
	spans: Record<string, [number, number]>;
	proof: Record<string, number>;
	proofMs: Record<string, number>;
	idb: { tx: number; rw: number; busyMs: number; byDb: Record<string, number> };
	tasks: { count: number; longest: number; total: number };
}

const PAGE_GLOBALS = process.env.TRACK_Z_PAGE_GLOBALS;

/**
 * Absolute page time, read inside the page.
 * @param page - The page.
 * @returns performance.timeOrigin + performance.now(), in ms.
 */
export const pageNow = (page: Page): Promise<number> => page.evaluate(() => performance.timeOrigin + performance.now());

function phaseProbeInitScript(globals: Readonly<Record<string, unknown>>): void {
	for (const [name, value] of Object.entries(globals)) Reflect.set(globalThis, name, value);
	const now = (): number => performance.timeOrigin + performance.now();
	const limit = 400_000;
	const state = {
		proof: [] as [number, string, number | null, string | null][],
		spans: [] as [string, number, number][],
		idb: [] as [string, string, number, number][],
		tasks: [] as [number, number][],
		auto: [] as Record<string, unknown>[],
		dropped: 0,
		open: 0,
	};
	const room = (): boolean => {
		if (state.proof.length + state.spans.length + state.idb.length + state.tasks.length < limit) return true;
		state.dropped++;
		return false;
	};
	const previous = Reflect.get(globalThis, "__warmProofEvent") as ((event: unknown) => unknown) | undefined;
	Reflect.set(globalThis, "__warmProofEvent", (event: unknown) => {
		try {
			if (event !== null && typeof event === "object" && room()) {
				const record = event as Record<string, unknown>;
				const ms = typeof record.ms === "number" ? record.ms : null;
				const detail = record.outcome ?? record.reason ?? record.refusal ?? null;
				state.proof.push([now(), String(record.kind), ms, detail === null ? null : String(detail).slice(0, 60)]);
			}
		} catch {
			// Observation only.
		}
		return typeof previous === "function" ? previous(event) : undefined;
	});
	Reflect.set(globalThis, "__trackZSpan", (name: unknown, start: unknown, end: unknown) => {
		if (typeof name === "string" && typeof start === "number" && typeof end === "number" && room())
			state.spans.push([name, performance.timeOrigin + start, performance.timeOrigin + end]);
	});
	Reflect.set(globalThis, "__trackZAutoLull", (outcome: unknown) => {
		if (outcome !== null && typeof outcome === "object" && state.auto.length < 4_096)
			state.auto.push({ ...(outcome as Record<string, unknown>), at: now() });
	});
	const transaction = IDBDatabase.prototype.transaction;
	IDBDatabase.prototype.transaction = function (
		this: IDBDatabase,
		...args: Parameters<IDBDatabase["transaction"]>
	): IDBTransaction {
		const created = Reflect.apply(transaction, this, args) as IDBTransaction;
		const started = now();
		const database = this.name;
		const mode = args[1] ?? "readonly";
		state.open++;
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			state.open--;
			if (room()) state.idb.push([database, mode, started, now()]);
		};
		created.addEventListener("complete", finish);
		created.addEventListener("abort", finish);
		created.addEventListener("error", finish);
		return created;
	};
	if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask"))
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries())
				if (room()) state.tasks.push([performance.timeOrigin + entry.startTime, entry.duration]);
		}).observe({ type: "longtask", buffered: true });
	Reflect.set(globalThis, "__TRACK_Z_PHASES__", {
		take: () => {
			const taken = {
				proof: state.proof.splice(0),
				spans: state.spans.splice(0),
				idb: state.idb.splice(0),
				tasks: state.tasks.splice(0),
				auto: state.auto.splice(0),
				dropped: state.dropped,
				openTransactions: state.open,
			};
			state.dropped = 0;
			return taken;
		},
	});
}

/**
 * Adds the observation-only probe (and any TRACK_Z_PAGE_GLOBALS) to a context's pages.
 * @param context - The browser context.
 */
export async function installPhaseProbe(context: BrowserContext): Promise<void> {
	const globals = PAGE_GLOBALS === undefined ? {} : (JSON.parse(PAGE_GLOBALS) as Record<string, unknown>);
	if (globals === null || typeof globals !== "object" || Array.isArray(globals))
		throw new TypeError("TRACK_Z_PAGE_GLOBALS must be a JSON object");
	await context.addInitScript(phaseProbeInitScript, globals);
}

/**
 * Drains the page's records since the previous take.
 * @param page - A page whose context has the probe.
 * @returns The records.
 */
export function takePhases(page: Page): Promise<RawPhases> {
	return page.evaluate(() => {
		const probe = Reflect.get(globalThis, "__TRACK_Z_PHASES__") as { take(): RawPhases } | undefined;
		if (probe === undefined) throw new Error("TRACK_Z_PHASE_PROBE_ABSENT");
		return probe.take();
	});
}

const shortDatabase = (name: string): string => name.replace(/[0-9a-f]{16,}/gu, "*").slice(0, 80);

/**
 * Assigns every record to the window holding its start time ("other" when none does).
 * @param raw - One page's records.
 * @param windows - The epoch's windows, in absolute page time.
 * @returns Per-window summaries.
 */
export function summarizePhases(raw: RawPhases, windows: readonly PhaseWindow[]): Record<string, WindowSummary> {
	const summaries: Record<string, WindowSummary> = {};
	const intervals: Record<string, [number, number][]> = {};
	const fresh = (ms: number): WindowSummary => ({
		ms,
		spans: {},
		proof: {},
		proofMs: {},
		idb: { tx: 0, rw: 0, busyMs: 0, byDb: {} },
		tasks: { count: 0, longest: 0, total: 0 },
	});
	for (const window of windows) summaries[window.name] = fresh(Math.round(window.end - window.start));
	const at = (time: number): WindowSummary => {
		const window = windows.find(({ start, end }) => time >= start && time < end);
		const name = window?.name ?? "other";
		summaries[name] ??= fresh(0);
		return summaries[name];
	};
	for (const [time, kind, ms] of raw.proof) {
		const summary = at(time);
		summary.proof[kind] = (summary.proof[kind] ?? 0) + 1;
		if (ms !== null) summary.proofMs[kind] = Math.round((summary.proofMs[kind] ?? 0) + ms);
	}
	for (const [name, start, end] of raw.spans) {
		const summary = at(start);
		const entry = (summary.spans[name] ??= [0, 0]);
		entry[0]++;
		entry[1] = Math.round(entry[1] + end - start);
	}
	for (const [database, mode, start, end] of raw.idb) {
		const window = windows.find(({ start: from, end: to }) => start >= from && start < to);
		const summary = at(start);
		summary.idb.tx++;
		if (mode === "readwrite") summary.idb.rw++;
		const key = shortDatabase(database);
		summary.idb.byDb[key] = (summary.idb.byDb[key] ?? 0) + 1;
		(intervals[window?.name ?? "other"] ??= []).push([start, end]);
	}
	for (const [name, list] of Object.entries(intervals)) {
		list.sort((left, right) => left[0] - right[0]);
		let busy = 0;
		let open: [number, number] | undefined;
		for (const [start, end] of list) {
			if (open === undefined || start > open[1]) {
				if (open !== undefined) busy += open[1] - open[0];
				open = [start, end];
			} else open[1] = Math.max(open[1], end);
		}
		if (open !== undefined) busy += open[1] - open[0];
		const summary = summaries[name];
		if (summary !== undefined) summary.idb.busyMs = Math.round(busy);
	}
	for (const [start, duration] of raw.tasks) {
		const summary = at(start);
		summary.tasks.count++;
		summary.tasks.longest = Math.max(summary.tasks.longest, Math.round(duration));
		summary.tasks.total = Math.round(summary.tasks.total + duration);
	}
	return summaries;
}
