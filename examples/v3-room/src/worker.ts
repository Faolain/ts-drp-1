/**
 * The v3 room's binding to @ts-drp/room-worker (opt-in: a room hosted in a dedicated worker).
 *
 * - V3_ROOM_WORKER_ERROR_CODECS: every typed room refusal crosses the boundary intact (class,
 *   name, message, fields, cause), so an app's `instanceof V3RoomNotReachingHost` keeps working.
 * - v3RoomWorkerNodeConfig: the node config a worker-hosted room needs (the identity seed from the
 *   page, the browser-local peer cache through the page's mirrored storage, no devtools inspector).
 *
 * Exported from the package's main entry. The harness's rollover observation is also the subpath
 * `@ts-drp/example-v3-room/worker-observation`: a worker installs it before the room's modules load,
 * so it imports nothing.
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
import {
	V3RoomAwaitingFence,
	V3RoomBusy,
	V3RoomKeptMoveRefused,
	V3RoomNotReachingHost,
	V3RoomReadOnly,
	V3RoomSuccessorUnavailable,
} from "./rollover.js";

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
	errorCodec("V3RoomBusy", V3RoomBusy),
	errorCodec("V3RoomKeptMoveRefused", V3RoomKeptMoveRefused),
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

interface HeldReservation {
	release(): Promise<void>;
}

/** The native read reservations a worker-hosted room holds through the page's room-head authority. */
export interface V3RoomWorkerReservations {
	/**
	 * Wraps the page's room-head authority factory (the room worker hook): every native read
	 * reservation the worker acquires through it is tracked until the worker releases it.
	 */
	wrap<Context, Authority>(
		factory: (context: Context) => Authority | Promise<Authority>
	): (context: Context) => Promise<Authority>;
	/**
	 * Releases every reservation a stopped worker still holds. A stopped worker is a dead process: its
	 * native locks go with it, or the external authority stays locked for every other writer.
	 */
	releaseAll(): Promise<void>;
	/** Reservations acquired and not yet released. */
	readonly held: number;
}

/**
 * Track the native read reservations a worker-hosted room holds, so the page releases them when the
 * worker stops (crash, terminate) before it opens the room again.
 * @returns The tracker; pass `wrap(factory)` as the room-head authority hook.
 */
export function createV3RoomWorkerReservations(): V3RoomWorkerReservations {
	const held = new Map<HeldReservation, () => Promise<void>>();
	const track = (reservation: HeldReservation): HeldReservation => {
		let released = false;
		const release = async (): Promise<void> => {
			held.delete(reservation);
			if (released) return;
			released = true;
			await reservation.release();
		};
		held.set(reservation, release);
		return new Proxy(reservation, {
			get(target, key): unknown {
				if (key === "release") return release;
				const value: unknown = Reflect.get(target, key, target);
				return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
			},
		});
	};
	const wrapAuthority = <Authority>(authority: Authority): Authority => {
		if (typeof authority !== "object" || authority === null) return authority;
		return new Proxy(authority, {
			get(target, key): unknown {
				const value: unknown = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				const method = value as (...args: unknown[]) => unknown;
				if (key !== "acquireNativeReadReservation") return method.bind(target);
				return async (...args: unknown[]): Promise<HeldReservation> =>
					track((await method.apply(target, args)) as HeldReservation);
			},
		});
	};
	return {
		wrap:
			<Context, Authority>(factory: (context: Context) => Authority | Promise<Authority>) =>
			async (context: Context): Promise<Authority> =>
				wrapAuthority(await factory(context)),
		async releaseAll(): Promise<void> {
			const releases = [...held.values()];
			const results = await Promise.allSettled(releases.map((release) => release()));
			for (const result of results)
				if (result.status === "rejected")
					console.error("Failed to release a stopped room worker's reservation", result.reason);
		},
		get held(): number {
			return held.size;
		},
	};
}
