import { decodeCanonical } from "@ts-drp/canonical";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	closeFixtures,
	dumpDatabase,
	installEnvironment,
	lullFixture,
	type LullFixture,
	type OpenedRoom,
	required,
	transition,
} from "./fixtures/track-m/room-retention-fixture.js";

// Track M, slice 14b RED 5 (differential safety). On a long room (creator and recipient,
// at least 16 epochs, and seeded random histories), at every lull the rows the retention
// decisions would delete are a subset of the rows the EXISTING planner deletes for the
// same pre-state within the same lull. The retention path runs as a plan-only probe
// beside the existing boundary's first pass: it plans from the SAME acquisition, plans
// its first decision's exact rows in a discarded room transaction, and writes nothing;
// the existing passes then run unchanged. The issuance holes the decisions would commit
// must equal the existing planner's. Rows the existing planner deletes that the
// decisions do not are reported (a retention gap retains more; it is never unsafe).

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
// Stores whose rows only the five retirement owners delete.
const OWNED = /^(ahe:|journal:|snapshot:|issuance:|(sealEvidence|signerState|voteSlots|voteOutbox) )/;

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
	const selections = event.selections as readonly Selection[];
	for (const selection of selections) {
		for (const { scope } of selection.snapshot.retire)
			for (const [key, value] of pre["snapshot:scopes"] ?? []) {
				const row = value as Record<string, unknown>;
				if (!["objectId", "epoch", "anchor", "manifestDigest"].every((field) => row[field] === scope[field])) continue;
				out.add(rowId("snapshot:scopes", key));
				// A retired scope's chunks go with it (the existing turnover's own effect).
				const prefix = stable(key).slice(0, -1);
				for (const [chunk] of pre["snapshot:chunks"] ?? [])
					if (stable(chunk).startsWith(`${prefix},`)) out.add(rowId("snapshot:chunks", chunk));
			}
		for (const entry of selection.signing.summaries) out.add(rowId(entry.store, entry.key));
		// An AHE unit retires its generation rows, their promotions, and the blobs no
		// surviving promotion references (the existing reclamation's own effects).
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

// A seeded history: paints per epoch, skipped lulls (never twice in a row), lull order,
// and one persisted reopen of both peers.
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

const plans: Event[] = [];
const declines: Event[] = [];
let armed = false;
let restore: (() => void) | undefined;
beforeEach(() => {
	plans.length = 0;
	declines.length = 0;
	restore = installEnvironment((event) => {
		if (event.kind === "room-retention-plan-only") plans.push(event);
		if (event.kind === "room-retention-declined") declines.push(event);
	});
	// The probe plans beside the FIRST pass of each lull; every other pass, and every
	// seal-inline or install maintenance, is the existing path alone.
	Reflect.set(globalThis, "__roomRetentionMode", () => {
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

async function lull(
	fixture: LullFixture,
	room: OpenedRoom,
	who: "creator" | "recipient",
	epoch: number,
	reports: LullReport[]
): Promise<void> {
	const database = fixture.host.database(who === "creator" ? "creator" : "observer");
	const pre = await dumpDatabase(database);
	const before = plans.length;
	armed = true;
	await room.room.maintainRecoveryPool();
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
	const selections = event.selections as readonly Selection[];
	const holes = selections[0]?.issuance.protectedRecords;
	reports.push({
		epoch,
		who,
		planned: true,
		predicted: named.size,
		deleted: deleted.size,
		unsafe: [...named].filter((id) => !deleted.has(id)),
		gap: [...deleted].filter((id) => !named.has(id)),
		holes: stable(holes) === stable(issuanceHoles(post)) ? "equal" : "differ",
		...(stable(holes) === stable(issuanceHoles(post))
			? {}
			: { holeDetail: { planned: holes, existing: issuanceHoles(post) } }),
	});
}

async function history(seed: number, epochs: number): Promise<LullReport[]> {
	const next = random(seed);
	const fixture = await lullFixture({ retention: true, creatorLull: true, seed: `track-m-diff-${seed}` });
	let creator = await fixture.open("creator", fixture.creator);
	let recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	const reports: LullReport[] = [];
	const reopenAt = seed === 0 ? -1 : 6 + Math.floor(next() * 6);
	let skipped = { creator: false, recipient: false };
	for (let epoch = 0; epoch < epochs; epoch++) {
		await transition(fixture, creator, recipient, epoch);
		const order =
			seed !== 0 && next() < 0.3 ? (["recipient", "creator"] as const) : (["creator", "recipient"] as const);
		for (const who of order) {
			const skip = seed !== 0 && epoch >= 4 && !skipped[who] && next() < 0.2;
			skipped = { ...skipped, [who]: skip };
			if (skip) continue;
			await lull(fixture, who === "creator" ? creator : recipient, who, epoch + 1, reports);
		}
		if (epoch + 1 === reopenAt) {
			await fixture.stop(recipient);
			await fixture.stop(creator);
			creator = await fixture.open("creator", fixture.creator, { reopen: true });
			recipient = await fixture.open("observer", fixture.observer, { reopen: true, receiveOnly: true });
		}
	}
	return reports;
}

function verdict(label: string, reports: readonly LullReport[]): void {
	if (process.env.TRACK_M_VERBOSE === "1")
		for (const report of reports) process.stdout.write(`TRACK_M_DIFFERENTIAL ${label} ${JSON.stringify(report)}\n`);
	for (const report of reports) {
		const at = `${label} ${report.who} lull at epoch ${report.epoch}`;
		// Safety: the retention decisions never delete a row the existing planner keeps.
		expect(report.unsafe, at).toEqual([]);
		if (report.planned) expect(report.holes, `${at}: issuance holes`).toBe("equal");
	}
	// The probe ran on both peers once their pools were in steady turnover.
	for (const who of ["creator", "recipient"] as const)
		expect(
			reports.filter((report) => report.who === who && report.planned && report.predicted > 0).length,
			`${label} ${who} planned lulls`
		).toBeGreaterThanOrEqual(4);
}

const EPOCHS = Number(process.env.TRACK_M_DIFFERENTIAL_EPOCHS ?? 16);

it(`retention decisions delete a subset of the existing planner's rows at every lull of a ${EPOCHS}-epoch room`, async () => {
	expect(EPOCHS).toBeGreaterThanOrEqual(16);
	verdict("seed-0", await history(0, EPOCHS));
}, 3_600_000);

const SEEDS = (process.env.TRACK_M_DIFFERENTIAL_SEEDS ?? "1,2")
	.split(",")
	.map((value) => Number(value))
	.filter((value) => Number.isSafeInteger(value) && value > 0);

it.each(SEEDS)(
	"retention decisions delete a subset of the existing planner's rows on seeded random history %i",
	async (seed) => {
		verdict(`seed-${seed}`, await history(required(seed), EPOCHS));
	},
	3_600_000
);
