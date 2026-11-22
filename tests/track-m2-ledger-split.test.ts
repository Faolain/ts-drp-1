import { roomRetentionRefusalOf } from "@ts-drp/storage/room-head";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	boundary,
	type Event,
	expectNoRefusedAcquisition,
	expectSameEndState,
	type InterruptionReport,
	kindsOf,
	observeEvents,
	recover,
	type Recovery,
	type Role,
	steadyRooms,
	UNIT_KINDS,
	type UnitKind,
} from "./fixtures/track-o/resume.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";

// Track M2 (slice 14b stage 2) on Track O's split points.
//
// 1. Coverage: on this branch the boundary Track O's split suites interrupt (its steady room,
//    then that role's lull with one-unit continuations) is decided from the ledger, for both
//    roles: Track O's kill and refusal cases (tests/track-o-room-retention-split*.test.ts)
//    therefore run over a ledger decision, then reopen.
// 2. In-session refusal: the ledger adds no transaction or decision, but after a refused
//    ledger decision the session can go on WITHOUT a reopen. The continuation after the first
//    unit of each kind is refused (stale); the same session then runs three more rollovers.
//    The ledger is dropped at the refusal, the role's next record is an open verification
//    (a complete cold acquisition, in the same lull or at the next boundary), later
//    boundaries decide from the ledger again, no
//    acquisition refuses, and the durable end state equals the crash-free in-session one.
// Mechanism evidence (fake-indexeddb); native SIGKILL is 14f.

const ROLES: readonly Role[] = ["creator", "observer"];
const ledgerRole = (role: Role): string => (role === "creator" ? "creator" : "recipient");

let observed: ReturnType<typeof observeEvents> | undefined;
beforeEach(() => {
	observed = observeEvents();
});
afterEach(async () => {
	observed?.restore();
	observed = undefined;
	expect(await closeFixtures()).toEqual([]);
});
const events = (): Event[] => required(observed).events;
const ledgerEvents = (role: Role, from: number, to = events().length): Event[] =>
	events()
		.slice(from, to)
		.filter((event) => event.kind === "room-retention-ledger" && event.role === ledgerRole(role));

for (const role of ROLES) {
	describe(`Track M2: Track O's split points of the ${role}'s boundary on a ledger decision`, () => {
		let reference: Recovery | undefined;
		let composition: InterruptionReport["committed"] | undefined;
		const present = (kind: UnitKind): boolean => required(composition).some((units) => units[kind] > 0);

		it("reference: the boundary is decided from the ledger; the session goes on in place", async () => {
			const rooms = await steadyRooms(`track-m2-split-${role}`);
			// The ledger was seeded by an open verification before the boundary.
			expect(
				ledgerEvents(role, 0).some((event) => event.action === "recorded" && event.source === "open-verification")
			).toBe(true);
			const before = events().length;
			const { lull, report } = await boundary(rooms, { role, oneUnit: true });
			composition = report.committed;
			console.info(`track-m2 ${role} one-unit transactions: ${JSON.stringify(composition.map(kindsOf))}`);
			expect(lull).toMatchObject({ kind: "maintained" });
			expect(report.committed.length).toBeGreaterThan(1);
			const during = events().slice(before);
			expect(
				ledgerEvents(role, before)
					.filter((event) => event.action === "recorded")
					.map((event) => event.source)
			).toEqual(["boundary"]);
			expect(
				during.filter((event) => event.kind === "room-retention-pass" && event.outcome === "applied").at(-1)
			).toMatchObject({ acquisition: "ledger" });
			const from = events().length;
			reference = await recover(rooms);
			expect(reference.failed).toBeUndefined();
			expectNoRefusedAcquisition(events(), from);
			await rooms.fixture.stop(rooms.recipient);
			await rooms.fixture.stop(rooms.creator);
		}, 900_000);

		for (const kind of UNIT_KINDS)
			it(`the transaction after ${kind} #1 refused (stale): the same session goes on and converges`, async (context) => {
				if (!present(kind)) return context.skip();
				const rooms = await steadyRooms(`track-m2-split-${role}`);
				const before = events().length;
				const { lull, report } = await boundary(rooms, {
					role,
					oneUnit: true,
					refuse: { after: kind, kind: "stale", occurrence: 1 },
				});
				expect(lull).toMatchObject({ kind: "maintained" });
				if (!report.refused) {
					// After the boundary's last transaction there is none to refuse.
					await rooms.fixture.stop(rooms.recipient);
					await rooms.fixture.stop(rooms.creator);
					return context.skip();
				}
				expect(roomRetentionRefusalOf(report.refusal)?.code).toBe("RETENTION_STALE");
				// The refused decision was the ledger's, and the refusal dropped the ledger.
				const refused = events()
					.slice(before)
					.find((event) => event.kind === "room-retention-pass" && event.outcome === "retained");
				expect(refused).toMatchObject({ acquisition: "ledger" });
				expect(
					ledgerEvents(role, before).some(
						(event) => event.action === "dropped" && String(event.reason).startsWith("retained:RETENTION_STALE")
					)
				).toBe(true);
				const from = events().length;
				const recovery = await recover(rooms);
				expectNoRefusedAcquisition(events(), from);
				expectSameEndState(recovery, required(reference));
				// In session: after the drop the role's first record is an open verification (the
				// lull's own fresh acquisition, or the next boundary's), then ledger boundaries.
				const own = ledgerEvents(role, before);
				const drop = own.findIndex(
					(event) => event.action === "dropped" && String(event.reason).startsWith("retained:RETENTION_STALE")
				);
				const recorded = own.slice(drop + 1).filter((event) => event.action === "recorded");
				expect(recorded[0]).toMatchObject({ source: "open-verification" });
				expect(recorded.some((event) => event.source === "boundary")).toBe(true);
				await rooms.fixture.stop(rooms.recipient);
				await rooms.fixture.stop(rooms.creator);
			}, 900_000);
	});
}
