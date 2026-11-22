import { afterEach, beforeEach, expect, it } from "vitest";

import {
	closeFixtures,
	heads,
	installEnvironment,
	required,
	rooms,
} from "./fixtures/track-m/room-retention-fixture.js";
import { type SealSourceHost, sealSourceRoom, type SealSourceRoom } from "./fixtures/track-x/seal-source-room.js";

// Track X RED: the creator's seal must not wait on its own live journal.
//
// close() (packages/node/src/creator-close.ts) takes the promotion source, and at epoch 2 the
// recovery source, BEFORE it stages the snapshot. Taking a source holds the live journal's
// native read reservation: a readonly IndexedDB transaction on the journal's stores that stays
// open and, by design, excludes every native writer. stageSnapshot then closes admission and
// waits for every task already in the plane's FIFO. An ingress task that started before
// admission closed appends to the same journal (a vertex the creator already has still takes
// an idempotent append); IndexedDB runs that readwrite transaction only after the held view
// ends, and the view ends only after the stage. Nothing in the cycle has a timeout: the seal
// never returns. In the shipped Canvas page the trigger is a recipient's retained-history
// push reaching the creator while it seals (<evidence>/verify-x/, Track X RESULT section 9).
//
// The test delivers a copy of one of the creator's own vertices back to it at the moment the
// seal's journal source is taken (a held journal view is created), on the default six-database
// host and on the room-database host, for the epoch-2 recovery source and for a promotion
// close's promotion source. The seal must return, and the creator must issue afterwards.

const BOUND_MS = Number(process.env.TRACK_X_RED_SEAL_BOUND_MS ?? 30_000);

let restore: (() => void) | undefined;
let held: SealSourceRoom | undefined;
beforeEach(() => {
	held = undefined;
	restore = installEnvironment(() => undefined);
});
afterEach(async () => {
	// A held seal never releases its room: leave that room and its floor, join the rest.
	if (held !== undefined) {
		rooms.delete(held.room);
		heads.delete(held.floor);
	}
	const joined = await closeFixtures();
	restore?.();
	expect(joined, "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<"timeout"> => new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));

async function bounded<Value>(promise: Promise<Value>): Promise<Value | "timeout"> {
	return Promise.race([promise, sleep(BOUND_MS)]);
}

/**
 * Calls `react` each time a held journal read view (the native read reservation's readonly
 * transaction on the journal's accepted entries) is created. Observation only: the original
 * transaction is returned unchanged.
 * @param react - Called synchronously at the view's creation, with the creating stack.
 * @returns Removes the observer.
 */
function onJournalView(react: (stack: string) => void): () => void {
	const prototype = IDBDatabase.prototype;
	const original = Object.getOwnPropertyDescriptor(prototype, "transaction");
	const transaction = prototype.transaction;
	Object.defineProperty(prototype, "transaction", {
		configurable: true,
		writable: true,
		value: function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>): IDBTransaction {
			const created = Reflect.apply(transaction, this, args) as IDBTransaction;
			const stores = typeof args[0] === "string" ? [args[0]] : [...args[0]];
			if ((args[1] ?? "readonly") === "readonly" && stores.some((store) => store.endsWith("acceptedEntries"))) {
				const limit = Error.stackTraceLimit;
				Error.stackTraceLimit = 40;
				const stack = new Error().stack ?? "";
				Error.stackTraceLimit = limit;
				if (stack.includes("HeldReadView")) react(stack);
			}
			return created;
		},
	});
	return () => {
		if (original === undefined) Reflect.deleteProperty(prototype, "transaction");
		else Object.defineProperty(prototype, "transaction", original);
	};
}

const move = (fixture: SealSourceRoom, id: string, x: number): Promise<unknown> =>
	fixture.room.issue({ action: "placeBlock", id, kind: "stone", x, y: 0 });

async function rollover(fixture: SealSourceRoom, epoch: number): Promise<void> {
	await move(fixture, `m-${epoch}`, epoch);
	const sealed = await fixture.room.sealEpoch();
	expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
	await fixture.room.adoptCreatorSuccessor();
	expect(fixture.room.authority()?.epoch).toBe(epoch + 1);
}

/**
 * The journal view of a source the creator's close() takes (creator-close.ts `acquireSource`,
 * reached from close(), not from the promotion checkpoint taken before it).
 * @param stack - The stack that created the view.
 * @returns Whether close() took it.
 */
const closeSourceView = (stack: string): boolean =>
	/acquireSource \(.*creator-close\.ts/u.test(stack) && !stack.includes("acquirePromotionCheckpoint");

/**
 * Runs `close` while every journal view a source of close() takes is met by a copy of the
 * creator's latest published vertex, delivered back to the creator (TRACK_X_RED_ECHO=0: no
 * copy, the control).
 * @param fixture - The creator.
 * @param close - The seal or promotion under test.
 * @returns The close outcome and how many source views close() created.
 */
async function closeWithEcho<Value>(
	fixture: SealSourceRoom,
	close: () => Promise<Value>
): Promise<Readonly<{ outcome: Value | "timeout"; views: number }>> {
	const echoed = required(fixture.published.at(-1));
	let views = 0;
	const stop = onJournalView((stack) => {
		if (!closeSourceView(stack)) return;
		views++;
		if (process.env.TRACK_X_RED_ECHO !== "0") queueMicrotask(() => fixture.echo(echoed));
	});
	try {
		return { outcome: await bounded(close()), views };
	} finally {
		stop();
	}
}

for (const host of ["six-database", "room-database"] as const satisfies readonly SealSourceHost[]) {
	it(`${host}: the epoch-2 seal returns when a duplicate ingress meets its recovery source`, async () => {
		const fixture = await sealSourceRoom(host);
		await rollover(fixture, 0);
		await rollover(fixture, 1);
		await move(fixture, "m-2", 2);
		const { outcome, views } = await closeWithEcho(fixture, () => fixture.room.sealEpoch());
		expect(views, "the epoch-2 seal took a journal source").toBeGreaterThan(0);
		if (outcome === "timeout") {
			held = fixture;
			throw new TypeError(`TRACK_X_RED the epoch-2 seal waited on its own journal for ${BOUND_MS} ms`);
		}
		expect((outcome as { ok?: boolean }).ok, JSON.stringify(outcome)).toBe(true);
		await fixture.room.adoptCreatorSuccessor();
		await move(fixture, "m-3", 3);
		expect(fixture.room.authority()?.epoch).toBe(3);
	}, 180_000);

	it(`${host}: a promotion close returns when a duplicate ingress meets its promotion source`, async () => {
		const fixture = await sealSourceRoom(host);
		await rollover(fixture, 0);
		await move(fixture, "m-1", 1);
		const { outcome, views } = await closeWithEcho(fixture, () =>
			fixture.room.promoteCreatorCheckpoint({ closedEpoch: 0 })
		);
		expect(views, "the promotion took a journal source").toBeGreaterThan(0);
		if (outcome === "timeout") {
			held = fixture;
			throw new TypeError(`TRACK_X_RED the promotion close waited on its own journal for ${BOUND_MS} ms`);
		}
		expect(fixture.room.authority()?.epoch).toBe(2);
		await move(fixture, "m-2", 2);
	}, 180_000);
}
