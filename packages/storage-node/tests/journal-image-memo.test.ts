import { describe, expect, test } from "vitest";

import {
	journalImageRowKey,
	journalImageRowMatches,
	JournalRetirementImageMemo,
} from "../src/internal/journal-image-memo.js";

// Row keys and bounds of the per-connection journal image memo. Store-level
// work counts and soundness live in journal-image-verify-once.test.ts.
describe("journal image memo keys and bounds", () => {
	const row = (sequence: number, digest = "a".repeat(64)) => ({ object_id: "room", epoch: 0, anchor_digest: digest,
		journal_sequence: sequence, received_preimage: Uint8Array.of(1, 2, sequence), local_author: null });
	const image = (digest: string) => Object.freeze({ imageDigest: digest, scopeCount: 1, rowCount: 1, byteCharge: 10 });

	test("keys copy blobs and match only identical tables, column orders and values", () => {
		const source = row(1), key = journalImageRowKey("accepted_entries", source)!;
		expect(journalImageRowMatches(key, "accepted_entries", row(1))).toBe(true);
		expect(journalImageRowMatches(key, "scopes", row(1))).toBe(false);
		expect(journalImageRowMatches(key, "accepted_entries", row(2))).toBe(false);
		expect(journalImageRowMatches(key, "accepted_entries", row(1, "b".repeat(64)))).toBe(false);
		const { local_author: _absent, ...shorter } = row(1);
		expect(journalImageRowMatches(key, "accepted_entries", shorter)).toBe(false);
		const { object_id, ...rest } = row(1);
		expect(journalImageRowMatches(key, "accepted_entries", { ...rest, object_id })).toBe(false);
		expect(journalImageRowMatches(key, "accepted_entries", { ...row(1), epoch: -0 })).toBe(false);
		expect(journalImageRowMatches(key, "accepted_entries", { ...row(1), epoch: "0" })).toBe(false);
		// The caller's carrier changes after keying: the key kept its own copy.
		source.received_preimage[0] = 9;
		expect(journalImageRowMatches(key, "accepted_entries", source)).toBe(false);
		expect(journalImageRowMatches(key, "accepted_entries", row(1))).toBe(true);
		// Only native SQLite scalars are keyable.
		expect(journalImageRowKey("scopes", { ...row(1), extra: { nested: true } })).toBeUndefined();
		expect(journalImageRowKey("scopes", { ...row(1), extra: new Uint16Array(2) })).toBeUndefined();
	});

	test("bounds remembered objects and bytes, and serves frames only when they were captured", () => {
		const memo = new JournalRetirementImageMemo(4, 4096);
		const key = journalImageRowKey("scopes", row(1))!;
		for (let object = 0; object < 6; object++) memo.remember(`room-${object}`, [key], image(`${object}`), [Uint8Array.of(object)]);
		expect(memo.size().objects).toBe(4);
		expect(memo.candidate("room-0", false)).toBeUndefined();
		expect(memo.candidate("room-5", true)?.image.imageDigest).toBe("5");
		// Refreshing an old object keeps it over newer ones.
		memo.touch("room-2");
		memo.remember("room-6", [key], image("6"), undefined);
		expect(memo.candidate("room-2", false)).toBeDefined();
		expect(memo.candidate("room-3", false)).toBeUndefined();
		// An image captured without frames never answers a capture that needs them.
		expect(memo.candidate("room-6", false)?.image.imageDigest).toBe("6");
		expect(memo.candidate("room-6", true)).toBeUndefined();
		// A capture larger than the byte bound is never retained, and evicts nothing.
		const huge = journalImageRowKey("scopes", { ...row(1), blob: new Uint8Array(8192) })!;
		memo.remember("room-7", [huge], image("7"), undefined);
		expect(memo.candidate("room-7", false)).toBeUndefined();
		expect(memo.size().objects).toBe(4);
		// Retained frames are private copies.
		const frame = Uint8Array.of(1, 2, 3);
		memo.remember("room-8", [key], image("8"), [frame]);
		frame.fill(0);
		expect([...memo.candidate("room-8", true)!.frames![0]!]).toEqual([1, 2, 3]);
		expect(memo.size().bytes).toBeLessThanOrEqual(4096);
	});
});
