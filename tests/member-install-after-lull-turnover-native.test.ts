/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native fixture inference. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { afterEach, expect, it } from "vitest";

import {
	type ChatSharesPeer,
	chatSharesRoomFixture,
	closeChatSharesRooms,
} from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// RED first: a member whose own recovery-pool lull already ran the received turnover at its
// current epoch does not run it again inside its next successor install.
//
// Observed in the app-mode Node fixture (epoch4-install trace): from the member's epoch 3 on,
// every install runs the full received turnover (318-398 ms of the ~700 ms install, on the
// member's critical path behind the creator's offer) although the member's lull at the same
// epoch already ran it. The install's predicate stays due because the current Cut still
// classifies scopes the member retains, and reconciling does not change that; the second run
// only rewrites retirement controls (no scope, generation or journal row changes).
//
// The skip is bound to the lull's exact boundary (the same live plane, epoch and recovery
// inventory), so a later install still runs its turnover when no lull ran at its epoch (an
// intervening adoption), after a failed install's recovery (the retirement-halt discharge path
// of creator-recipient-failed-install-after-lull-native), and after the member closed and
// reopened. The count is the install's own `recipient-received-turnover` observation (load
// independent): one per successful install, `ran` when it ran the passes.
//
// Genuine SQLite, Ed25519, room owners, floor and creator material server.

type TurnoverEvent = { kind: "recipient-received-turnover"; epoch: number; outcome: string };
const events: TurnoverEvent[] = [];
const previousObserver = Reflect.get(globalThis, "__warmProofEvent") as unknown;

afterEach(async () => {
	Reflect.set(globalThis, "__warmProofEvent", previousObserver);
	expect(await closeChatSharesRooms(), "native owners join").toEqual([]);
});

/**
 * The same port, whose chunk (non-material) frames have one byte flipped.
 * @param port - The fixture's honest delivery port.
 * @returns The damaging port.
 */
function damagedChunks(port: SnapshotChunkProtocolPort): SnapshotChunkProtocolPort {
	return {
		...port,
		localPeerId: port.localPeerId,
		connectedPeers: () => port.connectedPeers(),
		close: () => port.close(),
		serve: (handler) => port.serve(handler),
		open: async (peer) => {
			const stream = await port.open(peer);
			let material = false;
			const wrapped: SnapshotChunkProtocolStream = {
				peerId: stream.peerId,
				abort: (reason) => stream.abort(reason),
				close: () => stream.close(),
				write: (bytes, options) => {
					try {
						const request = decodeCanonical(bytes) as Record<string, unknown>;
						if (request.kind === "creator-successor-material-request") material = true;
					} catch {
						// Not a canonical control frame.
					}
					return stream.write(bytes, options);
				},
				read: async (maximum, options) => {
					const frame = await stream.read(maximum, options);
					if (material || frame.byteLength < 256) return frame;
					const damaged = Uint8Array.from(frame);
					damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 0xff;
					return damaged;
				},
			};
			return wrapped;
		},
	};
}

it("a member's install does not repeat the received turnover its own lull ran at the same epoch", async () => {
	Reflect.set(globalThis, "__warmProofEvent", (event: unknown) => {
		if (typeof event === "object" && event !== null && Reflect.get(event, "kind") === "recipient-received-turnover")
			events.push(event as TurnoverEvent);
	});
	const f = await chatSharesRoomFixture({
		members: ["late"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const creator = await f.open(0);
	let member: ChatSharesPeer = await f.open(1, { receiveOnly: true });
	const epochOf = () => member.room.authority()?.epoch ?? 0;
	const advance = async () => {
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
	};
	/** One successful install; its turnover observations (the member's own epoch before it). */
	const install = async (): Promise<string[]> => {
		const from = events.length,
			at = epochOf();
		await f.install(member);
		expect(epochOf(), "the member follows").toBe(creator.room.authority()?.epoch);
		return events
			.slice(from)
			.filter((event) => event.epoch === at)
			.map((event) => event.outcome);
	};
	const lull = async () => (await member.room.maintainRecoveryPool()).kind;

	// Follow until the install's turnover is due on its own (the pool's classified Cut).
	let due = false;
	for (let step = 0; step < 8 && !due; step++) {
		await advance();
		due = (await install()).includes("ran");
	}
	expect(due, "the install's received turnover became due").toBe(true);

	// Target: the member's lull ran the turnover at its epoch; the next install must not repeat it.
	const afterLull: { epoch: number; lull: string; install: string[] }[] = [];
	for (let step = 0; step < 2; step++) {
		const epoch = epochOf(),
			kind = await lull();
		await advance();
		afterLull.push({ epoch, lull: kind, install: await install() });
	}

	// Control: an intervening adoption. No lull ran at this epoch, so the install turns over.
	await advance();
	const noLull = await install();

	// Control: the retirement-halt path. A lull, then a failed install; the retry's recovery
	// reopens the plane (the lull's completed retirement halts it) and the install turns over.
	const haltLull = await lull();
	await advance();
	const transfer = await f.successorDelivery(member.index);
	Reflect.set(member.networkNode, "createSnapshotChunkProtocolHost", () => damagedChunks(transfer.port));
	const failure = await member.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers }).then(
		() => undefined,
		(error: unknown) => error
	);
	expect(failure, "the damaged install is refused").toBeInstanceOf(Error);
	const retried = await install();

	// Control: close and reopen. A lull, then the member closes and reopens; its install turns over.
	const closeLull = await lull();
	await f.stop(member);
	member = await f.open(1, { reopen: true, receiveOnly: true });
	await advance();
	const reopened = await install();

	expect(member.stateBytes(), "the member converges").toEqual(creator.stateBytes());
	console.log(
		"MEMBER_TURNOVER_AFTER_LULL",
		JSON.stringify({ afterLull, noLull, haltLull, retried, closeLull, reopened })
	);
	expect(
		afterLull.map((row) => row.lull),
		"each lull ran the received turnover"
	).toEqual(["maintained", "maintained"]);
	expect(noLull, "an install at an epoch with no lull still turns over").toEqual(["ran"]);
	expect(haltLull).toBe("maintained");
	expect(retried, "the retry after a failed install still turns over").toEqual(["ran"]);
	expect(closeLull).toBe("maintained");
	expect(reopened, "an install after a close and reopen still turns over").toEqual(["ran"]);
	expect(
		afterLull.map((row) => row.install.filter((outcome) => outcome === "ran").length),
		"received turnovers in an install whose epoch the member's lull already reconciled"
	).toEqual([0, 0]);
}, 600_000);
