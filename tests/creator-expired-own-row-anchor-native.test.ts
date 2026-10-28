import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// Case A of fix/snapshot-stage-chain-invalid: a silent Writer's window-expired own rows never outlive
// the generations that cover their historical anchors.
//
// The Writer makes one move in each of its first epochs, none of which reach the creator, so each
// move is displaced, guarded by its own fence, and expires once it is V3_SETTLEMENT_OWN_WINDOW_EPOCHS
// old. It then misses several successors (offline), follows by one skip install, and installs every
// successor after that with a lull after each. The received-turnover census demands the historical
// anchor of every held expired row, and the native recovery certificate refuses
// RECOVERY_DEPENDENCY_ANCHOR_UNCOVERED for any anchor no retained generation (or its predecessor
// link) authenticates. Measured with traces: issuance retirement releases an expired row one install
// after it is resolved, while the retained cut that protects it drains, and AHE retires the old
// generations one install behind, so every demanded anchor stays covered. With adjacent installs the
// rows are released at age 5. Should retirement ever hold an expired row, this refuses: measured with
// a mutant that never retires an expired row, install 7 refuses at the census
// (outbox-classification) before the anchor law, with or without exempting its anchor.

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// Epochs the Writer moves in (installing each), then epochs it misses (offline: no install, no
// delivery), then adjacent installs after its skip install.
const MOVES = Number(process.env.EXPIRED_ANCHOR_MOVES ?? 8);
const SKIP = Number(process.env.EXPIRED_ANCHOR_SKIP ?? 6);
const TAIL = Number(process.env.EXPIRED_ANCHOR_TAIL ?? 8);
const EPOCHS = MOVES + SKIP + TAIL;

/**
 * An error's message, depth-bounded through its cause chain.
 * @param error - The error.
 * @param depth - The current depth.
 * @returns The explanation.
 */
const explain = (error: unknown, depth = 0): string => {
	if (!(error instanceof Error) || depth > 3) return String(error).slice(0, 400);
	return error.message.slice(0, 400) + (error.cause === undefined ? "" : ` <- ${explain(error.cause, depth + 1)}`);
};

it("a silent Writer whose own moves expire across a skip keeps certifying its recovery roles", async () => {
	const outcomes: { label: string; outcome: string }[] = [];
	const record = async (label: string, run: () => Promise<unknown>): Promise<boolean> => {
		try {
			await run();
			outcomes.push({ label, outcome: "ok" });
			return true;
		} catch (error) {
			outcomes.push({ label, outcome: `failed: ${explain(error)}` });
			return false;
		}
	};
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	let delivered: number | null = null;
	const deliverCreator = async (offline: boolean): Promise<void> => {
		const rows = await fixture.publishedAfter(0, delivered);
		for (let start = 0; start < rows.length && !offline; start += 16) {
			const chunk = rows.slice(start, start + 16);
			const last = chunk.findLastIndex((row) => !isControl(row));
			if (last >= 0) await writer.receive(chunk.slice(0, last + 1), 0);
			writer.inject(chunk.slice(last + 1), 0);
		}
		if (rows.length !== 0) delivered = required(rows.at(-1)).commit.authorSequence;
	};
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		const offline = epoch >= MOVES && epoch < MOVES + SKIP;
		// The Writer's move of this epoch, never delivered: the Writer is silent.
		if (
			epoch < MOVES &&
			!(await record(`writer-move-${epoch}`, () =>
				writer.room.issue({ action: "placeBlock", id: `silent-${epoch}`, kind: "gold", x: 9, y: epoch })
			))
		)
			break;
		await creator.room.issue({ action: "placeBlock", id: `creator-${epoch}`, kind: "stone", x: 1, y: epoch });
		// Until its skip install, the Writer is still at an older epoch: it cannot accept these rows.
		await deliverCreator(epoch >= MOVES && epoch <= MOVES + SKIP);
		await sleep(300);
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		if (offline) continue;
		if (
			!(await record(`writer-install-${epoch + 1}`, async () => {
				const transfer = await settlementDelivery(fixture as unknown as SettlementRoom);
				Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
				await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
				expect(writer.room.authority()?.epoch).toBe(epoch + 1);
			}))
		)
			break;
		if (!(await record(`writer-lull-after-install-${epoch + 1}`, () => writer.room.maintainRecoveryPool()))) break;
	}
	console.log(`EXPIRED_OWN_ROW_ANCHOR ${JSON.stringify(outcomes)}`);
	expect(
		outcomes.filter(({ outcome }) => outcome !== "ok"),
		JSON.stringify(outcomes)
	).toEqual([]);
	expect(writer.room.authority()?.epoch).toBe(EPOCHS);
}, 900_000);
