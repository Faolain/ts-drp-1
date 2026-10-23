import "fake-indexeddb/auto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableIssuanceStore, DurableIssueCommit } from "@ts-drp/issuance-store";
import {
	closeIssuanceRetirementProtectedRecords,
	durableIssuancePruningMaintenanceForStore,
	ISSUANCE_RETIREMENT_LIMITS,
	issuanceRetirementPreparationWithPlanRewrite,
	issuanceRetirementCommitRows,
	issuanceRetirementImage,
} from "@ts-drp/issuance-store/maintenance";
import { createNodeDurableIssuanceStore } from "../src/issuance.js";
import { createBrowserDurableIssuanceStore } from "../../storage-browser/src/issuance.js";
import { d109bIssue } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

const directories: string[] = [];
const stores: DurableIssuanceStore[] = [];
afterEach(async () => {
	await Promise.all(stores.splice(0).map(store => store.close()));
	await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

it("SQLite SIGKILL reopens exact prepared-old or completed-new at every rewrite transaction edge", async () => {
	const directory = await mkdtemp(join(tmpdir(), "issuance-plan-death-"));
	directories.push(directory);
	const childFilename = join(directory, "child.mjs");
	await build({entryPoints: [new URL("./fixtures/issuance-plan-rewrite-child.mjs", import.meta.url).pathname],
		outfile: childFilename, bundle: true, platform: "node", format: "esm", target: "node22",
		alias: {"@ts-drp/issuance-store/maintenance": new URL("../../issuance-store/src/maintenance.ts", import.meta.url).pathname,
			"@ts-drp/issuance-store": new URL("../../issuance-store/src/index.ts", import.meta.url).pathname}});
	for (const edge of ["before-plan-write", "after-plan-write", "after-control-write", "before-commit", "after-commit"]) {
		const primaryFilename = join(directory, `${edge}.sqlite`);
		let store = createNodeDurableIssuanceStore({primaryFilename}); stores.push(store);
		await seed(store);
		const owner = durableIssuancePruningMaintenanceForStore(store)!;
		const read = await owner.acquireRetirementControl!({objectId: scope.objectId});
		const source = await owner.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
		const protectedRecords = closeIssuanceRetirementProtectedRecords({control: read.control, rows: source.rows,
			throughEpoch: 3, protectedRecords: []});
		const p = issuanceRetirementPreparationWithPlanRewrite(read.control, {throughEpoch: 3,
			decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), protectedRecords}, source.rows);
		const target = issuanceRetirementCommitRows(read.control, p, source.rows);
		const preparedControl = await read.prepareFence(p);
		await read.release(); await store.close(); stores.splice(stores.indexOf(store), 1);
		const child = spawn(process.execPath, [childFilename, primaryFilename, scope.objectId, edge],
			{stdio: ["ignore", "ignore", "pipe", "ipc"]});
		let checkpointed = false, stderr = "";
		child.stderr!.setEncoding("utf8"); child.stderr!.on("data", data => {stderr += data;});
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {child.kill("SIGKILL"); reject(new Error(`crash timeout ${edge}: ${stderr}`));}, 15_000);
			child.on("message", (message: {kind: string; edge?: string; message?: string}) => {
				if (message.kind === "child-error") {child.kill("SIGKILL"); reject(new Error(message.message));}
				if (message.kind === "checkpoint" && message.edge === edge) {checkpointed = true; child.kill("SIGKILL");}
			});
			child.once("error", reject);
			child.once("exit", (code, signal) => {clearTimeout(timeout);
				if (checkpointed && code === null && signal === "SIGKILL") resolve();
				else reject(new Error(`crash custody ${edge}: ${code}/${signal} ${stderr}`));});
		});
		store = createNodeDurableIssuanceStore({primaryFilename}); stores.push(store);
		const reopened = durableIssuancePruningMaintenanceForStore(store)!;
		const observed = await reopened.acquireRetirementControl!({objectId: scope.objectId});
		const census = await reopened.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
		const committed = edge === "after-commit";
		expect(observed.control, edge).toEqual(committed ? {...preparedControl, revision: preparedControl.revision + 1,
			active: null, completed: p} : preparedControl);
		expect(census.rows, edge).toEqual(committed ? target : source.rows);
		expect(census.image.imageDigest, edge).toBe(issuanceRetirementImage(committed ? target : source.rows, scope.objectId).imageDigest);
		await observed.release();
	}
}, 60_000);
const scope = {objectId: "rewrite-room", author: "writer"};
async function seed(store: DurableIssuanceStore) {
	const commits: DurableIssueCommit[] = [];
	for (let epoch = 0; epoch < 5; epoch++) commits.push(await d109bIssue(store, scope, epoch));
	const plan = {scope, revision: 0, fenceSequence: 4, entries: [0, 1, 2].map(sequence => ({
		sourceSequence: sequence, sourceDigest: commits[sequence]!.envelope.digest,
		disposition: "rebase" as const, replacementSequence: sequence + 1}))};
	await store.transactWriteSettlementPlan({scope, expectedRevision: null, plan});
	return plan;
}

describe.each(["sqlite", "indexeddb"] as const)("%s atomic plan retirement", backend => {
	it("keeps the old plan through preparation and commits the exact new plan/control together", async () => {
		const directory = await mkdtemp(join(tmpdir(), "issuance-plan-rewrite-"));
		directories.push(directory);
		const primaryFilename = join(directory, "primary.sqlite"), primaryDatabaseName = `rewrite-${crypto.randomUUID()}`;
		const open = () => backend === "sqlite" ? createNodeDurableIssuanceStore({primaryFilename}) :
			createBrowserDurableIssuanceStore({primaryDatabaseName});
		let store = await open(); stores.push(store);
		const before = await seed(store);
		const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
		const read = await maintenance.acquireRetirementControl!({objectId: scope.objectId});
		const source = await maintenance.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
		const replacement = source.rows.issued[1]!;
		const protectedRecords = closeIssuanceRetirementProtectedRecords({control: read.control, rows: source.rows,
			throughEpoch: 3, protectedRecords: [{author: scope.author, authorSequence: 1,
				digest: Buffer.from(replacement.digest).toString("hex")}]});
		const p = issuanceRetirementPreparationWithPlanRewrite(read.control, {throughEpoch: 3,
			decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), protectedRecords}, source.rows);
		await read.prepareFence(p);
		await read.release();
		expect(await store.readSettlementPlan(scope)).toEqual(before);
		const prepared = await maintenance.acquireRetirementControl!({objectId: scope.objectId});
		expect(prepared.image.imageDigest).toBe(source.image.imageDigest);
		const committed = await prepared.commitPrepared();
		await prepared.release();
		expect(committed.completed).toEqual(p);
		expect(committed.active).toBeNull();
		const after = await store.readSettlementPlan(scope);
		expect(after).toEqual({...before, revision: 1, entries: before.entries.slice(1)});
		const target = await maintenance.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
		expect(target.image.imageDigest).toBe(p.planRewrite!.targetImageDigest);
		expect(target.rows.issued).toEqual(source.rows.issued);
		await store.close(); stores.splice(stores.indexOf(store), 1);
		store = await open(); stores.push(store);
		expect(await store.readSettlementPlan(scope)).toEqual(after);
		await expect(store.transactWriteSettlementPlan({scope, expectedRevision: after!.revision,
			plan: {...after!, revision: after!.revision + 1}})).resolves.toEqual({...after!, revision: 2});
	});
});
