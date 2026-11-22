import { decodeCanonical } from "@ts-drp/canonical";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	closeFixtures,
	dumpDatabase,
	installEnvironment,
	lullFixture,
	required,
	transition,
} from "./fixtures/track-m/room-retention-fixture.js";

// Track M, slice 14b RED 6 (long-room bounds). The browser room on the retention path
// reaches the steady state of tests/recipient-long-room-journal-retention-native.test.ts
// (journal throughEpoch k-2, at most two protected scopes, a recent window of headers),
// taken at the same point (after install, before the lull), plus constant journal
// headers and rows, AHE generations, snapshot scopes and signing rows after the lulls
// from epoch 8, on both the creator and a receive-only recipient. That SQLite test stays
// unchanged. The same room on the existing path is the comparison. Issuance rows are
// reported (TRACK_M_VERBOSE=1), not bounded here: issuance retention is Track N's
// (settlement profile); this canvas room's is recorded in the Track M result.

const EPOCHS = Number(process.env.TRACK_M_LONG_ROOM_EPOCHS ?? 16);
const STEADY_EPOCH = 8;

type Dump = Record<string, [unknown, unknown][]>;
interface Census {
	readonly epoch: number;
	readonly journalThrough: number | null;
	readonly journalProtected: readonly number[] | null;
	readonly journalEpochs: readonly number[];
	readonly counts: Readonly<Record<string, number>>;
}

const events: Readonly<Record<string, unknown>>[] = [];
let restore: (() => void) | undefined;
beforeEach(() => {
	events.length = 0;
	restore = installEnvironment((event) => {
		if (event.kind === "room-retention-pass") events.push(event);
	});
});
afterEach(async () => {
	restore?.();
	expect(await closeFixtures()).toEqual([]);
});

const COUNTED = [
	"journal:scopes",
	"journal:acceptedEntries",
	"ahe:generations",
	"ahe:promotions",
	"ahe:blobs",
	"snapshot:scopes",
	"snapshot:chunks",
	"sealEvidence",
	"signerState",
	"voteSlots",
	"voteOutbox",
] as const;
const BOUNDED = new Set<string>(COUNTED);

function census(epoch: number, dump: Dump): Census {
	const counts: Record<string, number> = {};
	for (const [store, rows] of Object.entries(dump))
		if (BOUNDED.has(store) || store.startsWith("issuance:")) counts[store] = rows.length;
	for (const store of COUNTED) counts[store] ??= 0;
	// The native row carries the control's canonical bytes: { objectId, record, planRecord? }.
	const controlRow = (dump["journal:retirementControls"] ?? [])[0]?.[1] as { record?: unknown } | undefined;
	const control = (controlRow?.record instanceof Uint8Array ? decodeCanonical(controlRow.record) : undefined) as
		| { completed?: { throughEpoch: number; protectedScopes: readonly { epoch: number }[] } | null }
		| undefined;
	return {
		epoch,
		journalThrough: control?.completed?.throughEpoch ?? null,
		journalProtected: control?.completed?.protectedScopes.map((scope) => scope.epoch) ?? null,
		journalEpochs: (dump["journal:scopes"] ?? []).map(([key]) => Number((key as unknown[])[1])),
		counts,
	};
}

/** At install (before the lull), the SQLite test's steady state: the journal fence is k-2
 * with at most two protected scopes behind it, and only a recent window of headers. */
function expectInstalled(label: string, rows: readonly Census[]): void {
	const steady = rows.filter((row) => row.epoch >= STEADY_EPOCH);
	expect(steady.length, `${label} steady census`).toBeGreaterThanOrEqual(4);
	for (const row of steady) {
		const at = `${label} installed at epoch ${row.epoch}`;
		expect(row.journalThrough, at).toBe(row.epoch - 2);
		expect(required(row.journalProtected).length, at).toBeLessThanOrEqual(2);
		expect(
			required(row.journalProtected).every((epoch) => epoch >= row.epoch - 3),
			at
		).toBe(true);
		expect(
			row.journalEpochs.filter((epoch) => epoch !== 0).every((epoch) => epoch > row.epoch - STEADY_EPOCH),
			at
		).toBe(true);
	}
}

/** After the lulls: the fence moves one epoch per boundary and every bounded store holds a
 * constant number of rows from epoch 8. */
function expectConstant(label: string, rows: readonly Census[]): void {
	const steady = rows.filter((row) => row.epoch >= STEADY_EPOCH);
	expect(steady.length, `${label} steady census`).toBeGreaterThanOrEqual(4);
	const first = required(steady[0]);
	for (const row of steady) {
		const at = `${label} after the lulls at epoch ${row.epoch}`;
		expect(row.journalThrough, at).toBe(required(first.journalThrough) + row.epoch - first.epoch);
		for (const store of COUNTED) expect(row.counts[store], `${at}: ${store}`).toBe(first.counts[store]);
	}
}

interface Run {
	readonly installed: { creator: Census[]; recipient: Census[] };
	readonly lulled: { creator: Census[]; recipient: Census[] };
	readonly outcomes: unknown[];
}

async function longRoom(retention: boolean): Promise<Run> {
	const fixture = await lullFixture({ retention, creatorLull: true, seed: `track-m-long-room-${retention}` });
	const creator = await fixture.open("creator", fixture.creator);
	const recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	const run: Run = { installed: { creator: [], recipient: [] }, lulled: { creator: [], recipient: [] }, outcomes: [] };
	const first = events.length;
	const take = async (into: { creator: Census[]; recipient: Census[] }, epoch: number) => {
		into.creator.push(census(epoch, await dumpDatabase(fixture.host.database("creator"))));
		into.recipient.push(census(epoch, await dumpDatabase(fixture.host.database("observer"))));
	};
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await transition(fixture, creator, recipient, epoch);
		await take(run.installed, epoch + 1);
		const lulls = [await creator.room.maintainRecoveryPool(), await recipient.room.maintainRecoveryPool()];
		// The creator's explicit lull starts at epoch 3 (deferred before), as on the existing path.
		for (const lull of lulls)
			expect(["maintained", "not-needed", ...(epoch < 3 ? ["deferred"] : [])]).toContain(
				(lull as { kind: string }).kind
			);
		await take(run.lulled, epoch + 1);
		if (process.env.TRACK_M_VERBOSE === "1")
			process.stdout.write(
				`TRACK_M_LONG_ROOM ${JSON.stringify({ retention, epoch: epoch + 1, creator: run.lulled.creator.at(-1), recipient: run.lulled.recipient.at(-1) })}\n`
			);
	}
	run.outcomes.push(...events.slice(first).map((event) => event.outcome));
	await fixture.stop(recipient);
	await fixture.stop(creator);
	return run;
}

it(`a creator and a recipient keep bounded rows over ${EPOCHS} retention lulls`, async () => {
	expect(EPOCHS).toBeGreaterThanOrEqual(STEADY_EPOCH + 4);
	const run = await longRoom(true);
	// Every lull from the first steady boundary on decided on the retention path.
	expect(run.outcomes.length).toBeGreaterThanOrEqual(2 * (EPOCHS - 4));
	expect(run.outcomes.filter((outcome) => outcome !== "applied")).toEqual([]);
	for (const who of ["creator", "recipient"] as const) {
		expectInstalled(who, run.installed[who]);
		expectConstant(who, run.lulled[who]);
	}
	// The same room on the existing path: the retention path never keeps fewer rows, and
	// keeps more only where it lags (one recipient journal header, retired one lull later).
	const existing = await longRoom(false);
	for (const who of ["creator", "recipient"] as const)
		for (const [index, row] of run.lulled[who].entries()) {
			if (row.epoch < STEADY_EPOCH) continue;
			const base = required(existing.lulled[who][index]);
			const at = `${who} at epoch ${row.epoch}`;
			expect(row.journalThrough, at).toBe(base.journalThrough);
			expect(row.journalProtected, at).toEqual(base.journalProtected);
			for (const store of COUNTED) {
				const lag = who === "recipient" && store === "journal:scopes" ? 1 : 0;
				expect(required(row.counts[store]), `${at}: ${store}`).toBeGreaterThanOrEqual(required(base.counts[store]));
				expect(required(row.counts[store]), `${at}: ${store}`).toBeLessThanOrEqual(required(base.counts[store]) + lag);
			}
		}
}, 1_800_000);
