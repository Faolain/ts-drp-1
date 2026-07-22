/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const HOST = "127.0.0.1";
const requestedPort = Number(process.argv[2] ?? "4180");
if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
	throw new Error("Nostr relay fixture port must be an integer within 0..65535");
}

const storedEvents = new Map();
const subscriptions = new WeakMap();
// A plain HTTP GET returns 200 so orchestration/readiness probes (Playwright webServer,
// demo scripts) have a health endpoint; WebSocket upgrades are served on the same port.
const httpServer = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/plain" });
	response.end("nostr relay fixture ok\n");
});
const relay = new WebSocketServer({ server: httpServer });

relay.on("connection", (socket) => {
	subscriptions.set(socket, new Set());
	socket.on("message", (data, isBinary) => {
		if (isBinary) return;
		handleFrame(socket, data.toString());
	});
	socket.on("error", () => {
		// A disconnected fixture client is isolated from the relay process.
	});
});

httpServer.listen(requestedPort, HOST, () => {
	const address = httpServer.address();
	if (address === null || typeof address === "string") throw new Error("Nostr relay fixture has no TCP address");
	process.stdout.write(`nostr relay fixture listening on ws://${HOST}:${address.port}\n`);
});

httpServer.on("error", (error) => {
	process.stderr.write(`nostr relay fixture error: ${error.message}\n`);
	process.exitCode = 1;
});

function handleFrame(socket, raw) {
	let frame;
	try {
		frame = JSON.parse(raw);
	} catch {
		return;
	}
	if (!Array.isArray(frame)) return;

	if (frame[0] === "EVENT") {
		const event = frame[1];
		const id = typeof event?.id === "string" ? event.id : "";
		if (!isEvent(event)) {
			send(socket, ["OK", id, false, "invalid: malformed event"]);
			return;
		}
		const dTag = event.tags.find((tag) => tag[0] === "d");
		if (dTag?.[1] === undefined || dTag[1] === "") {
			send(socket, ["OK", event.id, false, "invalid: addressable event requires a d tag"]);
			return;
		}
		const key = JSON.stringify([event.kind, event.pubkey, dTag[1]]);
		const previous = storedEvents.get(key);
		if (previous === undefined || event.created_at > previous.created_at) storedEvents.set(key, event);
		send(socket, ["OK", event.id, true, "stored"]);
		return;
	}

	if (frame[0] === "REQ") {
		const [, subscriptionId, filter] = frame;
		if (typeof subscriptionId !== "string" || !isFilter(filter)) return;
		const active = subscriptions.get(socket);
		active?.add(subscriptionId);
		const limit = Number.isSafeInteger(filter.limit) && filter.limit >= 0 ? filter.limit : storedEvents.size;
		let sent = 0;
		for (const event of storedEvents.values()) {
			if (active?.has(subscriptionId) !== true || sent >= limit) break;
			if (!matchesFilter(event, filter)) continue;
			send(socket, ["EVENT", subscriptionId, event]);
			sent += 1;
		}
		if (active?.has(subscriptionId) === true) send(socket, ["EOSE", subscriptionId]);
		return;
	}

	if (frame[0] === "CLOSE" && typeof frame[1] === "string") {
		subscriptions.get(socket)?.delete(frame[1]);
	}
}

function isEvent(value) {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof value.id === "string" &&
		typeof value.pubkey === "string" &&
		Number.isSafeInteger(value.created_at) &&
		Number.isSafeInteger(value.kind) &&
		Array.isArray(value.tags) &&
		value.tags.every((tag) => Array.isArray(tag) && tag.every((entry) => typeof entry === "string")) &&
		typeof value.content === "string" &&
		typeof value.sig === "string"
	);
}

function isFilter(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesFilter(event, filter) {
	if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
	for (const [name, expected] of Object.entries(filter)) {
		if (!name.startsWith("#")) continue;
		if (!Array.isArray(expected)) return false;
		const tagName = name.slice(1);
		if (!event.tags.some((tag) => tag[0] === tagName && expected.includes(tag[1]))) return false;
	}
	return true;
}

function send(socket, frame) {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

let shuttingDown = false;
function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const socket of relay.clients) socket.close(1001, "fixture shutdown");
	relay.close(() => httpServer.close(() => process.exit(0)));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
