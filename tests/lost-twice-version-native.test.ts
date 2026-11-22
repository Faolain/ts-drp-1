/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// G25 cross-version probe for lost-twice custody (no schema bump). One store directory, two processes:
// "setup" (this code) loses the move twice (m1 never published, r1 never received), so the close of
// epoch 1 takes custody of m1's completed entry and the epoch-2 install passes the census through the
// live replacement chain; "continue" reopens the SAME directory and keeps installing. The driver runs
// "continue" from a checkout of the code before this fix (downgrade: it must fail closed and leave the
// member's native image exactly as it was) and then from this code again (it must continue, deliver
// the move's newest link and land it exactly once). Skipped unless LOST_TWICE_VERSION_PHASE is set.
// The old code may refuse with a general error (for F2's probe it was "chain-invalid: creator issuance
// ACL authority is invalid") rather than one naming the custody; that is acceptable when it refuses
// without writing (the driver compares the member's native image).
// Without a marker (lt-ver-07 against F2 8da835ba, lt-ver-08 against the last release ce972d7f), the old
// code opened the plan (custody on a completed entry is a shape F2 already accepts), ran its close
// bookkeeping (plan revision 9 -> 11, fence cleared, retirement control) and then refused the install at
// its census with the original lost-twice error ("outbox-classification:2:displaced:pending"): the image
// differed. The plan therefore carries SettlementPlan.completedSourceCustody, written once with the first
// such custody; both older readers refuse the unknown field at open, and the image is byte-identical.
const PHASE = process.env.LOST_TWICE_VERSION_PHASE;
const DIRECTORY = process.env.LOST_TWICE_VERSION_DIRECTORY;
const MOVE = "lost-twice-version-move";
const AFTER = "lost-twice-version-after";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
const fixture = (directory: string, localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
	chatSharesRoomFixture({ directory, members: ["genesis"], format: "window", localMembers: [1],
		...(localSelectors === undefined ? {} : { localSelectors }), genesisStateBytes: createShippingChatWindowGenesisStateBytes });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;
const count = (peer: Peer) => peer.room.projection().messages.filter(entry => entry.clientOperationId === MOVE).length;

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
async function links(f: Fixture) {
	return (await f.issuedAfter(1, null)).map(row => {
		const value = decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as
			{ epoch: number; operation: { clientOperationId?: unknown } };
		return { sequence: row.commit.authorSequence, epoch: value.epoch, id: value.operation.clientOperationId, row };
	}).filter(link => link.id === MOVE);
}
const errorChain = (cause: unknown) => {
	const chain: string[] = [];
	for (let value: unknown = cause; value instanceof Error && chain.length < 8; value = value.cause) chain.push(value.message);
	return chain;
};
async function roll(f: Fixture, creator: Peer, member: Peer, log: unknown[], label: string) {
	try {
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		log.push({ label, epoch: member.room.authority().epoch });
		return true;
	} catch (cause) {
		log.push({ label, error: errorChain(cause) });
		return false;
	}
}

it.runIf(PHASE === "setup")("setup: lose the move twice; the epoch-2 install passes through the live chain", async () => {
	const directory = required(DIRECTORY), log: unknown[] = [];
	const f = await fixture(directory);
	const creator = await f.open(0), member = await f.open(1);
	const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
	Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false));
	await member.room.issue(message(MOVE)).catch(() => undefined);
	Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
	for (let seal = 0; seal < 2; seal++) expect(await roll(f, creator, member, log, `lost-${seal + 1}`)).toBe(true);
	expect(member.room.authority().epoch).toBe(2);
	const plan = await f.withIssuance(1, store => store.readSettlementPlan({ objectId: f.objectId, author: required(f.identities[1]).author }));
	const m1 = required((await links(f))[0]).sequence;
	expect(plan?.entries.find(entry => entry.sourceSequence === m1)?.sourceContextDigest).toBeDefined();
	// The marker older readers refuse at open (closed plan record), before any write.
	expect(plan?.completedSourceCustody).toBe(true);
	writeFileSync(join(directory, "setup.json"), JSON.stringify({ selectors: f.localSelectors, log }));
	writeFileSync(join(directory, "image-setup.json"), JSON.stringify(nativeImage(directory)));
	console.info(`LOST_TWICE_VERSION setup ${JSON.stringify(log)}`);
}, 300_000);

it.runIf(PHASE === "continue")("continue: reopen the same stores and keep installing", async () => {
	const directory = required(DIRECTORY), label = required(process.env.LOST_TWICE_VERSION_LABEL), log: unknown[] = [];
	const setup = JSON.parse(readFileSync(join(directory, "setup.json"), "utf8")) as
		{ selectors: Record<number, { slot: number; incarnation: number }> };
	const f = await fixture(directory, setup.selectors);
	let ok = true;
	try {
		const creator = await f.open(0, { reopen: true });
		const member = await f.open(1, { reopen: true, promote: true });
		log.push({ label: "reopened", epoch: member.room.authority().epoch });
		// Roll until the move's newest link is signed in the member's epoch (a resumed or non-adjacent
		// install's replacement may come one install later), deliver that epoch's rows, then settle.
		// If the move waited past the settlement window it is handed back instead (never replaced again):
		// the application offers it again with its hand-back key, exactly once.
		let delivered = false, handedBack = false;
		for (let attempt = 0; attempt < 4 && ok && !delivered; attempt++) {
			ok = await roll(f, creator, member, log, `continue-${attempt}`);
			if (!ok) break;
			const epoch = member.room.authority().epoch;
			if (!handedBack) {
				const given = member.room.settlementStatus?.().undelivered.find(record =>
					record.operations[0]?.clientOperationId === MOVE);
				if (given !== undefined) {
					await member.room.issue(required(given.operations[0]) as never, { handBack: given.handBack });
					handedBack = true; log.push({ label: "handed-back", epoch, handBack: given.handBack });
				}
			}
			const newest = required((await links(f)).at(-1));
			// The epoch's rows in order (its author fence, then the link): the link depends on the fence.
			if (newest.epoch === epoch) delivered = await creator.receive((await f.issuedAfter(1, null)).filter(row =>
				(decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { epoch: number }).epoch === epoch), 1, 30_000);
		}
		if (ok) expect(delivered).toBe(true);
		for (let seal = 0; seal < 2 && ok; seal++) ok = await roll(f, creator, member, log, `settle-${seal}`);
		if (ok) {
			log.push({ label: "counts", creator: count(creator), member: count(member) });
			expect(count(creator)).toBe(1);
			expect(count(member)).toBe(1);
			expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
			// The plan's fence may have been cleared by older code's bookkeeping; a later own move must still
			// follow the plan's current author fence (issued, an author-fence row), and land exactly once. The
			// fence need not be in the move's own epoch: a drain re-fences only when the plan's fence is cleared.
			await member.room.issue(message(AFTER));
			const epoch = member.room.authority().epoch;
			const all = (await f.issuedAfter(1, null)).map(row => ({ row, value: decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as
				{ epoch: number; operation: { action?: unknown; clientOperationId?: unknown; fenceSequence?: unknown } } }));
			const rows = all.filter(({ value }) => value.epoch === epoch);
			const after = required(rows.find(({ value }) => value.operation.clientOperationId === AFTER));
			const plan = await f.withIssuance(1, store => store.readSettlementPlan({ objectId: f.objectId, author: required(f.identities[1]).author }));
			const fence = plan?.fenceSequence ?? null;
			const fenceRow = fence === null ? undefined : all.find(({ row }) => row.commit.authorSequence === fence);
			const fenced = fenceRow !== undefined && fenceRow.value.operation.action === "$drp.author-fence.v1" &&
				fenceRow.value.operation.fenceSequence === fence && fence < after.row.commit.authorSequence;
			log.push({ label: "after-move", epoch, fence, fenceEpoch: fenceRow?.value.epoch ?? null, fenced, sequence: after.row.commit.authorSequence });
			expect(fenced).toBe(true);
			expect(await creator.receive(rows.map(({ row }) => row), 1, 30_000)).toBe(true);
			ok = await roll(f, creator, member, log, "after-settle");
			expect(creator.room.projection().messages.filter(entry => entry.clientOperationId === AFTER)).toHaveLength(1);
		}
	} catch (cause) {
		ok = false;
		log.push({ label: "open", error: errorChain(cause) });
	}
	writeFileSync(join(directory, `continue-${label}.json`), JSON.stringify({ ok, log }));
	writeFileSync(join(directory, `image-${label}.json`), JSON.stringify(nativeImage(directory)));
	for (const row of log) console.info(`LOST_TWICE_VERSION continue ${label} ${JSON.stringify(row)}`);
	if (process.env.LOST_TWICE_VERSION_EXPECT === "refused") expect(ok).toBe(false);
	else expect(ok).toBe(true);
}, 300_000);
