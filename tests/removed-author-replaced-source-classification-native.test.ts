/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { durableIssuancePruningMaintenanceForStore } from "../packages/issuance-store/src/maintenance.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// A removed player must exit cleanly: a Writer removed in epoch E >= 1 while its issuance store still
// holds an own row of an earlier epoch must keep installing every later epoch the creator offers.
// At the removing close the Writer's plane takes source custody only for its current-epoch rows and its
// unresolved entries; an own row of an earlier epoch that is already settled (admitted, or replaced by a
// completed replacement) gets none. From epoch E + 1 on nothing can authenticate that row: the Writer is
// not in the ACL, and the creator's frontier names only successor members (no admitted sequence for a
// removed author), so the rebase outbox refuses it and the install fails.
// RED 1: an ordinary delivered, admitted epoch-0 move; the Writer is removed in epoch 1.
// RED 2: the move m1 is lost in transit, epoch 0 closes without it, the adjacent install replays it (a
// completed `rebase` entry; the replay is admitted, so the move is in history exactly once); the Writer
// is removed in epoch 1. The installs succeed, the lineage stays, the move is never applied twice.
// RED 3 (reachability of rows older than E - 1): one delivered move per epoch, removal in epoch 3 while
// the epoch-0 move is still present (prefix pruning waits behind the epoch-0 join-fence hole); here the
// first post-removal install fails earlier, in creator predecessor recovery (the historical census).
// Control: the same replayed move without the removal installs every later epoch.
// Measurement (no bound asserted): own outbox rows of a playing member after each install (at
// ce972d7f: 4, 6, 8, 10, then flat at 9 from install 5 to install 10).
const MOVE = "replayed-move";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
const fixture = () => chatSharesRoomFixture({ members: ["genesis"], format: "window", localMembers: [1],
	genesisStateBytes: createShippingChatWindowGenesisStateBytes });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;
const count = (peer: Peer, text: string) =>
	peer.room.projection().messages.filter((entry) => entry.clientOperationId === text).length;

async function nativeImage(f: Fixture) {
	const author = required(f.identities[1]).author, scope = { objectId: f.objectId, author };
	return f.withIssuance(1, async (store) => {
		const maintenance = required(durableIssuancePruningMaintenanceForStore(store));
		const control = await required(maintenance.acquireRetirementControl)({ objectId: f.objectId });
		const completed = control.control.completed; await control.release();
		const plan = await store.readSettlementPlan(scope);
		return {
			plan: plan === null ? null : { fenceSequence: plan.fenceSequence, entries: plan.entries.map(entry => ({
				sequence: entry.sourceSequence, disposition: entry.disposition, replacement: entry.replacementSequence,
				resolved: entry.sourceResolutionDigest !== undefined, context: entry.sourceContextDigest !== undefined })),
				contexts: plan.sourceContexts?.length ?? 0, memberFrontier: plan.memberFrontier !== undefined },
			lineage: await store.readLineage(scope),
			outbox: (await store.readOutboxPage({ scope, limit: 128 })).map(row => {
				const value = decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as
					{ epoch: number; operation: { action?: unknown; clientOperationId?: unknown } };
				return { sequence: row.commit.authorSequence, epoch: value.epoch, publishState: row.publishState,
					action: value.operation.action, ...(value.operation.clientOperationId === undefined ? {} : { id: value.operation.clientOperationId }) };
			}),
			holes: completed?.protectedRecords.filter(hole => hole.author === author).map(hole => hole.authorSequence) ?? null,
		};
	});
}

async function roll(f: Fixture, creator: Peer, member: Peer, label: string) {
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await f.install(member);
	const image = await nativeImage(f);
	console.info(`REMOVED_REPLACED ${label} epoch=${member.room.authority().epoch} rows=${image.outbox.length} ${JSON.stringify(image)}`);
	return image;
}

/** Delivers the Writer's rows above `after` to the creator; returns the last delivered sequence. */
async function deliver(f: Fixture, creator: Peer, after: number | null) {
	const rows = await f.issuedAfter(1, after);
	if (rows.length !== 0) expect(await creator.receive(rows, 1, 30_000)).toBe(true);
	return rows.at(-1)?.commit.authorSequence ?? after;
}

/** m1 signed in epoch 0 and lost; epoch 0 closes without it; the adjacent install replays it and the creator admits the replay. */
async function replayed(f: Fixture, creator: Peer, member: Peer) {
	const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
	Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false)); // Accepted, never delivered.
	await member.room.issue(message(MOVE)).catch(() => undefined);
	const m1 = required((await nativeImage(f)).outbox.find(row => row.id === MOVE));
	expect(m1).toMatchObject({ epoch: 0, publishState: "pending" });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
	await f.install(member);
	const image = await nativeImage(f);
	console.info(`REMOVED_REPLACED replayed epoch=${member.room.authority().epoch} ${JSON.stringify(image)}`);
	expect(image.plan?.entries.find(entry => entry.sequence === m1.sequence)).toMatchObject({ disposition: "rebase" });
	expect(image.plan?.entries.find(entry => entry.sequence === m1.sequence)?.replacement).not.toBeNull();
	// The Writer's epoch-1 rows (its fence and the replay) reach the creator; m1 never does.
	const rows = (await f.issuedAfter(1, m1.sequence)).filter(row => row.commit.authorSequence > m1.sequence);
	expect(await creator.receive(rows, 1, 30_000)).toBe(true);
	expect(count(creator, MOVE)).toBe(1);
	return { m1: m1.sequence, image };
}

/** Every published packet of `member` from now on, as hex. */
function capturePublished(member: Peer) {
	const published: string[] = [];
	const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
	Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => {
		const packet = args[0] as { data?: Uint8Array } | undefined;
		if (packet?.data instanceof Uint8Array) published.push(Buffer.from(packet.data).toString("hex"));
		return publish.apply(member.networkNode, args);
	});
	return published;
}

function issuanceFile(directory: string): string {
	const found: string[] = [];
	const walk = (path: string): void => { for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) walk(child); else if (entry.name.endsWith(".drp-issuance-v1.sqlite")) found.push(child);
	} };
	walk(join(directory, "local-sessions"));
	return required(found.length === 1 ? found[0] : undefined);
}

const PLAN_LIMITS = { maxBytes: 4_194_304, maxDepth: 32, maxItems: 65_536 };
/**
 * Rewrites the stored member frontier with one flipped signature byte and its digest recomputed, so the
 * store's shape and digest checks pass and only Node's re-verification of the signed statement can refuse.
 * @returns The stored plan text after the rewrite.
 */
function tamperMemberFrontier(directory: string): string {
	const database = new DatabaseSync(issuanceFile(directory));
	try {
		// The store's retirement fence triggers ask the store's own connection function; this raw
		// test connection answers it so the deliberate corruption can be written.
		database.function("issuance_retirement_connection", (_objectId: unknown) => 1); // arity 1, as the trigger calls it
		const row = required(database.prepare("SELECT object_id, author, entries_json FROM settlement_plans").get());
		const stored = JSON.parse(String(row.entries_json)) as { kind: string; bytes: string };
		const plan = decodeCanonical(Buffer.from(stored.bytes, "base64"), PLAN_LIMITS) as Record<string, unknown> &
			{ memberFrontier: { digest: Uint8Array; exactCanonicalContextBytes: Uint8Array } };
		const frontier = decodeCanonical(plan.memberFrontier.exactCanonicalContextBytes, PLAN_LIMITS) as Record<string, unknown> &
			{ anchorSignature: Uint8Array };
		const signature = new Uint8Array(frontier.anchorSignature); signature[0] ^= 0x01;
		const bytes = encodeCanonical({ ...frontier, anchorSignature: signature }, PLAN_LIMITS);
		plan.memberFrontier = { digest: hashDomain("ts-drp/settlement-source-context/v1", bytes), exactCanonicalContextBytes: bytes };
		const text = JSON.stringify({ ...stored, bytes: Buffer.from(encodeCanonical(plan, PLAN_LIMITS)).toString("base64") });
		database.prepare("UPDATE settlement_plans SET entries_json=? WHERE object_id=? AND author=?").run(text, row.object_id, row.author);
		return text;
	} finally { database.close(); }
}
const storedPlanText = (directory: string) => {
	const database = new DatabaseSync(issuanceFile(directory), { readOnly: true });
	try { return String(required(database.prepare("SELECT entries_json FROM settlement_plans").get()).entries_json); }
	finally { database.close(); }
};
const errorChain = (cause: unknown) => {
	const chain: string[] = [];
	for (let value: unknown = cause; value instanceof Error && chain.length < 8; value = value.cause) chain.push(value.message);
	return chain;
};

const revoke = (f: Fixture, creator: Peer) =>
	creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: required(f.identities[1]).author });

describe("a Writer removed in epoch 1 with an earlier own row installs every later epoch", () => {
	it("removed in epoch 1 after a delivered epoch-0 move: the next installs succeed", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		await member.room.issue(message(MOVE));
		expect(await creator.receive(await f.issuedAfter(1, null), 1, 30_000)).toBe(true);
		expect(count(creator, MOVE)).toBe(1);
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		const before = await nativeImage(f);
		await revoke(f, creator);
		for (let seal = 0; seal < 4; seal++) await roll(f, creator, member, `delivered-${seal}`);
		expect(member.room.authority().epoch).toBe(5);
		expect((await nativeImage(f)).lineage).toEqual(before.lineage);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		expect(count(creator, MOVE)).toBe(1);
	}, 300_000);

	it("removed in epoch 1 after its lost move was replayed: the next installs succeed; the lineage stays; the move is applied once", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		const { image: before } = await replayed(f, creator, member);
		await revoke(f, creator);
		for (let seal = 0; seal < 4; seal++) await roll(f, creator, member, `revoked-${seal}`);
		expect(member.room.authority().epoch).toBe(5);
		expect((await nativeImage(f)).lineage).toEqual(before.lineage);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		expect(count(creator, MOVE)).toBe(1);
	}, 300_000);

	it("removed in epoch 3 while its delivered epoch-0 move still lingers: the next installs succeed", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		// One delivered move per epoch, as a player plays; the epoch-0 move is admitted at the first close.
		await member.room.issue(message(`${MOVE}-0`));
		let delivered = await deliver(f, creator, null);
		for (let epoch = 1; epoch <= 3; epoch++) {
			await roll(f, creator, member, `played-${epoch}`);
			await member.room.issue(message(`${MOVE}-${epoch}`));
			delivered = await deliver(f, creator, delivered);
		}
		const before = await nativeImage(f);
		console.info(`REMOVED_REPLACED before-removal epoch=${member.room.authority().epoch} rows=${before.outbox.length}`);
		// Reachability: the settled epoch-0 move is still physically present at the removing close (E = 3).
		expect(before.outbox.find(row => row.id === `${MOVE}-0`)).toMatchObject({ epoch: 0, publishState: "published" });
		await revoke(f, creator);
		for (let seal = 0; seal < 4; seal++) await roll(f, creator, member, `removed-late-${seal}`);
		expect(member.room.authority().epoch).toBe(7);
		expect((await nativeImage(f)).lineage).toEqual(before.lineage);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		for (let epoch = 0; epoch <= 3; epoch++) expect(count(creator, `${MOVE}-${epoch}`)).toBe(1);
	}, 300_000);

	// G2: the completed entry that gained custody at the removing close is never re-offered, published or
	// applied again; its replacement stays applied exactly once across removal and a reopen.
	it("G2: after removal and a reopen the replayed move stays applied once; its source is never re-offered", async () => {
		const f = await fixture();
		const creator = await f.open(0);
		let member = await f.open(1);
		const { m1, image: before } = await replayed(f, creator, member);
		const source = required((await f.issuedAfter(1, null)).find(row => row.commit.authorSequence === m1));
		const sourceHex = Buffer.from(source.commit.envelope.canonicalPreimageBytes).toString("hex");
		let published = capturePublished(member);
		await revoke(f, creator);
		for (let seal = 0; seal < 2; seal++) await roll(f, creator, member, `g2-${seal}`);
		const custody = await nativeImage(f);
		const entry = required(custody.plan?.entries.find(value => value.sequence === m1));
		expect(entry).toMatchObject({ disposition: "rebase", context: true });
		expect(entry.replacement).toBe(before.plan?.entries.find(value => value.sequence === m1)?.replacement);
		await f.stop(member);
		member = await f.open(1, { reopen: true, promote: true });
		const reopenedPublished = capturePublished(member);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		for (let seal = 0; seal < 3; seal++) await roll(f, creator, member, `g2-reopened-${seal}`);
		await member.republish();
		published = [...published, ...reopenedPublished];
		expect(published.some(bytes => bytes.includes(sourceHex))).toBe(false);
		const after = await nativeImage(f);
		expect(after.plan?.entries.find(value => value.sequence === m1)).toEqual(entry);
		expect(after.lineage).toEqual(before.lineage);
		expect(count(creator, MOVE)).toBe(1);
		expect(count(member, MOVE)).toBe(1);
	}, 300_000);

	// A stored frontier that no longer verifies (one flipped signature byte, digest recomputed so the store
	// accepts its shape) fails closed: the removed author does not install, and nothing rewrites the plan.
	it("tamper: a stored member frontier that does not verify refuses the next install", async () => {
		const f = await fixture();
		const creator = await f.open(0);
		let member = await f.open(1);
		await member.room.issue(message(MOVE));
		await deliver(f, creator, null);
		await roll(f, creator, member, "tamper-member");
		await revoke(f, creator);
		await roll(f, creator, member, "tamper-removed");
		expect((await nativeImage(f)).plan?.memberFrontier).toBe(true);
		await f.stop(member);
		const tampered = tamperMemberFrontier(f.directory);
		let refusal: string[] | undefined;
		try {
			member = await f.open(1, { reopen: true, promote: true });
			await roll(f, creator, member, "tamper-next");
		} catch (cause) { refusal = errorChain(cause); }
		console.info(`REMOVED_REPLACED tamper refusal ${JSON.stringify(refusal)}`);
		expect(refusal).toBeDefined();
		expect(storedPlanText(f.directory)).toBe(tampered);
	}, 300_000);

	it("control: the same replayed move without the revocation installs every later epoch", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		await replayed(f, creator, member);
		for (let seal = 0; seal < 4; seal++) await roll(f, creator, member, `member-${seal}`);
		expect(member.room.authority().epoch).toBe(5);
		expect(count(creator, MOVE)).toBe(1);
	}, 300_000);

	// Storage growth (measurement, no bound asserted): a member that plays one delivered move per epoch;
	// the log reports how many own rows its issuance outbox still holds after each install.
	it("measure: own rows still present after each of 10 epochs for a playing member", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		let delivered: number | null = null;
		for (let epoch = 0; epoch < 10; epoch++) {
			await member.room.issue(message(`${MOVE}-m${epoch}`));
			delivered = await deliver(f, creator, delivered);
			await roll(f, creator, member, `measure-${epoch}`);
		}
		expect(member.room.authority().epoch).toBe(10);
	}, 300_000);
});
