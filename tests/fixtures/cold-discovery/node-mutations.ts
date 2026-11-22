import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type AuthFaultGraph, isAuthFaultCase, planAuthFault, verifyAuthFaultPersistence } from "./auth-fault-plan.js";
import type { AuthMutationReceipt, NativeMutations, RecoveryCase, RestartBootstrap } from "./types.js";
import type { SnapshotQuarantineScopeKey } from "../../../packages/storage/dist/src/snapshot-transfer.js";

/**
 * Real physical mutations against isolated SQLite fixtures, never synthetic reads.
 * @param identity
 */
export function nodeMutations(identity: string): NativeMutations {
	let authMutation: AuthMutationReceipt | undefined;
	const snapshot = (action: (database: DatabaseSync) => number): number => {
		const database = new DatabaseSync(join(identity, "snapshot.sqlite.drp-snapshot-quarantine-v1.sqlite"));
		try {
			database.exec("PRAGMA foreign_keys=ON");
			return action(database);
		} finally {
			database.close();
		}
	};
	const mutate = (mode: RecoveryCase, objectId: string, epoch: number, scope?: SnapshotQuarantineScopeKey): number =>
		snapshot((db) => {
			const rows = db.prepare("SELECT * FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=?").all(objectId, epoch);
			if (rows.length !== 1) throw new Error(`MUTATION_TARGET_NOT_UNIQUE:${rows.length}`);
			const row = rows[0] as Record<string, unknown>;
			if (scope !== undefined && (row.anchor !== scope.anchor || row.manifest_digest !== scope.manifestDigest))
				throw new Error("MUTATION_KEY_DIFFERS");
			const key = [objectId, epoch, String(row.anchor), String(row.manifest_digest)] as const;
			const where = "WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?";
			if (
				row.retention === "recovery" &&
				["missing-metadata", "delete-after-lookup", "poisoned", "open", "legacy"].includes(mode)
			) {
				db.prepare(
					"UPDATE snapshot_owner_v2 SET recovery_scopes=recovery_scopes-1,recovery_content_bytes=recovery_content_bytes-? WHERE id=1"
				).run(Number(row.total_bytes) + (row.exact_manifest_bytes as Uint8Array).byteLength);
			}
			if (mode === "missing-metadata" || mode === "delete-after-lookup")
				return Number(db.prepare(`DELETE FROM snapshot_scopes_v2 ${where}`).run(...key).changes);
			if (mode === "same-triple-conflict") {
				db.prepare(`DELETE FROM snapshot_chunks_v2 ${where}`).run(...key);
				return Number(
					db.prepare(`UPDATE snapshot_scopes_v2 SET manifest_digest=? ${where}`).run("f".repeat(64), ...key).changes
				);
			}
			if (mode === "poisoned" || mode === "open")
				return Number(
					db
						.prepare(`UPDATE snapshot_scopes_v2 SET state=?,retention='temporary' ${where}`)
						.run(mode === "poisoned" ? "poisoned" : "open", ...key).changes
				);
			if (mode === "legacy") {
				db.prepare(
					"UPDATE snapshot_owner_v2 SET legacy_unclassified_scopes=1,legacy_unclassified_content_bytes=? WHERE id=1"
				).run(Number(row.total_bytes) + (row.exact_manifest_bytes as Uint8Array).byteLength);
				return Number(
					db
						.prepare(
							`UPDATE snapshot_scopes_v2 SET retention='legacy-unclassified',state='open',descriptors=NULL ${where}`
						)
						.run(...key).changes
				);
			}
			if (mode === "identical-replacement" || mode === "replace-after-lookup")
				db.prepare(`UPDATE snapshot_scopes_v2 SET incarnation=? ${where}`).run(randomUUID(), ...key);
			if (mode === "identical-replacement") return 1;
			const chunk = db
				.prepare(`SELECT exact_bytes,chunk_index FROM snapshot_chunks_v2 ${where} ORDER BY chunk_index LIMIT 1`)
				.get(...key);
			if (chunk === undefined) throw new Error("MUTATION_CHUNK_MISSING_BEFORE_FAULT");
			if (mode === "missing-chunk")
				return Number(
					db.prepare(`DELETE FROM snapshot_chunks_v2 ${where} AND chunk_index=?`).run(...key, Number(chunk.chunk_index))
						.changes
				);
			if (mode === "corrupt-chunk" || mode === "replace-after-lookup") {
				const bytes = Uint8Array.from(chunk.exact_bytes as Uint8Array);
				bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
				return Number(
					db
						.prepare(`UPDATE snapshot_chunks_v2 SET exact_bytes=? ${where} AND chunk_index=?`)
						.run(bytes, ...key, Number(chunk.chunk_index)).changes
				);
			}
			throw new Error(`UNKNOWN_NATIVE_MUTATION:${mode}`);
		});
	return {
		get authMutation(): AuthMutationReceipt | undefined {
			return authMutation;
		},
		before: async (mode: RecoveryCase, bootstrap: RestartBootstrap): Promise<number> => {
			await Promise.resolve();
			if (isAuthFaultCase(mode)) {
				const db = new DatabaseSync(join(identity, "ahe.sqlite"));
				try {
					db.exec("PRAGMA foreign_keys=ON");
					db.exec("BEGIN IMMEDIATE");
					const objectId = bootstrap.expectedRoomHead.objectId;
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
					else
						db.prepare("INSERT OR IGNORE INTO blobs(digest,bytes) VALUES (?,?)").run(plan.blob.digest, plan.blob.bytes);
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
					authMutation = plan.receipt;
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
			return [
				"missing-metadata",
				"poisoned",
				"open",
				"legacy",
				"same-triple-conflict",
				"missing-chunk",
				"corrupt-chunk",
			].includes(mode)
				? mutate(mode, bootstrap.expectedRoomHead.objectId, bootstrap.expectedRoomHead.epoch - 1)
				: 0;
		},
		after: (mode, scope) =>
			Promise.resolve(
				["delete-after-lookup", "replace-after-lookup", "identical-replacement"].includes(mode)
					? mutate(mode, scope.objectId, scope.epoch, scope)
					: 0
			),
	};
}
