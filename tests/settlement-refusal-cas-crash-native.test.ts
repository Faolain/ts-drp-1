import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

// The batched drain writes every new transform refusal of one drain in ONE settlement-plan CAS
// (v3-room drain, per-drain batching). Store-level: SIGKILL just before, or just after, that write's
// SQLite COMMIT leaves either none of the drain's refusals or all of them, never a subset, and the
// plan's revision moves by exactly one with them.

const INNER = process.env.RUN_REFUSAL_CAS_CRASH === "1";
const EDGES = ["before-commit", "after-commit"] as const;
const SCOPE = { objectId: "refusal-cas-crash", author: "a".repeat(64) } as const;
const SOURCES = [10, 11, 12] as const;
const digest = (seed: number) => Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff);
const entry = (sourceSequence: number, refused: boolean) => ({
	sourceSequence,
	sourceDigest: digest(sourceSequence),
	disposition: "transform" as const,
	replacementSequence: null,
	...(refused
		? {
				transformRefusal: {
					version: 1 as const,
					kind: "admission-refused" as const,
					proposedIntentDigest: digest(sourceSequence + 100),
					reason: "capacity" as const,
				},
			}
		: {}),
});

const directories: string[] = [];
afterEach(() => {
	if (!INNER) for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.runIf(INNER)("inner: writes one drain's refusals in one plan CAS and dies at its COMMIT", async () => {
	const directory = process.env.REFUSAL_CAS_DIR as string;
	const edge = process.env.REFUSAL_CAS_EDGE as (typeof EDGES)[number];
	const store = createNodeDurableIssuanceStore({ primaryFilename: join(directory, "issuance.sqlite") });
	const prior = await store.transactWriteSettlementPlan({
		expectedRevision: null,
		scope: SCOPE,
		plan: {
			scope: SCOPE,
			revision: 0,
			fenceSequence: null,
			entries: SOURCES.map((sequence) => entry(sequence, false)),
		},
	});
	const original = DatabaseSync.prototype.exec;
	let armed = true;
	DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
		// The plan write's own COMMIT: its transaction (read on its own connection) holds all three refusals.
		const pending = () =>
			(
				this.prepare("SELECT entries_json FROM settlement_plans WHERE author=?").get(SCOPE.author) as
					| { entries_json: string }
					| undefined
			)?.entries_json.split("admission-refused").length ?? 1;
		if (armed && /^\s*COMMIT\b/iu.test(sql) && pending() - 1 === SOURCES.length) {
			armed = false;
			if (edge === "before-commit") {
				writeFileSync(
					join(directory, "death.json"),
					JSON.stringify({ edge, signal: "SIGKILL", refusalsInTransaction: pending() - 1 })
				);
				process.kill(process.pid, "SIGKILL");
			}
			const result = original.call(this, sql);
			writeFileSync(
				join(directory, "death.json"),
				JSON.stringify({ edge, signal: "SIGKILL", refusalsInTransaction: SOURCES.length })
			);
			process.kill(process.pid, "SIGKILL");
			return result;
		}
		return original.call(this, sql);
	};
	await store.transactWriteSettlementPlan({
		expectedRevision: prior.revision,
		scope: SCOPE,
		plan: { ...prior, revision: prior.revision + 1, entries: SOURCES.map((sequence) => entry(sequence, true)) },
	});
	throw new Error("SIGKILL_DID_NOT_TERMINATE");
});

it.skipIf(INNER).each(EDGES)(
	"SIGKILL %s of the drain's one refusal CAS leaves all of its refusals or none",
	async (edge) => {
		const directory = mkdtempSync(join(tmpdir(), "refusal-cas-crash-"));
		directories.push(directory);
		const file = "tests/settlement-refusal-cas-crash-native.test.ts";
		const child = spawn("npx", ["vitest", "run", file, "--no-file-parallelism", "--coverage.enabled=false"], {
			env: { ...process.env, RUN_REFUSAL_CAS_CRASH: "1", REFUSAL_CAS_DIR: directory, REFUSAL_CAS_EDGE: edge },
			stdio: "ignore",
		});
		await new Promise((resolve) => child.on("exit", resolve));
		expect(JSON.parse(readFileSync(join(directory, "death.json"), "utf8"))).toMatchObject({
			edge,
			signal: "SIGKILL",
			refusalsInTransaction: SOURCES.length,
		});
		const store = createNodeDurableIssuanceStore({ primaryFilename: join(directory, "issuance.sqlite") });
		try {
			const plan = await store.readSettlementPlan(SCOPE);
			const refused = (plan?.entries ?? [])
				.filter((row) => row.transformRefusal !== undefined)
				.map((row) => row.sourceSequence);
			if (edge === "before-commit") {
				expect(plan?.revision).toBe(0);
				expect(refused).toEqual([]);
			} else {
				expect(plan?.revision).toBe(1);
				expect(refused).toEqual([...SOURCES]);
			}
			// Either way the drain can go on: the next CAS against the revision it reads succeeds.
			const next = await store.transactWriteSettlementPlan({
				expectedRevision: plan!.revision,
				scope: SCOPE,
				plan: { ...plan!, revision: plan!.revision + 1, entries: SOURCES.map((sequence) => entry(sequence, true)) },
			});
			expect(next.entries.every((row) => row.transformRefusal?.reason === "capacity")).toBe(true);
		} finally {
			await store.close();
		}
	},
	120_000
);
