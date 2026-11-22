import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { server } from "./fixtures/signed-anchor-mechanism/browser-server.js";
import { expected, operations } from "./fixtures/signed-anchor-close-regression/causal.js";

test("actual browser IDB capture-close", { timeout: 360000 }, async (suite) => {
	const artifacts = process.env.SIGNED_ANCHOR_ARTIFACTS;
	if (!artifacts) throw new Error("FROZEN_BUNDLES_REQUIRED");
	const local = await server(artifacts);
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	try {
		const launched = await chromium.launch({ headless: true });
		browser = launched;
		for (const operation of [...operations, "positive"] as const)
			await suite.test(operation, { timeout: 90000 }, async () => {
				const context = await launched.newContext(),
					page = await context.newPage();
				try {
					await page.goto(local.origin + "/work");
					await page.waitForFunction(() => typeof Reflect.get(globalThis, "captureCloseRun") === "function");
					const observed = await page.evaluate(
						({ identity, operation }) => Reflect.get(globalThis, "captureCloseRun")(identity, operation),
						{ identity: "signed-anchor-close-red-" + randomUUID(), operation }
					);
					console.log(JSON.stringify(observed));
					assert.equal(observed.lifecycleJoined, true);
					assert.equal(observed.cleanupTerminal, "success");
					if (operation === "positive")
						assert.deepEqual(observed.receipt, {
							captureOk: true,
							importOk: true,
							readOk: true,
							kind: "present",
							exactAnchor: true,
						});
					else
						assert.deepEqual(
							observed.receipt,
							expected(observed.receipt),
							"whole typed shutdown refusal and no actual durable import"
						);
				} finally {
					await context.close();
				}
			});
	} finally {
		try {
			await browser?.close();
		} finally {
			await local.close();
		}
	}
});
