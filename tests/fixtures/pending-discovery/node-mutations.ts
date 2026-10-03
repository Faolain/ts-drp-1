import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { NativeMutations, OwnerCase } from "./types.js";
import type { SnapshotQuarantineScopeKey } from "../../../packages/storage/dist/src/snapshot-transfer.js";

/**
 * Real physical mutations against isolated SQLite fixtures, never synthetic reads.
 * @param identity - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export function nodeMutations(identity: string): NativeMutations {
	const snapshot = (action: (database: DatabaseSync) => number): number => {
		const database = new DatabaseSync(join(identity, "snapshot.sqlite.drp-snapshot-quarantine-v1.sqlite"));
		try {
			database.exec("PRAGMA foreign_keys=ON");
			return action(database);
		} finally {
			database.close();
		}
	};
	const mutate = (mode: OwnerCase, objectId: string, epoch: number, scope?: SnapshotQuarantineScopeKey): number =>
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
				[
					"missing-metadata",
					"delete-after-lookup",
					"poisoned",
					"open",
					"legacy-open",
					"legacy-verified",
					"expired-temporary",
					"expired-temporary-legacy-elsewhere",
					"open-legacy-elsewhere",
				].includes(mode)
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
			if (["expired-recovery", "expiry-after-acquisition"].includes(mode))
				return Number(db.prepare(`UPDATE snapshot_scopes_v2 SET expires_at=1 ${where}`).run(...key).changes);
			if (["expired-temporary", "expired-temporary-legacy-elsewhere", "open-legacy-elsewhere"].includes(mode)) {
				if (mode.endsWith("legacy-elsewhere")) {
					const other = db
						.prepare("SELECT * FROM snapshot_scopes_v2 WHERE object_id=? AND epoch<>?")
						.all(objectId, epoch);
					if (other.length !== 1) throw new Error("LEGACY_OTHER_SCOPE_NOT_UNIQUE");
					const neighbor = other[0] as Record<string, unknown>;
					db.prepare(
						"UPDATE snapshot_scopes_v2 SET retention='legacy-unclassified',descriptors=NULL WHERE object_id=? AND epoch=?"
					).run(objectId, Number(neighbor.epoch));
					db.prepare(
						"UPDATE snapshot_owner_v2 SET legacy_unclassified_scopes=1,legacy_unclassified_content_bytes=? WHERE id=1"
					).run(Number(neighbor.total_bytes) + (neighbor.exact_manifest_bytes as Uint8Array).byteLength);
				}
				return Number(
					db
						.prepare(`UPDATE snapshot_scopes_v2 SET retention='temporary',state=?,expires_at=? ${where}`)
						.run(
							mode === "open-legacy-elsewhere" ? "open" : "verified",
							mode === "open-legacy-elsewhere" ? Date.now() + 86400000 : 1,
							...key
						).changes
				);
			}
			if (mode === "poisoned" || mode === "open")
				return Number(
					db
						.prepare(`UPDATE snapshot_scopes_v2 SET state=?,retention='temporary' ${where}`)
						.run(mode === "poisoned" ? "poisoned" : "open", ...key).changes
				);
			if (mode === "legacy-open" || mode === "legacy-verified") {
				db.prepare(
					"UPDATE snapshot_owner_v2 SET legacy_unclassified_scopes=1,legacy_unclassified_content_bytes=? WHERE id=1"
				).run(Number(row.total_bytes) + (row.exact_manifest_bytes as Uint8Array).byteLength);
				return Number(
					db
						.prepare(`UPDATE snapshot_scopes_v2 SET retention='legacy-unclassified',state=?,descriptors=NULL ${where}`)
						.run(mode === "legacy-verified" ? "verified" : "open", ...key).changes
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
		before: async (mode, bootstrap): Promise<number> => {
			await Promise.resolve();
			if (mode === "expiry-after-acquisition")
				return mutate("open", bootstrap.expectedPreviousRoomHead.objectId, bootstrap.expectedPreviousRoomHead.epoch);
			if (
				[
					"verified",
					"lookup-rejected",
					"narrow-store",
					"delete-after-lookup",
					"replace-after-lookup",
					"identical-replacement",
				].includes(mode)
			)
				return 0;
			return mutate(mode, bootstrap.expectedPreviousRoomHead.objectId, bootstrap.expectedPreviousRoomHead.epoch);
		},
		after: (mode, scope): Promise<number> =>
			Promise.resolve(
				["delete-after-lookup", "replace-after-lookup", "identical-replacement", "expiry-after-acquisition"].includes(
					mode
				)
					? mutate(mode, scope.objectId, scope.epoch, scope)
					: 0
			),
	};
}
