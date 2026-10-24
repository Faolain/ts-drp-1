// Exploratory census/diagnostic probes only (not a gate). Opt-in via EXPLORE_* env.
import { afterEach, expect, it } from "vitest";
import { inspect } from "node:util";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, hex } from "./fixtures/chat-membership-shares/room.js";
import { floorCensus, nativeCensus } from "./fixtures/rollback-promotion/census.js";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));
const message = (id: string) => ({ action: "message", clientOperationId: id, displayTimeMs: 1_791_662_400_000, text: id });

// Diagnostic probes for the rollback gate; every probe is opt-in by environment.
const cases = (process.env.EXPLORE_CASES ?? "6:5").split(",").map(row => row.split(":").map(Number) as [number, number]);
(process.env.EXPLORE_CASES === undefined ? it.skip : it).each(cases)("explores the creator's own rollback chain at %i selecting %i", async (target, selected) => {
	const f = await chatSharesRoomFixture({ members: ["genesis"], format: "window", genesisStateBytes: createShippingChatWindowGenesisStateBytes });
	let creator = await f.open(0);
	const closed = new Map<number, string>();
	for (let epoch = 0; epoch < target; epoch++) {
		await creator.room.issue(message(`creator-epoch-${epoch}`));
		closed.set(epoch, hex(creator.stateBytes()));
		expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();
	}
	const log = (label: string, value: unknown) => console.log(`CENSUS ${label} ${JSON.stringify(value)}`);
	log("live", { target, epoch: creator.room.authority()?.epoch, floor: await floorCensus(creator, f.objectId, f.invite.pinnedGenesisAnchorDigest), native: await nativeCensus(f.directory, f.objectId, "peer-0") });
	if (process.env.EXPLORE_LIVE !== "1") { await f.stop(creator); creator = await f.open(0, { reopen: true }); }
	log("reopened", { target, epoch: creator.room.authority()?.epoch, floor: await floorCensus(creator, f.objectId, f.invite.pinnedGenesisAnchorDigest),
		generations: (await nativeCensus(f.directory, f.objectId, "peer-0")).generations.length });
	try { await creator.room.promoteCreatorCheckpoint({ closedEpoch: selected }); log("promoted", { selected }); }
	catch (error) { log("promotion-error", { selected, error: String(error), detail: inspect(error, { depth: 10, breakLength: Infinity }) }); throw error; }
	log("after", { epoch: creator.room.authority()?.epoch, sameState: hex(creator.stateBytes()) === closed.get(selected),
		messages: creator.room.projection().messages.map(row => row.clientOperationId),
		floor: await floorCensus(creator, f.objectId, f.invite.pinnedGenesisAnchorDigest), native: await nativeCensus(f.directory, f.objectId, "peer-0") });
	try { await creator.room.issue(message("after-promotion")); }
	catch (error) { log("issue-error", { detail: inspect(error, { depth: 10, breakLength: Infinity }) }); throw error; }
	log("issued", { messages: creator.room.projection().messages.map(row => row.clientOperationId) });
}, 600_000);

it.runIf(process.env.EXPLORE_REOPEN_ISSUE === "1")("explores issue after epoch-2 promotion across a cold reopen", async () => {
	const log = (label: string, value: unknown) => console.log(`CENSUS ${label} ${JSON.stringify(value)}`);
	const f = await chatSharesRoomFixture({ members: ["genesis"], format: "window", genesisStateBytes: createShippingChatWindowGenesisStateBytes });
	let creator = await f.open(0);
	for (let epoch = 0; epoch < 2; epoch++) {
		await creator.room.issue(message(`creator-epoch-${epoch}`));
		expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();
	}
	await creator.room.promoteCreatorCheckpoint({ closedEpoch: 1 });
	await f.stop(creator); creator = await f.open(0, { reopen: true });
	log("reopened-after-promotion", { epoch: creator.room.authority()?.epoch, messages: creator.room.projection().messages.map(row => row.clientOperationId) });
	try { await creator.room.issue(message("after-promotion-reopen")); log("reopen-issue-ok", {}); }
	catch (error) { log("reopen-issue-error", { detail: inspect(error, { depth: 10, breakLength: Infinity }) }); }
	try { expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor(); log("seal-after-promotion-ok", { epoch: creator.room.authority()?.epoch }); }
	catch (error) { log("seal-after-promotion-error", { detail: inspect(error, { depth: 10, breakLength: Infinity }) }); }
	try { await creator.room.issue(message("after-promotion-seal")); log("post-seal-issue-ok", { messages: creator.room.projection().messages.map(row => row.clientOperationId) }); }
	catch (error) { log("post-seal-issue-error", { detail: inspect(error, { depth: 10, breakLength: Infinity }) }); }
}, 600_000);

it.runIf(process.env.EXPLORE_REPLICA === "1")("explores a second same-creator replica installing genuine exports", async () => {
	const log = (label: string, value: unknown) => console.log(`CENSUS ${label} ${JSON.stringify(value)}`);
	const f = await chatSharesRoomFixture({ members: ["genesis"], format: "window", genesisStateBytes: createShippingChatWindowGenesisStateBytes });
	const creator = await f.open(0);
	let replica: Awaited<ReturnType<typeof f.open>> | undefined;
	try { replica = await f.open(0, { name: "creator-replica" }); log("replica-open", { epoch: replica.room.authority()?.epoch, peer: replica.networkNode.peerId?.toString?.() }); }
	catch (error) { log("replica-open-error", { detail: inspect(error, { depth: 10, breakLength: Infinity }) }); return; }
	for (let epoch = 0; epoch < 2; epoch++) {
		await creator.room.issue(message(`creator-epoch-${epoch}`));
		expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();
	}
	try { await f.install(replica); log("replica-install-ok", { epoch: replica.room.authority()?.epoch }); }
	catch (error) { log("replica-install-error", { detail: inspect(error, { depth: 10, breakLength: Infinity }) }); }
}, 600_000);

it.runIf(process.env.EXPLORE_BUSY === "1")("explores which native reservation is busy during a floor-4 promotion", async () => {
	const { SqliteNativeReadReservationOwner } = await import("../packages/storage-node/src/internal/native-read-reservation.js");
	const prototype = SqliteNativeReadReservationOwner.prototype as unknown as { acquire(...args: unknown[]): Promise<{ release(): Promise<void> }> };
	const original = prototype.acquire;
	const holders = new Map<object, string>();
	const frames = (stack: string | undefined) => (stack ?? "").split("\n").filter(line => /creator-|v3-room|live-journal|room-head|issuance/u.test(line)).slice(0, 12).map(line => line.trim());
	prototype.acquire = async function (this: object, ...args: unknown[]) {
		const file = String(Reflect.get(this, "filename")).split("/").at(-1);
		try {
			const reservation = await Reflect.apply(original, this, args) as { release(): Promise<void> };
			holders.set(this, new Error().stack ?? "");
			const release = reservation.release.bind(reservation);
			Reflect.set(reservation, "release", () => { holders.delete(this); return release(); });
			return reservation;
		} catch (error) {
			if (String(error).includes("NATIVE_READ_RESERVATION_BUSY"))
				console.log(`BUSY ${JSON.stringify({ file, contender: frames(new Error().stack), holder: frames(holders.get(this)) })}`);
			throw error;
		}
	};
	try {
		const f = await chatSharesRoomFixture({ members: ["genesis"], format: "window", genesisStateBytes: createShippingChatWindowGenesisStateBytes });
		const creator = await f.open(0);
		for (let epoch = 0; epoch < 4; epoch++) {
			await creator.room.issue(message(`creator-epoch-${epoch}`));
			expect((await creator.room.sealEpoch()).ok).toBe(true); await creator.room.adoptCreatorSuccessor();
		}
		await expect(creator.room.promoteCreatorCheckpoint({ closedEpoch: 3 })).rejects.toThrow("NATIVE_READ_RESERVATION_BUSY");
	} finally { prototype.acquire = original; }
}, 600_000);
