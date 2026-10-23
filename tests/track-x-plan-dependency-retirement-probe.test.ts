import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { type ReadinessHoldPeer, readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// Track X probe for CONTRACT.md 3.6 (amendment A-1), a fact-finding test, not a RED. The issuance
// store refuses a retirement preparation that would retire a row named by a settlement plan that
// does not permit authenticated pruning ("issuance retirement unsettled plan dependency is
// unprotected", packages/issuance-store/src/retirement.ts assertIssuanceRetirementPreparationRows).
// The node's hole selection (creator-closed-rollback-data.ts closedIssuanceProtectedRecordsForRetirement)
// does not read plans. Question: when the store refuses, does the caller decline and keep the rows,
// or refuse the install (the received turnover) or the lull (maintainRecoveryPool)?
//
// The plan state is the one a late review leaves: a complete entry [m1 -> y1] (a move made during
// the seal of epoch 0, rebased at install 1), then a pending manual-review entry [m2] (a move made
// during the seal of epoch 2, after the Writer reopened with a manual-review policy for placeBlock:
// the displacement policy is the trusted local room policy, not signed; v3-room.ts
// localSettlementPolicy). The Writer then installs on, with a lull after each install in the "lull"
// variant. Every step's outcome, and each issuance hole selection the room reports, is printed as
// one JSON line prefixed "TRACK_X_A1". A third case uses a manual-review policy from the start, so
// the result is not an artefact of the reopen.
//
// What it records today (log r61-a1-probe-r2): the store's plan check is never reached. Earlier, the
// received-turnover census refuses the pending manual-review source ("creator recovery dependency
// hold unavailable:outbox-classification:<seq>:displaced:published") at the Writer's install of
// epoch 4, and again on every retry. In the lull case the lull refuses the same way first and halts
// the Writer's admission. Nothing here asserts that outcome; it only records it.

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An error's message with its cause chain and aggregated errors, depth-bounded.
 * @param error - The error.
 * @param depth - The current depth.
 * @returns The explanation.
 */
const explain = (error: unknown, depth = 0): unknown => {
	if (!(error instanceof Error) || depth > 4) return String(error).slice(0, 400);
	return {
		message: error.message.slice(0, 400),
		...(error.cause === undefined ? {} : { cause: explain(error.cause, depth + 1) }),
		...(error instanceof AggregateError ? { errors: error.errors.map((inner) => explain(inner, depth + 1)) } : {}),
	};
};

async function probe(variant: "install" | "lull", manualFromStart = false): Promise<void> {
	const name = `${variant}${manualFromStart ? "-manual-from-start" : ""}`;
	const log = (entry: Record<string, unknown>): void => console.log(`TRACK_X_A1 ${name} ${JSON.stringify(entry)}`);
	const manual = Object.freeze({ placeBlock: "manual-review" as const });
	const record = async <Value>(label: string, run: () => Promise<Value>): Promise<boolean> => {
		try {
			const value = await run();
			log({ label, ok: true, ...(value === undefined ? {} : { value }) });
			return true;
		} catch (error) {
			log({ label, ok: false, error: explain(error) });
			return false;
		}
	};
	Reflect.set(globalThis, "__warmProofEvent", (event: Record<string, unknown>) => {
		if (event.kind === "closed-retirement-issuance-holes" || event.kind === "closed-retirement-room-session")
			log({ event });
	});
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0);
	let writer: ReadinessHoldPeer = await fixture.open(1, manualFromStart ? { policies: manual } : {});
	const delivered: [number | null, number | null] = [null, null];
	// Control rows (fences) are never reported as admitted moves, so trailing ones are handed over
	// without waiting, as tests/fixtures/track-x/outside-rows-room.ts deliver() does.
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
	const plan = async (): Promise<unknown> => {
		const store = await fixture.host.storageHost.openIssuance("peer-1");
		try {
			const value = await store.readSettlementPlan({
				objectId: fixture.objectId,
				author: required(fixture.identities[1]).author,
			});
			return value === null
				? null
				: {
						revision: value.revision,
						fenceSequence: value.fenceSequence,
						entries: value.entries.map((entry) => [entry.sourceSequence, entry.disposition, entry.replacementSequence]),
					};
		} finally {
			await store.close();
		}
	};
	const rows = async (): Promise<number[]> =>
		(await fixture.publishedAfter(1, null)).map((row) => row.commit.authorSequence);
	const install = (epoch: number): Promise<boolean> =>
		record(`writer-install-${epoch}`, async () => {
			const transfer = await settlementDelivery(fixture as unknown as SettlementRoom);
			Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
			await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
			return writer.room.authority()?.epoch;
		});
	const rollover = async (epoch: number, during?: string): Promise<boolean> => {
		await creator.room.issue({ action: "placeBlock", id: `creator-${epoch}`, kind: "stone", x: 1, y: epoch });
		await record(`deliver-creator-${epoch}`, () => deliver(0));
		await sleep(300);
		const sealing = creator.room.sealEpoch();
		if (during !== undefined)
			await record(`writer-move-during-seal-${epoch}`, () =>
				writer.room.issue({ action: "placeBlock", id: during, kind: "gold", x: 9, y: epoch })
			);
		const sealed = await sealing;
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		if (during !== undefined) creator.inject(await fixture.publishedAfter(1, delivered[1]), 1);
		await creator.room.adoptCreatorSuccessor();
		const installed = await install(epoch + 1);
		await record(`writer-plan-after-install-${epoch + 1}`, plan);
		await record(`writer-rows-after-install-${epoch + 1}`, rows);
		if (installed) await record(`deliver-writer-${epoch + 1}`, () => deliver(1));
		if (variant === "lull" && installed)
			await record(`writer-lull-after-install-${epoch + 1}`, () => writer.room.maintainRecoveryPool());
		return installed;
	};

	await writer.room.issue({ action: "placeBlock", id: "writer-0", kind: "stone", x: 2, y: 1 });
	await deliver(1);
	let first = 2;
	if (manualFromStart) {
		// Control: the Writer's policy is manual-review from the start, so m1 itself is held for review.
		first = 0;
	} else {
		expect(await rollover(0, "m1"), "install 1 replaces m1 (rebase)").toBe(true);
		expect(await rollover(1), "install 2").toBe(true);
		// The late review: the Writer's room reopens with a manual-review policy for its next displaced move.
		await fixture.stop(writer);
		writer = await fixture.open(1, { reopen: true, policies: manual });
		await record("writer-reopened", async () => writer.room.authority()?.epoch);
	}
	for (let epoch = first; epoch < first + 7; epoch++) {
		const installed = await rollover(epoch, epoch === first ? (manualFromStart ? "m1" : "m2") : undefined);
		if (!installed) {
			await record(`writer-install-${epoch + 1}-retry`, async () => {
				const transfer = await settlementDelivery(fixture as unknown as SettlementRoom);
				Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
				await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
				return writer.room.authority()?.epoch;
			});
			break;
		}
	}
	await record("writer-authority", async () => writer.room.authority());
}

it(
	"records what the install path does when the store refuses a plan-named retirement",
	() => probe("install"),
	900_000
);
it("records what the lull path does when the store refuses a plan-named retirement", () => probe("lull"), 900_000);
it(
	"records the install path with a manual-review policy from the start (control: not an artefact of the reopen)",
	() => probe("install", true),
	900_000
);
