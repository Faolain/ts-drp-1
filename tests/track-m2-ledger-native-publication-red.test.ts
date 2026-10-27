import { afterEach, beforeEach, expect, it } from "vitest";

import { closeFixtures, installEnvironment } from "./fixtures/track-m/room-retention-fixture.js";
import { stable } from "./fixtures/track-m/room-retention-probe.js";
import { settlementRoom, settlementTransition } from "./fixtures/track-m/settlement-room.js";

// RED (pre-existing defect, isolated from tests/track-m2-ledger-differential.test.ts
// "shadow: Track N's settlement room"). In a creator-trusted-settlement-v1 room the
// recipient's steady boundary authenticates as a native publication (1515daab): its
// forward facts hold one snapshot target per native current row (3 here), and stage 1
// accepts that count. The stage-2 ledger planner (planRoomRetentionFromLedger, 3794be41)
// still requires exactly two held targets, so at every recipient boundary it throws
// `snapshot-unavailable`. That refusal drops the ledger, so a settlement recipient is
// never planned from the ledger and is never shadow-compared. A boundary shape the planner
// does not model must be decided by it or declined as a shape, not refused.

type Event = Readonly<Record<string, unknown>>;
const ledger: Event[] = [];
const shadows: Event[] = [];
let restore: (() => void) | undefined;
beforeEach(() => {
	ledger.length = 0;
	shadows.length = 0;
	restore = installEnvironment((event) => {
		if (event.kind === "room-retention-ledger") ledger.push(event);
		if (event.kind === "room-retention-ledger-shadow") shadows.push(event);
	});
});
afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__roomRetentionLedgerMode");
	restore?.();
	expect(await closeFixtures()).toEqual([]);
});

const EPOCHS = 8;

it(`the ledger planner plans a settlement-v1 recipient's native-publication boundary (${EPOCHS} epochs)`, async () => {
	Reflect.set(globalThis, "__roomRetentionLedgerMode", "shadow");
	const fixture = await settlementRoom({ retention: true, name: "m2-native-publication" });
	const peers = [await fixture.open(0), await fixture.open(1)] as const;
	const delivered: (number | null)[] = [null, null];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await settlementTransition(fixture, peers, delivered, epoch);
		await peers[0].room.maintainRecoveryPool();
		await peers[1].room.maintainRecoveryPool();
	}
	await fixture.stop(peers[1]);
	await fixture.stop(peers[0]);
	const refused = ledger.filter((event) => event.role === "recipient" && String(event.reason ?? "").startsWith("refused:"));
	expect(refused.map(stable), "recipient ledger boundaries refused instead of planned or declined").toEqual([]);
	for (const shadow of shadows) expect(shadow, stable(shadow)).toMatchObject({ equal: true });
	expect(shadows.filter((shadow) => shadow.role === "recipient").length).toBeGreaterThanOrEqual(1);
}, 3_600_000);
