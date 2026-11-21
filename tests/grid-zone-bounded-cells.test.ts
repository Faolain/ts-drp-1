import { encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import {
	GRID_ZONE_BOARD,
	GRID_ZONE_ROOM_PARAMETERS,
	GRID_ZONE_STATE_LIMIT_BYTES,
	zoneCellPlacement,
} from "../examples/grid/src/v3-zone.js";
import { createZoneStateKernel, emptyZoneState } from "../examples/grid/src/zone-state.js";

// Grid's live state is bounded (owner decision 2026-11-21): a cell placement (placeCell) overwrites the
// block on its cell, so a zone's blocks are at most one per cell of its bounded board, and its state is
// bounded by board size x cell size however long the zone plays. Grid creates its rooms with an explicit
// application state limit that covers a full board with headroom (below the library ceiling).

const creatorAuthor = "c".repeat(64);
const creatorPeerId = "grid-bounded-peer-0";
const DEFAULT_LIMIT = 32_768;
const LIBRARY_CEILING = 131_072;
const WIDEST_KIND = "k".repeat(GRID_ZONE_BOARD.maxKindLength);

/** Deterministic xorshift32: the same 5,000 placements every run. */
function random(seed: number): () => number {
	let value = seed >>> 0 || 1;
	return () => {
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		return (value >>> 0) / 4_294_967_296;
	};
}

const stateBytes = (state: unknown): number => encodeCanonical(state).byteLength;

/** The zone state with every cell of the board holding a block of the widest kind. */
function fullBoardStateBytes(): number {
	const kernel = createZoneStateKernel(creatorAuthor, creatorPeerId);
	let state = kernel.emptyState();
	for (let y = 0; y < GRID_ZONE_BOARD.height; y++)
		for (let x = 0; x < GRID_ZONE_BOARD.width; x++)
			state = kernel.apply(state, zoneCellPlacement({ x, y, kind: WIDEST_KIND }), creatorAuthor).state;
	return stateBytes(state);
}

describe("Grid's live state is bounded by its board", () => {
	it("5,000 cell placements keep at most one block per cell and the state within the full-board bound", () => {
		const kernel = createZoneStateKernel(creatorAuthor, creatorPeerId);
		const next = random(0x9e3779b9);
		const kinds = ["stone", "gold", "water", "grass", "lava", WIDEST_KIND];
		const bound = fullBoardStateBytes();
		let state = emptyZoneState(creatorAuthor, creatorPeerId);
		let largest = 0;
		for (let placement = 0; placement < 5_000; placement++) {
			const x = Math.floor(next() * GRID_ZONE_BOARD.width);
			const y = Math.floor(next() * GRID_ZONE_BOARD.height);
			const kind = kinds[Math.floor(next() * kinds.length)]!;
			state = kernel.apply(state, zoneCellPlacement({ x, y, kind }), creatorAuthor).state;
			// Sampled (an exact encode per placement is the slow part of this test, not of the room).
			if (placement % 25 === 24) largest = Math.max(largest, stateBytes(state));
		}
		const blocks = (state as { blocks: readonly { x: number; y: number }[] }).blocks;
		const cells = new Set(blocks.map(({ x, y }) => `${x}:${y}`));
		expect(cells.size, "one block per occupied cell").toBe(blocks.length);
		expect(blocks.length).toBeLessThanOrEqual(GRID_ZONE_BOARD.width * GRID_ZONE_BOARD.height);
		expect(largest, "the state never passes the full-board bound").toBeLessThanOrEqual(bound);
	}, 300_000);

	it("placing on an occupied cell overwrites the block there", () => {
		const kernel = createZoneStateKernel(creatorAuthor, creatorPeerId);
		let state = emptyZoneState(creatorAuthor, creatorPeerId);
		state = kernel.apply(state, zoneCellPlacement({ x: 3, y: 4, kind: "stone" }), creatorAuthor).state;
		state = kernel.apply(state, zoneCellPlacement({ x: 3, y: 4, kind: "gold" }), creatorAuthor).state;
		const blocks = (state as { blocks: readonly { kind: string; x: number; y: number }[] }).blocks;
		expect(blocks.map(({ kind, x, y }) => ({ kind, x, y }))).toEqual([{ kind: "gold", x: 3, y: 4 }]);
	});

	it("a cell placement off the board or with an unbounded kind is refused before it is issued", () => {
		for (const input of [
			{ x: -1, y: 0, kind: "stone" },
			{ x: 0, y: GRID_ZONE_BOARD.height, kind: "stone" },
			{ x: GRID_ZONE_BOARD.width, y: 0, kind: "stone" },
			{ x: 0.5, y: 0, kind: "stone" },
			{ x: 0, y: 0, kind: "" },
			{ x: 0, y: 0, kind: `${WIDEST_KIND}k` },
		])
			expect(() => zoneCellPlacement(input), JSON.stringify(input)).toThrow(TypeError);
	});

	it("Grid creates its rooms with an explicit limit covering a full board with headroom, within the library ceiling", () => {
		const bound = fullBoardStateBytes();
		expect(GRID_ZONE_ROOM_PARAMETERS.maxApplicationStateBytes).toBe(GRID_ZONE_STATE_LIMIT_BYTES);
		expect(GRID_ZONE_STATE_LIMIT_BYTES, "headroom over a full board").toBeGreaterThanOrEqual(Math.ceil(bound * 1.5));
		expect(GRID_ZONE_STATE_LIMIT_BYTES).toBeGreaterThan(DEFAULT_LIMIT);
		expect(GRID_ZONE_STATE_LIMIT_BYTES).toBeLessThanOrEqual(LIBRARY_CEILING);
	});
});
