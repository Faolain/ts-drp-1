import { DRPNode } from "@ts-drp/node";
import type { DRPNodeConfig } from "@ts-drp/types";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";

void main();

async function main(): Promise<void> {
	const configPath = process.argv[2];
	const controlPort = Number.parseInt(process.argv[3] ?? "", 10);
	if (configPath === undefined || !Number.isSafeInteger(controlPort)) {
		throw new Error("usage: grid-relay-fixture <config.json> <control-port>");
	}
	const config = JSON.parse(await readFile(configPath, "utf8")) as DRPNodeConfig;
	let node: DRPNode | undefined;
	let transition = Promise.resolve();
	await startRelay();
	const server = createServer((request, response) => {
		response.setHeader("Access-Control-Allow-Headers", "content-type");
		response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		response.setHeader("Access-Control-Allow-Origin", "*");
		if (request.method === "OPTIONS") {
			response.writeHead(204).end();
			return;
		}
		if (request.method === "GET" && request.url === "/health") {
			writeJson(response, 200, { running: node !== undefined });
			return;
		}
		if (request.method === "POST" && request.url === "/stop") {
			transition = transition.then(stopRelay);
			void transition.then(
				() => writeJson(response, 200, { running: false }),
				(error: unknown) => writeJson(response, 500, { error: String(error) })
			);
			return;
		}
		if (request.method === "POST" && request.url === "/start") {
			transition = transition.then(startRelay);
			void transition.then(
				() => writeJson(response, 200, { running: true }),
				(error: unknown) => writeJson(response, 500, { error: String(error) })
			);
			return;
		}
		writeJson(response, 404, { error: "not found" });
	});
	await new Promise<void>((resolve) => server.listen(controlPort, "127.0.0.1", resolve));
	process.stdout.write(`grid relay fixture control ready http://127.0.0.1:${controlPort}\n`);

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			server.close();
			void stopRelay().finally(() => process.exit(0));
		});
	}

	async function startRelay(): Promise<void> {
		if (node !== undefined) return;
		const next = new DRPNode(config);
		await next.start();
		node = next;
		process.stdout.write(`grid relay fixture ready ${next.networkNode.peerId}\n`);
	}

	async function stopRelay(): Promise<void> {
		const current = node;
		node = undefined;
		await current?.stop();
	}
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(payload));
}
