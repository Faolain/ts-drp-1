import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { countDifferences, differences, type DigestDump, fate, stateOf, type Write } from "./assess.js";
import {
	type AssetServer,
	type ChildRun,
	type Engine,
	type Message,
	one,
	resultOf,
	runChild,
	startAssetServer,
} from "./harness.js";

// Track M, slice 14f (specs/bounded-storage-lifecycle/slices/14f-retention-native-evidence.md):
// native evidence for the single retention transaction of slices 14b/14e on the opt-in
// room-database host, in Chromium, Firefox and WebKit. The browser worker runs the SAME
// product modules as tests/fixtures/track-m/room-retention-fixture.ts (bundled from the
// working tree) on native IndexedDB, with the browser host floor.
//
// - case 2: the real retention transaction aborted after its last request leaves every
//   store of the room database unchanged, and the room continues;
// - case 3: a foreign strict writer on another thread is ordered after step B commits,
//   and every owner's ordinary writer then refuses the retired range with its existing code;
// - cases 5-8: SIGKILL inside step A, between A and B, inside B and after B: per database
//   old XOR exact new, the floor fence leads and never lags, and replay converges to the
//   crash-free reference;
// - case 11 (TRACK_M_14F_LONG=1, Chromium): the long-room bounds.

type Json = Readonly<Record<string, unknown>>;
const STEADY = Number(process.env.TRACK_M_14F_STEADY ?? 5);
const EVIDENCE = process.env.TRACK_M_14F_EVIDENCE ?? "";
const ASSETS = process.env.TRACK_M_14F_ASSET_DIR ?? "";
const SOURCE = JSON.parse(process.env.TRACK_M_14F_SOURCE ?? "{}") as Json;
const CHILD_TIMEOUT = Number(process.env.TRACK_M_14F_CHILD_TIMEOUT ?? 1_500_000);
// Boundaries after a recovery's reopen, each compared with the crash-free reference's.
const RECOVERY_ROLLOVERS = Number(process.env.TRACK_M_14F_RECOVERY_ROLLOVERS ?? 2);
const childAsset = (): string => path.join(ASSETS, "tm14f-child.mjs");

// Two loopback origins: the creator's room and the recipient's room each run in their own
// origin, as in the product browser tests (one live owner per object per origin).
let server: AssetServer;
let peer: AssetServer;
test.beforeAll(async () => {
	if (EVIDENCE === "" || ASSETS === "") throw new Error("TRACK_M_14F_GLOBAL_SETUP_MISSING");
	mkdirSync(path.join(EVIDENCE, "logs"), { recursive: true });
	mkdirSync(path.join(EVIDENCE, "profiles"), { recursive: true });
	server = await startAssetServer(ASSETS);
	peer = await startAssetServer(ASSETS);
});
test.afterAll(async () => {
	await server?.close();
	await peer?.close();
});

const peerUrl = (names: { prefix: string; seed: string }): string =>
	peer.url({ mode: "recipient", prefix: names.prefix, seed: names.seed });

function caseNames(engine: Engine, name: string) {
	const id = `${engine}-${name}-${randomUUID().slice(0, 8)}`;
	return { id, prefix: `tm14f-${id}`, seed: `track-m-14f-${name}`, log: path.join(EVIDENCE, "logs", `${id}.jsonl`) };
}

function evidence(engine: Engine, version: string, name: string, data: Json): void {
	const file = path.join(EVIDENCE, `${engine}-${name}.json`);
	writeFileSync(file, JSON.stringify({ engine, version, source: SOURCE, case: name, ...data }, null, 1));
	test.info().annotations.push({ type: "evidence", description: file });
}

async function run(engine: Engine, name: string, input: Json): Promise<{ run: ChildRun; result: Json; log: string }> {
	const names = caseNames(engine, name);
	const child = await runChild({
		childAsset: childAsset(),
		browserName: engine,
		mode: "run",
		url: server.url({ ...names, steady: STEADY, ...input }),
		peerUrl: peerUrl(names),
		log: names.log,
		timeoutMs: CHILD_TIMEOUT,
	});
	return { run: child, result: resultOf(child), log: names.log };
}

const pass = (event: unknown): Json => event as Json;
const outcomes = (value: unknown): unknown[] => (value as Json[]).map((event) => pass(event).outcome);

test("smoke: steady retention lulls apply on native IndexedDB", async ({ browserName, browser }) => {
	const engine = browserName as Engine;
	const { run: child, result, log } = await run(engine, "smoke", { mode: "smoke" });
	evidence(engine, browser.version(), "smoke", { ms: child.ms, log, result });
	expect(outcomes(result.passes)).toEqual(["applied", "applied"]);
	expect(result.creatorLull).toMatchObject({ kind: "maintained" });
	expect(result.recipientLull).toMatchObject({ kind: "maintained" });
});

for (const variant of ["refusal", "native-abort"] as const)
	test(`case 2 (${variant}): the retention transaction aborted after its last request leaves every store unchanged`, async ({
		browserName,
		browser,
	}) => {
		const engine = browserName as Engine;
		const { run: child, result, log } = await run(engine, `case2-${variant}`, { mode: "case2", variant });
		const pre = result.pre as { dump: DigestDump };
		const afterAbort = result.afterAbort as { dump: DigestDump } | null;
		const diff =
			afterAbort === null ? ["no afterAbort dump"] : differences(stateOf(pre.dump), stateOf(afterAbort.dump));
		const writes = result.sessionWrites as { op: string; store: string }[];
		const deletedStores = [...new Set(writes.filter((write) => write.op === "delete").map((write) => write.store))];
		const putStores = [...new Set(writes.filter((write) => write.op === "put").map((write) => write.store))];
		evidence(engine, browser.version(), `case2-${variant}`, {
			ms: child.ms,
			log,
			assertion: { allStoresUnchanged: diff, deletedStores, putStores },
			result: { ...result, pre: undefined, afterAbort: undefined, preFloor: undefined, afterAbortFloor: undefined },
		});
		expect(result.fired).toBe(true);
		expect(result.durability).toBe("strict");
		const stores = result.storesInTransaction as string[];
		for (const prefix of ["ahe:", "snapshot:", "journal:", "issuance:"])
			expect(
				stores.some((store) => store.startsWith(prefix)),
				prefix
			).toBe(true);
		expect(stores).toContain("sealEvidence");
		// The aborted transaction had issued deletes and control (mark) puts across owners.
		expect(writes.filter((write) => write.op === "delete").length).toBeGreaterThan(0);
		expect(putStores).toEqual(
			expect.arrayContaining([
				"ahe:storageMeta",
				"storageMeta",
				"journal:retirementControls",
				"snapshot:retirementControls",
				"issuance:retirementControls",
			])
		);
		// Every store of the room database (owned or not) is byte-identical to the pre-state.
		expect(diff).toEqual([]);
		// The trapped pass is retained (refusal) or failed (native abort), never applied.
		const lullEvents = result.lullEvents as Json[];
		const first = lullEvents.find((event) => event.kind === "room-retention-pass") as Json;
		expect(first.outcome).toBe(variant === "refusal" ? "retained" : "failed");
		if (variant === "refusal") {
			// The same lull continues: its next pass falls back to the existing path (declined
			// with the refusal's reason), then retention applies again; the lull completes.
			const after = lullEvents.slice(lullEvents.indexOf(first) + 1);
			expect(after[0]).toMatchObject({ kind: "room-retention-declined", reason: first.reason });
			expect(outcomes(after.filter((event) => event.kind === "room-retention-pass"))).toEqual(["applied"]);
			expect(result.lull).toMatchObject({ kind: "maintained" });
			expect(result.again).not.toHaveProperty("threw");
		} else {
			// The failure is rethrown; the room continues from the same databases after a reopen,
			// and the same boundary's lull on the reopened room completes without a failed pass.
			expect(result.lull).toHaveProperty("threw");
			expect(result.reopened).toMatchObject({ ok: true });
			expect((result.reopened as Json).lull).not.toHaveProperty("threw");
			expect(outcomes((result.reopened as Json).passes)).not.toContain("failed");
		}
		// The next boundary applies on both rooms.
		const next = outcomes(result.nextPasses);
		expect(next.length).toBeGreaterThanOrEqual(2);
		expect(new Set(next)).toEqual(new Set(["applied"]));
	});

const summary = (writes: Json) =>
	Object.fromEntries(
		Object.entries(writes).map(([owner, value]) => {
			const record = value as Json | undefined;
			return [
				owner,
				record === undefined
					? undefined
					: "threw" in record
						? { threw: record.threw }
						: { ok: record.ok, reason: record.reason ?? record.kind ?? record.code },
			];
		})
	);

test("case 3: a foreign strict writer is ordered after step B, then stale owner writers refuse", async ({
	browserName,
	browser,
}) => {
	const engine = browserName as Engine;
	const retention = await run(engine, "case3", { mode: "case3" });
	const existing = await run(engine, "case3-existing", { mode: "case3", variant: "existing" });
	const result = retention.result;
	const sequence = Object.fromEntries(
		(result.sequence as { what: string; at: number }[]).map((entry) => [entry.what, entry.at])
	);
	const foreign = result.foreign as Json;
	const control = result.journalControl as Json;
	evidence(engine, browser.version(), "case3", {
		ms: retention.run.ms + existing.run.ms,
		logs: [retention.log, existing.log],
		assertion: {
			sequence,
			foreign,
			control,
			stale: summary(result.stale as Json),
			existingStale: summary(existing.result.stale as Json),
		},
		result,
		existing: existing.result,
	});
	expect(outcomes(result.lullPasses)).toEqual(["applied"]);
	expect(foreign).toMatchObject({ ok: true });
	// Requested and issued while step B held the room, before its writes.
	expect(sequence["foreign-requested"]).toBeLessThan(Number(foreign.issuedAt));
	expect(Number(foreign.issuedAt)).toBeLessThan(sequence["step-b-applied"]!);
	expect(sequence["step-b-applied"]).toBeLessThan(sequence["checkpoint-0-committed"]!);
	// It could not interleave: it completed after step B, and its read saw exactly the
	// control the first continuation committed (not the pre-state, not a later one).
	expect(Number(foreign.completedAt)).toBeGreaterThan(sequence["step-b-applied"]!);
	expect(control.afterFirstContinuation).not.toBeNull();
	expect(foreign.readDigest).not.toBe(control.before);
	expect(foreign.readDigest).toBe(control.afterFirstContinuation);
	// After the commit every owner's ordinary writer for the retired range refuses, with the
	// same codes as after the existing path's retirement, and changes nothing.
	const stale = summary(result.stale as Json);
	for (const owner of ["signing", "journalAppend", "snapshot", "ahe"]) expect(owner in stale, owner).toBe(true);
	for (const value of Object.values(stale)) expect((value as Json).ok === true).toBe(false);
	expect(result.storesChangedByStaleWriters).toEqual([]);
	expect(stale).toEqual(summary(existing.result.stale as Json));
});

// ---------------------------------------------------------------------------------
// Process-death cases 5-8.
// ---------------------------------------------------------------------------------
type Edge = "inside-a" | "between-a-b" | "inside-b" | "after-b";
const EDGES: readonly (readonly [string, Edge])[] = [
	["5", "inside-a"],
	["6", "between-a-b"],
	["7", "inside-b"],
	["8", "after-b"],
];
const EXPECTED: Readonly<Record<Edge, { room: string; floor: string }>> = {
	"inside-a": { room: "old", floor: "old" },
	"between-a-b": { room: "old", floor: "new" },
	"inside-b": { room: "old", floor: "new" },
	"after-b": { room: "new", floor: "new" },
};
const references = new Map<Engine, Json>();

interface Observed {
	readonly dump: DigestDump | null;
	readonly counts: Readonly<Record<string, number>>;
	readonly floor?: Json | null;
	readonly controls?: Readonly<Record<string, { labels: Json | null } | null>>;
}
type ObservedAll = Readonly<Record<"room" | "floor" | "observerRoom" | "observerFloor", Observed>>;

async function deathRun(engine: Engine, name: string, edge: Edge | "none") {
	const names = caseNames(engine, name);
	const profile = mkdtempSync(path.join(EVIDENCE, "profiles", `${names.id}-`));
	const mutate = await runChild({
		childAsset: childAsset(),
		browserName: engine,
		mode: "mutate",
		profile,
		edge,
		url: server.url({ mode: "mutate", prefix: names.prefix, seed: names.seed, steady: STEADY, edge, continuation: 0 }),
		peerUrl: peerUrl(names),
		log: names.log,
		timeoutMs: CHILD_TIMEOUT,
	});
	const errors = mutate.messages.filter((message) => message.kind === "worker-error" || message.kind === "page-error");
	if (errors.length !== 0) throw new Error(`TRACK_M_14F_MUTATE_ERROR ${JSON.stringify(errors).slice(0, 6000)}`);
	const recovery = await runChild({
		childAsset: childAsset(),
		browserName: engine,
		mode: "recover",
		profile,
		url: server.url({
			mode: "recover",
			prefix: names.prefix,
			seed: names.seed,
			steady: STEADY,
			rollovers: RECOVERY_ROLLOVERS,
		}),
		peerUrl: peerUrl(names),
		log: names.log,
		timeoutMs: CHILD_TIMEOUT,
	});
	return { names, profile, mutate, recovery, recoveryResult: resultOf(recovery) };
}

test("death reference: the crash-free boundary and its reopen", async ({ browserName, browser }) => {
	const engine = browserName as Engine;
	const { names, profile, mutate, recovery, recoveryResult } = await deathRun(engine, "death-reference", "none");
	const reference = resultOf(mutate);
	evidence(engine, browser.version(), "death-reference", {
		ms: mutate.ms + recovery.ms,
		log: names.log,
		profile,
		mutate: { code: mutate.code, signal: mutate.signal, passes: reference.lullPasses, lull: reference.lull },
		recovery: recoveryResult,
	});
	expect(mutate.code).toBe(0);
	expect(outcomes(reference.lullPasses)).toEqual(["applied"]);
	expect(recoveryResult.rollover).toMatchObject({ ok: true });
	references.set(engine, recoveryResult);
});

for (const [number, edge] of EDGES)
	test(`case ${number}: SIGKILL ${edge} is old XOR exact new, the fence never lags, and replay converges`, async ({
		browserName,
		browser,
	}) => {
		const engine = browserName as Engine;
		const referenceFile = path.join(EVIDENCE, `${engine}-death-reference.json`);
		const reference =
			references.get(engine) ??
			(existsSync(referenceFile)
				? ((JSON.parse(readFileSync(referenceFile, "utf8")) as { recovery: Json }).recovery as Json)
				: undefined);
		const { names, profile, mutate, recovery, recoveryResult } = await deathRun(engine, `death-${edge}`, edge);
		const messages = mutate.messages;
		const checkpoint = one(messages, "checkpoint") as Message & { writes: Write[]; deletesIssued?: number };
		const pre = (one(messages, "pre") as { observed: ObservedAll }).observed;
		const plan = (messages.find((message) => message.kind === "plan" && message.index === 0) as { plan: Json }).plan;
		const recovered = (one(recovery.messages, "recovered") as { observed: ObservedAll }).observed;
		const k = 0;
		const writes = checkpoint.writes;
		const roomName = pre.room.dump!.database;
		const floorName = pre.floor.dump!.database;
		const nonSession = writes.filter((write) => write.database === roomName && !write.session);
		const room = fate(
			pre.room.dump!,
			recovered.room.dump!,
			writes.filter(
				(write) => write.database === roomName && write.session && write.continuation < k && write.committed
			),
			writes.filter((write) => write.database === roomName && write.session && write.continuation === k)
		);
		const floor = fate(
			pre.floor.dump!,
			recovered.floor.dump!,
			writes.filter((write) => write.database === floorName && write.continuation < k && write.committed),
			writes.filter((write) => write.database === floorName && write.continuation === k)
		);
		const observerRoom = fate(pre.observerRoom.dump!, recovered.observerRoom.dump!, [], []);
		const observerFloor = fate(pre.observerFloor.dump!, recovered.observerFloor.dump!, [], []);
		// The step's writes against the decision it planned.
		const owners = plan.owners as Record<
			string,
			{ delete: { store: string; key: string }[]; rewrite: { store: string; key: string }[] }
		>;
		const named = new Set(
			Object.values(owners).flatMap((section) => section.delete.map((row) => `${row.store} ${row.key}`))
		);
		const rewrites = new Set(
			Object.values(owners).flatMap((section) => section.rewrite.map((row) => `${row.store} ${row.key}`))
		);
		const target = writes.filter((write) => write.database === roomName && write.session && write.continuation === k);
		const deleted = new Set(
			target.filter((write) => write.op === "delete").map((write) => `${write.store} ${write.key}`)
		);
		const CONTROL_STORES = new Set([
			"ahe:storageMeta",
			"storageMeta",
			"journal:retirementControls",
			"snapshot:retirementControls",
			"issuance:retirementControls",
		]);
		const decisionCheck = {
			named: named.size,
			deleted: deleted.size,
			deletedNotNamed: [...deleted].filter((row) => !named.has(row)),
			namedNotDeleted: [...named].filter((row) => !deleted.has(row)),
			putsOutsideRewritesAndControls: target
				.filter((write) => write.op !== "delete")
				.map((write) => `${write.store} ${write.key}`)
				.filter((row) => !rewrites.has(row) && !CONTROL_STORES.has(row.split(" ")[0]!)),
			namedRowsExactInPreState: { verified: plan.verified, named: plan.named, unverified: plan.unverified },
		};
		// S3 (14c): the floor fence may lead a committed retirement, never lag it.
		const labels = plan.labels as { decisionDigest: string; throughEpoch: number; sourceProofDigest: string };
		const preControl = (pre.floor.floor as { control: Json }).control;
		const floorControl = (recovered.floor.floor as { control: Json }).control;
		const completed = floorControl.completed as { decisionDigest?: string; throughEpoch?: number } | null;
		const ownerLabels = Object.fromEntries(
			Object.entries(recovered.room.controls ?? {}).map(([owner, value]) => [owner, value?.labels ?? null])
		) as Record<string, { decisionDigest?: string; throughEpoch?: number } | null>;
		const preOwnerLabels = Object.fromEntries(
			Object.entries(pre.room.controls ?? {}).map(([owner, value]) => [owner, value?.labels ?? null])
		) as Record<string, { decisionDigest?: string; throughEpoch?: number } | null>;
		const s3 = {
			floorCompleted: completed,
			planLabels: labels,
			ownerLabels,
			preFloorCompleted: preControl.completed,
			preOwnerLabels,
			lagging: Object.entries(ownerLabels)
				.filter(
					([, owner]) =>
						owner?.decisionDigest === labels.decisionDigest && completed?.decisionDigest !== labels.decisionDigest
				)
				.map(([owner]) => owner),
			throughAhead: Object.entries(ownerLabels)
				.filter(([, owner]) => Number(owner?.throughEpoch ?? -1) > Number(completed?.throughEpoch ?? -1))
				.map(([owner]) => owner),
			floorShape:
				floor.fate === "new"
					? {
							active: floorControl.active,
							revisionDelta: Number(floorControl.revision) - Number(preControl.revision),
							completedIsPlan:
								completed?.decisionDigest === labels.decisionDigest && completed?.throughEpoch === labels.throughEpoch,
						}
					: { equalsPre: JSON.stringify(floorControl) === JSON.stringify(preControl) },
		};
		// Per-store row counts against the crash-free reference at the same epoch, after the
		// first boundary following the reopen (`convergence`) and after each one (`byRollover`).
		const differ = (left: Json | undefined, right: Json | undefined): Json =>
			left === undefined || right === undefined
				? { missing: { reference: left === undefined, recovery: right === undefined } }
				: Object.fromEntries(
						(["room", "observerRoom", "floor"] as const).map((database) => [
							database,
							countDifferences(
								(left[database] ?? {}) as Record<string, number>,
								(right[database] ?? {}) as Record<string, number>
							),
						])
					);
		const referenceRollovers = (reference?.byRollover ?? []) as { epoch: number; counts: Json }[];
		const recoveryRollovers = (recoveryResult.byRollover ?? []) as { epoch: number; counts: Json }[];
		const byRollover = recoveryRollovers.map((row, index) => ({
			epoch: row.epoch,
			referenceEpoch: referenceRollovers[index]?.epoch ?? null,
			differences: differ(referenceRollovers[index]?.counts, row.counts),
		}));
		const convergence =
			reference === undefined ? { reference: "missing" } : (byRollover[0]?.differences ?? { recovery: "missing" });
		evidence(engine, browser.version(), `death-${edge}`, {
			ms: mutate.ms + recovery.ms,
			log: names.log,
			profile,
			kill: mutate.kill,
			signal: mutate.signal,
			checkpoint: {
				edge: checkpoint.edge,
				at: checkpoint.at,
				deletesIssued: checkpoint.deletesIssued,
				writes: writes.length,
			},
			assertion: {
				room: { fate: room.fate, oldDiff: room.old, newDiff: room.new },
				floor: { fate: floor.fate, oldDiff: floor.old, newDiff: floor.new },
				observerRoom: observerRoom.fate,
				observerFloor: observerFloor.fate,
				nonSessionRoomWrites: nonSession.length,
				decisionCheck,
				s3,
				convergence,
				convergenceByRollover: byRollover,
			},
			recovery: recoveryResult,
			plan: { ...plan, owners: undefined },
		});
		// The kill: the child died by SIGKILL and every killed process is gone.
		expect(checkpoint.edge).toBe(edge);
		expect(mutate.signal).toBe("SIGKILL");
		expect(mutate.kill?.survivors).toEqual([]);
		expect(mutate.kill?.browserGroups.length).toBeGreaterThan(0);
		expect(nonSession).toEqual([]);
		// Old XOR exact new, per database; the other room is untouched.
		expect(room.fate).toBe(EXPECTED[edge].room);
		expect(floor.fate).toBe(EXPECTED[edge].floor);
		expect(observerRoom.fate).toBe("old");
		expect(observerFloor.fate).toBe("old");
		// The step's writes are exactly the decision's (complete at after-b, a prefix inside B).
		expect(decisionCheck.deletedNotNamed).toEqual([]);
		expect(decisionCheck.putsOutsideRewritesAndControls).toEqual([]);
		if (edge === "after-b") expect(decisionCheck.namedNotDeleted).toEqual([]);
		// The floor fence never lags the room database.
		expect(s3.lagging).toEqual([]);
		expect(s3.throughAhead).toEqual([]);
		if (floor.fate === "new") expect(s3.floorShape).toEqual({ active: null, revisionDelta: 2, completedIsPlan: true });
		// Replay: both rooms reopen, admit, seal, adopt, install and run both lulls.
		expect(recoveryResult.reopen).toEqual({ ok: true });
		expect(recoveryResult.rollover).toMatchObject({ ok: true });
		expect(outcomes(recoveryResult.passes)).not.toContain("failed");
		// Converges to the crash-free reference's row counts at the same epoch.
		expect.soft(convergence).toEqual({ room: {}, observerRoom: {}, floor: {} });
		expect(byRollover.length).toBe(RECOVERY_ROLLOVERS);
		for (const row of byRollover.slice(1))
			expect.soft(row.differences, `after ${row.epoch}`).toEqual({ room: {}, observerRoom: {}, floor: {} });
	});

// ---------------------------------------------------------------------------------
// Case 11 (optional): the long room on the retention path (14b acceptance 6).
// ---------------------------------------------------------------------------------
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
const STEADY_EPOCH = 8;
interface Census {
	readonly epoch: number;
	readonly journalThrough: number | null;
	readonly journalProtected: readonly number[] | null;
	readonly journalEpochs: readonly number[];
	readonly counts: Readonly<Record<string, number>>;
}

test("case 11: a long room keeps the steady-state bounds", async ({ browserName, browser }) => {
	test.skip(process.env.TRACK_M_14F_LONG !== "1", "opt-in: TRACK_M_14F_LONG=1");
	test.skip(browserName !== "chromium", "case 11 is a Chromium case");
	const engine = browserName as Engine;
	const epochs = Number(process.env.TRACK_M_14F_LONG_EPOCHS ?? 16);
	const { run: child, result, log } = await run(engine, "long", { mode: "long", epochs });
	const installed = result.installed as { creator: Census; recipient: Census }[];
	const lulled = result.lulled as { lulls: string[]; creator: Census; recipient: Census }[];
	const findings: string[] = [];
	for (const who of ["creator", "recipient"] as const) {
		const inst = installed.map((row) => row[who]).filter((row) => row.epoch >= STEADY_EPOCH);
		for (const row of inst) {
			if (row.journalThrough !== row.epoch - 2)
				findings.push(`${who} installed ${row.epoch}: through ${row.journalThrough}`);
			if ((row.journalProtected ?? []).length > 2)
				findings.push(`${who} installed ${row.epoch}: protected ${row.journalProtected}`);
			if (!(row.journalProtected ?? []).every((epoch) => epoch >= row.epoch - 3))
				findings.push(`${who} installed ${row.epoch}: protected ${row.journalProtected}`);
			if (!row.journalEpochs.filter((epoch) => epoch !== 0).every((epoch) => epoch > row.epoch - STEADY_EPOCH))
				findings.push(`${who} installed ${row.epoch}: headers ${row.journalEpochs}`);
		}
		const after = lulled.map((row) => row[who]).filter((row) => row.epoch >= STEADY_EPOCH);
		const first = after[0]!;
		for (const row of after) {
			if (row.journalThrough !== Number(first.journalThrough) + row.epoch - first.epoch)
				findings.push(`${who} lulled ${row.epoch}: through ${row.journalThrough}`);
			for (const store of COUNTED)
				if ((row.counts[store] ?? 0) !== (first.counts[store] ?? 0))
					findings.push(`${who} lulled ${row.epoch}: ${store} ${row.counts[store]} vs ${first.counts[store]}`);
		}
	}
	evidence(engine, browser.version(), "long", { ms: child.ms, log, findings, result });
	expect(installed.length).toBe(epochs);
	expect((result.passes as unknown[]).length).toBeGreaterThanOrEqual(2 * (epochs - 4));
	expect((result.passes as unknown[]).filter((outcome) => outcome !== "applied")).toEqual([]);
	expect(findings).toEqual([]);
});
