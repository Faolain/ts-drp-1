import { acquireBrowserIdentity } from "@ts-drp/example-browser-network";
import { DRPNode } from "@ts-drp/node";
import { enableTracing } from "@ts-drp/tracer";

import { bindControls } from "./controls";
import { env } from "./env";
import { createModularGridNetwork, type ModularGridNetworkSession } from "./modular-network";
import { isModularNetworkEnv, getNetworkConfigFromEnv as selectNetworkConfigFromEnv } from "./network-config";
import { createZonePresentation, enableUIControls, renderNetwork } from "./render";
import {
	createV3ZoneApi,
	type V3ZoneApi,
	type V3ZoneRoomHeadAuthorityForOpen,
	type V3ZoneSettlementSourceApproval,
	type V3ZoneSuccessorPublisher,
} from "./v3-zone";

declare global {
	interface Window {
		__TS_DRP_GRID_ROOM_HEAD_AUTHORITY_FOR_OPEN__?: V3ZoneRoomHeadAuthorityForOpen;
		__TS_DRP_GRID_SETTLEMENT_SOURCE_APPROVAL__?: V3ZoneSettlementSourceApproval;
		/**
		 * Test override of the creator's successor announcement; by default the zone's successor
		 * delivery announces offers to the zone's members over this page's node.
		 */
		__TS_DRP_GRID_SUCCESSOR_PUBLISHER__?: V3ZoneSuccessorPublisher;
	}
}

interface GridNetworkSession {
	readonly node: DRPNode;
	snapshot(): Readonly<{ readonly peerId: string }>;
	stop(): Promise<void>;
}

let applicationInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Get the selected network config.
 * @returns The environment-selected network configuration.
 */
export function getNetworkConfigFromEnv(): ReturnType<typeof selectNetworkConfigFromEnv> {
	return selectNetworkConfigFromEnv(env, window.location.origin);
}

/**
 * Open the zone on the page's main thread (the default; `?roomWorker` opts into a room worker).
 */
export async function main(): Promise<void> {
	if (env.enableTracing) await enableTracing();
	const identity = await acquireBrowserIdentity({
		lockPrefix: "ts-drp:grid:v3-zone:identity-slot",
		seedKey: "ts-drp:grid:v3-zone:identity-seed",
	});
	const target = window as typeof window & {
		__TS_DRP_GRID_SESSION__?: GridNetworkSession;
		__TS_DRP_V3_ZONE__?: V3ZoneApi;
	};
	let session: GridNetworkSession | undefined;
	let unloadHandler: (() => void) | undefined;
	let zone: V3ZoneApi | undefined;
	const presentation = createZonePresentation();
	try {
		const selected = getNetworkConfigFromEnv();
		const config: ReturnType<typeof selectNetworkConfigFromEnv> = {
			...selected,
			keychain_config: { ...selected.keychain_config, private_key_seed: identity.seed },
		};
		const modularSession = isModularNetworkEnv(env) ? createModularGridNetwork(config, env) : undefined;
		const node = modularSession?.node ?? new DRPNode(config);
		session = modularSession ?? {
			node,
			snapshot: (): Readonly<{ peerId: string }> => Object.freeze({ peerId: node.networkNode.peerId }),
			stop: (): Promise<void> => node.stop(),
		};
		await node.start();
		zone = createV3ZoneApi(
			node,
			presentation.projection,
			(context) => {
				const factory = window.__TS_DRP_GRID_ROOM_HEAD_AUTHORITY_FOR_OPEN__;
				if (typeof factory !== "function") {
					throw new TypeError(
						"v3 zone room-head authority is unavailable: the application host must configure its factory"
					);
				}
				return factory(context);
			},
			window.__TS_DRP_GRID_SETTLEMENT_SOURCE_APPROVAL__,
			presentation.transient,
			window.__TS_DRP_GRID_SUCCESSOR_PUBLISHER__
		);
		target.__TS_DRP_GRID_SESSION__ = session;
		target.__TS_DRP_V3_ZONE__ = zone;
		window.dispatchEvent(new CustomEvent("ts-drp:grid-ready", { detail: session.snapshot() }));
		bindControls(zone);
		applicationInterval = setInterval(() => renderNetwork(node), env.renderInfoInterval);
		renderNetwork(node);
		presentation.projection(zone.snapshot());
		unloadHandler = (): void => {
			presentation.close();
			if (applicationInterval !== undefined) clearInterval(applicationInterval);
			applicationInterval = undefined;
			// The document owns the Web Lock until termination. Releasing it here
			// would let a replacement page reuse this identity while teardown is pending.
			void (async (): Promise<void> => {
				// The room joins admitted work before node.stop revokes its signer.
				await zone?.close().catch((error: unknown) => console.error("Failed to close v3 zone", error));
				await session?.stop().catch((error: unknown) => console.error("Failed to stop grid session", error));
			})();
		};
		window.addEventListener("beforeunload", unloadHandler, { once: true });
		await node.networkNode.isDialable(() => {
			enableUIControls();
			console.log("Started v3 zone node", import.meta.env);
		});
	} catch (error) {
		presentation.close();
		delete target.__TS_DRP_GRID_SESSION__;
		delete target.__TS_DRP_V3_ZONE__;
		if (unloadHandler !== undefined) window.removeEventListener("beforeunload", unloadHandler);
		if (applicationInterval !== undefined) clearInterval(applicationInterval);
		applicationInterval = undefined;
		await zone?.close().catch(() => undefined);
		await session?.stop().catch(() => undefined);
		identity.release();
		throw error;
	}
}

export type { ModularGridNetworkSession };
