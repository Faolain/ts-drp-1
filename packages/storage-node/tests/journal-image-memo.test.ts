import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

import {
	beginJournalTransaction,
	journalImageCurrency,
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

	test("answers without a scan only for the exact recorded currency of committed rows", () => {
		const memo = new JournalRetirementImageMemo(2, 4096);
		const key = journalImageRowKey("scopes", row(1))!;
		const currency = Object.freeze({ dataVersion: 3, totalChanges: 7, schemaVersion: 2 });
		// Remembered without a currency (rows that were not committed): never answered unscanned.
		memo.remember("room", [key], image("a"), [Uint8Array.of(1)]);
		expect(memo.unchanged("room", false, currency)).toBeUndefined();
		// A scan of committed rows that matched records the currency.
		memo.touch("room", currency);
		expect(memo.unchanged("room", true, { ...currency })?.image.imageDigest).toBe("a");
		expect(memo.unchanged("room", false, undefined)).toBeUndefined();
		for (const moved of [{ dataVersion: 4 }, { totalChanges: 8 }, { schemaVersion: 3 }])
			expect(memo.unchanged("room", false, { ...currency, ...moved })).toBeUndefined();
		// A new capture replaces the old currency; one without a currency clears it.
		memo.remember("room", [key], image("b"), undefined, { ...currency, totalChanges: 9 });
		expect(memo.unchanged("room", false, currency)).toBeUndefined();
		expect(memo.unchanged("room", false, { ...currency, totalChanges: 9 })?.image.imageDigest).toBe("b");
		expect(memo.unchanged("room", true, { ...currency, totalChanges: 9 })).toBeUndefined();
		memo.remember("room", [key], image("c"), undefined);
		expect(memo.unchanged("room", false, { ...currency, totalChanges: 9 })).toBeUndefined();
		// Evicted objects take their currency with them.
		memo.remember("room", [key], image("d"), undefined, currency);
		memo.remember("other-1", [key], image("e"), undefined, currency);
		memo.remember("other-2", [key], image("f"), undefined, currency);
		expect(memo.unchanged("room", false, currency)).toBeUndefined();
		memo.remember("room", [key], image("g"), undefined);
		expect(memo.unchanged("room", false, currency)).toBeUndefined();
	});
});

describe("journal image connection currency", () => {
	test("is defined only for committed rows and moves with every own change, rollback, other commit and DDL", () => {
		const directory = mkdtempSync(join(tmpdir(), "ts-drp-journal-currency-"));
		const filename = join(directory, "currency.sqlite");
		const own = new DatabaseSync(filename), other = new DatabaseSync(filename);
		try {
			own.exec("PRAGMA journal_mode=WAL");
			own.exec("CREATE TABLE entries(n INTEGER)");
			own.exec("INSERT INTO entries VALUES(1)");
			// No transaction was begun through the recorder: nothing is known committed.
			own.exec("BEGIN");
			expect(journalImageCurrency(own)).toBeUndefined();
			own.exec("COMMIT");
			const committed = (): ReturnType<typeof journalImageCurrency> => {
				beginJournalTransaction(own, "BEGIN");
				try {
					return journalImageCurrency(own);
				} finally {
					own.exec("COMMIT");
				}
			};
			const first = committed()!;
			expect(first).toBeDefined();
			expect(committed()).toEqual(first);
			// An own uncommitted write: the visible rows could still roll back.
			beginJournalTransaction(own, "BEGIN IMMEDIATE");
			own.exec("INSERT INTO entries VALUES(2)");
			expect(journalImageCurrency(own)).toBeUndefined();
			own.exec("ROLLBACK");
			// The rolled-back write is still counted: the rows are the same, the currency is not.
			const afterRollback = committed()!;
			expect(afterRollback.totalChanges).toBeGreaterThan(first.totalChanges);
			// A write that commits moves the currency, inside and after its transaction.
			beginJournalTransaction(own, "BEGIN IMMEDIATE");
			own.exec("UPDATE entries SET n=3");
			expect(journalImageCurrency(own)).toBeUndefined();
			own.exec("COMMIT");
			const afterOwnCommit = committed()!;
			expect(afterOwnCommit.totalChanges).toBeGreaterThan(afterRollback.totalChanges);
			// Another connection's commit, before or during a transaction's snapshot.
			other.exec("UPDATE entries SET n=4");
			const afterOther = committed()!;
			expect(afterOther.dataVersion).not.toBe(afterOwnCommit.dataVersion);
			beginJournalTransaction(own, "BEGIN");
			const snapshot = journalImageCurrency(own)!;
			other.exec("UPDATE entries SET n=5");
			// Inside the transaction the snapshot (and its currency) holds; the next transaction sees the commit.
			expect(journalImageCurrency(own)).toEqual(snapshot);
			own.exec("COMMIT");
			expect(committed()!.dataVersion).not.toBe(snapshot.dataVersion);
			// DDL by another connection, and own uncommitted DDL (total_changes() counts neither).
			const beforeDdl = committed()!;
			other.exec("CREATE TABLE unrelated(x)");
			expect(committed()!.schemaVersion).not.toBe(beforeDdl.schemaVersion);
			beginJournalTransaction(own, "BEGIN IMMEDIATE");
			own.exec("CREATE TABLE own_unrelated(x)");
			expect(journalImageCurrency(own)).toBeUndefined();
			own.exec("ROLLBACK");
			// A connection's record never answers for another connection.
			other.exec("BEGIN");
			expect(journalImageCurrency(other)).toBeUndefined();
			other.exec("COMMIT");
		} finally {
			own.close();
			other.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
