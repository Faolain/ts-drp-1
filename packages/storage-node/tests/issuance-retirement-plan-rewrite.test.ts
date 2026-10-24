import "fake-indexeddb/auto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableIssuanceStore, DurableIssueCommit } from "@ts-drp/issuance-store";
import {
	closeIssuanceRetirementProtectedRecords,
	durableIssuancePruningMaintenanceForStore,
	ISSUANCE_RETIREMENT_LIMITS,
	issuanceRetirementPreparationWithPlanRewrite,
	issuanceRetirementCommitRows,
	issuanceRetirementImage,
	encodeIssuanceRetirementControl,
	issuanceRetirementPlanRewriteResourceForSizing,
} from "@ts-drp/issuance-store/maintenance";
import { createNodeDurableIssuanceStore } from "../src/issuance.js";
import { createBrowserDurableIssuanceStore } from "../../storage-browser/src/issuance.js";
import { d109bIssue, d109bPruningInput } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

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
	const contextBytes = encodeCanonical({historicalSource: "mechanical-custody-fixture"});
	const context = {digest: hashDomain("ts-drp/settlement-source-context/v1", contextBytes), exactCanonicalContextBytes: contextBytes};
	const plan = {scope, revision: 0, fenceSequence: 4, sourceContexts: [context], entries: [0, 1, 2].map(sequence => ({
		sourceContextDigest: context.digest,
		sourceSequence: sequence, sourceDigest: commits[sequence]!.envelope.digest,
		disposition: "rebase" as const, replacementSequence: sequence + 1}))};
	await store.transactWriteSettlementPlan({scope, expectedRevision: null, plan});
	return plan;
}

describe.each(["sqlite", "indexeddb"] as const)("%s atomic plan retirement", backend => {
	it("keeps terminal proof through physical custody and later plan progress, then releases it after the native drain", async () => {
		const directory = await mkdtemp(join(tmpdir(), "issuance-terminal-proof-")); directories.push(directory);
		const primaryFilename = join(directory, "primary.sqlite"), primaryDatabaseName = `terminal-proof-${crypto.randomUUID()}`;
		const open = () => backend === "sqlite" ? createNodeDurableIssuanceStore({primaryFilename}) :
			createBrowserDurableIssuanceStore({primaryDatabaseName});
		let store = await open(); stores.push(store);
		const commits: DurableIssueCommit[] = [];
		for (let epoch = 0; epoch < 5; epoch++) commits.push(await d109bIssue(store, scope, epoch, epoch !== 0));
		const context = (kind: string) => {const exactCanonicalContextBytes = encodeCanonical({kind});
			return {digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes), exactCanonicalContextBytes};};
		const source = context("mechanical-source"), proof = context("mechanical-completion");
		const before = {scope, revision: 0, fenceSequence: 4, entries: [{sourceSequence: 0,
			sourceDigest: commits[0]!.envelope.digest, sourceContextDigest: source.digest, sourceResolutionDigest: proof.digest,
			disposition: "committed" as const, replacementSequence: null}],
			sourceContexts: [source, proof].sort((a,b) => Buffer.compare(a.digest, b.digest))};
		await store.transactWriteSettlementPlan({scope, expectedRevision: null, plan: before});
		const retire = async () => {
			const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
			const read = await maintenance.acquireRetirementControl!({objectId: scope.objectId});
			try {
				const native = await maintenance.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
				const protectedRecords = closeIssuanceRetirementProtectedRecords({control: read.control, rows: native.rows,
					throughEpoch: 3, protectedRecords: []});
				expect(protectedRecords.some(hole => hole.authorSequence === 0)).toBe(false);
				const p = issuanceRetirementPreparationWithPlanRewrite(read.control, {throughEpoch: 3,
					decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), protectedRecords}, native.rows);
				if (p.planRewrite !== undefined) expect(encodeCanonical(p.planRewrite).byteLength).toBeLessThanOrEqual(
					issuanceRetirementPlanRewriteResourceForSizing(native.rows.plans)!.byteLength);
				await read.prepareFence(p);
			} finally {await read.release();}
			const prepared = await maintenance.acquireRetirementControl!({objectId: scope.objectId});
			try {await prepared.commitPrepared();} finally {await prepared.release();}
		};
		await expect(retire()).rejects.toThrow("pending publication is unprotected");
		expect((await store.readOutboxPage({scope, limit: 1}))[0]?.publishState).toBe("pending");
		await store.compareAndMarkOutboxPublished({scope, authorSequence: 0, digest: commits[0]!.envelope.digest});
		await retire();
		expect(await store.readSettlementPlan(scope)).toEqual(before);
		// An independent current write changes the exact target image. Durable
		// context ownership survives without borrowing an obsolete inverse.
		await d109bIssue(store, scope, 5);
		await store.transactWriteSettlementPlan({scope, expectedRevision: 0, plan: {...before, revision: 1}});
		await store.close(); stores.splice(stores.indexOf(store), 1);
		store = await open(); stores.push(store);
		expect(await store.readSettlementPlan(scope)).toEqual({...before, revision: 1});
		const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
		await maintenance.pruneAuthenticatedSettledPrefix(d109bPruningInput(await maintenance.inspectPruningState(scope), 3, 0));
		expect(await store.readIssued(scope, 0)).toBeNull();
		expect((await store.readSettlementPlan(scope))?.sourceContexts).toEqual(before.sourceContexts);
		await retire();
		expect(await store.readSettlementPlan(scope)).toEqual({scope, revision: 2, fenceSequence: 4, entries: []});
		await expect(store.transactWriteSettlementPlan({scope, expectedRevision: 2, plan: {...before, revision: 3}}))
			.rejects.toThrow("retired or absent issued work");
	});

	it("prunes a fence-less removed author's authenticated committed source without a FENCE", async () => {
		const directory = await mkdtemp(join(tmpdir(), "issuance-fenceless-terminal-")); directories.push(directory);
		const primaryFilename = join(directory, "primary.sqlite"), primaryDatabaseName = `fenceless-${crypto.randomUUID()}`;
		const open = () => backend === "sqlite" ? createNodeDurableIssuanceStore({primaryFilename}) :
			createBrowserDurableIssuanceStore({primaryDatabaseName});
		const store = await open(); stores.push(store);
		const commits: DurableIssueCommit[] = [];
		for (let epoch = 0; epoch < 5; epoch++) commits.push(await d109bIssue(store, scope, epoch));
		const context = (kind: string) => {const exactCanonicalContextBytes = encodeCanonical({kind});
			return {digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes), exactCanonicalContextBytes};};
		const source = context("fenceless-source"), proof = context("fenceless-completion");
		// A custody-born plan for a fully removed author: no Writer grant, no FENCE.
		const plan = {scope, revision: 0, fenceSequence: null, entries: [{sourceSequence: 0,
			sourceDigest: commits[0]!.envelope.digest, sourceContextDigest: source.digest, sourceResolutionDigest: proof.digest,
			disposition: "committed" as const, replacementSequence: null}],
			sourceContexts: [source, proof].sort((a,b) => Buffer.compare(a.digest, b.digest))};
		await store.transactWriteSettlementPlan({scope, expectedRevision: null, plan});
		const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
		const retire = async (expectProtected: boolean) => {
			const read = await maintenance.acquireRetirementControl!({objectId: scope.objectId});
			try {
				const native = await maintenance.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
				const protectedRecords = closeIssuanceRetirementProtectedRecords({control: read.control, rows: native.rows,
					throughEpoch: 3, protectedRecords: []});
				expect(protectedRecords.some(hole => hole.authorSequence === 0)).toBe(expectProtected);
				await read.prepareFence(issuanceRetirementPreparationWithPlanRewrite(read.control, {throughEpoch: 3,
					decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), protectedRecords}, native.rows));
			} finally {await read.release();}
			const prepared = await maintenance.acquireRetirementControl!({objectId: scope.objectId});
			try {await prepared.commitPrepared();} finally {await prepared.release();}
		};
		await retire(false);
		expect(await store.readSettlementPlan(scope)).toEqual(plan);
		await maintenance.pruneAuthenticatedSettledPrefix(d109bPruningInput(await maintenance.inspectPruningState(scope), 3, 0));
		expect(await store.readIssued(scope, 0)).toBeNull();
		await retire(false);
		expect(await store.readSettlementPlan(scope)).toEqual({scope, revision: 1, fenceSequence: null, entries: []});
	});

	it("keeps a fence-less plan's review or unauthenticated sibling source protected", async () => {
		const directory = await mkdtemp(join(tmpdir(), "issuance-fenceless-negative-")); directories.push(directory);
		const primaryFilename = join(directory, "primary.sqlite"), primaryDatabaseName = `fenceless-neg-${crypto.randomUUID()}`;
		const open = () => backend === "sqlite" ? createNodeDurableIssuanceStore({primaryFilename}) :
			createBrowserDurableIssuanceStore({primaryDatabaseName});
		const store = await open(); stores.push(store);
		const commits: DurableIssueCommit[] = [];
		for (let epoch = 0; epoch < 5; epoch++) commits.push(await d109bIssue(store, scope, epoch));
		const context = (kind: string) => {const exactCanonicalContextBytes = encodeCanonical({kind});
			return {digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes), exactCanonicalContextBytes};};
		const [source, sibling, proof] = [context("s0"), context("s1"), context("p0")];
		const plan = {scope, revision: 0, fenceSequence: null, entries: [{sourceSequence: 0,
			sourceDigest: commits[0]!.envelope.digest, sourceContextDigest: source.digest, sourceResolutionDigest: proof.digest,
			disposition: "committed" as const, replacementSequence: null}, {sourceSequence: 1,
			sourceDigest: commits[1]!.envelope.digest, sourceContextDigest: sibling.digest,
			disposition: "manual-review" as const, replacementSequence: null}],
			sourceContexts: [source, sibling, proof].sort((a,b) => Buffer.compare(a.digest, b.digest))};
		await store.transactWriteSettlementPlan({scope, expectedRevision: null, plan});
		const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
		const read = await maintenance.acquireRetirementControl!({objectId: scope.objectId});
		try {
			const native = await maintenance.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
			const protectedRecords = closeIssuanceRetirementProtectedRecords({control: read.control, rows: native.rows,
				throughEpoch: 3, protectedRecords: []});
			expect(protectedRecords.map(hole => hole.authorSequence)).toEqual([1]);
		} finally {await read.release();}
		await expect(maintenance.pruneAuthenticatedSettledPrefix(d109bPruningInput(await maintenance.inspectPruningState(scope), 3, 0)))
			.rejects.toThrow("settlement plan is incomplete");
		expect(await store.readIssued(scope, 0)).not.toBeNull();
	});

	it("retires and prunes an abandoned pending source of a fence-less author while its outbox stays pending", async () => {
		const directory = await mkdtemp(join(tmpdir(), "issuance-abandoned-")); directories.push(directory);
		const primaryFilename = join(directory, "primary.sqlite"), primaryDatabaseName = `abandoned-${crypto.randomUUID()}`;
		const open = () => backend === "sqlite" ? createNodeDurableIssuanceStore({primaryFilename}) :
			createBrowserDurableIssuanceStore({primaryDatabaseName});
		const store = await open(); stores.push(store);
		const commits: DurableIssueCommit[] = [];
		for (let epoch = 0; epoch < 5; epoch++) commits.push(await d109bIssue(store, scope, epoch, epoch !== 0));
		const context = (kind: string) => {const exactCanonicalContextBytes = encodeCanonical({kind});
			return {digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes), exactCanonicalContextBytes};};
		const [source, expiry, sibling] = [context("abandoned-source"), context("abandoned-expiry"), context("sibling-source")];
		// Custody-born: 0 and 1 unresolved reviews, 2 an unresolved (retained-fence) expiry.
		const reviewed = {scope, revision: 0, fenceSequence: null, entries: [
			{sourceSequence: 0, sourceDigest: commits[0]!.envelope.digest, sourceContextDigest: source.digest,
				disposition: "manual-review" as const, replacementSequence: null},
			{sourceSequence: 1, sourceDigest: commits[1]!.envelope.digest, sourceContextDigest: sibling.digest,
				disposition: "manual-review" as const, replacementSequence: null},
			{sourceSequence: 2, sourceDigest: commits[2]!.envelope.digest, sourceContextDigest: sibling.digest,
				disposition: "expire" as const, replacementSequence: null}],
			sourceContexts: [source, sibling].sort((a,b) => Buffer.compare(a.digest, b.digest))};
		await store.transactWriteSettlementPlan({scope, expectedRevision: null, plan: reviewed});
		const maintenance = durableIssuancePruningMaintenanceForStore(store)!;
		const protectedNow = async () => {
			const read = await maintenance.acquireRetirementControl!({objectId: scope.objectId});
			try {
				const native = await maintenance.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
				return closeIssuanceRetirementProtectedRecords({control: read.control, rows: native.rows,
					throughEpoch: 3, protectedRecords: []}).map(hole => hole.authorSequence);
			} finally {await read.release();}
		};
		const retire = async () => {
			const read = await maintenance.acquireRetirementControl!({objectId: scope.objectId});
			try {
				const native = await maintenance.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
				const protectedRecords = closeIssuanceRetirementProtectedRecords({control: read.control, rows: native.rows,
					throughEpoch: 3, protectedRecords: []});
				await read.prepareFence(issuanceRetirementPreparationWithPlanRewrite(read.control, {throughEpoch: 3,
					decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), protectedRecords}, native.rows));
			} finally {await read.release();}
			const prepared = await maintenance.acquireRetirementControl!({objectId: scope.objectId});
			try {await prepared.commitPrepared();} finally {await prepared.release();}
		};
		expect(await protectedNow()).toEqual([0, 1, 2]);
		// One CAS: entry 0 becomes signed expiry. Fence stays null, no new issuance.
		const abandoned = {...reviewed, revision: 1, entries: [{...reviewed.entries[0]!, disposition: "expire" as const,
			sourceResolutionDigest: expiry.digest}, reviewed.entries[1]!, reviewed.entries[2]!],
			sourceContexts: [source, expiry, sibling].sort((a,b) => Buffer.compare(a.digest, b.digest))};
		await store.transactWriteSettlementPlan({scope, expectedRevision: 0, plan: abandoned});
		expect(await protectedNow()).toEqual([1, 2]);
		await retire();
		expect((await store.readOutboxPage({scope, limit: 2})).map(row => row.publishState)).toEqual(["pending", "published"]);
		// The open review and the unresolved expiry keep the fence-less plan from pruning.
		await expect(maintenance.pruneAuthenticatedSettledPrefix(d109bPruningInput(await maintenance.inspectPruningState(scope), 3, 0)))
			.rejects.toThrow("settlement plan is incomplete");
		expect(await store.readIssued(scope, 0)).not.toBeNull();
		// Drop the siblings the way their own terminal owners would, then prune.
		const only = {scope, revision: 2, fenceSequence: null, entries: [abandoned.entries[0]!],
			sourceContexts: [source, expiry].sort((a,b) => Buffer.compare(a.digest, b.digest))};
		await store.transactWriteSettlementPlan({scope, expectedRevision: 1, plan: only});
		await maintenance.pruneAuthenticatedSettledPrefix(d109bPruningInput(await maintenance.inspectPruningState(scope), 3, 0));
		expect(await store.readIssued(scope, 0)).toBeNull();
		// Never published: the pending row was deleted by pruning, not acknowledged.
		expect((await store.readOutboxPage({scope, limit: 8})).some(row => row.commit.authorSequence === 0)).toBe(false);
		await retire();
		expect(await store.readSettlementPlan(scope)).toEqual({scope, revision: 3, fenceSequence: null, entries: []});
	});

	it("keeps signed expiry and publication exclusive for one source", async () => {
		const directory = await mkdtemp(join(tmpdir(), "issuance-expiry-exclusive-")); directories.push(directory);
		const primaryFilename = join(directory, "primary.sqlite"), primaryDatabaseName = `exclusive-${crypto.randomUUID()}`;
		const open = () => backend === "sqlite" ? createNodeDurableIssuanceStore({primaryFilename}) :
			createBrowserDurableIssuanceStore({primaryDatabaseName});
		const store = await open(); stores.push(store);
		const commits: DurableIssueCommit[] = [];
		for (let epoch = 0; epoch < 3; epoch++) commits.push(await d109bIssue(store, scope, epoch, epoch === 1));
		const context = (kind: string) => {const exactCanonicalContextBytes = encodeCanonical({kind});
			return {digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes), exactCanonicalContextBytes};};
		const [source, expiry] = [context("exclusive-source"), context("exclusive-expiry")];
		const reviewed = (sequence: number) => ({sourceSequence: sequence, sourceDigest: commits[sequence]!.envelope.digest,
			sourceContextDigest: source.digest, disposition: "manual-review" as const, replacementSequence: null});
		const prior = {scope, revision: 0, fenceSequence: null, entries: [reviewed(0), reviewed(1)], sourceContexts: [source]};
		await store.transactWriteSettlementPlan({scope, expectedRevision: null, plan: prior});
		const expire = (sequence: number) => ({...prior, revision: 1, entries: prior.entries.map(entry => entry.sourceSequence !== sequence ? entry :
			{...entry, disposition: "expire" as const, sourceResolutionDigest: expiry.digest}),
			sourceContexts: [source, expiry].sort((a,b) => Buffer.compare(a.digest, b.digest))});
		// Expiry over an already published row (replay after publication) is refused.
		await expect(store.transactWriteSettlementPlan({scope, expectedRevision: 0, plan: expire(1)}))
			.rejects.toThrow("expiry and publication are exclusive");
		expect(await store.readSettlementPlan(scope)).toEqual(prior);
		await store.transactWriteSettlementPlan({scope, expectedRevision: 0, plan: expire(0)});
		// Publication of an authenticated-expiry source is refused; the row stays pending.
		await expect(store.compareAndMarkOutboxPublished({scope, authorSequence: 0, digest: commits[0]!.envelope.digest}))
			.rejects.toThrow("expiry and publication are exclusive");
		expect((await store.readOutboxPage({scope, limit: 1}))[0]?.publishState).toBe("pending");
		// Unrelated sources still publish.
		await store.compareAndMarkOutboxPublished({scope, authorSequence: 2, digest: commits[2]!.envelope.digest});
		expect((await store.readOutboxPage({scope, limit: 3}))[2]?.publishState).toBe("published");
	});

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
	it("keeps private transition rows separate from caller census mutations and rejects preparation getters", async () => {
		const directory = await mkdtemp(join(tmpdir(), "issuance-plan-owned-"));
		directories.push(directory);
		const store = await (backend === "sqlite" ? createNodeDurableIssuanceStore({primaryFilename: join(directory, "primary.sqlite")}) :
			createBrowserDurableIssuanceStore({primaryDatabaseName: `rewrite-owned-${crypto.randomUUID()}`}));
		stores.push(store);
		const before = await seed(store);
		const owner = durableIssuancePruningMaintenanceForStore(store)!;
		const read = await owner.acquireRetirementControl!({objectId: scope.objectId});
		const census = await owner.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
		const protectedRecords = closeIssuanceRetirementProtectedRecords({control: read.control, rows: census.rows,
			throughEpoch: 3, protectedRecords: []});
		const preparation = issuanceRetirementPreparationWithPlanRewrite(read.control, {throughEpoch: 3,
			decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), protectedRecords}, census.rows);
		let getterCalls = 0;
		const hostile = Object.defineProperty({...preparation}, "protectedRecords", {
			enumerable: true, get() { getterCalls++; return protectedRecords; },
		});
		await expect(read.prepareFence(hostile)).rejects.toThrow();
		expect(getterCalls).toBe(0);
		await read.prepareFence(preparation);
		await read.release();
		const prepared = await owner.acquireRetirementControl!({objectId: scope.objectId});
		// The returned census is caller-owned DATA. It is not the detached native
		// image captured inside this one-use control or its subsequent writer.
		census.rows.issued[1]!.canonicalPreimageBytes.fill(0);
		census.rows.plans[0]!.entries[1]!.sourceDigest.fill(0);
		Object.defineProperty(census.rows, "outbox", {enumerable: true,
			get() { throw new Error("caller census getter must not enter native transition"); }});
		const completed = await prepared.commitPrepared();
		await prepared.release();
		expect(completed.active).toBeNull();
		expect(completed.completed).toEqual(preparation);
		const {sourceContexts: _released, ...plain} = before;
		expect(await store.readSettlementPlan(scope)).toEqual({...plain, revision: 1, entries: []});
		const actual = await owner.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
		expect(actual.image.imageDigest).toBe(preparation.planRewrite!.targetImageDigest);
	});
});

it("SQLite rereads a changed native plan under BEGIN before committing a captured retirement target", async () => {
	const directory = await mkdtemp(join(tmpdir(), "issuance-plan-writer-currency-"));
	directories.push(directory);
	const primaryFilename = join(directory, "primary.sqlite");
	const store = createNodeDurableIssuanceStore({primaryFilename}); stores.push(store);
	const before = await seed(store);
	const owner = durableIssuancePruningMaintenanceForStore(store)!;
	const initial = await owner.acquireRetirementControl!({objectId: scope.objectId});
	const source = await owner.readBoundedRecoveryCensus!({objectId: scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS});
	const protectedRecords = closeIssuanceRetirementProtectedRecords({control: initial.control, rows: source.rows,
		throughEpoch: 3, protectedRecords: []});
	const preparation = issuanceRetirementPreparationWithPlanRewrite(initial.control, {throughEpoch: 3,
		decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), protectedRecords}, source.rows);
	await initial.prepareFence(preparation); await initial.release();
	const prepared = await owner.acquireRetirementControl!({objectId: scope.objectId});
	const expectedControl = encodeIssuanceRetirementControl(prepared.control);
	const foreign = new DatabaseSync(`${primaryFilename}.drp-issuance-v1.sqlite`);
	const exec = DatabaseSync.prototype.exec;
	let changed = false;
	try {
		const storedPlan = JSON.parse(String(foreign.prepare("SELECT entries_json FROM settlement_plans WHERE object_id=? AND author=?")
			.get(scope.objectId, scope.author)?.entries_json));
		const changedPlan = {...before, revision: 1};
		const changedEntries = JSON.stringify({...storedPlan, bytes: Buffer.from(encodeCanonical(changedPlan)).toString("base64")});
		// A real foreign native mutation lands after the view was captured and
		// the expected target was derived, before the original writer acquires.
		foreign.function("issuance_retirement_connection", {varargs: true}, () => 1);
		DatabaseSync.prototype.exec = function (sql: string): void {
			if (!changed && this !== foreign && sql === "BEGIN IMMEDIATE") {
				changed = true;
				foreign.prepare("UPDATE settlement_plans SET revision=?,entries_json=? WHERE object_id=? AND author=?")
					.run(changedPlan.revision, changedEntries, scope.objectId, scope.author);
			}
			exec.call(this, sql);
		};
		await expect(prepared.commitPrepared()).rejects.toThrow("source stale");
		expect(changed).toBe(true);
		expect(foreign.prepare("SELECT record FROM retirement_controls WHERE object_id=?").get(scope.objectId)?.record)
			.toEqual(expectedControl);
		expect(await store.readSettlementPlan(scope)).toEqual({...before, revision: 1});
	} finally {
		DatabaseSync.prototype.exec = exec;
		foreign.close();
		await prepared.release();
	}
});
