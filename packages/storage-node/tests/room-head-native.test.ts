import { encodeCanonical } from "@ts-drp/canonical";
import { captureRoomHeadRetirementPlan, validateRoomHeadRetirementObservation } from "@ts-drp/storage";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { createNodeRoomHeadAuthority, type NodeRoomHeadAuthority } from "../src/room-head.js";

const scope = { objectId: "native-room-head", pinnedGenesisAnchorDigest: "0".repeat(64) };
const head = { objectId: scope.objectId, epoch: 0, currentAnchorDigest: scope.pinnedGenesisAnchorDigest };
const fences = { decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64), throughEpoch: 1 };
const directories: string[] = [],
	owners: NodeRoomHeadAuthority[] = [];
async function filename(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ts-drp-r9-head-"));
	directories.push(dir);
	return join(dir, "head.sqlite");
}
function open(
	file: string,
	initialization: Parameters<typeof createNodeRoomHeadAuthority>[0]["initialization"]
): NodeRoomHeadAuthority {
	const owner = createNodeRoomHeadAuthority({ filename: file, initialization });
	owners.push(owner);
	return owner;
}
afterEach(async () => {
	for (const owner of owners.splice(0)) await owner.close();
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
function independentWriter(file: string): ReturnType<typeof spawnSync> {
	return spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import {DatabaseSync} from 'node:sqlite';
		const db = new DatabaseSync(process.argv[1]);
		db.exec('PRAGMA busy_timeout=0');
		try {db.exec('BEGIN IMMEDIATE');db.exec('ROLLBACK');}
		catch(error){process.exitCode=error.errcode===5?5:1;}
		finally{db.close();}
	`,
			file,
		],
		{ encoding: "utf8", timeout: 5000 }
	);
}

test("SQLite room floor noncreating reopen, exact scope/CAS and persisted continuation", async () => {
	const file = await filename();
	expect(() => open(file, { kind: "reopen" })).toThrow();
	await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	const owner = open(file, { kind: "create" });
	expect(await owner.read({ scope })).toEqual({ ok: true, state: null });
	const created = await owner.create({ scope, stable: head });
	if (!created.ok || created.state === null) throw new Error("create failed");
	expect(await owner.read({ scope: { ...scope, pinnedGenesisAnchorDigest: "f".repeat(64) } })).toEqual({
		ok: false,
		reason: "conflict",
	});
	await expect(
		owner.begin({ scope, expected: created.state, next: { ...head, epoch: 2, currentAnchorDigest: "2".repeat(64) } })
	).rejects.toThrow();
	expect(await owner.read({ scope })).toEqual(created);
	const begun = await owner.begin({
		scope,
		expected: created.state,
		next: { ...head, epoch: 1, currentAnchorDigest: "1".repeat(64) },
	});
	if (!begun.ok || begun.state === null) throw new Error("begin failed");
	expect(await owner.commit({ scope, expected: created.state })).toEqual({ ok: false, reason: "conflict" });
	await owner.close();
	const resumed = open(file, { kind: "reopen" });
	expect(await resumed.read({ scope })).toEqual(begun);
	expect(await resumed.create({ scope, stable: head })).toEqual({ ok: false, reason: "conflict" });
	const committed = await resumed.commit({ scope, expected: begun.state });
	expect(committed).toMatchObject({ ok: true, state: { stable: { epoch: 1 }, pending: null } });
	await resumed.close();
	expect(await open(file, { kind: "reopen" }).read({ scope })).toEqual(committed);
});

test("SQLite room floor explicit migration is exact and does not overwrite another scope", async () => {
	const file = await filename(),
		migrated = { ...head, epoch: 4, currentAnchorDigest: "4".repeat(64) };
	const owner = open(file, { kind: "migrate", head: migrated });
	expect(await owner.create({ scope, stable: head })).toEqual({ ok: false, reason: "conflict" });
	expect(await owner.migrate({ scope, stable: { ...migrated, epoch: 3 } })).toEqual({ ok: false, reason: "conflict" });
	const installed = await owner.migrate({ scope, stable: migrated });
	expect(installed).toMatchObject({ ok: true, state: { stable: migrated, pending: null } });
	expect(await owner.migrate({ scope, stable: migrated })).toEqual(installed);
	expect(
		await owner.migrate({ scope: { ...scope, objectId: "foreign" }, stable: { ...migrated, objectId: "foreign" } })
	).toEqual({ ok: false, reason: "conflict" });
	expect(await owner.read({ scope })).toEqual(installed);
});

test("SQLite room floor held image excludes an independent process; release and close revoke/join", async () => {
	const file = await filename(),
		owner = open(file, { kind: "create" });
	await owner.create({ scope, stable: head });
	const before = await owner.readRetirementImage({ scope });
	expect(independentWriter(file).status).toBe(0);
	const held = await owner.acquireNativeReadReservation({ scope });
	await held.check();
	expect(independentWriter(file).status).toBe(5);
	expect(await owner.readRetirementImage({ scope })).toEqual(before);
	await expect(owner.acquireNativeReadReservation({ scope })).rejects.toThrow("BUSY");
	await held.release();
	await held.release();
	await expect(held.check()).rejects.toThrow("RELEASED");
	expect(independentWriter(file).status).toBe(0);
	const last = await owner.acquireNativeReadReservation({ scope });
	const closed = owner.close();
	await expect(last.check()).rejects.toThrow("RELEASED");
	await expect(owner.read({ scope })).rejects.toThrow("CLOSED");
	await closed;
	expect(independentWriter(file).status).toBe(0);
	expect(await open(file, { kind: "reopen" }).readRetirementImage({ scope })).toEqual(before);
});

test("SQLite room floor native prepared/completed images match the shared law through reopen", async () => {
	const file = await filename(),
		stable = { ...head, epoch: 4, currentAnchorDigest: "4".repeat(64) };
	const owner = open(file, { kind: "migrate", head: stable });
	await owner.migrate({ scope, stable });
	const original = await owner.acquireRetirementControl({ scope });
	const plan = captureRoomHeadRetirementPlan(original, fences);
	expect(validateRoomHeadRetirementObservation(original, plan.binding)).toBe("old");
	await original.prepareFence(fences);
	await expect(original.prepareFence(fences)).rejects.toThrow("RELEASED");
	await owner.close();
	const resumed = open(file, { kind: "reopen" }),
		prepared = await resumed.acquireRetirementControl({ scope });
	expect(validateRoomHeadRetirementObservation(prepared, plan.binding)).toBe("prepared");
	expect(prepared.imageDigest).toBe(plan.preparedImageDigest);
	expect(prepared.metadataBytes).toBe(plan.preparedMetadataBytes);
	await prepared.release();
	expect(
		await resumed.begin({
			scope,
			expected: prepared.state,
			next: { ...stable, epoch: 5, currentAnchorDigest: "5".repeat(64) },
		})
	).toEqual({ ok: false, reason: "conflict" });
	const committing = await resumed.acquireRetirementControl({ scope });
	await committing.commitPrepared(fences);
	const completed = await resumed.acquireRetirementControl({ scope });
	expect(validateRoomHeadRetirementObservation(completed, plan.binding)).toBe("completed");
	expect(completed.imageDigest).toBe(plan.binding.completedImageDigest);
	expect(completed.metadataBytes).toBe(plan.completedMetadataBytes);
	expect(completed.control.revision).toBe(original.control.revision + 2);
	expect(completed.state).toEqual(original.state);
	await completed.release();
	await resumed.close();
	expect(await open(file, { kind: "reopen" }).readRetirementImage({ scope })).toMatchObject({
		imageDigest: plan.binding.completedImageDigest,
	});
});

test("SQLite room floor release-to-write gap refuses stale whole image; legitimate abort continues", async () => {
	const file = await filename(),
		stable = { ...head, epoch: 4, currentAnchorDigest: "4".repeat(64) };
	const owner = open(file, { kind: "migrate", head: stable });
	const created = await owner.migrate({ scope, stable });
	if (!created.ok || created.state === null) throw new Error("migration failed");
	const foreign = open(file, { kind: "reopen" });
	const observed = await owner.acquireRetirementControl({ scope });
	const changing = observed.prepareFence(fences); // releases native exclusion, then yields before exact CAS
	const begun = await foreign.begin({
		scope,
		expected: created.state,
		next: { ...stable, epoch: 5, currentAnchorDigest: "5".repeat(64) },
	});
	await expect(changing).rejects.toThrow("STALE");
	if (!begun.ok || begun.state === null) throw new Error("foreign begin failed");
	await foreign.commit({ scope, expected: begun.state });
	const fresh = await owner.acquireRetirementControl({ scope });
	await fresh.prepareFence(fences);
	const prepared = await owner.acquireRetirementControl({ scope });
	await expect(prepared.abortPrepared({ ...fences, sourceProofDigest: "c".repeat(64) })).rejects.toThrow("CONFLICT");
	const retry = await owner.acquireRetirementControl({ scope });
	await retry.abortPrepared(fences);
	const after = await owner.read({ scope });
	if (!after.ok || after.state === null) throw new Error("read failed");
	expect(
		await owner.begin({
			scope,
			expected: after.state,
			next: { ...stable, epoch: 6, currentAnchorDigest: "6".repeat(64) },
		})
	).toMatchObject({ ok: true });
});

test("SQLite room floor refuses malformed/noncanonical native images and foreign schema", async () => {
	const file = await filename(),
		owner = open(file, { kind: "create" });
	await owner.create({ scope, stable: head });
	await owner.close();
	const db = new DatabaseSync(file);
	db.prepare("UPDATE room_head SET image=? WHERE id=1").run(encodeCanonical({ version: 2 }));
	db.close();
	const resumed = open(file, { kind: "reopen" });
	await expect(resumed.read({ scope })).rejects.toThrow();
	await resumed.close();
	const foreignFile = await filename(),
		foreign = new DatabaseSync(foreignFile);
	foreign.exec("CREATE TABLE unrelated(value BLOB)");
	foreign.close();
	expect(() => open(foreignFile, { kind: "create" })).toThrow("UNSUPPORTED_SCHEMA");
	const verify = new DatabaseSync(foreignFile);
	expect(verify.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([{ name: "unrelated" }]);
	verify.close();
});
