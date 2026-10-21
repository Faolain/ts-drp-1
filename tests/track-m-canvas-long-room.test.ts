import { afterEach, expect, it } from "vitest";

import {
	closeLongRooms,
	type HostKind,
	type RecipientMode,
	runLongRoom,
	selection,
} from "./fixtures/track-m-apps/app-long-room.js";

// Track M measurement: the shipped Canvas composition (the profile and signed ACL version of
// examples/canvas/src/profile.ts, 10x10) as a long room of genuine seal, adoption, install
// and both roles' lulls on the default Node SQLite host and on the room-database host with
// and without verified retention. It records per-store rows and bytes per role and epoch,
// and per-transition latency (TRACK_M_APPS_OUT=<dir> writes JSONL; TRACK_M_APPS_VERBOSE=1
// prints a line per epoch). It asserts only the room's own progress, never a bound: the
// numbers are the point.
//
// TRACK_M_APPS_HOSTS=node,browser,room,room-retention  TRACK_M_APPS_EPOCHS=16
// TRACK_M_APPS_CANVAS_RECIPIENTS=receive-only,writer  TRACK_M_APPS_LULLS=product,reader
// TRACK_M_APPS_REPEAT=<n> (cases repeated, hosts innermost; odd repeats reverse the hosts)

// Measurement only: runs with TRACK_M_APPS=1, never in the default suite.
const ENABLED = process.env.TRACK_M_APPS === "1";
const EPOCHS = Number(process.env.TRACK_M_APPS_EPOCHS ?? 16);
const REPEAT = Number(process.env.TRACK_M_APPS_REPEAT ?? 1);
// Ordinary moves per Writer per epoch (TRACK_M_APPS_MOVES).
const MOVES = Number(process.env.TRACK_M_APPS_MOVES ?? 2);
const HOSTS = selection<HostKind>(
	"TRACK_M_APPS_HOSTS",
	["node", "browser", "room", "room-retention"],
	["node", "room", "room-retention"]
);
const RECIPIENTS = selection<RecipientMode>(
	"TRACK_M_APPS_CANVAS_RECIPIENTS",
	["receive-only", "writer"],
	["receive-only"]
);
const LULLS = selection<"product" | "reader">("TRACK_M_APPS_LULLS", ["product", "reader"], ["product"]);
const LULL_KINDS = ["maintained", "not-needed", "deferred:unsupported", "deferred:busy"];

afterEach(async () => {
	expect(await closeLongRooms()).toEqual([]);
}, 300_000);

const cases = Array.from({ length: REPEAT }, (_, repeat) =>
	(REPEAT === 1
		? HOSTS.flatMap((host) => RECIPIENTS.flatMap((recipient) => LULLS.map((lull) => [host, recipient, lull] as const)))
		: RECIPIENTS.flatMap((recipient) =>
				LULLS.flatMap((lull) =>
					(repeat % 2 === 0 ? HOSTS : [...HOSTS].reverse()).map((host) => [host, recipient, lull] as const)
				)
			)
	).map(([host, recipient, lull]) => [host, recipient, lull, repeat] as const)
).flat();

it.skipIf(!ENABLED).each(cases)(
	`canvas long room (${EPOCHS} epochs) on the %s host with a %s recipient and the %s creator lull (repeat %i)`,
	async (host, recipient, lull) => {
		const run = await runLongRoom({
			app: "canvas",
			host,
			recipient,
			creatorLull: lull === "reader",
			epochs: EPOCHS,
			moves: MOVES,
		});
		expect(run.epochs).toHaveLength(EPOCHS);
		for (const record of run.epochs) {
			expect(LULL_KINDS).toContain(record.lulls.creator);
			expect(LULL_KINDS).toContain(record.lulls.recipient);
		}
	},
	3_600_000
);
