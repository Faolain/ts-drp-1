import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	D109B_CRASH_EDGES,
	D109B_NODE_MIGRATION_CASES,
	D109B_SCOPE,
	d109bIssue,
	d109bPruningInput,
	type D109bNodeMaintenanceModule,
} from "../../../tests/fixtures/phase-6b/issuance-retention-contract.js";

const PACKAGE_DIRECTORY = path.resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = path.resolve(PACKAGE_DIRECTORY, "../..");
const REQUIRED_NODE_OWNERS = Object.freeze([
	"packages/storage-node/src/issuance-maintenance.ts",
	"packages/storage-node/src/internal/node-issuance-store.ts",
] as const);
const directories: string[] = [];

function readiness(): Readonly<{ readonly missing: readonly string[]; readonly ready: boolean }> {
	const missing = REQUIRED_NODE_OWNERS.filter((owner) => {
		const filename = path.resolve(REPOSITORY_ROOT, owner);
		if (!fs.existsSync(filename)) return true;
		return !fs.readFileSync(filename, "utf8").includes("pruned_through_author_sequence");
	});
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

function primary(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `d109b-node-${label}-`));
	directories.push(directory);
	return path.join(directory, "primary.sqlite");
}

async function modules(): Promise<{
	readonly issuance: {
		createNodeDurableIssuanceStore(options: {
			readonly primaryFilename: string;
		}): import("@ts-drp/issuance-store").DurableIssuanceStore;
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
