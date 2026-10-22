/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inferred fixture shapes. */
import { afterEach, expect, it, vi } from "vitest";

import type { LongRoomOptions } from "./fixtures/canvas-chat-lull/long-room-driver.js";
import { openTrackZRoom, playEpochs, type TrackZRoom } from "./fixtures/track-z/default-room.js";
import type * as Binding from "../examples/v3-room/src/index.js";

// Track Z, RED first: a retained publication that the serving session's own successor cancels is
// not a publication fault.
//
// On the new default each recipient's lull starts right after its install, and a lull that
// maintained the pool asks every peer for retained history (the repair of arrivals refused at the
// bounded input pool). A peer that is itself adopting (the creator) or installing (a recipient) at
// that moment serves the request from the plane its successor is replacing. The successor's
// activation retires that plane's registration, so a send already in flight ends
// `publication-state-unknown` and a publication that starts in the activation window ends
// `not-active`. The room's retained publisher rejected with both outside an orderly close, so a
// transport that joins its admitted work counted an operation failure: the healthy native Grid bench
// at the new default failed its persisted close in 3 of 6 runs, with exactly these two messages.
// An orderly close already cancels a publication this way (f9828cd0). A successor activation is
// the same cancellation: the plane the publication read is gone, and its successor serves the next
// request.
//
// Guards (these must still reject): a send that fails while the serving plane is still current
// (`publish-failed`), and a publication that finds its target unavailable with no successor in
// flight (`not-active`). Store and record faults are covered by
// packages/node/tests/retained-publication-cancel.test.ts.
//
// The binding is wrapped so every room's transport keeps the session's retained publisher, lists
// the target as connected while a publication runs (the loopback network lists no peers), can hold
// one targeted send, and can start a publication from inside the successor's activation. A room
// opened with no `storageHost` gets what the new default selects (the room database with retention
// and the scheduled lull), with or without the flip. Chat with a Writer recipient
// (fake-indexeddb): both roles issue, so both publish rows.

type Role = "creator" | "recipient";
type Hold = { armed: boolean; held?(): void; release?(error?: Error): void };
type Wire = {
	peerId: string;
	peers: string[];
	publisher?(targetPeerId?: string): Promise<void>;
	hold: Hold;
	onActivation?(): void;
};
const wires: Partial<Record<Role, Wire>> = {};

vi.mock("../examples/v3-room/src/index.js", async (importOriginal) => {
	const original = await importOriginal<typeof Binding>();
	type Input = Parameters<typeof Binding.createV3RoomSession>[0];
	return {
		...original,
		createV3RoomSession: (input: Input): ReturnType<typeof Binding.createV3RoomSession> => {
			const openTransport = Reflect.get(input, "openTransport") as unknown;
			if (typeof openTransport !== "function") return original.createV3RoomSession(input);
			const role: Role = input.creatorFinalitySigner === undefined ? "recipient" : "creator";
			const wrapped = (...args: unknown[]) => {
				const transport = Reflect.apply(openTransport, input, args) as Record<string, unknown>;
				const networkNode = transport.networkNode as Record<string, unknown>;
				const wire: Wire = { peerId: String(networkNode.peerId), peers: [], hold: { armed: false } };
				wires[role] = wire;
				Reflect.set(networkNode, "getAllPeers", () => [...wire.peers]);
				// A plane activation reads the subscribed topics, then replaces the registration in the
				// same synchronous step; a publication started from a microtask queued here runs in the
				// window after the replacement, before the session switched its active plane.
				const topics = networkNode.getSubscribedTopics as () => string[];
				Reflect.set(networkNode, "getSubscribedTopics", () => {
					const start = wire.onActivation;
					if (start !== undefined && (new Error().stack ?? "").includes("activateV3LivePlane")) {
						wire.onActivation = undefined;
						queueMicrotask(start);
					}
					return Reflect.apply(topics, networkNode, []);
				});
				const send = networkNode.sendMessage as (...sent: unknown[]) => Promise<void>;
				Reflect.set(networkNode, "sendMessage", (...sent: unknown[]) => {
					const hold = wire.hold;
					if (!hold.armed) return Reflect.apply(send, networkNode, sent);
					hold.armed = false;
					return new Promise<void>((resolve, reject) => {
						hold.release = (error) =>
							error === undefined ? resolve(Reflect.apply(send, networkNode, sent)) : reject(error);
						hold.held?.();
					});
				});
				return {
					...transport,
					setRetainedPublisher: (publisher: (targetPeerId?: string) => Promise<void>) => {
						wire.publisher = publisher;
						return (transport.setRetainedPublisher as (selected: unknown) => unknown)(publisher);
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
	delete wires.creator;
	delete wires.recipient;
	expect(failures.flat()).toEqual([]);
}, 300_000);

const options: LongRoomOptions = {
	app: "chat",
	host: "room",
	recipient: "writer",
	bound: "shipped",
	epochs: 0,
	moves: 2,
	lullMoves: 0,
};
const PLAYED = 3;
type Outcome = Readonly<{ ok: true } | { ok: false; error: string }>;

/**
 * Opens a room, plays PLAYED epochs, then epoch PLAYED's moves (as playEpochs), so both roles have
 * rows to publish, stopping before its seal.
 * @returns The room.
 */
async function openPlayed() {
	const room = await openTrackZRoom(options, "default");
	rooms.add(room);
	await playEpochs(room, options, PLAYED);
	const role = (index: 0 | 1) => (index === 0 ? room.creator : room.recipient);
	const flush = async (from: 0 | 1) => {
		const rows = await role(from).published(room.delivered[from] ?? null);
		const last = rows.at(-1);
		if (last === undefined) return;
		await role(from === 0 ? 1 : 0).receive(rows);
		room.delivered[from] = last.authorSequence;
	};
	for (let ordinal = 0; ordinal < options.moves; ordinal++) {
		await room.creator.issue(PLAYED, ordinal);
		await flush(0);
		await room.recipient.issue(PLAYED, ordinal);
		await flush(1);
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
	return room;
}

/**
 * Serves one retained-history request: `server`'s publisher, targeted at the other role.
 * @param server - The role whose session serves it.
 * @param connected - Whether the target is listed as connected while it runs.
 * @returns The publisher's outcome.
 */
function publish(server: Role, connected = true): Promise<Outcome> {
	const wire = wires[server];
	const target = wires[server === "creator" ? "recipient" : "creator"];
	if (wire?.publisher === undefined || target === undefined) throw new TypeError("retained publisher is unbound");
	if (connected) wire.peers = [target.peerId];
	return wire
		.publisher(target.peerId)
		.then(
			(): Outcome => ({ ok: true }),
			(error: unknown): Outcome => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
		)
		.finally(() => {
			wire.peers = [];
		});
}

/**
 * Starts `server`'s publication and resolves once its first send is held.
 * @param server - The role whose session serves it.
 * @returns The serving wire and the publication's outcome.
 */
async function holdPublication(server: Role) {
	const wire = wires[server];
	if (wire === undefined) throw new TypeError("transport is unbound");
	const held = new Promise<void>((resolve) => {
		wire.hold = { armed: true, held: resolve };
	});
	const publication = publish(server);
	const first = await Promise.race([held.then(() => "held" as const), publication.then(() => "settled" as const)]);
	const settled = first === "settled" ? JSON.stringify(await publication) : "";
	expect(first, `${server}'s retained publication reached a send ${settled}`).toBe("held");
	return { wire, publication };
}

it("the creator's send in flight when its own adoption retires the plane does not reject", async () => {
	const room = await openPlayed();
	await room.creator.seal(PLAYED);

	const { wire, publication } = await holdPublication("creator");
	let waited = false;
	const fallback = setTimeout(() => {
		waited = true;
		wire.hold.release?.();
	}, 60_000);
	await room.creator.adopt().finally(() => clearTimeout(fallback));
	expect(waited, "the adoption did not wait for the held send").toBe(false);
	wire.hold.release?.();

	expect(await publication, "a send the creator's own adoption cancelled is not a fault").toEqual({ ok: true });
	const exported = await room.creator.exportOffer();
	await room.recipient.install(exported.offer);
	expect(await room.recipient.authorityEpoch()).toBe(PLAYED + 1);
	await playEpochs(room, options, 1, PLAYED + 1);
}, 480_000);

it("a recipient (Writer) asked for retained history inside its own install's activation does not reject", async () => {
	const room = await openPlayed();
	await room.creator.seal(PLAYED);
	await room.creator.adopt();
	const exported = await room.creator.exportOffer();

	const wire = wires.recipient;
	if (wire === undefined) throw new TypeError("transport is unbound");
	let publication: Promise<Outcome> | undefined;
	wire.onActivation = () => {
		publication = publish("recipient");
	};
	await room.recipient.install(exported.offer);
	expect(publication, "the install activated a successor plane").toBeDefined();

	expect(await publication, "a publication the recipient's own install cancelled is not a fault").toEqual({
		ok: true,
	});
	expect(await room.recipient.authorityEpoch()).toBe(PLAYED + 1);
	await playEpochs(room, options, 1, PLAYED + 1);
}, 480_000);

it("guard: a send that fails while the serving plane is still current still rejects", async () => {
	const room = await openPlayed();

	const { wire, publication } = await holdPublication("recipient");
	wire.hold.release?.(new Error("TRACK_Z_SEND_REFUSED"));

	expect(await publication).toEqual({ ok: false, error: "v3 room retained publication failed: publish-failed" });
	await playEpochs(room, options, 1, PLAYED);
}, 480_000);

it("guard: a target that is unavailable with no successor in flight still rejects", async () => {
	const room = await openPlayed();

	expect(await publish("creator", false)).toEqual({
		ok: false,
		error: "v3 room retained publication failed: not-active",
	});
	await playEpochs(room, options, 1, PLAYED);
}, 480_000);
