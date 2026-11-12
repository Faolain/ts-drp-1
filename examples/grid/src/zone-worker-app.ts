/**
 * The Grid zone as a room worker app: the same createV3ZoneApi as the main-thread page, opened in a
 * dedicated worker on a node started there. Loaded by zone-worker.ts after the worker's RTC globals
 * exist (network modules capture them when evaluated): never import it from the page.
 */
import { V3_ROOM_WORKER_ERROR_CODECS, v3RoomWorkerNodeConfig } from "@ts-drp/example-v3-room";
import { DRPNode } from "@ts-drp/node";
import { defineRoomWorkerApp, roomWorkerRtcStats } from "@ts-drp/room-worker/worker";

import { env } from "./env";
import { createModularGridNetwork } from "./modular-network";
import { getNetworkConfigFromEnv, isModularNetworkEnv } from "./network-config";
import { networkInfo } from "./render";
import {
	createV3ZoneApi,
	type V3ZoneRoomHeadAuthorityForOpen,
	type V3ZoneSettlementSourceApproval,
	type V3ZoneSuccessorPublisher,
} from "./v3-zone";
import {
	ZONE_WORKER_CONTRACT,
	type ZoneWorkerCommands,
	type ZoneWorkerInit,
	type ZoneWorkerNetwork,
	type ZoneWorkerReady,
	type ZoneWorkerSessionSnapshot,
} from "./zone-worker-contract";

export default defineRoomWorkerApp<ZoneWorkerInit>({
	contract: ZONE_WORKER_CONTRACT,
	errors: V3_ROOM_WORKER_ERROR_CODECS,
	async open(context) {
		const selected = getNetworkConfigFromEnv(env, context.init.origin);
		const config = v3RoomWorkerNodeConfig(selected, { seed: context.init.seed }, context.storage);
		const modular = isModularNetworkEnv(env) ? createModularGridNetwork(config, env) : undefined;
		const node = modular?.node ?? new DRPNode(config);
		await node.start();
		const authority = context.hook("roomHeadAuthorityForOpen");
		const approve = context.hook("approveSettlementSourceSelection");
		const publish = context.hook("publishSuccessor");
		const zone = createV3ZoneApi(
			node,
			(snapshot) => context.emit("projection", snapshot),
			((openContext) => {
				if (authority === undefined)
					throw new TypeError(
						"v3 zone room-head authority is unavailable: the application host must configure its factory"
					);
				return authority(openContext);
			}) as V3ZoneRoomHeadAuthorityForOpen,
			approve === undefined ? undefined : (((request) => approve(request)) as V3ZoneSettlementSourceApproval),
			(snapshot) => context.emit("transient", snapshot),
			publish === undefined ? undefined : (((offer, epoch) => publish(offer, epoch)) as V3ZoneSuccessorPublisher)
		);
		// The network panel: sent when it changes, at the page's render interval (the main-thread
		// page polls the node at the same interval).
		let dialable = false;
		let lastNetwork = "";
		const session = (): ZoneWorkerSessionSnapshot =>
			(modular?.snapshot() as ZoneWorkerSessionSnapshot | undefined) ?? { peerId: node.networkNode.peerId };
		const pushNetwork = (): void => {
			const info: ZoneWorkerNetwork = { ...networkInfo(node), dialable, session: session() };
			const text = JSON.stringify(info);
			if (text === lastNetwork) return;
			lastNetwork = text;
			context.emit("network", info);
		};
		const networkTimer = setInterval(pushNetwork, env.renderInfoInterval);
		pushNetwork();
		void node.networkNode.isDialable(() => {
			dialable = true;
			pushNetwork();
		});
		let stopped: Promise<void> | undefined;
		const stop = (): Promise<void> => {
			stopped ??= (async (): Promise<void> => {
				clearInterval(networkTimer);
				await (modular ?? node).stop();
			})();
			return stopped;
		};
		const ready: ZoneWorkerReady = { peerId: node.networkNode.peerId, snapshot: zone.snapshot(), session: session() };
		const commands: ZoneWorkerCommands = {
			"move": (dx: number, dy: number) => zone.move(dx, dy),
			"snapshot": () => zone.snapshot(),
			"create": (enrollments: string | readonly string[]) => zone.create(enrollments),
			"join": (invite: string) => zone.join(invite),
			"close": () => zone.close(),
			stop,
			"placeBlock": (block: Parameters<typeof zone.placeBlock>[0]) => zone.placeBlock(block),
			"sealEpoch": () => zone.sealEpoch(),
			"exportCreatorSuccessor": () => zone.exportCreatorSuccessor(),
			"adoptCreatorSuccessor": () => zone.adoptCreatorSuccessor(),
			"installCreatorSuccessor": (request: Parameters<typeof zone.installCreatorSuccessor>[0]) =>
				zone.installCreatorSuccessor(request),
			"rehearseMigration": () => zone.rehearseMigration(),
			"activateMigration": (receipt: Parameters<typeof zone.activateMigration>[0]) => zone.activateMigration(receipt),
			"approveTradeIntent": (input: Parameters<typeof zone.approveTradeIntent>[0]) => zone.approveTradeIntent(input),
			"prepareTradeIntent": (input: Parameters<typeof zone.prepareTradeIntent>[0]) => zone.prepareTradeIntent(input),
			"finalizeTradeIntent": (input: Parameters<typeof zone.finalizeTradeIntent>[0]) => zone.finalizeTradeIntent(input),
			"commitTradeIntent": (input: Parameters<typeof zone.commitTradeIntent>[0]) => zone.commitTradeIntent(input),
			"publishAoiPopulation": (input: Parameters<typeof zone.publishAoiPopulation>[0]) =>
				zone.publishAoiPopulation(input),
			"fabric.reset": (trialId: string) => zone.fabric.reset(trialId),
			"fabric.runTrial": (input: Parameters<typeof zone.fabric.runTrial>[0]) => zone.fabric.runTrial(input),
			"fabric.snapshot": (trialId: string) => zone.fabric.snapshot(trialId),
			"rtcStats": () => roomWorkerRtcStats(),
		};
		return {
			info: ready,
			commands,
			async close(): Promise<void> {
				// As the main-thread page unloads: the zone joins admitted work before the node's
				// stop revokes its signer.
				await zone.close().catch((error: unknown) => console.error("Failed to close v3 zone", error));
				await stop().catch((error: unknown) => console.error("Failed to stop grid session", error));
			},
		};
	},
});
