import { expect, type Page, test } from "@playwright/test";

import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";

declare global {
	interface Window {
		phase2lDRun(caseId: "golden-path" | "shared-conformance"): Promise<unknown>;
	}
}

let server: AssetServer;

test.beforeAll(async () => {
	const assetDirectory = process.env.PHASE_2L_D_ASSET_DIR;
	if (assetDirectory === undefined) throw new TypeError("Phase 2l-d global setup did not install assets");
	server = await startAssetServer(assetDirectory);
});

test.afterAll(async () => server.close());

async function run(page: Page, caseId: "golden-path" | "shared-conformance"): Promise<unknown> {
	const url = server.issueTransitionURL("phase-2l-d.html");
	try {
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase2lDRun === "function");
		return await page.evaluate((id) => window.phase2lDRun(id), caseId);
	} finally {
		server.revoke(new URL(url).pathname.split("/")[2] ?? "");
	}
}

test("matches the exact backend-neutral observable report", async ({ page }) => {
	await expect(run(page, "shared-conformance")).resolves.toEqual({
		builderFailures: ["sync-identity", "async-identity"],
		builderFailureOldState: [true, true],
		builderInvocations: 1,
		closedCode: "ISSUANCE_STORE_CLOSED",
		copy: {
			durableDigest: [29, 209],
			durableScope: { author: "author:success", objectId: "object:success" },
			durableSignature: [29, 81],
			freshRead: true,
			returnedDetached: true,
			sourceDetached: true,
			sourceDigest: [29, 209],
		},
		invalidCodes: ["ISSUANCE_INVALID_ARGUMENT", "ISSUANCE_INVALID_ARGUMENT"],
		invalidOldState: [true, true],
		invalidTypeErrors: [true, true],
		malformedCode: "ISSUANCE_COMMIT_INVALID",
		malformedLineage: { exhausted: false, next: 0 },
		malformedOldState: true,
		pendingCount: 1,
		scopeBoundary: {
			accepted1024: true,
			acceptedBuilderCalls: 1,
			rejected1025Code: "ISSUANCE_INVALID_ARGUMENT",
			rejectedBuilderCalls: 0,
		},
	});
});

test("binds the unmodified frozen issuer to durable selection and strict admission", async ({ page }) => {
	await expect(run(page, "golden-path")).resolves.toEqual({
		accepted: true,
		admissionDigestEqual: true,
		authorSequence: 0,
		dependencies: [
			"1212121212121212121212121212121212121212121212121212121212121212",
			"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
		],
		durableClosureEqual: true,
		pendingCount: 1,
	});
});
