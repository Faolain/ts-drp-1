import type { AheDurableStore, GenerationPageCursor, GenerationRecord, PresentHead } from "@ts-drp/storage";
import { digestBlob } from "@ts-drp/storage";
import { type ChildProcess, fork, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	D109F_OBJECT_ID,
	D109F_POLICY_DIGEST,
	D109F_PROOF_KIND_REGISTRY,
	D109F_SCOPE,
	D109F_STEP_COUNT,
	d109fErrorCode,
	d109fGenerationId,
	d109fPlanner,
	type D109fPlannerResult,
} from "../../../tests/fixtures/phase-6b/differential-exit-contract.js";
import { d109bIssue, d109bPruningInput } from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const CHILD_FIXTURE = resolve(import.meta.dirname, "fixtures/phase-6b-differential-exit-child.mjs");
const ISSUANCE_DATABASE_SUFFIX = ".drp-issuance-v1.sqlite";
const D109F_LIFECYCLE_TITLE =
	"D.109f preserves owner-observed Discord and MMORPG projections with zero deleted durable reads";
const directories: string[] = [];

function temporary(label: string): string {
	const directory = mkdtempSync(join(tmpdir(), `d109f-${label}-`));
	directories.push(directory);
	return join(directory, "primary.sqlite");
}

function successful<T>(result: { ok: false; reason: string } | { ok: true; value: T }, label: string): T {
	if (!result.ok) throw new TypeError(`D109F_${label}:${result.reason}`);
	return result.value;
}

function sqliteCount(filename: string, query: string): number {
	const database = new DatabaseSync(filename, { readOnly: true });
	try {
		const row = database.prepare(query).get() as { count: number };
		return Number(row.count);
	} finally {
		database.close();
	}
}

function runFreshLifecycle(): Promise<Readonly<Record<string, unknown>>> {
	return new Promise((resolvePromise, reject) => {
		const vitest = resolve(REPOSITORY_ROOT, "node_modules/vitest/vitest.mjs");
		const child = spawn(
			process.execPath,
			[
				vitest,
				"run",
				"tests/phase-6b-runtime-reclamation-red.test.ts",
				"-t",
				D109F_LIFECYCLE_TITLE,
				"--reporter=json",
				"--coverage.enabled=false",
				"--pool=forks",
				"--poolOptions.forks.singleFork=true",
			],
			{ cwd: REPOSITORY_ROOT, stdio: ["ignore", "pipe", "pipe"] }
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (value: string) => (stdout += value));
		child.stderr.on("data", (value: string) => (stderr += value));
		const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (code !== 0) {
				reject(new Error(`D109F_FRESH_LIFECYCLE_EXIT:${String(code)}:${String(signal)}:${stderr}:${stdout}`));
				return;
			}
			try {
				resolvePromise(JSON.parse(stdout) as Readonly<Record<string, unknown>>);
			} catch (error) {
				reject(new Error(`D109F_FRESH_LIFECYCLE_JSON:${stderr}:${stdout}`, { cause: error }));
			}
		});
	});
}

async function aheModules(): Promise<
	Readonly<{
		create(options: { readonly filename: string }): AheDurableStore;
		resolve(
			store: AheDurableStore
		): Readonly<{ reclaimClosedEpoch(input: unknown): Promise<Readonly<Record<string, unknown>>> }> | undefined;
	}>
> {
	const [root, maintenance] = await Promise.all([
		import(pathToFileURL(resolve(PACKAGE_DIRECTORY, "src/index.ts")).href),
		import(pathToFileURL(resolve(PACKAGE_DIRECTORY, "src/maintenance.ts")).href),
	]);
	return Object.freeze({
		create: (root as { createSqliteAheDurableStore(options: { filename: string }): AheDurableStore })
			.createSqliteAheDurableStore,
		resolve: (
			maintenance as {
				resolveNodeAheReclamationMaintenance(
					store: AheDurableStore
				): Readonly<{ reclaimClosedEpoch(input: unknown): Promise<Readonly<Record<string, unknown>>> }> | undefined;
			}
		).resolveNodeAheReclamationMaintenance,
	});
}

async function issuanceModules(): Promise<
	Readonly<{
		create(options: { readonly primaryFilename: string }): {
			close(): Promise<void>;
			compareAndMarkOutboxPublished(input: unknown): Promise<unknown>;
			readIssued(scope: unknown, authorSequence: number): Promise<unknown>;
			readOutboxPage(input: unknown): Promise<readonly unknown[]>;
			transactIssue(scope: unknown, build: (authorSequence: number) => Promise<unknown>): Promise<unknown>;
		};
		resolve(store: unknown):
			| Readonly<{
					inspectPruningState(scope: unknown): Promise<Readonly<Record<string, unknown>>>;
					prunePublishedPrefix(input: unknown): Promise<Readonly<Record<string, unknown>>>;
			  }>
			| undefined;
	}>
> {
	const [issuance, maintenance] = await Promise.all([
		import(pathToFileURL(resolve(PACKAGE_DIRECTORY, "src/issuance.ts")).href),
		import(pathToFileURL(resolve(PACKAGE_DIRECTORY, "src/issuance-maintenance.ts")).href),
	]);
	return Object.freeze({
		create: (issuance as never as { createNodeDurableIssuanceStore: never }).createNodeDurableIssuanceStore,
		resolve: (maintenance as never as { resolveNodeDurableIssuancePruningMaintenance: never })
			.resolveNodeDurableIssuancePruningMaintenance,
	});
}

async function appendGeneration(store: AheDurableStore, index: number): Promise<PresentHead> {
	const head = successful(await store.readHead(D109F_OBJECT_ID), "READ_HEAD");
	const generationId = d109fGenerationId(index);
	const bytes = Uint8Array.of(index & 0xff, (index + 1) & 0xff, (index + 2) & 0xff);
	const digest = successful(digestBlob(bytes), "DIGEST");
	const closure = Object.freeze([{ byteLength: bytes.byteLength, digest }]);
	successful(
		await store.beginGeneration({ baseExpectedHead: head, closure, generationId, objectId: D109F_OBJECT_ID }),
		"BEGIN"
	);
	successful(await store.putCachedBlob({ bytes, digest, generationId, objectId: D109F_OBJECT_ID }), "PUT");
	successful(await store.promoteReference({ digest, generationId, objectId: D109F_OBJECT_ID }), "PROMOTE");
	successful(await store.completeGeneration({ generationId, objectId: D109F_OBJECT_ID }), "COMPLETE");
	return successful(await store.swapHead({ expectedHead: head, generationId, objectId: D109F_OBJECT_ID }), "SWAP").head;
}

async function allGenerations(store: AheDurableStore): Promise<readonly GenerationRecord[]> {
	const records: GenerationRecord[] = [];
	let cursor: GenerationPageCursor | undefined;
	do {
		const page = successful(
			await store.readGenerationPage({
				...(cursor === undefined ? {} : { cursor }),
				limit: 64,
				objectId: D109F_OBJECT_ID,
			}),
			"PAGE"
		);
		records.push(...page.generations);
		cursor = page.nextCursor ?? undefined;
	} while (cursor !== undefined);
	return records;
}

function child(role: string, databaseFilename: string, encodedInput?: string): ChildProcess {
	return fork(CHILD_FIXTURE, [role, databaseFilename, ...(encodedInput === undefined ? [] : [encodedInput])], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
}

function waitForMessage(
	process: ChildProcess,
	kind: string,
	timeoutMilliseconds = 15_000
): Promise<Record<string, unknown>> {
	return new Promise((resolvePromise, reject) => {
		let stderr = "";
		process.stderr?.setEncoding("utf8");
		process.stderr?.on("data", (value: string) => (stderr += value));
		const timeout = setTimeout(() => reject(new Error(`D109F_CHILD_TIMEOUT:${kind}:${stderr}`)), timeoutMilliseconds);
		const listener = (message: unknown): void => {
			if (message === null || typeof message !== "object") return;
			const record = message as Record<string, unknown>;
			if (record.kind === "child-error") {
				clearTimeout(timeout);
				process.off("message", listener);
				reject(new Error(String(record.message)));
			} else if (record.kind === kind) {
				clearTimeout(timeout);
				process.off("message", listener);
				resolvePromise(record);
			}
		};
		process.on("message", listener);
		process.once("error", reject);
	});
}

function waitForExit(process: ChildProcess): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		process.once("error", reject);
		process.once("exit", (code) =>
			code === 0 ? resolvePromise() : reject(new Error(`D109F_CHILD_EXIT:${String(code)}`))
		);
	});
}

function plannerInput(
	records: readonly GenerationRecord[],
	head: PresentHead,
	closedEpoch: number
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		adoption: Object.freeze({ activeHead: head, adopted: true }),
		availabilityPolicyDigest: D109F_POLICY_DIGEST,
		close: Object.freeze({
			closedEpoch,
			commitQcRef: Object.freeze({ byteLength: 32, digest: "c".repeat(64) }),
			objectId: D109F_OBJECT_ID,
			verified: true,
		}),
		expectedHead: head,
		generations: records,
		issuance: Object.freeze({
			complete: true,
			lineage: Object.freeze({ exhausted: false, next: 1 }),
			prunedThroughAuthorSequence: null,
			rows: Object.freeze([
				Object.freeze({
					authorSequence: 0,
					epoch: closedEpoch,
					issued: true,
					outbox: true,
					publishState: "published" as const,
				}),
			]),
			scope: D109F_SCOPE,
			throughAuthorSequence: 0,
		}),
		snapshot: Object.freeze({ adopted: true, manifestDigest: "d".repeat(64) }),
	});
}

function aheInput(plan: Extract<D109fPlannerResult, { ok: true }>["plan"]): Readonly<Record<string, unknown>> {
	return Object.freeze({
		activeGenerationId: plan.activeGenerationId,
		availabilityPolicyDigest: plan.availabilityPolicyDigest,
		closedEpoch: plan.closedEpoch,
		expectedHead: plan.expectedHead,
		lineageFloor: plan.lineageFloor,
		objectId: plan.objectId,
		rollbackGenerationIds: plan.rollbackGenerationIds,
	});
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("D.109f Node differential exit RED", () => {
	it("rejects empty deletion with a present former parent before owner I/O", async () => {
		const modules = await aheModules();
		const store = modules.create({ filename: temporary("invalid-ahe") });
		try {
			let head: PresentHead | undefined;
			for (let index = 1; index <= 4; index += 1) head = await appendGeneration(store, index);
			if (head === undefined) throw new TypeError("D109F_HEAD_MISSING");
			const planner = await d109fPlanner();
			const result = planner(plannerInput(await allGenerations(store), head, 0));
			if (!result.ok) throw new TypeError(`D109F_PLANNER_REFUSED:${result.reason}`);
			const invalid = structuredClone(aheInput(result.plan)) as Record<string, unknown> & {
				lineageFloor: Record<string, unknown>;
			};
			invalid.lineageFloor.deleteGenerationIds = [];
			const owner = modules.resolve(store);
			if (owner === undefined) throw new TypeError("D109F_AHE_OWNER_MISSING");
			await expect(owner.reclaimClosedEpoch(invalid)).rejects.toSatisfy(
				(error: unknown) => d109fErrorCode(error) === "AHE_RECLAMATION_INVALID_ARGUMENT"
			);
		} finally {
			await store.close();
		}
	});

	it("executes 128 genuine compacted maintenance steps while the archival owner remains complete", async () => {
		const modules = await aheModules();
		const archivalFilename = temporary("archival-ahe");
		const compactedFilename = temporary("compacted-ahe");
		const archival = modules.create({ filename: archivalFilename });
		const compacted = modules.create({ filename: compactedFilename });
		try {
			const owner = modules.resolve(compacted);
			if (owner === undefined) throw new TypeError("D109F_AHE_OWNER_MISSING");
			const planner = await d109fPlanner();
			let archivalHead: PresentHead | undefined;
			let compactedHead: PresentHead | undefined;
			for (let index = 1; index <= 3; index += 1) {
				archivalHead = await appendGeneration(archival, index);
				compactedHead = await appendGeneration(compacted, index);
			}
			const receipts: Readonly<Record<string, unknown>>[] = [];
			for (let step = 0; step < D109F_STEP_COUNT; step += 1) {
				const index = step + 4;
				archivalHead = await appendGeneration(archival, index);
				compactedHead = await appendGeneration(compacted, index);
				const archivalPlan = planner(plannerInput(await allGenerations(archival), archivalHead, step));
				const compactedPlan = planner(plannerInput(await allGenerations(compacted), compactedHead, step));
				if (!archivalPlan.ok || !compactedPlan.ok) throw new TypeError(`D109F_PLANNER_REFUSED:${step}`);
				expect(compactedPlan.plan.lineageFloor.deleteGenerationIds).toHaveLength(1);
				expect(compactedPlan.plan.activeGenerationId).toBe(archivalPlan.plan.activeGenerationId);
				expect(compactedPlan.plan.rollbackGenerationIds).toEqual(archivalPlan.plan.rollbackGenerationIds);
				const receipt = await owner.reclaimClosedEpoch(aheInput(compactedPlan.plan));
				expect(receipt).toMatchObject({
					activeGenerationId: compactedPlan.plan.activeGenerationId,
					closedEpoch: step,
					deletedGenerationIds: compactedPlan.plan.lineageFloor.deleteGenerationIds,
					rollbackGenerationIds: compactedPlan.plan.rollbackGenerationIds,
				});
				receipts.push(receipt);
			}
			expect(receipts).toHaveLength(D109F_STEP_COUNT);
			expect(await allGenerations(archival)).toHaveLength(131);
			expect(await allGenerations(compacted)).toHaveLength(3);
			expect(successful(await archival.readHead(D109F_OBJECT_ID), "ARCHIVE_HEAD")).toEqual(
				successful(await compacted.readHead(D109F_OBJECT_ID), "COMPACT_HEAD")
			);
			const archivalCensus = {
				blobs: sqliteCount(archivalFilename, "SELECT COUNT(*) AS count FROM blobs"),
				generations: sqliteCount(archivalFilename, "SELECT COUNT(*) AS count FROM generations"),
				heads: sqliteCount(archivalFilename, "SELECT COUNT(*) AS count FROM objects WHERE head_record IS NOT NULL"),
				promotions: sqliteCount(
					archivalFilename,
					"SELECT COUNT(*) AS count FROM (SELECT object_id, generation_id FROM promotions GROUP BY object_id, generation_id)"
				),
				references: sqliteCount(archivalFilename, "SELECT COUNT(*) AS count FROM promotions"),
			};
			const compactedCensus = {
				blobs: sqliteCount(compactedFilename, "SELECT COUNT(*) AS count FROM blobs"),
				generations: sqliteCount(compactedFilename, "SELECT COUNT(*) AS count FROM generations"),
				heads: sqliteCount(compactedFilename, "SELECT COUNT(*) AS count FROM objects WHERE head_record IS NOT NULL"),
				promotions: sqliteCount(
					compactedFilename,
					"SELECT COUNT(*) AS count FROM (SELECT object_id, generation_id FROM promotions GROUP BY object_id, generation_id)"
				),
				references: sqliteCount(compactedFilename, "SELECT COUNT(*) AS count FROM promotions"),
			};
			expect(archivalCensus).toEqual({ blobs: 131, generations: 131, heads: 1, promotions: 131, references: 131 });
			expect(compactedCensus).toEqual({ blobs: 3, generations: 3, heads: 1, promotions: 3, references: 3 });
			expect(
				Object.keys(archivalCensus)
					.map((name) => `ahe.${name}`)
					.sort()
			).toEqual(D109F_PROOF_KIND_REGISTRY.filter(({ name }) => name.startsWith("ahe.")).map(({ name }) => name));
		} finally {
			await Promise.all([archival.close(), compacted.close()]);
		}
	});

	it("crosses the 64-row issuance boundary twice and preserves a numeric watermark", async () => {
		const modules = await issuanceModules();
		const filename = temporary("issuance-pages");
		const store = modules.create({ primaryFilename: filename });
		const owner = modules.resolve(store);
		if (owner === undefined) throw new TypeError("D109F_ISSUANCE_OWNER_MISSING");
		try {
			for (let index = 0; index < 65; index += 1) await d109bIssue(store as never, D109F_SCOPE, 0);
			for (let index = 0; index < 65; index += 1) await d109bIssue(store as never, D109F_SCOPE, 1);
			const before = await owner.inspectPruningState(D109F_SCOPE);
			const first = await owner.prunePublishedPrefix(d109bPruningInput(before as never, 0, 64));
			const middle = await owner.inspectPruningState(D109F_SCOPE);
			const second = await owner.prunePublishedPrefix(d109bPruningInput(middle as never, 1, 129));
			expect(first).toMatchObject({ deletedAuthorSequenceRange: { from: 0, through: 64 } });
			expect(second).toMatchObject({ deletedAuthorSequenceRange: { from: 65, through: 129 } });
			expect(await owner.inspectPruningState(D109F_SCOPE)).toMatchObject({
				lineage: { exhausted: false, next: 130 },
				prunedThroughAuthorSequence: 129,
			});
			const issuanceCensus = {
				issuedRecords: sqliteCount(
					`${filename}${ISSUANCE_DATABASE_SUFFIX}`,
					"SELECT COUNT(*) AS count FROM issued_records"
				),
				lineages: sqliteCount(`${filename}${ISSUANCE_DATABASE_SUFFIX}`, "SELECT COUNT(*) AS count FROM lineages"),
				outbox: sqliteCount(`${filename}${ISSUANCE_DATABASE_SUFFIX}`, "SELECT COUNT(*) AS count FROM issuance_outbox"),
				watermarks: sqliteCount(
					`${filename}${ISSUANCE_DATABASE_SUFFIX}`,
					"SELECT COUNT(*) AS count FROM lineages WHERE pruned_through_author_sequence = 129"
				),
			};
			expect(issuanceCensus).toEqual({ issuedRecords: 0, lineages: 1, outbox: 0, watermarks: 1 });
			expect(
				D109F_PROOF_KIND_REGISTRY.filter(({ name }) => name.startsWith("issuance.")).map(({ name }) => name)
			).toEqual(["issuance.issued-records", "issuance.lineage", "issuance.outbox", "issuance.watermark"]);
		} finally {
			await store.close();
		}
	});

	it("reopens in a fresh process and coordinates transaction release without timeout inference", async () => {
		const modules = await aheModules();
		const databaseFilename = temporary("fresh-process");
		const store = modules.create({ filename: databaseFilename });
		let input: Readonly<Record<string, unknown>>;
		try {
			let head: PresentHead | undefined;
			for (let index = 1; index <= 4; index += 1) head = await appendGeneration(store, index);
			if (head === undefined) throw new TypeError("D109F_HEAD_MISSING");
			const planned = (await d109fPlanner())(plannerInput(await allGenerations(store), head, 0));
			if (!planned.ok) throw new TypeError(`D109F_PLANNER_REFUSED:${planned.reason}`);
			input = aheInput(planned.plan);
		} finally {
			await store.close();
		}

		const holder = child("hold", databaseFilename);
		const holderExit = waitForExit(holder);
		await waitForMessage(holder, "held");
		const worker = child("reclaim", databaseFilename, Buffer.from(JSON.stringify(input)).toString("base64url"));
		const workerExit = waitForExit(worker);
		await waitForMessage(worker, "attempting");
		const released = waitForMessage(holder, "released");
		holder.send("release");
		await released;
		const reclaimed = await waitForMessage(worker, "reclaimed");
		await Promise.all([holderExit, workerExit]);
		expect(reclaimed.fresh).toMatchObject({ deletedGenerationIds: [d109fGenerationId(1)] });
		expect(reclaimed.replay).toMatchObject({ deletedGenerationIds: [] });

		const reopened = child("reopen", databaseFilename);
		const reopenedExit = waitForExit(reopened);
		const observation = await waitForMessage(reopened, "reopened");
		await reopenedExit;
		expect(observation.next).toMatchObject({ generationId: d109fGenerationId(5), revision: 5 });
	});

	it("returns a Promise before a closed Node inspection rejects", async () => {
		const modules = await issuanceModules();
		const store = modules.create({ primaryFilename: temporary("async-close") });
		const owner = modules.resolve(store);
		if (owner === undefined) throw new TypeError("D109F_ISSUANCE_OWNER_MISSING");
		await store.close();
		let promise: Promise<unknown> | undefined;
		expect(() => {
			promise = owner.inspectPruningState(D109F_SCOPE);
		}, "D109F_NODE_INSPECTION_THROWN_SYNCHRONOUSLY").not.toThrow();
		expect(promise).toBeInstanceOf(Promise);
		await expect(promise).rejects.toBeDefined();
	});

	it("runs the genuine close, adopt, reclaim and next-live golden paths in a fresh process", async () => {
		const result = await runFreshLifecycle();
		expect(result).toMatchObject({
			numFailedTests: 0,
			numPassedTests: 1,
			success: true,
		});
		const testResults = result.testResults as readonly Readonly<Record<string, unknown>>[];
		expect(testResults).toHaveLength(1);
		expect(String(testResults[0]?.name)).toBe(
			resolve(REPOSITORY_ROOT, "tests/phase-6b-runtime-reclamation-red.test.ts")
		);
		const assertionResults = testResults[0]?.assertionResults as readonly Readonly<Record<string, unknown>>[];
		expect(assertionResults.filter(({ status }) => status === "passed")).toEqual([
			expect.objectContaining({ status: "passed", title: D109F_LIFECYCLE_TITLE }),
		]);
	});
});
