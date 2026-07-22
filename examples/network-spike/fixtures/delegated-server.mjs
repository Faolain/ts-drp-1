/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 4175;
const TEST_PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";
const PUBLIC_ONLY_PROVIDER_ID = "16Uiu2HAmGQfUVeXqZJvyELMmJyLLBaPCUYbrz3LCkYZcwKuvLha5";
const GRID_INVITE_TOKEN = "grid-local-fixture-invite-0123456789";
const PUBLIC_ONLY_PROVIDER = {
	Addrs: [
		`/ip4/127.0.0.1/tcp/50000/ws/p2p/16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5/p2p-circuit/p2p/${PUBLIC_ONLY_PROVIDER_ID}`,
	],
	ID: PUBLIC_ONLY_PROVIDER_ID,
	Protocols: ["/meshsub/1.1.0"],
	Schema: "peer",
};
const GRID_RELAYS = {
	exhaustion: [
		gridRelay("16Uiu2HAm4WvcWKEkvP1pX5tqyQogncus5EwZHrxvShSGm2EywxS8", 50004),
		gridRelay("16Uiu2HAmRgxW71ra5FBwuKQXxm5XdidPXdopkPf5boqjgTdfoioN", 50006),
	],
	success: [
		gridRelay("16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5", 50000),
		gridRelay("16Uiu2HAmT72TapomemeWskZbmzd4hZcakAzYnTwLtbdsvdaSUvXU", 50002),
	],
};
const state = new Map();
const gridRecords = new Map();
const gridRegistryAvailable = new Map([
	["primary", true],
	["secondary", true],
]);

const server = createServer((request, response) => {
	void handleRequest(request, response);
});

async function handleRequest(request, response) {
	const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
	if (url.pathname.startsWith("/grid-control/registry/")) {
		handleGridRegistryControl(request, response, url);
		return;
	}
	if (url.pathname.startsWith("/grid-registry/")) {
		await handleGridRegistry(request, response, url);
		return;
	}
	const match = /^\/fixture\/([^/]+)\/(primary|secondary)\/routing\/v1\/(.+)$/u.exec(url.pathname);
	if (match === null) {
		writeJson(response, 404, { error: "fixture route not found" });
		return;
	}
	const [, scenario, endpoint, route] = match;
	const key = `${scenario}:${endpoint}:${route}`;
	const count = (state.get(key) ?? 0) + 1;
	state.set(key, count);

	if (!(scenario === "cors" && endpoint === "primary")) {
		response.setHeader("access-control-allow-origin", "http://127.0.0.1:4174");
		response.setHeader("access-control-expose-headers", "content-length,retry-after,x-fixture-count");
	}
	response.setHeader("cache-control", "no-store");
	response.setHeader("x-fixture-count", String(count));

	if (scenario === "grid-relays-success" || scenario === "grid-relays-exhaustion") {
		const mode = scenario === "grid-relays-success" ? "success" : "exhaustion";
		writeJson(response, 200, collection(route, GRID_RELAYS[mode]));
		return;
	}
	if (scenario === "public-only-browser") {
		writeJson(
			response,
			200,
			collection(route, route.startsWith("providers/") ? [PUBLIC_ONLY_PROVIDER] : GRID_RELAYS.success)
		);
		return;
	}

	if (endpoint === "primary") {
		if (scenario === "timeout" || scenario === "abort") {
			await delay(250);
		}
		if (scenario === "outage") {
			request.socket.destroy();
			return;
		}
		if (scenario === "malformed") {
			writeText(response, 200, "{", "application/json");
			return;
		}
		if (scenario === "oversized") {
			writeText(response, 200, "x".repeat(4096), "application/x-ndjson");
			return;
		}
		if (scenario === "poisoned") {
			writeRouting(response, route, {
				Addrs: ["/dns4/relay.example/tcp/443/tls/ws"],
				ID: "not-a-peer-id",
				Protocols: [],
				Schema: "peer",
			});
			return;
		}
		if (scenario === "rate-limit") {
			response.setHeader("retry-after", "0.05");
			writeJson(response, 429, collection(route, []));
			return;
		}
		if (scenario === "failover") {
			writeJson(response, 503, { error: "primary unavailable" });
			return;
		}
		if (scenario === "empty" || scenario === "404") {
			writeJson(response, 404, { error: "no records" });
			return;
		}
	}

	const publicIp = scenario === "stale" && count > 1 ? "1.1.1.1" : "8.8.8.8";
	writeRouting(response, route, peer(publicIp));
}

async function handleGridRegistry(request, response, url) {
	response.setHeader("access-control-allow-origin", "http://127.0.0.1:4174");
	response.setHeader("access-control-allow-headers", "content-type");
	response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
	response.setHeader("cache-control", "no-store");
	if (request.method === "OPTIONS") {
		response.statusCode = 204;
		response.end();
		return;
	}
	const match = /^\/grid-registry\/(primary|secondary)\/(v1\/)?(register|discover)$/u.exec(url.pathname);
	if (match === null) {
		writeJson(response, 404, { error: "grid registry route not found" });
		return;
	}
	const [, endpoint, version, operation] = match;
	if (gridRegistryAvailable.get(endpoint) !== true) {
		writeJson(response, 503, { accepted: false, code: "endpoint-unavailable" });
		return;
	}
	if (operation === "register" && request.method === "POST") {
		const body = await readJson(request, 12_000);
		if (version === "v1/" && (body?.credential?.kind !== "invite" || body.credential.token !== GRID_INVITE_TOKEN)) {
			writeJson(response, 403, { accepted: false, code: "admission-denied" });
			return;
		}
		const record = body?.record;
		if (
			typeof record?.namespace !== "string" ||
			typeof record?.peerId !== "string" ||
			!Number.isSafeInteger(record?.expiresAtMs)
		) {
			writeJson(response, 400, { accepted: false, code: "record-rejected" });
			return;
		}
		const key = `${endpoint}:${record.namespace}:${record.peerId}`;
		gridRecords.set(key, structuredClone(record));
		writeJson(response, 200, {
			accepted: true,
			admissionMode: "invite",
			endpointId: `grid-${endpoint}`,
			expiresAtMs: record.expiresAtMs,
			refreshed: false,
			sequence: record.sequence,
		});
		return;
	}
	if (operation === "discover" && (request.method === "GET" || request.method === "POST")) {
		const body = request.method === "POST" ? await readJson(request, 2_000) : undefined;
		const namespace = request.method === "POST" ? body?.namespace : url.searchParams.get("namespace");
		if (typeof namespace !== "string" || namespace.length > 256) {
			writeJson(response, 400, { code: "record-rejected" });
			return;
		}
		const now = Date.now();
		const prefix = `${endpoint}:${namespace}:`;
		const records = [];
		for (const [key, record] of gridRecords) {
			if (record.expiresAtMs <= now) {
				gridRecords.delete(key);
				continue;
			}
			if (key.startsWith(prefix)) records.push({ admissionMode: "invite", record });
		}
		writeJson(response, 200, { endpointId: `grid-${endpoint}`, records: records.slice(0, 64) });
		return;
	}
	writeJson(response, 405, { error: "method not allowed" });
}

function handleGridRegistryControl(request, response, url) {
	response.setHeader("access-control-allow-origin", "*");
	response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
	if (request.method === "OPTIONS") {
		response.statusCode = 204;
		response.end();
		return;
	}
	if (url.pathname === "/grid-control/registry/reset" && request.method === "POST") {
		// Clear all published records so sequential test runs (e.g. one browser project after another,
		// sharing this fixture) start from a clean registry and never discover a prior run's stale peer.
		gridRecords.clear();
		gridRegistryAvailable.set("primary", true);
		gridRegistryAvailable.set("secondary", true);
		writeJson(response, 200, { records: 0, reset: true });
		return;
	}
	const match = /^\/grid-control\/registry\/(primary|secondary)\/(up|down|status)$/u.exec(url.pathname);
	if (match === null) {
		writeJson(response, 404, { error: "grid registry control route not found" });
		return;
	}
	const [, endpoint, action] = match;
	if (action === "status" && request.method === "GET") {
		writeJson(response, 200, { endpoint, running: gridRegistryAvailable.get(endpoint) === true });
		return;
	}
	if ((action === "up" || action === "down") && request.method === "POST") {
		gridRegistryAvailable.set(endpoint, action === "up");
		writeJson(response, 200, { endpoint, running: action === "up" });
		return;
	}
	writeJson(response, 405, { error: "method not allowed" });
}

server.listen(PORT, HOST, () => {
	process.stdout.write(`delegated fixture server listening on http://${HOST}:${PORT}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => server.close(() => process.exit(0)));
}

function peer(publicIp) {
	return {
		Addrs: [
			"/dns4/relay.example/tcp/443/tls/ws",
			`/ip4/${publicIp}/udp/443/quic-v1/webtransport`,
			"/ip4/8.8.4.4/tcp/4001",
			"/ip4/127.0.0.1/tcp/443/tls/ws",
		],
		ID: TEST_PEER_ID,
		Protocols: ["transport-bitswap"],
		Schema: "peer",
	};
}

function gridRelay(peerId, port) {
	return {
		Addrs: [`/ip4/127.0.0.1/tcp/${port}/ws/p2p/${peerId}`],
		ID: peerId,
		Protocols: ["/libp2p/circuit/relay/0.2.0/hop"],
		Schema: "peer",
	};
}

function collection(route, records) {
	return route.startsWith("providers/") ? { Providers: records } : { Peers: records };
}

function writeRouting(response, route, record) {
	writeJson(response, 200, collection(route, [record]));
}

function writeJson(response, status, body) {
	writeText(response, status, JSON.stringify(body), "application/json");
}

function writeText(response, status, body, contentType) {
	response.statusCode = status;
	response.setHeader("content-type", contentType);
	response.setHeader("content-length", String(Buffer.byteLength(body)));
	response.end(body);
}

function delay(durationMs) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function readJson(request, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				request.destroy();
				reject(new Error("request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", reject);
	});
}
