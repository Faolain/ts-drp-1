import { afterEach, expect, it } from "vitest";

import {
	type AppKind,
	type BoundMode,
	closeLongRooms,
	type HostKind,
	type RecipientMode,
	runLongRoom,
} from "./fixtures/canvas-chat-lull/node-long-room.js";

// Track Q evidence (Canvas and Chat creator lull): long rooms of the shipped Canvas
// (its shipped profile from examples/canvas/src/profile.ts, 10x10) and Chat
// (creator-trusted-settlement-v1) compositions through
// genuine seal, adoption, install and both roles' lulls, with moves arriving while the
// creator's lull runs and an optional persisted reopen. Each run is the product composition
// ("shipped") or the same composition without its resource bound reader ("absent", the
// pre-Track-Q shape), so one tree yields interleaved pairs. Measurement runs only with
// CANVAS_CHAT_LULL=1; it is skipped in the default suite.
//
// CANVAS_CHAT_LULL_APPS=canvas,chat  CANVAS_CHAT_LULL_HOSTS=node,room,browser
// CANVAS_CHAT_LULL_RECIPIENTS=receive-only,writer  CANVAS_CHAT_LULL_BOUNDS=shipped,absent
// CANVAS_CHAT_LULL_EPOCHS=16  CANVAS_CHAT_LULL_MOVES=2  CANVAS_CHAT_LULL_LULL_MOVES=2
// CANVAS_CHAT_LULL_REOPEN_AFTER=<epoch> (every host)  CANVAS_CHAT_LULL_REPEAT=<n>
// (pairs; odd repeats reverse the bound order)  CANVAS_CHAT_LULL_OUT=<dir> (JSONL)
// CANVAS_CHAT_LULL_TREE=<label>  CANVAS_CHAT_LULL_VERBOSE=1  CANVAS_CHAT_LULL_SETTLE_MS=300

const ENABLED = process.env.CANVAS_CHAT_LULL === "1";

function selection<Value extends string>(name: string, allowed: readonly Value[], fallback: readonly Value[]): Value[] {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return [...fallback];
	const values = raw.split(",").map((value) => value.trim());
	for (const value of values)
		if (!allowed.includes(value as Value)) throw new TypeError(`CANVAS_CHAT_LULL_SELECTION ${name}=${value}`);
	return values as Value[];
}

const EPOCHS = Number(process.env.CANVAS_CHAT_LULL_EPOCHS ?? 16);
const MOVES = Number(process.env.CANVAS_CHAT_LULL_MOVES ?? 2);
const LULL_MOVES = Number(process.env.CANVAS_CHAT_LULL_LULL_MOVES ?? 2);
const REPEAT = Number(process.env.CANVAS_CHAT_LULL_REPEAT ?? 1);
const REOPEN_AFTER =
	process.env.CANVAS_CHAT_LULL_REOPEN_AFTER === undefined
		? undefined
		: Number(process.env.CANVAS_CHAT_LULL_REOPEN_AFTER);
const APPS = selection<AppKind>("CANVAS_CHAT_LULL_APPS", ["canvas", "chat"], ["canvas", "chat"]);
const HOSTS = selection<HostKind>("CANVAS_CHAT_LULL_HOSTS", ["node", "room", "browser"], ["node"]);
const RECIPIENTS = selection<RecipientMode>(
	"CANVAS_CHAT_LULL_RECIPIENTS",
	["receive-only", "writer"],
	["receive-only", "writer"]
);
const BOUNDS = selection<BoundMode>("CANVAS_CHAT_LULL_BOUNDS", ["shipped", "absent"], ["shipped", "absent"]);

afterEach(async () => {
	expect(await closeLongRooms()).toEqual([]);
}, 300_000);

const cases = Array.from({ length: REPEAT }, (_, repeat) =>
	APPS.flatMap((app) =>
		HOSTS.flatMap((host) =>
			RECIPIENTS.flatMap((recipient) =>
				(repeat % 2 === 0 ? BOUNDS : [...BOUNDS].reverse()).map(
					(bound) => [app, host, recipient, bound, repeat] as const
				)
			)
		)
	)
).flat();

it.skipIf(!ENABLED).each(cases)(
	`%s long room on the %s host with a %s recipient and the %s bound (repeat %i)`,
	async (app, host, recipient, bound) => {
		const run = await runLongRoom(
			{
				app,
				host,
				recipient,
				bound,
				epochs: EPOCHS,
				moves: MOVES,
				lullMoves: LULL_MOVES,
				...(REOPEN_AFTER === undefined ? {} : { reopenAfter: REOPEN_AFTER }),
			},
			{
				settleMs: Number(process.env.CANVAS_CHAT_LULL_SETTLE_MS ?? 300),
				...(process.env.CANVAS_CHAT_LULL_OUT === undefined ? {} : { out: process.env.CANVAS_CHAT_LULL_OUT }),
				...(process.env.CANVAS_CHAT_LULL_TREE === undefined ? {} : { tree: process.env.CANVAS_CHAT_LULL_TREE }),
				verbose: process.env.CANVAS_CHAT_LULL_VERBOSE === "1",
			}
		);
		expect(run.epochs).toHaveLength(EPOCHS);
		const summary = JSON.stringify(
			run.epochs.map((record) => ({
				epoch: record.epoch,
				lull: record.lulls.creator,
				sealRetirement: record.windows.seal.retirementSelections,
				lullRetirement: record.windows.lull.retirementSelections,
				ingress: record.lullIngress?.order,
				entered: record.lullIngress?.entered,
				pending: record.lullIngress?.pendingAtDelivery,
				reopened: record.reopened === undefined ? undefined : true,
			}))
		);
		for (const record of run.epochs) {
			// Every move delivered while the lull ran, and the creator's own, was admitted in order (G23).
			if (record.lullIngress !== undefined) {
				expect(record.lullIngress.allAdmitted, summary).toBe(true);
				expect(record.lullIngress.fifo, summary).toBe(true);
				// A lull that selected retirement had the moves handed to it while it was still running.
				if (record.windows.lull.retirementSelections > 0)
					expect([record.lullIngress.entered, record.lullIngress.pendingAtDelivery], summary).toEqual([true, true]);
			}
			if (bound === "absent") expect(record.lulls.creator, summary).toBe("deferred:unsupported");
		}
		if (bound === "shipped") {
			for (const record of run.epochs.filter(({ epoch }) => epoch >= 3))
				expect(record.lulls.creator, summary).not.toBe("deferred:unsupported");
			for (const record of run.epochs) {
				const prior = run.epochs.find(({ epoch }) => epoch === record.epoch - 1);
				// The first seal after a persisted reopen resumes the retirement the closed process had
				// planned (its in-memory turnover token does not survive the reopen); it is reported in
				// the JSONL and RESULT.md, not asserted here.
				if (prior?.lulls.creator === "maintained" && prior.reopened === undefined)
					expect(record.windows.seal.retirementSelections, summary).toBe(0);
			}
		}
	},
	7_200_000
);
