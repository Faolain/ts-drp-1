import type { DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPNetworkNode } from "../src/node.js";
import { createDRPUnreliableWebRtcOwner } from "../src/unreliable-webrtc.js";
import { resolveWebRtcConfiguration } from "../src/webrtc-configuration.js";
import { webRTC } from "@libp2p/webrtc";

vi.mock("@libp2p/webrtc", async (original) => ({
	...await original<typeof import("@libp2p/webrtc")>(),
	webRTC: vi.fn(() => () => ({})),
}));
vi.mock("../src/unreliable-webrtc.js", async (original) => {
	const module = await original<typeof import("../src/unreliable-webrtc.js")>();
	return { ...module, createDRPUnreliableWebRtcOwner: vi.fn(module.createDRPUnreliableWebRtcOwner) };
});

const google = [{ urls: ["stun:stun.l.google.com:19302"] }];
const turn = { urls: ["turn:turn.example:3478?transport=udp"], username: "local-user", credential: "local-secret" };
const localConfig = {
	bootstrap_peers: [],
	listen_addresses: [],
	log_config: { level: "silent" as const },
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("local WebRTC ICE configuration owner", () => {
	test("preserves installed libp2p defaults and explicitly configures Google STUN for raw connections", () => {
		const owner = resolveWebRtcConfiguration(undefined);
		expect(owner.forLibp2pTransport()).toBeUndefined();
		expect(owner.forRawConnection()).toEqual({ iceServers: google, iceTransportPolicy: "all" });
	});

	test("shares explicit TURN policy without retaining caller or constructor-owned dictionaries", () => {
		const input = { ice_servers: [{ ...turn, urls: [...turn.urls] }], ice_transport_policy: "relay" as const };
		const owner = resolveWebRtcConfiguration(input);
		input.ice_servers[0].credential = "changed";
		input.ice_servers[0].urls.push("stun:changed.example");
		const raw = owner.forRawConnection();
		const transport = owner.forLibp2pTransport();
		expect(raw).toEqual({ iceServers: [turn], iceTransportPolicy: "relay" });
		expect(transport).toEqual(raw);
		(raw.iceServers?.[0].urls as string[]).push("stun:mutated.example");
		expect(owner.forRawConnection()).toEqual(transport);
	});

	test("retains explicit host-only operation rather than restoring public STUN", () => {
		const owner = resolveWebRtcConfiguration({ ice_servers: [] });
		expect(owner.forRawConnection()).toEqual({ iceServers: [], iceTransportPolicy: "all" });
		expect(owner.forLibp2pTransport()).toEqual(owner.forRawConnection());
	});

	test.each([
		null, { unexpected: true }, { ice_servers: "stun:example" }, { ice_transport_policy: "bogus" },
		{ ice_transport_policy: null }, { ice_servers: Array(1) },
		{ ice_servers: Array(9).fill({ urls: "stun:example" }) },
		{ ice_servers: [{ urls: [] }] }, { ice_servers: [{ urls: Array(1) }] },
		{ ice_servers: [{ urls: Array(9).fill("stun:example") }] },
		{ ice_servers: [{ urls: "https://example" }] }, { ice_servers: [{ urls: "stun:example:0" }] },
		{ ice_servers: [{ urls: "stun:example:65536" }] }, { ice_servers: [{ urls: "stun:example?transport=tcp" }] },
		{ ice_servers: [{ urls: "stun:user:private-secret@example" }] },
		{ ice_servers: [{ urls: "stun:example", credential: { private: "private-secret" } }] },
		{ ice_servers: [{ urls: "stun:example", credential: "x".repeat(1025) }] },
		{ ice_servers: [{ urls: `stun:${"x".repeat(2048)}` }] },
		{ ice_servers: [{ urls: "turn:example", username: "private-secret" }] },
		{ ice_servers: [{ urls: "turns:example", credential: "private-secret" }] },
		{ ice_servers: [{ urls: "stun:example", credentialType: "oauth" }] },
		{ ice_transport_policy: "relay" }, { ice_servers: [], ice_transport_policy: "relay" },
		{ ice_servers: [{ urls: "stun:example" }], ice_transport_policy: "relay" },
	])("refuses malformed/bounded-out or unusable relay configuration without exposing secrets %#", (input) => {
		expect(() => resolveWebRtcConfiguration(input as DRPNetworkNodeConfig["webrtc"]))
			.toThrow(new TypeError("Invalid local WebRTC ICE configuration"));
	});

	test.each<{
		configuration?: DRPNetworkNodeConfig["webrtc"];
		expectedRaw: RTCConfiguration;
		expectedTransport?: RTCConfiguration;
	}>([
		{ expectedRaw: { iceServers: google, iceTransportPolicy: "all" } },
		{
			configuration: { ice_servers: [] },
			expectedRaw: { iceServers: [], iceTransportPolicy: "all" },
			expectedTransport: { iceServers: [], iceTransportPolicy: "all" },
		},
		{
			configuration: { ice_servers: [turn], ice_transport_policy: "relay" },
			expectedRaw: { iceServers: [turn], iceTransportPolicy: "relay" },
			expectedTransport: { iceServers: [turn], iceTransportPolicy: "relay" },
		},
	])("wires local configuration through both production constructors %#", async ({ configuration, expectedRaw, expectedTransport }) => {
		const stopBeforeHost = new Error("unit test stops before host construction");
		const node = new DRPNetworkNode({ ...localConfig, webrtc: configuration }, {
			hostFactory: () => Promise.reject(stopBeforeHost),
		});
		await expect(node.start()).rejects.toBe(stopBeforeHost);
		const transportConfig = vi.mocked(webRTC).mock.calls.at(-1)?.[0]?.rtcConfiguration;
		expect(transportConfig).toEqual(expectedTransport);
		// Exercise the production activation factory, without constructing libp2p/native peers.
		const native = vi.fn(function (_config: RTCConfiguration): void {});
		vi.stubGlobal("RTCPeerConnection", native);
		node["_activateUnreliableWebRtcOwner"]();
		const rawFactory = vi.mocked(createDRPUnreliableWebRtcOwner).mock.calls.at(-1)?.[0].createPeerConnection;
		if (rawFactory === undefined) throw new Error("raw factory missing");
		rawFactory();
		expect(native).toHaveBeenCalledWith(expectedRaw);
		node["_deactivateUnreliableWebRtcOwner"]();
	});

	test("refuses invalid policy before host/transport construction and has no send fallback", async () => {
		const hostFactory = vi.fn();
		const node = new DRPNetworkNode({ ...localConfig, webrtc: { ice_transport_policy: "relay" } }, { hostFactory });
		await expect(node.start()).rejects.toThrow("Invalid local WebRTC ICE configuration");
		expect(hostFactory).not.toHaveBeenCalled();
		expect(webRTC).not.toHaveBeenCalled();
		expect(await node.unreliableWebRtcOwner.openUnreliableWebRtcRoute("room:epoch").send(["peer"], new Uint8Array(1)))
			.toBe(false);
	});

	test("refuses accessors/inherited/symbol fields and sanitizes exotic-object failures", () => {
		const getter = vi.fn(() => { throw new Error("private-secret"); });
		const accessor = Object.defineProperty({}, "ice_servers", { get: getter });
		const urlAccessor = Object.defineProperty(["stun:example"], "0", { get: getter });
		for (const input of [
			accessor, Object.create({ ice_servers: [] }), { [Symbol("private-secret")]: [] },
			{ ice_servers: [{ urls: urlAccessor }] },
			new Proxy({}, { ownKeys: () => { throw new Error("private-secret"); } }),
		]) {
			expect(() => resolveWebRtcConfiguration(input as DRPNetworkNodeConfig["webrtc"]))
				.toThrow(new TypeError("Invalid local WebRTC ICE configuration"));
		}
		expect(getter).not.toHaveBeenCalled();
	});

	test("facade reset re-arms while active but cannot re-arm during asynchronous host teardown", async () => {
		let enteredStop!: () => void;
		let releaseStop!: () => void;
		const stopEntered = new Promise<void>((resolve) => { enteredStop = resolve; });
		const stopRelease = new Promise<void>((resolve) => { releaseStop = resolve; });
		const node = new DRPNetworkNode(localConfig);
		node["_node"] = {
			status: "started",
			getConnections: () => [],
			stop: (): Promise<void> => {
				enteredStop();
				return stopRelease;
			},
		} as never;
		node["_webRtcConfiguration"] = resolveWebRtcConfiguration(undefined);
		node["_activateUnreliableWebRtcOwner"]();
		const firstRoute = node.unreliableWebRtcOwner.openUnreliableWebRtcRoute("room:first");
		const activations = vi.mocked(createDRPUnreliableWebRtcOwner).mock.calls.length;
		node.unreliableWebRtcOwner.close();
		expect(vi.mocked(createDRPUnreliableWebRtcOwner).mock.calls.length).toBe(activations + 1);
		expect(await firstRoute.send(["peer"], new Uint8Array(1))).toBe(false);
		const currentRoute = node.unreliableWebRtcOwner.openUnreliableWebRtcRoute("room:current");
		const stopping = node.stop();
		await stopEntered;
		const native = vi.fn(function (_config: RTCConfiguration): void {});
		vi.stubGlobal("RTCPeerConnection", native);
		try {
			expect(node["_node"]?.status).toBe("started");
			expect(node["_webRtcConfiguration"]).toBeUndefined();
			expect(() => node.unreliableWebRtcOwner.close()).not.toThrow();
			expect(node["_activeUnreliableWebRtcOwner"]).toBeUndefined();
			expect(vi.mocked(createDRPUnreliableWebRtcOwner).mock.calls.length).toBe(activations + 1);
			expect(native).not.toHaveBeenCalled();
			expect(await currentRoute.send(["peer"], new Uint8Array(1))).toBe(false);
		} finally {
			releaseStop();
			await stopping;
		}
	});

	test("stop/restart revokes old routes, clears local policy, and applies only the next policy", async () => {
		const node = new DRPNetworkNode(localConfig);
		node["_webRtcConfiguration"] = resolveWebRtcConfiguration({ ice_servers: [turn] });
		node["_activateUnreliableWebRtcOwner"]();
		const oldFactory = vi.mocked(createDRPUnreliableWebRtcOwner).mock.calls.at(-1)?.[0].createPeerConnection;
		if (oldFactory === undefined) throw new Error("raw factory missing");
		const route = node.unreliableWebRtcOwner.openUnreliableWebRtcRoute("room:epoch");
		await node.stop();
		const native = vi.fn(function (_config: RTCConfiguration): void {});
		vi.stubGlobal("RTCPeerConnection", native);
		expect(oldFactory).toThrow("WebRTC ICE configuration is unavailable");
		expect(node["_webRtcConfiguration"]).toBeUndefined();
		expect(await route.send(["peer"], new Uint8Array(1))).toBe(false);
		const next = { ...localConfig, webrtc: { ice_servers: [] } };
		const start = vi.spyOn(node, "start").mockImplementation(async () => {
			node["_webRtcConfiguration"] = resolveWebRtcConfiguration(node["_config"]?.webrtc);
			node["_activateUnreliableWebRtcOwner"]();
		});
		await node.restart(next);
		expect(start).toHaveBeenCalledOnce();
		expect(node["_webRtcConfiguration"]?.forRawConnection()).toEqual({ iceServers: [], iceTransportPolicy: "all" });
		expect(oldFactory).toThrow("WebRTC ICE configuration is unavailable");
		expect(native).not.toHaveBeenCalled();
		expect(await route.send(["peer"], new Uint8Array(1))).toBe(false);
		await node.stop();
	});
});
