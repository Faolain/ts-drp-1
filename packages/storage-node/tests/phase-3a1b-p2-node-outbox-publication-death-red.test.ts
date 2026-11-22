import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadPhase2lCNodeModule } from "./fixtures/phase-2l-c-node-issuance-contract.js";
import {
	assertExactDeathRegistry,
	expectedPhase3a1bP2Snapshot,
	type Phase3a1bP2DeathTuple,
	type Phase3a1bP2PublicationSnapshot,
	type Phase3a1bP2Store,
	PHASE_3A1B_P2_DEATH_TUPLES,
	PHASE_3A1B_P2_OTHER_SCOPE,
	PHASE_3A1B_P2_SCOPE,
	snapshotPhase3a1bP2Store,
} from "../../../tests/fixtures/phase-3a1b-p2-outbox-publication-contract.js";

const childFixture = new URL("./fixtures/phase-3a1b-p2-node-publication-child.mjs", import.meta.url);
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

function primary(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-3a1b-p2-death-${label}-`));
	directories.push(directory);
	return path.join(directory, "primary.sqlite");
}

interface ChildMessage {
	readonly edge?: string;
	readonly kind: string;
	readonly message?: string;
}

function killAt(tuple: Phase3a1bP2DeathTuple, primaryFilename: string): Promise<readonly ChildMessage[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [childFixture.pathname, primaryFilename, JSON.stringify(tuple)], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const messages: ChildMessage[] = [];
		let armed = false;
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new TypeError(`Seam 2 Node death timeout ${tuple.id}: ${stderr}`));
		}, 15_000);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => (stderr += chunk));
		child.on("message", (message: ChildMessage) => {
			messages.push(message);
			if (message.kind === "child-error") {
				clearTimeout(timeout);
				reject(new TypeError(`${tuple.id}: ${message.message}`));
			} else if (message.kind === "checkpoint" && message.edge === tuple.edge && !armed) {
				armed = true;
				child.kill("SIGKILL");
			}
		});
		child.once("error", reject);
		child.once("exit", (_code, signal) => {
			clearTimeout(timeout);
			if (!armed) reject(new TypeError(`${tuple.id}: child exited before checkpoint: ${stderr}`));
			else if (signal !== "SIGKILL") reject(new TypeError(`${tuple.id}: expected SIGKILL, got ${String(signal)}`));
			else resolve(messages);
		});
	});
}

async function recover(
	primaryFilename: string,
	tuple: Phase3a1bP2DeathTuple
): Promise<Readonly<{ counts: readonly number[]; snapshot: Phase3a1bP2PublicationSnapshot }>> {
	const { createNodeDurableIssuanceStore } = await loadPhase2lCNodeModule();
	const store = createNodeDurableIssuanceStore({ primaryFilename }) as unknown as Phase3a1bP2Store;
	let snapshot: Phase3a1bP2PublicationSnapshot;
	try {
		snapshot = await snapshotPhase3a1bP2Store(
			store,
			tuple.scenario === "single-row" ? [PHASE_3A1B_P2_SCOPE] : [PHASE_3A1B_P2_SCOPE, PHASE_3A1B_P2_OTHER_SCOPE]
		);
	} finally {
		await store.close();
	}
	const database = new (await import("node:sqlite")).DatabaseSync(`${primaryFilename}.drp-issuance-v1.sqlite`, {
		readOnly: true,
	});
	try {
		return {
			counts: ["lineages", "issued_records", "issuance_outbox"].map((table) => {
				const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { readonly count: number };
				return row.count;
			}),
			snapshot,
		};
	} finally {
		database.close();
	}
}

describe("D.93.29 Seam 2 Node SIGKILL evidence", () => {
	it("hard-kills all exact fourteen deterministic boundaries and reopens old or exact-new", async () => {
		assertExactDeathRegistry();
		let sawWal = false;
		for (const [ordinal, tuple] of PHASE_3A1B_P2_DEATH_TUPLES.entries()) {
			const filename = primary(`${ordinal}`);
			const messages = await killAt(tuple, filename);
			expect(
				messages.filter(({ kind }) => kind === "checkpoint"),
				tuple.id
			).toHaveLength(1);
			const wal = `${filename}.drp-issuance-v1.sqlite-wal`;
			sawWal ||= fs.existsSync(wal) && fs.statSync(wal).size > 0;
			const state = await recover(filename, tuple);
			const expectedCount = tuple.scenario === "single-row" ? 1 : 2;
			expect(state.counts, tuple.id).toEqual([expectedCount, expectedCount, expectedCount]);
			expect(state.snapshot, tuple.id).toEqual(expectedPhase3a1bP2Snapshot(tuple.scenario, tuple.terminalFate));
		}
		expect(sawWal).toBe(true);
	}, 240_000);
});
