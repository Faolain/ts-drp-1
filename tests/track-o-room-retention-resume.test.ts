import { roomRetentionRefusalOf } from "@ts-drp/storage/room-head";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import {
	boundary,
	closeBoth,
	type Event,
	expectNoRefusedAcquisition,
	expectSameEndState,
	expectUnchangedSinceKill,
	kindsOf,
	observeEvents,
	openBoth,
	recover,
	type Recovery,
	steadyRooms,
} from "./fixtures/track-o/resume.js";

// Track O, RED for Track M's finding 1 (14f case 8) at node level, on the browser room
// database host (fake-indexeddb; the native engines with a real SIGKILL are 14f), at the
// default per-transaction caps.
//
// The creator's steady boundary on the opt-in retention path retires epoch e's signing
// evidence. Whatever transaction of that boundary commits last, the next pass must resume
// and the room must reach the crash-free durable end state: no unclassified signing
// dependency, no halted maintenance, and no signing row left in an epoch the signing
// control already retires.
//
// - kill: the process dies right after the transaction that retired e's evidence commits
//   (Track M: its first decision, D1). Both rooms reopen from the same databases.
// - refusal: the next transaction of the same boundary (Track M: D2, e's summaries) is
//   refused with a genuine owner refusal (stale, budget, capacity), which writes nothing;
//   the lull's next pass then runs from a fresh acquisition.

const SEED = "track-o-resume";
let observed: ReturnType<typeof observeEvents> | undefined;
let reference: Recovery | undefined;

beforeEach(() => {
	observed = observeEvents();
});
afterEach(async () => {
	observed?.restore();
	observed = undefined;
	expect(await closeFixtures()).toEqual([]);
});

const events = (): Event[] => required(observed).events;

describe("Track O: a creator boundary resumes from every committed prefix (14f case 8)", () => {
	it("reference: the crash-free boundary, a reopen and three more rollovers", async () => {
		const rooms = await steadyRooms(SEED);
		const { lull, report } = await boundary(rooms, { role: "creator" });
		console.info(`track-o reference transactions: ${JSON.stringify(report.committed.map(kindsOf))}`);
		expect(lull).toMatchObject({ kind: "maintained" });
		// The boundary under test retires signing evidence on the retention path.
		expect(report.committed.some((units) => units["signing-evidence"] > 0)).toBe(true);
		await closeBoth(rooms);
		await openBoth(rooms);
		const from = events().length;
		reference = await recover(rooms);
		expect(reference.failed).toBeUndefined();
		expectNoRefusedAcquisition(events(), from);
		for (const rollover of reference.rollovers) expect(rollover.creatorRetiredSigning).toEqual([]);
	}, 900_000);

	it("a kill right after the transaction that retires the evidence commits: reopen resumes", async () => {
		const rooms = await steadyRooms(SEED);
		const { lull, report } = await boundary(rooms, { role: "creator", kill: { kind: "signing-evidence" } });
		console.info(`track-o killed after: ${JSON.stringify(report.committed.map(kindsOf))}`);
		expect(report.killed).toBe(true);
		expect(lull).toMatchObject({ failed: expect.stringContaining("TRACK_O_KILLED") });
		await closeBoth(rooms);
		await expectUnchangedSinceKill(rooms, "creator", report);
		await openBoth(rooms);
		const from = events().length;
		const recovery = await recover(rooms);
		expectNoRefusedAcquisition(events(), from);
		expectSameEndState(recovery, required(reference));
	}, 900_000);

	for (const [kind, code] of [
		["stale", "RETENTION_STALE"],
		["budget", "RETENTION_BUDGET"],
		["capacity", "RETENTION_CAPACITY"],
	] as const)
		it(`the next transaction of the boundary refused (${kind}) after the evidence committed: the lull resumes`, async () => {
			const rooms = await steadyRooms(SEED);
			const from = events().length;
			const { lull, report } = await boundary(rooms, { role: "creator", refuse: { after: "signing-evidence", kind } });
			console.info(
				`track-o refused (${kind}): ${JSON.stringify({ committed: report.committed.map(kindsOf), at: report.committedAtRefusal, refused: report.refusedUnits === undefined ? undefined : kindsOf(report.refusedUnits) })}`
			);
			const carried = report.committed.findIndex((units) => units["signing-evidence"] > 0);
			expect(carried).toBeGreaterThanOrEqual(0);
			if (report.refused) {
				// A refusal writes nothing: the boundary's committed prefix is the durable state.
				expect(roomRetentionRefusalOf(report.refusal)?.code).toBe(code);
				expect(report.committedAtRefusal).toBe(carried + 1);
			} else {
				// No transaction of this boundary follows the one that retired the evidence: the
				// state a refusal would leave does not exist (that epoch's summaries retired with it).
				expect(report.committed).toHaveLength(carried + 1);
				expect(required(report.committed[carried])["signing-summary"]).toBeGreaterThan(0);
			}
			expect(lull).toMatchObject({ kind: "maintained" });
			expectNoRefusedAcquisition(events(), from);
			await closeBoth(rooms);
			await openBoth(rooms);
			const recovered = events().length;
			const recovery = await recover(rooms);
			expectNoRefusedAcquisition(events(), recovered);
			expectSameEndState(recovery, required(reference));
		}, 900_000);
});
