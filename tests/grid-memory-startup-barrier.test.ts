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
		"GRID_STARTUP_CONTROL_CLEANUP"
	).toEqual([]);
});

it("awaits only genuine live sessions' existing startup and rejects copied, foreign, and closed sessions", async () => {
	const { waitForV3RoomStartupForDiagnostics } = await import("../examples/v3-room/src/index.js");
	expect(waitForV3RoomStartupForDiagnostics).toBeTypeOf("function");
	const fixture = await openRoom(2, false, false, false, ({ identities, creatorPeerId }) => {
		const roster = identities.map(({ author }, order) => ({
			author,
			peerId: `${creatorPeerId.slice(0, -1)}${order}`,
			order,
		}));
		return createV3ZoneApplication(roster, creatorPeerId, required(identities[0]).author);
	});
	for (const peer of fixture.peers)
		await expect(waitForV3RoomStartupForDiagnostics(peer.room)).resolves.toBeUndefined();
	const creator = required(fixture.peers[0]);
	const follower = required(fixture.peers[1]);
	const callsBefore = { commits: observed.commits.length, publications: observed.publications.length };
	for (const peer of fixture.peers) {
		await expect(waitForV3RoomStartupForDiagnostics(peer.room)).resolves.toBeUndefined();
	}
	expect({ commits: observed.commits.length, publications: observed.publications.length }).toEqual(callsBefore);
	for (const foreign of [undefined, null, {}, { ...creator.room }, Object.create(creator.room)]) {
		await expect(
			Promise.resolve().then(() => Reflect.apply(waitForV3RoomStartupForDiagnostics, undefined, [foreign]))
		).rejects.toThrow();
	}
	await follower.room.close();
	sessions.delete(follower.room);
	await expect(waitForV3RoomStartupForDiagnostics(follower.room)).rejects.toThrow();
	await expect(waitForV3RoomStartupForDiagnostics(creator.room)).resolves.toBeUndefined();
}, 120_000);

it("propagates the same original failed startup recovery as the real room issue path", async () => {
	const { waitForV3RoomStartupForDiagnostics } = await import("../examples/v3-room/src/index.js");
	const fixture = await openRoom(2, false, false, false, ({ identities, creatorPeerId }) => {
		const roster = identities.map(({ author }, order) => ({
			author,
			peerId: `${creatorPeerId.slice(0, -1)}${order}`,
			order,
		}));
		return createV3ZoneApplication(roster, creatorPeerId, required(identities[0]).author);
	});
	const creator = required(fixture.peers[0]);
	const follower = required(fixture.peers[1]);
	for (const peer of fixture.peers) await waitForV3RoomStartupForDiagnostics(peer.room);
	await follower.room.issue({ action: "placeBlock", id: "startup-before-close", kind: "stone", x: 1, y: 1 });
	expect(await fixture.close()).toMatchObject({ ok: true });
	fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	// Real transport refusal on the already-started successor recovery, not a
	// manufactured runtime or substituted startup promise.
	fixture.publicationFailures.add(follower.databaseName);
	await fixture.reopen(follower, 0, true);
	const [waiting, issuing] = await Promise.allSettled([
		waitForV3RoomStartupForDiagnostics(follower.room),
		follower.room.issue({ action: "placeBlock", id: "must-not-issue-after-failed-startup", kind: "stone", x: 2, y: 2 }),
	]);
	expect(waiting.status, "STARTUP_BARRIER_MUST_NOT_SWALLOW_REAL_FAILURE").toBe("rejected");
	expect(issuing.status, "REAL_ROOM_STARTUP_FAILURE_CONTROL").toBe("rejected");
	if (waiting.status !== "rejected" || issuing.status !== "rejected") throw new Error("MISSING_STARTUP_FAILURE");
	expect(waiting.reason).toBeInstanceOf(Error);
	expect(waiting.reason, "ORIGINAL_STARTUP_FAILURE_IDENTITY_PRESERVED").toBe(issuing.reason);
}, 120_000);
