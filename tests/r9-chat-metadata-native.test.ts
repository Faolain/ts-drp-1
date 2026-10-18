/* eslint-disable @typescript-eslint/explicit-function-return-type -- Existing native fixture signatures are inferred without new adapters. */
import { compareBytes, encodeCanonical } from "@ts-drp/canonical";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
	captureShippingChatOperation,
	createShippingChatAdmissionPolicy,
	restoreShippingChatState,
	SHIPPING_CHAT_STATE_LIMITS,
	shippingChatCanonicalStateBytes,
} from "../examples/chat/src/v3-chat-application.js";

const alice = "a".repeat(64),
	bob = "b".repeat(64);
const send = (id = "immutable-1", text = "棋 ♟ café", displayTimeMs = 1791662400000) =>
	Object.freeze({ action: "message" as const, clientOperationId: id, displayTimeMs, text });
const entry = (author = alice, operation = send()) =>
	Object.freeze({
		author,
		clientOperationId: operation.clientOperationId,
		displayTimeMs: operation.displayTimeMs,
		text: operation.text,
	});

describe("shipping Chat metadata/identity narrow native component", () => {
	it("captures immutable ID/time/text once and rejects a supplied or forged sender field", () => {
		const caller = { ...send() };
		const captured = captureShippingChatOperation(caller, alice);
		caller.text = "mutated";
		caller.displayTimeMs++;
		expect(captured).toEqual(send());
		expect(Object.isFrozen(captured)).toBe(true);
		expect(() => captureShippingChatOperation({ ...send(), author: bob }, alice)).toThrow();
		expect(() => captureShippingChatOperation(send(), "peer-id-is-not-wire-authority")).toThrow();
	});
	it("exact retries reserve under authenticated author; conflicting immutable fields refuse before commit", () => {
		const policy = createShippingChatAdmissionPolicy();
		const first = policy.reserve(send(), { author: alice });
		expect(first.kind).toBe("fresh");
		if (first.kind !== "fresh") throw new TypeError("expected reservation");
		first.commit();
		first.release();
		const retry = policy.reserve(send(), { author: alice });
		expect(retry.kind).toBe("fresh");
		if (retry.kind === "fresh") {
			retry.commit();
			retry.release();
		}
		expect(policy.reserve(send("immutable-1", "changed"), { author: alice }).kind).toBe("conflict");
		expect(policy.reserve(send("immutable-1", "棋 ♟ café", 1791662400001), { author: alice }).kind).toBe("conflict");
		expect(policy.reserve(send(), { author: bob }).kind).toBe("fresh");
		expect(policy.reserve(send()).kind).toBe("rejected");
	});
	it("joins reservations: releasing one exact retry cannot release another's retained identity", () => {
		const policy = createShippingChatAdmissionPolicy();
		const first = policy.reserve(send(), { author: alice }),
			second = policy.reserve(send(), { author: alice });
		if (first.kind !== "fresh" || second.kind !== "fresh") throw new TypeError("expected reservations");
		first.release();
		expect(policy.reserve(send("immutable-1", "changed"), { author: alice }).kind).toBe("conflict");
		second.release();
		expect(policy.reserve(send("immutable-1", "changed"), { author: alice }).kind).toBe("fresh");
		expect(() => first.commit()).toThrow("released");
	});
	it("persists exact complete sender/time/identity/text bytes in SQLite and seeds cold retry independently", () => {
		const directory = mkdtempSync(join(tmpdir(), "shipping-chat-metadata-"));
		let db: DatabaseSync | undefined;
		try {
			const filename = join(directory, "native.sqlite");
			db = new DatabaseSync(filename);
			db.exec("CREATE TABLE snapshot (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL)");
			const state = [entry(alice), entry(bob)];
			const exactBytes = shippingChatCanonicalStateBytes(state);
			db.prepare("INSERT INTO snapshot (id, bytes) VALUES (?, ?)").run(1, exactBytes);
			db.close();
			db = new DatabaseSync(filename, { readOnly: true });
			const row = db.prepare("SELECT bytes FROM snapshot WHERE id = ?").get(1);
			if (!(row?.bytes instanceof Uint8Array)) throw new TypeError("native snapshot missing");
			expect(compareBytes(row.bytes, exactBytes)).toBe(0);
			expect(restoreShippingChatState(row.bytes)).toEqual(state);
			const policy = createShippingChatAdmissionPolicy({ authenticatedApplicationStateBytes: row.bytes });
			expect(policy.reserve(send(), { author: alice }).kind).toBe("fresh");
			expect(policy.reserve(send("immutable-1", "changed"), { author: alice }).kind).toBe("conflict");
			expect(policy.reserve(send("independent-2"), { author: alice }).kind).toBe("fresh");
			// Valid old sender in an authenticated snapshot grants no ordinary
			// caller the ability to supply that sender in a target command.
			expect(policy.reserve({ ...send(), author: alice }, { author: bob }).kind).toBe("rejected");
		} finally {
			db?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("charges actual UTF-8 plus canonical sender/time/identity framing at the exact retained byte ceiling", () => {
		let low = 0,
			high = SHIPPING_CHAT_STATE_LIMITS.maxBytes;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			try {
				captureShippingChatOperation(send("limit", "x".repeat(middle)), alice);
				low = middle;
			} catch {
				high = middle - 1;
			}
		}
		const exact = send("limit", "x".repeat(low));
		expect(shippingChatCanonicalStateBytes([entry(alice, exact)]).byteLength).toBe(32768);
		expect(captureShippingChatOperation(exact, alice)).toEqual(exact);
		expect(() => captureShippingChatOperation(send("limit", "x".repeat(low + 1)), alice)).toThrow();
		expect(() => captureShippingChatOperation(send("limit", "棋".repeat(low)), alice)).toThrow();
		expect(
			createShippingChatAdmissionPolicy().reserve(send("limit", "x".repeat(low + 1)), { author: alice }).kind
		).toBe("rejected");
		expect(encodeCanonical([entry(alice, send("limit", "x".repeat(low + 1)))]).byteLength).toBe(32769);
	});
	it("rejects duplicate/conflicting snapshot identities, noncanonical order and unrecognized metadata", () => {
		expect(() => shippingChatCanonicalStateBytes([entry(), entry()])).toThrow();
		expect(() => shippingChatCanonicalStateBytes([entry(bob), entry(alice)])).toThrow();
		expect(() => shippingChatCanonicalStateBytes([{ ...entry(), transportPeerId: "untrusted" }])).toThrow();
	});
	it("reserves batches atomically with exact metadata; a later conflicting entry cannot retain the first", () => {
		const policy = createShippingChatAdmissionPolicy();
		const batch = Object.freeze({
			action: "applicationBatch",
			batch: {
				version: 1,
				entries: [
					{ logicalTime: 1, operation: send() },
					{ logicalTime: 2, operation: send("immutable-1", "changed") },
				],
			},
		});
		expect(policy.reserve(batch, { author: alice }).kind).toBe("conflict");
		expect(policy.reserve(send("immutable-1", "changed"), { author: alice }).kind).toBe("fresh");
	});
	it("bounds the complete batch output before effects even when large exact retries would retain only one message", () => {
		const operation = send("large-exact-retry", "x".repeat(17_000));
		expect(() => captureShippingChatOperation(operation, alice)).not.toThrow();
		const batch = {
			action: "applicationBatch",
			batch: {
				version: 1,
				entries: [
					{ logicalTime: 1, operation },
					{ logicalTime: 2, operation },
				],
			},
		};
		expect(encodeCanonical(batch).byteLength).toBeLessThan(65_536);
		expect(encodeCanonical([entry(alice, operation), entry(alice, operation)]).byteLength).toBeGreaterThan(32_768);
		const policy = createShippingChatAdmissionPolicy();
		expect(policy.reserve(batch, { author: alice }).kind).toBe("rejected");
		expect(policy.reserve(send("large-exact-retry", "different later command"), { author: alice }).kind).toBe("fresh");
	});
});
