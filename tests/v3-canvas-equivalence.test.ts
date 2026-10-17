import { expect, test } from "vitest";

import { Pixel } from "../examples/canvas/src/objects/pixel.js";
import { createV3CanvasApplication } from "../packages/node/src/applications/canvas.js";
import {
	type CanvasOperation,
	createCanvasStateKernel,
	createV3CanvasDescriptor,
	fromCanvasWireOperation,
} from "../packages/blueprints/src/v3-canvas.js";

test("pure canvas preserves original Pixel additive counters and modulo-256 query", () => {
	const kernel = createCanvasStateKernel(),
		pixel = new Pixel();
	const paint: CanvasOperation = { action: "paint", offset: [0, 0], rgb: [255, 7, 1] };
	const splash: CanvasOperation = { action: "splash", offset: [0, 0], size: [2, 2], rgb: [2, 250, 3] };
	let state = kernel.createState(2, 2);
	for (const operation of [paint, splash, paint]) {
		pixel.paint([...operation.rgb]);
		state = kernel.apply(state, operation).state;
	}
	expect(kernel.queryCounters(state, 0, 0)).toEqual(pixel.counters());
	expect(kernel.queryColor(state, 0, 0)).toEqual(pixel.color());
	expect(kernel.queryCounters(state, 1, 1)).toEqual(splash.rgb);
});

test("Canvas migration replays inherited full counters above 255 with bounded stable imports", () => {
	const application = createV3CanvasApplication(2, 2);
	const descriptor = createV3CanvasDescriptor(2, 2);
	const state = {
		version: 1,
		width: 2,
		height: 2,
		counters: [
			[510, 14, 2],
			[0, 0, 0],
			[1, 300, 511],
			[0, 0, 0],
		],
	};
	const source = descriptor.canonicalStateBytes(state);
	const migration = application.migration;
	if (migration === undefined) throw new TypeError("Canvas migration missing");
	const prepared = migration.prepare([], source);
	expect(prepared.exactCanonicalApplicationStateBytes).toEqual(source);
	expect(prepared).toEqual(migration.prepare([], new Uint8Array(source)));
	expect(prepared.importOperations).toHaveLength(5);
	let replay = descriptor.initialState;
	for (const operation of prepared.importOperations) {
		replay = descriptor.kernel.apply(replay, fromCanvasWireOperation(operation)).state;
	}
	expect(descriptor.canonicalStateBytes(replay)).toEqual(source);
	expect(descriptor.kernel.queryColor(replay, 0, 0)).toEqual([254, 14, 2]);
	const excessive = descriptor.canonicalStateBytes({
		...state,
		counters: [[8192 * 255 + 1, 0, 0], ...state.counters.slice(1)],
	});
	expect(() => migration.prepare([], excessive)).toThrow("unbounded");
});
