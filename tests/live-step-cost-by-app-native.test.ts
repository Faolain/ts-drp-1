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
// (ordinary moves per Writer per epoch, default 6), LIVE_ROLLOVER (harness | app, default harness).
// Prints one `LIVE_STEPS {json}` line: per step and position bucket (0 = the first such step after
// the boundary, then 1, 2-3, 4+; "span" = an app-rollover step during which the role's epoch
// changed), the count and the median/p95 wall and CPU in ms.
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
	const boundary = (role: string) => {
		for (const key of [...since.keys()]) if (key.startsWith(`${role}.`)) since.set(key, 0);
	};
	const wrap = (role: "creator" | "writer", endpoint: RoleEndpoint): RoleEndpoint => {
		const wrapped: Record<string, unknown> = { ...endpoint };
		const timed = (method: "issue" | "receive", step: string) => {
			const original = endpoint[method] as (...args: unknown[]) => Promise<unknown>;
			wrapped[method] = async (...args: unknown[]) => {
				const position = since.get(step) ?? 0;
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
			// The roles' recovery-pool lulls run (as in the conservation gate), so the creator's
			// maintenance image stays within its native bound across epochs.
			creatorLull: true,
			epochs: EPOCHS,
			moves: MOVES,
			...(ROLLOVER === "app" ? { rollover: "app" as const } : {}),
		},
		(creator, writer) => [wrap("creator", creator), wrap("writer", writer)]
	);
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
	console.info(`LIVE_STEPS ${JSON.stringify({ app: APP, rollover: ROLLOVER, epochs: EPOCHS, moves: MOVES, steps: out })}`);
}, 1_800_000);
