import { createOpaqueNamespaceV1, DhtAnchorPublisher, namespaceAnchorCid } from "@ts-drp/rendezvous";
import { createNodeRouting, type NodeRouting } from "@ts-drp/routing-node";
import { describe, expect, it } from "vitest";

describe("DHT anchor publication", () => {
	it("publishes the versioned anchor CID through the real local Node DHT lifecycle", async () => {
		const server = await createNodeRouting({
			limits: { maxResults: 2 },
			mode: "server",
			network: "local",
		});
		const publisher = await createNodeRouting({
			bootstrapPeers: [],
			mode: "client",
			network: "local",
		});
		try {
			const signal = new AbortController().signal;
			const status = await server.status(signal);
			const address = status.addresses.find(({ decision }) => decision.dialable)?.address;
			if (address === undefined) throw new Error("local anchor server has no dialable address");
			await publisher.connect(address.includes("/p2p/") ? address : `${address}/p2p/${server.peerId}`, signal);
			await publisher.waitForRoutingTable(1, signal);
			const anchor = new DhtAnchorPublisher(publisher);
			const namespace = createOpaqueNamespaceV1(Uint8Array.from({ length: 32 }, (_, offset) => 19 + offset));
			const publication = await anchor.publish(namespace, signal);
			const providers = await waitForProvider(server, publication.cid, publisher.peerId, AbortSignal.timeout(5_000));
			expect(publication.cid).toBe(await namespaceAnchorCid(namespace));
			expect(providers).toContain(publisher.peerId);
			await anchor.stop(namespace, signal);
			expect(publisher.measurements.some(({ operation }) => operation === "cancelReprovide")).toBe(true);
		} finally {
			await Promise.allSettled([publisher.stop(), server.stop()]);
		}
	}, 20_000);
});

async function waitForProvider(
	routing: NodeRouting,
	cid: string,
	peerId: string,
	signal: AbortSignal
): Promise<string[]> {
	while (true) {
		signal.throwIfAborted();
		const providers: string[] = [];
		for await (const provider of routing.findProviders(cid, signal)) providers.push(provider.peerId);
		if (providers.includes(peerId)) return providers;
		await abortableDelay(100, signal);
	}
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timeout);
			reject(signal.reason);
		};
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, durationMs);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
