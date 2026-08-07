import { expect, test } from "@playwright/test";
import { fork } from "node:child_process";
import path from "node:path";

import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";
import { parseBrowserSmokeChildMessage, type WorkerToPageMessage } from "./fixtures/worker-protocol.js";

let server: AssetServer;

test.beforeAll(async () => {
	const assetDirectory = process.env.PHASE_2B_ASSET_DIR;
	if (assetDirectory === undefined) throw new TypeError("PHASE_2B_ASSET_DIR was not installed by global setup");
	server = await startAssetServer(assetDirectory);
});

test.afterAll(async () => {
	await server.close();
});

function runBrowserChild(url: string): Promise<WorkerToPageMessage> {
	const assetDirectory = process.env.PHASE_2B_ASSET_DIR;
	if (assetDirectory === undefined) return Promise.reject(new TypeError("PHASE_2B_ASSET_DIR is unavailable"));
	return new Promise((resolve, reject) => {
		const child = fork(path.join(assetDirectory, "browser-smoke-child.js"), [], {
			env: { ...process.env, PHASE_2B_SMOKE_URL: url },
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		let result: WorkerToPageMessage | undefined;
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new TypeError("browser smoke child exceeded 30 seconds"));
		}, 30_000);
		child.on("message", (message: unknown) => {
			const parsed = parseBrowserSmokeChildMessage(message);
			if (parsed === undefined) {
				reject(new TypeError("browser smoke child emitted malformed IPC"));
				return;
			}
			if (parsed.kind === "smoke-result") result = parsed.result;
			else reject(new TypeError(parsed.detail));
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (code !== 0 || signal !== null || result === undefined) {
				reject(new TypeError(`browser smoke child exit code=${String(code)} signal=${String(signal)}`));
				return;
			}
			resolve(result);
		});
	});
}

test("causal browser RED reaches the closed inert Worker failure", async () => {
	const transitionURL = server.issueTransitionURL();
	const result = await runBrowserChild(transitionURL);
	server.revoke(new URL(transitionURL).pathname.split("/")[2] ?? "");
	const detail = result.kind === "failure" ? `${result.code}: ${result.detail}` : "Worker unexpectedly completed";
	expect(result, detail).toMatchObject({ kind: "hit", id: "database-open", edge: "before" });
});
