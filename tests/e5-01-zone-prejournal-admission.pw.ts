import { expect, type Page, test } from "@playwright/test";

interface Approval {
	readonly signatureHex: string;
	readonly signer: string;
}

interface PreparedIntent {
	readonly clientOperationId: string;
	readonly exactCanonicalIntentHex: string;
	readonly exactCanonicalPayloadHex: string;
}

interface CommitInput {
	readonly approvals: readonly Approval[];
	readonly exactCanonicalIntentHex: string;
	readonly exactCanonicalPayloadHex: string;
}

interface Snapshot {
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localAuthor: string;
	readonly outcomeCount: number;
	readonly tradeIntent: Readonly<{ readonly clientOperationId?: string; readonly status: string }>;
}

interface ZoneApi {
	approveTradeIntent(input: Omit<CommitInput, "approvals">): Promise<Approval>;
	close(): Promise<void>;
	commitTradeIntent(input: CommitInput): Promise<Readonly<{ readonly kind: "accepted" | "duplicate" }>>;
	create(memberEnrollments: readonly string[]): Promise<void>;
	join(invite: string): Promise<void>;
	prepareTradeIntent(
		input: Readonly<{
			readonly clientOperationId: string;
			readonly counterpartyAuthor: string;
			readonly offeredAsset: string;
			readonly requestedAsset: string;
		}>
	): Promise<PreparedIntent>;
	snapshot(): Snapshot;
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

async function snapshot(page: Page): Promise<Snapshot> {
	return page.evaluate(() => {
		const api = window.__TS_DRP_V3_ZONE__;
		if (api === undefined) throw new Error("E501_ZONE_API_ABSENT");
		return api.snapshot();
	});
}

async function prepareAndApprove(
	alice: Page,
	bob: Page,
	clientOperationId: string,
	offeredAsset = "crystal"
): Promise<CommitInput> {
	const bobAuthor = (await snapshot(bob)).localAuthor;
	const prepared = await alice.evaluate((input) => window.__TS_DRP_V3_ZONE__?.prepareTradeIntent(input), {
		clientOperationId,
		counterpartyAuthor: bobAuthor,
		offeredAsset,
		requestedAsset: "ore",
	});
	if (prepared === undefined) throw new Error("E501_PREPARED_INTENT_ABSENT");
	const proof = {
		exactCanonicalIntentHex: prepared.exactCanonicalIntentHex,
		exactCanonicalPayloadHex: prepared.exactCanonicalPayloadHex,
	};
	const approvals = await Promise.all([
		alice.evaluate((input) => window.__TS_DRP_V3_ZONE__?.approveTradeIntent(input), proof),
		bob.evaluate((input) => window.__TS_DRP_V3_ZONE__?.approveTradeIntent(input), proof),
	]);
	if (approvals[0] === undefined || approvals[1] === undefined) throw new Error("E501_APPROVAL_ABSENT");
	return Object.freeze({ ...proof, approvals });
}

test("two real members admit one co-signed outcome before journal and recover it exactly once", async ({ browser }) => {
	test.setTimeout(180_000);
	const aliceContext = await browser.newContext();
	const bobContext = await browser.newContext();
	const alice = await aliceContext.newPage();
	const bob = await bobContext.newPage();
	try {
		await Promise.all([openGrid(alice), openGrid(bob)]);
		const ready = await alice.evaluate(() => typeof window.__TS_DRP_V3_ZONE__?.commitTradeIntent === "function");
		expect(ready, "E5-01 GREEN must install the pre-journal commit owner").toBe(true);
		if (!ready) return;

		await alice.evaluate(
			(enrollment) => window.__TS_DRP_V3_ZONE__?.create([enrollment]),
			(await snapshot(bob)).enrollment
		);
		const created = await snapshot(alice);
		await bob.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite);
		await expect.poll(async () => (await snapshot(bob)).durableVertexCount).toBe(2);
		const baseline = (await snapshot(alice)).durableVertexCount;
		const accepted = await prepareAndApprove(alice, bob, "trade-e5-01-0001");

		expect(await alice.evaluate((input) => window.__TS_DRP_V3_ZONE__?.commitTradeIntent(input), accepted)).toEqual({
			kind: "accepted",
		});
		await expect
			.poll(async () => {
				const [left, right] = await Promise.all([snapshot(alice), snapshot(bob)]);
				return [left.durableVertexCount, right.durableVertexCount, left.outcomeCount, right.outcomeCount];
			})
			.toEqual([baseline + 1, baseline + 1, 1, 1]);

		expect(await alice.evaluate((input) => window.__TS_DRP_V3_ZONE__?.commitTradeIntent(input), accepted)).toEqual({
			kind: "duplicate",
		});
		expect((await snapshot(alice)).durableVertexCount).toBe(baseline + 1);

		const badSignature = accepted.approvals[0]?.signatureHex ?? "";
		const tampered = {
			...accepted,
			approvals: [
				{
					...accepted.approvals[0],
					signatureHex: `${badSignature.slice(0, -2)}${badSignature.endsWith("00") ? "01" : "00"}`,
				},
				accepted.approvals[1],
			],
		};
		await expect(
			alice.evaluate((input) => window.__TS_DRP_V3_ZONE__?.commitTradeIntent(input), tampered)
		).rejects.toThrow();

		const conflict = await prepareAndApprove(alice, bob, "trade-e5-01-0001", "ore");
		await expect(
			alice.evaluate((input) => window.__TS_DRP_V3_ZONE__?.commitTradeIntent(input), conflict)
		).rejects.toThrow();
		expect((await snapshot(alice)).durableVertexCount).toBe(baseline + 1);

		await bob.evaluate(() => window.__TS_DRP_V3_ZONE__?.close());
		await bob.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite);
		await expect
			.poll(async () => {
				const value = await snapshot(bob);
				return [value.durableVertexCount, value.outcomeCount, value.tradeIntent.status];
			})
			.toEqual([baseline + 1, 1, "accepted"]);
		expect(await bob.evaluate((input) => window.__TS_DRP_V3_ZONE__?.commitTradeIntent(input), accepted)).toEqual({
			kind: "duplicate",
		});
		expect((await snapshot(bob)).durableVertexCount).toBe(baseline + 1);
		await expect(alice.locator("#tradeIntentWorkbench")).toContainText("accepted");
		await expect(bob.locator("#tradeIntentWorkbench")).toContainText("recovered");
	} finally {
		await Promise.all([aliceContext.close(), bobContext.close()]);
	}
});
