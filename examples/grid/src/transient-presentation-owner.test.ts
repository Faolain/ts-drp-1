import { encodeCanonical } from "@ts-drp/canonical";
import { createEphemeralChannel, encodeEntityDeltaBatch, encodeEphemeralFrame, type EphemeralChannel, type EphemeralIngress } from "@ts-drp/ephemeral";
import { Keychain } from "../../../packages/keychain/dist/src/index.js";
import type { DRPNode } from "@ts-drp/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createV3ZoneApi, type V3ZoneApi, type ZoneSnapshot, type ZoneTransientSnapshot } from "./v3-zone";
import type { createV3RoomSession, V3RoomHeadAuthority } from "@ts-drp/example-v3-room";

type RoomInput = Parameters<typeof createV3RoomSession>[0];
const probe = vi.hoisted(() => ({ history: new Set<unknown>(), historyEncodes: 0,
	create: undefined as undefined | ((input: RoomInput) => unknown) }));
vi.mock("@ts-drp/canonical", async original => {
	const actual = await original<typeof import("@ts-drp/canonical")>();
	return { ...actual, encodeCanonical: (...args: Parameters<typeof actual.encodeCanonical>) => {
		if (probe.history.has(args[0])) probe.historyEncodes++;
		return actual.encodeCanonical(...args);
	} };
});
vi.mock("@ts-drp/example-v3-room", async original => ({
	...(await original<Record<string, unknown>>()),
	createV3RoomSession: (input: RoomInput) => Promise.resolve(probe.create!(input)),
}));

const identities: Keychain[] = [], zones: V3ZoneApi[] = [];
afterEach(async () => {
	await Promise.all(zones.splice(0).map(zone => zone.close()));
	await Promise.all(identities.splice(0).map(identity => identity.stop()));
	probe.history.clear(); probe.historyEncodes = 0; probe.create = undefined;
});
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
function authority(): V3RoomHeadAuthority {
	const unavailable = () => Promise.resolve({ ok: false as const, reason: "unavailable" as const });
	return { initialization: { kind: "create" }, begin: unavailable, commit: unavailable, create: unavailable,
		migrate: unavailable, read: unavailable };
}
async function fixture(transient = true) {
	const keychain = new Keychain({ private_key_seed: "grid-transient-presentation-owner" });
	await keychain.start(); identities.push(keychain);
	const other = new Keychain({ private_key_seed: "grid-transient-presentation-recipient" });
	await other.start(); identities.push(other);
	const full: ZoneSnapshot[] = [], positions: ZoneTransientSnapshot[] = [], rooms: {
		input: RoomInput; channel: EphemeralChannel; receive(ingress: EphemeralIngress): void;
		preview: ReturnType<typeof vi.fn>; issue: ReturnType<typeof vi.fn>; state: { authorized: boolean; epoch: number };
	}[] = [];
	probe.create = input => {
		let receive!: (ingress: EphemeralIngress) => void;
		const state = { authorized: true, epoch: 0 }, preview = vi.fn(() => ({ current: { epoch: state.epoch } })), issue = vi.fn(async () => undefined);
		const channel = createEphemeralChannel({ localPeerId: "creator", authorizedPeers: () => ["recipient"],
			isAuthorized: () => state.authorized, maxEnvelopeBytes: () => 65_536,
			onMessage: listener => { receive = listener; return () => undefined; }, send: async () => true },
			{ maxMessageBytes: 65_536, maxSequencedKeys: 9, maxSequencedSenders: 2 });
		rooms.push({ input, channel, receive: ingress => receive(ingress), preview, issue, state });
		return { objectId: input.objectId, roomId: "a".repeat(64), invite: typeof input.creatorInvite === "string" ? input.creatorInvite
			: hex(encodeCanonical({ ...input.creatorInvite, kind: "ts-drp-example-v3-room-creator-invite", version: 1 })),
			close: async () => undefined, previewLatchedAcl: preview, openEphemeral: () => channel, issue };
	};
	const node = { keychain, networkNode: { peerId: "creator" }, ephemeralUnreliableWebRtcSnapshot: vi.fn(() => undefined) } as unknown as DRPNode;
	const zone = createV3ZoneApi(node, snapshot => full.push(snapshot), authority, undefined,
		transient ? snapshot => positions.push(snapshot) : undefined);
	zones.push(zone);
	// Use the application's own enrollment encoder, avoiding fixture wire guesses.
	const recipient = createV3ZoneApi({ keychain: other, networkNode: { peerId: "recipient" },
		ephemeralUnreliableWebRtcSnapshot: () => undefined } as unknown as DRPNode, () => undefined, authority);
	zones.push(recipient);
	await zone.create(recipient.snapshot().enrollment);
	const project = (acceptedDigests: readonly string[], blocks: ZoneSnapshot["blocks"] = Object.freeze([])) => {
		probe.history.add(acceptedDigests);
		rooms.at(-1)!.input.onProjection!(Object.freeze({ acceptedDigests, blocks, outcomes: Object.freeze([]),
			creatorAuthor: keychain.localAuthorId, creatorPeerId: "creator", roster: Object.freeze([]),
			transportPeerAuthors: Object.freeze([]), writerAuthors: Object.freeze([]) }) as never);
	};
	const deliver = (sequence: number, x: number, payload?: Uint8Array, selected = rooms.at(-1)!) => selected.receive({ sender: "recipient",
		bytes: encodeEphemeralFrame({ class: "unreliable-sequenced", key: "recipient", sequence,
			payload: payload ?? encodeEntityDeltaBatch([{ entityId: 0, sequence, x, y: 2 }]) }) });
	return { zone, full, positions, rooms, project, deliver };
}

describe("Grid transient presentation owner", () => {
	it("moves and receives without durable history encoding, ACL preview or full projection notification", async () => {
		const f = await fixture(), history = Object.freeze(["c".repeat(64)]);
		f.project(history);
		const before = probe.historyEncodes, room = f.rooms[0]!;
		room.preview.mockClear(); f.full.length = 0;
		for (let i = 0; i < 5; i++) { f.zone.move(1, 0); f.deliver(i + 1, i); }
		expect(f.positions).toHaveLength(10); expect(f.full).toHaveLength(0);
		expect(room.preview).not.toHaveBeenCalled(); expect(room.issue).not.toHaveBeenCalled();
		expect(probe.historyEncodes).toBe(before);
		expect(f.positions.at(-1)!.transientPositions.creator).toEqual({ x: 5, y: 0 });
		expect(f.positions.at(-1)!.transientPositions.recipient).toEqual({ x: 4, y: 2 });
		expect(() => { (f.positions[0]!.transientPositions.creator as { x: number }).x = 999; }).toThrow();
		expect(f.zone.snapshot().transientPositions.creator).toEqual({ x: 5, y: 0 });
	});

	it("updates durable facts only on projection installation while explicit snapshots keep current context fresh", async () => {
		const f = await fixture(), first = Object.freeze(["c".repeat(64)]), second = Object.freeze(["c".repeat(64), "d".repeat(64)]);
		f.project(first); const a = f.zone.snapshot(); expect(probe.historyEncodes).toBe(1);
		f.rooms[0]!.state.epoch = 4;
		const b = f.zone.snapshot(); expect(b.outcomeContext!.epoch).toBe(4); expect(b.acceptedOperationDigest).toBe(a.acceptedOperationDigest);
		f.project(second); const c = f.zone.snapshot();
		expect(c.acceptedOperationDigest).not.toBe(a.acceptedOperationDigest); expect(c.durableVertexCount).toBe(2);
		expect(probe.historyEncodes).toBe(2);
	});

	it("preserves sequenced stale/refusal behavior and prevents closed-channel callbacks repainting same-room reopen", async () => {
		const f = await fixture(); f.deliver(3, 30); const count = f.positions.length;
		f.deliver(2, 20); f.deliver(3, 31); f.deliver(4, 40, Uint8Array.of(255));
		expect(f.positions).toHaveLength(count); expect(f.rooms[0]!.channel.stats().stale).toBe(2);
		f.rooms[0]!.state.authorized = false; f.deliver(5, 50);
		expect(f.positions).toHaveLength(count); expect(f.rooms[0]!.channel.stats().unauthorized).toBe(1);
		const invite = f.zone.snapshot().invite, old = f.rooms[0]!;
		await f.zone.close(); await f.zone.join(invite); const reopened = f.zone.snapshot();
		old.state.authorized = true; f.deliver(100, 100, undefined, old);
		expect(f.zone.snapshot().transientPositions).toEqual({}); expect(reopened.zoneId).toBe(f.positions[0]!.zoneId);
		f.deliver(1, 1); expect(f.zone.snapshot().transientPositions.recipient).toEqual({ x: 1, y: 2 });
	});

	it("preserves full projection notifications for consumers without a transient observer", async () => {
		const f = await fixture(false), before = f.full.length;
		f.zone.move(1, 0); f.deliver(1, 4);
		expect(f.full).toHaveLength(before + 2); expect(f.positions).toHaveLength(0);
		expect(() => f.zone.move(0.5, 0)).toThrow("integer range");
	});
});
