import { ed25519 } from "@noble/curves/ed25519.js";
import { expect, type Page, test } from "@playwright/test";
import { resolve } from "node:path";

import { importWorkspacePackageExportFile } from "./fixtures/shared/workspace-package-export-file.mjs";

const { hashDomain } = (
	await importWorkspacePackageExportFile({
		expectedPackageName: "@ts-drp/canonical",
		exportKey: ".",
		packageDirectory: resolve(import.meta.dirname, "../packages/canonical"),
	})
).module as Readonly<{ hashDomain(domain: string, bytes: Uint8Array): Uint8Array }>;

interface Approval {
	readonly signatureHex: string;
	readonly signer: string;
}

interface PreparedIntent {
	readonly exactCanonicalIntentHex: string;
	readonly exactCanonicalPayloadHex: string;
	readonly registeredDigestHex: string;
}

interface Snapshot {
	readonly aclVersion: 1 | 2;
	readonly aclMembers: readonly Readonly<{ readonly author: string; readonly groups: readonly string[] }>[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localAuthor: string;
	readonly localRoles: readonly string[];
	readonly outcomeCount: number;
	readonly tradeIntent: Readonly<{ readonly status: string }>;
}

interface ZoneApi {
	approveTradeIntentAsReferee(
		input: Readonly<{
			readonly exactCanonicalIntentHex: string;
			readonly exactCanonicalPayloadHex: string;
		}>
	): Promise<Approval>;
	close(): Promise<void>;
	commitTradeIntent(
		input: Readonly<{
			readonly approvals: readonly Approval[];
			readonly exactCanonicalIntentHex: string;
			readonly exactCanonicalPayloadHex: string;
		}>
	): Promise<Readonly<{ readonly kind: "accepted" | "duplicate" }>>;
	create(memberEnrollments: readonly string[]): Promise<void>;
	join(invite: string): Promise<void>;
	placeBlock(
		input: Readonly<{ readonly id: string; readonly kind: string; readonly x: number; readonly y: number }>
	): Promise<void>;
	prepareTradeIntent(
		input: Readonly<{
			readonly clientOperationId: string;
			readonly counterpartyAuthor: string;
			readonly offeredAsset: string;
			readonly requestedAsset: string;
		}>
	): Promise<PreparedIntent>;
	setRefereeRole(input: Readonly<{ readonly author: string; readonly enabled: boolean }>): Promise<void>;
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
		if (api === undefined) throw new Error("E502_ZONE_API_ABSENT");
		return api.snapshot();
	});
}

function groupsFor(value: Snapshot, author: string): readonly string[] | undefined {
	return value.aclMembers.find((member) => member.author === author)?.groups;
}

function bytes(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "hex"));
}

test("one current referee decision makes one writer-issued outcome durable across reconnect", async ({ browser }) => {
	test.setTimeout(180_000);
	const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
	const [alice, bob, referee] = await Promise.all(contexts.map((context) => context.newPage()));
	try {
		await Promise.all([openGrid(alice), openGrid(bob), openGrid(referee)]);
		const ready = await alice.evaluate(
			() =>
				typeof window.__TS_DRP_V3_ZONE__?.setRefereeRole === "function" &&
				typeof window.__TS_DRP_V3_ZONE__?.approveTradeIntentAsReferee === "function"
		);
		expect(ready, "E5-02 GREEN must install the three-client referee outcome owner").toBe(true);
		if (!ready) return;

		const [bobEnrollment, refereeEnrollment] = await Promise.all([snapshot(bob), snapshot(referee)]);
		await alice.evaluate(
			(enrollments) => window.__TS_DRP_V3_ZONE__?.create(enrollments),
			[bobEnrollment.enrollment, refereeEnrollment.enrollment]
		);
		const created = await snapshot(alice);
		await Promise.all([
			bob.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite),
			referee.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite),
		]);
		await expect.poll(async () => (await snapshot(referee)).durableVertexCount).toBe(3);
		const refereeAuthor = (await snapshot(referee)).localAuthor;
		await expect
			.poll(async () => {
				const values = await Promise.all([snapshot(alice), snapshot(bob), snapshot(referee)]);
				return values.map((value) => [value.aclVersion, groupsFor(value, refereeAuthor)]);
			})
			.toEqual([
				[2, ["writer"]],
				[2, ["writer"]],
				[2, ["writer"]],
			]);
		const roleBaseline = (await snapshot(alice)).durableVertexCount;
		await alice.evaluate(
			(author) => window.__TS_DRP_V3_ZONE__?.setRefereeRole({ author, enabled: true }),
			refereeAuthor
		);
		await expect
			.poll(async () => {
				const values = await Promise.all([snapshot(alice), snapshot(bob), snapshot(referee)]);
				return values.map((value) => [value.durableVertexCount, value.aclVersion, groupsFor(value, refereeAuthor)]);
			})
			.toEqual([
				[roleBaseline + 2, 2, ["referee"]],
				[roleBaseline + 2, 2, ["referee"]],
				[roleBaseline + 2, 2, ["referee"]],
			]);
		await expect(
			referee.evaluate(() =>
				window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "referee-must-not-write", kind: "stone", x: 1, y: 1 })
			)
		).rejects.toThrow();
		await referee.evaluate(() => window.__TS_DRP_V3_ZONE__?.close());
		await referee.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite);
		await expect
			.poll(async () => {
				const value = await snapshot(referee);
				return [value.aclVersion, value.localRoles, groupsFor(value, refereeAuthor)];
			})
			.toEqual([2, ["referee"], ["referee"]]);
		await expect(
			referee.evaluate(() =>
				window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "recovered-referee-must-not-write", kind: "stone", x: 2, y: 2 })
			)
		).rejects.toThrow();

		const bobAuthor = (await snapshot(bob)).localAuthor;
		const prepared = await alice.evaluate(
			(counterpartyAuthor) =>
				window.__TS_DRP_V3_ZONE__?.prepareTradeIntent({
					clientOperationId: "trade-e5-02-0001",
					counterpartyAuthor,
					offeredAsset: "crystal",
					requestedAsset: "ore",
				}),
			bobAuthor
		);
		if (prepared === undefined) throw new Error("E502_PREPARED_INTENT_ABSENT");
		const decision = await referee.evaluate((input) => window.__TS_DRP_V3_ZONE__?.approveTradeIntentAsReferee(input), {
			exactCanonicalIntentHex: prepared.exactCanonicalIntentHex,
			exactCanonicalPayloadHex: prepared.exactCanonicalPayloadHex,
		});
		if (decision === undefined) throw new Error("E502_REFEREE_DECISION_ABSENT");
		expect(decision.signer).toBe(refereeAuthor);
		expect(
			ed25519.verify(
				bytes(decision.signatureHex),
				hashDomain("ts-drp/outcome-intent/v1", bytes(prepared.exactCanonicalIntentHex)),
				bytes(decision.signer),
				{ zip215: false }
			)
		).toBe(true);

		const baseline = (await snapshot(alice)).durableVertexCount;
		const commitInput = {
			approvals: [decision],
			exactCanonicalIntentHex: prepared.exactCanonicalIntentHex,
			exactCanonicalPayloadHex: prepared.exactCanonicalPayloadHex,
		};
		expect(await alice.evaluate((input) => window.__TS_DRP_V3_ZONE__?.commitTradeIntent(input), commitInput)).toEqual({
			kind: "accepted",
		});
		await expect
			.poll(async () => {
				const values = await Promise.all([snapshot(alice), snapshot(bob), snapshot(referee)]);
				return values.map(({ durableVertexCount, outcomeCount }) => [durableVertexCount, outcomeCount]);
			})
			.toEqual([
				[baseline + 1, 1],
				[baseline + 1, 1],
				[baseline + 1, 1],
			]);

		await referee.evaluate(() => window.__TS_DRP_V3_ZONE__?.close());
		await referee.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite);
		await expect.poll(async () => (await snapshot(referee)).tradeIntent.status).toBe("recovered");
		await expect(referee.locator("#tradeIntentWorkbench")).toContainText("referee");
		await expect(referee.locator("#tradeIntentWorkbench")).toContainText("signed");
	} finally {
		await Promise.all(contexts.map((context) => context.close()));
	}
});
