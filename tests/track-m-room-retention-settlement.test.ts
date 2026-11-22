import { decodeCanonical } from "@ts-drp/canonical";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	closeFixtures,
	dumpDatabase,
	installEnvironment,
	required,
} from "./fixtures/track-m/room-retention-fixture.js";
import { settlementRoom, type SettlementRoom, settlementTransition } from "./fixtures/track-m/settlement-room.js";

// Track M, slice 14b RED 5 on Track N's settlement room (Grid zone application,
// creator-trusted-settlement-v1, the creator and one Writer recipient issuing every epoch,
// the recipient's cold issuance drain at activation in `cleanupCreatorSettlementSuccessor`).
// 1. Plan-only differential: at every lull the retention decisions delete a subset of the
//    rows the existing planner deletes for the same pre-state, with equal issuance holes.
// 2. Applied: the same deterministic history on the existing path and on the retention
//    path; at every epoch the retention path keeps every issuance row the existing path
//    keeps (it never retires more), and the recipient's issuance stays flat (Track N's
//    bound), i.e. the retention decisions' AHE and issuance labels meet Track N's drain.
// Mechanism evidence only (fake-indexeddb).

type Dump = Record<string, [unknown, unknown][]>;
type Event = Readonly<Record<string, unknown>>;
const stable = (value: unknown): string =>
	JSON.stringify(value, (_key, item: unknown) =>
		item instanceof Uint8Array ? { $b: Buffer.from(item).toString("hex") } : (item as unknown)
	);
const rowId = (store: string, key: unknown): string => `${store} ${stable(key)}`;
function index(dump: Dump): Map<string, string> {
	const out = new Map<string, string>();
	for (const [store, entries] of Object.entries(dump))
		for (const [key, value] of entries) out.set(rowId(store, key), stable(value));
	return out;
}
const OWNED = /^(ahe:|journal:|snapshot:|issuance:|(sealEvidence|signerState|voteSlots|voteOutbox) )/;
const ISSUANCE_ROWS = ["issuance:issuedRecords", "issuance:issuanceOutbox"] as const;

interface Selection {
	readonly snapshot: { readonly retire: readonly { readonly scope: Record<string, unknown> }[] };
	readonly signing: { readonly summaries: readonly { readonly store: string; readonly key: unknown }[] };
	readonly ahe: {
		readonly units: readonly {
			readonly reclamation: { readonly lineageFloor: { readonly deleteGenerationIds: readonly string[] } };
		}[];
	};
	readonly issuance: { readonly protectedRecords: readonly unknown[] };
}
interface PlannedSection {
	readonly delete: readonly { readonly store: string; readonly key: unknown }[];
}

/** The rows the retention decisions name, as physical row ids of the pre-state dump. */
function predicted(event: Event, pre: Dump): Set<string> {
	const out = new Set<string>();
	const planned = event.planned as { owners: Record<string, PlannedSection | undefined> } | undefined;
	for (const [owner, section] of Object.entries(planned?.owners ?? {}))
		for (const row of section?.delete ?? []) {
			const physical = pre[`${owner}:${row.store}`] !== undefined ? `${owner}:${row.store}` : row.store;
			out.add(rowId(physical, row.key));
		}
	for (const selection of event.selections as readonly Selection[]) {
		for (const { scope } of selection.snapshot.retire)
			for (const [key, value] of pre["snapshot:scopes"] ?? []) {
				const row = value as Record<string, unknown>;
				if (!["objectId", "epoch", "anchor", "manifestDigest"].every((field) => row[field] === scope[field])) continue;
				out.add(rowId("snapshot:scopes", key));
				const prefix = stable(key).slice(0, -1);
				for (const [chunk] of pre["snapshot:chunks"] ?? [])
					if (stable(chunk).startsWith(`${prefix},`)) out.add(rowId("snapshot:chunks", chunk));
			}
		for (const entry of selection.signing.summaries) out.add(rowId(entry.store, entry.key));
		const retired = new Set(selection.ahe.units.flatMap((unit) => unit.reclamation.lineageFloor.deleteGenerationIds));
		if (retired.size === 0) continue;
		for (const [key] of pre["ahe:generations"] ?? [])
			if (retired.has(String((key as unknown[])[1]))) out.add(rowId("ahe:generations", key));
		const promotions = (pre["ahe:promotions"] ?? []).map(([key]) => key as unknown[]);
		const kept = new Set(promotions.filter((key) => !retired.has(String(key[1]))).map((key) => String(key[2])));
		for (const key of promotions)
			if (retired.has(String(key[1]))) {
				out.add(rowId("ahe:promotions", key));
				if (!kept.has(String(key[2]))) out.add(rowId("ahe:blobs", key[2]));
			}
	}
	return out;
}

/** The issuance owner's completed holes in a dump (the decoded native control). */
function issuanceHoles(dump: Dump): unknown {
	for (const [, value] of dump["issuance:retirementControls"] ?? []) {
		const record = (value as { record?: unknown }).record;
		const control = (record instanceof Uint8Array ? decodeCanonical(record) : record) as {
			completed?: { protectedRecords?: readonly { author: string; authorSequence: number; digest: unknown }[] } | null;
		};
		const holes = control?.completed?.protectedRecords;
		return holes === undefined
			? null
			: holes.map((hole) => ({
					author: hole.author,
					authorSequence: hole.authorSequence,
					digest: hole.digest instanceof Uint8Array ? Buffer.from(hole.digest).toString("hex") : hole.digest,
				}));
	}
	return null;
}

const plans: Event[] = [];
const passes: Event[] = [];
let mode: "probe" | "apply" = "probe";
let armed = false;
let restore: (() => void) | undefined;
beforeEach(() => {
	plans.length = 0;
	passes.length = 0;
	mode = "probe";
	restore = installEnvironment((event) => {
		if (event.kind === "room-retention-plan-only") plans.push(event);
		if (event.kind === "room-retention-pass") passes.push(event);
	});
	// Probe: the existing path runs everything; the retention path plans beside the FIRST
	// pass of each lull and writes nothing. Apply: the retention path decides normally.
	Reflect.set(globalThis, "__roomRetentionMode", () => {
		if (mode === "apply") return "apply";
		if (!armed) return "off";
		armed = false;
		return "plan-only";
	});
});
afterEach(async () => {
	armed = false;
	restore?.();
	expect(await closeFixtures()).toEqual([]);
});

const EPOCHS = Number(process.env.TRACK_M_SETTLEMENT_EPOCHS ?? 16);
const STEADY_EPOCH = 8;

interface LullReport {
	readonly epoch: number;
	readonly who: "creator" | "recipient";
	readonly planned: boolean;
	readonly predicted: number;
	readonly deleted: number;
	readonly unsafe: readonly string[];
	readonly gap: readonly string[];
	readonly holes: "equal" | "differ" | "none";
	readonly holeDetail?: unknown;
}

async function probedLull(
	fixture: SettlementRoom,
	room: Readonly<{ maintainRecoveryPool(): Promise<unknown> }>,
	who: "creator" | "recipient",
	epoch: number,
	reports: LullReport[]
): Promise<void> {
	const database = fixture.database(who === "creator" ? 0 : 1);
	const pre = await dumpDatabase(database);
	const before = plans.length;
	armed = true;
	await room.maintainRecoveryPool();
	armed = false;
	const post = await dumpDatabase(database);
	const preRows = index(pre);
	const postRows = index(post);
	const deleted = new Set([...preRows.keys()].filter((id) => !postRows.has(id) && OWNED.test(id)));
	const events = plans.slice(before);
	expect(events.length, `${who} lull ${epoch}: at most one probe`).toBeLessThanOrEqual(1);
	const event = events[0];
	if (event === undefined) {
		reports.push({
			epoch,
			who,
			planned: false,
			predicted: 0,
			deleted: deleted.size,
			unsafe: [],
			gap: [],
			holes: "none",
		});
		return;
	}
	expect(event.refused, `${who} lull ${epoch}: the first decision plans`).toBeUndefined();
	const named = predicted(event, pre);
	const holes = (event.selections as readonly Selection[])[0]?.issuance.protectedRecords;
	const equal = stable(holes) === stable(issuanceHoles(post));
	reports.push({
		epoch,
		who,
		planned: true,
		predicted: named.size,
		deleted: deleted.size,
		unsafe: [...named].filter((id) => !deleted.has(id)),
		gap: [...deleted].filter((id) => !named.has(id)),
		holes: equal ? "equal" : "differ",
		...(equal ? {} : { holeDetail: { planned: holes, existing: issuanceHoles(post) } }),
	});
}

it(`settlement room: retention decisions delete a subset of the existing planner's rows at every lull of ${EPOCHS} epochs`, async () => {
	expect(EPOCHS).toBeGreaterThanOrEqual(16);
	const fixture = await settlementRoom({ retention: true, name: "probe" });
	const peers = [await fixture.open(0), await fixture.open(1)] as const;
	const delivered: (number | null)[] = [null, null];
	const reports: LullReport[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await settlementTransition(fixture, peers, delivered, epoch);
		await probedLull(fixture, peers[0].room, "creator", epoch + 1, reports);
		await probedLull(fixture, peers[1].room, "recipient", epoch + 1, reports);
	}
	if (process.env.TRACK_M_VERBOSE === "1")
		for (const report of reports) process.stdout.write(`TRACK_M_SETTLEMENT_DIFF ${JSON.stringify(report)}\n`);
	for (const report of reports) {
		const at = `${report.who} lull at epoch ${report.epoch}`;
		expect(report.unsafe, at).toEqual([]);
		if (report.planned) expect(report.holes, `${at}: issuance holes`).toBe("equal");
	}
	for (const who of ["creator", "recipient"] as const)
		expect(
			reports.filter((report) => report.who === who && report.planned && report.predicted > 0).length,
			`${who} planned lulls`
		).toBeGreaterThanOrEqual(4);
}, 3_600_000);

interface Census {
	readonly epoch: number;
	readonly issuance: readonly [ReadonlySet<string>, ReadonlySet<string>];
	readonly counts: readonly [Readonly<Record<string, number>>, Readonly<Record<string, number>>];
}

/** One deterministic Track N history with both lulls per epoch; the census after each. */
async function appliedHistory(retention: boolean): Promise<Census[]> {
	mode = "apply";
	const fixture = await settlementRoom({ retention, name: "applied" });
	const peers = [await fixture.open(0), await fixture.open(1)] as const;
	const delivered: (number | null)[] = [null, null];
	const census: Census[] = [];
	const read = async (peer: number) => {
		const dump = await dumpDatabase(fixture.database(peer));
		const keys = new Set(ISSUANCE_ROWS.flatMap((store) => (dump[store] ?? []).map(([key]) => rowId(store, key))));
		const counts = Object.fromEntries(
			Object.entries(dump)
				.filter(([store]) => OWNED.test(`${store} `))
				.map(([store, rows]) => [store, rows.length])
		);
		return { keys, counts };
	};
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await settlementTransition(fixture, peers, delivered, epoch);
		await peers[0].room.maintainRecoveryPool();
		await peers[1].room.maintainRecoveryPool();
		const [creator, recipient] = [await read(0), await read(1)];
		census.push({
			epoch: epoch + 1,
			issuance: [creator.keys, recipient.keys],
			counts: [creator.counts, recipient.counts],
		});
	}
	await fixture.stop(peers[1]);
	await fixture.stop(peers[0]);
	return census;
}

it(`settlement room: the retention path never retires an issuance row the existing path keeps, and the recipient stays flat`, async () => {
	const existing = await appliedHistory(false);
	const before = passes.length;
	const retained = await appliedHistory(true);
	const applied = passes.slice(before).filter((event) => event.outcome === "applied");
	expect(applied.length, "retention passes applied").toBeGreaterThanOrEqual(8);
	const rows: unknown[] = [];
	for (const [position, census] of retained.entries()) {
		const base = required(existing[position]);
		expect(census.epoch).toBe(base.epoch);
		for (const peer of [0, 1] as const) {
			const missing = [...required(base.issuance[peer])].filter((key) => !census.issuance[peer].has(key));
			expect(missing, `peer ${peer} epoch ${census.epoch}: issuance rows only the existing path keeps`).toEqual([]);
			rows.push({
				epoch: census.epoch,
				peer,
				existing: base.issuance[peer].size,
				retention: census.issuance[peer].size,
				counts: { existing: base.counts[peer], retention: census.counts[peer] },
			});
		}
	}
	if (process.env.TRACK_M_VERBOSE === "1")
		for (const row of rows) process.stdout.write(`TRACK_M_SETTLEMENT_CENSUS ${JSON.stringify(row)}\n`);
	// Track N's bound on the recipient, on the retention path: flat from the steady epoch.
	const steady = retained.filter((census) => census.epoch >= STEADY_EPOCH);
	expect(steady.length).toBeGreaterThanOrEqual(4);
	const first = required(steady[0]);
	for (const census of steady)
		expect(census.issuance[1].size, `recipient issuance rows at epoch ${census.epoch}`).toBe(first.issuance[1].size);
}, 3_600_000);
