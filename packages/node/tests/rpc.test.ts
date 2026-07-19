import type * as grpc from "@grpc/grpc-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DRPNode } from "../src/index.js";
import type { GenericRespone, GetDRPHashGraphResponse } from "../src/proto/drp/node/v1/rpc_pb.js";
import { init } from "../src/rpc/index.js";

type RpcHandler = (
	call: { request: unknown },
	callback: (error: Error | null, response?: unknown) => void
) => void | Promise<void>;

const harness = vi.hoisted(() => ({
	address: "",
	bindError: null as Error | null,
	boundPort: 6969,
	handlers: {} as Record<string, RpcHandler>,
	log: {
		error: vi.fn(),
		info: vi.fn(),
	},
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
	}

	return {
		...actual,
		Server: TestServer,
	};
});

vi.mock("@grpc/reflection", () => ({
	ReflectionService: class {
		addToServer(_server: grpc.Server): void {}
	},
}));

vi.mock("../src/logger.js", () => ({
	log: harness.log,
}));

interface TestNode {
	addCustomGroup: ReturnType<typeof vi.fn>;
	connectObject: ReturnType<typeof vi.fn>;
	get: ReturnType<typeof vi.fn>;
	sendCustomMessage: ReturnType<typeof vi.fn>;
	sendGroupMessage: ReturnType<typeof vi.fn>;
	syncObject: ReturnType<typeof vi.fn>;
	unsubscribeObject: ReturnType<typeof vi.fn>;
}

function createNode(): TestNode {
	return {
		addCustomGroup: vi.fn(),
		connectObject: vi.fn().mockResolvedValue(undefined),
		get: vi.fn(),
		sendCustomMessage: vi.fn().mockResolvedValue(undefined),
		sendGroupMessage: vi.fn().mockResolvedValue(undefined),
		syncObject: vi.fn().mockResolvedValue(undefined),
		unsubscribeObject: vi.fn(),
	};
}

async function invoke<TResponse>(name: string, request: unknown): Promise<TResponse> {
	const handler = harness.handlers[name];
	if (!handler) throw new Error(`RPC handler "${name}" was not registered`);

	const callback = vi.fn();
	await handler({ request }, callback);
	expect(callback).toHaveBeenCalledOnce();

	const [error, response] = callback.mock.calls[0] as [Error | null, TResponse];
	expect(error).toBeNull();
	return response;
}

describe("RPC server", () => {
	beforeEach(() => {
		harness.address = "";
		harness.bindError = null;
		harness.boundPort = 6969;
		harness.handlers = {};
		vi.clearAllMocks();
	});

	it("delegates successful commands with every request argument intact", async () => {
		const node = createNode();
		const customData = Uint8Array.from([1, 2]);
		const groupData = Uint8Array.from([3, 4]);
		init(node as unknown as DRPNode, 7001);

		await expect(invoke<GenericRespone>("subscribeDRP", { drpId: "object-a" })).resolves.toMatchObject({
			returnCode: 0,
		});
		await expect(invoke<GenericRespone>("unsubscribeDRP", { drpId: "object-b" })).resolves.toMatchObject({
			returnCode: 0,
		});
		await expect(
			invoke<GenericRespone>("syncDRPObject", { drpId: "object-c", peerId: "peer-c" })
		).resolves.toMatchObject({ returnCode: 0 });
		await expect(
			invoke<GenericRespone>("sendCustomMessage", { peerId: "peer-d", data: customData })
		).resolves.toMatchObject({ returnCode: 0 });
		await expect(
			invoke<GenericRespone>("sendGroupMessage", { group: "group-e", data: groupData })
		).resolves.toMatchObject({ returnCode: 0 });
		await expect(invoke<GenericRespone>("addCustomGroup", { group: "group-f" })).resolves.toMatchObject({
			returnCode: 0,
		});

		expect(node.connectObject).toHaveBeenCalledWith({ id: "object-a" });
		expect(node.unsubscribeObject).toHaveBeenCalledWith("object-b");
		expect(node.syncObject).toHaveBeenCalledWith("object-c", "peer-c");
		expect(node.sendCustomMessage).toHaveBeenCalledWith("peer-d", customData);
		expect(node.sendGroupMessage).toHaveBeenCalledWith("group-e", groupData);
		expect(node.addCustomGroup).toHaveBeenCalledWith("group-f");
	});

	it("maps command failures to application return codes without transport errors", async () => {
		const node = createNode();
		const errors = {
			addGroup: new Error("add group failed"),
			connect: new Error("connect failed"),
			custom: new Error("custom failed"),
			group: new Error("group failed"),
			sync: new Error("sync failed"),
			unsubscribe: new Error("unsubscribe failed"),
		};
		node.connectObject.mockRejectedValue(errors.connect);
		node.unsubscribeObject.mockImplementation(() => {
			throw errors.unsubscribe;
		});
		node.syncObject.mockRejectedValue(errors.sync);
		node.sendCustomMessage.mockRejectedValue(errors.custom);
		node.sendGroupMessage.mockRejectedValue(errors.group);
		node.addCustomGroup.mockImplementation(() => {
			throw errors.addGroup;
		});
		init(node as unknown as DRPNode);

		const responses = [];
		responses.push(await invoke<GenericRespone>("subscribeDRP", { drpId: "object-a" }));
		responses.push(await invoke<GenericRespone>("unsubscribeDRP", { drpId: "object-b" }));
		responses.push(await invoke<GenericRespone>("syncDRPObject", { drpId: "object-c", peerId: "peer-c" }));
		responses.push(
			await invoke<GenericRespone>("sendCustomMessage", {
				peerId: "peer-d",
				data: new Uint8Array(),
			})
		);
		responses.push(
			await invoke<GenericRespone>("sendGroupMessage", {
				group: "group-e",
				data: new Uint8Array(),
			})
		);
		responses.push(await invoke<GenericRespone>("addCustomGroup", { group: "group-f" }));

		expect(responses.map(({ returnCode }) => returnCode)).toEqual([1, 1, 1, 1, 1, 1]);
		expect(harness.log.error).toHaveBeenCalledTimes(6);
		for (const error of Object.values(errors)) {
			expect(harness.log.error).toHaveBeenCalledWith(expect.any(String), error);
		}
	});

	it("returns graph hashes in order and represents unavailable graphs as empty", async () => {
		const node = createNode();
		node.get
			.mockReturnValueOnce({ vertices: [{ hash: "root" }, { hash: "second" }] })
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce({ vertices: [] });
		init(node as unknown as DRPNode);

		await expect(invoke<GetDRPHashGraphResponse>("getDRPHashGraph", { drpId: "available" })).resolves.toMatchObject({
			verticesHashes: ["root", "second"],
		});
		await expect(invoke<GetDRPHashGraphResponse>("getDRPHashGraph", { drpId: "missing" })).resolves.toMatchObject({
			verticesHashes: [],
		});
		await expect(invoke<GetDRPHashGraphResponse>("getDRPHashGraph", { drpId: "empty" })).resolves.toMatchObject({
			verticesHashes: [],
		});
		expect(harness.log.error).toHaveBeenCalledTimes(2);
	});

	it("reports bind outcomes accurately", () => {
		const node = createNode();

		harness.boundPort = 7001;
		init(node as unknown as DRPNode, 7001);
		expect(harness.address).toBe("0.0.0.0:7001");
		expect(harness.log.info).toHaveBeenCalledWith("::rpc::init: running grpc in port:", 7001);
		expect(harness.log.error).not.toHaveBeenCalled();

		vi.clearAllMocks();
		const bindError = new Error("address already in use");
		harness.bindError = bindError;
		init(node as unknown as DRPNode, 7002);

		expect(harness.log.error).toHaveBeenCalledOnce();
		expect(harness.log.error).toHaveBeenCalledWith(
			"::rpc::init: Error binding grpc server",
			expect.objectContaining({ message: "address already in use" })
		);
		expect(harness.log.info).not.toHaveBeenCalledWith("::rpc::init: running grpc in port:", expect.anything());
	});
});
