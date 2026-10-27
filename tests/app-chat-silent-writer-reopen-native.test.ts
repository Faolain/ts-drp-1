import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { chatSharesRoomFixture, closeChatSharesRooms } from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// PINNED DEFECT (pre-existing: c08d8680 refuses the same install with chain-invalid at
// RECOVERY_CERTIFICATE_STAGE:native-source:2). A silent Chat Writer (its network publishes nowhere)
// sends a message in every epoch, both peers close and reopen over the same stores, and the Writer,
// now idle, follows the creator's successors. The first install after the reopen succeeds; the second
// refuses "creator recovery dependency hold unavailable:outbox-classification:4:displaced:published".
// Measured: that install's retirement plan rewrite dropped the completed rebase entries of rows 4 and 5
// (retired by the control) while the rows themselves are still in the outbox, so the recovery census
// finds a displaced published row with no completion entry. Without the reopen (the same scenario
// continued in one process) six idle installs succeed. Found as the recovery half of the T9
// control-writer crash control; a clean close at the same point fails the same way, so the crash is
// not the cause. When this is fixed the test fails; make it assert every install succeeds.
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

it("pinned defect: a reopened silent Chat Writer refuses its second install (census: a retired, unpruned displaced row lost its completion entry)", async () => {
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
		expect(installed).toEqual([1]);
		expect(
			causes.some((cause) =>
				/creator recovery dependency hold unavailable:outbox-classification:\d+:displaced:published/.test(cause)
			)
		).toBe(true);
	} finally {
		expect(await closeChatSharesRooms()).toEqual([]);
	}
}, 900_000);
