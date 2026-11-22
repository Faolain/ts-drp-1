import { roomRetentionRefusalOf } from "@ts-drp/storage/room-head";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	boundary,
	closeBoth,
	type Event,
	expectNoRefusedAcquisition,
	expectSameEndState,
	expectUnchangedSinceKill,
	type InterruptionReport,
	kindsOf,
	observeEvents,
	openBoth,
	recover,
	type Recovery,
	type Role,
	type Rooms,
	steadyRooms,
	UNIT_KINDS,
	type UnitKind,
} from "./resume.js";
import { closeFixtures, required } from "../track-m/room-retention-fixture.js";

// Track O: every split point of one boundary on the retention path, for one role. The
// boundary runs with one-unit continuations (a per-transaction cap of one unit: the node's
// own planner splits every decision into whole units), so each transaction carries one
// unit and a kill or a refusal can land between any two consecutive units:
//
// - kill after the n-th unit of each kind: the process dies right after that transaction
//   commits; both rooms reopen from the same databases and run RECOVERY_ROLLOVERS more
//   rollovers (default caps);
// - refusal (capacity, stale or budget) of the transaction after the n-th unit of each
//   kind: the lull goes on from a fresh acquisition, then the rooms reopen and run the same
//   rollovers.
//
// Each must reach the crash-free durable end state of the same one-unit boundary, with no
// refused acquisition. A split point this room's boundary does not have is skipped (the
// reference prints the boundary's transactions).

const OCCURRENCES = [1, 2] as const;
const REFUSALS = [
	["capacity", "RETENTION_CAPACITY"],
	["stale", "RETENTION_STALE"],
	["budget", "RETENTION_BUDGET"],
] as const;

/**
 * Registers the split-point suite of `role`'s boundary.
 * @param role - The role whose boundary is split (creator or observer).
 * @param seed - The room seed.
 */
export function splitSuite(role: Role, seed: string): void {
	let observed: ReturnType<typeof observeEvents> | undefined;
	let reference: Recovery | undefined;
	let composition: InterruptionReport["committed"] | undefined;
	beforeEach(() => {
		observed = observeEvents();
	});
	afterEach(async () => {
		observed?.restore();
		observed = undefined;
		expect(await closeFixtures()).toEqual([]);
	});
	const events = (): Event[] => required(observed).events;
	// A transaction carries `kind` when its unit has rows of it (one epoch's signing unit
	// carries both signing-evidence and signing-summary).
	const positionsOf = (kind: UnitKind): number[] =>
		required(composition).flatMap((units, index) => (units[kind] > 0 ? [index] : []));
	const present = (kind: UnitKind, occurrence: number): boolean => positionsOf(kind).length >= occurrence;
	const resumeAfter = async (report: InterruptionReport, rooms: Rooms): Promise<void> => {
		await closeBoth(rooms);
		if (report.killed) await expectUnchangedSinceKill(rooms, role, report);
		await openBoth(rooms);
		const from = events().length;
		const recovery = await recover(rooms);
		expectNoRefusedAcquisition(events(), from);
		expectSameEndState(recovery, required(reference));
	};

	describe(`Track O: every split point of the ${role}'s boundary resumes (one-unit continuations)`, () => {
		it("reference: the crash-free one-unit boundary, a reopen and three more rollovers", async () => {
			const rooms = await steadyRooms(seed);
			const { lull, report } = await boundary(rooms, { role, oneUnit: true });
			composition = report.committed;
			console.info(`track-o ${role} one-unit transactions: ${JSON.stringify(composition.map(kindsOf))}`);
			expect(lull).toMatchObject({ kind: "maintained" });
			// Every committed transaction carries exactly one unit.
			for (const units of report.committed) expect(units.total).toBe(1);
			expect(report.committed.length).toBeGreaterThan(1);
			await closeBoth(rooms);
			await openBoth(rooms);
			const from = events().length;
			reference = await recover(rooms);
			expect(reference.failed).toBeUndefined();
			expectNoRefusedAcquisition(events(), from);
		}, 900_000);

		for (const kind of UNIT_KINDS)
			for (const occurrence of OCCURRENCES)
				it(`kill right after the transaction carrying ${kind} #${occurrence}`, async (context) => {
					if (!present(kind, occurrence)) return context.skip();
					const rooms = await steadyRooms(seed);
					const { lull, report } = await boundary(rooms, { role, oneUnit: true, kill: { kind, occurrence } });
					console.info(`track-o ${role} killed after: ${JSON.stringify(report.committed.map(kindsOf))}`);
					expect(report.killed).toBe(true);
					expect(lull).toMatchObject({ failed: expect.stringContaining("TRACK_O_KILLED") });
					await resumeAfter(report, rooms);
				}, 900_000);

		for (const [refusal, code] of REFUSALS)
			for (const kind of UNIT_KINDS)
				for (const occurrence of OCCURRENCES)
					it(`the transaction after ${kind} #${occurrence} refused (${refusal}): the lull resumes`, async (context) => {
						if (!present(kind, occurrence)) return context.skip();
						const rooms = await steadyRooms(seed);
						const from = events().length;
						const { lull, report } = await boundary(rooms, {
							role,
							oneUnit: true,
							refuse: { after: kind, kind: refusal, occurrence },
						});
						console.info(
							`track-o ${role} refused after ${kind} #${occurrence}: ${JSON.stringify({ committed: report.committed.map(kindsOf), at: report.committedAtRefusal, refused: report.refusedUnits === undefined ? undefined : kindsOf(report.refusedUnits) })}`
						);
						const last = positionsOf(kind)[occurrence - 1] === required(composition).length - 1;
						if (report.refused) expect(roomRetentionRefusalOf(report.refusal)?.code).toBe(code);
						// After the boundary's last transaction there is none to refuse.
						else expect(last).toBe(true);
						expect(lull).toMatchObject({ kind: "maintained" });
						expectNoRefusedAcquisition(events(), from);
						await resumeAfter(report, rooms);
					}, 900_000);
	});
}
