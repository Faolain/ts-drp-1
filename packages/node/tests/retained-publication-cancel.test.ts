import { describe, expect, it } from "vitest";

import { retainedPublicationCancelled, type RetainedPublicationState } from "../src/internal/retained-publication.js";

// Track Z: the room's retained publisher returns (a cancellation) instead of rejecting (a fault)
// only for a plane that an orderly close or the session's own successor retired. Every egress
// failure kind against every session state; tests/track-z-retained-publication-successor.test.ts
// covers the same rule in a room.

const KINDS = [
	"not-active",
	"publication-state-unknown",
	"publish-failed",
	"store-failed",
	"record-rejected",
	"admission-rejected",
] as const;
const state = (terminal: boolean, closing: boolean, superseded: boolean): RetainedPublicationState => ({
	terminal,
	closing,
	superseded,
});
const STATES = [false, true].flatMap((terminal) =>
	[false, true].flatMap((closing) => [false, true].map((superseded) => state(terminal, closing, superseded)))
);
const cancelled = (kind: string): RetainedPublicationState[] =>
	STATES.filter((selected) => retainedPublicationCancelled(kind, selected));

describe("retained publication cancellation", () => {
	it("storage, record and admission faults reject in every state, a close or a successor included", () => {
		for (const kind of ["store-failed", "record-rejected", "admission-rejected"]) expect(cancelled(kind)).toEqual([]);
	});

	it("every failure after a terminal failure rejects", () => {
		for (const kind of KINDS)
			for (const selected of STATES.filter(({ terminal }) => terminal))
				expect(retainedPublicationCancelled(kind, selected)).toBe(false);
	});

	it("a retired plane (not-active, publication-state-unknown) is a cancellation only during a close or once superseded", () => {
		for (const kind of ["not-active", "publication-state-unknown"])
			expect(cancelled(kind)).toEqual([state(false, false, true), state(false, true, false), state(false, true, true)]);
	});

	it("publish-failed is a cancellation only during an orderly close, never because of a successor", () => {
		expect(cancelled("publish-failed")).toEqual([state(false, true, false), state(false, true, true)]);
		expect(retainedPublicationCancelled("publish-failed", state(false, false, true))).toBe(false);
	});

	it("with no close, no successor and no terminal failure, every failure rejects", () => {
		for (const kind of KINDS) expect(retainedPublicationCancelled(kind, state(false, false, false))).toBe(false);
	});
});
