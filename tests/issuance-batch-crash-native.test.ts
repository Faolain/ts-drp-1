import { decodeCanonical } from "@ts-drp/canonical";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import {
	issueBatch,
	issueOne,
	replacement,
	SCOPE,
	settledStore,
	snapshot,
} from "./fixtures/issuance-batch/conformance.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

// transactIssueBatch crash atomicity on the SQLite store: the process is SIGKILLed around each of the
// batch's two writer commits (the entered marker, then every row), with no write, signature or
// transaction mocked. The reopened store is never partial: before the marker commits nothing is
// written; with the marker and no commit the marker alone is durable (no row, lineage unmoved) and
// only the same whole batch resumes it; after the commit every row and the plan are durable.
const INNER = process.env.RUN_ISSUANCE_BATCH_CRASH === "1";
// single-entered (G25, the older-store direction): a store an older build left with a single entered
// marker. The single path and its marker codec are unchanged by batching, so this build writes exactly the
// pre-batch record; the reopened store must read it as a single (pre-batch keys, no followingIntents),
// refuse a batch over it before any signature, and resume it as the single it is.
const EDGES = ["before-marker", "after-marker", "before-commit", "after-commit", "single-entered"] as const;
const PRE_BATCH_MARKER_KEYS = [
	"authorSequence",
	"canonicalPreimageBytes",
	"digest",
	"exactCanonicalPlanBytes",
	"incarnation",
	"kind",
	"phase",
	"planEffect",
];
type Edge = (typeof EDGES)[number];
const MOVES = 8;

const directories: string[] = [];
afterEach(() => {
	if (!INNER) for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * The first element of a test array, or a thrown test error.
 * @param values - The array.
 * @returns Its first element.
 */
function head<T>(values: readonly T[]): T {
	const [value] = values;
	if (value === undefined) throw new Error("issuance-batch crash: empty array");
	return value;
}

const storeIn = (directory: string, reopen: boolean): ReturnType<typeof createNodeDurableIssuanceStore> =>
	createNodeDurableIssuanceStore({
		primaryFilename: join(directory, "issuance"),
		...(reopen ? { initialization: "reopen" as const } : {}),
	});

/**
 * Whether the lineage holds a pending marker, and how many intents it covers.
 * @param directory - The crash run's store directory.
 * @returns The marker's byte length, or null without a marker.
 */
function markerIntents(directory: string): number | null {
	return markerBytes(directory)?.byteLength ?? null;
}

/**
 * The lineage's raw pending marker bytes, if any.
 * @param directory - The crash run's store directory.
 * @returns The bytes, or null.
 */
function markerBytes(directory: string): Uint8Array | null {
	const db = new DatabaseSync(join(directory, "issuance.drp-issuance-v1.sqlite"), { readOnly: true });
	try {
		const row = db.prepare("SELECT pending_unsigned FROM lineages WHERE author=?").get(SCOPE.author) as
			| { pending_unsigned: Uint8Array | null }
			| undefined;
		return row?.pending_unsigned ?? null;
	} finally {
		db.close();
	}
}

it.runIf(INNER)(
	"a process dies around a batch's commits",
	async () => {
		const directory = process.env.ISSUANCE_BATCH_CRASH_DIRECTORY;
		if (directory === undefined) throw new Error("ISSUANCE_BATCH_CRASH_DIRECTORY is not set");
		const edge = process.env.ISSUANCE_BATCH_CRASH_EDGE as Edge;
		const { store, sources } = await settledStore(() => Promise.resolve(storeIn(directory, false)), "crash", MOVES);
		const before = await snapshot(store, MOVES + 1, 2 * MOVES);
		writeFileSync(join(directory, "before.json"), JSON.stringify(before));
		const exec = DatabaseSync.prototype.exec;
		const seen = { marker: false, rows: false };
		const die = (detail: Record<string, unknown>): never => {
			writeFileSync(join(directory, "death.json"), JSON.stringify({ edge, ...detail }));
			process.kill(process.pid, "SIGKILL");
			throw Error("SIGKILL_DID_NOT_TERMINATE");
		};
		// Each commit is classified by what its own transaction holds (the connection sees its own
		// uncommitted writes): the marker commit holds the pending marker and no batch row; the batch
		// commit holds every batch row. Reads and other transactions are never edges.
		DatabaseSync.prototype.exec = function (sql: string): void {
			const commit = sql === "COMMIT" || sql.endsWith("COMMIT");
			if (!commit || this.location()?.endsWith("issuance.drp-issuance-v1.sqlite") !== true) return exec.call(this, sql);
			const pending =
				(
					this.prepare("SELECT pending_unsigned FROM lineages WHERE author=?").get(SCOPE.author) as
						| { pending_unsigned: Uint8Array | null }
						| undefined
				)?.pending_unsigned != null;
			const rows = Number(
				(
					this.prepare("SELECT count(*) AS n FROM issued_records WHERE author=? AND author_sequence>?").get(
						SCOPE.author,
						MOVES
					) as {
						n: number | bigint;
					}
				).n
			);
			const entered =
				pending &&
				(
					decodeCanonical(
						(
							this.prepare("SELECT pending_unsigned FROM lineages WHERE author=?").get(SCOPE.author) as {
								pending_unsigned: Uint8Array;
							}
						).pending_unsigned
					) as { phase?: string }
				).phase === "entered";
			if (edge === "single-entered" && entered && rows === 0) {
				const result = exec.call(this, sql);
				die({ kind: "single-entered", rows });
				return result;
			}
			const kind = !seen.marker && pending && rows === 0 ? "marker" : !seen.rows && rows === MOVES ? "rows" : undefined;
			if (kind === "marker") seen.marker = true;
			if (kind === "rows") seen.rows = true;
			if ((edge === "before-marker" && kind === "marker") || (edge === "before-commit" && kind === "rows"))
				die({ kind, rows });
			const result = exec.call(this, sql);
			if ((edge === "after-marker" && kind === "marker") || (edge === "after-commit" && kind === "rows"))
				die({ kind, rows });
			return result;
		};
		if (edge === "single-entered") await issueOne(store, replacement(head(sources).authorSequence));
		else
			await issueBatch(
				store,
				sources.map((source) => replacement(source.authorSequence))
			);
		throw Error(`ISSUANCE_BATCH_CRASH_EDGE_NOT_REACHED:${edge}:${JSON.stringify(seen)}`);
	},
	120_000
);

it.skipIf(INNER).each(EDGES)(
	"SIGKILL %s: the reopened store holds none or all of the batch (or the single), and resumes only it whole",
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
		const before = JSON.parse(readFileSync(join(directory, "before.json"), "utf8")) as Awaited<
			ReturnType<typeof snapshot>
		>;
		const marker = markerIntents(directory);
		const store = storeIn(directory, true);
		try {
			const after = await snapshot(store, MOVES + 1, 2 * MOVES);
			const all = Array.from({ length: MOVES }, (_, index) => MOVES + 1 + index);
			const none = all.map(() => null);
			const sourcesOf = Array.from({ length: MOVES }, (_, index) => index);
			const rows = sourcesOf.map((sequence) => replacement(sequence));
			process.stdout.write(`ISSUANCE_BATCH_CRASH ${JSON.stringify({ edge, marker, after: after.issued })}\n`);
			if (edge === "single-entered") {
				const bytes = markerBytes(directory);
				if (bytes === null) throw new Error("the single-entered edge left no marker");
				const record = decodeCanonical(bytes) as Record<string, unknown>;
				expect(Object.keys(record).sort()).toEqual(PRE_BATCH_MARKER_KEYS);
				expect(record.kind).toBe("v3-issuance-pending-unsigned-1");
				expect(record.phase).toBe("entered");
				expect(after.issued).toEqual(none);
				expect(after.lineage).toEqual(before.lineage);
				// A batch over the single marker (same head row, more rows) is refused before any signature.
				const over = await issueBatch(store, rows);
				expect(over.ok).toBe(false);
				expect(over.signed).toEqual([]);
				expect((await snapshot(store, MOVES + 1, 2 * MOVES)).issued).toEqual(none);
				// The single resumes as itself.
				const single = await issueOne(store, head(rows));
				expect(single.authorSequence).toBe(MOVES + 1);
				const final = await snapshot(store, MOVES + 1, 2 * MOVES);
				expect(final.issued).toEqual([MOVES + 1, ...none.slice(1)]);
				expect(final.lineage).toEqual({ exhausted: false, next: MOVES + 2 });
				expect(markerIntents(directory)).toBeNull();
				return;
			}
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
				// Nor does a single of the batch's head row: the marker is never read as a single.
				await expect(issueOne(store, head(rows))).rejects.toThrow();
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
