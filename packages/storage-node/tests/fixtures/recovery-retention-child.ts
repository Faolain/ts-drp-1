import { DatabaseSync } from "node:sqlite";

import { fixture, outcome } from "../../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import { createNodeSnapshotQuarantineStore } from "../../src/snapshot-transfer.js";

const [primaryFilename, mode, control, token, objectId] = process.argv.slice(2);
if (
	primaryFilename === undefined ||
	!(["precommit-error", "ack-loss", "kill-before", "kill-after", "race"] as unknown[]).includes(mode) ||
	(control !== "control" && control !== "production") ||
	token === undefined
)
	throw new Error("invalid retention child input");
const selected = fixture("retention-native-edge");
const charge = selected.declaration.totalBytes + selected.declaration.exactCanonicalManifestBytes.byteLength;
const evidence = { begins: 0, mutations: 0, nativeCommits: 0, edgeReached: false };
let armed = false;
let injected = false;
const originalExec = DatabaseSync.prototype.exec;
const originalPrepare = DatabaseSync.prototype.prepare;
const normalized = (sql: string): string => sql.trim().replace(/\s+/gu, " ").toUpperCase();
const send = (message: Readonly<Record<string, unknown>>): void => {
	process.send?.({ ...message, token, pid: process.pid, mode, control });
};
const postWrite = (database: DatabaseSync): Readonly<Record<string, unknown>> => {
	const row = originalPrepare.call(database, "SELECT retention,state FROM snapshot_scopes_v2").get();
	const owner = originalPrepare
		.call(database, "SELECT recovery_scopes,recovery_content_bytes FROM snapshot_owner_v2")
		.get();
	if (
		row?.retention !== "recovery" ||
		row.state !== "verified" ||
		owner?.recovery_scopes !== 1 ||
		owner.recovery_content_bytes !== charge ||
		evidence.begins !== 1
	)
		throw new Error(`RETENTION_POST_WRITE_EDGE_NOT_REACHED:${JSON.stringify({ row, owner, evidence })}`);
	return { row, owner };
};
DatabaseSync.prototype.prepare = function observedPrepare(sql): ReturnType<typeof originalPrepare> {
	const statement = originalPrepare.call(this, sql);
	const originalRun = statement.run;
	statement.run = function observedRun(...parameters): ReturnType<typeof originalRun> {
		const result = Reflect.apply(originalRun, this, parameters) as ReturnType<typeof originalRun>;
		if (armed && /\b(?:UPDATE|INSERT|REPLACE)\b.*\bSNAPSHOT_/u.test(normalized(sql))) evidence.mutations += 1;
		return result;
	};
	return statement;
};
DatabaseSync.prototype.exec = function observedExec(sql): void {
	const command = normalized(sql);
	if (armed && command === "COMMIT" && !injected) {
		const image = postWrite(this);
		injected = true;
		evidence.edgeReached = true;
		if (mode === "kill-before") {
			send({ kind: "checkpoint", edge: "post-write-precommit", evidence: { ...evidence }, image });
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		}
		if (mode === "precommit-error") throw new Error("INJECTED_RETENTION_PRECOMMIT_FAILURE");
		originalExec.call(this, sql);
		evidence.nativeCommits += 1;
		const committedImage = postWrite(this);
		if (mode === "kill-after") {
			send({ kind: "checkpoint", edge: "native-commit-returned", evidence: { ...evidence }, image: committedImage });
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		}
		throw new Error("INJECTED_RETENTION_COMMIT_ACK_LOSS");
	}
	originalExec.call(this, sql);
	if (armed && command === "BEGIN IMMEDIATE") evidence.begins += 1;
	if (armed && /\b(?:UPDATE|INSERT|REPLACE)\b.*\bSNAPSHOT_/u.test(command)) evidence.mutations += 1;
};

async function run(): Promise<void> {
	send({ kind: "born" });
	try {
		if (mode === "race") {
			if (objectId === undefined || control !== "production") throw new Error("invalid race child input");
			const store = createNodeSnapshotQuarantineStore({ primaryFilename });
			try {
				const scope = await store.openScope(fixture(objectId).declaration);
				const go = new Promise<void>((resolveGo) => {
					process.on("message", (message: unknown) => {
						if (
							message !== null &&
							typeof message === "object" &&
							Reflect.get(message, "kind") === "go" &&
							Reflect.get(message, "token") === token
						)
							resolveGo();
					});
				});
				send({ kind: "ready", objectId });
				await go;
				const retain: unknown = Reflect.get(scope, "retainForRecovery");
				if (typeof retain !== "function") {
					send({ kind: "masked", reason: "MASKED_BY_ABSENT_RETENTION_API", evidence });
				} else {
					const result = await outcome(() => Reflect.apply(retain, scope, []));
					send({ kind: "result", result });
				}
			} finally {
				await store.close();
			}
		} else if (control === "control") {
			// Native fault-instrumentation control only; this is NOT adapter retention.
			const database = new DatabaseSync(`${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`);
			try {
				database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
				armed = true;
				const result = await outcome(() => {
					database.exec("BEGIN IMMEDIATE");
					try {
						database.prepare("UPDATE snapshot_scopes_v2 SET retention='recovery'").run();
						database.prepare("UPDATE snapshot_owner_v2 SET recovery_scopes=1,recovery_content_bytes=?").run(charge);
						database.exec("COMMIT");
					} catch (error) {
						try {
							database.exec("ROLLBACK");
						} catch {
							// Native COMMIT may already have returned; preserve injected acknowledgment loss.
						}
						throw error;
					}
				});
				send({ kind: "result", result, evidence });
			} finally {
				armed = false;
				database.close();
			}
		} else {
			const store = createNodeSnapshotQuarantineStore({ primaryFilename });
			try {
				const scope = await store.openScope(selected.declaration);
				const retain: unknown = Reflect.get(scope, "retainForRecovery");
				if (typeof retain !== "function") {
					send({ kind: "masked", reason: "MASKED_BY_ABSENT_RETENTION_API", evidence });
				} else {
					armed = true;
					const result = await outcome(() => Reflect.apply(retain, scope, []));
					send({ kind: "result", result, evidence });
				}
			} finally {
				armed = false;
				await store.close();
			}
		}
	} catch (error) {
		send({ kind: "child-error", detail: String(error), evidence });
		process.exitCode = 1;
	} finally {
		DatabaseSync.prototype.exec = originalExec;
		DatabaseSync.prototype.prepare = originalPrepare;
		process.disconnect?.();
	}
}
void run();
