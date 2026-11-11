import { describe, expect, it } from "vitest";

import { createEphemeralChannel, type EphemeralChannel, type EphemeralIngress, type EphemeralStats } from "../src/index.js";

// Authority-bound (v3-room) channels across epoch rollovers, with every count deterministic.
//
// A creator adopts epoch e+1 before any member installs it, and members install one after another,
// so for a while peers that are writers on both sides of the rollover sit on adjacent epochs. Frames
// between such peers must keep flowing (the rollover must not black out the stream), while:
//   - a sender the receiver's installed successor removed is refused as soon as the receiver installs it;
//   - a frame is accepted only under a context the receiver itself installed (current or the one just left);
//   - nothing is accepted two epochs away, and a sender's frames from a context it has already left
//     are refused once the receiver has seen it in a later one.

const OBJECT = "rollover-room";
const OPTIONS = { maxMessageBytes: 512, maxSequencedKeys: 4, maxSequencedSenders: 8 } as const;

interface Authority {
	readonly aclDigest: string;
	readonly anchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}

function digest(epoch: number, salt: number): string {
	return ((epoch * 16 + salt) % 256).toString(16).padStart(2, "0").repeat(32);
}

function authorityAt(epoch: number, branch = 0): Authority {
	return Object.freeze({
		aclDigest: digest(epoch, 3 + branch * 7),
		anchorDigest: digest(epoch, 5 + branch * 7),
		epoch,
		objectId: OBJECT,
	});
}

/** Writers of each epoch: X is removed by epoch 1; everyone else stays. */
function writersAt(epoch: number): ReadonlySet<string> {
	return new Set(epoch === 0 ? ["author-c", "author-a", "author-b", "author-x"] : ["author-c", "author-a", "author-b"]);
}

interface Wire {
	readonly bytes: Uint8Array;
	readonly sender: string;
	readonly senderEpoch: number | undefined;
	readonly to: string;
}

class Room {
	readonly peers = new Map<string, Peer>();
	readonly roster = new Map<string, string>();
	readonly wire: Wire[] = [];
	/** Delivered payloads by receiver, then sender. */
	readonly delivered = new Map<string, Map<string, string[]>>();

	add(peerId: string, author: string, epoch: number): Peer {
		this.roster.set(peerId, author);
		const peer = new Peer(this, peerId, epoch);
		this.peers.set(peerId, peer);
		return peer;
	}

	deliveredFrom(receiver: string, sender: string): readonly string[] {
		return this.delivered.get(receiver)?.get(sender) ?? [];
	}

	inject(receiver: string, wire: Wire): void {
		this.peers.get(receiver)?.listener?.({ bytes: wire.bytes.slice(), sender: wire.sender });
	}
}

class Peer {
	authority: Authority | undefined;
	listener: ((ingress: EphemeralIngress) => void) | undefined;
	readonly channel: EphemeralChannel;
	sent = 0;

	constructor(
		readonly room: Room,
		readonly peerId: string,
		epoch: number
	) {
		this.authority = authorityAt(epoch);
		const writer = (author: string | undefined): boolean =>
			author !== undefined && this.authority !== undefined && writersAt(this.authority.epoch).has(author);
		const authorized = (): string[] =>
			[...room.roster.keys()].filter((peerId) => peerId !== this.peerId && writer(room.roster.get(peerId))).sort();
		this.channel = createEphemeralChannel(
			{
				authorForPeer: (peerId: string): string | undefined => room.roster.get(peerId),
				authorizedPeers: authorized,
				currentAuthority: (): Authority | undefined => this.authority,
				isAuthorized: (sender: string): boolean => writer(room.roster.get(sender)),
				isCurrentWriter: (author: string): boolean => writer(author),
				localPeerId: peerId,
				maxEnvelopeBytes: (): number => 1_024,
				onMessage: (listener: (ingress: EphemeralIngress) => void): (() => void) => {
					this.listener = listener;
					return (): void => {
						this.listener = undefined;
					};
				},
				onPeerDisconnect: (): (() => void) => (): void => undefined,
				send: (input: { bytes: Uint8Array; recipients: "all" | readonly string[] }): Promise<boolean> => {
					const recipients = input.recipients === "all" ? authorized() : input.recipients;
					for (const to of recipients) {
						const wire = { bytes: input.bytes.slice(), sender: this.peerId, senderEpoch: this.authority?.epoch, to };
						room.wire.push(wire);
						room.inject(to, wire);
					}
					return Promise.resolve(recipients.length > 0);
				},
			} as Parameters<typeof createEphemeralChannel>[0],
			OPTIONS
		);
		this.channel.subscribe(({ payload, sender }) => {
			let bySender = room.delivered.get(this.peerId);
			if (bySender === undefined) room.delivered.set(this.peerId, (bySender = new Map()));
			const list = bySender.get(sender) ?? [];
			list.push(new TextDecoder().decode(payload));
			bySender.set(sender, list);
		});
	}

	install(epoch: number): void {
		this.authority = authorityAt(epoch);
	}

	async move(label: string): Promise<void> {
		this.sent += 1;
		await this.channel.publish({
			class: "unreliable-sequenced",
			key: "movement",
			payload: new TextEncoder().encode(`${this.peerId}:${label}`),
		});
	}

	stats(): EphemeralStats {
		return this.channel.stats();
	}
}

const CONTINUING = ["peer-c", "peer-a", "peer-b"] as const;

function setup(): { room: Room; c: Peer; a: Peer; b: Peer; x: Peer } {
	const room = new Room();
	const c = room.add("peer-c", "author-c", 0);
	const a = room.add("peer-a", "author-a", 0);
	const b = room.add("peer-b", "author-b", 0);
	const x = room.add("peer-x", "author-x", 0);
	return { room, c, a, b, x };
}

describe("authority-bound ephemeral stream across epoch rollovers", () => {
	it("keeps frames flowing between peers that stay writers through K rollovers while members lag the creator", async () => {
		const ROLLOVERS = 6;
		const { room, c, a, b } = setup();
		room.peers.delete("peer-x"); // removal is covered separately; here every peer stays a writer
		room.roster.delete("peer-x");
		const round = async (label: string): Promise<void> => {
			for (const peer of [c, a, b]) await peer.move(label);
		};
		let rounds = 0;
		await round("e0");
		rounds++;
		for (let epoch = 1; epoch <= ROLLOVERS; epoch++) {
			// The creator adopts first; members install one after another (three peers on two epochs).
			c.install(epoch);
			await round(`e${epoch}-creator`);
			a.install(epoch);
			await round(`e${epoch}-a`);
			b.install(epoch);
			await round(`e${epoch}-b`);
			rounds += 3;
		}
		const mismatches = [c, a, b].reduce((total, peer) => total + peer.stats().authorityMismatch, 0);
		const missing: string[] = [];
		for (const receiver of CONTINUING)
			for (const sender of CONTINUING) {
				if (receiver === sender) continue;
				const got = room.deliveredFrom(receiver, sender).length;
				if (got !== rounds) missing.push(`${sender}->${receiver}: ${got}/${rounds}`);
			}
		expect({ mismatches, missing }).toEqual({ mismatches: 0, missing: [] });
		for (const peer of [c, a, b])
			expect(peer.stats()).toMatchObject({ malformed: 0, stale: 0, unauthorized: 0, rateLimited: 0, overLimit: 0 });
	});

	it("keeps the stream in the other direction too: a member installing before the creator's frames reach it", async () => {
		const { room, c, a } = setup();
		room.peers.delete("peer-x");
		room.roster.delete("peer-x");
		room.peers.delete("peer-b");
		room.roster.delete("peer-b");
		// Member ahead of the creator (it installed from a peer while the creator's channel has not yet
		// observed its own adoption) and creator ahead of the member: both orders, three rollovers.
		for (let epoch = 1; epoch <= 3; epoch++) {
			const [first, second] = epoch % 2 === 1 ? [a, c] : [c, a];
			first.install(epoch);
			await first.move(`e${epoch}-ahead`);
			await second.move(`e${epoch}-behind`);
			second.install(epoch);
			await first.move(`e${epoch}-both`);
			await second.move(`e${epoch}-both`);
		}
		expect(room.deliveredFrom("peer-c", "peer-a")).toHaveLength(6);
		expect(room.deliveredFrom("peer-a", "peer-c")).toHaveLength(6);
		expect(c.stats().authorityMismatch + a.stats().authorityMismatch).toBe(0);
	});

	it("refuses a sender removed by the successor as soon as the receiver installs it, and never widens to two epochs", async () => {
		const { room, c, a, b, x } = setup();
		await a.move("a-e0");
		await x.move("e0");
		for (const receiver of CONTINUING) expect(room.deliveredFrom(receiver, "peer-x")).toEqual(["peer-x:e0"]);
		// Epoch 1 removes X. X cannot install it and keeps sending under epoch 0.
		c.install(1);
		await x.move("after-creator");
		// The creator installed the removal: refused there. Members still on epoch 0 have not verified the
		// removal yet; they keep their existing epoch-0 decision (X is a writer there).
		expect(room.deliveredFrom("peer-c", "peer-x")).toEqual(["peer-x:e0"]);
		expect(room.deliveredFrom("peer-a", "peer-x")).toEqual(["peer-x:e0", "peer-x:after-creator"]);
		const cUnauthorized = c.stats().unauthorized;
		expect(cUnauthorized).toBeGreaterThan(0);
		a.install(1);
		b.install(1);
		const before = room.wire.length;
		await x.move("after-all");
		// X still addresses everyone it believes is a writer under epoch 0; nobody delivers it any more.
		expect(room.wire.length - before).toBe(3);
		for (const receiver of CONTINUING) expect(room.deliveredFrom(receiver, "peer-x").includes("peer-x:after-all")).toBe(false);
		// Replaying X's genuine epoch-0 frames into receivers that installed epoch 1 is refused too.
		for (const wire of room.wire.filter((entry) => entry.sender === "peer-x")) room.inject("peer-c", wire);
		expect(room.deliveredFrom("peer-c", "peer-x")).toEqual(["peer-x:e0"]);
		// Window bound: A's frame sent under epoch 0, injected into C on epoch 2, is refused (two epochs).
		await a.move("a-e1");
		const aEpoch0 = room.wire.find((entry) => entry.sender === "peer-a" && entry.senderEpoch === 0 && entry.to === "peer-c");
		expect(aEpoch0).toBeDefined();
		c.install(2);
		const cMismatch = c.stats().authorityMismatch;
		const cFromA = room.deliveredFrom("peer-c", "peer-a").length;
		room.inject("peer-c", aEpoch0 as Wire);
		expect(room.deliveredFrom("peer-c", "peer-a")).toHaveLength(cFromA);
		expect(c.stats().authorityMismatch).toBe(cMismatch + 1);
	});

	it("refuses a sender's frame from a context it has already left once the receiver has seen it in a later one", async () => {
		const { room, c, a } = setup();
		await a.move("e0-first");
		c.install(1);
		await a.move("e0-second"); // A still on epoch 0: accepted by C (the epoch C just left)
		const late = room.wire.filter((entry) => entry.sender === "peer-a" && entry.to === "peer-c").at(-1) as Wire;
		expect(room.deliveredFrom("peer-c", "peer-a")).toEqual(["peer-a:e0-first", "peer-a:e0-second"]);
		a.install(1);
		await a.move("e1");
		expect(room.deliveredFrom("peer-c", "peer-a")).toEqual(["peer-a:e0-first", "peer-a:e0-second", "peer-a:e1"]);
		const mismatch = c.stats().authorityMismatch;
		room.inject("peer-c", late);
		expect(room.deliveredFrom("peer-c", "peer-a")).toHaveLength(3);
		expect(c.stats().authorityMismatch).toBe(mismatch + 1);
	});

	it("never accepts a frame whose contexts the receiver did not install (foreign tuple at an adjacent epoch)", async () => {
		const { room, c } = setup();
		// A forger on a foreign epoch-1 tuple (same epoch number, different anchor/ACL) that had a
		// foreign epoch-0 predecessor: neither tag is a context C or A installed.
		const forger = room.add("peer-f", "author-a", 0);
		forger.authority = authorityAt(0, 1);
		await forger.move("foreign-e0");
		forger.authority = authorityAt(1, 1);
		await forger.move("foreign-e1");
		expect(room.deliveredFrom("peer-c", "peer-f")).toEqual([]);
		c.install(1);
		await forger.move("foreign-e1-again");
		expect(room.deliveredFrom("peer-c", "peer-f")).toEqual([]);
		expect(room.deliveredFrom("peer-a", "peer-f")).toEqual([]);
	});
});
