/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inferred fixture shapes. */
import type * as V3Live from "@ts-drp/node/v3-live";
import { MessageType } from "@ts-drp/types";
import { afterEach, expect, it, vi } from "vitest";

import type { LongRoomOptions } from "./fixtures/canvas-chat-lull/long-room-driver.js";
import { openTrackZRoom, playEpochs, type TrackZRoom } from "./fixtures/track-z/default-room.js";
import type * as Binding from "../examples/v3-room/src/index.js";
import type * as RollbackData from "../packages/node/src/internal/creator-closed-rollback-data.js";
import { readV3RuntimeOwnerCensus, republishV3RetainedTo } from "../packages/node/src/v3-live.js";
import { NativeReadReservationOwner } from "../packages/storage-browser/dist/src/internal/native-read-reservation.js";

const capturedReplayPlane = vi.hoisted(() => ({ current: undefined as V3Live.V3PlaneHandle | undefined }));
vi.mock("@ts-drp/node/v3-live", async (importOriginal) => {
	const original = await importOriginal<typeof V3Live>();
	return {
		...original,
		republishV3RetainedTo: (...args: Parameters<typeof original.republishV3RetainedTo>) => {
			capturedReplayPlane.current = args[0];
			return original.republishV3RetainedTo(...args);
		},
	};
});

const capturedSources = vi.hoisted(() => new Set<RollbackData.CreatorForwardPromotionSourceMaterial>());
vi.mock("../packages/node/src/internal/creator-closed-rollback-data.js", async (importOriginal) => {
	const original = await importOriginal<typeof RollbackData>();
	return {
		...original,
		resolveCreatorForwardPromotionSource: (
			...args: Parameters<typeof original.resolveCreatorForwardPromotionSource>
		) => {
			const source = original.resolveCreatorForwardPromotionSource(...args);
			if (source !== undefined) capturedSources.add(source);
			return source;
		},
	};
});

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
	networkNode: Record<string, unknown>;
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
				const wire: Wire = { peerId: String(networkNode.peerId), networkNode, peers: [], hold: { armed: false } };
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
	capturedSources.clear();
	capturedReplayPlane.current = undefined;
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
	const predecessor = capturedReplayPlane.current;
	if (predecessor === undefined) throw new TypeError("creator plane is unavailable");
	expect(readV3RuntimeOwnerCensus(predecessor)?.retainedReplayPrefixRows).toBeGreaterThan(0);
	let waited = false;
	const fallback = setTimeout(() => {
		waited = true;
		wire.hold.release?.();
	}, 60_000);
	await room.creator.adopt().finally(() => clearTimeout(fallback));
	expect(waited, "the adoption did not wait for the held send").toBe(false);
	expect(readV3RuntimeOwnerCensus(predecessor)).toMatchObject({
		active: 0,
		retainedReplayPrefixRows: 0,
		retainedReplayBufferedRows: 1,
		retainedReplayNativeSends: 1,
		admittedEgressControlJobs: 1,
	});
	wire.hold.release?.();

	expect(await publication, "a send the creator's own adoption cancelled is not a fault").toEqual({ ok: true });
	const exported = await room.creator.exportOffer();
	await room.recipient.install(exported.offer);
	expect(await room.recipient.authorityEpoch()).toBe(PLAYED + 1);
	await playEpochs(room, options, 1, PLAYED + 1);
}, 480_000);

it("creator close drains replay reads before acquiring its native sources", async () => {
	const room = await openPlayed();
	let running = true;
	const outcomes: Outcome[] = [];
	const replay = (async () => {
		while (running) {
			outcomes.push(await publish("creator"));
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	})();
	try {
		await room.creator.seal(PLAYED);
	} finally {
		running = false;
		await replay;
	}
	expect(outcomes.length).toBeGreaterThan(0);
	expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
	expect(await publish("creator")).toEqual({ ok: true });
}, 480_000);

it.each(["creator", "recipient"] as const)(
	"successor native preparation joins concurrent %s replay reads",
	async (server) => {
		const room = await openPlayed();
		await room.creator.seal(PLAYED);
		if (server === "recipient") await room.creator.adopt();
		const offer = server === "recipient" ? await room.creator.exportOffer() : undefined;
		let running = true;
		const outcomes: Outcome[] = [];
		const replay = (async () => {
			while (running) {
				outcomes.push(await publish(server));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		})();
		try {
			if (offer === undefined) await room.creator.adopt();
			else await room.recipient.install(offer.offer);
		} finally {
			running = false;
			await replay;
		}
		expect(outcomes.length).toBeGreaterThan(0);
		expect(
			outcomes.every((outcome) => outcome.ok),
			JSON.stringify(outcomes)
		).toBe(true);
	},
	480_000
);

it("a malformed successor offer leaves ordinary retained publication available", async () => {
	const room = await openPlayed();
	await room.creator.seal(PLAYED);
	await room.creator.adopt();
	const exported = await room.creator.exportOffer();
	await expect(
		room.recipient.install({ ...exported.offer, exactCanonicalCommitQcBytes: new Uint8Array([0]) })
	).rejects.toThrow();
	expect(await publish("recipient")).toEqual({ ok: true });
}, 480_000);

it("physical retained sends share one egress bound across multiple hot handoffs", async () => {
	const room = await openPlayed();
	const old: { release(): void; publication: Promise<Outcome>; plane: V3Live.V3PlaneHandle }[] = [];
	const releaseCurrent: (() => void)[] = [];
	const currentPublications: Promise<unknown>[] = [];
	const wire = wires.creator;
	if (wire === undefined) throw new TypeError("creator wire is unavailable");
	let restoreSend: (() => void) | undefined;
	try {
		for (let offset = 0; offset < 2; offset++) {
			await room.creator.seal(PLAYED + offset);
			const held = await holdPublication("creator");
			const plane = capturedReplayPlane.current;
			const release = held.wire.hold.release;
			if (plane === undefined || release === undefined) throw new TypeError("held predecessor is unavailable");
			old.push({ release, publication: held.publication, plane });
			await room.creator.adopt();
			const exported = await room.creator.exportOffer();
			await room.recipient.install(exported.offer);
			await room.creator.issue(PLAYED + offset + 1, 0);
			const rows = await room.creator.published(room.delivered[0] ?? null);
			if (rows.length > 0) {
				await room.recipient.receive(rows);
				room.delivered[0] = rows.at(-1)?.authorSequence ?? null;
			}
		}
		expect(await publish("creator")).toEqual({ ok: true });
		const current = capturedReplayPlane.current;
		if (current === undefined) throw new TypeError("current creator is unavailable");
		const send = wire.networkNode.sendMessage as (...args: unknown[]) => Promise<void>;
		Reflect.set(wire.networkNode, "sendMessage", (...args: unknown[]) => {
			if ((args[1] as { type?: unknown }).type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE)
				return Reflect.apply(send, wire.networkNode, args);
			return new Promise<void>((resolve) => {
				releaseCurrent.push(resolve);
			});
		});
		restoreSend = () => {
			Reflect.set(wire.networkNode, "sendMessage", send);
		};
		wire.peers = Array.from({ length: 31 }, (_, index) => `bounded-peer-${index}`);
		for (const peer of wire.peers.slice(0, 30)) currentPublications.push(republishV3RetainedTo(current, peer));
		const extra = republishV3RetainedTo(current, wire.peers[30] ?? "missing");
		currentPublications.push(extra);
		const refused = await Promise.race([
			extra,
			new Promise((resolve) => setTimeout(() => resolve("still-pending"), 2_000)),
		]);
		expect(refused).toMatchObject({ ok: false, kind: "admission-rejected" });
		for (let attempt = 0; attempt < 200 && releaseCurrent.length !== 30; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(releaseCurrent).toHaveLength(30);
		for (const prior of old)
			expect(readV3RuntimeOwnerCensus(prior.plane)).toMatchObject({
				retainedReplayPrefixRows: 0,
				retainedReplayNativeSends: 1,
				admittedEgressControlJobs: 1,
			});
		expect(readV3RuntimeOwnerCensus(current)).toMatchObject({
			admittedEgressControlJobs: 30,
			sharedEgressControlJobs: 32,
		});
		const currentBytes = readV3RuntimeOwnerCensus(current)?.retainedReplayBufferedBytes ?? 0;
		const priorBytes = old.reduce(
			(total, prior) => total + (readV3RuntimeOwnerCensus(prior.plane)?.retainedReplayBufferedBytes ?? 0),
			0
		);
		expect(priorBytes).toBeGreaterThan(0);
		expect(readV3RuntimeOwnerCensus(current)?.sharedRetainedReplayBufferedBytes).toBe(currentBytes + priorBytes);
	} finally {
		restoreSend?.();
		for (const prior of old) prior.release();
		for (const release of releaseCurrent) release();
		await Promise.all([...old.map((prior) => prior.publication), ...currentPublications]);
		wire.peers = [];
	}
	expect(await publish("creator")).toEqual({ ok: true });
	if (capturedReplayPlane.current === undefined) throw new TypeError("creator plane is unavailable");
	expect(readV3RuntimeOwnerCensus(capturedReplayPlane.current)).toMatchObject({
		sharedEgressControlJobs: 0,
		sharedRetainedReplayBufferedBytes: 0,
	});
}, 480_000);

it("current room close joins physical retained sends from a retired predecessor", async () => {
	const room = await openPlayed();
	await room.creator.seal(PLAYED);
	const { wire, publication } = await holdPublication("creator");
	const predecessor = capturedReplayPlane.current;
	if (predecessor === undefined) throw new TypeError("creator predecessor is unavailable");
	const release = wire.hold.release;
	if (release === undefined) throw new TypeError("held native send is unavailable");
	let closed = false;
	let close: ReturnType<typeof room.close> | undefined;
	try {
		await room.creator.adopt();
		close = room.close().then((errors) => {
			closed = true;
			return errors;
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(closed, "current room close must join the predecessor's actual native send").toBe(false);
		expect(readV3RuntimeOwnerCensus(predecessor)).toMatchObject({
			active: 0,
			retainedReplayPrefixRows: 0,
			retainedReplayNativeSends: 1,
			sharedEgressControlJobs: 1,
		});
	} finally {
		release();
		await publication;
		if (close !== undefined) expect(await close).toEqual([]);
	}
	expect(closed).toBe(true);
	expect(readV3RuntimeOwnerCensus(predecessor)).toMatchObject({
		sharedEgressControlJobs: 0,
		sharedRetainedReplayBufferedBytes: 0,
	});
}, 480_000);

it("retained publication recovers through the original close retry after native acquisition fails", async () => {
	const room = await openPlayed();
	const fault = vi
		.spyOn(NativeReadReservationOwner.prototype, "acquire")
		.mockRejectedValueOnce(new TypeError("injected transient native close acquisition failure"));
	try {
		await expect(room.creator.seal(PLAYED)).rejects.toThrow();
	} finally {
		fault.mockRestore();
	}
	expect(await publish("creator")).toMatchObject({ ok: false });
	await room.creator.seal(PLAYED);
	expect(await publish("creator")).toEqual({ ok: true });
	await room.creator.adopt();
}, 480_000);

it("retirement wakes replay waiting outside the FIFO and a late close completion cannot revive it", async () => {
	const room = await openPlayed();
	const wire = wires.creator;
	if (wire === undefined) throw new TypeError("creator transport is unavailable");
	await publish("creator");
	const predecessor = capturedReplayPlane.current;
	if (predecessor === undefined) throw new TypeError("creator plane is unavailable");
	let entered!: () => void, release!: () => void;
	const held = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const acquire = NativeReadReservationOwner.prototype.acquire;
	const fault = vi.spyOn(NativeReadReservationOwner.prototype, "acquire").mockImplementationOnce(async function (
		...args
	) {
		const reservation = await Reflect.apply(acquire, this, args);
		entered();
		await released;
		return reservation;
	});
	const close = room.creator.seal(PLAYED).then(
		() => true,
		() => false
	);
	try {
		await Promise.race([
			held,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("native close acquisition was not reached")), 5_000)
			),
		]);
		const publication = publish("creator");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(readV3RuntimeOwnerCensus(predecessor)?.retainedReplayReadJobs).toBe(1);
		predecessor.deactivate();
		const settled = await Promise.race([
			publication.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
		]);
		expect(settled).toBe(true);
		release();
		await close;
		expect(readV3RuntimeOwnerCensus(predecessor)).toMatchObject({
			active: 0,
			retainedReplayPrefixRows: 0,
			retainedReplayReadJobs: 0,
			admittedEgressControlJobs: 0,
			retainedReplayReadRetired: 1,
		});
	} finally {
		release();
		fault.mockRestore();
		await close;
	}
}, 480_000);

it("sealed replay children preserve native journal exclusion and join parent revocation", async () => {
	const room = await openPlayed();
	await room.creator.seal(PLAYED);
	const sources = [...capturedSources].filter((source) => source.currentTrust.currentEpoch === PLAYED);
	let selected:
		| {
				source: RollbackData.CreatorForwardPromotionSourceMaterial;
				child: Awaited<
					ReturnType<RollbackData.CreatorForwardPromotionSourceMaterial["borrowJournalHeaderReservation"]>
				>;
		  }
		| undefined;
	for (const source of sources.reverse()) {
		try {
			selected = { source, child: await source.borrowJournalHeaderReservation() };
			break;
		} catch {
			/* Closed aliases cannot borrow; select the actual still-held source. */
		}
	}
	expect(selected, "the sealed close retained an original native source").toBeDefined();
	if (selected === undefined) throw new TypeError("sealed close source is unavailable");
	const { source, child } = selected;
	const sibling = await source.borrowJournalHeaderReservation();
	const databases = await indexedDB.databases();
	expect(databases.some((database) => database.name === "creator")).toBe(true);
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("creator");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	let writeRan = false,
		releaseSettled = false;
	const foreignWrite = new Promise<void>((resolve, reject) => {
		const transaction = database.transaction([...database.objectStoreNames], "readwrite");
		const storeName = database.objectStoreNames[0];
		if (storeName === undefined) throw new TypeError("creator room database is empty");
		const request = transaction.objectStore(storeName).count();
		request.onsuccess = () => {
			writeRan = true;
		};
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error);
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(writeRan).toBe(false);
		await child.release();
		await expect(child.check()).rejects.toThrow();
		await sibling.check();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(writeRan, "releasing a replay child preserves the parent's original transaction").toBe(false);
		const released = source.release().then(() => {
			releaseSettled = true;
		});
		await expect(sibling.check()).rejects.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(releaseSettled, "parent release joins the still-owned child").toBe(false);
		await sibling.release();
		await released;
		expect(await room.close()).toEqual([]);
		rooms.delete(room);
		await foreignWrite;
		expect(writeRan).toBe(true);
	} finally {
		await Promise.allSettled([child.release(), sibling.release()]);
		database.close();
	}
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
