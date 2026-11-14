import * as grpc from "@grpc/grpc-js";
import { type CanvasProjection, createV3CanvasApplication } from "@ts-drp/node/applications/canvas";
import { startV3NodeDaemon, type V3NodeDaemon } from "@ts-drp/node/rpc/v3-daemon";
import type { V3RpcRoomAcquisition } from "@ts-drp/node/rpc/v3-room-registry";
import type { NodeRuntimeDependencies } from "@ts-drp/node/runtime";
import { captureRoomHeadScope, roomHeadFields, roomHeadInteger } from "@ts-drp/storage";
import { createNodeV3RoomStorageHost } from "@ts-drp/storage-node/v3-room-host";
import type { DRPNodeConfig } from "@ts-drp/types";
import { resolve } from "node:path";

export interface V3CanvasCliRoom {
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
	readonly localAuthorId: string;
	readonly databaseName: string;
	readonly initialization: "create" | "reopen";
	readonly initialLogicalTime: number;
}

/** Local operator data. Neither RPC nor an invite selects a file, module or key. */
export interface V3CanvasCliConfig {
	readonly node: DRPNodeConfig;
	readonly rpc: Readonly<{
		port: number;
		maxActiveEntries: number;
		maxCustomGroups: number;
		maxPayloadBytes: number;
		maxNameBytes: number;
	}>;
	readonly canvas: Readonly<{
		width: number;
		height: number;
		directory: string;
		rooms: readonly V3CanvasCliRoom[];
	}>;
}

function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0") || /\p{Surrogate}/u.test(value))
		throw new TypeError("V3_CLI_INVALID_TEXT");
	return value;
}

function positive(value: unknown): number {
	const n = roomHeadInteger(value);
	if (n === 0) throw new TypeError("V3_CLI_INVALID_LIMIT");
	return n;
}

function jsonData(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object" || seen.has(value)) throw new TypeError("V3_CLI_INVALID_NODE_CONFIG");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("V3_CLI_INVALID_NODE_CONFIG");
			return Array.from({ length: value.length }, (_, i) => {
				const d = Object.getOwnPropertyDescriptor(value, String(i));
				if (d === undefined || !("value" in d)) throw new TypeError("V3_CLI_INVALID_NODE_CONFIG");
				return jsonData(d.value, seen);
			});
		}
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
			throw new TypeError("V3_CLI_INVALID_NODE_CONFIG");
		const keys = Reflect.ownKeys(value);
		if (keys.some((key) => typeof key !== "string")) throw new TypeError("V3_CLI_INVALID_NODE_CONFIG");
		const fields = roomHeadFields(value, keys as string[]);
		return Object.fromEntries(Object.entries(fields).map(([key, v]) => [key, jsonData(v, seen)]));
	} finally {
		seen.delete(value);
	}
}

/**
 * Capture the exact configured application and local custody policy before starting
 * a Node or opening storage. This is not signed protocol authority or freshness.
 * @param value - Parsed local configuration, not an RPC request.
 * @returns Detached data-only configuration with explicit finite RPC policy.
 */
export function captureV3CanvasCliConfig(value: unknown): V3CanvasCliConfig {
	const root = roomHeadFields(jsonData(value), ["node", "rpc", "canvas"]);
	const rpc = roomHeadFields(root.rpc, [
		"port",
		"maxActiveEntries",
		"maxCustomGroups",
		"maxPayloadBytes",
		"maxNameBytes",
	]);
	const canvas = roomHeadFields(root.canvas, ["width", "height", "directory", "rooms"]);
	if (root.node === null || typeof root.node !== "object" || Array.isArray(root.node))
		throw new TypeError("V3_CLI_INVALID_NODE_CONFIG");
	// Configuration is JSON data. Do not accept executable callbacks/accessors as
	// part of the application's configuration surface.
	const node = root.node as DRPNodeConfig;
	const port = roomHeadInteger(rpc.port);
	if (port > 65_535) throw new TypeError("V3_CLI_INVALID_PORT");
	const maxCustomGroups = positive(rpc.maxCustomGroups);
	const maxPayloadBytes = roomHeadInteger(rpc.maxPayloadBytes);
	const maxNameBytes = positive(rpc.maxNameBytes);
	if (maxPayloadBytes + maxNameBytes + 32 > 2_147_483_647) throw new TypeError("V3_CLI_INVALID_NETWORK_POLICY");
	if (!Array.isArray(canvas.rooms)) throw new TypeError("V3_CLI_INVALID_ROOMS");
	const objects = new Set<string>();
	const names = new Set<string>();
	const rooms = canvas.rooms.map((value: unknown): V3CanvasCliRoom => {
		const r = roomHeadFields(value, [
			"objectId",
			"pinnedGenesisAnchorDigest",
			"localAuthorId",
			"databaseName",
			"initialization",
			"initialLogicalTime",
		]);
		const scope = captureRoomHeadScope({
			objectId: r.objectId,
			pinnedGenesisAnchorDigest: r.pinnedGenesisAnchorDigest,
		});
		const localAuthorId = text(r.localAuthorId);
		const databaseName = text(r.databaseName);
		if (
			!/^[0-9a-f]{64}$/u.test(localAuthorId) ||
			(r.initialization !== "create" && r.initialization !== "reopen") ||
			objects.has(scope.objectId) ||
			names.has(databaseName)
		)
			throw new TypeError("V3_CLI_INVALID_ROOM_BINDING");
		objects.add(scope.objectId);
		names.add(databaseName);
		return Object.freeze({
			...scope,
			localAuthorId,
			databaseName,
			initialization: r.initialization,
			initialLogicalTime: roomHeadInteger(r.initialLogicalTime),
		});
	});
	return Object.freeze({
		node,
		rpc: Object.freeze({
			port,
			maxActiveEntries: positive(rpc.maxActiveEntries),
			maxCustomGroups,
			maxPayloadBytes,
			maxNameBytes,
		}),
		canvas: Object.freeze({
			width: positive(canvas.width),
			height: positive(canvas.height),
			directory: resolve(text(canvas.directory)),
			rooms: Object.freeze(rooms),
		}),
	});
}

/**
 * Genuine packaged receive-only Canvas daemon. Signed invites authenticate first;
 * exact local room/genesis/identity bindings then select native acquisition.
 * SQLite supplies mechanical monotone head custody, not an independent rollback
 * oracle. Missing retained files never authorize creation. No v1 RPC is installed.
 * @param value - Explicit trusted operator configuration.
 * @param dependencies - Existing runtime construction seams, not wire authority.
 * @returns Existing joined daemon lifetime and actual Node runtime.
 */
export async function startConfiguredV3CanvasDaemon(
	value: unknown,
	dependencies: NodeRuntimeDependencies = {}
): Promise<V3NodeDaemon> {
	const config = captureV3CanvasCliConfig(value);
	const application = createV3CanvasApplication(config.canvas.width, config.canvas.height);
	const applicationId = application.catalog.blueprintDigests[0];
	if (applicationId === undefined) throw new TypeError("V3_CLI_APPLICATION_UNAVAILABLE");
	return startV3NodeDaemon(
		{
			config: config.node,
			prepare(node) {
				// Network-only CLI operation requires no fabricated room or signing
				// identity. Configured room acquisition still binds exact local custody.
				const author = config.canvas.rooms.length === 0 ? undefined : node.keychain.localAuthorId;
				if (config.canvas.rooms.some((room) => room.localAuthorId !== author))
					throw new TypeError("V3_CLI_LOCAL_IDENTITY_DIFFERS");
				const reopened = new Set<string>();
				return Promise.resolve({
					registry: {
						maxActiveEntries: config.rpc.maxActiveEntries,
						applications: [
							{
								applicationId,
								application,
								async acquire({
									objectId,
									pinnedGenesisAnchorDigest,
									signal,
								}): Promise<V3RpcRoomAcquisition<CanvasProjection>> {
									signal.throwIfAborted();
									const room = config.canvas.rooms.find(
										(r) => r.objectId === objectId && r.pinnedGenesisAnchorDigest === pinnedGenesisAnchorDigest
									);
									if (room === undefined || author === undefined) throw new TypeError("V3_CLI_ROOM_UNAVAILABLE");
									const initialization = reopened.has(objectId) ? "reopen" : room.initialization;
									const host = createNodeV3RoomStorageHost({
										directory: config.canvas.directory,
										initialization: () => initialization,
									});
									const head = await host.openRoomHead(room.databaseName, { kind: initialization });
									// Even a failed partial open cannot silently retry as fresh. A
									// missing family now fails closed under noncreating reopen.
									reopened.add(objectId);
									return {
										input: {
											author,
											storageHost: host,
											databaseName: room.databaseName,
											issuanceDatabaseName: room.databaseName,
											initialLogicalTime: room.initialLogicalTime,
											publicKeyBytes: Uint8Array.from(Buffer.from(author, "hex")),
											roomHeadAuthority: head,
											signRegisteredVertexDigest: (digest) => node.keychain.signWithLocalAuthor(digest),
											openTransport: (id) => node.openRoomNetwork(id),
											onAcceptedVertex: () => undefined,
											onProjection: () => undefined,
										},
										close: () => head.close(),
									};
								},
							},
						],
					},
					rpc: {
						address: `127.0.0.1:${config.rpc.port}`,
						credentials: grpc.ServerCredentials.createInsecure(),
						network: { ...config.rpc, port: node },
					},
					close: () => Promise.resolve(),
				});
			},
		},
		dependencies
	);
}
