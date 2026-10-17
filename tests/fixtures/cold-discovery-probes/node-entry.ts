import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeOwners } from "../cold-discovery/node-owners.js";
import { nodeMutations } from "../cold-discovery/node-mutations.js";
import type { SetupReport } from "../cold-discovery/types.js";
import { probe, type Mode } from "./common.js";

const setup = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as SetupReport;
const identity = setup.bootstrap.identity;
const owners = nodeOwners(identity);
try {
	const report = await probe(setup, process.argv[3] as Mode, owners, nodeMutations(identity), {
		snapshot: async () => {
			const db = new DatabaseSync(join(identity, "snapshot.sqlite.drp-snapshot-quarantine-v1.sqlite"));
			try {
				const scope = setup.oracle.lookupScope;
				const keys = [scope.objectId, scope.epoch, scope.anchor, scope.manifestDigest];
				return {
					foreignKeyDefinition: db.prepare("PRAGMA foreign_key_list(snapshot_chunks_v2)").all(),
					scopes: db
						.prepare(
							"SELECT * FROM snapshot_scopes_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
						)
						.all(...keys),
					chunks: db
						.prepare(
							"SELECT * FROM snapshot_chunks_v2 WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? ORDER BY chunk_index"
						)
						.all(...keys),
					owner: db.prepare("SELECT * FROM snapshot_owner_v2").all(),
				};
			} finally {
				db.close();
			}
		},
		blobs: async () => {
			const db = new DatabaseSync(join(identity, "ahe.sqlite"));
			try {
				return db
					.prepare("SELECT digest,bytes FROM blobs")
					.all()
					.map((row) => ({ digest: String(row.digest), bytes: Uint8Array.from(row.bytes as Uint8Array) }));
			} finally {
				db.close();
			}
		},
	});
	console.log(
		JSON.stringify({ kind: "DIRECT_PROBE_COMPLETE", pid: process.pid, report }, (_key, value) =>
			value instanceof Uint8Array ? { bytesHex: Buffer.from(value).toString("hex") } : value
		)
	);
} finally {
	await owners.close();
}
