import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { type Identify, identify } from "@libp2p/identify";
import { type KadDHT, kadDHT, passthroughMapper } from "@libp2p/kad-dht";
import { ping, type Ping } from "@libp2p/ping";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { createServer } from "node:http";

const DHT_PORT = 4176;
const HEALTH_PORT = 4177;

async function main(): Promise<void> {
	type FixtureServices = {
		[key: string]: unknown;
		aminoDHT: KadDHT;
		identify: Identify;
		ping: Ping;
	};
	const node = await createLibp2p<FixtureServices>({
		addresses: { listen: [`/ip4/127.0.0.1/tcp/${DHT_PORT}/ws`] },
		connectionEncrypters: [noise()],
		services: {
			aminoDHT: kadDHT({
				allowQueryWithZeroPeers: true,
				alpha: 1,
				clientMode: false,
				disjointPaths: 1,
				initialQuerySelfInterval: 0,
				kBucketSize: 1,
				peerInfoMapper: passthroughMapper,
				protocol: "/ipfs/kad/1.0.0",
				querySelfInterval: 24 * 60 * 60 * 1_000,
				reprovide: { interval: 24 * 60 * 60 * 1_000 },
			}),
			identify: identify(),
			ping: ping(),
		},
		streamMuxers: [yamux()],
		transports: [webSockets()],
	});
	const fixtureAddress = node.getMultiaddrs().find((address) => address.toString().includes(`/tcp/${DHT_PORT}/ws`));
	if (fixtureAddress === undefined) throw new Error("browser DHT fixture did not expose its WebSocket address");

	const health = createServer((request, response) => {
		if (request.url !== "/health") {
			response.writeHead(404).end();
			return;
		}
		response.setHeader("access-control-allow-origin", "http://127.0.0.1:4174");
		response.setHeader("cache-control", "no-store");
		response.setHeader("content-type", "application/json");
		response.setHeader("timing-allow-origin", "http://127.0.0.1:4174");
		response.end(JSON.stringify({ address: fixtureAddress.toString(), status: "ready" }));
	});
	await new Promise<void>((resolve) => health.listen(HEALTH_PORT, "127.0.0.1", resolve));
	process.stdout.write(`${JSON.stringify({ fixtureAddress: fixtureAddress.toString(), healthPort: HEALTH_PORT })}\n`);

	let stopping = false;
	async function stop(): Promise<void> {
		if (stopping) return;
		stopping = true;
		await Promise.allSettled([
			node.stop(),
			new Promise<void>((resolve, reject) =>
				health.close((error) => {
					if (error === undefined) resolve();
					else reject(error);
				})
			),
		]);
	}
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => void stop().finally(() => process.exit(0)));
	}
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
