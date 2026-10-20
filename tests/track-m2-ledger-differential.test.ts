import { afterEach, beforeEach, expect, it } from "vitest";

import {
	closeFixtures,
	dumpDatabase,
	installEnvironment,
	lullFixture,
	required,
	transition,
} from "./fixtures/track-m/room-retention-fixture.js";
import { rowId, stable } from "./fixtures/track-m/room-retention-probe.js";
import { settlementRoom, settlementTransition } from "./fixtures/track-m/settlement-room.js";

// Track M2, slice 14b RED 5 for stage 2 (differential safety of the ledger decision).
//
// 1. Shadow: stage 1 decides every boundary; beside it, on the same pre-state, the ledger
//    planner decides from its in-session ledger plus the boundary's fresh census and delta.
//    Every compared boundary must report `room-retention-ledger-shadow` with `equal: true`
//    (the same selections, survivors, controls and turnover). Seeded random histories (skipped
//    lulls, swapped lull order, one persisted reopen) and Track N's settlement room.
// 2. Applied twins: the same deterministic settlement history with the ledger deciding
//    (`apply`) and with stage 1 alone (`off`). At every epoch both peers hold exactly the
//    same owned rows: the ledger never deletes a row stage 1 keeps, nor keeps one it deletes.
// Mechanism evidence only (fake-indexeddb).

type Event = Readonly<Record<string, unknown>>;
const shadows: Event[] = [];
const passes: Event[] = [];
let restore: (() => void) | undefined;
beforeEach(() => {
	shadows.length = 0;
	passes.length = 0;
	restore = installEnvironment((event) => {
		if (event.kind === "room-retention-ledger-shadow") shadows.push(event);
		if (event.kind === "room-retention-pass") passes.push(event);
	});
});
afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__roomRetentionLedgerMode");
	restore?.();
	expect(await closeFixtures()).toEqual([]);
});

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const EPOCHS = Number(process.env.TRACK_M2_DIFFERENTIAL_EPOCHS ?? 16);

async function shadowHistory(seed: number): Promise<void> {
	Reflect.set(globalThis, "__roomRetentionLedgerMode", "shadow");
	const next = random(seed);
	const fixture = await lullFixture({ retention: true, creatorLull: true, seed: `track-m2-diff-${seed}` });
	let creator = await fixture.open("creator", fixture.creator);
	let recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	const reopenAt = seed === 0 ? -1 : 6 + Math.floor(next() * 6);
	let skipped = { creator: false, recipient: false };
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await transition(fixture, creator, recipient, epoch);
		const order =
			seed !== 0 && next() < 0.3 ? (["recipient", "creator"] as const) : (["creator", "recipient"] as const);
		for (const who of order) {
			const skip = seed !== 0 && epoch >= 4 && !skipped[who] && next() < 0.2;
			skipped = { ...skipped, [who]: skip };
			if (skip) continue;
			await (who === "creator" ? creator : recipient).room.maintainRecoveryPool();
		}
		if (epoch + 1 === reopenAt) {
			await fixture.stop(recipient);
			await fixture.stop(creator);
			creator = await fixture.open("creator", fixture.creator, { reopen: true });
			recipient = await fixture.open("observer", fixture.observer, { reopen: true, receiveOnly: true });
		}
	}
	await fixture.stop(recipient);
	await fixture.stop(creator);
	if (process.env.TRACK_M_VERBOSE === "1")
		for (const shadow of shadows) process.stdout.write(`TRACK_M2_SHADOW seed-${seed} ${stable(shadow)}\n`);
	for (const shadow of shadows) expect(shadow, stable(shadow)).toMatchObject({ equal: true });
	expect(shadows.filter((shadow) => shadow.role === "creator").length).toBeGreaterThanOrEqual(4);
	expect(shadows.filter((shadow) => shadow.role === "recipient").length).toBeGreaterThanOrEqual(4);
	expect(passes.filter((pass) => pass.acquisition === "ledger")).toEqual([]);
}

it(`shadow: the ledger decision equals stage 1's at every compared boundary of a ${EPOCHS}-epoch room`, async () => {
	expect(EPOCHS).toBeGreaterThanOrEqual(16);
	await shadowHistory(0);
}, 3_600_000);

const SEEDS = (process.env.TRACK_M2_DIFFERENTIAL_SEEDS ?? "1,2")
	.split(",")
	.map((value) => Number(value))
	.filter((value) => Number.isSafeInteger(value) && value > 0);

it.each(SEEDS)(
	"shadow: the ledger decision equals stage 1's on seeded random history %i",
	async (seed) => {
		await shadowHistory(required(seed));
	},
	3_600_000
);

it(`shadow: Track N's settlement room, ${EPOCHS} epochs`, async () => {
	Reflect.set(globalThis, "__roomRetentionLedgerMode", "shadow");
	const fixture = await settlementRoom({ retention: true, name: "m2-shadow" });
	const peers = [await fixture.open(0), await fixture.open(1)] as const;
	const delivered: (number | null)[] = [null, null];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await settlementTransition(fixture, peers, delivered, epoch);
		await peers[0].room.maintainRecoveryPool();
		await peers[1].room.maintainRecoveryPool();
	}
	await fixture.stop(peers[1]);
	await fixture.stop(peers[0]);
	for (const shadow of shadows) expect(shadow, stable(shadow)).toMatchObject({ equal: true });
	expect(shadows.filter((shadow) => shadow.role === "creator").length).toBeGreaterThanOrEqual(4);
	expect(shadows.filter((shadow) => shadow.role === "recipient").length).toBeGreaterThanOrEqual(4);
}, 3_600_000);

const OWNED = /^(ahe:|journal:|snapshot:|issuance:|(sealEvidence|signerState|voteSlots|voteOutbox|storageMeta) )/;

/** One deterministic settlement history; every owned row id of both peers after each epoch. */
async function appliedHistory(mode: "apply" | "off"): Promise<(readonly [ReadonlySet<string>, ReadonlySet<string>])[]> {
	Reflect.set(globalThis, "__roomRetentionLedgerMode", mode);
	const fixture = await settlementRoom({ retention: true, name: "m2-twin" });
	const peers = [await fixture.open(0), await fixture.open(1)] as const;
	const delivered: (number | null)[] = [null, null];
	const out: (readonly [ReadonlySet<string>, ReadonlySet<string>])[] = [];
	const owned = async (peer: number): Promise<ReadonlySet<string>> => {
		const dump = await dumpDatabase(fixture.database(peer));
		const ids = new Set<string>();
		for (const [store, rows] of Object.entries(dump))
			for (const [key] of rows) {
				const id = rowId(store, key);
				if (OWNED.test(id)) ids.add(id);
			}
		return ids;
	};
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await settlementTransition(fixture, peers, delivered, epoch);
		await peers[0].room.maintainRecoveryPool();
		await peers[1].room.maintainRecoveryPool();
		out.push([await owned(0), await owned(1)] as const);
	}
	await fixture.stop(peers[1]);
	await fixture.stop(peers[0]);
	return out;
}

it("applied twins: with the ledger deciding, both peers hold exactly stage 1's rows at every epoch", async () => {
	const stage1 = await appliedHistory("off");
	const before = passes.length;
	const ledger = await appliedHistory("apply");
	expect(
		passes.slice(before).filter((pass) => pass.acquisition === "ledger" && pass.outcome === "applied").length,
		"ledger decisions applied"
	).toBeGreaterThanOrEqual(8);
	for (const [index, [creator, recipient]] of ledger.entries()) {
		const [baseCreator, baseRecipient] = required(stage1[index]);
		for (const [label, mine, base] of [
			["creator", creator, baseCreator],
			["recipient", recipient, baseRecipient],
		] as const) {
			const onlyStage1 = [...base].filter((id) => !mine.has(id));
			const onlyLedger = [...mine].filter((id) => !base.has(id));
			expect({ epoch: index + 1, label, onlyStage1, onlyLedger }).toEqual({
				epoch: index + 1,
				label,
				onlyStage1: [],
				onlyLedger: [],
			});
		}
	}
}, 3_600_000);
