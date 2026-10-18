import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
	derivedFilename,
	loadPhase2lCNodeModule,
	phase2lCCommit,
	type Phase2lCDeathTuple,
	PHASE_2L_C_DEATH_TUPLES,
	PHASE_2L_C_SCOPE,
} from "./fixtures/phase-2l-c-node-issuance-contract.js";
import type { DurableIssuanceStore } from "../../issuance-store/dist/src/index.js";

const childFixture = new URL("./fixtures/phase-2l-c-node-death-child.mjs", import.meta.url);
const admissionFixture = new URL("./fixtures/phase-2l-c-node-admission-child.mjs", import.meta.url);
const preloadControlFixture = new URL("./fixtures/phase-2l-c-sqlite-preload-control.mjs", import.meta.url);
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

function primary(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-2l-c-death-${label}-`));
	directories.push(directory);
	return path.join(directory, "primary.sqlite");
}

function pragma(database: DatabaseSync, name: string): unknown {
	const statement = database.prepare(`PRAGMA ${name}`);
	statement.setReadBigInts(false);
	const row = statement.get();
	return row === undefined ? undefined : Object.values(row)[0];
}

interface ChildMessage {
	readonly changes?: number;
	readonly edge?: string;
	readonly kind: string;
	readonly message?: string;
	readonly parameters?: readonly unknown[];
	readonly sql?: string | null;
}

function runKilled(
	tuple: Phase2lCDeathTuple,
	primaryFilename: string
): Promise<{
	readonly messages: readonly ChildMessage[];
	readonly signal: NodeJS.Signals | null;
}> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [childFixture.pathname, primaryFilename, JSON.stringify(tuple)], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const messages: ChildMessage[] = [];
		let armed = false;
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Phase 2l-c death timeout ${tuple.id}: ${stderr}`));
		}, 10_000);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: ChildMessage) => {
			messages.push(message);
			if (message.kind === "child-error") {
				clearTimeout(timeout);
				reject(new Error(`${tuple.id}: ${message.message}`));
			} else if (message.kind === "checkpoint" && message.edge === tuple.edge && !armed) {
				armed = true;
				child.kill("SIGKILL");
			}
		});
		child.once("error", reject);
		child.once("exit", (_code, signal) => {
			clearTimeout(timeout);
			if (!armed) reject(new Error(`${tuple.id}: child exited before its exact checkpoint: ${stderr}`));
			else resolve({ messages, signal });
		});
	});
}

interface RecoveredState {
	readonly issued0: Awaited<ReturnType<DurableIssuanceStore["readIssued"]>>;
	readonly issued1: Awaited<ReturnType<DurableIssuanceStore["readIssued"]>>;
	readonly lineage: Awaited<ReturnType<DurableIssuanceStore["readLineage"]>>;
	readonly outbox: Awaited<ReturnType<DurableIssuanceStore["readOutboxPage"]>>;
	readonly walBytes: number;
}

async function recovered(primaryFilename: string): Promise<RecoveredState> {
	const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
	const filename = derivedFilename(primaryFilename);
	const wal = `${filename}-wal`;
	const walBytes = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
	const store = createNodeDurableIssuanceStore({ primaryFilename });
	try {
		return {
			issued0: await store.readIssued(PHASE_2L_C_SCOPE, 0),
			issued1: await store.readIssued(PHASE_2L_C_SCOPE, 1),
			lineage: await store.readLineage(PHASE_2L_C_SCOPE),
			outbox: await store.readOutboxPage(),
			walBytes,
		};
	} finally {
		await store.close();
	}
}

describe("Phase 2l-c genuine Node issuance process death", () => {
	it("proves the private preload arms after native DDL/COMMIT and the parent owns genuine SIGKILL custody", async () => {
		let sawNonemptyWal = false;
		for (const edge of ["admission-ddl", "commit"] as const) {
			const filename = derivedFilename(primary(`preload-control-${edge}`));
			const child = spawn(process.execPath, [preloadControlFixture.pathname, filename, edge], {
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			const messages: ChildMessage[] = [];
			const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
				const timeout = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`preload control timeout ${edge}`));
				}, 5_000);
				child.once("error", reject);
				child.on("message", (message: ChildMessage) => {
					messages.push(message);
					if (message.kind === "checkpoint" && message.edge === edge) child.kill("SIGKILL");
				});
				child.once("exit", (_code, killedBy) => {
					clearTimeout(timeout);
					resolve(killedBy);
				});
			});
			expect(signal).toBe("SIGKILL");
			expect(messages.filter(({ kind }) => kind === "checkpoint")).toHaveLength(1);
			expect(messages.some(({ kind }) => kind === "unexpected-result")).toBe(false);
			sawNonemptyWal ||= fs.statSync(`${filename}-wal`).size > 0;
			const reopened = new DatabaseSync(filename);
			const catalog = reopened.prepare("SELECT count(*) AS count FROM sqlite_schema").get() as { count: number };
			if (edge === "admission-ddl") expect(catalog.count).toBe(0);
			else {
				expect(catalog.count).toBe(1);
				expect(reopened.prepare("SELECT id FROM control_value").get()).toEqual({ id: 1 });
			}
			reopened.close();
		}
		expect(sawNonemptyWal).toBe(true);
	});

	it("hard-kills all exact 18 statement tuples and reopens old XOR exact-new without deleting WAL", async () => {
		const expectedTrace: Record<Phase2lCDeathTuple["edge"], readonly string[]> = {
			"begin": ["begin"],
			"commit": ["begin", "state-select", "lineage-write", "issued-insert", "outbox-insert", "commit"],
			"issued-insert": ["begin", "state-select", "lineage-write", "issued-insert"],
			"lineage-write": ["begin", "state-select", "lineage-write"],
			"outbox-insert": ["begin", "state-select", "lineage-write", "issued-insert", "outbox-insert"],
			"postbuild": ["postbuild"],
			"rollback": ["begin", "state-select", "rollback"],
			"state-select": ["begin", "state-select"],
			"suspended-build": ["suspended-build"],
		};
		const evidence: Array<{
			recovery: RecoveredState;
			tuple: Phase2lCDeathTuple;
		}> = [];
		for (const tuple of PHASE_2L_C_DEATH_TUPLES) {
			const primaryFilename = primary(tuple.id.replace("/", "-"));
			const killed = await runKilled(tuple, primaryFilename);
			expect.soft(killed.signal, tuple.id).toBe("SIGKILL");
			expect
				.soft(
					killed.messages.filter(({ kind }) => kind === "checkpoint"),
					tuple.id
				)
				.toHaveLength(1);
			expect
				.soft(
					killed.messages.filter(({ kind }) => kind === "trace").map(({ edge }) => edge),
					tuple.id
				)
				.toEqual(expectedTrace[tuple.edge]);
			expect
				.soft(
					killed.messages.some(({ kind }) => kind === "unexpected-result"),
					tuple.id
				)
				.toBe(false);
			for (const message of killed.messages.filter(
				(value) =>
					value.kind === "trace" && ["lineage-write", "issued-insert", "outbox-insert"].includes(value.edge ?? "")
			)) {
				expect.soft(message.changes, `${tuple.id}/${message.edge}`).toBe(1);
				expect.soft(message.parameters?.length, `${tuple.id}/${message.edge}/parameters`).toBeGreaterThan(0);
				if (tuple.scenario === "existing-lineage" && message.edge === "lineage-write") {
					expect
						.soft(message.sql?.trim().replace(/\s+/gu, " "), `${tuple.id}/exact-prior-sql`)
						.toMatch(
							/^UPDATE lineages SET next\s*=\s*\?,\s*exhausted\s*=\s*\? WHERE object_id\s*=\s*\? AND author\s*=\s*\? AND next\s*=\s*\? AND exhausted\s*=\s*\?$/iu
						);
					expect
						.soft(message.parameters, `${tuple.id}/exact-prior-parameters`)
						.toEqual([2, 0, "room:alpha", "alice", 1, 0]);
				}
			}
			const recovery = await recovered(primaryFilename);
			const existing = tuple.scenario === "existing-lineage";
			const expectedOld = {
				issued0: existing ? phase2lCCommit(0, 3) : null,
				issued1: null,
				lineage: { exhausted: false, next: existing ? 1 : 0 },
				outbox: existing ? [{ commit: phase2lCCommit(0, 3), publishState: "pending" }] : [],
			};
			const expectedNew = {
				issued0: existing ? phase2lCCommit(0, 3) : phase2lCCommit(0),
				issued1: existing ? phase2lCCommit(1) : null,
				lineage: { exhausted: false, next: existing ? 2 : 1 },
				outbox: existing
					? [
							{ commit: phase2lCCommit(0, 3), publishState: "pending" },
							{ commit: phase2lCCommit(1), publishState: "pending" },
						]
					: [{ commit: phase2lCCommit(0), publishState: "pending" }],
			};
			const { walBytes: _walBytes, ...durable } = recovery;
			expect.soft(durable, tuple.id).toEqual(tuple.terminalFate === "old" ? expectedOld : expectedNew);
			evidence.push({ recovery, tuple });
		}
		expect(evidence).toHaveLength(18);
		expect(evidence.some(({ recovery }) => recovery.walBytes > 0)).toBe(true);
	});

	it("keeps empty-catalog/version-zero admission retryable after bounded pre-capability death", async () => {
		const primaryFilename = primary("admission-kill");
		const child = spawn(process.execPath, [admissionFixture.pathname, primaryFilename], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const killed = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("Phase 2l-c admission death timeout"));
			}, 10_000);
			child.on("message", (message: ChildMessage) => {
				if (message.kind === "child-error") reject(new Error(String(message.message)));
				if (message.kind === "checkpoint" && message.edge === "admission-ddl") child.kill("SIGKILL");
			});
			child.once("error", reject);
			child.once("exit", (_code, signal) => {
				clearTimeout(timeout);
				resolve(signal);
			});
		});
		expect(killed).toBe("SIGKILL");
		const filename = derivedFilename(primaryFilename);
		const raw = new DatabaseSync(filename);
		expect(pragma(raw, "user_version")).toBe(0);
		const catalog = raw.prepare("SELECT count(*) AS count FROM sqlite_schema").get() as { count: number };
		expect(catalog.count).toBe(0);
		raw.close();
		const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
		const store = createNodeDurableIssuanceStore({ primaryFilename });
		await store.close();
		const reopened = createNodeDurableIssuanceStore({ primaryFilename });
		await expect(reopened.readLineage({ author: "alice", objectId: "room:alpha" })).resolves.toEqual({
			exhausted: false,
			next: 0,
		});
		await reopened.close();
	});
});
