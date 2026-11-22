import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { DRPNetworkNode } from "../packages/network/src/index.js";
import { DRPNode } from "../packages/node/src/index.js";
import { creatorRoutingHint } from "../packages/node/src/room-network.js";

const node = new DRPNode(
	{
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
	},
	{ reconnect: false }
);
beforeAll(() => node.start(), 30_000);
afterAll(() => node.stop());
it.each(["interval_discovery_options", "interval_sync_options"])(
	"retired activation rejects %s configuration before getters or host construction",
	(name) => {
		let reads = 0;
		const config = Object.defineProperty({ log_config: { level: "silent" as const } }, name, {
			enumerable: true,
			get(): object {
				reads++;
				return {};
			},
		});
		expect(() => new DRPNode(config)).toThrow("retired object configuration");
		expect(reads).toBe(0);
	}
);
const retiredActivationNames = [
	"createObject",
	"connectObject",
	"get",
	"put",
	"subscribe",
	"subscribeObject",
	"unsubscribeObject",
	"openEphemeral",
	"syncObject",
	"sendNegotiatedSync",
	"sendNegotiatedSyncResponse",
	"buildSyncPayloadForProtocol",
	"buildSyncResponseChunks",
] as const;
it("retires the Object package and keeps creator routing as a non-authorizing hint", async () => {
	const manifest = JSON.parse(readFileSync(new URL("../packages/node/package.json", import.meta.url), "utf8")) as {
		readonly dependencies?: Readonly<Record<string, string>>;
	};
	expect(manifest.dependencies?.["@ts-drp/object"]).toBeUndefined();
	expect(existsSync(new URL("../packages/object/package.json", import.meta.url))).toBe(false);
	expect(existsSync(new URL("../packages/object/src/index.ts", import.meta.url))).toBe(false);
	const oldPublicSource = "../packages/object/src/index.js";
	const oldPublic = await import(oldPublicSource).catch(() => ({}));
	expect(["DRPObject", "FinalityStore", "DRPApplier"].map((name) => typeof Reflect.get(oldPublic, name))).toEqual([
		"undefined",
		"undefined",
		"undefined",
	]);
	expect(creatorRoutingHint("creator-peer:opaque:room")).toBe("creator-peer:opaque");
	expect(creatorRoutingHint("opaque-room")).toBeUndefined();
	expect(creatorRoutingHint(":opaque-room")).toBeUndefined();
	expect(creatorRoutingHint("creator-peer:")).toBe("creator-peer");
	expect(node.networkNode).toBeInstanceOf(DRPNetworkNode);
});
it.each([undefined, { enabled: true }])(
	"retired activation refuses before constructing a default or explicit old finality object %j",
	async (finality_config) => {
		let reads = 0;
		const method = Reflect.get(node, "createObject");
		if (typeof method !== "function") return;
		let object: unknown;
		try {
			object = await Reflect.apply(method, node, [
				{
					get drp(): { add(): undefined; query(): number } {
						reads++;
						return {
							add(): undefined {
								return undefined;
							},
							query(): number {
								return 0;
							},
						};
					},
					finality_config,
				},
			]);
			expect({ outcome: object === undefined ? "unavailable" : "activated", reads }).toEqual({
				outcome: "unavailable",
				reads: 0,
			});
		} finally {
			if (typeof object === "object" && object !== null) {
				const id = Reflect.get(object, "id");
				const unsubscribe = Reflect.get(node, "unsubscribeObject");
				if (typeof id === "string" && typeof unsubscribe === "function") Reflect.apply(unsubscribe, node, [id, true]);
			}
		}
	}
);
it("retired activation removes alternate public construction and outbound owners without transport effects", () => {
	expect(node.networkNode).toBeInstanceOf(DRPNetworkNode);
	for (const name of retiredActivationNames)
		expect({ name, kind: typeof Reflect.get(node, name) }).toEqual({ name, kind: "undefined" });
});
it("retired activation exposes no old fetch or sync module authoring functions", async () => {
	// Deliberately load the removed module only if it still exists; a static
	// import would turn an intended runtime refusal into a test-loader failure.
	const obsoleteModule = "../packages/node/src/operations.js";
	const oldOperations = await import(obsoleteModule).catch(() => ({}));
	const spy = vi.spyOn(node.networkNode, "sendGroupMessageRandomPeer");
	const method = Reflect.get(oldOperations, "fetchState");
	if (typeof method === "function")
		await Promise.resolve(Reflect.apply(method, undefined, [node, "retired-causal-object"])).catch(() => undefined);
	expect({
		fetch: typeof method,
		sync: typeof Reflect.get(oldOperations, "syncObject"),
		sends: spy.mock.calls.length,
	}).toEqual({ fetch: "undefined", sync: "undefined", sends: 0 });
	spy.mockRestore();
});
