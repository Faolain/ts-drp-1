/**
 * The Canvas room as a room worker app: the same canvas-room.ts as the main-thread page, on a node
 * started in a dedicated worker. Loaded by canvas-worker.ts after the worker's RTC globals exist
 * (network modules capture them when evaluated): never import it from the page.
 */
import {
	createModularBrowserNetwork,
	getNetworkConfigFromEnv,
	isModularNetworkEnv,
	readBrowserNetworkEnv,
} from "@ts-drp/example-browser-network";
import { V3_ROOM_WORKER_ERROR_CODECS, v3RoomWorkerNodeConfig } from "@ts-drp/example-v3-room";
import { DRPNode } from "@ts-drp/node";
import { defineRoomWorkerApp, roomWorkerRtcStats } from "@ts-drp/room-worker/worker";

import {
	type CanvasHeadFactory,
	type CanvasSettlementApproval,
	type CanvasSuccessorPublisher,
	createCanvasRoom,
} from "./canvas-room";
import {
	CANVAS_WORKER_CONTRACT,
	type CanvasWorkerCommands,
	type CanvasWorkerInit,
	type CanvasWorkerNetwork,
	type CanvasWorkerReady,
	type CanvasWorkerSessionSummary,
} from "./canvas-worker-contract";

/** The page's network panel interval (the main-thread page polls the node at the same one). */
const NETWORK_RENDER_MS = 500;

export default defineRoomWorkerApp<CanvasWorkerInit>({
	contract: CANVAS_WORKER_CONTRACT,
	errors: V3_ROOM_WORKER_ERROR_CODECS,
	async open(context) {
		const environment = readBrowserNetworkEnv(import.meta.env);
		const selected = getNetworkConfigFromEnv(environment, context.init.origin);
		const config = v3RoomWorkerNodeConfig(selected, { seed: context.init.seed }, context.storage);
		const modular = isModularNetworkEnv(environment) ? createModularBrowserNetwork(config, environment) : undefined;
		const node = modular?.node ?? new DRPNode(config);
		await node.start();
		const authority = context.hook("roomHeadAuthorityForOpen");
		const approve = context.hook("approveSettlementSourceSelection");
		const publish = context.hook("publishSuccessor");
		const room = createCanvasRoom(
			node,
			{
				roomHeadAuthorityForOpen: () =>
					authority === undefined ? undefined : (((openContext) => authority(openContext)) as CanvasHeadFactory),
				approveSettlementSourceSelection: () =>
					approve === undefined ? undefined : (((request) => approve(request)) as CanvasSettlementApproval),
				publishSuccessor: () =>
					publish === undefined ? undefined : (((offer, epoch) => publish(offer, epoch)) as CanvasSuccessorPublisher),
			},
			(view) => context.emit("canvas", view)
		);
		const summary = (): CanvasWorkerSessionSummary => ({
			peerId: node.networkNode.peerId,
			relayReservations: modular?.snapshot().relayReservations ?? [],
		});
		// The peer panel and the session summary: sent when they change, at the page's render interval.
		let dialable = false;
		let lastNetwork = "";
		let lastSession = "";
		const push = (): void => {
			const network: CanvasWorkerNetwork = { ...room.network(), dialable };
			const networkText = JSON.stringify(network);
			if (networkText !== lastNetwork) {
				lastNetwork = networkText;
				context.emit("network", network);
			}
			const session = summary();
			const sessionText = JSON.stringify(session);
			if (sessionText !== lastSession) {
				lastSession = sessionText;
				context.emit("session", session);
			}
		};
		const timer = setInterval(push, NETWORK_RENDER_MS);
		push();
		void node.networkNode.isDialable(() => {
			dialable = true;
			push();
		});
		let stopped: Promise<void> | undefined;
		const stop = (): Promise<void> => {
			stopped ??= (async (): Promise<void> => {
				clearInterval(timer);
				try {
					await room.close();
				} finally {
					await (modular?.stop() ?? node.stop());
				}
			})();
			return stopped;
		};
		const ready: CanvasWorkerReady = { peerId: node.networkNode.peerId, view: room.view(), session: summary() };
		const commands: CanvasWorkerCommands = {
			open: (operation, invite) => room.open(operation, invite),
			paint: (x, y, rgb) => room.paint(x, y, rgb),
			view: () => room.view(),
			close: () => room.close(),
			session: () => modular?.snapshot() ?? summary(),
			rtcStats: () => roomWorkerRtcStats(),
		};
		return {
			info: ready,
			commands,
			async close(): Promise<void> {
				// As the main-thread page unloads: the room joins admitted work before the node stops.
				await stop().catch((error: unknown) => console.error("Canvas shutdown failed", error));
			},
		};
	},
});
