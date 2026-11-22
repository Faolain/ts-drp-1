import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
	type AppKind,
	closeLongRooms,
	type HostKind,
	type RecipientMode,
	type RoleEndpoint,
	runLongRoom,
	selection,
} from "./fixtures/track-m-apps/app-long-room.js";

// Track M measurement: where the creator's per-move issue time goes as the room ages. The
// same long room as tests/track-m-{canvas,chat}-long-room.test.ts; the creator's `issue`
// calls in the selected epochs run under the V8 sampling profiler (node:inspector, this
// process), one .cpuprofile per move in TRACK_M_APPS_PROFILE_OUT. Observation only: the
// wrapper forwards every call unchanged. It asserts only the room's own progress.
//
// TRACK_M_APPS_PROFILE_OUT=<dir>  TRACK_M_APPS_PROFILE_EPOCHS=2,16  TRACK_M_APPS_EPOCHS=16
// TRACK_M_APPS_PROFILE_APP=canvas  TRACK_M_APPS_PROFILE_HOST=node
// TRACK_M_APPS_PROFILE_RECIPIENT=receive-only  TRACK_M_APPS_MOVES=8

// Measurement only: runs with TRACK_M_APPS=1, never in the default suite.
const ENABLED = process.env.TRACK_M_APPS === "1";
const EPOCHS = Number(process.env.TRACK_M_APPS_EPOCHS ?? 16);
const MOVES = Number(process.env.TRACK_M_APPS_MOVES ?? 8);
const PROFILED = (process.env.TRACK_M_APPS_PROFILE_EPOCHS ?? "2,16").split(",").map(Number);
const [APP] = selection<AppKind>("TRACK_M_APPS_PROFILE_APP", ["canvas", "chat"], ["canvas"]);
const [HOST] = selection<HostKind>(
	"TRACK_M_APPS_PROFILE_HOST",
	["node", "browser", "room", "room-retention"],
	["node"]
);
const [RECIPIENT] = selection<RecipientMode>(
	"TRACK_M_APPS_PROFILE_RECIPIENT",
	["receive-only", "writer"],
	["receive-only"]
);
const OUT = process.env.TRACK_M_APPS_PROFILE_OUT;

afterEach(async () => {
	expect(await closeLongRooms()).toEqual([]);
}, 300_000);

it.skipIf(!ENABLED)(
	`creator issue profile (${String(APP)} on ${String(HOST)}, epochs ${PROFILED.join("/")} of ${EPOCHS})`,
	async () => {
		const session = new Session();
		session.connect();
		await session.post("Profiler.enable");
		await session.post("Profiler.setSamplingInterval", { interval: 100 });
		if (OUT !== undefined) mkdirSync(OUT, { recursive: true });
		const timings: { epoch: number; ordinal: number; ms: number }[] = [];
		const wrap = (creator: RoleEndpoint, recipient: RoleEndpoint) =>
			[
				{
					...creator,
					issue: async (epoch: number, ordinal: number): Promise<number> => {
						if (!PROFILED.includes(epoch + 1)) return creator.issue(epoch, ordinal);
						await session.post("Profiler.start");
						let ms = Number.NaN;
						try {
							ms = await creator.issue(epoch, ordinal);
							return ms;
						} finally {
							const { profile } = await session.post("Profiler.stop");
							timings.push({ epoch: epoch + 1, ordinal, ms });
							if (OUT !== undefined)
								writeFileSync(join(OUT, `creator-issue-e${epoch + 1}-m${ordinal}.cpuprofile`), JSON.stringify(profile));
						}
					},
				},
				recipient,
			] as const;
		try {
			const run = await runLongRoom(
				{
					app: required(APP),
					host: required(HOST),
					recipient: required(RECIPIENT),
					creatorLull: false,
					epochs: EPOCHS,
					moves: MOVES,
				},
				wrap
			);
			expect(run.epochs).toHaveLength(EPOCHS);
			if (OUT !== undefined) writeFileSync(join(OUT, "timings.json"), JSON.stringify(timings, null, 1));
		} finally {
			await session.post("Profiler.disable");
			session.disconnect();
		}
	},
	3_600_000
);

function required<Value>(value: Value | undefined): Value {
	if (value === undefined) throw new TypeError("TRACK_M_APPS_PROFILE_SELECTION");
	return value;
}
