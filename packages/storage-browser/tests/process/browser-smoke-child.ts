import { type BrowserContext, chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseWorkerToPageMessage, type WorkerToPageMessage } from "../fixtures/worker-protocol.js";

async function run(): Promise<void> {
	const url = process.env.PHASE_2B_SMOKE_URL;
	if (url === undefined) throw new TypeError("PHASE_2B_SMOKE_URL is required");
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2b-smoke-profile-"));
	let context: BrowserContext | undefined;
	try {
		context = await chromium.launchPersistentContext(profile, { headless: true });
		const page = context.pages()[0] ?? (await context.newPage());
		await page.goto(url);
		const untrustedResult = await page.evaluate<unknown>(() =>
			window.phase2bRun({ id: "database-open", edge: "before" })
		);
		const result: WorkerToPageMessage | undefined = parseWorkerToPageMessage(untrustedResult);
		if (result === undefined) throw new TypeError("page relayed a message outside the closed Worker protocol");
		process.send?.({ kind: "smoke-result", version: 1, result });
	} finally {
		if (context !== undefined) await context.close();
		fs.rmSync(profile, { recursive: true, force: true });
	}
}

void run().catch((error: unknown) => {
	process.send?.({
		kind: "smoke-error",
		version: 1,
		detail: error instanceof Error ? error.message : "unknown browser smoke failure",
	});
	process.exitCode = 1;
});
