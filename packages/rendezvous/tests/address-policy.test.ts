import { type AddressCandidate, AddressPolicy, type Resolver } from "@ts-drp/rendezvous";
import { describe, expect, it, vi } from "vitest";

const signal = new AbortController().signal;
const publicResolver: Resolver = {
	resolve: () => Promise.resolve(["8.8.8.8", "2001:4860:4860::8888"]),
};

describe("AddressPolicy", () => {
	it("classifies supported address families and transports for each target", async () => {
		const browser = new AddressPolicy({ target: "browser" });
		const node = new AddressPolicy({ target: "node" });

		await expect(browser.evaluate("/ip4/8.8.8.8/tcp/443/wss", publicResolver, signal)).resolves.toMatchObject({
			dialable: true,
			family: "ipv4",
			scope: "public",
			transports: ["wss"],
		});
		await expect(
			browser.evaluate("/ip6/2001:4860:4860::8888/udp/443/quic-v1/webtransport", publicResolver, signal)
		).resolves.toMatchObject({
			dialable: true,
			family: "ipv6",
			transports: ["webtransport"],
		});
		await expect(
			browser.evaluate("/ip4/8.8.8.8/udp/4001/webrtc-direct", publicResolver, signal)
		).resolves.toMatchObject({
			dialable: true,
			transports: ["webrtc-direct"],
		});
		await expect(
			browser.evaluate(
				"/dns4/relay.example/tcp/443/wss/p2p-circuit",
				{ resolve: () => Promise.resolve(["8.8.8.8"]) },
				signal
			)
		).resolves.toMatchObject({
			dialable: true,
			family: "dns",
			scope: "public",
			transports: ["relay", "wss"],
		});
		await expect(browser.evaluate("/ip4/8.8.8.8/tcp/4001", publicResolver, signal)).resolves.toMatchObject({
			dialable: false,
			reasons: expect.arrayContaining(["node-only-transport"]),
			transports: ["tcp"],
		});
		await expect(node.evaluate("/ip4/8.8.8.8/tcp/4001", publicResolver, signal)).resolves.toMatchObject({
			dialable: true,
			transports: ["tcp"],
		});
		await expect(node.evaluate("/ip4/8.8.8.8/udp/4001/quic-v1", publicResolver, signal)).resolves.toMatchObject({
			dialable: true,
			transports: ["quic-v1"],
		});
		await expect(
			new AddressPolicy({ allowInsecureWebSocket: true, target: "node" }).evaluate(
				"/ip4/8.8.8.8/tcp/80/ws",
				publicResolver,
				signal
			)
		).resolves.toMatchObject({ dialable: true, transports: ["ws"] });
	});

	it("passes DNS family intent to the resolver and preserves explicit-family mismatch rejection", async () => {
		const policy = new AddressPolicy({ target: "node" });
		const resolve = vi.fn((_hostname: string, _signal: AbortSignal, family: "ipv4" | "ipv6" | undefined) =>
			Promise.resolve(family === "ipv6" ? ["8.8.8.8"] : ["8.8.8.8", "2001:4860:4860::8888"])
		);
		const resolver: Resolver = { resolve };

		await expect(policy.evaluate("/dns4/v4.example/tcp/443", resolver, signal)).resolves.toMatchObject({
			dialable: false,
			reasons: expect.arrayContaining(["dns-family-mismatch"]),
		});
		expect(resolve).toHaveBeenLastCalledWith("v4.example", signal, "ipv4");

		await expect(policy.evaluate("/dns6/v6.example/tcp/443", resolver, signal)).resolves.toMatchObject({
			dialable: false,
			reasons: expect.arrayContaining(["dns-family-mismatch"]),
		});
		expect(resolve).toHaveBeenLastCalledWith("v6.example", signal, "ipv6");

		await policy.evaluate("/dns/dual.example/tcp/443", resolver, signal);
		expect(resolve).toHaveBeenLastCalledWith("dual.example", signal, undefined);
	});

	it("rejects private/local addresses, insecure WebSockets, and DNS rebinding", async () => {
		const policy = new AddressPolicy({ target: "browser" });
		const mutableOptions = { allowPrivate: true, target: "browser" as const };
		const privateAllowed = new AddressPolicy(mutableOptions);
		mutableOptions.allowPrivate = false;
		const rebindingResolver: Resolver = {
			resolve: () => Promise.resolve(["8.8.8.8", "192.168.1.20"]),
		};
		const ipv6RebindingResolver: Resolver = {
			resolve: () => Promise.resolve(["::192.168.1.20"]),
		};
		await expect(policy.evaluate("/ip4/127.0.0.1/tcp/443/wss", publicResolver, signal)).resolves.toMatchObject({
			dialable: false,
			scope: "loopback",
		});
		await expect(policy.evaluate("/ip6/fe80::1/tcp/443/wss", publicResolver, signal)).resolves.toMatchObject({
			dialable: false,
			scope: "link-local",
		});
		await expect(policy.evaluate("/ip6/fec0::1/tcp/443/wss", publicResolver, signal)).resolves.toMatchObject({
			dialable: false,
			scope: "reserved",
		});
		await expect(policy.evaluate("/ip4/8.8.8.8/tcp/80/ws", publicResolver, signal)).resolves.toMatchObject({
			dialable: false,
			reasons: expect.arrayContaining(["insecure-websocket"]),
		});
		await expect(policy.evaluate("/dns4/rebind.example/tcp/443/wss", rebindingResolver, signal)).resolves.toMatchObject(
			{
				dialable: false,
				reasons: expect.arrayContaining(["dns-rebinding-risk"]),
			}
		);
		await expect(
			policy.evaluate("/ip6/::ffff:192.168.1.20/tcp/443/wss", publicResolver, signal)
		).resolves.toMatchObject({
			dialable: false,
			scope: "private",
		});
		await expect(policy.evaluate("/ip6/::192.168.1.20/tcp/443/wss", publicResolver, signal)).resolves.toMatchObject({
			dialable: false,
			scope: "private",
		});
		await expect(policy.evaluate("/ip6/::8.8.8.8/tcp/443/wss", publicResolver, signal)).resolves.toMatchObject({
			dialable: false,
			scope: "reserved",
		});
		for (const [address, scope] of [
			["::ffff:0:10.0.0.1", "private"],
			["::ffff:0:127.0.0.1", "loopback"],
			["::ffff:0:169.254.0.1", "link-local"],
			["::ffff:0:8.8.8.8", "reserved"],
		] as const) {
			await expect(policy.evaluate(`/ip6/${address}/tcp/443/wss`, publicResolver, signal)).resolves.toMatchObject({
				dialable: false,
				scope,
			});
		}
		await expect(
			policy.evaluate("/dns6/rebind.example/tcp/443/wss", ipv6RebindingResolver, signal)
		).resolves.toMatchObject({
			dialable: false,
			reasons: expect.arrayContaining(["dns-rebinding-risk"]),
		});
		await expect(
			policy.evaluate("/dns6/family.example/tcp/443/wss", { resolve: () => Promise.resolve(["8.8.8.8"]) }, signal)
		).resolves.toMatchObject({
			dialable: false,
			reasons: expect.arrayContaining(["dns-family-mismatch"]),
		});
		await expect(
			policy.evaluate(
				"/dns6/translated-rebind.example/tcp/443/wss",
				{ resolve: () => Promise.resolve(["::ffff:0:192.168.1.20"]) },
				signal
			)
		).resolves.toMatchObject({
			dialable: false,
			reasons: expect.arrayContaining(["dns-rebinding-risk"]),
		});
		await expect(policy.evaluate("/ip6/64:ff9b:1::808:808/tcp/443/wss", publicResolver, signal)).resolves.toMatchObject(
			{
				dialable: false,
				scope: "reserved",
			}
		);
		await expect(privateAllowed.evaluate("/ip4/10.0.0.2/tcp/443/wss", publicResolver, signal)).resolves.toMatchObject({
			dialable: true,
			scope: "private",
		});
		await expect(privateAllowed.evaluate("/ip4/127.0.0.1/tcp/443/wss", publicResolver, signal)).resolves.toMatchObject({
			dialable: false,
			scope: "loopback",
		});
		await expect(
			new AddressPolicy({ allowLoopback: true, target: "node" }).evaluate(
				"/ip4/127.0.0.1/tcp/4001",
				publicResolver,
				signal
			)
		).resolves.toMatchObject({
			dialable: true,
			scope: "loopback",
		});
	});

	it("deduplicates exact addresses, preserves multiple addresses, and enforces the cap", async () => {
		const policy = new AddressPolicy({ target: "browser" });
		const candidates = [
			candidate("peer_000000000001", "addr_000000000001", "/ip4/8.8.8.8/tcp/443/wss"),
			candidate("peer_000000000001", "addr_000000000001", "/ip4/8.8.8.8/tcp/443/wss"),
			candidate("peer_000000000001", "addr_000000000002", "/ip6/2001:4860:4860::8888/tcp/443/wss"),
			candidate("peer_000000000002", "addr_000000000003", "/ip4/10.0.0.2/tcp/443/wss"),
		];
		const plan = await policy.plan(candidates, publicResolver, signal);
		expect(plan.accepted).toHaveLength(2);
		expect(plan.rejected).toHaveLength(1);
		await expect(policy.plan(candidates, publicResolver, signal, 3)).rejects.toThrow(/cap exceeded/u);
		await expect(policy.plan(candidates, publicResolver, signal, 65)).rejects.toThrow(/within 1\.\.64/u);
		await expect(policy.plan(candidates, publicResolver, signal, Number.POSITIVE_INFINITY)).rejects.toThrow(
			/within 1\.\.64/u
		);
		await expect(policy.evaluate("not-a-multiaddr", publicResolver, signal)).rejects.toThrow();
	});

	it.each([
		["50%", 10, 5],
		["75%", 12, 9],
		["90%", 10, 9],
	])("fast-rejects %s undialable candidate fixtures", async (_label, total, rejected) => {
		const policy = new AddressPolicy({ target: "browser" });
		const candidates = Array.from({ length: total }, (_value, index) => {
			const isRejected = index < rejected;
			return candidate(
				`peer_${index.toString(16).padStart(12, "0")}`,
				`addr_${index.toString(16).padStart(12, "0")}`,
				`/ip4/${isRejected ? `10.0.0.${index + 1}` : "8.8.8.8"}/tcp/443/wss`
			);
		});
		const plan = await policy.plan(candidates, publicResolver, signal);
		expect(plan.rejected).toHaveLength(rejected);
		expect(plan.accepted).toHaveLength(total - rejected);
	});
});

function candidate(candidatePseudonym: string, addressPseudonym: string, address: string): AddressCandidate {
	return { address, addressPseudonym, candidatePseudonym };
}
