import { ed25519 } from "@noble/curves/ed25519.js";
import { expect, type Page, test } from "@playwright/test";
import { resolve } from "node:path";

import { importWorkspacePackageExportFile } from "./fixtures/shared/workspace-package-export-file.mjs";

const { decodeCanonical, hashDomain } = (
	await importWorkspacePackageExportFile({
		expectedPackageName: "@ts-drp/canonical",
		exportKey: ".",
		packageDirectory: resolve(import.meta.dirname, "../packages/canonical"),
	})
).module as Readonly<{
	decodeCanonical(bytes: Uint8Array): unknown;
	hashDomain(domain: string, bytes: Uint8Array): Uint8Array;
}>;

interface TradeApproval {
	readonly signatureHex: string;
	readonly signer: string;
}

interface PreparedTradeIntent {
	readonly clientOperationId: string;
	readonly exactCanonicalIntentHex: string;
	readonly exactCanonicalPayloadHex: string;
	readonly intentDigest: string;
	readonly registeredDigestHex: string;
}

interface ZoneSnapshot {
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localAuthor: string;
	readonly outcomeContext: Readonly<{
		readonly aclDigest: string;
		readonly anchorDigest: string;
		readonly epoch: number;
		readonly objectId: string;
	}> | null;
	readonly tradeIntent: Readonly<{
		readonly aclDigest: string;
		readonly approvalCount: number;
		readonly anchorDigest: string;
		readonly clientOperationId: string;
		readonly counterparties: readonly string[];
		readonly epoch: number;
		readonly intentDigest: string;
		readonly objectId: string;
		readonly outcomeKind: string;
		readonly status: "absent" | "approved" | "pending" | "ready";
	}>;
}

interface ZoneApi {
	approveTradeIntent(
		input: Readonly<{
			readonly exactCanonicalIntentHex: string;
			readonly exactCanonicalPayloadHex: string;
		}>
	): Promise<TradeApproval>;
	create(memberEnrollments: readonly string[]): Promise<void>;
	finalizeTradeIntent(
		input: Readonly<{
			readonly approvals: readonly TradeApproval[];
			readonly exactCanonicalIntentHex: string;
			readonly exactCanonicalPayloadHex: string;
		}>
	): Promise<Readonly<{ readonly action: "commit-outcome-v1"; readonly clientOperationId: string }>>;
	join(invite: string): Promise<void>;
	prepareTradeIntent(
		input: Readonly<{
			readonly clientOperationId: string;
			readonly counterpartyAuthor: string;
			readonly offeredAsset: string;
			readonly requestedAsset: string;
		}>
	): Promise<PreparedTradeIntent>;
	snapshot(): ZoneSnapshot;
}

declare global {
	interface Window {
		readonly __TS_DRP_V3_ZONE__?: ZoneApi;
	}
}

async function openGrid(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => window.__TS_DRP_V3_ZONE__ !== undefined);
	await expect(page.locator("#loadingMessage")).toBeHidden();
}

async function zone(page: Page): Promise<ZoneSnapshot> {
	return page.evaluate(() => {
		const api = window.__TS_DRP_V3_ZONE__;
		if (api === undefined) throw new Error("E500_ZONE_API_ABSENT");
		return api.snapshot();
	});
}

function bytes(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "hex"));
}

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

test("two real zone members co-sign one reviewable trade intent without durable application", async ({ browser }) => {
	test.setTimeout(180_000);
	const aliceContext = await browser.newContext();
	const bobContext = await browser.newContext();
	const alice = await aliceContext.newPage();
	const bob = await bobContext.newPage();
	try {
		await Promise.all([openGrid(alice), openGrid(bob)]);
		const aliceApiReady = await alice.evaluate(() => {
			const api = window.__TS_DRP_V3_ZONE__;
			return (
				typeof api?.prepareTradeIntent === "function" &&
				typeof api.approveTradeIntent === "function" &&
				typeof api.finalizeTradeIntent === "function"
			);
		});
		expect(aliceApiReady, "E5-00 GREEN must install the co-signed trade-intent owner").toBe(true);
		if (!aliceApiReady) return;

		const bobEnrollment = (await zone(bob)).enrollment;
		await alice.evaluate((member) => window.__TS_DRP_V3_ZONE__?.create([member]), bobEnrollment);
		const created = await zone(alice);
		await bob.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite);
		await expect
			.poll(async () => {
				const [aliceSnapshot, bobSnapshot] = await Promise.all([zone(alice), zone(bob)]);
				return [aliceSnapshot.durableVertexCount, bobSnapshot.durableVertexCount];
			})
			.toEqual([2, 2]);
		const [aliceJoined, bobJoined] = await Promise.all([zone(alice), zone(bob)]);
		expect(aliceJoined.outcomeContext).toEqual(bobJoined.outcomeContext);
		if (aliceJoined.outcomeContext === null) throw new Error("E500_OUTCOME_CONTEXT_ABSENT");
		const bobAuthor = bobJoined.localAuthor;
		const durableBaseline = aliceJoined.durableVertexCount;
		const prepared = await alice.evaluate(
			({ clientOperationId, counterpartyAuthor }) =>
				window.__TS_DRP_V3_ZONE__?.prepareTradeIntent({
					clientOperationId,
					counterpartyAuthor,
					offeredAsset: "crystal",
					requestedAsset: "ore",
				}),
			{ clientOperationId: "trade-browser-0001", counterpartyAuthor: bobAuthor }
		);
		if (prepared === undefined) throw new Error("E500_PREPARED_INTENT_ABSENT");
		const registeredDigest = hashDomain("ts-drp/outcome-intent/v1", bytes(prepared.exactCanonicalIntentHex));
		const decodedIntent = decodeCanonical(bytes(prepared.exactCanonicalIntentHex));
		expect(prepared.registeredDigestHex).toBe(hex(registeredDigest));
		expect(prepared.intentDigest).toBe(hex(registeredDigest));
		expect(decodedIntent).toEqual({
			...aliceJoined.outcomeContext,
			clientOperationId: "trade-browser-0001",
			counterparties: [aliceJoined.localAuthor, bobAuthor].sort(),
			kind: "ts-drp-outcome-intent",
			outcomeKind: "same-zone-trade-v1",
			payloadDigest: hex(hashDomain("ts-drp/outcome-payload/v1", bytes(prepared.exactCanonicalPayloadHex))),
			version: 1,
		});
		expect((await zone(alice)).tradeIntent).toEqual({
			...aliceJoined.outcomeContext,
			approvalCount: 0,
			clientOperationId: "trade-browser-0001",
			counterparties: [aliceJoined.localAuthor, bobAuthor].sort(),
			intentDigest: prepared.intentDigest,
			outcomeKind: "same-zone-trade-v1",
			status: "pending",
		});
		const approvalInput = {
			exactCanonicalIntentHex: prepared.exactCanonicalIntentHex,
			exactCanonicalPayloadHex: prepared.exactCanonicalPayloadHex,
		};
		const [aliceApproval, bobApproval] = await Promise.all([
			alice.evaluate((intent) => window.__TS_DRP_V3_ZONE__?.approveTradeIntent(intent), approvalInput),
			bob.evaluate((intent) => window.__TS_DRP_V3_ZONE__?.approveTradeIntent(intent), approvalInput),
		]);
		if (aliceApproval === undefined || bobApproval === undefined) throw new Error("E500_APPROVAL_ABSENT");
		expect(new Set([aliceApproval.signer, bobApproval.signer])).toEqual(
			new Set([(await zone(alice)).localAuthor, bobAuthor])
		);
		for (const selected of [aliceApproval, bobApproval]) {
			expect(
				ed25519.verify(bytes(selected.signatureHex), registeredDigest, bytes(selected.signer), { zip215: false })
			).toBe(true);
		}
		const finalIntentByte = prepared.exactCanonicalIntentHex.slice(-2);
		const tamperedIntentHex = `${prepared.exactCanonicalIntentHex.slice(0, -2)}${finalIntentByte === "00" ? "01" : "00"}`;
		expect(tamperedIntentHex).not.toBe(prepared.exactCanonicalIntentHex);
		await expect(
			bob.evaluate((input) => window.__TS_DRP_V3_ZONE__?.approveTradeIntent(input), {
				...approvalInput,
				exactCanonicalIntentHex: tamperedIntentHex,
			})
		).rejects.toThrow();
		const foreignPrepared = await alice.evaluate((input) => window.__TS_DRP_V3_ZONE__?.prepareTradeIntent(input), {
			clientOperationId: "trade-browser-foreign",
			counterpartyAuthor: "44".repeat(32),
			offeredAsset: "crystal",
			requestedAsset: "ore",
		});
		if (foreignPrepared === undefined) throw new Error("E500_FOREIGN_INTENT_ABSENT");
		await expect(
			bob.evaluate((input) => window.__TS_DRP_V3_ZONE__?.approveTradeIntent(input), {
				exactCanonicalIntentHex: foreignPrepared.exactCanonicalIntentHex,
				exactCanonicalPayloadHex: foreignPrepared.exactCanonicalPayloadHex,
			})
		).rejects.toThrow();
		const operation = await alice.evaluate((input) => window.__TS_DRP_V3_ZONE__?.finalizeTradeIntent(input), {
			...approvalInput,
			approvals: [bobApproval, aliceApproval],
		});
		expect(operation).toEqual({ action: "commit-outcome-v1", clientOperationId: "trade-browser-0001" });
		const [aliceFinal, bobFinal] = await Promise.all([zone(alice), zone(bob)]);
		expect(aliceFinal.durableVertexCount).toBe(durableBaseline);
		expect(bobFinal.durableVertexCount).toBe(durableBaseline);
		expect(aliceFinal.tradeIntent).toEqual({
			...aliceJoined.outcomeContext,
			approvalCount: 2,
			clientOperationId: "trade-browser-0001",
			counterparties: [aliceJoined.localAuthor, bobAuthor].sort(),
			intentDigest: prepared.intentDigest,
			outcomeKind: "same-zone-trade-v1",
			status: "ready",
		});
		expect(bobFinal.tradeIntent).toEqual({
			...aliceJoined.outcomeContext,
			approvalCount: 1,
			clientOperationId: "trade-browser-0001",
			counterparties: [aliceJoined.localAuthor, bobAuthor].sort(),
			intentDigest: prepared.intentDigest,
			outcomeKind: "same-zone-trade-v1",
			status: "approved",
		});
		await expect(alice.locator("#tradeIntentWorkbench")).toContainText("ready");
		await expect(alice.locator("#tradeIntentWorkbench")).toContainText("2 / 2 approvals");
		await expect(bob.locator("#tradeIntentWorkbench")).toContainText("approved");
	} finally {
		await Promise.all([aliceContext.close(), bobContext.close()]);
	}
});
