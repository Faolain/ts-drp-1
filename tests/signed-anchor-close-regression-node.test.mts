import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createNodeDurableLiveJournalStore } from "../packages/storage-node/dist/src/live-journal.js";
import { causal, expected, operations, positive, scope } from "./fixtures/signed-anchor-close-regression/causal.js";

for (const operation of [...operations, "positive"] as const)
	test("SQLite capture-close: " + operation, { timeout: 90000 }, async () => {
		const owned = mkdtempSync(join(tmpdir(), "signed-anchor-close-red-"));
		const primaryFilename = join(owned, "journal");
		const store = createNodeDurableLiveJournalStore({ primaryFilename });
		let receipt: unknown;
		try {
			if (operation === "positive") {
				receipt = await positive(store);
				assert.deepEqual(receipt, {
					captureOk: true,
					importOk: true,
					readOk: true,
					kind: "present",
					exactAnchor: true,
				});
			} else {
				const observed = await causal(store, operation);
				const db = new DatabaseSync(primaryFilename + ".drp-live-journal-v1.sqlite", { readOnly: true });
				let rows: unknown[];
				try {
					rows = db
						.prepare(
							"SELECT object_id,epoch,anchor_digest,next_journal_sequence FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?"
						)
						.all(scope.objectId, scope.epoch, scope.anchorDigest)
						.map((row) => ({ ...row }));
				} finally {
					db.close();
				}
				receipt = { ...observed, rows };
				console.log(JSON.stringify({ owner: "SQLite", operation, owned, receipt }));
				assert.deepEqual(receipt, expected(observed), "whole typed shutdown refusal and no actual durable import");
			}
		} finally {
			await store.close();
			rmSync(owned, { recursive: true });
			console.log(
				JSON.stringify({
					owner: "SQLite",
					operation,
					owned,
					lifecycleJoined: true,
					cleanupAbsent: !existsSync(owned),
					receipt,
				})
			);
		}
	});
