import { describe, expect, it } from "vitest";

import { createV3RoomWorkerReservations } from "../examples/v3-room/src/worker.js";

/**
 * A worker-hosted room holds its native read reservations through page-owned handles. When the worker
 * stops, those reservations must go with it, as a dead process's native locks do: otherwise the
 * external authority stays locked for every other writer (the creator's next issue fails "database is
 * locked").
 */
function fakeAuthority(): Readonly<{
	authority: Record<string, unknown>;
	released: string[];
	acquired: string[];
}> {
	const released: string[] = [];
	const acquired: string[] = [];
	let next = 0;
	const authority = {
		initialization: "reopen",
		read: (): Promise<string> => Promise.resolve("read"),
		acquireNativeReadReservation: (): Promise<{ check(): Promise<void>; release(): Promise<void> }> => {
			const id = `r${next++}`;
			acquired.push(id);
			return Promise.resolve({
				check: (): Promise<void> => Promise.resolve(),
				release: (): Promise<void> => {
					released.push(id);
					return Promise.resolve();
				},
			});
		},
	};
	return { authority, released, acquired };
}

type Reservation = { check(): Promise<void>; release(): Promise<void> };
type Authority = {
	initialization: string;
	read(): Promise<string>;
	acquireNativeReadReservation(input: unknown): Promise<Reservation>;
};

describe("room worker: a stopped worker's native read reservations", () => {
	it("releases every reservation the worker still holds, once, and none it released", async () => {
		const { authority, released, acquired } = fakeAuthority();
		const reservations = createV3RoomWorkerReservations();
		const factory = reservations.wrap((_context: unknown) => authority as never);
		const wrapped = (await factory({})) as unknown as Authority;
		expect(wrapped.initialization).toBe("reopen");
		await expect(wrapped.read()).resolves.toBe("read");
		const first = await wrapped.acquireNativeReadReservation({ scope: "s" });
		const second = await wrapped.acquireNativeReadReservation({ scope: "s" });
		await first.release();
		expect(reservations.held).toBe(1);
		await reservations.releaseAll();
		expect(acquired).toEqual(["r0", "r1"]);
		expect(released).toEqual(["r0", "r1"]);
		expect(reservations.held).toBe(0);
		// A late release from the stopped worker's handle releases nothing twice.
		await second.release();
		await reservations.releaseAll();
		expect(released).toEqual(["r0", "r1"]);
	});

	it("keeps an authority without native reservations unchanged", async () => {
		const reservations = createV3RoomWorkerReservations();
		const plain = { initialization: "create", read: (): Promise<string> => Promise.resolve("plain") };
		const wrapped = (await reservations.wrap((_context: unknown) => plain as never)({})) as unknown as {
			initialization: string;
			read(): Promise<string>;
			acquireNativeReadReservation?: unknown;
		};
		expect(wrapped.acquireNativeReadReservation).toBeUndefined();
		await expect(wrapped.read()).resolves.toBe("plain");
		await reservations.releaseAll();
	});
});
