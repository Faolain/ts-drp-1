import "fake-indexeddb/auto";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	observed,
	openRoom,
	originalStorage,
	required,
	sessions,
	waitForGridStartupForDiagnostics,
} from "./fixtures/grid-room-workload.js";
import { createV3ZoneApplication } from "../examples/grid/src/v3-zone.js";
import { waitForV3RoomStartupForDiagnostics } from "../examples/v3-room/src/index.js";
import { readV3RuntimeOwnerCensus } from "../packages/node/src/v3-live.js";

beforeEach(() => {
	observed.commits.length = 0;
	observed.snapshots.length = 0;
	observed.closeGraphs.length = 0;
	observed.planes.clear();
	observed.stores.clear();
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
		"GRID_TERMINAL_READINESS_CLEANUP"
	).toEqual([]);
});

async function rejectionMessage(action: () => Promise<void>): Promise<string> {
	try {
		await action();
	} catch (error) {
		if (!(error instanceof Error)) throw new TypeError("EXPECTED_READINESS_ERROR");
		return error.message;
	}
	throw new Error("EXPECTED_READINESS_REJECTION");
}

it("terminal accounting skips only the fence-count restriction, retaining creator and plane readiness checks", async () => {
	// Seventeen genuine writer tips exceed the unchanged 16-dependency limit,
	// requiring a real causal-join control in addition to writer fences.
	const fixture = await openRoom(17, false, false, false, ({ identities, creatorPeerId }) => {
		const roster = identities.map(({ author }, order) => ({
			author,
			peerId: `${creatorPeerId.slice(0, -1)}${order}`,
			order,
		}));
		return createV3ZoneApplication(roster, creatorPeerId, required(identities[0]).author);
	});
	for (const [index, peer] of fixture.peers.entries()) {
		await waitForV3RoomStartupForDiagnostics(peer.room);
		await peer.room.issue({ action: "placeBlock", id: `terminal-probe-${index}`, kind: "stone", x: index, y: 1 });
	}
	const creator = required(fixture.peers[0]);
	await creator.room.issue({ action: "placeBlock", id: "terminal-creator-join-probe", kind: "stone", x: 17, y: 2 });
	const follower = required(fixture.peers[1]);
	const creatorPlane = required(observed.planes.get(creator.databaseName));
	const followerPlane = required(observed.planes.get(follower.databaseName));
	const current = required(readV3RuntimeOwnerCensus(creatorPlane));
	expect(current).toMatchObject({ active: 1, terminal: 0, pendingIngress: 0, drainingPendingIngress: 0 });
	// This is a measured natural-room control, not an invented terminal count.
	expect(current.controlVertices, "GENESIS_AND_ORDINARY_WORK_CONTROL_COUNT_DIFFERS_FROM_REOPEN_FENCES").not.toBe(
		sessions.size
	);
	expect(await rejectionMessage(() => waitForGridStartupForDiagnostics({ terminalAccounting: false }))).toContain(
		"GRID_MEMORY_ALL_CURRENT_WRITER_FENCES_ADMITTED_BEFORE_CENSUS"
	);
	expect(await waitForGridStartupForDiagnostics({ terminalAccounting: true })).toBeUndefined();

	// Diagnostic catalog omission must still fail at terminal accounting.
	// Neither test mutation fabricates or changes a product runtime handle.
	observed.planes.delete(follower.databaseName);
	try {
		expect(await rejectionMessage(() => waitForGridStartupForDiagnostics({ terminalAccounting: true }))).toContain(
			"GRID_MEMORY_ONE_CURRENT_PLANE_PER_SESSION"
		);
	} finally {
		observed.planes.set(follower.databaseName, followerPlane);
	}
	observed.planes.delete(creator.databaseName);
	try {
		expect(await rejectionMessage(() => waitForGridStartupForDiagnostics({ terminalAccounting: true }))).toContain(
			"GRID_MEMORY_ONE_CURRENT_CREATOR"
		);
	} finally {
		observed.planes.set(creator.databaseName, creatorPlane);
	}
	expect(await waitForGridStartupForDiagnostics({ terminalAccounting: true })).toBeUndefined();
}, 120_000);
