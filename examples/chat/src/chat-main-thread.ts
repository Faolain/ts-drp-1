/**
 * The Chat room on the page's main thread: the `?mainThread` opt-out, and the fallback of a browser
 * that cannot host the room in a worker (the default hosts it in a room worker, chat-worker-page.ts).
 */
import {
	acquireBrowserIdentity,
	createModularBrowserNetwork,
	getNetworkConfigFromEnv,
	isModularNetworkEnv,
	type ModularBrowserNetworkSession,
	readBrowserNetworkEnv,
} from "@ts-drp/example-browser-network";
import { DRPNode } from "@ts-drp/node";

import { type ChatPage, createChatPage, status, writerReplicaStorage } from "./chat-page";
import { type ChatRoom, createChatRoom } from "./chat-room";

/** The page's periodic render (the device archive writes in later tasks; the peer panel). */
const RENDER_MS = 3000;

/**
 * Opens the Chat node and room on the main thread.
 * @param page - The page (the worker page's, when it falls back here).
 */
export async function main(page: ChatPage = createChatPage()): Promise<void> {
	const identity = await acquireBrowserIdentity({
		lockPrefix: "ts-drp:chat:v3:identity-slot",
		seedKey: "ts-drp:chat:v3:identity-seed",
	});
	let modular: ModularBrowserNetworkSession | undefined;
	let node: DRPNode | undefined;
	let room: ChatRoom | undefined;
	let renderInterval: ReturnType<typeof setInterval> | undefined;
	try {
		const environment = readBrowserNetworkEnv(import.meta.env);
		const selected = getNetworkConfigFromEnv(environment, window.location.origin);
		const config = { ...selected, keychain_config: { ...selected.keychain_config, private_key_seed: identity.seed } };
		modular = isModularNetworkEnv(environment) ? createModularBrowserNetwork(config, environment) : undefined;
		node = modular?.node ?? new DRPNode(config);
		await node.start();
		const started = node;
		let bound = false;
		room = createChatRoom(
			started,
			{
				roomHeadAuthorityForOpen: () => window.__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__,
				approveSettlementSourceSelection: () => window.__TS_DRP_CHAT_SETTLEMENT_SOURCE_APPROVAL__,
				publishSuccessor: () => window.__TS_DRP_CHAT_SUCCESSOR_PUBLISHER__,
				readWriterReplica: writerReplicaStorage.read,
				markWriterReplica: writerReplicaStorage.mark,
			},
			{
				view: (view) => {
					page.view(view);
					// The page's render also refreshed the peer panel (once the controls are bound).
					if (bound) page.network(opened.network());
				},
				status,
			}
		);
		const opened = room;
		page.view(opened.view());
		if (modular !== undefined) {
			window.__TS_DRP_CHAT_SESSION__ = modular;
			window.dispatchEvent(new CustomEvent("ts-drp:chat-ready", { detail: modular.snapshot() }));
		}
		window.addEventListener(
			"beforeunload",
			() => {
				page.unload();
				if (renderInterval !== undefined) clearInterval(renderInterval);
				void (async (): Promise<void> => {
					await opened.close();
					await (modular?.stop() ?? started.stop());
					identity.release();
				})().catch((error: unknown) =>
					console.error("Chat shutdown failed; custody retained until document termination", error)
				);
			},
			{ once: true }
		);
		await started.networkNode.isDialable(() => {
			if (bound) return;
			bound = true;
			page.bind(opened);
			page.network(opened.network());
			renderInterval = setInterval(() => {
				opened.refresh();
			}, RENDER_MS);
		});
	} catch (error) {
		await node?.stop();
		identity.release();
		throw error;
	}
}
