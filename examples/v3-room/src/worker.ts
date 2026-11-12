/**
 * The v3 room's binding to @ts-drp/room-worker (opt-in: a room hosted in a dedicated worker).
 *
 * - V3_ROOM_WORKER_ERROR_CODECS: every typed room refusal crosses the boundary intact (class,
 *   name, message, fields, cause), so an app's `instanceof V3RoomNotReachingHost` keeps working.
 * - v3RoomWorkerNodeConfig: the node config a worker-hosted room needs (the identity seed from the
 *   page, the browser-local peer cache through the page's mirrored storage, no devtools inspector).
 *
 * The harness's rollover observation lives in ./worker-observation.ts: it must load before the room's
 * modules in the worker, so it imports nothing.
 */
import { DRPError } from "@ts-drp/errors";
import {
	V3RoomAdoptionHoldExpired,
	V3RoomAwaitingAuthorFence,
	V3RoomLocalBacklogFull,
	V3RoomNotYetCurrent,
	V3RoomSuccessorInstallExpired,
} from "@ts-drp/node/v3-room";
import { errorCodec, type RoomWorkerErrorCodec } from "@ts-drp/room-worker";
import type { DRPNodeConfig } from "@ts-drp/types";

import { V3RoomPlayerDatabaseMigrationUnavailable } from "./player-database.js";
import { V3RoomAwaitingFence, V3RoomNotReachingHost, V3RoomReadOnly, V3RoomSuccessorUnavailable } from "./rollover.js";

/** Codecs of every exported V3Room* error, and the coded DRPError. */
export const V3_ROOM_WORKER_ERROR_CODECS: readonly RoomWorkerErrorCodec[] = Object.freeze([
	errorCodec("V3RoomSuccessorInstallExpired", V3RoomSuccessorInstallExpired),
	errorCodec("V3RoomAdoptionHoldExpired", V3RoomAdoptionHoldExpired),
	errorCodec("V3RoomNotYetCurrent", V3RoomNotYetCurrent),
	errorCodec("V3RoomLocalBacklogFull", V3RoomLocalBacklogFull),
	errorCodec("V3RoomAwaitingAuthorFence", V3RoomAwaitingAuthorFence),
	errorCodec("V3RoomSuccessorUnavailable", V3RoomSuccessorUnavailable),
	errorCodec("V3RoomReadOnly", V3RoomReadOnly),
	errorCodec("V3RoomNotReachingHost", V3RoomNotReachingHost),
	errorCodec("V3RoomAwaitingFence", V3RoomAwaitingFence),
	errorCodec("V3RoomPlayerDatabaseMigrationUnavailable", V3RoomPlayerDatabaseMigrationUnavailable),
	// DRPError carries a symbol brand (isDRPError) a data copy cannot restore: rebuild it.
	errorCodec("DRPError", DRPError, {
		construct: (fields, message, cause) =>
			new DRPError(
				fields.code as ConstructorParameters<typeof DRPError>[0],
				message,
				cause === undefined ? undefined : { cause }
			),
	}),
]);

/** The page's identity and storage, as the worker receives them. */
export interface V3RoomWorkerIdentity {
	/** The page's identity seed (acquireBrowserIdentity); the signing key is derived in the worker. */
	readonly seed: string;
}

/**
 * The node config of a worker-hosted room.
 * @param config - The app's node config, as on the main thread.
 * @param identity - The page's identity seed.
 * @param storage - The worker's mirrored storage (RoomWorkerContext.storage).
 * @returns The config: the seed applied, the browser-local peer cache on the mirrored storage, and
 * the libp2p devtools inspector off (it talks to a page window a worker lacks).
 */
export function v3RoomWorkerNodeConfig(
	config: DRPNodeConfig,
	identity: V3RoomWorkerIdentity,
	storage: Readonly<{
		getItem(key: string): string | null;
		setItem(key: string, value: string): void;
		removeItem(key: string): void;
	}>
): DRPNodeConfig {
	const network = config.network_config;
	const rendezvous = network?.control_plane?.rendezvous;
	const cache = rendezvous?.cache;
	return {
		...config,
		keychain_config: { ...config.keychain_config, private_key_seed: identity.seed },
		...(network === undefined
			? {}
			: {
					network_config: {
						...network,
						browser_metrics: false,
						...(network.control_plane === undefined ||
						rendezvous === undefined ||
						cache?.persistence !== "browser-local"
							? {}
							: {
									control_plane: {
										...network.control_plane,
										rendezvous: { ...rendezvous, cache: { ...cache, storage } },
									},
								}),
					},
				}),
	};
}

/**
 * The browser-local peer cache key of a config, for the page's localStorage mirror.
 * @param config
 */
export function v3RoomWorkerPeerCacheKeys(config: DRPNodeConfig): readonly string[] {
	const cache = config.network_config?.control_plane?.rendezvous?.cache;
	return cache?.persistence === "browser-local" ? [cache.key] : [];
}
