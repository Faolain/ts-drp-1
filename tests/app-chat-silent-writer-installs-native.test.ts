import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// The Chat (window format) sibling of app-rollover-silent-writer-catchup-native.test.ts. A Writer whose
// rows never reach the creator (its network publishes nowhere) sends a message in every epoch and
// follows each epoch by installing the creator's successor. On c08d8680 its eighth install refused
// with chain-invalid at RECOVERY_CERTIFICATE_STAGE:native-source-snapshot:6 (one protected journal
// scope per silent epoch). Within the settlement window it must keep installing every epoch, report
// that its rows are not reaching the host, and hand its old messages back instead of holding them.
const SEALS = 9;
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

it("a silent Chat Writer that sends every epoch keeps installing every successor", async () => {
	const directory = mkdtempSync(join(tmpdir(), "app-chat-silent-writer-"));
	directories.push(directory);
	try {
		const f = await chatSharesRoomFixture({
			directory,
			members: ["genesis"],
			format: "window",
			localMembers: [1],
			genesisStateBytes: createShippingChatWindowGenesisStateBytes,
		});
		const creator = await f.open(0),
			member = await f.open(1);
		const installed: number[] = [];
		for (let seal = 0; seal < SEALS; seal++) {
			await member.room.issue(message(`writer-${seal}`)).catch(() => undefined);
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			try {
				await f.install(member);
			} catch (error) {
				throw new Error(`install ${seal + 1} refused after ${JSON.stringify(installed)}: ${String(error)}`, {
					cause: error,
				});
			}
			installed.push(seal + 1);
		}
		const settlement = required(member.room.settlementStatus?.());
		process.stdout.write(`CHAT_SILENT_WRITER ${JSON.stringify({ installed, settlement })}\n`);
		expect(installed).toHaveLength(SEALS);
		expect(settlement.unsettledEpochs).toBeLessThanOrEqual(settlement.window);
		// Messages older than the window were handed back, not held.
		expect(settlement.undelivered.length).toBeGreaterThan(0);
	} finally {
		expect(await closeChatSharesRooms()).toEqual([]);
	}
}, 900_000);
