/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native host-turn probes over the real room surface. */
import { afterEach, expect, it } from "vitest";

import { nativePlayNetwork } from "./fixtures/active-endurance/native-network.js";
import {
	installNativeStatementOwners,
	startNativeTurnMeter,
	summarizeNativeTurns,
} from "./fixtures/host-turns/native-turn-meter.js";
import { creatorDeliveryRoom, eventually } from "./fixtures/track-aa/creator-delivery-room.js";
import { closeFixtures, ports } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery } from "./fixtures/track-m/settlement-room.js";

// Statements prepared before this are not attributed, so it runs before any store opens.
installNativeStatementOwners();

const lockFailure = /database is locked|NATIVE_READ_RESERVATION_BUSY|SQLITE_BUSY/;

type Network = Awaited<ReturnType<typeof nativePlayNetwork>>;
type Fixture = Awaited<ReturnType<typeof creatorDeliveryRoom>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;

let network: Network | undefined;

afterEach(async () => {
	await closeFixtures();
	await network?.close();
	network = undefined;
});

async function openRoom() {
	network = await nativePlayNetwork();
	const fixture = await creatorDeliveryRoom({ profile: "settlement", network, peerIds: network.peerIds });
	const creator = await fixture.open(0),
		writer = await fixture.open(1);
	for (let i = 0; i < 4; i++) {
		await writer.room.issue({ action: "placeBlock", id: `w-${i}`, kind: "stone", x: i, y: 1 });
		await creator.room.issue({ action: "placeBlock", id: `c-${i}`, kind: "stone", x: i, y: 2 });
	}
	expect(await eventually(() => creator.room.projection().blocks.length === 8, 20_000)).toBe(true);
	return { fixture, creator, writer };
}

async function install(fixture: Fixture, writer: Peer) {
	const transfer = await settlementDelivery(fixture);
	Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	try {
		await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	} finally {
		for (const port of [...ports]) {
			await port.close();
			ports.delete(port);
		}
	}
}

it("seal and adopt give the host bounded native turns across rollovers", async () => {
	const { fixture, creator, writer } = await openRoom();
	const channelOptions = { maxMessageBytes: 512, maxSequencedKeys: 1, maxSequencedSenders: 2 };
	const seals: ReturnType<typeof summarizeNativeTurns>[] = [],
		adoptions: ReturnType<typeof summarizeNativeTurns>[] = [];
	let sealFrames = 0,
		frame = 0;
	for (let epoch = 1; epoch <= 3; epoch++) {
		// Each host turn the seal leaves free carries one writer frame.
		const creatorChannel = creator.room.openEphemeral(channelOptions),
			writerChannel = writer.room.openEphemeral(channelOptions);
		let delivered = 0;
		creatorChannel.subscribe(() => {
			delivered++;
		});
		// Both peers' files are hashed, so every native statement counts. The
		// writer is idle apart from ephemeral frames, which use no store.
		let meter = startNativeTurnMeter({
			onTurn: () => {
				void writerChannel.publish({
					class: "unreliable-sequenced",
					key: "movement",
					payload: new TextEncoder().encode(`frame-${frame++}`),
				});
			},
		});
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		seals.push(summarizeNativeTurns(meter.stop()));
		sealFrames += delivered;
		creatorChannel.close();
		writerChannel.close();
		meter = startNativeTurnMeter();
		await creator.room.adoptCreatorSuccessor();
		adoptions.push(summarizeNativeTurns(meter.stop()));
		expect(creator.room.authority()?.epoch).toBe(epoch);
		await install(fixture, writer);
		await writer.room.issue({ action: "placeBlock", id: `w-e${epoch}`, kind: "stone", x: 9, y: epoch });
		await creator.room.issue({ action: "placeBlock", id: `c-e${epoch}`, kind: "stone", x: 10, y: epoch });
		await creator.room.maintainRecoveryPool();
	}
	console.info(JSON.stringify({ seals, adoptions, sealFrames }));
	for (const seal of seals) {
		// Membership, replay qualification, signing and the generation stage each
		// end at a host boundary instead of running as one native span.
		expect(seal.busyTurns).toBeGreaterThanOrEqual(6);
		expect(seal.maxStatements).toBeLessThanOrEqual(1_600);
		// A turn ended by a busy-timeout wait would carry a single ~1 s statement.
		expect(seal.maxStatementMs).toBeLessThan(750);
	}
	for (const adoption of adoptions) {
		// Adoption's time-checkpointed spans split less often on a fast host, so
		// this bound leaves room above the structural begin-to-projection span.
		expect(adoption.maxStatements).toBeLessThanOrEqual(1_250);
		expect(adoption.maxStatementMs).toBeLessThan(750);
	}
	expect(sealFrames).toBeGreaterThanOrEqual(3 * 5);
}, 300_000);

it("work arriving at seal host turns is refused, deferred or resettled, never admitted into the sealed epoch", async () => {
	const { fixture, creator, writer } = await openRoom();
	const sealedBlocks = () => creator.room.projection().blocks.map((block) => block.id);
	const before = sealedBlocks();
	const outcomes: Promise<{ kind: string; ok: boolean; error?: string }>[] = [];
	const settle = (kind: string, job: Promise<unknown>) => {
		const outcome = job.then(
			() => ({ kind, ok: true }),
			(cause: unknown) => ({ kind, ok: false, error: String(cause) })
		);
		outcomes.push(outcome);
	};
	const admittedDuringSeal: string[][] = [];
	let writes = 0,
		turns = 0;
	const meter = startNativeTurnMeter({
		onTurn: () => {
			turns++;
			const current = sealedBlocks();
			if (current.join() !== before.join()) admittedDuringSeal.push(current);
			// Writer moves reach the creator as real ingress 20 ms later, inside
			// later seal turns, and its local issue lands in its own epoch.
			const skip = process.env.ADOPT_SKIP ?? "";
			if (!skip.includes("w"))
				settle(
					"writer-issue",
					writer.room.issue({ action: "placeBlock", id: `mid-${writes}`, kind: "stone", x: writes++, y: 3 })
				);
			settle(
				"creator-issue",
				creator.room.issue({ action: "placeBlock", id: `refused-${turns}`, kind: "stone", x: turns, y: 4 })
			);
			if (turns % 2 === 1) settle("maintenance", creator.room.maintainRecoveryPool());
			settle("retained", creator.room.queryRetainedHashes({ limit: 1 }));
		},
	});
	const sealed = await creator.room.sealEpoch();
	const sealTurns = summarizeNativeTurns(meter.stop());
	expect(sealed.ok).toBe(true);
	expect(admittedDuringSeal).toEqual([]);
	await creator.room.adoptCreatorSuccessor();
	await install(fixture, writer);
	const settled = await Promise.all(outcomes);
	console.info(JSON.stringify({ sealTurns, writes, settled }));
	expect(writes).toBeGreaterThan(0);
	// Nothing waited on or failed over a native reservation.
	expect(settled.filter((outcome) => lockFailure.test(outcome.error ?? ""))).toEqual([]);
	expect(sealTurns.maxStatementMs).toBeLessThan(750);
	// No creator write was accepted against the sealed epoch.
	for (const outcome of settled.filter(({ kind }) => kind === "creator-issue")) {
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toMatch(/not-active|not accepting|not authorized|sealed|closing|unavailable/);
	}
	expect(creator.room.projection().blocks.filter(({ id }) => id.startsWith("refused-"))).toEqual([]);
	// Every writer move accepted during the seal reaches the successor on both peers.
	const accepted = settled.filter(({ kind, ok }) => kind === "writer-issue" && ok).length;
	expect(accepted).toBe(writes);
	const reached = (peer: Peer) =>
		Array.from({ length: writes }, (_, index) => `mid-${index}`).every((id) =>
			peer.room.projection().blocks.some((block) => block.id === id)
		);
	expect(await eventually(() => reached(writer) && reached(creator), 30_000)).toBe(true);
	// One successor, adopted by the creator and installed by the writer.
	expect(creator.room.authority()?.epoch).toBe(1);
	expect(writer.room.authority()?.epoch).toBe(1);
	expect((await creator.room.maintainRecoveryPool()) !== undefined).toBe(true);
}, 300_000);

it("work arriving at adoption host turns never waits on the adoption's native custody", async () => {
	const { fixture, creator, writer } = await openRoom();
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	const outcomes: Promise<{ kind: string; id: string; ok: boolean; error?: string }>[] = [];
	const settle = (kind: string, id: string, job: Promise<unknown>) => {
		outcomes.push(
			job.then(
				() => ({ kind, id, ok: true }),
				(cause: unknown) => ({ kind, id, ok: false, error: String(cause) })
			)
		);
	};
	let turns = 0;
	const meter = startNativeTurnMeter({
		onTurn: () => {
			turns++;
			const writerId = `adopt-w-${turns}`;
			// Writer moves reach the creator as sealed-epoch ingress while it adopts
			// and are resettled into the successor once the writer installs it.
			// Creator issue calls are left out: on a3b1f276 they already make the
			// adoption fence refuse MAINTENANCE_POST_ADOPTION_CENSUS_UNAVAILABLE.
			settle(
				"writer-issue",
				writerId,
				writer.room.issue({ action: "placeBlock", id: writerId, kind: "stone", x: turns, y: 5 })
			);
			if (turns % 3 === 1) settle("maintenance", "", creator.room.maintainRecoveryPool());
			settle("retained", "", creator.room.queryRetainedHashes({ limit: 1 }));
		},
	});
	const adopted = await creator.room.adoptCreatorSuccessor().then(
		() => undefined,
		(cause: unknown) => String(cause)
	);
	const adoptTurns = summarizeNativeTurns(meter.stop());
	const settled = await Promise.all(outcomes);
	console.info(JSON.stringify({ adopted, adoptTurns, turns, settled }));
	expect(adopted).toBeUndefined();
	await install(fixture, writer);
	expect(turns).toBeGreaterThan(5);
	expect(settled.filter((outcome) => lockFailure.test(outcome.error ?? ""))).toEqual([]);
	// A write blocked on another connection's reservation waits out the busy timeout.
	expect(adoptTurns.maxStatementMs).toBeLessThan(750);
	expect(creator.room.authority()?.epoch).toBe(1);
	expect(writer.room.authority()?.epoch).toBe(1);
	// Every move the writer accepted reaches both projections exactly once.
	const accepted = settled.filter(({ kind, ok }) => ok && kind === "writer-issue").map(({ id }) => id);
	expect(accepted.length).toBeGreaterThan(0);
	const reached = (peer: Peer) =>
		accepted.every((id) => peer.room.projection().blocks.filter((block) => block.id === id).length === 1);
	expect(await eventually(() => reached(writer) && reached(creator), 30_000)).toBe(true);
}, 300_000);

it.each([1, 3, 5])(
	"room close at seal host turn %i joins the seal without a native lock wait",
	async (at) => {
		const { creator } = await openRoom();
		let closing: Promise<void> | undefined,
			turns = 0;
		const meter = startNativeTurnMeter({
			onTurn: () => {
				if (++turns === at) closing = creator.room.close();
			},
		});
		const sealing = creator.room.sealEpoch().then(
			(result) => ({ ok: result.ok, error: undefined as string | undefined }),
			(cause: unknown) => ({ ok: false, error: String(cause) })
		);
		const sealed = await sealing;
		const turnsSeen = summarizeNativeTurns(meter.stop());
		await closing;
		console.info(JSON.stringify({ at, sealed, turnsSeen }));
		expect(closing).toBeDefined();
		expect(sealed.error ?? "").not.toMatch(lockFailure);
		expect(turnsSeen.maxStatementMs).toBeLessThan(750);
		await expect(
			creator.room.issue({ action: "placeBlock", id: "after-close", kind: "stone", x: 1, y: 1 })
		).rejects.toThrow("closed");
	},
	120_000
);
