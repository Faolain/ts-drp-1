import * as grpc from "@grpc/grpc-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { V3RpcRoomRegistry } from "../src/rpc/v3-room-registry.js";
import type { V3RoomProjectionAuthority } from "../src/v3-room.js";
import { startV3RpcRoomServer, type V3RpcNetworkPort, type V3RpcRoomServer } from "../src/rpc/v3-service.js";

type RpcHandler = (
	call: { request: unknown },
	callback: (error: grpc.ServiceError | null, response?: unknown) => void
) => void;

const harness = vi.hoisted(() => ({
	address: "",
	bindError: null as Error | null,
	boundPort: 6969,
	handlers: {} as Record<string, RpcHandler>,
	forceShutdown: vi.fn(),
	tryShutdown: vi.fn(),
}));

vi.mock("@grpc/grpc-js", async (importOriginal) => {
	const actual = await importOriginal<typeof grpc>();
	class TestServer {
		addService(_service: unknown, implementation: Record<string, RpcHandler>): void {
			harness.handlers = implementation;
		}
		bindAsync(address: string, _credentials: unknown, callback: (error: Error | null, port: number) => void): void {
			harness.address = address;
			callback(harness.bindError, harness.boundPort);
		}
		forceShutdown(): void {
			harness.forceShutdown();
		}
		tryShutdown(callback: (error?: Error) => void): void {
			harness.tryShutdown();
			callback();
		}
	}
	return { ...actual, Server: TestServer };
});

interface TestNetwork extends V3RpcNetworkPort {
	addCustomGroup: ReturnType<typeof vi.fn>;
	sendCustomMessage: ReturnType<typeof vi.fn>;
	sendGroupMessage: ReturnType<typeof vi.fn>;
}
const servers = new Set<V3RpcRoomServer>();
function createNetwork(): TestNetwork {
	return {
		addCustomGroup: vi.fn(),
		sendCustomMessage: vi.fn().mockResolvedValue(undefined),
		sendGroupMessage: vi.fn().mockResolvedValue(undefined),
	};
}
async function start(network: TestNetwork, address = "127.0.0.1:7001"): Promise<V3RpcRoomServer> {
	const server = await startV3RpcRoomServer({
		// Unit-only lifetime stand-in: these cases never acquire a room or assert
		// authentication. Genuine registry/native authority is tested separately.
		registry: {
			close: vi.fn().mockResolvedValue(undefined),
		} as unknown as V3RpcRoomRegistry<V3RoomProjectionAuthority>,
		address,
		credentials: {} as grpc.ServerCredentials,
		network: { port: network, maxCustomGroups: 8, maxPayloadBytes: 4096, maxNameBytes: 128 },
	});
	servers.add(server);
	return server;
}
async function invoke(
	name: string,
	request: unknown
): Promise<{
	error: grpc.ServiceError | null;
	response?: unknown;
}> {
	const handler = harness.handlers[name];
	if (handler === undefined) throw new Error(`RPC handler "${name}" was not registered`);
	let callback!: ReturnType<typeof vi.fn>;
	const outcome = await new Promise<{ error: grpc.ServiceError | null; response?: unknown }>((resolve) => {
		callback = vi.fn((error: grpc.ServiceError | null, response?: unknown) => resolve({ error, response }));
		handler({ request }, callback);
	});
	expect(callback).toHaveBeenCalledOnce();
	return outcome;
}

// Historical disposition of the original four v1 bodies:
// - Network command arguments survive below; completion is now honest local
//   completion, not a remote-delivery acknowledgment.
// - Failures use current gRPC status, not v1 application returnCode/logging.
// - subscribeDRP/unsubscribeDRP/syncDRPObject/getDRPHashGraph are retired, not
//   compatibility aliases. Their retained capability ports are OpenRoom,
//   UnsubscribeRoom, QueryRetainedHashes and RequestRetainedRepair, covered by
//   accepted tests/r9-rpc-v3-room-native.test.ts. Query coverage is the bounded
//   current-epoch retained accepted window, not a raw graph or missing=>empty.
// - Binding now resolves/rejects explicitly; failed bind forces server cleanup.
describe("current v3 RPC generic command controls", () => {
	beforeEach(() => {
		harness.address = "";
		harness.bindError = null;
		harness.boundPort = 6969;
		harness.handlers = {};
		vi.clearAllMocks();
	});
	afterEach(async () => {
		for (const server of servers) await server.close();
		servers.clear();
	});

	it("delegates supported network commands with every request argument intact", async () => {
		const network = createNetwork(),
			customData = Uint8Array.from([0, 1, 255]),
			groupData = Uint8Array.from([3, 4]);
		await start(network);
		for (const [name, request] of [
			["sendCustomMessage", { peerId: "peer-d", data: customData }],
			["sendGroupMessage", { group: "group-e", data: groupData }],
			["addCustomGroup", { group: "group-f" }],
		] as const) {
			expect(await invoke(name, request)).toEqual({ error: null, response: { kind: "local-completed" } });
		}
		expect(network.sendCustomMessage).toHaveBeenCalledWith("peer-d", customData);
		expect(network.sendGroupMessage).toHaveBeenCalledWith("group-e", groupData);
		expect(network.addCustomGroup).toHaveBeenCalledWith("group-f");
	});

	it("reports supported command failures through the current refusal status", async () => {
		const network = createNetwork();
		network.sendCustomMessage.mockRejectedValue(new Error("custom failed"));
		network.sendGroupMessage.mockRejectedValue(new Error("group failed"));
		network.addCustomGroup.mockImplementation(() => {
			throw new Error("add group failed");
		});
		await start(network);
		for (const [name, request] of [
			["sendCustomMessage", { peerId: "peer-d", data: new Uint8Array() }],
			["sendGroupMessage", { group: "group-e", data: new Uint8Array() }],
			["addCustomGroup", { group: "group-f" }],
		] as const) {
			const result = await invoke(name, request);
			expect(result.response).toBeUndefined();
			expect(result.error).toMatchObject({ code: grpc.status.FAILED_PRECONDITION, details: "V3_RPC_ROOM_REFUSED" });
		}
	});

	it("registers current retained capability ports without retired raw graph or bare-ID handlers", async () => {
		await start(createNetwork());
		expect(Object.keys(harness.handlers).sort()).toEqual([
			"addCustomGroup",
			"openRoom",
			"queryRetainedHashes",
			"requestRetainedRepair",
			"sendCustomMessage",
			"sendGroupMessage",
			"unsubscribeRoom",
		]);
		for (const retired of ["subscribeDRP", "unsubscribeDRP", "syncDRPObject", "getDRPHashGraph"]) {
			expect(harness.handlers[retired]).toBeUndefined();
		}
	});

	it("resolves successful binding and rejects failed binding after server cleanup", async () => {
		harness.boundPort = 7001;
		const server = await start(createNetwork(), "127.0.0.1:7001");
		expect(server.port).toBe(7001);
		expect(harness.address).toBe("127.0.0.1:7001");
		expect(harness.forceShutdown).not.toHaveBeenCalled();
		const bindError = new Error("address already in use");
		harness.bindError = bindError;
		await expect(start(createNetwork(), "127.0.0.1:7002")).rejects.toBe(bindError);
		expect(harness.address).toBe("127.0.0.1:7002");
		expect(harness.forceShutdown).toHaveBeenCalledOnce();
		await server.close();
		expect(harness.tryShutdown).toHaveBeenCalledOnce();
	});
});
