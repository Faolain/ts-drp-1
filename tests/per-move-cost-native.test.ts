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
// The run stays below 64 Writer moves (moves 0-63, deep window 48-63): the creator is silent after its
// first move, so the Writer never receives a creator row proving its moves admitted, and it counts
// every move of the epoch against V3_ROOM_LOCAL_BACKLOG_LIMIT (64 own moves without admission evidence
// between installs; one hand-back record each if a window expiry ever held them). Its 65th move is
// refused with V3RoomLocalBacklogFull. Shipped apps roll over every few moves per author, and each
// install clears the count, so only an artificial single-epoch run with a silent creator reaches it.
//
// Seams (restored after the test): node:sqlite DatabaseSync.exec and StatementSync run/get/all/iterate
// (statements by leading keyword; BEGIN vs BEGIN IMMEDIATE/EXCLUSIVE; each transaction's COMMIT or
// ROLLBACK classified per connection; a statement object executed for the first time counts as one
// prepare, so the per-connection statement cache stays native), and the canonical codec's public
// call counts and bytes (@ts-drp/canonical/instrumentation: every importer, dist packages included),
// Ed25519 verifications computed or answered by the exact-byte memo (@ts-drp/protocol-v3/instrumentation,
// source and dist instances),
// bytes hashed (SHA-256 updates: @noble/hashes HashMD, the codec's hash, and node:crypto Hash) and rows read.
//
// PERMOVE_TIMING=1 installs NO seam at all and reports process CPU (user+system) and wall time of the
// early and deep windows instead (PERMOVE_TIMING JSON line; counts and budgets are skipped): the
// interleaved A/B cost check behind every count fix.
//
// PERMOVE_ATTRIBUTE=1 attributes every counted call of the measured window to its repository stack
// (PERMOVE_SITES_OUT, default /dev/shm/permove-sites.json); PERMOVE_CPU_PROFILE=<file> profiles it.
import { observeCanonicalCalls } from "@ts-drp/canonical/instrumentation";
import { observeEd25519Verifications } from "@ts-drp/protocol-v3/instrumentation";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { type Profiler, Session } from "node:inspector";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

import { installSqliteCountSeams } from "./fixtures/perf-counts/counts.js";
import {
	type AppKind,
	closeLongRooms,
	type RoleEndpoint,
	runLongRoom,
} from "./fixtures/track-m-apps/app-long-room.js";

afterEach(async () => {
	expect(await closeLongRooms()).toEqual([]);
});

const env = process.env;
const attribute = env.PERMOVE_ATTRIBUTE === "1";
if (attribute) Error.stackTraceLimit = 80;
const WARMUP = Number(env.PERMOVE_WARMUP ?? 8);
const MEASURED = Number(env.PERMOVE_MEASURED ?? 16);
// A second window deeper into the same epoch: per-move work must not grow with epoch history.
// 48, not 64: moves DEEP_AT..DEEP_AT+15 must stay within the 64-move bound (see the header).
const DEEP_AT = Number(env.PERMOVE_DEEP_AT ?? 48);
const CREATOR_MOVES = Number(env.PERMOVE_CREATOR_MOVES ?? 1);
// PERMOVE_APP: the application (grid by default; canvas and chat for the per-app comparison).
const APP = (env.PERMOVE_APP ?? "grid") as AppKind;
const TIMING = env.PERMOVE_TIMING === "1";
const ASSERT = !TIMING && (env.PERMOVE_ASSERT ?? "1") === "1";

// Budgets per steady Writer move (writer.issue + creator.admit), early window (moves 8-23). Base
// 89426d0a, exact and identical across runs: SELECT 779, read transactions 72, write transactions 13
// (4 of them rolled back: native read reservations, whose BEGIN IMMEDIATE is the writer exclusion
// itself and never writes), prepares 71, canonical encodes 1480 (2264 in the deep window, moves
// 64-79), decodes 273. Budgets: at least 5x fewer SELECTs, transactions and encodes, prepares only
// where a statement is genuinely new, no rolled-back write beyond the reservations' exclusion, and
// no growth of encodes with epoch history. Cost budgets (same base, test 3723013e counters): canonical
// bytes encoded 351220 (821440 deep), decoded 46833, rows read 1094, bytes hashed 37189 (137407 deep),
// Ed25519 verifications computed 1 (plus 3 exact-byte memo hits): 5x fewer bytes and rows, no growth
// of encoded or hashed bytes with history, and never more than the one verification the move needs.
// Two modes. By default the test is a regression ceiling at the counts reached by perf/per-move-cost
// (exact on 43e9d159: SELECT 474, transactions 68, prepares 14, encodes 1088, bytes encoded 288491)
// plus ~10%, so it passes in ordinary suites and fails if the steady path regresses. PERMOVE_TARGETS=1
// checks the 5x targets above, which are not met yet (the remaining cost is not one hotspot, and
// fixes that lowered a count without lowering CPU were reverted).
const TARGETS = env.PERMOVE_TARGETS === "1";
const BUDGET = Object.freeze({
	select: Number(env.PERMOVE_BUDGET_SELECT ?? (TARGETS ? 155 : 520)),
	transactions: Number(env.PERMOVE_BUDGET_TX ?? (TARGETS ? 17 : 75)),
	rolledBackWrites: Number(env.PERMOVE_BUDGET_ROLLBACK ?? 4),
	prepares: Number(env.PERMOVE_BUDGET_PREPARE ?? (TARGETS ? 10 : 16)),
	encodes: Number(env.PERMOVE_BUDGET_ENCODE ?? (TARGETS ? 296 : 1_200)),
	encodedBytes: Number(env.PERMOVE_BUDGET_ENCODED_BYTES ?? (TARGETS ? 70_244 : 320_000)),
	decodedBytes: Number(env.PERMOVE_BUDGET_DECODED_BYTES ?? (TARGETS ? 9_367 : 30_000)),
	rows: Number(env.PERMOVE_BUDGET_ROWS ?? (TARGETS ? 219 : 730)),
	hashedBytes: Number(env.PERMOVE_BUDGET_HASHED_BYTES ?? (TARGETS ? 7_438 : 41_000)),
	verifies: Number(env.PERMOVE_BUDGET_VERIFIES ?? 1),
	// Deep-window counts over the early window: O(1) per move in epoch history.
	growth: Number(env.PERMOVE_BUDGET_GROWTH ?? 1.25),
});
// Regression mode only: the deep window still grows with history (on 43e9d159, window 64-79: encodes 1536,
// bytes encoded 702376, bytes hashed 137407, rows 1277.5 vs early 1088 / 288491 / 37189 / 661.5). That growth
// is an open cost item; these ceilings only stop it getting worse. Since the deep window moved to 48-63
// (the 64-move bound, see the header) they are the window-48 counts measured on c56daab6 plus ~10%.
// PERMOVE_TARGETS=1 requires O(1).
const DEEP_CEILING: Partial<Record<"select" | "encodes" | "encodedBytes" | "hashedBytes" | "rows", number>> = TARGETS
	? {}
	: { encodes: 1_550, encodedBytes: 645_000, hashedBytes: 120_000, rows: 1_215 };
const deepCap = (key: "select" | "encodes" | "encodedBytes" | "hashedBytes" | "rows", early: number): number =>
	DEEP_CEILING[key] ?? Math.max(BUDGET[key], early * BUDGET.growth);

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
		const target = (sqlite.StatementSync as { prototype: Record<string, unknown> }).prototype;
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
		// Both protocol-v3 instances: the vite-aliased source this test's importers load, and the dist
		// build the dist packages (storage, compaction, issuance-store) resolve through node.
		const distVerifications = (
			(await import(path.resolve(import.meta.dirname, "../packages/protocol-v3/dist/src/instrumentation.js"))) as {
				observeEd25519Verifications: typeof observeEd25519Verifications;
			}
		).observeEd25519Verifications;
		for (const [instance, observe] of [
			["source", observeEd25519Verifications],
			["dist", distVerifications],
		] as const) {
			observe((outcome) => bump(`${outcome === "computed" ? "verify" : "verifyMemo"}.${instance}`));
			restores.push(() => observe(undefined));
		}
		// Bytes hashed: every SHA-256 update of the codec's @noble/hashes (the ESM instance every
		// importer shares) and of node:crypto.
		const nobleMd = createRequire(new URL("../packages/canonical/package.json", import.meta.url)).resolve(
			"@noble/hashes/_md"
		);
		const { HashMD } = (await import(pathToFileURL(path.join(path.dirname(nobleMd), "esm/_md.js")).href)) as {
			HashMD: { prototype: Record<string, unknown> };
		};
		for (const prototype of [
			HashMD.prototype,
			Object.getPrototypeOf(createHash("sha256")) as Record<string, unknown>,
		]) {
			const update = prototype.update as (this: unknown, data: unknown, ...rest: unknown[]) => unknown;
			prototype.update = function (this: unknown, data: unknown, ...rest: unknown[]) {
				bump("hashedBytes", typeof data === "string" ? Buffer.byteLength(data) : (data as Uint8Array).byteLength);
				return update.call(this, data, ...rest);
			};
			restores.push(() => {
				prototype.update = update;
			});
		}
	}

	const profileOut = env.PERMOVE_CPU_PROFILE;
	const session = profileOut === undefined ? undefined : new Session();
	const post = (method: string, params?: object): Promise<unknown> =>
		new Promise<unknown>((resolve, reject) =>
			(session as Session).post(method as never, params as never, (error: unknown, result: unknown) =>
				error ? reject(error as Error) : resolve(result)
			)
		);
	// The recorded (and profiled) window ends at ordinal WARMUP + MEASURED, or at the seal when that
	// ordinal is the last (PERMOVE_WARMUP = PERMOVE_DEEP_AT profiles the deep window).
	const endRecording = async () => {
		if (!recording) return;
		recording = false;
		if (session !== undefined) {
			const result = (await post("Profiler.stop")) as Profiler.StopReturnType;
			writeFileSync(profileOut as string, JSON.stringify(result.profile));
			session.disconnect();
		}
	};
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
				if (ordinal === WARMUP || ordinal === WARMUP + MEASURED || ordinal === DEEP_AT || ordinal % MEASURED === 0)
					mark(`at${ordinal}`);
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
					await endRecording();
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
		wrapped.seal = async () => {
			if (role === "creator") {
				mark("seal");
				if (WARMUP + MEASURED === DEEP_AT + MEASURED) mark(`at${WARMUP + MEASURED}`);
				await endRecording();
			}
			throw STOP;
		};
		return wrapped as unknown as RoleEndpoint;
	};
	try {
		const stopped = await runLongRoom(
			{ app: APP, host: "node", recipient: "writer", creatorLull: false, epochs: 1, moves: DEEP_AT + MEASURED },
			(creator, writer) => [steps("creator", creator), steps("writer", writer)]
		).then(
			() => new Error("PERMOVE_SEAL_NOT_REACHED"),
			(error: unknown) => error
		);
		// The driver wraps a transition's refusal (cause: the sentinel).
		if (stopped !== STOP && (stopped as { cause?: unknown } | undefined)?.cause !== STOP)
			throw new Error(`PERMOVE_RUN_FAILED at ordinal ${ordinal} step ${step}`, { cause: stopped });
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
				// Per-move cost by epoch depth: every MEASURED-move window from the first.
				curve: Array.from({ length: Math.floor(DEEP_AT / MEASURED) + 1 }, (_, index) => {
					const from = index * MEASURED;
					const to = from + MEASURED;
					return marks.has(`at${from}`) && marks.has(to === DEEP_AT + MEASURED ? "seal" : `at${to}`)
						? { from, ...window(`at${from}`, to === DEEP_AT + MEASURED ? "seal" : `at${to}`) }
						: { from };
				}),
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
		hashedBytes: per.hashedBytes ?? 0,
		verifies: (per["verify.source"] ?? 0) + (per["verify.dist"] ?? 0),
		verifiesDist: per["verify.dist"] ?? 0,
		verifyMemoHits: (per["verifyMemo.source"] ?? 0) + (per["verifyMemo.dist"] ?? 0),
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
	expect.soft(e.encodedBytes, "canonical bytes encoded per Writer move").toBeLessThanOrEqual(BUDGET.encodedBytes);
	expect.soft(e.decodedBytes, "canonical bytes decoded per Writer move").toBeLessThanOrEqual(BUDGET.decodedBytes);
	expect.soft(e.rows, "SQLite rows read per Writer move").toBeLessThanOrEqual(BUDGET.rows);
	expect.soft(e.hashedBytes, "bytes hashed per Writer move").toBeLessThanOrEqual(BUDGET.hashedBytes);
	expect.soft(e.verifies, "Ed25519 verifications computed per Writer move").toBeLessThanOrEqual(BUDGET.verifies);
	const d = deep.writerMove;
	expect
		.soft(d.select, "deep-window SELECT per Writer move (history growth)")
		.toBeLessThanOrEqual(deepCap("select", e.select));
	expect
		.soft(d.encodes, "deep-window canonical encodes per Writer move (history growth)")
		.toBeLessThanOrEqual(deepCap("encodes", e.encodes));
	expect
		.soft(d.encodedBytes, "deep-window canonical bytes encoded per Writer move (history growth)")
		.toBeLessThanOrEqual(deepCap("encodedBytes", e.encodedBytes));
	expect
		.soft(d.hashedBytes, "deep-window bytes hashed per Writer move (history growth)")
		.toBeLessThanOrEqual(deepCap("hashedBytes", e.hashedBytes));
	expect
		.soft(d.rows, "deep-window SQLite rows read per Writer move (history growth)")
		.toBeLessThanOrEqual(deepCap("rows", e.rows));
}, 900_000);
