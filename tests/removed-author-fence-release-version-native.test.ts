/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { afterEach, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durableIssuancePruningMaintenanceForStore } from "../packages/issuance-store/src/maintenance.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// Cross-version probe for the removed-author FENCE release (no format change, new law).
// One store directory, two processes: "setup" removes the author and rolls past the
// retained window; "continue" reopens the SAME directory and keeps rolling, then
// re-admits. The driver runs each phase against a chosen issuance-store dist (the
// c08d8680 law or the release law), so upgrade and downgrade are real reopenings.
// Skipped unless FENCE_VERSION_PHASE is set.
const PHASE = process.env.FENCE_VERSION_PHASE;
const DIRECTORY = process.env.FENCE_VERSION_DIRECTORY;

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
const fixture = (directory: string, localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
	chatSharesRoomFixture({ directory, members: ["genesis"], format: "window", localMembers: [1],
		...(localSelectors === undefined ? {} : { localSelectors }), genesisStateBytes: createShippingChatWindowGenesisStateBytes });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;

async function image(f: Fixture) {
	const author = required(f.identities[1]).author, scope = { objectId: f.objectId, author };
	return f.withIssuance(1, async (store) => {
		const maintenance = required(durableIssuancePruningMaintenanceForStore(store));
		const control = await required(maintenance.acquireRetirementControl)({ objectId: f.objectId });
		const { completed, active } = control.control; await control.release();
		const plan = await store.readSettlementPlan(scope);
		return { fenceSequence: plan?.fenceSequence ?? null, entries: plan?.entries.map(entry => entry.sourceSequence) ?? [],
			next: (await store.readLineage(scope)).next, active: active !== null,
			holes: completed?.protectedRecords.filter(hole => hole.author === author).map(hole => hole.authorSequence) ?? null,
			throughEpoch: completed?.throughEpoch ?? null,
			prunedThrough: (await maintenance.inspectPruningState(scope)).prunedThroughAuthorSequence };
	});
}

async function roll(f: Fixture, creator: Peer, member: Peer, log: unknown[], label: string) {
	try {
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		log.push({ label, epoch: member.room.authority().epoch, ...(await image(f)) });
		return true;
	} catch (cause) {
		const chain: string[] = [];
		for (let value: unknown = cause; value instanceof Error && chain.length < 8; value = value.cause) chain.push(value.message);
		log.push({ label, error: chain });
		return false;
	}
}

it.runIf(PHASE === "setup")("setup: remove the author and roll past the retained window", async () => {
	const directory = required(DIRECTORY), log: unknown[] = [];
	const f = await fixture(directory);
	const creator = await f.open(0), member = await f.open(1);
	// T9 shape: the abandoned source is the removed author's terminal custody, which a
	// cold reopen needs (a removed author holding only a retained fence cannot promote).
	Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false));
	await member.room.issue(message("before-removal")).catch(() => undefined);
	await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: required(f.identities[1]).author });
	expect(await roll(f, creator, member, log, "revoked")).toBe(true);
	const unresolved = required((await member.room.unresolvedAcceptedWork())[0]);
	await member.room.abandonUnresolvedAcceptedWork({ sourceSequence: unresolved.sourceSequence,
		sourceDigest: unresolved.sourceDigest, sourceContextDigest: unresolved.sourceContextDigest });
	for (let seal = 0; seal < 5; seal++) expect(await roll(f, creator, member, log, `setup-${seal}`)).toBe(true);
	writeFileSync(join(directory, "setup.json"), JSON.stringify({ selectors: f.localSelectors, log }));
	console.info(`FENCE_VERSION setup ${JSON.stringify(log.at(-1))}`);
}, 300_000);

it.runIf(PHASE === "continue")("continue: reopen the same stores, keep rolling, re-admit", async () => {
	const directory = required(DIRECTORY), log: unknown[] = [];
	const setup = JSON.parse(readFileSync(join(directory, "setup.json"), "utf8")) as
		{ selectors: Record<number, { slot: number; incarnation: number }> };
	const f = await fixture(directory, setup.selectors);
	let ok = true;
	try {
		let stage = "open-creator";
		const opened = await (async () => {
			const creator = await f.open(0, { reopen: true });
			stage = "open-member";
			return { creator, member: await f.open(1, { reopen: true, promote: true }) };
		})().catch((cause: unknown) => { throw new Error(stage, { cause }); });
		const { creator, member } = opened;
		log.push({ label: "reopened", unresolved: (await member.room.unresolvedAcceptedWork()).length, ...(await image(f)) });
		for (let seal = 0; seal < 3 && ok; seal++) ok = await roll(f, creator, member, log, `continue-${seal}`);
		if (ok) {
			await creator.room.issue({ action: "acl", kind: "grant", group: "writer", target: required(f.identities[1]).author });
			ok = await roll(f, creator, member, log, "granted");
		}
		if (ok) {
			await member.room.issue(message("after-readmission"));
			ok = await roll(f, creator, member, log, "readmitted");
		}
	} catch (cause) {
		ok = false;
		const chain: string[] = [];
		for (let value: unknown = cause; value instanceof Error && chain.length < 8; value = value.cause) chain.push(value.message);
		log.push({ label: "open", error: chain });
	}
	writeFileSync(join(directory, "continue.json"), JSON.stringify({ ok, log }));
	for (const row of log) console.info(`FENCE_VERSION continue ${JSON.stringify(row)}`);
	expect(ok).toBe(true);
}, 300_000);
