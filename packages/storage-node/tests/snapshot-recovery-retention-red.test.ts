import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeSnapshotQuarantineStore as createLegacy } from "./fixtures/legacy-snapshot-transfer.mjs";
import type {
	LegacyStore,
	OwnerImage,
	RecoveryStore,
} from "../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import { fixture, outcome, stable } from "../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import {
	expectedRetentionCase,
	RETENTION_CASES,
	type RetentionEnvironment,
	runRetentionCase,
} from "../../../tests/fixtures/snapshot-recovery-retention/contract.js";
import { snapshotQuarantineContract } from "../../storage/src/snapshot-transfer.js";
import { createNodeSnapshotQuarantineStore } from "../src/snapshot-transfer.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function environment(): RetentionEnvironment {
	const directory = mkdtempSync(join(tmpdir(), "retention-red-"));
	directories.push(directory);
	const primaryFilename = join(directory, "primary.sqlite");
	const filename = `${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`;
	return {
		open: (recoveryLimits): Promise<RecoveryStore> =>
			Promise.resolve(
				createNodeSnapshotQuarantineStore({
					primaryFilename,
					...(recoveryLimits === undefined ? {} : { recoveryLimits }),
				} as Parameters<typeof createNodeSnapshotQuarantineStore>[0])
			),
		legacy: (): Promise<LegacyStore> => Promise.resolve(createLegacy({ primaryFilename })),
		exists: (): Promise<boolean> => Promise.resolve(existsSync(filename)),
		image: (): Promise<OwnerImage> => {
			const db = new DatabaseSync(filename, { readOnly: true });
			try {
				const scopes = db
					.prepare("SELECT * FROM snapshot_scopes_v2 ORDER BY object_id,epoch,anchor,manifest_digest")
					.all();
				const chunks = db
					.prepare("SELECT * FROM snapshot_chunks_v2 ORDER BY object_id,epoch,anchor,manifest_digest,chunk_index")
					.all();
				return Promise.resolve({
					version: Number(db.prepare("PRAGMA user_version").get()?.user_version),
					names: db
						.prepare("SELECT name FROM sqlite_schema ORDER BY name")
						.all()
						.map((row) => String(row.name)),
					schema: db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
					ownerRows: db.prepare("SELECT * FROM snapshot_owner_v2").all(),
					durableScopes: scopes,
					durableChunks: chunks,
					scopes,
					chunks,
				});
			} finally {
				db.close();
			}
		},
		fault: (kind, objectId, charge): Promise<void> => {
			const db = new DatabaseSync(filename);
			try {
				db.exec("BEGIN IMMEDIATE");
				if (kind === "identity-conflict")
					db.prepare("UPDATE snapshot_scopes_v2 SET total_bytes=total_bytes+1 WHERE object_id=?").run(objectId);
				if (kind === "poisoned-state")
					db.prepare("UPDATE snapshot_scopes_v2 SET state='poisoned' WHERE object_id=?").run(objectId);
				if (kind.startsWith("owned-")) {
					db.prepare("UPDATE snapshot_scopes_v2 SET retention='recovery',state=? WHERE object_id=?").run(
						kind === "owned-verified-missing" ? "verified" : "open",
						objectId
					);
					db.prepare("UPDATE snapshot_owner_v2 SET recovery_scopes=1,recovery_content_bytes=?").run(charge);
				}
				if (kind === "extra" || kind === "missing-extra" || kind === "extra-oversized" || kind === "extra-string")
					db.prepare(
						"INSERT INTO snapshot_chunks_v2 SELECT object_id,epoch,anchor,manifest_digest,?,chunk_digest,byte_length,exact_bytes FROM snapshot_chunks_v2 WHERE object_id=? AND chunk_index=0"
					).run(kind === "extra-oversized" ? 99999 : kind === "extra-string" ? "unexpected" : -1, objectId);
				if (kind === "descriptor-corrupt")
					db.prepare("UPDATE snapshot_chunks_v2 SET chunk_digest='invalid' WHERE object_id=?").run(objectId);
				if (kind.includes("missing"))
					db.prepare("DELETE FROM snapshot_chunks_v2 WHERE object_id=? AND chunk_index=0").run(objectId);
				if (kind === "owned-open-conflict" || kind === "owned-open-missing-conflict")
					db.prepare(
						"UPDATE snapshot_chunks_v2 SET exact_bytes=zeroblob(byte_length) WHERE object_id=? AND chunk_index=?"
					).run(objectId, kind === "owned-open-missing-conflict" ? 1 : 0);
				if (kind === "corrupt")
					db.prepare("UPDATE snapshot_chunks_v2 SET exact_bytes=x'00000000' WHERE object_id=?").run(objectId);
				db.exec("COMMIT");
			} finally {
				db.close();
			}
			return Promise.resolve();
		},
	};
}
describe("1a-1 native SQLite retention RED", () => {
	for (const name of RETENTION_CASES)
		it(name, async () => {
			expect(await runRetentionCase(name, environment())).toEqual(expectedRetentionCase(name));
		});
});

describe("1a-1 shared pure closure helpers RED", () => {
	for (const name of [
		"valid",
		"chunk-valid",
		"manifest-bytes",
		"manifest-identity",
		"descriptor-vector",
		"chunk-bytes",
		"chunk-index",
		"chunk-descriptor",
	] as const)
		it(name, async () => {
			const selected = fixture("closure-helper");
			const descriptor = selected.declaration.chunks[0];
			const bytes = selected.chunks[0];
			if (descriptor === undefined || bytes === undefined) throw new Error("fixture incomplete");
			const declaration =
				name === "manifest-bytes"
					? { ...selected.declaration, exactCanonicalManifestBytes: Uint8Array.of(0) }
					: name === "manifest-identity"
						? { ...selected.declaration, scope: { ...selected.declaration.scope, objectId: "mismatched" } }
						: name === "descriptor-vector"
							? { ...selected.declaration, chunks: [{ ...descriptor, byteLength: descriptor.byteLength + 1 }] }
							: selected.declaration;
			const selectedDescriptor =
				name === "chunk-index"
					? { ...descriptor, index: 1 }
					: name === "chunk-descriptor"
						? { ...descriptor, digest: "invalid" }
						: descriptor;
			const selectedBytes = name === "chunk-bytes" ? new Uint8Array(bytes).fill(0) : bytes;
			const before = stable({ declaration, selectedDescriptor, selectedBytes });
			let invocation = "threw";
			const result = await outcome(() => {
				const helper: unknown = Reflect.get(
					snapshotQuarantineContract,
					name.startsWith("chunk-") ? "validateRecoveryChunk" : "validateRecoveryManifest"
				);
				if (typeof helper !== "function") throw new Error("RED: shared closure helper absent");
				const returned: unknown = Reflect.apply(
					helper,
					snapshotQuarantineContract,
					name.startsWith("chunk-") ? [declaration, selectedDescriptor, selectedBytes] : [declaration]
				);
				invocation = returned === undefined ? "returned-undefined" : "returned-other";
				// Attach a rejection handler immediately through outcome's awaited return.
				// An async candidate is classified as returned-other, never mistaken for a synchronous throw.
				return returned;
			});
			expect({
				code: result.code,
				invocation,
				unchanged: before === stable({ declaration, selectedDescriptor, selectedBytes }),
			}).toEqual({
				code: name === "valid" || name === "chunk-valid" ? "none" : "poisoned",
				invocation: name === "valid" || name === "chunk-valid" ? "returned-undefined" : "threw",
				unchanged: true,
			});
		});
});
