// Measurement only (no assertions on time): per-step wall and process CPU of the long-room driver's
// live path, per application, by position after the last epoch boundary. Answers "where does a
// Canvas or Chat move spend what a Grid move does not": the steady issue/receive steps, or the first
// steps after an install/adoption.
//
// No product seam is installed: the only instrumentation is a wrapper at the driver's endpoint
// boundary (performance.now and process.cpuUsage around each awaited call). Both roles share this
// process, so a step's CPU includes anything else that ran while it was awaited.
//
// Environment: LIVE_APP (grid | canvas | chat, default grid), LIVE_EPOCHS (default 8), LIVE_MOVES
// (ordinary moves per Writer per epoch, default 6), LIVE_ROLLOVER (harness | app, default harness),
// LIVE_READER (product: the app's own resource bound reader, default | harness), LIVE_CHAT_FORMAT
// (window, the long room's default | shares, what the shipped Chat signs | lifetime).
// Prints one `LIVE_STEPS {json}` line: per step and position bucket (0 = the first such step after
// the boundary, then 1, 2-3, 4+; "span" = an app-rollover step during which the role's epoch
// changed), the count and the median/p95 wall and CPU in ms.
import { mkdirSync, writeFileSync } from "node:fs";
import { type Profiler, Session } from "node:inspector";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

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
const APP = (env.LIVE_APP ?? "grid") as AppKind;
const EPOCHS = Number(env.LIVE_EPOCHS ?? 8);
const MOVES = Number(env.LIVE_MOVES ?? 6);
const ROLLOVER = (env.LIVE_ROLLOVER ?? "harness") as "harness" | "app";
// LIVE_PROFILE=<step>@<bucket> (e.g. creator.admit@0) with LIVE_PROFILE_OUT=<dir>: a CPU profile of
// every such step (one .cpuprofile each); the profiled steps' timings include the profiler.
const PROFILE = env.LIVE_PROFILE;
const PROFILE_OUT = env.LIVE_PROFILE_OUT ?? "/dev/shm/live-profiles";

interface StepSample {
	readonly step: string;
	/** App rollover: the role's epoch changed while this step was awaited (it spanned a rollover). */
	spanned: boolean;
	readonly position: number;
	readonly rows: number;
	readonly wallMs: number;
	readonly cpuMs: number;
}

const quantile = (values: readonly number[], q: number): number => {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
};
const bucket = (position: number): string =>
	position === 0 ? "0" : position === 1 ? "1" : position <= 3 ? "2-3" : "4+";

it(`live step cost by position after the epoch boundary (${APP}, ${ROLLOVER} rollover)`, async () => {
	const samples: StepSample[] = [];
	// Steps of each kind since the last boundary (creator: its adoption; Writer: its install).
	const since = new Map<string, number>();
	const session = PROFILE === undefined ? undefined : new Session();
	if (session !== undefined) {
		session.connect();
		mkdirSync(PROFILE_OUT, { recursive: true });
	}
	const post = (method: string, params?: object): Promise<unknown> =>
		new Promise<unknown>((resolve, reject) =>
			(session as Session).post(method as never, params as never, (error: unknown, result: unknown) =>
				error ? reject(error as Error) : resolve(result)
			)
		);
	let profiled = 0;
	// Creator diagnostics (the room's __warmProofEvent observations: kind and reason) drained after
	// each creator step, tallied per step bucket. Draining moves them out of the driver's per-epoch
	// event tally; measurement only.
	const events = new Map<string, Record<string, number>>();
	const boundary = (role: string) => {
		for (const key of [...since.keys()]) if (key.startsWith(`${role}.`)) since.set(key, 0);
	};
	const wrap = (role: "creator" | "writer", endpoint: RoleEndpoint): RoleEndpoint => {
		const wrapped: Record<string, unknown> = { ...endpoint };
		const timed = (method: "issue" | "receive", step: string) => {
			const original = endpoint[method] as (...args: unknown[]) => Promise<unknown>;
			wrapped[method] = async (...args: unknown[]) => {
				const position = since.get(step) ?? 0;
				const profiling = session !== undefined && PROFILE === `${step}@${bucket(position)}`;
				if (profiling) {
					await post("Profiler.enable");
					await post("Profiler.setSamplingInterval", { interval: 250 });
					await post("Profiler.start");
				}
				const cpu = process.cpuUsage();
				const wall = performance.now();
				try {
					return await original(...args);
				} finally {
					const used = process.cpuUsage(cpu);
					samples.push({
						step,
						spanned: false,
						position,
						rows: method === "receive" ? (args[0] as readonly unknown[]).length : 1,
						wallMs: performance.now() - wall,
						cpuMs: (used.user + used.system) / 1000,
					});
					since.set(step, position + 1);
					if (role === "creator") {
						const key = `${step}@${bucket(position)}`;
						const tally = events.get(key) ?? {};
						for (const event of await endpoint.drainEvents()) {
							const name = event.reason === undefined ? event.kind : `${event.kind}:${event.reason}`;
							tally[name] = (tally[name] ?? 0) + 1;
						}
						events.set(key, tally);
					}
					if (profiling) {
						const result = (await post("Profiler.stop")) as Profiler.StopReturnType;
						writeFileSync(join(PROFILE_OUT, `${step}-${profiled++}.cpuprofile`), JSON.stringify(result.profile));
					}
				}
			};
		};
		timed("issue", `${role}.issue`);
		timed("receive", role === "creator" ? "creator.admit" : "writer.receive");
		const after = (method: "adopt" | "install", reset: string) => {
			const original = endpoint[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
			if (original === undefined) return;
			wrapped[method] = async (...args: unknown[]) => {
				try {
					return await original(...args);
				} finally {
					boundary(reset);
				}
			};
		};
		if (role === "creator") after("adopt", "creator");
		else after("install", "writer");
		// App rollover: the roles install on their own; the epoch they report marks the boundary.
		if (ROLLOVER === "app") {
			let seen: number | null = null;
			const issue = wrapped.issue as (...args: unknown[]) => Promise<unknown>;
			const receive = wrapped.receive as (...args: unknown[]) => Promise<unknown>;
			const check = async () => {
				const epoch = await endpoint.authorityEpoch();
				if (epoch !== seen) {
					if (seen !== null) boundary(role);
					seen = epoch;
				}
			};
			const spanning = async (step: string, call: () => Promise<unknown>) => {
				await check();
				const before = seen;
				try {
					return await call();
				} finally {
					if ((await endpoint.authorityEpoch()) !== before) {
						const last = samples.findLast((sample) => sample.step === step);
						if (last !== undefined) last.spanned = true;
					}
				}
			};
			wrapped.issue = (...args: unknown[]) => spanning(`${role}.issue`, () => issue(...args));
			wrapped.receive = (...args: unknown[]) =>
				spanning(role === "creator" ? "creator.admit" : "writer.receive", () => receive(...args));
		}
		return wrapped as unknown as RoleEndpoint;
	};
	await runLongRoom(
		{
			app: APP,
			host: "node",
			recipient: "writer",
			// false = each app's own ordinary resource bound reader (what the pages ship); true = the
			// harness's measurement-only reader (LIVE_READER=harness). The driver runs both roles'
			// lulls after every install either way.
			creatorLull: env.LIVE_READER === "harness",
			epochs: EPOCHS,
			moves: MOVES,
			...(ROLLOVER === "app" ? { rollover: "app" as const } : {}),
			...(env.LIVE_CHAT_FORMAT === undefined
				? {}
				: { chatFormat: env.LIVE_CHAT_FORMAT as "window" | "shares" | "lifetime" }),
		},
		(creator, writer) => [wrap("creator", creator), wrap("writer", writer)]
	);
	session?.disconnect();
	const groups = new Map<string, StepSample[]>();
	for (const sample of samples) {
		const key = `${sample.step}@${sample.spanned ? "span" : bucket(sample.position)}`;
		groups.set(key, [...(groups.get(key) ?? []), sample]);
	}
	const out: Record<string, unknown> = {};
	for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
		out[key] = {
			n: group.length,
			rows: Math.round((100 * group.reduce((sum, s) => sum + s.rows, 0)) / group.length) / 100,
			wallP50: Math.round(100 * quantile(group.map((s) => s.wallMs), 0.5)) / 100,
			wallP95: Math.round(100 * quantile(group.map((s) => s.wallMs), 0.95)) / 100,
			cpuP50: Math.round(100 * quantile(group.map((s) => s.cpuMs), 0.5)) / 100,
			cpuP95: Math.round(100 * quantile(group.map((s) => s.cpuMs), 0.95)) / 100,
		};
	console.info(
		`LIVE_STEPS ${JSON.stringify({
			app: APP,
			rollover: ROLLOVER,
			epochs: EPOCHS,
			moves: MOVES,
			steps: out,
			events: Object.fromEntries(events),
		})}`
	);
}, 1_800_000);
