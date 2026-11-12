/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// G25 cross-version probe for the last-member frontier (SettlementPlan.memberFrontier; no schema bump).
// One store directory, two processes: "setup" (this code) removes the author, so the removing close
// stores the frontier, and installs past it; "continue" reopens the SAME directory and keeps installing.
// The driver runs "continue" from a checkout of the code before the frontier existed (downgrade: it must
// fail closed, refusing the unknown plan field, and leave the native image exactly as it was) and then
// from this code again (it must continue). Skipped unless MEMBER_FRONTIER_VERSION_PHASE is set.
const PHASE = process.env.MEMBER_FRONTIER_VERSION_PHASE;
const DIRECTORY = process.env.MEMBER_FRONTIER_VERSION_DIRECTORY;
const MOVE = "frontier-version-move";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
const fixture = (directory: string, localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
	chatSharesRoomFixture({ directory, members: ["genesis"], format: "window", localMembers: [1],
		...(localSelectors === undefined ? {} : { localSelectors }), genesisStateBytes: createShippingChatWindowGenesisStateBytes });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;

function issuanceFile(directory: string): string {
	const found: string[] = [];
	const walk = (path: string): void => { for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) walk(child); else if (entry.name.endsWith(".drp-issuance-v1.sqlite")) found.push(child);
	} };
	walk(join(directory, "local-sessions"));
	return required(found.length === 1 ? found[0] : undefined);
}
/** The member's complete native issuance image (every row of every table), read-only. */
function nativeImage(directory: string) {
	const database = new DatabaseSync(issuanceFile(directory), { readOnly: true });
	try {
		const tables = ["lineages", "issued_records", "issuance_outbox", "settlement_plans", "retirement_controls"];
		return Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table}`).all().map(row =>
			JSON.stringify(row, (_key, value: unknown) => value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value))]));
	} finally { database.close(); }
}

async function roll(f: Fixture, creator: Peer, member: Peer, log: unknown[], label: string) {
	try {
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		log.push({ label, epoch: member.room.authority().epoch });
		return true;
	} catch (cause) {
		const chain: string[] = [];
		for (let value: unknown = cause; value instanceof Error && chain.length < 8; value = value.cause) chain.push(value.message);
		log.push({ label, error: chain });
		return false;
	}
}

it.runIf(PHASE === "setup")("setup: remove the author so the removing close stores its frontier", async () => {
	const directory = required(DIRECTORY), log: unknown[] = [];
	const f = await fixture(directory);
	const creator = await f.open(0), member = await f.open(1);
	await member.room.issue(message(MOVE));
	expect(await creator.receive(await f.issuedAfter(1, null), 1, 30_000)).toBe(true);
	expect(await roll(f, creator, member, log, "member")).toBe(true);
	await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: required(f.identities[1]).author });
	for (let seal = 0; seal < 2; seal++) expect(await roll(f, creator, member, log, `removed-${seal}`)).toBe(true);
	const plan = await f.withIssuance(1, store => store.readSettlementPlan({ objectId: f.objectId, author: required(f.identities[1]).author }));
	expect(plan?.memberFrontier).toBeDefined();
	writeFileSync(join(directory, "setup.json"), JSON.stringify({ selectors: f.localSelectors, log }));
	writeFileSync(join(directory, "image-setup.json"), JSON.stringify(nativeImage(directory)));
	console.info(`MEMBER_FRONTIER_VERSION setup ${JSON.stringify(log)}`);
}, 300_000);

it.runIf(PHASE === "continue")("continue: reopen the same stores and keep installing", async () => {
	const directory = required(DIRECTORY), label = required(process.env.MEMBER_FRONTIER_VERSION_LABEL), log: unknown[] = [];
	const setup = JSON.parse(readFileSync(join(directory, "setup.json"), "utf8")) as
		{ selectors: Record<number, { slot: number; incarnation: number }> };
	const f = await fixture(directory, setup.selectors);
	let ok = true;
	try {
		const creator = await f.open(0, { reopen: true });
		const member = await f.open(1, { reopen: true, promote: true });
		log.push({ label: "reopened", epoch: member.room.authority().epoch });
		for (let seal = 0; seal < 2 && ok; seal++) ok = await roll(f, creator, member, log, `continue-${seal}`);
		if (ok) expect(creator.room.projection().messages.filter(entry => entry.clientOperationId === MOVE)).toHaveLength(1);
	} catch (cause) {
		ok = false;
		const chain: string[] = [];
		for (let value: unknown = cause; value instanceof Error && chain.length < 8; value = value.cause) chain.push(value.message);
		log.push({ label: "open", error: chain });
	}
	writeFileSync(join(directory, `continue-${label}.json`), JSON.stringify({ ok, log }));
	writeFileSync(join(directory, `image-${label}.json`), JSON.stringify(nativeImage(directory)));
	for (const row of log) console.info(`MEMBER_FRONTIER_VERSION continue ${label} ${JSON.stringify(row)}`);
	if (process.env.MEMBER_FRONTIER_VERSION_EXPECT === "refused") expect(ok).toBe(false);
	else expect(ok).toBe(true);
}, 300_000);
