import { DatabaseSync, StatementSync } from "node:sqlite";

import { type AnchorCase, anchorMaterial } from "./material.js";
import { type NativeAccess, recoverAnchorCase } from "./scenarios.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/dist/src/live-journal.js";

const [mode, filename, id] = process.argv.slice(2);
if (filename === undefined) throw new Error("missing journal fixture filename");
const journalFilename = `${filename}.drp-live-journal-v1.sqlite`;
const material = anchorMaterial(id === "non-genesis" ? 1 : 0);
const key = [material.scope.objectId, material.scope.epoch, material.scope.anchorDigest] as const;

function raw<T>(call: (database: DatabaseSync) => T): T {
	const database = new DatabaseSync(journalFilename);
	try {
		return call(database);
	} finally {
		database.close();
	}
}

function census(): unknown {
	return raw((database) => ({
		catalog: database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
		entries: database
			.prepare("SELECT * FROM accepted_entries ORDER BY object_id,epoch,anchor_digest,journal_sequence")
			.all(),
		scopes: database
			.prepare(
				"SELECT object_id,epoch,anchor_digest,next_journal_sequence,hex(exact_anchor_preimage) AS anchor,hex(detached_anchor_signature) AS signature,parameters_digest,hex(exact_parameters_carrier) AS parameters FROM scopes ORDER BY object_id,epoch,anchor_digest"
			)
			.all(),
	}));
}

function mutate(change: Parameters<NativeAccess["mutate"]>[0]): Promise<void> {
	raw((database) => {
		if (change === "delete") {
			database.prepare("DELETE FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?").run(...key);
			return;
		}
		if (change === "replacement") {
			database
				.prepare("INSERT INTO scopes VALUES (?,?,?,0,?,?,?,?)")
				.run(
					...key,
					Uint8Array.of(0),
					material.install.detachedAnchorSignature,
					material.scope.anchorDigest,
					material.install.exactCanonicalParametersCarrierBytes
				);
			return;
		}
		if (change === "unrelated-carriers") {
			database
				.prepare(
					"UPDATE scopes SET detached_anchor_signature=?,exact_parameters_carrier=?,next_journal_sequence=-1 WHERE object_id=? AND epoch=? AND anchor_digest=?"
				)
				.run(new Uint8Array(8193), "not-parameters", ...key);
			return;
		}
		if (change === "scope") {
			const epochOne = anchorMaterial(1);
			database
				.prepare(
					"UPDATE scopes SET anchor_digest=?,exact_anchor_preimage=? WHERE object_id=? AND epoch=? AND anchor_digest=?"
				)
				.run(epochOne.scope.anchorDigest, epochOne.bytes, ...key);
			return;
		}
		const value =
			change === "oversize"
				? new Uint8Array(8193).fill(7)
				: change === "empty"
					? new Uint8Array()
					: change === "non-byte"
						? "not-bytes"
						: change === "noncanonical"
							? Uint8Array.of(...material.bytes, 0)
							: anchorMaterial(0, { aclDigest: "9".repeat(64) }).bytes;
		database
			.prepare("UPDATE scopes SET exact_anchor_preimage=? WHERE object_id=? AND epoch=? AND anchor_digest=?")
			.run(value, ...key);
	});
	return Promise.resolve();
}

async function observe(
	call: () => Promise<unknown>,
	mode?: "failure" | "close-executing"
): Promise<{ result: unknown; trace: readonly unknown[] }> {
	const trace: unknown[] = [];
	const statements = new WeakMap<StatementSync, string>();
	const statementDatabases = new WeakMap<StatementSync, DatabaseSync>();
	const prepare = DatabaseSync.prototype.prepare;
	const exec = DatabaseSync.prototype.exec;
	const get = StatementSync.prototype.get;
	const all = StatementSync.prototype.all;
	let armed = mode === "failure";
	DatabaseSync.prototype.prepare = function (sql): StatementSync {
		const statement = prepare.call(this, sql);
		statements.set(statement, sql);
		statementDatabases.set(statement, this);
		return statement;
	};
	DatabaseSync.prototype.exec = function (sql): void {
		trace.push({ operation: "exec", sql });
		return exec.call(this, sql);
	};
	const query = (
		statement: StatementSync,
		operation: "get" | "all",
		parameters: readonly unknown[],
		callNative: () => unknown
	): unknown => {
		const sql = statements.get(statement) ?? "unobserved";
		if (armed && /\bscopes\b/iu.test(sql)) {
			armed = false;
			trace.push({ injectedFailure: true, operation, sql });
			const database = statementDatabases.get(statement);
			if (database === undefined) throw new Error("unbound native statement control");
			// Real SQLite prepare error, initiated by the test at the request edge; no fabricated row.
			prepare.call(database, "SELECT nonexistent_test_column FROM scopes").get();
			throw new Error("native failure control unexpectedly admitted invalid SQL");
		}
		const value = callNative();
		const rows = value === undefined ? [] : Array.isArray(value) ? value : [value];
		trace.push({
			operation,
			parameters,
			sql,
			projection: rows.map((row) =>
				Object.fromEntries(
					Object.entries(row as object).map(([key, value]) => [
						key,
						value instanceof Uint8Array ? { nativeBytes: value.length } : value,
					])
				)
			),
		});
		return value;
	};
	StatementSync.prototype.get = function (...parameters): ReturnType<StatementSync["get"]> {
		return query(this, "get", parameters, () => Reflect.apply(get, this, parameters)) as ReturnType<
			StatementSync["get"]
		>;
	};
	StatementSync.prototype.all = function (...parameters): ReturnType<StatementSync["all"]> {
		return query(this, "all", parameters, () => Reflect.apply(all, this, parameters)) as ReturnType<
			StatementSync["all"]
		>;
	};
	try {
		return { result: await call(), trace };
	} finally {
		DatabaseSync.prototype.prepare = prepare;
		DatabaseSync.prototype.exec = exec;
		StatementSync.prototype.get = get;
		StatementSync.prototype.all = all;
	}
}

if (mode === "setup") {
	const owner = createNodeDurableLiveJournalStore({ primaryFilename: filename });
	let installed;
	try {
		installed = await (material.scope.epoch === 0
			? owner.installGenesis(material.install)
			: owner.installEpochAnchor(material.install));
	} finally {
		await owner.close();
	}
	console.log(
		JSON.stringify({
			installed,
			setupPid: process.pid,
			census: census(),
			expectedBytes: Array.from(material.bytes),
			expectedScope: material.scope,
		})
	);
} else if (mode === "control") {
	await mutate("oversize");
	const gated = raw((database) =>
		database
			.prepare(
				"SELECT typeof(exact_anchor_preimage) AS nativeType,length(exact_anchor_preimage) AS nativeLength,CASE WHEN typeof(exact_anchor_preimage)='blob' AND length(exact_anchor_preimage)>0 AND length(exact_anchor_preimage)<=? THEN exact_anchor_preimage ELSE NULL END AS boundedAnchor FROM scopes WHERE object_id=? AND epoch=? AND anchor_digest=?"
			)
			.get(8192, ...key)
	);
	const digestSpellingControl = raw((database) =>
		database
			.prepare("SELECT length(?) AS characters,length(CAST(? AS BLOB)) AS bytes")
			.get("é".repeat(64), "é".repeat(64))
	);
	console.log(
		JSON.stringify({
			control: "test-owned-sql-guard-not-product",
			digestSpellingControl,
			gated,
			recoveryPid: process.pid,
		})
	);
} else {
	const native: NativeAccess = {
		census: () => Promise.resolve(census()),
		mutate,
		observe,
		open: () => Promise.resolve(createNodeDurableLiveJournalStore({ primaryFilename: filename })),
	};
	console.log(JSON.stringify({ ...(await recoverAnchorCase(native, id as AnchorCase)), recoveryPid: process.pid }));
}
