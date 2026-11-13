import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { issueBatch, replacement, SCOPE, settledStore, snapshot } from "./fixtures/issuance-batch/conformance.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

// transactIssueBatch crash atomicity on the SQLite store: the process is SIGKILLed around each of the
// batch's two writer commits (the entered marker, then every row), with no write, signature or
// transaction mocked. The reopened store is never partial: before the marker commits nothing is
// written; with the marker and no commit the marker alone is durable (no row, lineage unmoved) and
// only the same whole batch resumes it; after the commit every row and the plan are durable.
const INNER = process.env.RUN_ISSUANCE_BATCH_CRASH === "1";
const EDGES = ["before-marker", "after-marker", "before-commit", "after-commit"] as const;
type Edge = (typeof EDGES)[number];
const MOVES = 8;

const directories: string[] = [];
afterEach(() => {
	if (!INNER) for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const storeIn = (directory: string, reopen: boolean) =>
	createNodeDurableIssuanceStore({
		primaryFilename: join(directory, "issuance"),
		...(reopen ? { initialization: "reopen" as const } : {}),
	});

/** Whether the lineage holds a pending marker, and how many intents it covers. */
function markerIntents(directory: string): number | null {
	const db = new DatabaseSync(join(directory, "issuance.drp-issuance-v1.sqlite"), { readOnly: true });
	try {
		const row = db.prepare("SELECT pending_unsigned FROM lineages WHERE author=?").get(SCOPE.author) as
			| { pending_unsigned: Uint8Array | null }
			| undefined;
		if (row?.pending_unsigned == null) return null;
		return row.pending_unsigned.byteLength;
	} finally {
		db.close();
	}
}

it.runIf(INNER)(
	"a process dies around a batch's commits",
	async () => {
		const directory = process.env.ISSUANCE_BATCH_CRASH_DIRECTORY!;
		const edge = process.env.ISSUANCE_BATCH_CRASH_EDGE as Edge;
		const { store, sources } = await settledStore(() => Promise.resolve(storeIn(directory, false)), "crash", MOVES);
		const before = await snapshot(store, MOVES + 1, 2 * MOVES);
		writeFileSync(join(directory, "before.json"), JSON.stringify(before));
		const exec = DatabaseSync.prototype.exec;
		const seen = { marker: false, rows: false };
		const die = (detail: Record<string, unknown>) => {
			writeFileSync(join(directory, "death.json"), JSON.stringify({ edge, ...detail }));
			process.kill(process.pid, "SIGKILL");
			throw Error("SIGKILL_DID_NOT_TERMINATE");
		};
		// Each commit is classified by what its own transaction holds (the connection sees its own
		// uncommitted writes): the marker commit holds the pending marker and no batch row; the batch
		// commit holds every batch row. Reads and other transactions are never edges.
		DatabaseSync.prototype.exec = function (sql: string) {
			const commit = sql === "COMMIT" || sql.endsWith("COMMIT");
			if (!commit || this.location()?.endsWith("issuance.drp-issuance-v1.sqlite") !== true) return exec.call(this, sql);
			const pending =
				(this.prepare("SELECT pending_unsigned FROM lineages WHERE author=?").get(SCOPE.author) as
					| { pending_unsigned: Uint8Array | null }
					| undefined)?.pending_unsigned != null;
			const rows = Number(
				(this.prepare("SELECT count(*) AS n FROM issued_records WHERE author=? AND author_sequence>?").get(SCOPE.author, MOVES) as {
					n: number | bigint;
				}).n
			);
			const kind = !seen.marker && pending && rows === 0 ? "marker" : !seen.rows && rows === MOVES ? "rows" : undefined;
			if (kind === "marker") seen.marker = true;
			if (kind === "rows") seen.rows = true;
			if ((edge === "before-marker" && kind === "marker") || (edge === "before-commit" && kind === "rows")) die({ kind, rows });
			const result = exec.call(this, sql);
			if ((edge === "after-marker" && kind === "marker") || (edge === "after-commit" && kind === "rows")) die({ kind, rows });
			return result;
		};
		await issueBatch(
			store,
			sources.map((source) => replacement(source.authorSequence))
		);
		throw Error(`ISSUANCE_BATCH_CRASH_EDGE_NOT_REACHED:${edge}:${JSON.stringify(seen)}`);
	},
	120_000
);

it.skipIf(INNER).each(EDGES)(
	"SIGKILL %s: the reopened store holds none or all of the batch, and resumes only the whole batch",
	async (edge) => {
		const directory = mkdtempSync(join(tmpdir(), `issuance-batch-crash-${edge}-`));
		directories.push(directory);
		const child = spawn(
			"npx",
			["vitest", "run", fileURLToPath(import.meta.url), "--no-file-parallelism", "--coverage.enabled=false"],
			{
				env: {
					...process.env,
					RUN_ISSUANCE_BATCH_CRASH: "1",
					ISSUANCE_BATCH_CRASH_DIRECTORY: directory,
					ISSUANCE_BATCH_CRASH_EDGE: edge,
				},
				stdio: ["ignore", "pipe", "pipe"],
			}
		);
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		if (!existsSync(join(directory, "death.json"))) throw new Error(`no death at ${edge}:\n${output.slice(-4000)}`);
		const before = JSON.parse(readFileSync(join(directory, "before.json"), "utf8")) as Awaited<ReturnType<typeof snapshot>>;
		const marker = markerIntents(directory);
		const store = storeIn(directory, true);
		try {
			const after = await snapshot(store, MOVES + 1, 2 * MOVES);
			const all = Array.from({ length: MOVES }, (_, index) => MOVES + 1 + index);
			const none = all.map(() => null);
			const sourcesOf = Array.from({ length: MOVES }, (_, index) => index);
			const rows = sourcesOf.map((sequence) => replacement(sequence));
			process.stdout.write(`ISSUANCE_BATCH_CRASH ${JSON.stringify({ edge, marker, after: after.issued })}\n`);
			if (edge === "after-commit") {
				expect(marker).toBeNull();
				expect(after.issued).toEqual(all);
				expect(after.lineage).toEqual({ exhausted: false, next: 2 * MOVES + 1 });
				expect(after.planRevision).toBe((before.planRevision as number) + MOVES);
				return;
			}
			// Never partial: no row, lineage unmoved, plan unmoved.
			expect(after.issued).toEqual(none);
			expect(after.lineage).toEqual(before.lineage);
			expect(after.planBytes).toEqual(before.planBytes);
			expect(after.planRevision).toBe(before.planRevision);
			if (edge === "before-marker") expect(marker).toBeNull();
			else {
				expect(marker).not.toBeNull();
				// Only the same whole batch resumes an entered marker.
				const foreign = await issueBatch(store, rows.slice(0, MOVES - 1));
				expect(foreign.ok).toBe(false);
				expect((await snapshot(store, MOVES + 1, 2 * MOVES)).issued).toEqual(none);
			}
			const resumed = await issueBatch(store, rows);
			expect(resumed.ok).toBe(true);
			const final = await snapshot(store, MOVES + 1, 2 * MOVES);
			expect(final.issued).toEqual(all);
			expect(final.lineage).toEqual({ exhausted: false, next: 2 * MOVES + 1 });
			expect(final.planRevision).toBe((before.planRevision as number) + MOVES);
			expect(markerIntents(directory)).toBeNull();
		} finally {
			await store.close();
		}
	},
	180_000
);
