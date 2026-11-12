import { describe, expect, it } from "vitest";

import { DRPError, isDRPError } from "../packages/errors/src/index.js";
import * as nodeRoom from "../packages/node/src/v3-room.js";
import { decodeError, encodeError } from "../packages/room-worker/src/index.js";
import * as room from "../examples/v3-room/src/index.js";
import { V3_ROOM_WORKER_ERROR_CODECS } from "../examples/v3-room/src/worker.js";

// A room hosted in a worker must hand the app the room's typed errors intact: the same class
// (instanceof), name, message, fields and cause. The binding's codec table must name every
// exported V3Room* error class, so a new one (V3RoomBusy, for one) cannot land without it.

const roundTrip = (error: unknown): unknown =>
	decodeError(structuredClone(encodeError(error, V3_ROOM_WORKER_ERROR_CODECS)), V3_ROOM_WORKER_ERROR_CODECS);

const exportedErrorClasses = (): Map<string, abstract new (...args: never[]) => Error> => {
	const classes = new Map<string, abstract new (...args: never[]) => Error>();
	for (const module of [nodeRoom, room] as Record<string, unknown>[])
		for (const [name, value] of Object.entries(module))
			if (typeof value === "function" && value.prototype instanceof Error && name.startsWith("V3Room"))
				classes.set(name, value as abstract new (...args: never[]) => Error);
	return classes;
};

describe("v3 room errors across the room worker boundary", () => {
	it("the codec table names every exported V3Room* error class", () => {
		const classes = exportedErrorClasses();
		expect(classes.size).toBeGreaterThanOrEqual(10);
		const covered = new Set(V3_ROOM_WORKER_ERROR_CODECS.map((codec) => codec.type));
		const missing = [...classes].filter(([, type]) => !covered.has(type)).map(([name]) => name);
		expect(missing).toEqual([]);
	});

	it("a member's not-reaching-host refusal keeps its class, kept move, epoch and backlog cause", () => {
		const operation = Object.freeze({ action: "placeBlock", id: "b7", kind: "stone", x: 1, y: 2 });
		const backlog = new nodeRoom.V3RoomLocalBacklogFull(65, 64);
		const decoded = roundTrip(new room.V3RoomNotReachingHost(operation, 9, { cause: backlog }));
		expect(decoded).toBeInstanceOf(room.V3RoomNotReachingHost);
		const typed = decoded as InstanceType<typeof room.V3RoomNotReachingHost>;
		expect(typed.operation).toEqual(operation);
		expect(typed.epoch).toBe(9);
		expect(typed.name).toBe("V3RoomNotReachingHost");
		expect(typed.cause).toBeInstanceOf(nodeRoom.V3RoomLocalBacklogFull);
		expect((typed.cause as InstanceType<typeof nodeRoom.V3RoomLocalBacklogFull>).backlog).toBe(65);
		expect((typed.cause as InstanceType<typeof nodeRoom.V3RoomLocalBacklogFull>).bound).toBe(64);
	});

	it("every room refusal keeps what the app branches on", () => {
		const cases: [Error, Record<string, unknown>][] = [
			[new nodeRoom.V3RoomNotYetCurrent("behind-frontier", "epoch 4"), { reason: "behind-frontier", code: "V3_ROOM_NOT_YET_CURRENT" }],
			[new nodeRoom.V3RoomAdoptionHoldExpired(1_200), { heldMs: 1_200 }],
			[new nodeRoom.V3RoomSuccessorInstallExpired(120_000), { deadlineMs: 120_000, stage: "material" }],
			[new nodeRoom.V3RoomAwaitingAuthorFence(3), { epoch: 3 }],
			[new room.V3RoomReadOnly({ action: "m" }, 2), { epoch: 2 }],
			[new room.V3RoomSuccessorUnavailable({ action: "m" }, 5, 30_000), { epoch: 5, waitedMs: 30_000 }],
			[new room.V3RoomAwaitingFence({ action: "m" }, 6), { epoch: 6 }],
			[new room.V3RoomPlayerDatabaseMigrationUnavailable("x"), { code: "V3_ROOM_PLAYER_DATABASE_MIGRATION_UNAVAILABLE" }],
		];
		for (const [error, fields] of cases) {
			const decoded = roundTrip(error) as Error;
			expect(decoded, error.name).toBeInstanceOf(error.constructor as new () => Error);
			expect(decoded.name).toBe(error.name);
			expect(decoded.message).toBe(error.message);
			expect(decoded).toMatchObject(fields);
		}
	});

	it("a coded DRP error stays a DRP error, and the close-pending refusal is still recognized", () => {
		const coded = roundTrip(new DRPError("CANONICAL_ENCODING", "too big")) as DRPError;
		expect(isDRPError(coded)).toBe(true);
		expect(coded.code).toBe("CANONICAL_ENCODING");

		const closePending = new Error(`v3 room issue refused: ${nodeRoom.V3_ROOM_CLOSE_PENDING}: retry after the close adopts`);
		expect(nodeRoom.isV3RoomClosePendingRefusal(roundTrip(closePending))).toBe(true);
	});
});
