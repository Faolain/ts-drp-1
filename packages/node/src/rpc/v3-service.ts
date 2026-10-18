import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { V3RetainedHashCursor, V3RetainedHashPage } from "../v3-live.js";
import type { V3RoomProjectionAuthority } from "../v3-room.js";
import { type V3RpcRoomOpenReceipt, type V3RpcRoomOpenRequest, type V3RpcRoomRegistry } from "./v3-room-registry.js";

// Bounded hex invite (131072 characters), identity and protobuf framing. This
// transport admission bound is not a heap/RSS or native proof-budget claim.
const MAX_OPEN_MESSAGE_BYTES = 132_096;
// Aggregate service work, separate from active-room capacity and native read/proof
// accounting. Closing calls retain their slot until their own joined response.
const MAX_ADMITTED_RPC_TASKS = 32;

/** Trusted local Node methods only; these carry no room/create authority. */
export interface V3RpcNetworkPort {
	addCustomGroup(group: string): void;
	sendGroupMessage(group: string, data: Uint8Array): Promise<void>;
	sendCustomMessage(peerId: string, data: Uint8Array): Promise<void>;
}

/** Finite host-selected network admission, independent of room proof charges. */
export interface V3RpcNetworkOptions {
	readonly port: V3RpcNetworkPort;
	/** Distinct subscriptions remain occupied until daemon shutdown. */
	readonly maxCustomGroups: number;
	readonly maxPayloadBytes: number;
	readonly maxNameBytes: number;
}

export interface V3RpcRoomServerOptions<Projection extends V3RoomProjectionAuthority> {
	readonly registry: V3RpcRoomRegistry<Projection>;
	/** Explicit trusted host binding; tests use loopback with an ephemeral port. */
	readonly address: string;
	readonly credentials: grpc.ServerCredentials;
	/** Explicit host policy is required whenever network-only methods are enabled. */
	readonly network?: V3RpcNetworkOptions;
}

export interface V3RpcRoomServer {
	readonly port: number;
	/** Revoke registry admission, join native work and finish all server handles. */
	close(): Promise<void>;
}

/**
 * Load the versioned wire schema with existing proto-loader machinery.
 * Decoding provides structure only; the registry authenticates signed authority.
 * @returns Runtime gRPC method definition shared by server and local clients.
 */
export function loadV3RpcRoomServiceDefinition(): grpc.ServiceDefinition {
	const file = resolve(dirname(fileURLToPath(import.meta.url)), "../proto/drp/node/v2/rpc.proto");
	const definitions = protoLoader.loadSync(file, { longs: Number, defaults: false, arrays: true });
	return definitions["drp.node.v2.V3RoomService"] as grpc.ServiceDefinition;
}

function refusal(error: unknown): grpc.ServiceError {
	const message = error instanceof Error ? error.message : "";
	let code: grpc.status = grpc.status.FAILED_PRECONDITION;
	if (
		message.includes("CAPACITY") ||
		message.includes("task capacity exhausted") ||
		message.includes("schedule capacity exhausted")
	)
		code = grpc.status.RESOURCE_EXHAUSTED;
	else if (message.includes("INVALID_") || (message.includes("retained query") && message.includes("invalid")))
		code = grpc.status.INVALID_ARGUMENT;
	else if (message.includes("APPLICATION_UNAVAILABLE") || message.includes("SUBSCRIPTION_UNAVAILABLE"))
		code = grpc.status.NOT_FOUND;
	else if (message.includes("CANCELLED") || (error instanceof Error && error.name === "AbortError"))
		code = grpc.status.CANCELLED;
	else if (
		message.includes("REGISTRY_CLOSED") ||
		message.includes("SERVER_CLOSED") ||
		message.includes("NETWORK_UNAVAILABLE")
	)
		code = grpc.status.UNAVAILABLE;
	return Object.assign(new Error("V3_RPC_ROOM_REFUSED"), {
		code,
		details: "V3_RPC_ROOM_REFUSED",
		metadata: new grpc.Metadata(),
	});
}

/**
 * Capture one exact local handle without accepting wire-supplied capabilities.
 * @param request - Decoded data-only request.
 * @param allowedKeys - Additional fields owned by the selected method.
 * @returns Validated local subscription identifier.
 */
function subscriptionIdentity(request: unknown, allowedKeys: readonly string[] = []): string {
	if (request === null || typeof request !== "object") throw new TypeError("V3_RPC_INVALID_SUBSCRIPTION_REQUEST");
	const keys = Reflect.ownKeys(request);
	const handle = Object.getOwnPropertyDescriptor(request, "subscriptionId");
	if (
		keys.some((key) => key !== "subscriptionId" && (typeof key !== "string" || !allowedKeys.includes(key))) ||
		handle === undefined ||
		!("value" in handle) ||
		typeof handle.value !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(handle.value)
	)
		throw new TypeError("V3_RPC_INVALID_SUBSCRIPTION_REQUEST");
	return handle.value as string;
}

/**
 * Start an actual versioned unary boundary over the sole trusted local registry.
 * Pending-call cancellation revokes/joins its fresh attempt. A successful response
 * transfers only exact local handle custody; explicit unsubscribe/server close ends it.
 * @param options - Trusted registry, binding and transport credentials.
 * @returns Bound port and joined server lifetime owner.
 */
export async function startV3RpcRoomServer<Projection extends V3RoomProjectionAuthority>(
	options: V3RpcRoomServerOptions<Projection>
): Promise<V3RpcRoomServer> {
	const registry = options.registry;
	const supplied = options.network;
	let network: V3RpcNetworkOptions | undefined;
	if (supplied !== undefined) {
		const { maxCustomGroups, maxPayloadBytes, maxNameBytes, port } = supplied;
		if (
			!Number.isSafeInteger(maxCustomGroups) ||
			maxCustomGroups < 1 ||
			!Number.isSafeInteger(maxPayloadBytes) ||
			maxPayloadBytes < 0 ||
			!Number.isSafeInteger(maxNameBytes) ||
			maxNameBytes < 1 ||
			maxPayloadBytes + maxNameBytes + 32 > 2_147_483_647 ||
			typeof port?.addCustomGroup !== "function" ||
			typeof port?.sendGroupMessage !== "function" ||
			typeof port?.sendCustomMessage !== "function"
		)
			throw new TypeError("V3_RPC_INVALID_NETWORK_POLICY");
		network = Object.freeze({
			maxCustomGroups,
			maxPayloadBytes,
			maxNameBytes,
			port: Object.freeze({
				addCustomGroup: port.addCustomGroup.bind(port),
				sendGroupMessage: port.sendGroupMessage.bind(port),
				sendCustomMessage: port.sendCustomMessage.bind(port),
			}),
		});
	}
	// Each network request has one bounded name plus bytes. Tags/length prefixes
	// fit within 32 bytes; the independent signed-invite bound remains unchanged.
	const server = new grpc.Server({
		"grpc.max_receive_message_length": Math.max(
			MAX_OPEN_MESSAGE_BYTES,
			network === undefined ? 0 : network.maxPayloadBytes + network.maxNameBytes + 32
		),
	});
	const customGroups = new Set<string>();
	const captureNetworkRequest = (
		value: unknown,
		nameKey: "group" | "peerId",
		withData: boolean
	): { name: string; data: Uint8Array } => {
		if (network === undefined) throw new TypeError("V3_RPC_NETWORK_UNAVAILABLE");
		if (value === null || typeof value !== "object") throw new TypeError("V3_RPC_INVALID_NETWORK_REQUEST");
		const keys = Reflect.ownKeys(value);
		const name = Object.getOwnPropertyDescriptor(value, nameKey);
		const bytes = Object.getOwnPropertyDescriptor(value, "data");
		if (
			keys.some((key) => key !== nameKey && !(withData && key === "data")) ||
			name === undefined ||
			!("value" in name) ||
			typeof name.value !== "string" ||
			name.value.length === 0 ||
			Buffer.byteLength(name.value, "utf8") > network.maxNameBytes ||
			(bytes !== undefined && (!("value" in bytes) || !(bytes.value instanceof Uint8Array)))
		)
			throw new TypeError("V3_RPC_INVALID_NETWORK_REQUEST");
		const data: Uint8Array = bytes === undefined ? new Uint8Array() : bytes.value;
		if (data.byteLength > network.maxPayloadBytes) throw new TypeError("V3_RPC_NETWORK_PAYLOAD_CAPACITY");
		return { name: name.value as string, data: Uint8Array.from(data) };
	};
	const tasks = new Set<Promise<void>>();
	let closing = false;
	let joinedClose: Promise<void> | undefined;
	const run = (work: () => void | Promise<void>, reject: (error: grpc.ServiceError) => void): boolean => {
		if (closing) {
			reject(refusal(new TypeError("V3_RPC_SERVER_CLOSED")));
			return false;
		}
		if (tasks.size >= MAX_ADMITTED_RPC_TASKS) {
			reject(refusal(new TypeError("V3_RPC_HANDLER_CAPACITY")));
			return false;
		}
		// Reserve before work executes. Each accepted call gets its own FIFO
		// microtask and lifetime; never share/coalesce another caller's promise.
		const task = Promise.resolve().then(work);
		tasks.add(task);
		void task.finally(() => tasks.delete(task)).catch(() => undefined);
		return true;
	};
	server.addService(loadV3RpcRoomServiceDefinition(), {
		addCustomGroup(
			call: grpc.ServerUnaryCall<unknown, { kind: string }>,
			callback: grpc.sendUnaryData<{ kind: string }>
		): void {
			run((): void => {
				// The original subscription delegate is synchronous; the outer admitted
				// task still reserves and joins this distinct call's completion.
				try {
					if (closing) throw new TypeError("V3_RPC_SERVER_CLOSED");
					if (network === undefined) throw new TypeError("V3_RPC_NETWORK_UNAVAILABLE");
					const request = captureNetworkRequest(call.request, "group", false);
					if (!customGroups.has(request.name) && customGroups.size >= network.maxCustomGroups)
						throw new TypeError("V3_RPC_CUSTOM_GROUP_CAPACITY");
					// Reserve before the existing owner can subscribe. A thrown operation
					// may have effected subscription, so its slot stays conservatively held.
					customGroups.add(request.name);
					network.port.addCustomGroup(request.name);
					callback(null, { kind: "local-completed" });
				} catch (error) {
					callback(refusal(error));
				}
			}, callback);
		},
		sendGroupMessage(
			call: grpc.ServerUnaryCall<unknown, { kind: string }>,
			callback: grpc.sendUnaryData<{ kind: string }>
		): void {
			run(async (): Promise<void> => {
				try {
					if (closing) throw new TypeError("V3_RPC_SERVER_CLOSED");
					if (network === undefined) throw new TypeError("V3_RPC_NETWORK_UNAVAILABLE");
					const request = captureNetworkRequest(call.request, "group", true);
					await network.port.sendGroupMessage(request.name, request.data);
					callback(null, { kind: "local-completed" });
				} catch (error) {
					callback(refusal(error));
				}
			}, callback);
		},
		sendCustomMessage(
			call: grpc.ServerUnaryCall<unknown, { kind: string }>,
			callback: grpc.sendUnaryData<{ kind: string }>
		): void {
			run(async (): Promise<void> => {
				try {
					if (closing) throw new TypeError("V3_RPC_SERVER_CLOSED");
					if (network === undefined) throw new TypeError("V3_RPC_NETWORK_UNAVAILABLE");
					const request = captureNetworkRequest(call.request, "peerId", true);
					await network.port.sendCustomMessage(request.name, request.data);
					callback(null, { kind: "local-completed" });
				} catch (error) {
					callback(refusal(error));
				}
			}, callback);
		},
		openRoom(
			call: grpc.ServerUnaryCall<unknown, V3RpcRoomOpenReceipt>,
			callback: grpc.sendUnaryData<V3RpcRoomOpenReceipt>
		): void {
			const controller = new AbortController();
			const cancelled = (): void => controller.abort(new TypeError("V3_RPC_SUBSCRIPTION_CANCELLED"));
			call.once("cancelled", cancelled);
			if (call.cancelled) cancelled();
			const admitted = run(async (): Promise<void> => {
				let subscriptionId: string | undefined;
				try {
					if (closing) throw new TypeError("V3_RPC_SERVER_CLOSED");
					const attempt = registry.open(call.request as V3RpcRoomOpenRequest, { signal: controller.signal });
					subscriptionId = attempt.subscriptionId;
					const receipt = await attempt.ready;
					if (closing) throw new TypeError("V3_RPC_SERVER_CLOSED");
					if (controller.signal.aborted) {
						await registry.unsubscribe(subscriptionId);
						controller.signal.throwIfAborted();
					}
					call.removeListener("cancelled", cancelled);
					callback(null, receipt);
				} catch (error) {
					callback(refusal(error));
				} finally {
					call.removeListener("cancelled", cancelled);
				}
			}, callback);
			if (!admitted) call.removeListener("cancelled", cancelled);
		},
		unsubscribeRoom(
			call: grpc.ServerUnaryCall<unknown, Record<string, never>>,
			callback: grpc.sendUnaryData<Record<string, never>>
		): void {
			run(async (): Promise<void> => {
				try {
					if (closing) throw new TypeError("V3_RPC_SERVER_CLOSED");
					await registry.unsubscribe(subscriptionIdentity(call.request));
					callback(null, {});
				} catch (error) {
					callback(refusal(error));
				}
			}, callback);
		},
		queryRetainedHashes(
			call: grpc.ServerUnaryCall<unknown, V3RetainedHashPage>,
			callback: grpc.sendUnaryData<V3RetainedHashPage>
		): void {
			run(async (): Promise<void> => {
				try {
					if (closing) throw new TypeError("V3_RPC_SERVER_CLOSED");
					const subscriptionId = subscriptionIdentity(call.request, ["limit", "cursor"]);
					const request = call.request as { limit: number; cursor?: V3RetainedHashCursor };
					const page = await registry.queryRetainedHashes(subscriptionId, {
						limit: request.limit,
						...(request.cursor === undefined ? {} : { cursor: request.cursor }),
					});
					if (closing) throw new TypeError("V3_RPC_SERVER_CLOSED");
					callback(null, page);
				} catch (error) {
					callback(refusal(error));
				}
			}, callback);
		},
		requestRetainedRepair(
			call: grpc.ServerUnaryCall<unknown, Readonly<{ kind: "scheduled" }>>,
			callback: grpc.sendUnaryData<Readonly<{ kind: "scheduled" }>>
		): void {
			run(async (): Promise<void> => {
				try {
					if (closing) throw new TypeError("V3_RPC_SERVER_CLOSED");
					const subscriptionId = subscriptionIdentity(call.request, ["target"]);
					const target = (call.request as { target?: { peerId?: string } }).target;
					if (
						target !== undefined &&
						(typeof target.peerId !== "string" || target.peerId.length === 0 || target.peerId.length > 4096)
					)
						throw new TypeError("V3_RPC_INVALID_REPAIR_TARGET");
					const result = await registry.requestRetainedRepair(
						subscriptionId,
						target === undefined ? {} : { targetPeerId: target.peerId }
					);
					callback(null, result);
				} catch (error) {
					callback(refusal(error));
				}
			}, callback);
		},
	});
	let port: number;
	try {
		port = await new Promise<number>((accept, reject) => {
			server.bindAsync(options.address, options.credentials, (error, boundPort) => {
				if (error !== null) reject(error);
				else accept(boundPort);
			});
		});
	} catch (error) {
		server.forceShutdown();
		throw error;
	}
	return Object.freeze({
		port,
		close(): Promise<void> {
			if (joinedClose !== undefined) return joinedClose;
			closing = true;
			// Closing registry revokes synchronously, before either asynchronous join.
			const registryClose = registry.close();
			const serverClose = new Promise<void>((accept, reject) => {
				server.tryShutdown((error) => {
					if (error === undefined) accept();
					else reject(error);
				});
			});
			joinedClose = (async (): Promise<void> => {
				const outcomes = await Promise.allSettled([registryClose, serverClose, ...tasks]);
				const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
				if (failures.length > 0) throw new AggregateError(failures, "V3_RPC_SERVER_CLOSE_FAILED");
				customGroups.clear();
			})();
			return joinedClose;
		},
	});
}
