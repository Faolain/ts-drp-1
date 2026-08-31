import { encodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { PHASE_2L_C_DDL, PHASE_2L_C_V1_LINEAGES_DDL } from "./fixtures/phase-2l-c-node-issuance-contract.js";
import {
	D109B_CRASH_EDGES,
	D109B_NODE_MIGRATION_CASES,
	D109B_SCOPE,
	d109bCommit,
	d109bIssue,
	type D109bNodeMaintenanceModule,
	d109bPruningInput,
} from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

const PACKAGE_DIRECTORY = path.resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = path.resolve(PACKAGE_DIRECTORY, "../..");
const REQUIRED_NODE_OWNERS = Object.freeze([
	"packages/storage-node/src/issuance-maintenance.ts",
	"packages/storage-node/src/internal/node-issuance-store.ts",
] as const);
const directories: string[] = [];
const DATABASE_SUFFIX = ".drp-issuance-v1.sqlite";

function readiness(): Readonly<{ readonly missing: readonly string[]; readonly ready: boolean }> {
	const missing = REQUIRED_NODE_OWNERS.filter((owner) => {
		const filename = path.resolve(REPOSITORY_ROOT, owner);
		if (!fs.existsSync(filename)) return true;
		const source = fs.readFileSync(filename, "utf8");
		return owner.endsWith("issuance-maintenance.ts")
			? !source.includes("resolveNodeDurableIssuancePruningMaintenance")
			: !source.includes("pruned_through_author_sequence");
	});
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

function primary(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `d109b-node-${label}-`));
	directories.push(directory);
	return path.join(directory, "primary.sqlite");
}

function derived(primaryFilename: string): string {
	return `${primaryFilename}${DATABASE_SUFFIX}`;
}

function scalar(database: DatabaseSync, sql: string): unknown {
	const statement = database.prepare(sql);
	statement.setReadBigInts(false);
	const row = statement.get();
	return row === undefined ? undefined : Object.values(row)[0];
}

function catalog(database: DatabaseSync): readonly Record<string, unknown>[] {
	const statement = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name");
	statement.setReadBigInts(false);
	return statement.all();
}

function createV1Authority(primaryFilename: string, rows = 1): void {
	const database = new DatabaseSync(derived(primaryFilename));
	try {
		database.exec("PRAGMA page_size=4096");
		database.prepare("PRAGMA journal_mode=WAL").get();
		database.exec("BEGIN IMMEDIATE");
		database.exec(PHASE_2L_C_V1_LINEAGES_DDL);
		database.exec(PHASE_2L_C_DDL.issued_records);
		database.exec(PHASE_2L_C_DDL.issuance_outbox);
		if (rows > 0) {
			database
				.prepare("INSERT INTO lineages(object_id,author,next,exhausted) VALUES(?,?,?,?)")
				.run(D109B_SCOPE.objectId, D109B_SCOPE.author, rows, 0);
			const issued = database.prepare(
				"INSERT INTO issued_records(object_id,author,author_sequence,canonical_preimage,digest,signature) VALUES(?,?,?,?,?,?)"
			);
			const outbox = database.prepare(
				"INSERT INTO issuance_outbox(object_id,author,author_sequence,digest,publish_state) VALUES(?,?,?,?,?)"
			);
			for (let authorSequence = 0; authorSequence < rows; authorSequence += 1) {
				const commit = d109bCommit(D109B_SCOPE, authorSequence, 4);
				issued.run(
					D109B_SCOPE.objectId,
					D109B_SCOPE.author,
					authorSequence,
					commit.envelope.canonicalPreimageBytes,
					commit.envelope.digest,
					commit.envelope.signature
				);
				outbox.run(D109B_SCOPE.objectId, D109B_SCOPE.author, authorSequence, commit.envelope.digest, "published");
			}
		}
		database.exec("PRAGMA user_version=1");
		database.exec("COMMIT");
	} finally {
		database.close();
	}
}

async function childAdmission(childFixture: string, primaryFilename: string): Promise<void> {
	const children = [0, 1].map(() =>
		spawn(process.execPath, [childFixture, primaryFilename, "plain-barrier"], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		})
	);
	await Promise.all(
		children.map(
			(child) =>
				new Promise<void>((resolvePromise, reject) => {
					const timeout = setTimeout(() => reject(new Error("D109B_ADMISSION_READY_TIMEOUT")), 10_000);
					child.once("error", reject);
					child.on("message", (message: { readonly kind?: string; readonly message?: string }) => {
						if (message.kind === "ready") {
							clearTimeout(timeout);
							resolvePromise();
						}
						if (message.kind === "child-error") reject(new Error(message.message));
					});
				})
		)
	);
	for (const child of children) child.send("start");
	await Promise.all(
		children.map(
			(child) =>
				new Promise<void>((resolvePromise, reject) => {
					let admitted = false;
					let stderr = "";
					const timeout = setTimeout(() => {
						child.kill("SIGKILL");
						reject(new Error(`D109B_ADMISSION_TIMEOUT:${stderr}`));
					}, 15_000);
					child.stderr?.setEncoding("utf8");
					child.stderr?.on("data", (value: string) => (stderr += value));
					child.once("error", reject);
					child.on("message", (message: { readonly kind?: string; readonly message?: string }) => {
						if (message.kind === "admitted") admitted = true;
						if (message.kind === "child-error") reject(new Error(message.message));
					});
					child.once("exit", (code) => {
						clearTimeout(timeout);
						if (code === 0 && admitted) resolvePromise();
						else reject(new Error(`D109B_ADMISSION_EXIT:${String(code)}:${stderr}`));
					});
				})
		)
	);
}

async function modules(): Promise<{
	readonly issuance: {
		createNodeDurableIssuanceStore(options: { readonly primaryFilename: string }): DurableIssuanceStore;
	};
	readonly maintenance: D109bNodeMaintenanceModule;
}> {
	const [issuance, maintenance] = await Promise.all([
		import(pathToFileURL(path.resolve(PACKAGE_DIRECTORY, "src/issuance.ts")).href),
		import(pathToFileURL(path.resolve(PACKAGE_DIRECTORY, "src/issuance-maintenance.ts")).href),
	]);
	return { issuance, maintenance } as never;
}

const state = readiness();

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("D.109b Node issuance-retention RED", () => {
	it("freezes the ten migration cases and six genuine process-death boundaries", () => {
		expect(D109B_NODE_MIGRATION_CASES).toHaveLength(10);
		expect(D109B_CRASH_EDGES).toEqual([
			"before-delete",
			"after-issued-delete",
			"after-pair-delete",
			"after-watermark-write",
			"before-commit",
			"after-commit",
		]);
	});

	it("[RED readiness] requires the Node maintenance owner and v2 watermark schema", () => {
		expect(state, "D109B_NODE_MAINTENANCE_MISSING").toEqual({ missing: [], ready: true });
	});

	it.skipIf(!state.ready)("prunes and reopens the same derived authority without changing its facade", async () => {
		const { issuance, maintenance: maintenanceModule } = await modules();
		const primaryFilename = primary("reopen");
		const store = issuance.createNodeDurableIssuanceStore({ primaryFilename });
		const maintenance = maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(store);
		expect(maintenance).toBeDefined();
		expect(maintenanceModule.resolveNodeDurableIssuancePruningMaintenance({ ...store })).toBeUndefined();
		expect(maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(new Proxy(store, {}))).toBeUndefined();
		const conformance = await import("@ts-drp/issuance-store/conformance");
		const foreignStore = conformance.createEphemeralDurableIssuanceStore();
		expect(maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(foreignStore)).toBeUndefined();
		await foreignStore.close();
		if (maintenance === undefined) return;
		await d109bIssue(store, D109B_SCOPE, 4);
		const before = await maintenance.inspectPruningState(D109B_SCOPE);
		await maintenance.prunePublishedPrefix(d109bPruningInput(before, 4, 0));
		await store.close();
		const reopened = issuance.createNodeDurableIssuanceStore({ primaryFilename });
		try {
			const reopenedMaintenance = maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(reopened);
			expect(await reopenedMaintenance?.inspectPruningState(D109B_SCOPE)).toMatchObject({
				lineage: { exhausted: false, next: 1 },
				prunedThroughAuthorSequence: 0,
			});
			expect(await reopened.readIssued(D109B_SCOPE, 0)).toBeNull();
		} finally {
			await reopened.close();
		}
	});

	it.skipIf(!state.ready).each([
		[
			"canonical-malformed",
			(database: DatabaseSync): unknown =>
				database
					.prepare("UPDATE issued_records SET canonical_preimage=? WHERE author_sequence=0")
					.run(Uint8Array.of(0)),
			"ISSUANCE_RECOVERY_CORRUPT",
		],
		[
			"vertex-kind-wrong",
			(database: DatabaseSync): unknown =>
				database.prepare("UPDATE issued_records SET canonical_preimage=? WHERE author_sequence=0").run(
					encodeCanonical({
						...D109B_SCOPE,
						authorSequence: 0,
						epoch: 4,
						kind: "not-a-vertex",
						protocolMajor: 3,
					})
				),
			"ISSUANCE_RECOVERY_CORRUPT",
		],
		[
			"protocol-major-wrong",
			(database: DatabaseSync): unknown =>
				database.prepare("UPDATE issued_records SET canonical_preimage=? WHERE author_sequence=0").run(
					encodeCanonical({
						...D109B_SCOPE,
						authorSequence: 0,
						epoch: 4,
						kind: "drp-vertex",
						protocolMajor: 2,
					})
				),
			"ISSUANCE_RECOVERY_CORRUPT",
		],
		[
			"scope-wrong",
			(database: DatabaseSync): unknown =>
				database.prepare("UPDATE issued_records SET canonical_preimage=? WHERE author_sequence=0").run(
					encodeCanonical({
						...D109B_SCOPE,
						author: "z".repeat(64),
						authorSequence: 0,
						epoch: 4,
						kind: "drp-vertex",
						protocolMajor: 3,
					})
				),
			"ISSUANCE_RECOVERY_CORRUPT",
		],
		[
			"ordinal-wrong",
			(database: DatabaseSync): unknown =>
				database.prepare("UPDATE issued_records SET canonical_preimage=? WHERE author_sequence=0").run(
					encodeCanonical({
						...D109B_SCOPE,
						authorSequence: 1,
						epoch: 4,
						kind: "drp-vertex",
						protocolMajor: 3,
					})
				),
			"ISSUANCE_RECOVERY_CORRUPT",
		],
		[
			"epoch-wrong",
			(database: DatabaseSync): unknown =>
				database.prepare("UPDATE issued_records SET canonical_preimage=? WHERE author_sequence=0").run(
					encodeCanonical({
						...D109B_SCOPE,
						authorSequence: 0,
						epoch: 5,
						kind: "drp-vertex",
						protocolMajor: 3,
					})
				),
			"ISSUANCE_INVALID_ARGUMENT",
		],
		[
			"issued-only",
			(database: DatabaseSync): unknown =>
				database.prepare("DELETE FROM issuance_outbox WHERE author_sequence=0").run(),
			"ISSUANCE_RECOVERY_CORRUPT",
		],
		[
			"outbox-only",
			(database: DatabaseSync): unknown => database.prepare("DELETE FROM issued_records WHERE author_sequence=0").run(),
			"ISSUANCE_RECOVERY_CORRUPT",
		],
		[
			"digest-mismatch",
			(database: DatabaseSync): unknown =>
				database.prepare("UPDATE issuance_outbox SET digest=? WHERE author_sequence=0").run(Uint8Array.of(255)),
			"ISSUANCE_RECOVERY_CORRUPT",
		],
		[
			"sequence-gap",
			(database: DatabaseSync): void => {
				database.prepare("DELETE FROM issued_records WHERE author_sequence=1").run();
				database.prepare("DELETE FROM issuance_outbox WHERE author_sequence=1").run();
			},
			"ISSUANCE_RECOVERY_CORRUPT",
		],
		[
			"epoch-regression",
			(database: DatabaseSync): unknown =>
				database.prepare("UPDATE issued_records SET canonical_preimage=? WHERE author_sequence=1").run(
					encodeCanonical({
						...D109B_SCOPE,
						authorSequence: 1,
						epoch: 3,
						kind: "drp-vertex",
						protocolMajor: 3,
					})
				),
			"ISSUANCE_INVALID_ARGUMENT",
		],
	] as const)("refuses native mutant %s with zero pruning writes", async (_mutant, mutate, expectedCode) => {
		const { issuance, maintenance: maintenanceModule } = await modules();
		const primaryFilename = primary(_mutant);
		const seeded = issuance.createNodeDurableIssuanceStore({ primaryFilename });
		for (let index = 0; index < 3; index += 1) await d109bIssue(seeded, D109B_SCOPE, 4);
		await seeded.close();
		const raw = new DatabaseSync(derived(primaryFilename));
		mutate(raw);
		const before = {
			issued: scalar(raw, "SELECT count(*) FROM issued_records"),
			outbox: scalar(raw, "SELECT count(*) FROM issuance_outbox"),
			watermark: scalar(raw, "SELECT pruned_through_author_sequence FROM lineages"),
		};
		raw.close();

		const store = issuance.createNodeDurableIssuanceStore({ primaryFilename });
		const owner = maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(store);
		if (owner === undefined) throw new TypeError("D109B_NODE_MAINTENANCE_MISSING");
		const observed = await owner.inspectPruningState(D109B_SCOPE);
		const error = await new Promise<unknown>((resolvePromise) => {
			void owner.prunePublishedPrefix(d109bPruningInput(observed, 4, 2)).then(
				() => resolvePromise(undefined),
				(value) => resolvePromise(value)
			);
		});
		expect(Reflect.get(error as object, "code")).toBe(expectedCode);
		if (expectedCode === "ISSUANCE_RECOVERY_CORRUPT") {
			await expect(store.readLineage(D109B_SCOPE)).rejects.toBe(error);
		} else {
			await expect(store.readLineage(D109B_SCOPE)).resolves.toEqual({ exhausted: false, next: 3 });
		}
		await store.close();
		const afterDatabase = new DatabaseSync(derived(primaryFilename), { readOnly: true });
		try {
			expect({
				issued: scalar(afterDatabase, "SELECT count(*) FROM issued_records"),
				outbox: scalar(afterDatabase, "SELECT count(*) FROM issuance_outbox"),
				watermark: scalar(afterDatabase, "SELECT pruned_through_author_sequence FROM lineages"),
			}).toEqual(before);
		} finally {
			afterDatabase.close();
		}
	});

	it.skipIf(!state.ready).each([
		["delete-count-mismatch", /^DELETE FROM issued_records\b/u],
		["watermark-update-count-mismatch", /^UPDATE lineages SET pruned_through_author_sequence=/u],
	] as const)("rolls back the injected %s owner-count mutant", async (label, target) => {
		const { issuance, maintenance: maintenanceModule } = await modules();
		const primaryFilename = primary(label);
		const store = issuance.createNodeDurableIssuanceStore({ primaryFilename });
		await d109bIssue(store, D109B_SCOPE, 4);
		const owner = maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(store);
		if (owner === undefined) throw new TypeError("D109B_NODE_MAINTENANCE_MISSING");
		const observed = await owner.inspectPruningState(D109B_SCOPE);
		const originalPrepare = DatabaseSync.prototype.prepare;
		DatabaseSync.prototype.prepare = function (sql: string): StatementSync {
			const prepared = originalPrepare.call(this, sql);
			if (!target.test(sql)) return prepared;
			return new Proxy(prepared, {
				get(statement, property): unknown {
					const value = Reflect.get(statement, property, statement);
					if (property !== "run" || typeof value !== "function") {
						return typeof value === "function" ? value.bind(statement) : value;
					}
					return (...parameters: unknown[]) => {
						const result = Reflect.apply(value, statement, parameters) as object;
						return { ...result, changes: 0 };
					};
				},
			}) as StatementSync;
		};
		let error: unknown;
		try {
			error = await owner.prunePublishedPrefix(d109bPruningInput(observed, 4, 0)).catch((value) => value);
		} finally {
			DatabaseSync.prototype.prepare = originalPrepare;
		}
		expect(Reflect.get(error as object, "code")).toBe("ISSUANCE_RECOVERY_CORRUPT");
		await store.close();
		const reopened = issuance.createNodeDurableIssuanceStore({ primaryFilename });
		try {
			expect(await reopened.readIssued(D109B_SCOPE, 0)).not.toBeNull();
			const reopenedOwner = maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(reopened);
			if (reopenedOwner === undefined) throw new TypeError("D109B_NODE_MAINTENANCE_MISSING");
			expect((await reopenedOwner.inspectPruningState(D109B_SCOPE)).prunedThroughAuthorSequence).toBeNull();
		} finally {
			await reopened.close();
		}
	});

	it.skipIf(!state.ready)("serializes two live handles and rejects a genuinely stale watermark extension", async () => {
		const { issuance, maintenance: maintenanceModule } = await modules();
		const primaryFilename = primary("stale-handle");
		const first = issuance.createNodeDurableIssuanceStore({ primaryFilename });
		await d109bIssue(first, D109B_SCOPE, 4);
		await d109bIssue(first, D109B_SCOPE, 4);
		const second = issuance.createNodeDurableIssuanceStore({ primaryFilename });
		try {
			const firstOwner = maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(first);
			const secondOwner = maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(second);
			if (firstOwner === undefined || secondOwner === undefined) throw new TypeError("D109B_NODE_MAINTENANCE_MISSING");
			const stale = await secondOwner.inspectPruningState(D109B_SCOPE);
			await firstOwner.prunePublishedPrefix(d109bPruningInput(stale, 4, 0));
			await expect(secondOwner.prunePublishedPrefix(d109bPruningInput(stale, 4, 1))).rejects.toMatchObject({
				code: "ISSUANCE_RETRY_REQUIRED",
			});
			const refreshed = await secondOwner.inspectPruningState(D109B_SCOPE);
			expect(refreshed.prunedThroughAuthorSequence).toBe(0);
			await expect(secondOwner.prunePublishedPrefix(d109bPruningInput(refreshed, 4, 1))).resolves.toMatchObject({
				deletedAuthorSequenceRange: { from: 1, through: 1 },
			});
		} finally {
			await first.close();
			await second.close();
		}
	});

	it.skipIf(!state.ready)("migrates the exact v1 authority in place and preserves every issuance row", async () => {
		const { issuance, maintenance: maintenanceModule } = await modules();
		const primaryFilename = primary("v1-migration");
		createV1Authority(primaryFilename, 2);
		const filename = derived(primaryFilename);
		const inode = fs.statSync(filename).ino;
		const before = new DatabaseSync(filename, { readOnly: true });
		try {
			expect(scalar(before, "PRAGMA user_version")).toBe(1);
			expect(catalog(before).find(({ name }) => name === "lineages")?.sql).toBe(PHASE_2L_C_V1_LINEAGES_DDL);
		} finally {
			before.close();
		}

		const store = issuance.createNodeDurableIssuanceStore({ primaryFilename });
		try {
			const owner = maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(store);
			expect(await owner?.inspectPruningState(D109B_SCOPE)).toEqual({
				lineage: { exhausted: false, next: 2 },
				prunedThroughAuthorSequence: null,
				scope: D109B_SCOPE,
			});
			expect((await store.readOutboxPage({ scope: D109B_SCOPE })).map(({ commit }) => commit.authorSequence)).toEqual([
				0, 1,
			]);
		} finally {
			await store.close();
		}
		expect(fs.statSync(filename).ino).toBe(inode);
		const after = new DatabaseSync(filename, { readOnly: true });
		try {
			expect(scalar(after, "PRAGMA user_version")).toBe(2);
			expect(catalog(after).find(({ name }) => name === "lineages")?.sql).toBe(PHASE_2L_C_DDL.lineages);
			expect(scalar(after, "SELECT count(*) FROM issued_records")).toBe(2);
			expect(scalar(after, "SELECT count(*) FROM issuance_outbox")).toBe(2);
			expect(scalar(after, "SELECT count(*) FROM lineages WHERE pruned_through_author_sequence IS NULL")).toBe(1);
		} finally {
			after.close();
		}

		const reopened = issuance.createNodeDurableIssuanceStore({ primaryFilename });
		await reopened.close();
		expect(fs.statSync(filename).ino).toBe(inode);
	});

	it.skipIf(!state.ready)(
		"rolls back a failed v1 migration and admits two racing v1 openers exactly once",
		async () => {
			const { issuance } = await modules();
			const failedPrimary = primary("v1-rollback");
			createV1Authority(failedPrimary, 1);
			const originalExec = DatabaseSync.prototype.exec;
			let injected = false;
			DatabaseSync.prototype.exec = function (sql: string): void {
				if (!injected && /^INSERT INTO lineages .* SELECT /u.test(sql)) {
					injected = true;
					throw new Error("D109B_MIGRATION_INJECTED_FAILURE");
				}
				return originalExec.call(this, sql);
			};
			try {
				expect(() => issuance.createNodeDurableIssuanceStore({ primaryFilename: failedPrimary })).toThrow(
					expect.objectContaining({ code: "ISSUANCE_SUBSTRATE_FAILURE" })
				);
			} finally {
				DatabaseSync.prototype.exec = originalExec;
			}
			expect(injected).toBe(true);
			const rolledBack = new DatabaseSync(derived(failedPrimary), { readOnly: true });
			try {
				expect(scalar(rolledBack, "PRAGMA user_version")).toBe(1);
				expect(catalog(rolledBack).find(({ name }) => name === "lineages")?.sql).toBe(PHASE_2L_C_V1_LINEAGES_DDL);
				expect(scalar(rolledBack, "SELECT count(*) FROM issued_records")).toBe(1);
			} finally {
				rolledBack.close();
			}

			const racingPrimary = primary("v1-race");
			createV1Authority(racingPrimary, 1);
			await childAdmission(
				path.resolve(import.meta.dirname, "fixtures/phase-2l-c-node-admission-child.mjs"),
				racingPrimary
			);
			const raced = new DatabaseSync(derived(racingPrimary), { readOnly: true });
			try {
				expect(scalar(raced, "PRAGMA user_version")).toBe(2);
				expect(catalog(raced).find(({ name }) => name === "lineages")?.sql).toBe(PHASE_2L_C_DDL.lineages);
				expect(scalar(raced, "SELECT count(*) FROM issued_records")).toBe(1);
				expect(scalar(raced, "SELECT count(*) FROM lineages WHERE pruned_through_author_sequence IS NULL")).toBe(1);
			} finally {
				raced.close();
			}
		}
	);

	it.skipIf(!state.ready)("rejects unknown versions and catalogs without repairing either authority", async () => {
		const { issuance } = await modules();
		const unknownVersion = primary("unknown-version");
		createV1Authority(unknownVersion, 0);
		const versionDatabase = new DatabaseSync(derived(unknownVersion));
		versionDatabase.exec("PRAGMA user_version=3");
		versionDatabase.close();
		expect(() => issuance.createNodeDurableIssuanceStore({ primaryFilename: unknownVersion })).toThrow(
			expect.objectContaining({ code: "ISSUANCE_UNSUPPORTED_SCHEMA" })
		);
		const versionAfter = new DatabaseSync(derived(unknownVersion), { readOnly: true });
		try {
			expect(scalar(versionAfter, "PRAGMA user_version")).toBe(3);
			expect(catalog(versionAfter).find(({ name }) => name === "lineages")?.sql).toBe(PHASE_2L_C_V1_LINEAGES_DDL);
		} finally {
			versionAfter.close();
		}

		const unknownCatalog = primary("unknown-catalog");
		createV1Authority(unknownCatalog, 0);
		const catalogDatabase = new DatabaseSync(derived(unknownCatalog));
		catalogDatabase.exec("CREATE TABLE unexpected (id TEXT PRIMARY KEY)");
		catalogDatabase.close();
		expect(() => issuance.createNodeDurableIssuanceStore({ primaryFilename: unknownCatalog })).toThrow(
			expect.objectContaining({ code: "ISSUANCE_UNSUPPORTED_SCHEMA" })
		);
		const catalogAfter = new DatabaseSync(derived(unknownCatalog), { readOnly: true });
		try {
			expect(scalar(catalogAfter, "PRAGMA user_version")).toBe(1);
			expect(catalog(catalogAfter).map(({ name }) => name)).toContain("unexpected");
		} finally {
			catalogAfter.close();
		}
	});

	it.skipIf(!state.ready)("recovers old XOR complete-new state at every frozen hard-kill edge", async () => {
		const childFixture = path.resolve(import.meta.dirname, "fixtures/phase-6b-issuance-retention-child.mjs");
		const { issuance, maintenance: maintenanceModule } = await modules();
		for (const edge of D109B_CRASH_EDGES) {
			const primaryFilename = primary(edge);
			const child = spawn(process.execPath, [childFixture, primaryFilename, edge], {
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			let checkpointed = false;
			let stderr = "";
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (value: string) => (stderr += value));
			await new Promise<void>((resolvePromise, reject) => {
				const timeout = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`D109B_NODE_CHILD_TIMEOUT:${edge}:${stderr}`));
				}, 15_000);
				child.on(
					"message",
					(message: { readonly edge?: string; readonly kind?: string; readonly message?: string }) => {
						if (message.kind === "child-error") reject(new Error(message.message));
						if (message.kind === "checkpoint" && message.edge === edge) {
							checkpointed = true;
							child.kill("SIGKILL");
						}
					}
				);
				child.once("error", reject);
				child.once("exit", (_code, signal) => {
					clearTimeout(timeout);
					if (!checkpointed || signal !== "SIGKILL") reject(new Error(`D109B_NODE_CHILD_CUSTODY:${edge}`));
					else resolvePromise();
				});
			});
			const reopened = issuance.createNodeDurableIssuanceStore({ primaryFilename });
			try {
				const owner = maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(reopened);
				if (owner === undefined) throw new TypeError("D109B_NODE_MAINTENANCE_MISSING");
				const observed = await owner.inspectPruningState(D109B_SCOPE);
				const rows = await reopened.readOutboxPage({ scope: D109B_SCOPE });
				expect({ rows: rows.length, watermark: observed.prunedThroughAuthorSequence }, edge).toEqual(
					edge === "after-commit" ? { rows: 0, watermark: 1 } : { rows: 2, watermark: null }
				);
			} finally {
				await reopened.close();
			}
		}
	});
});
