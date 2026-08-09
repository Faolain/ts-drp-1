import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";

let server: AssetServer | undefined;
let directory: string | undefined;

afterEach(async () => {
	if (server !== undefined) await server.close();
	if (directory !== undefined) fs.rmSync(directory, { recursive: true, force: true });
	server = undefined;
	directory = undefined;
});

describe("closed browser asset server controls", () => {
	it("serves only token-owned assets with isolation and no-store headers", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2b-server-"));
		for (const name of ["index.html", "phase-2e7.html", "phase-2e7-publication-component.js"])
			fs.writeFileSync(path.join(directory, name), name);
		server = await startAssetServer(directory);
		const transitionURL = server.issueTransitionURL();
		const response = await fetch(transitionURL);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
		expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
		expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
		const componentURL = server.issueTransitionURL("phase-2e7.html");
		expect((await fetch(componentURL)).status).toBe(200);
		const componentToken = new URL(componentURL).pathname.split("/")[2] ?? "";
		expect(
			(await fetch(`${server.baseURL}/transition/${componentToken}/phase-2e7-publication-component.js`)).status
		).toBe(200);
		const token = new URL(transitionURL).pathname.split("/")[2] ?? "";
		expect((await fetch(`${server.baseURL}/transition/${token}/unknown.js`)).status).toBe(404);
		expect((await fetch(`${server.baseURL}/transition/${token}/..%2Findex.html`)).status).toBe(404);
		server.revoke(token);
		expect((await fetch(transitionURL)).status).toBe(404);
	});
});
