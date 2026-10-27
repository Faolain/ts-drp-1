import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { chatSharesRoomFixture, closeChatSharesRooms } from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// A silent Chat Writer (its network publishes nowhere) sends a message in every epoch, both peers close
// and reopen over the same stores, and the Writer, now idle, follows the creator's successors. Every
// install after the reopen must succeed. On 1cc69f5d the second refused "creator recovery dependency
// hold unavailable:outbox-classification:4:displaced:published": that install's retirement plan rewrite
// dropped the completed rebase entries of rows 4 and 5 (retired by the control) while the rows were
// still in the outbox, so the recovery census found a displaced published row with no completion
// entry. c08d8680 refused the same install with chain-invalid at RECOVERY_CERTIFICATE_STAGE:native-source:2.
// The Chromium FPS gate's Grid member refused the same way (outbox-classification:34:displaced:published).
const SEALS = Number(process.env.CHAT_REOPEN_SEALS ?? 5);
const AFTER = 6;
const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("a reopened silent Chat Writer keeps installing every successor", async () => {
	const directory = mkdtempSync(join(tmpdir(), "app-chat-silent-reopen-"));
	directories.push(directory);
	const fixture = (localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
		chatSharesRoomFixture({
			directory,
			members: ["genesis"],
			format: "window",
			localMembers: [1],
			...(localSelectors === undefined ? {} : { localSelectors }),
			genesisStateBytes: createShippingChatWindowGenesisStateBytes,
		});
	let selectors: Readonly<Record<number, { slot: number; incarnation: number }>>;
	try {
		const f = await fixture();
		const creator = await f.open(0),
			member = await f.open(1);
		for (let seal = 0; seal < SEALS; seal++) {
			await member.room.issue(message(`writer-${seal}`)).catch(() => undefined);
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			await f.install(member);
		}
		selectors = f.localSelectors;
	} finally {
		expect(await closeChatSharesRooms()).toEqual([]);
	}
	try {
		const f = await fixture(selectors);
		const creator = await f.open(0, { reopen: true }),
			member = await f.open(1, { reopen: true });
		const installed: number[] = [];
		let refused: unknown;
		for (let seal = 0; seal < AFTER && refused === undefined; seal++) {
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			try {
				await f.install(member);
				installed.push(seal + 1);
			} catch (error) {
				refused = error;
			}
		}
		const causes: string[] = [];
		for (let value: unknown = refused; value instanceof Error && causes.length < 10; value = value.cause)
			causes.push(String(value.message));
		process.stdout.write(`CHAT_SILENT_REOPEN ${JSON.stringify({ installed, causes })}\n`);
		expect(causes).toEqual([]);
		expect(installed).toEqual(Array.from({ length: AFTER }, (_, index) => index + 1));
	} finally {
		expect(await closeChatSharesRooms()).toEqual([]);
	}
}, 900_000);
