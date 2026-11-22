/**
 * The Chat room as a room worker app: the same chat-room.ts as the main-thread page, on a node
 * started in a dedicated worker. Loaded by chat-worker.ts after the worker's RTC globals exist
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
	type ChatHeadFactory,
	type ChatSettlementApproval,
	type ChatSuccessorPublisher,
	createChatRoom,
} from "./chat-room";
import {
	CHAT_WORKER_CONTRACT,
	type ChatWorkerCommands,
	type ChatWorkerInit,
	type ChatWorkerNetwork,
	type ChatWorkerReady,
	type ChatWorkerSessionSummary,
	type ChatWorkerStatus,
} from "./chat-worker-contract";

/** The page's periodic render interval (the main-thread page refreshes at the same one). */
const RENDER_MS = 3000;
/** The session summary's interval (relay reservations; the page's diagnostics read it). */
const SESSION_MS = 500;

export default defineRoomWorkerApp<ChatWorkerInit>({
	contract: CHAT_WORKER_CONTRACT,
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
		const readWriterReplica = context.hook("readWriterReplica");
		const markWriterReplica = context.hook("markWriterReplica");
		// The peer panel and the session summary: sent when they change.
		let dialable = false;
		let lastNetwork = "";
		let lastSession = "";
		let network: () => ChatWorkerNetwork = () => ({
			peerId: node.networkNode.peerId,
			author: node.keychain.localAuthorId,
			peers: [],
			discoveryPeers: [],
			objectPeers: [],
			dialable,
		});
		const pushNetwork = (): void => {
			const next = network();
			const text = JSON.stringify(next);
			if (text === lastNetwork) return;
			lastNetwork = text;
			context.emit("network", next);
		};
		const summary = (): ChatWorkerSessionSummary => ({
			peerId: node.networkNode.peerId,
			relayReservations: modular?.snapshot().relayReservations ?? [],
		});
		const pushSession = (): void => {
			const session = summary();
			const text = JSON.stringify(session);
			if (text === lastSession) return;
			lastSession = text;
			context.emit("session", session);
		};
		const room = createChatRoom(
			node,
			{
				roomHeadAuthorityForOpen: () =>
					authority === undefined ? undefined : (((openContext) => authority(openContext)) as ChatHeadFactory),
				approveSettlementSourceSelection: () =>
					approve === undefined ? undefined : (((request) => approve(request)) as ChatSettlementApproval),
				publishSuccessor: () =>
					publish === undefined ? undefined : (((offer, epoch) => publish(offer, epoch)) as ChatSuccessorPublisher),
				// The page's localStorage, through its hooks (a worker has none).
				readWriterReplica: async (key) => (await readWriterReplica?.(key)) === true,
				markWriterReplica: async (key, writer) => {
					await markWriterReplica?.(key, writer);
				},
			},
			{
				view: (view) => {
					context.emit("chat", view);
					// The page's render also refreshed the peer panel.
					pushNetwork();
				},
				status: (message, state): void => context.emit("status", { message, state } satisfies ChatWorkerStatus),
			}
		);
		network = (): ChatWorkerNetwork => ({ ...room.network(), dialable });
		const sessionTimer = setInterval(pushSession, SESSION_MS);
		pushSession();
		pushNetwork();
		let renderTimer: ReturnType<typeof setInterval> | undefined;
		void node.networkNode.isDialable(() => {
			if (dialable) return;
			dialable = true;
			pushNetwork();
			renderTimer = setInterval(() => room.refresh(), RENDER_MS);
		});
		let stopped: Promise<void> | undefined;
		const stop = (): Promise<void> => {
			stopped ??= (async (): Promise<void> => {
				clearInterval(sessionTimer);
				if (renderTimer !== undefined) clearInterval(renderTimer);
				try {
					await room.close();
				} finally {
					await (modular?.stop() ?? node.stop());
				}
			})();
			return stopped;
		};
		const ready: ChatWorkerReady = { peerId: node.networkNode.peerId, view: room.view(), session: summary() };
		const commands: ChatWorkerCommands = {
			open: (operation, invite) => room.open(operation, invite),
			send: (text) => room.send(text),
			changeWriter: (kind, target) => room.changeWriter(kind, target),
			close: () => room.close(),
			session: () => modular?.snapshot() ?? summary(),
			rtcStats: () => roomWorkerRtcStats(),
		};
		return {
			info: ready,
			commands,
			async close(): Promise<void> {
				// As the main-thread page unloads: the room joins admitted work before the node stops.
				await stop().catch((error: unknown) => console.error("Chat shutdown failed", error));
			},
		};
	},
});
