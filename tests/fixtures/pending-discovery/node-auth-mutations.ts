import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type AuthFaultGraph, isAuthFaultCase, planAuthFault, verifyAuthFaultPersistence } from "./auth-fault-plan.js";
import type { RecoveryCase, RestartBootstrap } from "./types.js";
/**
 * Run the named pending-only fixture seam.
 * @param identity - Explicit fixture-owned input for this isolated control.
 * @param bootstrap - Explicit fixture-owned input for this isolated control.
 * @param mode - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function nodeAuthMutation(
	identity: string,
	bootstrap: RestartBootstrap,
	mode: RecoveryCase
): Promise<number> {
	await Promise.resolve();
	if (isAuthFaultCase(mode)) {
		const db = new DatabaseSync(join(identity, "ahe.sqlite"));
		try {
			db.exec("PRAGMA foreign_keys=ON");
			db.exec("BEGIN IMMEDIATE");
			const objectId = bootstrap.expectedPreviousRoomHead.objectId;
			const graph = (): AuthFaultGraph => ({
				headRecord: db.prepare("SELECT head_record FROM objects WHERE object_id=?").get(objectId)
					?.head_record as Uint8Array,
				generations: db
					.prepare("SELECT generation_id,record FROM generations WHERE object_id=? ORDER BY generation_id")
					.all(objectId)
					.map((row) => ({ generationId: String(row.generation_id), record: row.record as Uint8Array })),
				blobs: db
					.prepare("SELECT digest,bytes FROM blobs ORDER BY digest")
					.all()
					.map((row) => ({ digest: String(row.digest), bytes: row.bytes as Uint8Array })),
				promotions: db
					.prepare("SELECT generation_id,digest FROM promotions WHERE object_id=? ORDER BY generation_id,digest")
					.all(objectId)
					.map((row) => ({ generationId: String(row.generation_id), digest: String(row.digest) })),
			});
			const before = graph(),
				plan = planAuthFault(before, bootstrap, mode);
			if (plan.receipt.kind === "storage-corrupt")
				db.prepare("UPDATE blobs SET bytes=? WHERE digest=?").run(plan.blob.bytes, plan.blob.digest);
			else db.prepare("INSERT OR IGNORE INTO blobs(digest,bytes) VALUES (?,?)").run(plan.blob.digest, plan.blob.bytes);
			for (const row of plan.generations)
				db.prepare("UPDATE generations SET record=? WHERE object_id=? AND generation_id=?").run(
					row.record,
					objectId,
					row.generationId
				);
			for (const row of plan.promotions)
				db.prepare("UPDATE promotions SET digest=? WHERE object_id=? AND generation_id=? AND digest=?").run(
					row.toDigest,
					objectId,
					row.generationId,
					row.fromDigest
				);
			if (plan.headRecord !== undefined)
				db.prepare("UPDATE objects SET head_record=? WHERE object_id=?").run(plan.headRecord, objectId);
			verifyAuthFaultPersistence(before, graph(), plan);
			db.exec("COMMIT");

			return plan.receipt.faultApplications;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* Preserve the fixture failure. */
			}
			throw error;
		} finally {
			db.close();
		}
	}
	return 0;
}
