import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { ReadEnvironment, ReadObservation } from "./contract.js";
import type { SnapshotQuarantineDeclaration } from "../../../packages/storage/src/snapshot-transfer.js";
import { snapshotQuarantineContract } from "../../../packages/storage/src/snapshot-transfer.js";
import {
	observeSQLite,
	sqliteEnvironment,
	suffix,
} from "../../../packages/storage-node/tests/fixtures/declaration-discovery-environment.js";

/** Reuse exact native results; add only the missing BEGIN/read-boundary visibility. */
export function environment(primaryFilename: string): ReadEnvironment {
	const existing = sqliteEnvironment(primaryFilename);
	const observeReader: ReadEnvironment["observeReader"] = async (action, boundary) => {
		const nativeExec = DatabaseSync.prototype.exec;
		const starts: string[] = [];
		const terminals: string[] = [];
		DatabaseSync.prototype.exec = function (sql: string): void {
			Reflect.apply(nativeExec, this, [sql]);
			if (/^\s*BEGIN\b/iu.test(sql)) {
				starts.push(sql);
				boundary?.("start");
			}
			if (/^\s*(COMMIT|ROLLBACK)\b/iu.test(sql)) {
				terminals.push(sql);
				boundary?.("terminal");
			}
		};
		try {
			const result = await observeSQLite(action);
			return {
				value: result.value,
				evidence: { ...result.evidence, starts, terminals, modes: [...starts], transactions: starts.length },
			};
		} finally {
			DatabaseSync.prototype.exec = nativeExec;
		}
	};
	return {
		...existing,
		put: async (row): Promise<void> => {
			const db = new DatabaseSync(primaryFilename + suffix);
			try {
				const key = [row.objectId, row.epoch, row.anchor, row.manifestDigest] as SQLInputValue[];
				const where = "object_id=? AND epoch=? AND anchor=? AND manifest_digest=?";
				if (db.prepare(`SELECT 1 FROM snapshot_scopes_v2 WHERE ${where}`).get(...key)) {
					// Exact metadata/private identity edits must not invoke REPLACE's FK deletion.
					db.prepare(
						`UPDATE snapshot_scopes_v2 SET exact_manifest_bytes=?,total_bytes=?,chunk_count=?,expires_at=?,state=?,retention=?,incarnation=?,descriptors=? WHERE ${where}`
					).run(
						...([
							row.exactCanonicalManifestBytes,
							row.totalBytes,
							row.chunkCount,
							row.expiresAt,
							row.state,
							row.retention,
							row.incarnation,
							row.descriptors,
						] as SQLInputValue[]),
						...key
					);
				} else await existing.put(row);
			} finally {
				db.close();
			}
		},
		observeReader,
		oversize: (declaration, byteLength): Promise<void> => {
			const db = new DatabaseSync(primaryFilename + suffix);
			try {
				const { objectId, epoch, anchor, manifestDigest } = declaration.scope;
				db.prepare(
					"UPDATE snapshot_chunks_v2 SET exact_bytes=zeroblob(?) WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=0"
				).run(byteLength, objectId, epoch, anchor, manifestDigest);
			} finally {
				db.close();
			}
			return Promise.resolve();
		},
		readonlyControl: async (
			declaration: SnapshotQuarantineDeclaration,
			lengthGuard = false
		): Promise<ReadObservation> => {
			const result = await observeReader(() => {
				const db = new DatabaseSync(primaryFilename + suffix);
				try {
					db.exec("BEGIN");
					const { objectId, epoch, anchor, manifestDigest } = declaration.scope;
					const where =
						"FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=0";
					const row = lengthGuard
						? db
								.prepare(
									`SELECT length(exact_bytes) AS native_length,CASE WHEN length(exact_bytes)<=? THEN exact_bytes ELSE NULL END AS exact_bytes ${where}`
								)
								.get(snapshotQuarantineContract.limits.snapshotChunkBytes, objectId, epoch, anchor, manifestDigest)
						: db.prepare(`SELECT exact_bytes ${where}`).get(objectId, epoch, anchor, manifestDigest);
					if (lengthGuard) {
						if (
							row?.native_length !== snapshotQuarantineContract.limits.snapshotChunkBytes + 1 ||
							row.exact_bytes !== null
						)
							throw new Error("actual bounded native length control absent");
					} else if (!(row?.exact_bytes instanceof Uint8Array))
						throw new Error("actual native readonly chunk control absent");
					db.exec("COMMIT");
					return Promise.resolve(row.exact_bytes);
				} finally {
					db.close();
				}
			});
			return result.evidence;
		},
	};
}

export { run, setup } from "./contract.js";
