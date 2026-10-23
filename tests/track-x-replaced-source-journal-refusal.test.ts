import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import {
	blockIds,
	deliver,
	install,
	isControl,
	journalHolds,
	openOutsideRowsRoom as open,
	play,
	protectedEpochs,
	seal,
} from "./fixtures/track-x/outside-rows-room.js";

// The unified Done rule replaces the former later-Cut chain rule. A terminally covered own
// source whose exact local replacement is complete can retire while that replacement misses
// later Cuts. Missing or forged completion retains it. Received outside rows wait for durable
// successor installation. The native schedule below proves that later chain delivery is not a
// second cleanup requirement; completion/forgery controls live with the shared owner tests.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

it("collects a terminally covered settled source even while its replacements miss later Cuts", async () => {
	const room = await open();
	const creator = required(room.peers[0]);
	const history: string[] = [];
	const MISSED = 1;
	// The replacements issued by the installs after these seals miss the next Cut.
	const CHAIN = new Set([MISSED, MISSED + 1, MISSED + 2]);
	// The last link, issued by the install after the last chain seal, is in cut(LAST); this Writer
	// knows that Cut from its install after seal LAST.
	const LAST = MISSED + 4;
	// Through the install of epoch LAST (the evidence run for the window sets more: its install of
	// epoch 8 refuses, "settlement plan references retired or absent issued work").
	const EPOCHS = Number(process.env.TRACK_X_R5_REFUSAL_A_EPOCHS ?? LAST);
	let source: DurableIssuanceOutboxRecord | undefined;
	let late: DurableIssuanceOutboxRecord[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		// The Writer does not move while its replacement is withheld: its moves would depend on it.
		await play(room, `epoch-${epoch}`, CHAIN.has(epoch - 1) ? [0] : [0, 1]);
		await seal(room, epoch, epoch === MISSED ? [1] : []);
		// The withheld replacement reaches the creator after its seal, which drops it.
		if (late.length > 0) creator.inject(late, 1);
		late = [];
		if (epoch === MISSED)
			source = (await room.fixture.publishedAfter(1, null)).find(
				(row) => row.commit.authorSequence === room.delivered[1]
			);
		await creator.room.adoptCreatorSuccessor();
		const installed = await install(room, 1);
		const kept = await protectedEpochs(room, 1);
		history.push(`epoch ${epoch + 1}: ${installed}; protected [${kept.join(",")}]`);
		expect(installed, history.join("\n")).toBe("ok");
		if (epoch >= MISSED + 3 && epoch < LAST) {
			// Its signed terminal coverage and local completion are enough once replay ends.
			// The replacement's own future acceptance is a separate row's lifecycle.
			expect(kept, history.join("\n")).not.toContain(MISSED);
			expect(await journalHolds(room, 1, required(source).commit.envelope.digest)).toBe(false);
		}
		if (CHAIN.has(epoch)) {
			// The install's fence reaches the creator in time (no admission report exists for a
			// control row; the seal's settle covers it), and its replacement only after the next seal.
			const rows = await room.fixture.publishedAfter(1, room.delivered[1]);
			expect(rows.map(isControl)).toEqual([true, false]);
			creator.inject([required(rows[0])], 1);
			late = [required(rows[1])];
			room.delivered[1] = required(rows[1]).commit.authorSequence;
		} else await deliver(room, 1);
	}
	console.log(`TRACK_X_R5_REFUSAL_A ${JSON.stringify(history)}`);
	// The move converged through the fourth link.
	expect(blockIds(creator)).toContain(`seal-${MISSED}-1`);
}, 900_000);

it("(c) a scope holding another Writer's move outside the Cut is kept across a crash after the install, then collected", async () => {
	const room = await open(2);
	const creator = required(room.peers[0]);
	const history: string[] = [];
	const OUTSIDE = 1;
	let received: DurableIssuanceOutboxRecord | undefined;
	for (let epoch = 0; epoch < 6; epoch++) {
		await play(room, `epoch-${epoch}`);
		// Writer 2 moves during this seal; Writer 1, still in the sealed epoch, admits it.
		await seal(room, epoch, epoch === OUTSIDE ? [2] : [], epoch === OUTSIDE ? [1] : []);
		if (epoch === OUTSIDE)
			received = (await room.fixture.publishedAfter(2, null)).find(
				(row) => row.commit.authorSequence === room.delivered[2]
			);
		await creator.room.adoptCreatorSuccessor();
		const installed = [await install(room, 1), await install(room, 2)];
		history.push(
			`epoch ${epoch + 1}: ${installed.join(",")}; writer-1 protected [${(await protectedEpochs(room, 1)).join(",")}]`
		);
		expect(installed, history.join("\n")).toEqual(["ok", "ok"]);
		if (epoch === OUTSIDE) {
			// Writer 1's install of the successor is durable; it crashes before any later retirement.
			const digest = required(received).commit.envelope.digest;
			expect(await journalHolds(room, 1, digest)).toBe(true);
			await room.fixture.stop(required(room.peers[1]));
			room.peers[1] = await room.fixture.open(1, { reopen: true });
			expect(required(room.peers[1]).room.authority()?.epoch).toBe(OUTSIDE + 1);
			expect(await journalHolds(room, 1, digest), "kept across the crash").toBe(true);
		}
		await deliver(room, 1);
		await deliver(room, 2);
	}
	console.log(`TRACK_X_R5_REFUSAL_C ${JSON.stringify(history)}`);
	expect(blockIds(creator)).toContain(`seal-${OUTSIDE}-2`);
	expect(await protectedEpochs(room, 1), history.join("\n")).not.toContain(OUTSIDE);
	expect(await journalHolds(room, 1, required(received).commit.envelope.digest), "collected").toBe(false);
	expect(required(room.peers[1]).room.projection()).toEqual(creator.room.projection());
}, 900_000);
