import "fake-indexeddb/auto";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { observed, openRoom, originalStorage, required, sessions } from "./fixtures/grid-room-workload.js";
import { createV3ZoneApplication } from "../examples/grid/src/v3-zone.js";

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
		"GRID_OWNER_CONTROL_CLEANUP"
	).toEqual([]);
});

it("measures both real runtime owners and only their existing databases after one genuine grid transition", async () => {
	const fixture = await openRoom(2, false, false, false, ({ identities, creatorPeerId }) => {
		const roster = identities.map(({ author }, order) => ({
			author,
			peerId: `${creatorPeerId.slice(0, -1)}${order}`,
			order,
		}));
		return createV3ZoneApplication(roster, creatorPeerId, required(identities[0]).author);
	});
	for (const [index, peer] of fixture.peers.entries()) {
		await peer.room.issue({ action: "placeBlock", id: `owner-probe-${index}`, kind: "stone", x: index, y: 1 });
	}
	expect(await fixture.close()).toMatchObject({ ok: true });
	fixture.checkpoint();
	const creator = required(fixture.peers[0]);
	await creator.room.adoptCreatorSuccessor();
	for (const peer of fixture.peers.slice(1)) await fixture.reopen(peer, 0, true);
	for (const peer of fixture.peers) expect(peer.room.authority()).toMatchObject({ epoch: 1 });
	const owners = fixture.ownerCensus();
	expect(owners).toMatchObject({ runtimePlanesMeasured: 2, peers: 2, activeRoomOwners: 2 });
	expect(Object.keys(owners).some((name) => name.startsWith("runtime_"))).toBe(true);
	for (const [name, count] of Object.entries(owners)) {
		expect(typeof count, name).toBe("number");
		expect(Number.isSafeInteger(count), name).toBe(true);
		expect(count, name).toBeGreaterThanOrEqual(0);
	}
	const catalogBefore = await indexedDB.databases();
	const names = await fixture.databaseNames();
	// The creator also owns the seal vote/evidence database at its base name.
	const expected = [
		creator.databaseName,
		...fixture.peers.flatMap(({ databaseName }) => [
			`${databaseName}--ahe`,
			`${databaseName}--drp-live-journal-v1`,
			`${databaseName}--drp-snapshot-quarantine-v1`,
			`${databaseName}--drp-issuance-v1`,
		]),
	].sort();
	expect(names).toEqual(expected);
	expect(new Set(names).size).toBe(9);
	for (const name of names)
		expect(
			catalogBefore.some((entry) => entry.name === name),
			name
		).toBe(true);
	expect(await indexedDB.databases(), "CENSUS_MUST_NOT_CREATE_GUESSED_DATABASES").toEqual(catalogBefore);
}, 120_000);
