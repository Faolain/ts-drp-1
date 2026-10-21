import { encodeCanonical } from "@ts-drp/canonical";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

import {
	openBrowserShippingChatArchiveStore,
	openShippingChatLocalArchive,
	SHIPPING_CHAT_ARCHIVE_DEFAULT_BOUND,
	shippingChatArchiveDatabaseName,
	type ShippingChatArchiveStore,
	shippingChatHistory,
} from "../examples/chat/src/v3-chat-archive.js";
import { openNodeShippingChatArchiveStore } from "../examples/chat/src/v3-chat-archive-sqlite.js";
import type { ShippingChatMessage } from "../examples/chat/src/v3-chat-message.js";

// Track W: the Chat device archive. Each device keeps the messages its room projection has shown
// in its own store, outside room storage, bounded, written after the projection callback in a
// later task, never read by the room. Stored bytes are untrusted and only displayed.

const directories: string[] = [];
afterAll(() => {
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
function temporary(): string {
	const directory = mkdtempSync(join(tmpdir(), "chat-local-archive-"));
	directories.push(directory);
	return directory;
}
const A = "a".repeat(64);
const B = "b".repeat(64);
const T = 1_791_662_400_000;
const message = (author: string, id: string, text = `text of ${id}`, time = T): ShippingChatMessage =>
	Object.freeze({ author, clientOperationId: id, displayTimeMs: time, text });
const identity = (value: Readonly<{ author: string; clientOperationId: string }>) =>
	`${value.author}\u0000${value.clientOperationId}`;
const size = (value: ShippingChatMessage) => encodeCanonical(value).byteLength;

/** Counts the store's transactions; forwards everything unchanged. */
function counted(store: ShippingChatArchiveStore) {
	const calls = { load: 0, commit: 0 };
	const wrapped: ShippingChatArchiveStore = {
		load: () => {
			calls.load++;
			return store.load();
		},
		commit: (append, remove) => {
			calls.commit++;
			return store.commit(append, remove);
		},
		close: () => store.close(),
	};
	return { store: wrapped, calls };
}

describe("Track W: Chat's device archive", () => {
	it("records each message the projection shows once, in the order first seen, with that projection's epoch", async () => {
		const file = join(temporary(), "archive.sqlite");
		const archive = await openShippingChatLocalArchive({ store: openNodeShippingChatArchiveStore(file) });
		const [m1, m2, m3] = [message(A, "one"), message(B, "two"), message(A, "three")];
		archive.observe({ messages: [m1, m2], epoch: 3 });
		await archive.flush();
		// m1 left the window; the archive keeps it.
		archive.observe({ messages: [m2, m3], epoch: 4 });
		await archive.flush();
		expect(archive.records().map((row) => [identity(row), row.epoch])).toEqual([
			[identity(m1), 3],
			[identity(m2), 3],
			[identity(m3), 4],
		]);
		expect(archive.records().map((row) => row.text)).toEqual([m1.text, m2.text, m3.text]);
		expect(archive.stats()).toMatchObject({ messages: 3, bytes: size(m1) + size(m2) + size(m3) });
		await archive.close();
	});

	it("observing does no store work and reads no message until a later task, and one flush is one transaction", async () => {
		const { store, calls } = counted(openNodeShippingChatArchiveStore(join(temporary(), "archive.sqlite")));
		const archive = await openShippingChatLocalArchive({ store });
		expect(calls).toEqual({ load: 1, commit: 0 });
		let reads = 0;
		const rows = [message(A, "one"), message(A, "two")];
		const projection = {
			epoch: 1,
			get messages() {
				reads++;
				return rows;
			},
		};
		for (let index = 0; index < 100; index++) archive.observe(projection);
		expect({ reads, commits: calls.commit }).toEqual({ reads: 0, commits: 0 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await archive.flush();
		expect(calls.commit).toBe(1);
		expect(archive.records()).toHaveLength(2);
		// Nothing new: no transaction.
		archive.observe(projection);
		await archive.flush();
		expect(calls.commit).toBe(1);
		await archive.close();
	});

	it("keeps its bound by count and by bytes, dropping the oldest first; the default is 2,000 messages or 1 MiB", async () => {
		expect(SHIPPING_CHAT_ARCHIVE_DEFAULT_BOUND).toEqual({ maxMessages: 2000, maxBytes: 1_048_576 });
		const rows = Array.from({ length: 8 }, (_, index) => message(A, `m-${index}`, "same length text"));
		const byCount = await openShippingChatLocalArchive({
			store: openNodeShippingChatArchiveStore(join(temporary(), "count.sqlite")),
			bound: { maxMessages: 5, maxBytes: 1_048_576 },
		});
		for (const row of rows) byCount.observe({ messages: [row], epoch: 1 });
		await byCount.flush();
		expect(byCount.records().map(identity)).toEqual(rows.slice(3).map(identity));
		await byCount.close();
		const byBytes = await openShippingChatLocalArchive({
			store: openNodeShippingChatArchiveStore(join(temporary(), "bytes.sqlite")),
			bound: { maxMessages: 100, maxBytes: 3 * size(rows[0]!) },
		});
		for (const row of rows) {
			byBytes.observe({ messages: [row], epoch: 1 });
			await byBytes.flush();
		}
		expect(byBytes.records().map(identity)).toEqual(rows.slice(5).map(identity));
		expect(byBytes.stats().bytes).toBe(3 * size(rows[0]!));
		await byBytes.close();
	});

	it("survives a reopen on the Node SQLite store and on the IndexedDB store, and keeps counting on", async () => {
		await import("fake-indexeddb/auto");
		const file = join(temporary(), "archive.sqlite");
		const name = shippingChatArchiveDatabaseName("creator:reopen-object", A);
		const stores = [
			() => openNodeShippingChatArchiveStore(file),
			() => openBrowserShippingChatArchiveStore(name),
		] as const;
		for (const open of stores) {
			const first = await openShippingChatLocalArchive({ store: await open() });
			first.observe({ messages: [message(A, "one"), message(B, "two")], epoch: 5 });
			await first.close();
			const second = await openShippingChatLocalArchive({ store: await open() });
			expect(second.records().map((row) => [identity(row), row.epoch, row.seq])).toEqual([
				[identity(message(A, "one")), 5, 1],
				[identity(message(B, "two")), 5, 2],
			]);
			second.observe({ messages: [message(B, "two"), message(A, "three")], epoch: 6 });
			await second.flush();
			expect(second.records().map((row) => [identity(row), row.seq])).toEqual([
				[identity(message(A, "one")), 1],
				[identity(message(B, "two")), 2],
				[identity(message(A, "three")), 3],
			]);
			await second.close();
		}
	});

	it("discarding (a crash) loses only unwritten work; the next projection writes it again", async () => {
		const file = join(temporary(), "archive.sqlite");
		const archive = await openShippingChatLocalArchive({
			store: openNodeShippingChatArchiveStore(file),
			schedule: () => undefined,
		});
		archive.observe({ messages: [message(A, "kept")], epoch: 1 });
		await archive.flush();
		archive.observe({ messages: [message(A, "kept"), message(A, "admitted")], epoch: 1 });
		await archive.discard();
		const reopened = await openShippingChatLocalArchive({ store: openNodeShippingChatArchiveStore(file) });
		expect(reopened.records().map(identity)).toEqual([identity(message(A, "kept"))]);
		reopened.observe({ messages: [message(A, "kept"), message(A, "admitted")], epoch: 1 });
		await reopened.flush();
		expect(reopened.records().map(identity)).toEqual([identity(message(A, "kept")), identity(message(A, "admitted"))]);
		await reopened.close();
	});

	it("treats stored bytes as untrusted: a tampered or malformed row is dropped on load, never shown", async () => {
		const file = join(temporary(), "archive.sqlite");
		const archive = await openShippingChatLocalArchive({ store: openNodeShippingChatArchiveStore(file) });
		archive.observe({ messages: [message(A, "one"), message(A, "two"), message(A, "three")], epoch: 1 });
		await archive.close();
		const database = new DatabaseSync(file);
		try {
			// A changed text under the original key, and a row that is not a message at all.
			const tampered = encodeCanonical(message(A, "two", "something else"));
			database.prepare("UPDATE messages SET record=? WHERE seq=2").run(tampered);
			database.prepare("UPDATE messages SET record=? WHERE seq=3").run(new Uint8Array([0xff, 0x00]));
		} finally {
			database.close();
		}
		const reopened = await openShippingChatLocalArchive({ store: openNodeShippingChatArchiveStore(file) });
		expect(reopened.records().map(identity)).toEqual([identity(message(A, "one"))]);
		await reopened.close();
		const check = new DatabaseSync(file, { readOnly: true });
		try {
			expect(
				check
					.prepare("SELECT seq FROM messages ORDER BY seq")
					.all()
					.map((row) => Number(row.seq))
			).toEqual([1]);
		} finally {
			check.close();
		}
	});

	it("shows the window and the archive as one history, each message once, the window's copy first", () => {
		const one = message(A, "one", "one", T + 1);
		const two = message(B, "two", "two", T + 2);
		const three = message(A, "three", "three", T);
		const history = shippingChatHistory(
			[two, three],
			[
				{ ...one, key: "k1", seq: 1, epoch: 1, bytes: size(one) },
				{ ...two, key: "k2", seq: 2, epoch: 1, bytes: size(two) },
			]
		);
		expect(history.map(identity)).toEqual([three, one, two].map(identity));
		expect(history.map((row) => row.inWindow)).toEqual([true, false, true]);
	});

	it("lives in its own database, never a room database", () => {
		const name = shippingChatArchiveDatabaseName("creator:object", A);
		expect(name).toMatch(/^ts-drp-chat-archive-v1--[0-9a-f]{64}$/u);
		expect(name.startsWith("ts-drp-v3-chat--")).toBe(false);
		expect(shippingChatArchiveDatabaseName("creator:object", B)).not.toBe(name);
	});

	it.each(["before-commit", "after-commit"] as const)(
		"a SIGKILL %s of an append leaves the old or the new archive, never part of one",
		async (checkpoint) => {
			const file = join(temporary(), "archive.sqlite");
			const stopBatch = 4;
			const batchSize = 25;
			const maxMessages = 60;
			const killed = await new Promise<{ signal: NodeJS.Signals | null; reached: boolean; stderr: string }>(
				(accept, reject) => {
					const child = spawn(
						process.execPath,
						[
							"--import",
							"tsx",
							new URL("./fixtures/chat-rolling-window/archive-crash-child.ts", import.meta.url).pathname,
							file,
							checkpoint,
							String(stopBatch),
							String(batchSize),
							String(maxMessages),
						],
						{ stdio: ["ignore", "ignore", "pipe", "ipc"] }
					);
					let reached = false;
					let stderr = "";
					const watchdog = setTimeout(() => child.kill("SIGKILL"), 60_000);
					child.stderr?.setEncoding("utf8");
					child.stderr?.on("data", (value: string) => {
						stderr += value;
					});
					child.on("message", (value: { kind?: string; batch?: number }) => {
						if (value.kind === "checkpoint" && value.batch === stopBatch) {
							reached = true;
							child.kill("SIGKILL");
						}
					});
					child.once("error", (error) => {
						clearTimeout(watchdog);
						reject(error);
					});
					child.once("close", (_code, signal) => {
						clearTimeout(watchdog);
						accept({ signal, reached, stderr });
					});
				}
			);
			expect(killed, killed.stderr).toMatchObject({ signal: "SIGKILL", reached: true });
			const archive = await openShippingChatLocalArchive({
				store: openNodeShippingChatArchiveStore(file),
				bound: { maxMessages, maxBytes: 64 * 1024 * 1024 },
			});
			const ids = archive.records().map((row) => row.clientOperationId);
			const lastBatch = checkpoint === "before-commit" ? stopBatch - 1 : stopBatch;
			const written = Array.from({ length: lastBatch }, (_, batch) =>
				Array.from({ length: batchSize }, (__, index) => `b${batch + 1}-m${index}`)
			).flat();
			// Old XOR new: exactly the newest `maxMessages` of the committed batches, in order.
			expect(ids).toEqual(written.slice(-maxMessages));
			const seqs = archive.records().map((row) => row.seq);
			expect(seqs).toEqual(seqs.map((_, index) => required(seqs[0]) + index));
			await archive.close();
		},
		120_000
	);
});

function required<Value>(value: Value | undefined): Value {
	if (value === undefined) throw new TypeError("CHAT_ARCHIVE_REQUIRED");
	return value;
}
