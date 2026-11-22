import "fake-indexeddb/auto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableIssuanceStore, DurableIssueCommit } from "@ts-drp/issuance-store";
import {
	closeIssuanceRetirementProtectedRecords,
	durableIssuancePruningMaintenanceForStore,
	encodeIssuanceRetirementControl,
	ISSUANCE_RETIREMENT_LIMITS,
	issuanceRetirementPreparationWithPlanRewrite,
	reconstructIssuanceRetirementSourceRows,
	type DurableIssuanceRetirementControl,
	type DurableIssuanceRetirementPreparation,
	type IssuanceRetirementRows,
} from "@ts-drp/issuance-store/maintenance";
import { createNodeDurableIssuanceStore } from "../src/issuance.js";
import { createBrowserDurableIssuanceStore } from "../../storage-browser/src/issuance.js";
import { d109bIssue, d109bPruningInput } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

// Control-2 lazy upgrade (fix/maintenance-image-capacity, rule A + H). A store written by the
// previous format (native schema 5; browser stores keep their layout) reopens under this code
// with every legacy control intact: an idle object, a completed control-1 retirement, and an
// active control-1 preparation, which commits or aborts in its own legacy form. Only the next
// preparation this code writes is floored and moves the control to control-2 with its side row.

const DATABASE_SUFFIX = ".drp-issuance-v1.sqlite";
const scope = {objectId: "legacy-reopen-room", author: "writer"};
const directories: string[] = [];
const stores: DurableIssuanceStore[] = [];
afterEach(async () => {
	await Promise.all(stores.splice(0).map(store => store.close()));
	await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

type Backend = "sqlite" | "indexeddb";
async function location(backend: Backend) {
	const directory = await mkdtemp(join(tmpdir(), "issuance-legacy-reopen-")); directories.push(directory);
	const primaryFilename = join(directory, "primary.sqlite"), primaryDatabaseName = `legacy-reopen-${crypto.randomUUID()}`;
	const open = async (): Promise<DurableIssuanceStore> => {
		const store = backend === "sqlite" ? createNodeDurableIssuanceStore({primaryFilename}) :
			await createBrowserDurableIssuanceStore({primaryDatabaseName});
		stores.push(store);
		return store;
	};
	const close = async (store: DurableIssuanceStore) => {stores.splice(stores.indexOf(store), 1); await store.close();};
	/** Returns the closed store to the previous format: native schema 5 has no side-row table. */
	const toPreviousFormat = () => {
		if (backend !== "sqlite") return;
		const database = new DatabaseSync(`${primaryFilename}${DATABASE_SUFFIX}`);
		try {
			expect(database.prepare("SELECT count(*) AS n FROM retirement_plan_before").get()).toEqual({n: 0});
			database.exec("DROP TABLE retirement_plan_before");
			database.exec("PRAGMA user_version=5");
		} finally {database.close();}
	};
	const nativeSchema = () => {
		const database = new DatabaseSync(`${primaryFilename}${DATABASE_SUFFIX}`, {readOnly: true});
		try {
			return {version: (database.prepare("PRAGMA user_version").get() as {user_version: number}).user_version,
				sideTable: database.prepare("SELECT name FROM sqlite_schema WHERE name = 'retirement_plan_before'").get() !== undefined};
		} finally {database.close();}
	};
	const setNativeVersion = (version: number) => {
		const database = new DatabaseSync(`${primaryFilename}${DATABASE_SUFFIX}`);
		try {database.exec(`PRAGMA user_version=${version}`);} finally {database.close();}
	};
	return {open, close, toPreviousFormat, nativeSchema, setNativeVersion};
}

/** Rows 0..4 with completed rebase entries 0 -> 1, 1 -> 2, 2 -> 3, fence 4; the prefix pruner removed row 0. */
async function seed(store: DurableIssuanceStore) {
	const commits: DurableIssueCommit[] = [];
	for (let epoch = 0; epoch < 5; epoch++) commits.push(await d109bIssue(store, scope, epoch));
	const contextBytes = encodeCanonical({historicalSource: "legacy-reopen-fixture"});
	const context = {digest: hashDomain("ts-drp/settlement-source-context/v1", contextBytes), exactCanonicalContextBytes: contextBytes};
	await store.transactWriteSettlementPlan({scope, expectedRevision: null, plan: {scope, revision: 0, fenceSequence: 4,
		sourceContexts: [context], entries: [0, 1, 2].map(sequence => ({sourceContextDigest: context.digest,
			sourceSequence: sequence, sourceDigest: commits[sequence]!.envelope.digest,
			disposition: "rebase" as const, replacementSequence: sequence + 1}))}});
	await prune(store, 0);
}
async function prune(store: DurableIssuanceStore, through: number) {
	const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
	await maintenance.pruneAuthenticatedSettledPrefix(d109bPruningInput(await maintenance.inspectPruningState(scope), 3, through));
}
async function census(store: DurableIssuanceStore): Promise<IssuanceRetirementRows> {
	return (await durableIssuancePruningMaintenanceForStore(store)!.readBoundedRecoveryCensus!(
		{objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS})).rows;
}
async function control(store: DurableIssuanceStore): Promise<DurableIssuanceRetirementControl> {
	const read = await durableIssuancePruningMaintenanceForStore(store)!.acquireRetirementControl!({objectId: scope.objectId});
	try {return read.control;} finally {await read.release();}
}
async function planBefore(store: DurableIssuanceStore): Promise<Uint8Array | null> {
	return durableIssuancePruningMaintenanceForStore(store)!.readRetirementPlanBefore!({objectId: scope.objectId});
}
/** Prepares one retirement through epoch 3; floorEpoch undefined writes the previous (control-1) form. */
async function prepare(store: DurableIssuanceStore, floorEpoch: number | undefined, decision: string):
	Promise<{p: DurableIssuanceRetirementPreparation; source: IssuanceRetirementRows}> {
	const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
	const read = await maintenance.acquireRetirementControl!({objectId: scope.objectId});
	try {
		const source = await census(store), floor = floorEpoch === undefined ? {} : {floorEpoch};
		const protectedRecords = closeIssuanceRetirementProtectedRecords({control: read.control, rows: source,
			throughEpoch: 3, ...floor, protectedRecords: []});
		const p = issuanceRetirementPreparationWithPlanRewrite(read.control, {throughEpoch: 3, ...floor,
			decisionDigest: decision.repeat(64), sourceProofDigest: "b".repeat(64), protectedRecords}, source);
		await read.prepareFence(p);
		return {p, source};
	} finally {await read.release();}
}
async function finish(store: DurableIssuanceStore, how: "commit" | "abort" = "commit"): Promise<DurableIssuanceRetirementControl> {
	const read = await durableIssuancePruningMaintenanceForStore(store)!.acquireRetirementControl!({objectId: scope.objectId});
	try {return how === "commit" ? await read.commitPrepared() : await read.abortPrepared();} finally {await read.release();}
}
/** The first preparation this code writes: floored, control-2, with the BEFORE images in the side row. */
async function upgradeByNextRetirement(store: DurableIssuanceStore, floorEpoch: number, decision: string) {
	const {p, source} = await prepare(store, floorEpoch, decision);
	expect(p.floorEpoch).toBe(floorEpoch);
	const completed = await finish(store);
	expect(completed.kind).toBe("v3-issuance-retirement-control-2");
	expect(completed.completed).toEqual(p);
	const before = await planBefore(store);
	if (p.planRewrite === undefined) {expect(before).toBeNull(); return;}
	expect(p.planRewrite.kind).toBe("v3-issuance-retirement-plan-rewrite-2");
	expect(before).toBeInstanceOf(Uint8Array);
	expect(reconstructIssuanceRetirementSourceRows(completed, p, await census(store), before)).toEqual(source);
}

describe.each(["sqlite", "indexeddb"] as const)("%s legacy retirement reopen", backend => {
	it("idle: reopens the previous format, then the first retirement writes control-2 with its side row", async () => {
		const at = await location(backend);
		let store = await at.open();
		await seed(store);
		await at.close(store); at.toPreviousFormat();
		store = await at.open();
		if (backend === "sqlite") {
			await at.close(store);
			expect(at.nativeSchema()).toEqual({version: 6, sideTable: true});
			store = await at.open();
		}
		expect((await control(store)).kind).toBe("v3-issuance-retirement-control-1");
		expect(await planBefore(store)).toBeNull();
		await upgradeByNextRetirement(store, 3, "a");
		expect(await planBefore(store)).not.toBeNull();
		// The side row and control-2 survive their own reopen.
		const before = await planBefore(store), after = await control(store);
		await at.close(store); store = await at.open();
		expect(await planBefore(store)).toEqual(before);
		expect(encodeIssuanceRetirementControl(await control(store))).toEqual(encodeIssuanceRetirementControl(after));
	});

	it("completed: keeps the exact control-1 bytes and legacy reconstruction, then upgrades monotonically", async () => {
		const at = await location(backend);
		let store = await at.open();
		await seed(store);
		const {p, source} = await prepare(store, undefined, "a");
		expect(p.planRewrite?.kind).toBe("v3-issuance-retirement-plan-rewrite-1");
		const legacy = await finish(store);
		expect(legacy.kind).toBe("v3-issuance-retirement-control-1");
		await at.close(store); at.toPreviousFormat();
		store = await at.open();
		const reopened = await control(store);
		expect(encodeIssuanceRetirementControl(reopened)).toEqual(encodeIssuanceRetirementControl(legacy));
		expect(await planBefore(store)).toBeNull();
		// The legacy byte rewrite reconstructs from its control alone.
		expect(reconstructIssuanceRetirementSourceRows(reopened, p, await census(store))).toEqual(source);
		// The next floored retirement may not lower the legacy floor (its cut, 3).
		await expect(prepare(store, 2, "c")).rejects.toThrow();
		expect(encodeIssuanceRetirementControl(await control(store))).toEqual(encodeIssuanceRetirementControl(legacy));
		await prune(store, 1);
		await upgradeByNextRetirement(store, 3, "c");
	});

	it.each(["commit", "abort"] as const)("active: resumes a control-1 preparation and %ss it in legacy form", async how => {
		const at = await location(backend);
		let store = await at.open();
		await seed(store);
		const {p, source} = await prepare(store, undefined, "a");
		const prepared = await control(store);
		expect(prepared.kind).toBe("v3-issuance-retirement-control-1");
		await at.close(store); at.toPreviousFormat();
		store = await at.open();
		expect(encodeIssuanceRetirementControl(await control(store))).toEqual(encodeIssuanceRetirementControl(prepared));
		const done = await finish(store, how);
		expect(done.kind).toBe("v3-issuance-retirement-control-1");
		expect(done.active).toBeNull();
		expect(await planBefore(store)).toBeNull();
		if (how === "commit") {
			expect(done.completed).toEqual(p);
			expect(reconstructIssuanceRetirementSourceRows(done, p, await census(store))).toEqual(source);
			await prune(store, 1);
		} else {
			expect(done.completed).toBeNull();
			expect(await census(store)).toEqual(source);
		}
		await upgradeByNextRetirement(store, 3, "c");
	});
});

it("sqlite refuses a schema newer than this code", async () => {
	const at = await location("sqlite");
	const store = await at.open();
	await seed(store);
	await at.close(store);
	at.setNativeVersion(7);
	await expect(at.open().then(opened => control(opened)))
		.rejects.toMatchObject({code: "ISSUANCE_UNSUPPORTED_SCHEMA"});
});
