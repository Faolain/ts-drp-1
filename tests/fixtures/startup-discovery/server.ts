import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
/**
 *
 * @param directory
 */
export async function server(directory: string): Promise<{ origin: string; close(): Promise<void> }> {
	const bundles = new Map(
		["setup", "recovery", "lifecycle", "shipped"].map((name) => [
			"/" + name + ".mjs",
			readFileSync(join(directory, name, "entry.mjs")),
		])
	);
	const owned = createServer((request, response) => {
		const script = bundles.get(request.url ?? "");
		if (script !== undefined)
			response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(script);
		else if (["/setup", "/recovery", "/lifecycle", "/shipped"].includes(request.url ?? ""))
			response
				.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
				.end(`<!doctype html><script type=module src="${request.url}.mjs"></script>`);
		else response.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) => {
		owned.once("error", reject);
		owned.listen(0, "127.0.0.1", resolve);
	});
	const address = owned.address();
	if (address === null || typeof address === "string") throw new Error("STARTUP_SERVER_ADDRESS");
	const origin = `http://127.0.0.1:${address.port}`;
	console.log(JSON.stringify({ lane: "startup-server-open", origin, pid: process.pid, directory }));
	return {
		origin,
		close: async (): Promise<void> => {
			await new Promise<void>((resolve, reject) => owned.close((error) => (error ? reject(error) : resolve())));
			console.log(JSON.stringify({ lane: "startup-server-closed", origin, pid: process.pid }));
		},
	};
}
