import "fake-indexeddb/auto";

import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Install observers before the room/node consumers below.
import {
	hex,
	observed,
	openRoom,
	originalStorage,
	productState,
	record,
	required,
	sessions,
} from "./fixtures/grid-room-workload.js";
import { createV3ZoneApplication } from "../examples/grid/src/v3-zone.js";

interface ApplicationProjectionOrder {
	readonly objectId: string;
	readonly epoch: number;
	readonly anchorDigest: string;
	readonly digests: readonly string[];
	readonly controlDigests: readonly string[];
}

type ApplicationProjectionOrderResult =
	| { readonly ok: true; readonly order: ApplicationProjectionOrder }
	| { readonly ok: false; readonly kind: "malformed-input" | "not-active" | "graph-rejected"; readonly detail: string };

async function projectionOrderReader(): Promise<(input: unknown) => ApplicationProjectionOrderResult> {
	const module = await import("../packages/node/src/v3-live.js");
	const read: unknown = Reflect.get(module, "readV3ApplicationProjectionOrder");
	expect(read, "NODE_APPLICATION_PROJECTION_ORDER_CAPABILITY_REQUIRED").toBeTypeOf("function");
	if (typeof read !== "function") throw new TypeError("NODE_APPLICATION_PROJECTION_ORDER_CAPABILITY_REQUIRED");
	return (input) => Reflect.apply(read, undefined, [input]) as ApplicationProjectionOrderResult;
}

async function orderFixture(writerCount = 1): Promise<Awaited<ReturnType<typeof openRoom>>> {
	return openRoom(writerCount, false, false, false, ({ identities, creatorPeerId }) => {
		const author = required(identities[0]).author;
		const roster = identities.map(({ author: memberAuthor }, order) => ({
			author: memberAuthor,
			peerId: `${creatorPeerId.slice(0, -1)}${order}`,
			order,
		}));
		return createV3ZoneApplication(roster, creatorPeerId, author);
	});
}

it("exposes a detached frozen exact-scope application order excluding anchor and protocol fences", async () => {
	const read = await projectionOrderReader();
	const fixture = await orderFixture(20);
	const creator = required(fixture.peers[0]);
	for (const [index, peer] of fixture.peers.slice(1).entries()) {
		await peer.room.issue({ action: "placeBlock", id: `order-tip-${index}`, kind: "stone", x: index, y: 1 });
	}
	await creator.room.issue({ action: "placeBlock", id: "order-probe", kind: "stone", x: 9, y: 12 });
	const plane = required(observed.planes.get(creator.databaseName));
	const selected = read({ plane });
	expect(selected).toMatchObject({ ok: true });
	if (!selected.ok) throw new TypeError(selected.detail);
	const rows = observed.commits.map((commit) => ({
		digest: hex(commit.envelope.digest),
		vertex: record(commit.envelope.canonicalPreimageBytes),
	}));
	const controlActions = new Set(["join", "causalJoin", "$drp.author-fence.v1"]);
	const controlRows = rows.filter(({ vertex }) =>
		controlActions.has(String((vertex.operation as Record<string, unknown>).action))
	);
	const applicationRows = rows.filter(
		({ vertex }) => !controlActions.has(String((vertex.operation as Record<string, unknown>).action))
	);
	expect(
		controlRows.some(({ vertex }) => (vertex.operation as Record<string, unknown>).action === "causalJoin"),
		"GRID_REAL_CAUSAL_JOIN_REQUIRED_ABOVE_SIXTEEN_TIPS"
	).toBe(true);
	const anchorDigest = required(applicationRows[0]).vertex.anchor;
	expect(selected.order).toMatchObject({ objectId: fixture.objectId, epoch: 0, anchorDigest });
	expect([...selected.order.digests].sort()).toEqual(applicationRows.map(({ digest }) => digest).sort());
	expect(selected.order.digests).not.toContain(anchorDigest);
	expect(selected.order.controlDigests).toEqual(controlRows.map(({ digest }) => digest).sort());
	expect(selected.order.controlDigests).not.toContain(anchorDigest);
	for (const row of controlRows) {
		expect(selected.order.digests).not.toContain(row.digest);
	}
	for (const { digest, vertex } of applicationRows) {
		for (const dependency of vertex.dependencies as string[]) {
			if (selected.order.digests.includes(dependency))
				expect(selected.order.digests.indexOf(dependency)).toBeLessThan(selected.order.digests.indexOf(digest));
		}
	}
	expect(Object.isFrozen(selected.order)).toBe(true);
	expect(Object.isFrozen(selected.order.digests)).toBe(true);
	expect(Object.isFrozen(selected.order.controlDigests)).toBe(true);
	expect(Reflect.set(selected.order, "epoch", 900)).toBe(false);
	expect(Reflect.set(selected.order.digests, "0", "0".repeat(64))).toBe(false);
	expect(Reflect.set(selected.order.controlDigests, "0", "0".repeat(64))).toBe(false);
	const copied = structuredClone(selected.order);
	Reflect.set(copied, "epoch", 900);
	Reflect.set(copied.digests, "0", "0".repeat(64));
	Reflect.set(copied.controlDigests, "0", "0".repeat(64));
	const reread = read({ plane });
	expect(reread).toEqual(selected);
	if (!reread.ok) throw new TypeError(reread.detail);
	expect(reread.order).not.toBe(selected.order);
	expect(reread.order.digests).not.toBe(selected.order.digests);
	expect(reread.order.controlDigests).not.toBe(selected.order.controlDigests);
}, 120_000);

it("rejects forged copied cross-scope and accessor order inputs without invoking getters and rejects closed handles", async () => {
	const read = await projectionOrderReader();
	const fixture = await orderFixture();
	const creator = required(fixture.peers[0]);
	const plane = required(observed.planes.get(creator.databaseName));
	let getterCalls = 0;
	const accessor = Object.defineProperty({}, "plane", {
		enumerable: true,
		get: () => {
			getterCalls += 1;
			return plane;
		},
	});
	const inherited = Object.create({ plane });
	for (const input of [
		undefined,
		null,
		{},
		{ plane: {} },
		{ plane: { ...plane } },
		{ plane, objectId: "creator:ffffffffffffffffffffffffffffffff" },
		{ plane, epoch: 99 },
		inherited,
		accessor,
	]) {
		expect(read(input)).toEqual({ ok: false, kind: "malformed-input", detail: expect.any(String) });
	}
	expect(getterCalls).toBe(0);
	await creator.room.close();
	sessions.delete(creator.room);
	expect(read({ plane })).toEqual({ ok: false, kind: "not-active", detail: expect.any(String) });
}, 120_000);

beforeEach(() => {
	observed.commits.length = 0;
	observed.snapshots.length = 0;
	observed.closeGraphs.length = 0;
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: { estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) },
	});
});

afterEach(async () => {
	const closed = await Promise.allSettled([...sessions].map((room) => room.close()));
	sessions.clear();
	vi.restoreAllMocks();
	if (originalStorage === undefined) Reflect.deleteProperty(navigator, "storage");
	else Object.defineProperty(navigator, "storage", originalStorage);
	expect(
		closed.filter((result) => result.status === "rejected"),
		"GRID_SUCCESSOR_CLEANUP_FAILURE"
	).toEqual([]);
});

it("retains the real grid roster and placed block in a genuine successor snapshot and cold reopen", async () => {
	let roster: { author: string; peerId: string; order: number }[] = [];
	const fixture = await openRoom(2, false, false, false, ({ identities, creatorPeerId }) => {
		const prefix = creatorPeerId.slice(0, -1);
		roster = identities.map(({ author }, order) => ({ author, peerId: `${prefix}${order}`, order }));
		return createV3ZoneApplication(roster, creatorPeerId, required(identities[0]).author);
	});
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	const block = { id: "survives-real-close", kind: "stone", x: 17, y: -23 };
	await writer.room.issue({ action: "placeBlock", ...block });
	const expected = encodeCanonical({ version: 1, blocks: [block], outcomes: [], roster });
	expect(productState(creator), "GRID_SUCCESSOR_ACCEPTED_PROJECTION_BEFORE_CLOSE").toEqual(expected);
	expect(await fixture.close()).toMatchObject({ ok: true });
	const checkpoint = fixture.checkpoint();
	const snapshot = required(
		observed.snapshots.findLast((row) => row.result.manifestDigest === checkpoint.identity.snapshotManifestDigest)
	);
	const payload = new Uint8Array(Buffer.concat(snapshot.result.chunks));
	expect(payload).toEqual(snapshot.input.exactCanonicalPayloadBytes);
	expect(encodeCanonical(record(payload).application), "GRID_SUCCESSOR_REAL_SNAPSHOT_PRESERVES_ACCEPTED_WORLD").toEqual(
		expected
	);
	expect(checkpoint.cut.stateDigest).toBe(hex(hashDomain("ts-drp/state/v3", expected)));
	await creator.room.adoptCreatorSuccessor();
	expect(creator.room.authority()).toMatchObject({ epoch: 1, anchorDigest: checkpoint.identity.successorAnchorDigest });
	expect(productState(creator), "GRID_SUCCESSOR_ADOPTED_WORLD").toEqual(expected);
	await fixture.reopen(creator, 0);
	expect(productState(creator), "GRID_SUCCESSOR_COLD_REOPEN_WORLD").toEqual(expected);
	expect(creator.room.projection()).toMatchObject({
		blocks: [block],
		writerAuthors: roster.map(({ author }) => author),
		transportPeerAuthors: roster.map(({ author, peerId }) => ({ author, peerId })),
	});
}, 120_000);

it("ignores a noncreator's conflicting roster through genuine snapshot and adoption", async () => {
	let roster: { author: string; peerId: string; order: number }[] = [];
	const fixture = await openRoom(2, false, false, false, ({ identities, creatorPeerId }) => {
		roster = identities.map(({ author }, order) => ({
			author,
			peerId: `${creatorPeerId.slice(0, -1)}${order}`,
			order,
		}));
		return createV3ZoneApplication(roster, creatorPeerId, required(identities[0]).author);
	});
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	const conflicting = roster.map((member) =>
		member.order === 1 ? { ...member, peerId: "peer:unauthorized-rebind" } : member
	);
	await writer.room.issue({ action: "installRoster", roster: { entries: conflicting } });
	const block = { id: "after-unauthorized-roster", kind: "stone", x: 31, y: 7 };
	await writer.room.issue({ action: "placeBlock", ...block });
	const expected = encodeCanonical({ version: 1, blocks: [block], outcomes: [], roster });
	expect(productState(creator), "GRID_UNAUTHORIZED_JOIN_NEVER_CHANGES_LIVE_AUTHORITY").toEqual(expected);
	expect(await fixture.close()).toMatchObject({ ok: true });
	const checkpoint = fixture.checkpoint();
	const snapshot = required(
		observed.snapshots.findLast((row) => row.result.manifestDigest === checkpoint.identity.snapshotManifestDigest)
	);
	expect(
		encodeCanonical(record(new Uint8Array(Buffer.concat(snapshot.result.chunks))).application),
		"GRID_UNAUTHORIZED_JOIN_NEVER_CHANGES_SNAPSHOT_AUTHORITY"
	).toEqual(expected);
	await creator.room.adoptCreatorSuccessor();
	expect(productState(creator)).toEqual(expected);
	await fixture.reopen(creator, 0);
	expect(productState(creator)).toEqual(expected);
}, 120_000);

it("uses one world order for independent same-block branches live and after genuine close", async () => {
	let roster: { author: string; peerId: string; order: number }[] = [];
	const fixture = await openRoom(3, false, false, false, ({ identities, creatorPeerId }) => {
		roster = identities.map(({ author }, order) => ({
			author,
			peerId: `${creatorPeerId.slice(0, -1)}${order}`,
			order,
		}));
		return createV3ZoneApplication(roster, creatorPeerId, required(identities[0]).author);
	});
	const creator = required(fixture.peers[0]);
	const writers = fixture.peers.slice(1);
	// Fixed input sequence: 16 IDs each receive two genuine concurrent updates.
	// Neither noncreator ever receives the other noncreator's admitted branch.
	for (let round = 0; round < 16; round += 1) {
		for (const [index, writer] of writers.entries()) {
			await writer.room.issue({
				action: "placeBlock",
				id: `shared-${round.toString().padStart(2, "0")}`,
				kind: "stone",
				x: round,
				y: index,
			});
		}
	}
	const live = productState(creator).slice();
	expect(await fixture.close()).toMatchObject({ ok: true });
	const checkpoint = fixture.checkpoint();
	const captured = required(observed.closeGraphs.at(-1));
	// Read the actual complete node graph. Room application callbacks deliberately
	// omit remote protocol controls and cannot serve as a graph oracle.
	const graph = captured.input.vertices;
	const anchor = checkpoint.identity.closedAnchorDigest;
	expect(graph.has(anchor), "GRID_GRAPH_CONTAINS_REAL_CLOSED_ANCHOR").toBe(true);
	expect(required(graph.get(anchor)).dependencies).toEqual([]);
	const signed = new Map(
		observed.commits.map((commit) => [hex(commit.envelope.digest), record(commit.envelope.canonicalPreimageBytes)])
	);
	for (const [digest, vertex] of graph) {
		for (const dependency of vertex.dependencies)
			expect(graph.has(dependency), "GRID_GRAPH_COMPLETE_DEPENDENCY").toBe(true);
		if (digest === anchor) continue;
		const envelope = required(signed.get(digest));
		expect(envelope.objectId).toBe(fixture.objectId);
		expect(envelope.epoch).toBe(0);
		expect(envelope.anchor).toBe(anchor);
		expect(envelope.dependencies).toEqual(vertex.dependencies);
		expect(envelope.operation).toEqual(vertex.operation);
		if (writers.some((peer) => peer.author === envelope.author)) {
			for (const dependency of vertex.dependencies) {
				const parent = signed.get(dependency);
				expect(writers.filter((peer) => peer.author !== envelope.author).map((peer) => peer.author)).not.toContain(
					parent?.author
				);
			}
		}
	}
	const controls = new Set(
		[...graph]
			.filter(([, vertex]) => ["join", "causalJoin", "$drp.author-fence.v1"].includes(String(vertex.operation?.action)))
			.map(([digest]) => digest)
	);
	const dependencies = new Map<string, Set<string>>();
	for (const [digest, vertex] of graph) {
		if (controls.has(digest)) continue;
		const expanded = new Set<string>();
		const pending = [...vertex.dependencies];
		const seen = new Set<string>();
		while (pending.length > 0) {
			const dependency = required(pending.pop());
			if (seen.has(dependency)) continue;
			seen.add(dependency);
			const parent = required(graph.get(dependency));
			if (controls.has(dependency)) pending.push(...parent.dependencies);
			else expanded.add(dependency);
		}
		dependencies.set(digest, expanded);
	}
	const remaining = new Set(dependencies.keys());
	const order: string[] = [];
	while (remaining.size > 0) {
		const next = required(
			[...remaining]
				.filter((digest) => [...required(dependencies.get(digest))].every((dependency) => !remaining.has(dependency)))
				.sort()[0]
		);
		remaining.delete(next);
		if (required(graph.get(next)).operation?.action === "placeBlock") order.push(next);
	}
	expect(order).toHaveLength(32);
	const legacyOrder = [...order].sort((a, b) => {
		const left = required(signed.get(a));
		const right = required(signed.get(b));
		const leftAuthor = String(left.author);
		const rightAuthor = String(right.author);
		return (
			Number(left.logicalTime) - Number(right.logicalTime) ||
			(leftAuthor < rightAuthor ? -1 : leftAuthor > rightAuthor ? 1 : 0)
		);
	});
	const worldFor = (sequence: readonly string[]): Uint8Array => {
		const blocks = new Map<string, Record<string, unknown>>();
		for (const digest of sequence) {
			const operation = required(required(graph.get(digest)).operation);
			const { id, kind, x, y } = operation;
			if (typeof id !== "string") throw new TypeError("GRID_BRANCH_ID_MISSING");
			blocks.set(id, { id, kind, x, y });
		}
		return encodeCanonical({
			version: 1,
			blocks: [...blocks.values()].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1)),
			outcomes: [],
			roster,
		});
	};
	const expected = worldFor(order);
	expect(expected, "GRID_FIXED_BRANCHES_MUST_DISTINGUISH_LEGACY_ORDER").not.toEqual(worldFor(legacyOrder));
	const snapshot = required(
		observed.snapshots.findLast((row) => row.result.manifestDigest === checkpoint.identity.snapshotManifestDigest)
	);
	const sealed = encodeCanonical(record(new Uint8Array(Buffer.concat(snapshot.result.chunks))).application);
	expect
		.soft(decodeCanonical(live), "GRID_CONCURRENT_LIVE_USES_DEPENDENCY_HASH_ORDER")
		.toEqual(decodeCanonical(expected));
	expect.soft(sealed, "GRID_CONCURRENT_SNAPSHOT_USES_SAME_WORLD").toEqual(expected);
	expect(sealed, "GRID_CONCURRENT_LIVE_SNAPSHOT_AGREE").toEqual(live);
	await creator.room.adoptCreatorSuccessor();
	expect(productState(creator)).toEqual(expected);
}, 120_000);
