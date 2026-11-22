/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inferred fixture shapes. */
import { afterEach, expect, it, vi } from "vitest";

import type { LongRoomOptions } from "./fixtures/canvas-chat-lull/long-room-driver.js";
import { openTrackZRoom, playEpochs, type ProofEvent, type TrackZRoom } from "./fixtures/track-z/default-room.js";
import type * as Binding from "../examples/v3-room/src/index.js";

// Track Z, RED first: a scheduled lull still running when the application closes the room does
// no network work after the close.
//
// On the new default the recipient's lull starts right after its install, so an application may
// close the room while that lull is still running (the healthy native Grid bench does, at its
// persisted close). The session's close revokes the room transport at once and then waits for
// the lull to finish. A recipient lull that maintained the pool asks the transport for retained
// history (the repair of arrivals refused at the bounded input pool), and that request must not
// reach a transport the close already revoked: the session's other retained-history requests
// already stop at close, and the next open asks for retained history anyway.
//
// The binding is wrapped so every room's transport records its close and each retained-history
// request, and so a room opened with no `storageHost` gets what the new default selects: the
// room database with retention and the scheduled lull (the same with or without the flip). The
// room (fake-indexeddb) plays 5 epochs; in the 6th, the recipient is closed from inside its
// scheduled lull, at the lull's retention pass, before the lull returns.

type TransportLog = { closed: boolean; requests: number; afterClose: number };
const transports: Record<"creator" | "recipient", TransportLog[]> = { creator: [], recipient: [] };

vi.mock("../examples/v3-room/src/index.js", async (importOriginal) => {
	const original = await importOriginal<typeof Binding>();
	type Input = Parameters<typeof Binding.createV3RoomSession>[0];
	return {
		...original,
		createV3RoomSession: (input: Input): ReturnType<typeof Binding.createV3RoomSession> => {
			const openTransport = Reflect.get(input, "openTransport") as unknown;
			if (typeof openTransport !== "function") return original.createV3RoomSession(input);
			const role = input.creatorFinalitySigner === undefined ? "recipient" : "creator";
			const wrapped = (...args: unknown[]) => {
				const transport = Reflect.apply(openTransport, input, args) as Record<string, unknown>;
				const log: TransportLog = { closed: false, requests: 0, afterClose: 0 };
				transports[role].push(log);
				return {
					...transport,
					close: () => {
						log.closed = true;
						return (transport.close as () => unknown)();
					},
					requestRetainedHistory: () => {
						log.requests++;
						if (log.closed) log.afterClose++;
						return (transport.requestRetainedHistory as () => unknown)();
					},
				};
			};
			const host =
				input.storageHost === undefined
					? {
							storageHost: original.createBrowserV3RoomDatabaseStorageHost({ roomRetention: true }),
							recoveryPoolScheduledLull: true,
						}
					: {};
			return original.createV3RoomSession({ ...input, ...host, openTransport: wrapped } as Input);
		},
	};
});

const rooms = new Set<TrackZRoom>();
afterEach(async () => {
	const failures = await Promise.all([...rooms].map((room) => room.close()));
	rooms.clear();
	transports.creator.length = 0;
	transports.recipient.length = 0;
	expect(failures.flat()).toEqual([]);
}, 300_000);

const options = (app: "canvas" | "chat", recipient: "receive-only" | "writer"): LongRoomOptions => ({
	app,
	host: "room",
	recipient,
	bound: "shipped",
	epochs: 0,
	moves: 2,
	lullMoves: 0,
});
const PLAYED = 5;

it.each([
	["canvas", "receive-only"],
	["chat", "writer"],
] as const)(
	"%s: a recipient (%s) closed while its scheduled lull runs requests no retained history after the close",
	async (app, recipient) => {
		const selected = options(app, recipient);
		const room = await openTrackZRoom(selected, "default");
		rooms.add(room);
		await playEpochs(room, selected, PLAYED);

		// Epoch PLAYED + 1: close the recipient from inside its scheduled lull, at its retention pass.
		const fixtureObserver = Reflect.get(globalThis, "__warmProofEvent") as (event: ProofEvent) => void;
		let armed = false;
		let closing: Promise<void> | undefined;
		let closedAt = -1;
		Reflect.set(globalThis, "__warmProofEvent", (event: ProofEvent) => {
			const before = room.events.recipient.length;
			fixtureObserver(event);
			if (!armed || room.events.recipient.length === before || event.kind !== "room-retention-pass") return;
			armed = false;
			closedAt = room.events.recipient.length - 1;
			closing = room.recipient.close();
		});
		// As playEpochs (tests/fixtures/track-z/default-room.ts), one epoch.
		const role = (index: 0 | 1) => (index === 0 ? room.creator : room.recipient);
		const flush = async (from: 0 | 1) => {
			const rows = await role(from).published(room.delivered[from] ?? null);
			const last = rows.at(-1);
			if (last === undefined) return;
			await role(from === 0 ? 1 : 0).receive(rows);
			room.delivered[from] = last.authorSequence;
		};
		try {
			for (let ordinal = 0; ordinal < selected.moves; ordinal++) {
				await room.creator.issue(PLAYED, ordinal);
				await flush(0);
				if (recipient !== "writer") continue;
				await room.recipient.issue(PLAYED, ordinal);
				await flush(1);
			}
			await new Promise((resolve) => setTimeout(resolve, 300));
			await room.creator.seal(PLAYED);
			await room.creator.adopt();
			const exported = await room.creator.exportOffer();
			armed = true;
			await room.recipient.install(exported.offer);
			for (let wait = 0; closing === undefined && wait < 600; wait++)
				await new Promise((resolve) => setTimeout(resolve, 50));
			expect(closing, "the recipient's scheduled lull ran a retention pass after its install").toBeDefined();
			await closing;
		} finally {
			Reflect.set(globalThis, "__warmProofEvent", fixtureObserver);
		}

		// The lull was still running when the close began: its own event came after the close.
		const lulls = room.events.recipient
			.map((event, index) => ({ event, index }))
			.filter(({ event }) => event.kind === "recovery-pool-lull" && Number(event.epoch) === PLAYED + 1);
		expect(
			lulls.map(({ event, index }) => [event.trigger, event.result, index > closedAt]),
			"the epoch's scheduled lull maintained the pool and finished after the close began"
		).toEqual([["scheduled", "maintained", true]]);
		const recipientTransport = transports.recipient.at(-1);
		expect(recipientTransport?.closed, "the close revoked the recipient's transport").toBe(true);
		expect(
			recipientTransport?.afterClose,
			"no retained-history request reached the transport after the close revoked it"
		).toBe(0);
	},
	480_000
);
