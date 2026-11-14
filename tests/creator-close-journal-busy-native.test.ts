import { encodeCanonical } from "@ts-drp/canonical";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	acquireCreatorForwardPromotionSource,
	resolveCreatorForwardPromotionSource,
} from "../packages/node/src/internal/creator-closed-rollback-data.js";
import { closeFixtures, installEnvironment, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementRoom, settlementTransition } from "./fixtures/track-m/settlement-room.js";

// The creator's live journal has ONE native read reservation. A close's recovery and
// promotion sources take it; so does a received append's custody, before the creator's
// maintenance consumer admits or refuses the append.
// 1. A source acquisition that meets the reservation held by someone else refuses with a
//    typed retryable kind, not internal-invariant: busy is contention, not a broken law.
// 2. A received move refused while the creator's close runs is retained; the retained row's
//    drain must not take the journal reservation while the close is sealing, so the close's
//    source acquisition does not meet it. A test-only hook (globalThis.__replacementCustodyHold,
//    inside the replacement custody once it holds the store and journal reservations) holds the
//    Writer's move while the seal starts, so the creator's consumer meets the close; a second
//    custody (the refusal's drain, queued behind the close's stage) is held until the seal settles.
// Mechanism evidence on fake-indexeddb (Track M's settlement room, creator-trusted-settlement-v1).

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let restore: (() => void) | undefined;
beforeEach(() => {
	restore = installEnvironment(() => undefined);
});
afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__replacementCustodyHold");
	restore?.();
	expect(await closeFixtures()).toEqual([]);
});

it("a closed-data source that meets the live journal's held native read reservation refuses source-busy, not internal-invariant", async () => {
	const fixture = await settlementRoom({ retention: false, name: "journal-busy-typed" });
	const peers = [await fixture.open(0), await fixture.open(1)] as const;
	const delivered: (number | null)[] = [null, null];
	for (let epoch = 0; epoch < 3; epoch++) await settlementTransition(fixture, peers, delivered, epoch);
	const invite = fixture.invite;
	const store = await fixture.host.storageHost.openAhe("peer-0--ahe");
	const snapshotStore = await fixture.host.storageHost.openSnapshots("peer-0");
	const liveJournalStore = await fixture.host.storageHost.openJournal("peer-0");
	try {
		const context = {
			objectId: fixture.objectId,
			pinnedGenesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
			exactCanonicalPinnedGenesisTrustStateRecordBytes: encodeCanonical({
				kind: "drp-anchor-trust-state",
				version: 1,
				objectId: fixture.objectId,
				genesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
				currentAnchorDigest: invite.pinnedGenesisAnchorDigest,
				currentEpoch: 0,
				profileId: "creator-trusted-settlement-v1",
				quorum: 1,
				exactCanonicalCurrentAnchorPreimageBytes: invite.exactCanonicalGenesisAnchorPreimageBytes,
				detachedCurrentAnchorSignature: invite.detachedGenesisSignature,
				exactCanonicalProfileBytes: invite.exactCanonicalProfileBytes,
				exactCanonicalSignerSetBytes: invite.exactCanonicalSignerSetBytes,
			}),
			roomHeadAuthority: peers[0].floor,
			catalog: fixture.application.catalog,
			store,
			snapshotStore,
			liveJournalStore,
		} as unknown as Parameters<typeof acquireCreatorForwardPromotionSource>[0];
		// The creator's plane is at epoch 3; its close would take the closed epoch 2.
		const closedEpoch = 2;
		// Control: the same acquisition with the reservation free authenticates the source.
		const control = await acquireCreatorForwardPromotionSource(context, closedEpoch, { sealed: true });
		expect(control.ok, JSON.stringify(control)).toBe(true);
		if (control.ok) await required(resolveCreatorForwardPromotionSource(control.observation, store as never, snapshotStore as never)).release();
		// Another holder has this journal owner's one native read reservation.
		const reserve = Reflect.get(liveJournalStore, "acquireNativeReadReservation") as (
			input: Readonly<{ objectId: string }>
		) => Promise<Readonly<{ release(): Promise<void> }>>;
		const held = await Reflect.apply(reserve, liveJournalStore, [{ objectId: fixture.objectId }]);
		let refused: unknown;
		try {
			refused = await acquireCreatorForwardPromotionSource(context, closedEpoch, { sealed: true });
		} finally {
			await held.release();
		}
		process.stdout.write(`CLOSED_DATA_BUSY ${JSON.stringify(refused)}\n`);
		expect(refused).toEqual({ ok: false, kind: "source-busy" });
		// Contention only: with the holder gone, the same acquisition succeeds again.
		const retried = await acquireCreatorForwardPromotionSource(context, closedEpoch, { sealed: true });
		expect(retried.ok, JSON.stringify(retried)).toBe(true);
		if (retried.ok) await required(resolveCreatorForwardPromotionSource(retried.observation, store as never, snapshotStore as never)).release();
	} finally {
		await liveJournalStore.close();
		await snapshotStore.close();
		await store.close();
	}
}, 600_000);

it("a received move refused while the creator's close seals is retained without its drain holding the journal across the close's source acquisition", async () => {
	const fixture = await settlementRoom({ retention: false, name: "journal-busy-order" });
	const peers = [await fixture.open(0), await fixture.open(1)] as const;
	const [creator, writer] = peers;
	const delivered: (number | null)[] = [null, null];
	for (let epoch = 0; epoch < 2; epoch++) await settlementTransition(fixture, peers, delivered, epoch);
	const epoch = 2;
	// One ordinary creator move delivered to the Writer, then the Writer's move.
	await creator.room.issue({ action: "placeBlock", id: "block-0-busy", kind: "stone", x: epoch, y: 0 });
	const creatorRows = await fixture.publishedAfter(0, delivered[0] ?? null);
	await writer.receive(creatorRows, 0);
	delivered[0] = required(creatorRows.at(-1)).commit.authorSequence;
	await writer.room.issue({ action: "placeBlock", id: "block-1-busy", kind: "stone", x: epoch, y: 1 });
	const writerRows = await fixture.publishedAfter(1, delivered[1] ?? null);
	let holds = 0;
	let sealing: Promise<unknown> | undefined;
	let sealFailure: unknown;
	let sealed: unknown;
	Reflect.set(globalThis, "__replacementCustodyHold", async () => {
		holds++;
		if (holds === 1) {
			// The Writer's move holds its custody; the creator's seal starts now. Its close shuts
			// the maintenance consumer synchronously and its stage waits behind this ingress task,
			// so the consumer refuses this append and the row is retained.
			sealing = creator.room.sealEpoch().then(
				(value) => {
					sealed = value;
				},
				(error: unknown) => {
					sealFailure = error;
				}
			);
			await sleep(500);
			return;
		}
		// A later received append that reaches its hook while the close runs (the retained row's
		// drain): keep its custody until the seal settles, bounded.
		await Promise.race([sealing, sleep(5_000)]);
	});
	const receiving = creator.receive(writerRows, 1).then(
		() => "accepted",
		(error: unknown) => String(error)
	);
	for (let waited = 0; sealing === undefined && waited < 30_000; waited += 10) await sleep(10);
	expect(sealing, "the Writer's move reached the creator's received-append custody").toBeDefined();
	await sealing;
	Reflect.deleteProperty(globalThis, "__replacementCustodyHold");
	process.stdout.write(
		`CLOSE_JOURNAL_ORDER ${JSON.stringify({ holds, sealed, sealFailure: sealFailure === undefined ? null : String(sealFailure) })}\n`
	);
	expect(sealFailure === undefined ? null : String(sealFailure)).toBeNull();
	expect((sealed as { ok?: boolean } | undefined)?.ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	void receiving;
}, 600_000);
