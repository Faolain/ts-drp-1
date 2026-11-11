/* eslint-disable @typescript-eslint/explicit-function-return-type -- Count harness; native capability inference. */
// Per-move cost of the steady issue -> admit path, as deterministic COUNTS (never wall-clock).
//
// The deterministic long-room driver (tests/fixtures/track-m-apps, harness mode, Grid, the app's own
// settlement profile, node SQLite host, no network and no timers): a creator and one Writer, each
// ordinal one creator move and one Writer move, each delivered to the other role and joined to its
// acceptance. Rollover is off: the measurement stops before the epoch's seal (the driver's seal is
// refused with a sentinel), and no lull runs (creatorLull false). The epoch only grows.
//
// Every count belongs to exactly one step: "writer.issue" (the Writer's local issue), "creator.admit"
// (the creator receiving and admitting that row), "creator.issue", "writer.receive". The driver's own
// observation reads (published(): a separate observation handle) are counted apart and excluded.
//
// Seams (restored after the test): node:sqlite DatabaseSync.exec and StatementSync run/get/all/iterate
// (statements by leading keyword; BEGIN vs BEGIN IMMEDIATE/EXCLUSIVE; each transaction's COMMIT or
// ROLLBACK classified per connection; a statement object executed for the first time counts as one
// prepare, so the per-connection statement cache stays native), and the canonical codec's public
// call counts (@ts-drp/canonical/instrumentation: every importer, dist packages included).
//
// PERMOVE_TIMING=1 installs NO seam at all and reports process CPU (user+system) and wall time of the
// early and deep windows instead (PERMOVE_TIMING JSON line; counts and budgets are skipped): the
// interleaved A/B cost check behind every count fix.
//
// PERMOVE_ATTRIBUTE=1 attributes every counted call of the measured window to its repository stack
// (PERMOVE_SITES_OUT, default /dev/shm/permove-sites.json); PERMOVE_CPU_PROFILE=<file> profiles it.
import { observeCanonicalCalls } from "@ts-drp/canonical/instrumentation";
import { writeFileSync } from "node:fs";
import { type Profiler, Session } from "node:inspector";
import { afterEach, expect, it } from "vitest";

import { installSqliteCountSeams } from "./fixtures/perf-counts/counts.js";
import { closeLongRooms, type RoleEndpoint, runLongRoom } from "./fixtures/track-m-apps/app-long-room.js";

afterEach(async () => {
	expect(await closeLongRooms()).toEqual([]);
});

const env = process.env;
const attribute = env.PERMOVE_ATTRIBUTE === "1";
if (attribute) Error.stackTraceLimit = 80;
const WARMUP = Number(env.PERMOVE_WARMUP ?? 8);
const MEASURED = Number(env.PERMOVE_MEASURED ?? 16);
// A second window deeper into the same epoch: per-move work must not grow with epoch history.
const DEEP_AT = Number(env.PERMOVE_DEEP_AT ?? 64);
const CREATOR_MOVES = Number(env.PERMOVE_CREATOR_MOVES ?? 1);
const TIMING = env.PERMOVE_TIMING === "1";
const ASSERT = !TIMING && (env.PERMOVE_ASSERT ?? "1") === "1";

// Budgets per steady Writer move (writer.issue + creator.admit), early window (moves 8-23). Base
// 89426d0a, exact and identical across runs: SELECT 779, read transactions 72, write transactions 13
// (4 of them rolled back: native read reservations, whose BEGIN IMMEDIATE is the writer exclusion
// itself and never writes), prepares 71, canonical encodes 1480 (2264 in the deep window, moves
// 64-79), decodes 273. Budgets: at least 5x fewer SELECTs, transactions and encodes, prepares only
// where a statement is genuinely new, no rolled-back write beyond the reservations' exclusion, and
// no growth of encodes with epoch history.
const BUDGET = Object.freeze({
	select: Number(env.PERMOVE_BUDGET_SELECT ?? 155),
	transactions: Number(env.PERMOVE_BUDGET_TX ?? 17),
	rolledBackWrites: Number(env.PERMOVE_BUDGET_ROLLBACK ?? 4),
	prepares: Number(env.PERMOVE_BUDGET_PREPARE ?? 10),
	encodes: Number(env.PERMOVE_BUDGET_ENCODE ?? 296),
	// Deep-window counts over the early window: O(1) per move in epoch history.
	growth: Number(env.PERMOVE_BUDGET_GROWTH ?? 1.25),
});

type Counts = Record<string, number>;

const STOP = new Error("PERMOVE_STOP_BEFORE_SEAL");

it("per steady move (rollover off): bounded SQLite statements, transactions, prepares and canonical encodes", async () => {
	const sqlite = (await import("node:sqlite")) as unknown as Record<string, { prototype: Record<string, unknown> }>;
	// Counts by "<ordinal>:<step>".
	const counts = new Map<string, Counts>();
	const sites = new Map<string, Counts>();
	let step = "setup";
	let ordinal = -1;
	let recording = false;
	const callSite = () => {
		const ours: string[] = [];
		for (const frame of (new Error().stack ?? "").split("\n").slice(3)) {
			const match = /at (?:async )?(?:(\S+) )?\(?.*?\/((?:packages|examples)\/[^:]+):(\d+)/u.exec(frame);
			if (match === null) continue;
			ours.push(`${match[1] ?? "<anon>"}@${match[2]?.replace(/^packages\//u, "")}:${match[3]}`);
			if (ours.length === 40) break;
		}
		return ours.join(" < ");
	};
	const bump = (key: string, amount = 1) => {
		const name = `${ordinal}:${step}`;
		let row = counts.get(name);
		if (row === undefined) counts.set(name, (row = {}));
		row[key] = (row[key] ?? 0) + amount;
		if (!attribute || !recording || step === "harness") return;
		const site = `${step} | ${callSite()}`;
		let siteRow = sites.get(site);
		if (siteRow === undefined) sites.set(site, (siteRow = {}));
		siteRow[key] = (siteRow[key] ?? 0) + amount;
	};
	// Timing marks (PERMOVE_TIMING): process CPU and wall clock at window boundaries.
	const marks = new Map<string, { cpu: number; wall: number }>();
	const mark = (name: string) => {
		if (!TIMING) return;
		const cpu = process.cpuUsage();
		marks.set(name, { cpu: (cpu.user + cpu.system) / 1000, wall: performance.now() });
	};
	// Shared SQLite counters (tests/fixtures/perf-counts): statements by keyword, transactions by mode.
	const restores: (() => void)[] = [];
	if (!TIMING) restores.push(await installSqliteCountSeams(bump));
	// Prepares (the shared seam never touches prepare, so the statement cache stays native): a
	// statement object executed for the first time counts as one prepare.
	const seen = new WeakSet<object>();
	for (const method of TIMING ? [] : ["run", "get", "all", "iterate"]) {
		const target = sqlite.StatementSync!.prototype;
		const original = target[method] as (...values: unknown[]) => unknown;
		target[method] = function (this: object, ...args: unknown[]) {
			if (!seen.has(this)) {
				seen.add(this);
				bump("prepare");
			}
			const result = original.apply(this, args);
			// Rows read: get() of a row, every row of all(); iterate() rows are counted as consumed.
			if (method === "get" && result !== undefined) bump("rows");
			else if (method === "all") bump("rows", (result as unknown[]).length);
			else if (method === "iterate") {
				const iterator = result as IterableIterator<unknown>;
				const next = iterator.next.bind(iterator);
				iterator.next = (...values: [] | [unknown]) => {
					const item = next(...values);
					if (item.done !== true) bump("rows");
					return item;
				};
			}
			return result;
		};
		restores.push(() => {
			target[method] = original;
		});
	}
	if (!TIMING) {
		observeCanonicalCalls((kind, byteLength) => {
			bump(`canonical.${kind}`);
			bump(`canonical.${kind}Bytes`, byteLength);
		});
		restores.push(() => observeCanonicalCalls(undefined));
	}

	const profileOut = env.PERMOVE_CPU_PROFILE;
	const session = profileOut === undefined ? undefined : new Session();
	const post = (method: string, params?: object) =>
		new Promise<unknown>((resolve, reject) =>
			session!.post(method as never, params as never, (error: unknown, result: unknown) =>
				error ? reject(error as Error) : resolve(result)
			)
		);
	const steps = (role: "creator" | "writer", endpoint: RoleEndpoint): RoleEndpoint => {
		const wrapped: Record<string, unknown> = { ...endpoint };
		const label = (
			name: string,
			method: keyof RoleEndpoint,
			enter?: (args: unknown[]) => Promise<void>,
			replacement?: (...args: unknown[]) => Promise<unknown>
		) => {
			const original = replacement ?? (endpoint[method] as (...args: unknown[]) => Promise<unknown>);
			wrapped[method] = async (...args: unknown[]) => {
				if (enter !== undefined) await enter(args);
				const previous = step;
				step = name;
				try {
					return await original(...args);
				} finally {
					step = previous;
				}
			};
		};
		// Writer moves only (the scorecard's rollover-off condition, SCORECARD_CREATOR_WRITES=0): the
		// creator's own moves fill its maintenance image and need a rollover long before the deep window,
		// so after CREATOR_MOVES the creator's issue only marks the ordinal (and the profiling window).
		label(
			`${role}.issue`,
			"issue",
			async (args) => {
				if (role !== "creator") return;
				ordinal = Number(args[1]);
				if (ordinal === WARMUP || ordinal === WARMUP + MEASURED || ordinal === DEEP_AT) mark(`at${ordinal}`);
				if (ordinal === WARMUP) {
					recording = true;
					if (session !== undefined) {
						session.connect();
						await post("Profiler.enable");
						await post("Profiler.setSamplingInterval", { interval: 250 });
						await post("Profiler.start");
					}
				}
				if (ordinal === WARMUP + MEASURED) {
					recording = false;
					if (session !== undefined) {
						const result = (await post("Profiler.stop")) as Profiler.StopReturnType;
						writeFileSync(profileOut!, JSON.stringify(result.profile));
						session.disconnect();
					}
				}
			},
			role === "creator"
				? (...args: unknown[]) =>
						// The creator's first move opens the room's admission (a Writer move is admitted only
						// after the creator has issued); every later creator ordinal is a no-op.
						Number(args[1]) < CREATOR_MOVES ? endpoint.issue(...(args as [number, number])) : Promise.resolve(0)
				: undefined
		);
		label(role === "creator" ? "creator.admit" : "writer.receive", "receive");
		label("harness", "published");
		wrapped.seal = () => {
			if (role === "creator") mark("seal");
			return Promise.reject(STOP);
		};
		return wrapped as unknown as RoleEndpoint;
	};
	try {
		const stopped = await runLongRoom(
			{ app: "grid", host: "node", recipient: "writer", creatorLull: false, epochs: 1, moves: DEEP_AT + MEASURED },
			(creator, writer) => [steps("creator", creator), steps("writer", writer)]
		).then(
			() => new Error("PERMOVE_SEAL_NOT_REACHED"),
			(error: unknown) => error
		);
		// The driver wraps a transition's refusal (cause: the sentinel).
		if (stopped !== STOP && (stopped as { cause?: unknown } | undefined)?.cause !== STOP) throw new Error(`PERMOVE_RUN_FAILED at ordinal ${ordinal} step ${step}`, { cause: stopped });
	} finally {
		for (const restore of restores.reverse()) restore();
	}
	if (TIMING) {
		const window = (from: string, to: string) => {
			const a = marks.get(from),
				b = marks.get(to);
			if (a === undefined || b === undefined) throw new Error(`PERMOVE_TIMING_MARK_MISSING ${from}..${to}`);
			return { cpuMsPerMove: (b.cpu - a.cpu) / MEASURED, wallMsPerMove: (b.wall - a.wall) / MEASURED };
		};
		console.info(
			`PERMOVE_TIMING ${JSON.stringify({
				warmup: WARMUP,
				measured: MEASURED,
				deepAt: DEEP_AT,
				early: window(`at${WARMUP}`, `at${WARMUP + MEASURED}`),
				deep: window(`at${DEEP_AT}`, "seal"),
			})}`
		);
		return;
	}
	const windowCounts = (from: number, to: number, names: readonly string[]): Counts => {
		const out: Counts = {};
		for (let at = from; at < to; at++)
			for (const name of names)
				for (const [key, value] of Object.entries(counts.get(`${at}:${name}`) ?? {}))
					out[key] = (out[key] ?? 0) + value;
		for (const key of Object.keys(out)) out[key] = Math.round((100 * (out[key] as number)) / (to - from)) / 100;
		return out;
	};
	const summary = (per: Counts) => ({
		select: (per["sql.SELECT"] ?? 0) + (per["sql.WITH"] ?? 0),
		pragma: (per["sql.PRAGMA"] ?? 0) + (per["exec.PRAGMA"] ?? 0),
		insert: (per["sql.INSERT"] ?? 0) + (per["exec.INSERT"] ?? 0),
		update: per["sql.UPDATE"] ?? 0,
		delete: per["sql.DELETE"] ?? 0,
		readTransactions: per["sql.beginRead"] ?? 0,
		writeTransactions: per["sql.beginWrite"] ?? 0,
		rolledBackWrites: per["sql.rollbackWrite"] ?? 0,
		prepares: per.prepare ?? 0,
		encodes: per["canonical.encode"] ?? 0,
		decodes: per["canonical.decode"] ?? 0,
		encodedBytes: per["canonical.encodeBytes"] ?? 0,
		decodedBytes: per["canonical.decodeBytes"] ?? 0,
		rows: per.rows ?? 0,
	});
	const WRITER_MOVE = ["writer.issue", "creator.admit"];
	// The creator issues nothing; anything it publishes back is delivered and counted in writer.receive.
	const CREATOR_MOVE = ["creator.issue", "writer.receive"];
	const report = (from: number) => ({
		writerMove: summary(windowCounts(from, from + MEASURED, WRITER_MOVE)),
		creatorMove: summary(windowCounts(from, from + MEASURED, CREATOR_MOVE)),
		byStep: Object.fromEntries(
			[...WRITER_MOVE, ...CREATOR_MOVE].map((name) => [name, summary(windowCounts(from, from + MEASURED, [name]))])
		),
	});
	const early = report(WARMUP);
	const deep = report(DEEP_AT);
	console.info(
		`PERMOVE_COUNTS ${JSON.stringify({
			warmup: WARMUP,
			measured: MEASURED,
			deepAt: DEEP_AT,
			early,
			deep,
			budget: BUDGET,
		})}`
	);
	if (attribute) {
		const out = env.PERMOVE_SITES_OUT ?? "/dev/shm/permove-sites.json";
		writeFileSync(
			out,
			JSON.stringify(
				[...sites.entries()].map(([site, row]) => ({
					site,
					perMove: Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value / MEASURED])),
				}))
			)
		);
		console.info(`PERMOVE_SITES ${out} ${sites.size}`);
	}
	if (!ASSERT) return;
	const e = early.writerMove;
	expect.soft(e.select, "SELECT per Writer move").toBeLessThanOrEqual(BUDGET.select);
	expect
		.soft(e.readTransactions + e.writeTransactions, "transactions (read + write) per Writer move")
		.toBeLessThanOrEqual(BUDGET.transactions);
	expect
		.soft(e.rolledBackWrites, "rolled-back write transactions per Writer move")
		.toBeLessThanOrEqual(BUDGET.rolledBackWrites);
	expect.soft(e.prepares, "statement prepares per Writer move").toBeLessThanOrEqual(BUDGET.prepares);
	expect.soft(e.encodes, "canonical encodes per Writer move").toBeLessThanOrEqual(BUDGET.encodes);
	const d = deep.writerMove;
	expect
		.soft(d.select, "deep-window SELECT per Writer move (history growth)")
		.toBeLessThanOrEqual(Math.max(BUDGET.select, e.select * BUDGET.growth));
	expect
		.soft(d.encodes, "deep-window canonical encodes per Writer move (history growth)")
		.toBeLessThanOrEqual(Math.max(BUDGET.encodes, e.encodes * BUDGET.growth));
}, 900_000);
