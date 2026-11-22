/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native boundary probes retain the production capability signatures. */
import { expect, it, vi } from "vitest";

import { nativePlayNetwork } from "./fixtures/active-endurance/native-network.js";
import { creatorDeliveryRoom, eventually } from "./fixtures/track-aa/creator-delivery-room.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import * as adoptionActivation from "../packages/node/src/creator-adoption-activate.js";
import * as adoptionPublication from "../packages/node/src/creator-adoption-stage.js";
import * as cooperativeWork from "../packages/node/src/internal/cooperative-work.js";
import * as roomHeads from "../packages/storage-node/src/room-head.js";

type Boundary = "begin" | "publish" | "commit" | "recovery" | "activate";

function holdNativeReturn(boundary: Boundary) {
	let armed = false;
	let entered!: () => void;
	let release!: () => void;
	const arrival = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const returned = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		arrival,
		arm: () => {
			armed = true;
		},
		release,
		async after(actual: Boundary) {
			if (!armed || actual !== boundary) return;
			armed = false;
			entered();
			await returned;
		},
	};
}

function installNativeReturnHolds(gate: ReturnType<typeof holdNativeReturn>) {
	const createCheckpoint = cooperativeWork.createWorkCheckpoint;
	vi.spyOn(cooperativeWork, "createWorkCheckpoint").mockImplementation(() => {
		const checkpoint = createCheckpoint();
		if (!new Error().stack?.includes("recoverV3LiveReplica")) return checkpoint;
		return async () => {
			await checkpoint();
			await gate.after("recovery");
		};
	});
	const create = roomHeads.createNodeRoomHeadAuthority;
	vi.spyOn(roomHeads, "createNodeRoomHeadAuthority").mockImplementation((...args: Parameters<typeof create>) => {
		const native = create(...args);
		if (!args[0].filename.endsWith("peer-0-external-floor.sqlite")) return native;
		// Every method is still the original SQLite owner's closure. Hold only
		// delivery of a successful native CAS result, never its storage effects.
		return Object.freeze({
			...native,
			async begin(input: Parameters<typeof native.begin>[0]) {
				const result = await native.begin(input);
				if (result.ok) await gate.after("begin");
				return result;
			},
			async commit(input: Parameters<typeof native.commit>[0]) {
				const result = await native.commit(input);
				if (result.ok) await gate.after("commit");
				return result;
			},
		});
	});
	const publish = adoptionPublication.publishStagedCreatorSuccessorAdoption;
	vi.spyOn(adoptionPublication, "publishStagedCreatorSuccessorAdoption").mockImplementation(async (input) => {
		const result = await publish(input);
		if (result.ok === true) await gate.after("publish");
		return result;
	});
	const activate = adoptionActivation.activateCreatorSuccessorAdoption;
	vi.spyOn(adoptionActivation, "activateCreatorSuccessorAdoption").mockImplementation(async (input) => {
		const result = await activate(input);
		if (result.ok === true) await gate.after("activate");
		return result;
	});
}

const channelOptions = { maxMessageBytes: 512, maxSequencedKeys: 1, maxSequencedSenders: 2 };
const movement = (value: string) => ({
	class: "unreliable-sequenced" as const,
	key: "movement",
	payload: new TextEncoder().encode(value),
});
const hostTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

it.each(["begin", "publish", "commit", "recovery", "activate"] as const)(
	"retains original public owners while native adoption boundary %s is held",
	async (boundary) => {
		const gate = holdNativeReturn(boundary);
		installNativeReturnHolds(gate);
		let network: Awaited<ReturnType<typeof nativePlayNetwork>> | undefined;
		const jobs: Promise<unknown>[] = [];
		const own = <Value>(job: Promise<Value>) => {
			jobs.push(job);
			void job.catch(() => undefined);
			return job;
		};
		try {
			network = await nativePlayNetwork();
			const fixture = await creatorDeliveryRoom({ profile: "settlement", network, peerIds: network.peerIds });
			const creator = await fixture.open(0),
				writer = await fixture.open(1);
			await writer.room.issue({ action: "placeBlock", id: "native-boundary", kind: "stone", x: 1, y: 1 });
			expect(await eventually(() => creator.room.projection().blocks.length === 1, 10_000)).toBe(true);
			const beforeProjection = [...creator.room.projection().blocks];
			const creatorChannel = creator.room.openEphemeral(channelOptions);
			const writerChannel = writer.room.openEphemeral(channelOptions);
			let delivered = 0;
			const unsubscribe = creatorChannel.subscribe(() => {
				delivered++;
			});
			expect(await writerChannel.publish(movement("before"))).toBe(true);
			expect(delivered).toBe(1);
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			gate.arm();
			const adoption = own(creator.room.adoptCreatorSuccessor());
			await Promise.race([
				gate.arrival,
				adoption.then(() => {
					throw new Error("native boundary was not held");
				}),
			]);
			const observed = await creator.floor.read({
				scope: {
					objectId: fixture.objectId,
					pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest,
				},
			});
			expect(observed.ok).toBe(true);
			if (!observed.ok || observed.state === null) throw new Error("native floor unavailable");
			expect(observed.state.stable.epoch).toBe(boundary === "begin" || boundary === "publish" ? 0 : 1);
			expect(observed.state.pending !== null).toBe(boundary === "begin" || boundary === "publish");
			// Metadata and application projection are observed independently. No
			// assertion says application callbacks are atomic with authority binding.
			expect(creator.room.authority()).toBeNull();
			expect(creator.room.projection().blocks).toEqual(beforeProjection);
			const receivedBefore = delivered;
			await writerChannel.publish(movement(`during-${boundary}`));
			await hostTurn();
			if (boundary === "activate") {
				// Registration replacement has revoked the old handle, while the
				// room has not yet received the replacement to expose it.
				expect(delivered).toBe(receivedBefore);
				expect(await creatorChannel.publish(movement("unbound"))).toBe(false);
			} else {
				// A pending or committed floor alone does not revoke installed E2.
				expect(delivered).toBe(receivedBefore + 1);
			}
			const stale = required(network.raw.sends.findLast((send) => send.sender === writer.peerId));
			await expect(
				creator.room.issue({ action: "placeBlock", id: "must-not-issue", kind: "stone", x: 2, y: 1 })
			).rejects.toThrow(/not-active|not accepting|not authorized/);
			await expect(creator.room.queryRetainedHashes({ limit: 1 })).rejects.toThrow();
			let exported = false;
			const exporting = own(creator.room.exportCreatorSuccessor());
			void exporting.then(
				() => {
					exported = true;
				},
				() => {
					exported = true;
				}
			);
			await hostTurn();
			expect(exported).toBe(false);
			gate.release();
			await adoption;
			await exporting;
			expect(creator.room.authority()?.epoch).toBe(1);
			expect(creator.room.projection().blocks).toEqual(beforeProjection);
			const afterAdoption = delivered,
				before = creatorChannel.stats();
			network.raw.inject(creator.peerId, stale.routeId, writer.peerId, stale.bytes);
			// The Writer has not installed epoch 1 and stays a writer under it, so its epoch-0 frame is
			// inside the adjacent window (the epoch the creator just left): replay is what is refused.
			if (boundary === "activate") {
				// Never delivered (it arrived while the creator had no bound authority): delivered once,
				// and the same bytes again are refused by the carried replay watermark.
				expect(delivered).toBe(afterAdoption + 1);
				network.raw.inject(creator.peerId, stale.routeId, writer.peerId, stale.bytes);
				expect(delivered).toBe(afterAdoption + 1);
			} else {
				// Already delivered under epoch 0: the replay into epoch 1 is refused.
				expect(delivered).toBe(afterAdoption);
			}
			expect(creatorChannel.stats().stale).toBe(before.stale + 1);
			expect(creatorChannel.stats().authorityMismatch).toBe(before.authorityMismatch);
			unsubscribe();
		} finally {
			gate.release();
			await Promise.allSettled(jobs);
			await closeFixtures();
			await network?.close();
			vi.restoreAllMocks();
		}
	},
	60_000
);

it.each(["commit", "recovery"] as const)(
	"joins session close while native adoption boundary %s is held",
	async (boundary) => {
		const gate = holdNativeReturn(boundary);
		installNativeReturnHolds(gate);
		let network: Awaited<ReturnType<typeof nativePlayNetwork>> | undefined;
		let adoption: Promise<void> | undefined;
		let closing: Promise<void> | undefined;
		try {
			network = await nativePlayNetwork();
			const fixture = await creatorDeliveryRoom({ profile: "settlement", network, peerIds: network.peerIds });
			const creator = await fixture.open(0),
				writer = await fixture.open(1);
			const creatorChannel = creator.room.openEphemeral(channelOptions);
			const writerChannel = writer.room.openEphemeral(channelOptions);
			let delivered = 0;
			const unsubscribe = creatorChannel.subscribe(() => {
				delivered++;
			});
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			gate.arm();
			adoption = creator.room.adoptCreatorSuccessor();
			void adoption.catch(() => undefined);
			await Promise.race([
				gate.arrival,
				adoption.then(() => {
					throw new Error("native commit was not held");
				}),
			]);
			let closed = false;
			closing = creator.room.close().then(() => {
				closed = true;
			});
			void closing.catch(() => undefined);
			await hostTurn();
			expect(closed).toBe(false);
			await expect(
				creator.room.issue({ action: "placeBlock", id: "closed", kind: "stone", x: 1, y: 1 })
			).rejects.toThrow("closed");
			gate.release();
			await expect(adoption).rejects.toThrow("closed");
			await closing;
			expect(closed).toBe(true);
			const before = delivered;
			await writerChannel.publish(movement("after-close"));
			await hostTurn();
			expect(delivered).toBe(before);
			expect(await creatorChannel.publish(movement("after-close"))).toBe(false);
			unsubscribe();
		} finally {
			gate.release();
			await Promise.allSettled([adoption, closing]);
			await closeFixtures();
			await network?.close();
			vi.restoreAllMocks();
		}
	},
	60_000
);
