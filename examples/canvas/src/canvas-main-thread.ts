/**
 * The Canvas room on the page's main thread: the `?mainThread` opt-out, and the fallback of a browser
 * that cannot host the room in a worker (the default hosts it in a room worker, canvas-worker-page.ts).
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

import { connectionStatus, createCanvasPage } from "./canvas-page";
import { type CanvasRoom, createCanvasRoom } from "./canvas-room";

const NETWORK_RENDER_MS = 500;

/** Opens the Canvas node and room on the main thread. */
export async function main(): Promise<void> {
	const identity = await acquireBrowserIdentity({
		lockPrefix: "ts-drp:canvas:v3:identity-slot",
		seedKey: "ts-drp:canvas:v3:identity-seed",
	});
	const page = createCanvasPage();
	let modular: ModularBrowserNetworkSession | undefined;
	let node: DRPNode | undefined;
	let room: CanvasRoom | undefined;
	let renderInterval: ReturnType<typeof setInterval> | undefined;
	try {
		const environment = readBrowserNetworkEnv(import.meta.env);
		const selected = getNetworkConfigFromEnv(environment, window.location.origin);
		const config = { ...selected, keychain_config: { ...selected.keychain_config, private_key_seed: identity.seed } };
		modular = isModularNetworkEnv(environment) ? createModularBrowserNetwork(config, environment) : undefined;
		node = modular?.node ?? new DRPNode(config);
		await node.start();
		const started = node;
		room = createCanvasRoom(
			started,
			{
				roomHeadAuthorityForOpen: () => window.__TS_DRP_CANVAS_ROOM_HEAD_AUTHORITY_FOR_OPEN__,
				approveSettlementSourceSelection: () => window.__TS_DRP_CANVAS_SETTLEMENT_SOURCE_APPROVAL__,
				publishSuccessor: () => window.__TS_DRP_CANVAS_SUCCESSOR_PUBLISHER__,
			},
			(view) => page.view(view)
		);
		const opened = room;
		if (modular !== undefined) {
			window.__TS_DRP_CANVAS_SESSION__ = modular;
			window.dispatchEvent(new CustomEvent("ts-drp:canvas-ready", { detail: modular.snapshot() }));
		}
		window.addEventListener(
			"beforeunload",
			() => {
				page.unload();
				if (renderInterval !== undefined) clearInterval(renderInterval);
				void (async (): Promise<void> => {
					try {
						await opened.close();
					} finally {
						try {
							await (modular?.stop() ?? started.stop());
						} finally {
							identity.release();
						}
					}
				})().catch((error) => console.error("Canvas shutdown failed", error));
			},
			{ once: true }
		);
		let bound = false;
		await started.networkNode.isDialable(() => {
			if (bound) return;
			bound = true;
			page.bind(opened);
			page.network(opened.network());
			renderInterval = setInterval(() => page.network(opened.network()), NETWORK_RENDER_MS);
		});
	} catch (error) {
		await node?.stop().catch(() => undefined);
		identity.release();
		connectionStatus("Canvas could not start. Check the configured identity and network.", "error");
		throw error;
	}
}
