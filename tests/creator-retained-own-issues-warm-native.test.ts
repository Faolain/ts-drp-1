// A creator that is also a player keeps its own issued rows in the issuance retirement window
// (the browser Grid host does: 26-33 retained rows from the fourth epoch on). Its ordinary issues
// must stay on the incremental warm path, as they do with few retained rows. The exact composer
// accepts these issues; the warm path may only differ by declining what the composer refuses.
//
// Before the fix, the boundary readiness preparation built the finishing resource program, whose
// issuance census check paired the PENDING successor rows with the union limit (786432). The exact
// composer never bounds that pairing by the union limit, so from the epoch where the retained rows
// passed about 24 the preparation declined every epoch, the incremental quote declined
// ("window-source-unprepared") and every creator issue went to the template or the cold composer.
//
// Host: WARM_RETAINED_HOST (browser | node | room, default browser: the default browser host on
// fake-indexeddb). Observation only: product `__warmProofEvent` diagnostics, no product seam.
import { afterEach, expect, it } from "vitest";

import { closeLongRooms, runLongRoom } from "./fixtures/track-m-apps/app-long-room.js";

afterEach(async () => {
	expect(await closeLongRooms()).toEqual([]);
});

const HOST = (process.env.WARM_RETAINED_HOST ?? "browser") as "browser" | "node" | "room";
const EPOCHS = 6;
const MOVES = 8;

it(`creator issues stay incremental while the creator retains its own issued rows (${HOST})`, async () => {
	const tally = new Map<string, number>();
	let current: unknown = Reflect.get(globalThis, "__warmProofEvent");
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__warmProofEvent");
	// The room installs its own observer; every observer it installs is wrapped, unchanged.
	Object.defineProperty(globalThis, "__warmProofEvent", {
		configurable: true,
		get: () => current,
		set: (value: unknown) => {
			current =
				typeof value === "function"
					? (event: unknown) => {
							if (event !== null && typeof event === "object") {
								const e = event as Record<string, unknown>;
								if (e.kind === "ordinary-incremental-hit" || e.kind === "ordinary-incremental-fallback") {
									const key = `${String(e.kind)}|${String(e.phase)}|e${String(e.epoch)}`;
									tally.set(key, (tally.get(key) ?? 0) + 1);
								}
							}
							return (value as (event: unknown) => unknown)(event);
						}
					: value;
		},
	});
	try {
		await runLongRoom({ app: "grid", host: HOST, recipient: "writer", creatorLull: false, epochs: EPOCHS, moves: MOVES });
	} finally {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, "__warmProofEvent");
		else Object.defineProperty(globalThis, "__warmProofEvent", descriptor);
	}
	const count = (kind: string, phase: string, epoch: number) => tally.get(`${kind}|${phase}|e${epoch}`) ?? 0;
	const rows = Array.from({ length: EPOCHS }, (_, epoch) => ({
		epoch,
		localHits: count("ordinary-incremental-hit", "local-issuance", epoch),
		localFallbacks: count("ordinary-incremental-fallback", "local-issuance", epoch),
		receivedFallbacks: count("ordinary-incremental-fallback", "received-append", epoch),
	}));
	console.info(`WARM_RETAINED ${JSON.stringify(rows)}`);
	// Every epoch, every one of the creator's own moves is an incremental hit, and nothing falls back.
	expect(rows).toEqual(
		rows.map(({ epoch }) => ({ epoch, localHits: MOVES, localFallbacks: 0, receivedFallbacks: 0 }))
	);
}, 1_800_000);
