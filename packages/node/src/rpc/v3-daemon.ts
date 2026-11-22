import type { DRPNodeConfig } from "@ts-drp/types";

import type { DRPNode } from "../index.js";
import { createNodeRuntime, type NodeRuntimeDependencies } from "../runtime.js";
import type { V3RoomProjectionAuthority } from "../v3-room.js";
import { V3RpcRoomRegistry, type V3RpcRoomRegistryOptions } from "./v3-room-registry.js";
import { startV3RpcRoomServer, type V3RpcRoomServer, type V3RpcRoomServerOptions } from "./v3-service.js";

/** Trusted local composition, never a wire-selected module, path or signer. */
export interface V3NodeDaemonHost<Projection extends V3RoomProjectionAuthority> {
	readonly registry: V3RpcRoomRegistryOptions<Projection>;
	readonly rpc: Omit<V3RpcRoomServerOptions<Projection>, "registry">;
	/** Release host-global custody only after all admitted room work joins. */
	close(): Promise<void>;
}

export interface V3NodeDaemonOptions<Projection extends V3RoomProjectionAuthority> {
	readonly config: DRPNodeConfig;
	/** Own partial acquisition/cleanup until the complete host is returned. */
	prepare(node: DRPNode): Promise<V3NodeDaemonHost<Projection>>;
}

export interface V3NodeDaemon {
	readonly node: DRPNode;
	readonly port: number;
	/** Immediately revoke RPC admission, then join rooms before host/signing release. */
	close(): Promise<void>;
}

/**
 * Compose the existing Node runtime and versioned room service under one lifetime.
 * Host factories select catalogs, storage initialization and external head custody;
 * wire data cannot select any of them. Runtime configuration and public-network
 * acknowledgement remain with createNodeRuntime. This does not supply freshness.
 * @param options - Trusted runtime configuration and host factory.
 * @param dependencies - Existing runtime construction seams.
 * @returns Exact daemon lifetime and the runtime available to its local owner.
 */
export async function startV3NodeDaemon<Projection extends V3RoomProjectionAuthority>(
	options: V3NodeDaemonOptions<Projection>,
	dependencies: NodeRuntimeDependencies = {}
): Promise<V3NodeDaemon> {
	if (typeof options.prepare !== "function") throw new TypeError("V3_DAEMON_INVALID_HOST_FACTORY");
	const prepare = options.prepare.bind(options);
	const runtime = await createNodeRuntime(options.config, dependencies);
	let host: V3NodeDaemonHost<Projection> | undefined;
	let closeHost: (() => Promise<void>) | undefined;
	let registry: V3RpcRoomRegistry<Projection> | undefined;
	let server: V3RpcRoomServer | undefined;
	const dispose = async (): Promise<void> => {
		// Do not release native head/identity or Node signing custody if the
		// preceding owner cannot establish its successful joined close.
		if (server !== undefined) await server.close();
		else if (registry !== undefined) await registry.close();
		if (closeHost !== undefined) await closeHost();
		await runtime.node.stop();
	};
	try {
		host = await prepare(runtime.node);
		if (typeof host.close !== "function") throw new TypeError("V3_DAEMON_INVALID_HOST_LIFETIME");
		closeHost = host.close.bind(host);
		registry = new V3RpcRoomRegistry(host.registry);
		server = await startV3RpcRoomServer({ ...host.rpc, registry });
	} catch (primary) {
		try {
			await dispose();
		} catch (cleanup) {
			throw new AggregateError([primary, cleanup], "V3_DAEMON_START_AND_CLEANUP_FAILED");
		}
		throw primary;
	}
	let joinedClose: Promise<void> | undefined;
	return Object.freeze({
		node: runtime.node,
		port: server.port,
		close(): Promise<void> {
			joinedClose ??= dispose();
			return joinedClose;
		},
	});
}
