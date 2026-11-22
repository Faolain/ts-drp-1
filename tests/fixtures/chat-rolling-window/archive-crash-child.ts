// Track W: a child process that appends to a Chat device archive (the shipped Node SQLite store)
// in batches and stops itself at a checkpoint inside one append transaction, so the parent can
// SIGKILL it there (the existing native IPC/SIGKILL pattern of
// tests/fixtures/r11-disposable-session-child.ts). The hook runs the real statement first and
// grants nothing.
//
// argv: <archive file> <checkpoint: before-commit | after-commit> <batch to stop in> <batch size> <max messages>
import { DatabaseSync } from "node:sqlite";

import { openShippingChatLocalArchive } from "../../../examples/chat/src/v3-chat-archive.js";
import { openNodeShippingChatArchiveStore } from "../../../examples/chat/src/v3-chat-archive-sqlite.js";

const [, , filename, checkpoint, stopBatchText, batchSizeText, maxMessagesText] = process.argv;
if (
	filename === undefined ||
	(checkpoint !== "before-commit" && checkpoint !== "after-commit") ||
	stopBatchText === undefined ||
	batchSizeText === undefined ||
	maxMessagesText === undefined
)
	throw new Error("CHAT_ARCHIVE_CRASH_ARGUMENTS_REQUIRED");
const stopBatch = Number(stopBatchText);
const batchSize = Number(batchSizeText);
const maxMessages = Number(maxMessagesText);
if (typeof process.send !== "function") throw new Error("CHAT_ARCHIVE_CRASH_IPC_REQUIRED");
const send = process.send.bind(process);

let batch = 0;
function stop(): never {
	send({ kind: "checkpoint", checkpoint, batch });
	process.kill(process.pid, "SIGSTOP");
	throw new Error("CHAT_ARCHIVE_CRASH_CHILD_MUST_NOT_RESUME");
}
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string): void {
	if (sql === "COMMIT" && batch === stopBatch && checkpoint === "before-commit") stop();
	originalExec.call(this, sql);
	if (sql === "COMMIT" && batch === stopBatch && checkpoint === "after-commit") stop();
};

const author = "d".repeat(64);
const archive = await openShippingChatLocalArchive({
	store: openNodeShippingChatArchiveStore(filename),
	bound: { maxMessages, maxBytes: 64 * 1024 * 1024 },
	schedule: () => undefined,
});
const window: { author: string; clientOperationId: string; displayTimeMs: number; text: string }[] = [];
for (batch = 1; ; batch++) {
	for (let index = 0; index < batchSize; index++)
		window.push({
			author,
			clientOperationId: `b${batch}-m${index}`,
			displayTimeMs: 1_791_662_400_000 + batch * 1000 + index,
			text: `batch ${batch} message ${index}`,
		});
	archive.observe({ messages: window.slice(-batchSize), epoch: batch });
	await archive.flush();
	send({ kind: "flushed", batch });
}
