/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { durableIssuancePruningMaintenanceForStore } from "../packages/issuance-store/src/maintenance.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// A player on a bad link loses a move and then loses its replay, across two epochs. The Writer's move
// m1 is signed in epoch 0 and never reaches the creator; epoch 0 closes without it. The adjacent
// install replays it as r1 (epoch 1): m1's plan entry is a completed `rebase` (replacement r1), but r1
// is published and never received either, so epoch 1 closes without it too. The Writer must still
// install epoch 2: r1 (and through it m1) was never admitted, so the move is re-offered (a fresh
// replacement or a hand-back), reaches the creator in epoch 2, and is in history exactly once (counted
// on the creator and on the member). The aged case loses it three times, so m1 outlives the displaced
// adjacency before the move lands.
const MOVE = "lost-twice-move";
const OTHER = "lost-twice-other-move";

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
				handBacks: plan.handBacks?.length ?? 0,
				// Custody bytes (condition (c)): every stored displaced-plane context, exactly.
				contextBytes: plan.sourceContexts?.map(context => context.exactCanonicalContextBytes.byteLength) ?? [] },
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
	console.info(`LOST_TWICE ${label} epoch=${member.room.authority().epoch} ${JSON.stringify(image)}`);
	return image;
}

/** Delivers the Writer's rows of one epoch above `after` to the creator. */
async function deliverEpoch(f: Fixture, creator: Peer, after: number, epoch: number) {
	const rows = (await f.issuedAfter(1, after)).filter(row =>
		(decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { epoch: number }).epoch === epoch);
	if (rows.length !== 0) expect(await creator.receive(rows, 1, 30_000)).toBe(true);
	return rows.length;
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
type StoredEntry = { sourceSequence: number; replacementSequence: number | null; disposition?: string;
	sourceContextDigest?: Uint8Array; sourceResolutionDigest?: Uint8Array };
type StoredContext = { digest: Uint8Array; exactCanonicalContextBytes: Uint8Array };
/** Store-level edit of the member's plan (canonical carrier), bypassing every plan-write law. */
function editPlanEntries(directory: string, edit: (entries: StoredEntry[], contexts: StoredContext[]) => void): void {
	const database = new DatabaseSync(issuanceFile(directory));
	try {
		// The store's retirement fence triggers ask the store's own connection function; this raw test
		// connection answers it so the deliberate corruption can be written.
		database.function("issuance_retirement_connection", (_objectId: unknown) => 1); // arity 1, as the trigger calls it
		const row = required(database.prepare("SELECT object_id, author, entries_json FROM settlement_plans").get());
		const stored = JSON.parse(String(row.entries_json)) as { kind: string; bytes: string };
		const plan = decodeCanonical(Buffer.from(stored.bytes, "base64"), PLAN_LIMITS) as
			{ entries: StoredEntry[]; sourceContexts?: StoredContext[] };
		plan.sourceContexts ??= [];
		edit(plan.entries, plan.sourceContexts);
		const text = JSON.stringify({ ...stored, bytes: Buffer.from(encodeCanonical(plan, PLAN_LIMITS)).toString("base64") });
		database.prepare("UPDATE settlement_plans SET entries_json=? WHERE object_id=? AND author=?").run(text, row.object_id, row.author);
	} finally { database.close(); }
}
const storedEntries = (directory: string) => {
	const database = new DatabaseSync(issuanceFile(directory), { readOnly: true });
	try {
		const stored = JSON.parse(String(required(database.prepare("SELECT entries_json FROM settlement_plans").get()).entries_json)) as { bytes: string };
		return (decodeCanonical(Buffer.from(stored.bytes, "base64"), PLAN_LIMITS) as { entries: StoredEntry[] }).entries;
	} finally { database.close(); }
};
const errorChain = (cause: unknown) => {
	const chain: string[] = [];
	for (let value: unknown = cause; value instanceof Error && chain.length < 8; value = value.cause) chain.push(value.message);
	return chain;
};

describe("a move lost twice across two epochs", () => {
	it("the next install succeeds; the move lands exactly once", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
		Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false)); // Accepted, never delivered.
		await member.room.issue(message(MOVE)).catch(() => undefined);
		const m1 = required((await nativeImage(f)).outbox.find(row => row.id === MOVE));
		expect(m1).toMatchObject({ epoch: 0, publishState: "pending" });
		Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
		// Rows reach the creator only when delivered: nothing of epochs 0 and 1 is (r1 is published, never received).
		const lost = await roll(f, creator, member, "lost-1");
		const r1 = required(lost.outbox.find(row => row.id === MOVE && row.epoch === 1));
		expect(lost.plan?.entries.find(entry => entry.sequence === m1.sequence)).toMatchObject({ disposition: "rebase", replacement: r1.sequence });
		// The epoch-2 install succeeds although neither m1 nor r1 was admitted.
		const after = await roll(f, creator, member, "lost-2");
		expect(member.room.authority().epoch).toBe(2);
		expect(await deliverEpoch(f, creator, r1.sequence, 2)).toBeGreaterThan(0);
		expect(count(creator, MOVE)).toBe(1);
		for (let seal = 0; seal < 3; seal++) await roll(f, creator, member, `settled-${seal}`);
		expect(member.room.authority().epoch).toBe(5);
		expect(count(creator, MOVE)).toBe(1);
		expect(count(member, MOVE)).toBe(1);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		expect((await nativeImage(f)).lineage.next).toBeGreaterThanOrEqual(after.lineage.next);
		// Custody of the completed source withholds nothing: the member keeps fencing each successor, and a
		// later own move follows the plan's current author fence.
		await member.room.issue(message(`${MOVE}-after`));
		const fenced = await nativeImage(f);
		const later = required(fenced.outbox.find(row => row.id === `${MOVE}-after`));
		expect(fenced.plan?.fenceSequence ?? null).not.toBeNull();
		expect(fenced.outbox.find(row => row.sequence === fenced.plan?.fenceSequence)?.action).toBe("$drp.author-fence.v1");
		expect(required(fenced.plan?.fenceSequence)).toBeLessThan(later.sequence);
	}, 300_000);

	// Reopen (G2): lose the move twice, stop the member, reopen the same stores; the next installs pass the
	// census through the chain authenticated from durable custody, and the move lands exactly once.
	it("after a reopen the chain still authenticates; the move lands exactly once", async () => {
		const f = await fixture();
		const creator = await f.open(0);
		let member = await f.open(1);
		const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
		Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false));
		await member.room.issue(message(MOVE)).catch(() => undefined);
		Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
		await roll(f, creator, member, "reopen-lost-1");
		await roll(f, creator, member, "reopen-lost-2");
		await f.stop(member);
		member = await f.open(1, { reopen: true, promote: true });
		let delivered = false;
		for (let attempt = 0; attempt < 4 && !delivered; attempt++) {
			const image = await roll(f, creator, member, `reopen-next-${attempt}`);
			const newest = required(image.outbox.filter(row => row.id === MOVE).at(-1));
			if (newest.epoch === member.room.authority().epoch)
				delivered = await deliverEpoch(f, creator, 0, newest.epoch) > 0; // the epoch's fence and the link
		}
		expect(delivered).toBe(true);
		for (let seal = 0; seal < 3; seal++) await roll(f, creator, member, `reopen-settled-${seal}`);
		expect(count(creator, MOVE)).toBe(1);
		expect(count(member, MOVE)).toBe(1);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
	}, 300_000);

	// The chain walk rests on authenticated evidence, never on plan rows alone. A store edit of the member's
	// plan refuses the next install instead of installing, and the edited link is never silently repaired:
	// - "foreign-chunk": m1's completed entry names a live row of ANOTHER move (its signed operations are
	//   not m1's permitted replacement);
	// - "double-claim": m1's completed entry names r2, which r1's entry also names;
	// - "cycle": r1's completed entry names m1 (a chunk before its source);
	// - "forged-expiry": r1's entry is rewritten as durably expired under a forged abandonment receipt (a
	//   context whose bytes and digest no author key signed), so the walk would end at it as terminal.
	it.each(["foreign-chunk", "double-claim", "cycle", "forged-expiry"] as const)("tamper (%s): the next install refuses", async (shape) => {
		const f = await fixture();
		const creator = await f.open(0);
		let member = await f.open(1);
		const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
		Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false));
		await member.room.issue(message(MOVE)).catch(() => undefined);
		Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
		const m1 = required((await nativeImage(f)).outbox.find(row => row.id === MOVE)).sequence;
		await roll(f, creator, member, "tamper-1");
		await roll(f, creator, member, "tamper-2");
		if (shape === "foreign-chunk") await member.room.issue(message(OTHER));
		const image = await nativeImage(f);
		const links = image.outbox.filter(row => row.id === MOVE).map(row => row.sequence);
		expect(links).toHaveLength(3); // m1, r1, r2: m1 -> r1 -> r2 (r2 current at epoch 2)
		const [, r1, r2] = links as [number, number, number];
		const other = image.outbox.find(row => row.id === OTHER)?.sequence;
		await f.stop(member);
		const edited = shape === "cycle" ? { source: r1, replacement: m1 as number | null }
			: shape === "forged-expiry" ? { source: r1, replacement: null }
			: { source: m1, replacement: shape === "double-claim" ? r2 : required(other) };
		editPlanEntries(f.directory, (entries, contexts) => {
			const entry = required(entries.find(value => value.sourceSequence === edited.source));
			entry.replacementSequence = edited.replacement;
			if (shape !== "forged-expiry") return;
			// A forged receipt: an existing context's bytes with one byte flipped, under a made-up digest.
			const bytes = new Uint8Array(required(contexts[0]).exactCanonicalContextBytes);
			bytes[bytes.length - 1] ^= 0x01;
			const forged = { digest: new Uint8Array(32).fill(0xab), exactCanonicalContextBytes: bytes };
			contexts.push(forged);
			entry.disposition = "expire";
			entry.sourceResolutionDigest = forged.digest;
			entry.sourceContextDigest ??= required(contexts[0]).digest;
		});
		let refusal: string[] | undefined;
		try {
			member = await f.open(1, { reopen: true, promote: true });
			await roll(f, creator, member, "tamper-next");
		} catch (cause) { refusal = errorChain(cause); }
		console.info(`LOST_TWICE tamper ${shape} refusal ${JSON.stringify(refusal)}`);
		expect(refusal).toBeDefined();
		expect(storedEntries(f.directory).find(entry => entry.sourceSequence === edited.source)?.replacementSequence).toBe(edited.replacement);
	}, 300_000);

	// Custody age: the move misses three epochs (m1, r1, r2 never received), so m1 ages past the displaced
	// adjacency before r3 lands. Every install still authenticates the whole chain, and the move lands once.
	it("lost three times: m1 ages past the displaced adjacency; r3 lands exactly once", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
		Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false));
		await member.room.issue(message(MOVE)).catch(() => undefined);
		Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
		for (let epoch = 1; epoch <= 3; epoch++) {
			const image = await roll(f, creator, member, `aged-${epoch}`);
			expect(image.outbox.filter(row => row.id === MOVE).at(-1)?.epoch).toBe(epoch);
		}
		expect(member.room.authority().epoch).toBe(3);
		expect(await deliverEpoch(f, creator, 0, 3)).toBeGreaterThan(0);
		for (let seal = 0; seal < 3; seal++) await roll(f, creator, member, `aged-settled-${seal}`);
		expect(member.room.authority().epoch).toBe(6);
		expect(count(creator, MOVE)).toBe(1);
		expect(count(member, MOVE)).toBe(1);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
	}, 300_000);
});
