/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { afterEach, describe, expect, it } from "vitest";
import { decodeCanonical } from "@ts-drp/canonical";
import { durableIssuancePruningMaintenanceForStore } from "../packages/issuance-store/src/maintenance.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// A removed author's own join-time `$drp.author-fence.v1` no-op stays in its issuance
// store as an `expire` plan entry with no resolution. Before the release rule, nothing
// ever retired it: one permanent protected hole per removed author (FENCE-DESIGN.md,
// candidate A; model packages/issuance-store/formal/removed-author-fence-release.qnt).
// The release never moves the durable lineage: re-admission fences at lineage.next.

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const FENCE = "$drp.author-fence.v1";
const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
// Peer 1 is a genuine owned local session: its own issuance store holds the join FENCE.
const fixture = () => chatSharesRoomFixture({ members: ["genesis"], format: "window", localMembers: [1],
	genesisStateBytes: createShippingChatWindowGenesisStateBytes });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;

async function nativeImage(f: Fixture, index: number) {
	const author = required(f.identities[index]).author, scope = { objectId: f.objectId, author };
	return f.withIssuance(index, async (store) => {
		const maintenance = required(durableIssuancePruningMaintenanceForStore(store));
		const control = await required(maintenance.acquireRetirementControl)({ objectId: f.objectId });
		const completed = control.control.completed; await control.release();
		const plan = await store.readSettlementPlan(scope);
		return {
			plan: plan === null ? null : { fenceSequence: plan.fenceSequence, entries: plan.entries.map(entry => ({
				sequence: entry.sourceSequence, disposition: entry.disposition, resolved: entry.sourceResolutionDigest !== undefined })),
				contexts: plan.sourceContexts?.length ?? 0 },
			lineage: await store.readLineage(scope),
			outbox: (await store.readOutboxPage({ scope, limit: 128 })).map(row => {
				const operation = (decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { operation: { action?: unknown; fenceSequence?: unknown } }).operation;
				return { sequence: row.commit.authorSequence, publishState: row.publishState, action: operation.action,
					...(operation.action === FENCE ? { fenceSequence: operation.fenceSequence } : {}) };
			}),
			holes: completed?.protectedRecords.filter(hole => hole.author === author).map(hole => hole.authorSequence) ?? null,
			retiredThroughEpoch: completed?.throughEpoch ?? null,
			prunedThrough: (await maintenance.inspectPruningState(scope)).prunedThroughAuthorSequence,
		};
	});
}

async function roll(f: Fixture, creator: Peer, member: Peer, label: string) {
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await f.install(member);
	const image = await nativeImage(f, 1);
	console.info(`FENCE_RELEASE ${label} epoch=${member.room.authority().epoch} ${JSON.stringify(image)}`);
	return image;
}

/** Removed author: roll past the retained window, release, then re-admit at lineage.next. */
async function releaseThenReadmit(f: Fixture, creator: Peer, member: Peer, label: string,
	beforeGrant: () => void = () => undefined) {
	const author = required(f.identities[1]).author;
	const removed = await nativeImage(f, 1);
	const fence = required(removed.outbox.find(row => row.action === FENCE));
	// The join FENCE is the removed author's retained no-op: `expire` with no resolution, no current fence.
	expect(removed.plan?.fenceSequence).toBeNull();
	expect(removed.plan?.entries.find(entry => entry.sequence === fence.sequence)).toEqual(
		{ sequence: fence.sequence, disposition: "expire", resolved: false });
	const next = removed.lineage.next;
	let image = removed;
	// Fence epoch 0: the retirement cut must reach epoch 2 (R3) and a little beyond.
	for (let seal = 0; seal < 5; seal++) image = await roll(f, creator, member, `${label}-removed-${seal}`);
	expect(image.retiredThroughEpoch).toBeGreaterThanOrEqual(3);
	// RELEASED: the fence row is no longer a protected hole and its plan entry is gone.
	expect(image.holes).toEqual([]);
	// Its entry stays as custody while the row is physically present: the recovery walk
	// still authenticates the exact no-op through its retained source contract.
	expect(image.plan?.entries.find(entry => entry.sequence === fence.sequence)).toEqual(
		{ sequence: fence.sequence, disposition: "expire", resolved: false });
	// The durable lineage never moves (no seq is ever re-signed).
	expect(image.lineage).toEqual(removed.lineage);
	expect(image.plan?.fenceSequence ?? null).toBeNull();
	// The dropped entry's context is not read as an unresolved obligation.
	expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
	beforeGrant();
	await creator.room.issue({ action: "acl", kind: "grant", group: "writer", target: author });
	const granted = await roll(f, creator, member, `${label}-granted`);
	// Re-admission signs a FRESH fence at the unchanged lineage.next, never the released sequence.
	const fresh = required(granted.outbox.find(row => row.action === FENCE && row.sequence >= next));
	expect(fresh).toMatchObject({ sequence: next, fenceSequence: next, publishState: "published" });
	expect(granted.plan?.fenceSequence).toBe(next);
	expect(granted.lineage.next).toBe(next + 1);
	expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
	await member.room.issue(message(`${label}-after-readmission`));
	const after = await nativeImage(f, 1);
	expect(after.outbox.at(-1)).toMatchObject({ sequence: next + 1, action: "message" });
	// With a current fence again, the ordinary prefix pruner removes the released row and
	// the retirement drops its entry; the fresh fence stays the plan's current fence.
	const pruned = await roll(f, creator, member, `${label}-readmitted`);
	expect(pruned.prunedThrough).toBeGreaterThanOrEqual(fence.sequence);
	expect(pruned.plan?.entries.some(entry => entry.sequence === fence.sequence) ?? false).toBe(false);
	expect(pruned.outbox.some(row => row.sequence === fence.sequence)).toBe(false);
	expect(pruned.lineage.next).toBeGreaterThan(next + 1);
	return { fence: fence.sequence, next };
}

describe("removed author's join FENCE release", () => {
	it("retires the fence of a removed author with no pending work; re-admission fences at lineage.next", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		const author = required(f.identities[1]).author;
		await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
		await roll(f, creator, member, "A-revoked");
		const { fence, next } = await releaseThenReadmit(f, creator, member, "A");
		expect({ fence, next }).toEqual({ fence: 1, next: 2 });
	}, 300_000);

	it("retires the fence after abandoned unknown work settles (T9 shape); re-admission fences at lineage.next", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
		Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false)); // Accepted, never acknowledged.
		await member.room.issue(message("before-removal")).catch(() => undefined);
		const author = required(f.identities[1]).author;
		await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
		await roll(f, creator, member, "B-revoked");
		const unresolved = required((await member.room.unresolvedAcceptedWork())[0]);
		// Unresolved work keeps the fence (R2): nothing is released before abandonment settles it.
		await member.room.abandonUnresolvedAcceptedWork({ sourceSequence: unresolved.sourceSequence,
			sourceDigest: unresolved.sourceDigest, sourceContextDigest: unresolved.sourceContextDigest });
		const { fence, next } = await releaseThenReadmit(f, creator, member, "B",
			() => Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args)));
		expect({ fence, next }).toEqual({ fence: 1, next: 3 });
		// The abandoned source stays terminal and never publishes.
		const image = await nativeImage(f, 1);
		expect(image.outbox.find(row => row.sequence === unresolved.sourceSequence)?.publishState ?? "pending").toBe("pending");
		await f.stop(member);
		const reopened = await f.open(1, { reopen: true, promote: true });
		expect(await reopened.room.unresolvedAcceptedWork()).toEqual([]);
	}, 300_000);
});
