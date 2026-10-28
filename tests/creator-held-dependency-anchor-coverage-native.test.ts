import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { type ReadinessHoldPeer, readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// A Writer whose own row stays held past the retained AHE generations still certifies its
// recovery roles.
//
// The received-turnover census (v3-live readCreatorRecoveryDependencyCensus) names the historical
// anchor of every held own row that is not terminally covered, retired or capsuled, bounded only by
// count (at most 7 anchors), not by age. The recovery certificate's native path
// (creator-closed-rollback-data acquireRecoveryRoleCertificate) requires every such anchor to be
// the trust of a retained native generation:
//   requiredDependencyAnchors.every(required => dependencyAnchors.some(actual => same epoch and digest))
// and AHE generation retirement keeps at most 7 generations (retiring above 5) without consulting
// those anchors. So once the row's epoch leaves the retained generations, every lull and install
// refuses "chain-invalid", labelled RECOVERY_CERTIFICATE_STAGE:<last stage of the source loop>,
// and the Writer can never install again.
//
// Here the held row is a move displaced during the seal of epoch 2 after the Writer reopened with a
// manual-review policy (the plan keeps [m2, manual-review]), so it is held indefinitely. The Writer
// installs and runs a lull after each install. Measured today: the lull after install 7 refuses
// (required anchors [2, 6, 7]; retained generation trusts [0, 3, 4, 5, 6, 7]), then install 8.

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

// Known defect (case B of fix/snapshot-stage-chain-invalid, residual after the predecessor-link fix):
// a manual-review row is replayable and held indefinitely, so its anchor outlives the retained
// generations; the lull after install 8 refuses RECOVERY_DEPENDENCY_ANCHOR_UNCOVERED:2. Protecting
// the covering generation refuses RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE instead. A fix needs a
// source capsule for review rows or a hand-back past the window. No shipped app uses manual review.
it.fails(
	"[known: manual-review rows outlive the retained generations; no shipped app uses manual review]",
	async () => {
		const manual = Object.freeze({ placeBlock: "manual-review" as const });
		const outcomes: { label: string; outcome: string }[] = [];
		const record = async <Value>(label: string, run: () => Promise<Value>): Promise<boolean> => {
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
		let writer: ReadinessHoldPeer = await fixture.open(1);
		const delivered: [number | null, number | null] = [null, null];
		const deliver = async (from: 0 | 1): Promise<void> => {
			const rows = await fixture.publishedAfter(from, delivered[from]);
			const to = from === 0 ? writer : creator;
			for (let start = 0; start < rows.length; start += 16) {
				const chunk = rows.slice(start, start + 16);
				const last = chunk.findLastIndex((row) => !isControl(row));
				if (last >= 0) await to.receive(chunk.slice(0, last + 1), from);
				to.inject(chunk.slice(last + 1), from);
			}
			if (rows.length !== 0) delivered[from] = required(rows.at(-1)).commit.authorSequence;
		};
		const install = (epoch: number): Promise<boolean> =>
			record(`writer-install-${epoch}`, async () => {
				const transfer = await settlementDelivery(fixture as unknown as SettlementRoom);
				Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
				await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
				expect(writer.room.authority()?.epoch).toBe(epoch);
			});
		const rollover = async (epoch: number, during?: string): Promise<boolean> => {
			await creator.room.issue({ action: "placeBlock", id: `creator-${epoch}`, kind: "stone", x: 1, y: epoch });
			await deliver(0);
			await sleep(300);
			const sealing = creator.room.sealEpoch();
			if (during !== undefined)
				await writer.room.issue({ action: "placeBlock", id: during, kind: "gold", x: 9, y: epoch });
			const sealed = await sealing;
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			if (during !== undefined) creator.inject(await fixture.publishedAfter(1, delivered[1]), 1);
			await creator.room.adoptCreatorSuccessor();
			if (!(await install(epoch + 1))) return false;
			// The held row never reaches the creator's admission; delivery is not what is judged here.
			await deliver(1).catch(() => undefined);
			return record(`writer-lull-after-install-${epoch + 1}`, () => writer.room.maintainRecoveryPool());
		};

		await writer.room.issue({ action: "placeBlock", id: "writer-0", kind: "stone", x: 2, y: 1 });
		await deliver(1);
		expect(await rollover(0, "m1"), JSON.stringify(outcomes)).toBe(true);
		expect(await rollover(1), JSON.stringify(outcomes)).toBe(true);
		await fixture.stop(writer);
		writer = await fixture.open(1, { reopen: true, policies: manual });
		for (let epoch = 2; epoch < 9; epoch++) if (!(await rollover(epoch, epoch === 2 ? "m2" : undefined))) break;
		console.log(`HELD_DEPENDENCY_COVERAGE ${JSON.stringify(outcomes)}`);
		expect(
			outcomes.filter(({ outcome }) => outcome !== "ok"),
			JSON.stringify(outcomes)
		).toEqual([]);
		expect(writer.room.authority()?.epoch).toBe(9);
	},
	900_000
);
