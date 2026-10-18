import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createRecoverableFinalitySigner } from "@ts-drp/keychain/finality";
import { type CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { verifySealQC } from "@ts-drp/protocol-v3/seal";
import { createCreatorSealActor } from "@ts-drp/seal/creator";
import {
	type CreatorCloseEvidenceRecord,
	resolveCreatorCloseEvidenceStore,
} from "@ts-drp/seal/internal/creator-close-intent";
import { signingRetirementFrameDigest, storedSealQcContainsVote, type SigningRetirementPreparation } from "@ts-drp/seal/internal/storage-port";
import { resolveSealStorePort } from "@ts-drp/seal/internal/storage-port";
import { AHE_BOUNDED_READ_LIMITS } from "@ts-drp/storage";
import { spawnSync } from "node:child_process";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";

import { prepareCreatorActorFixture } from "../../storage-browser/tests/assets/phase-5e-creator-actor-entry.js";
import { SqliteSigningDatabase } from "../src/internal/signing-database.js";
import { acquireSqliteSigningLease } from "../src/internal/signing-lease.js";
import {
	readSqliteSigningImage,
	sqliteSigningMutationRefusal,
	SqliteSigningRetirementOwner,
} from "../src/internal/signing-retirement.js";
import { openNodeSealEvidenceStore } from "../src/seal-evidence.js";
import { openNodeSealVoteStore } from "../src/seal-vote.js";

const directories: string[] = [];
const owners: SqliteSigningDatabase[] = [];
const participants: SqliteSigningRetirementOwner[] = [];
const aliasClosers: Array<() => Promise<void>> = [];
type NativeCreatorHarness = Readonly<{
	actor: Extract<Awaited<ReturnType<typeof createCreatorSealActor>>, { ok: true }>["actor"];
	vote: Awaited<ReturnType<typeof openNodeSealVoteStore>>;
	evidence: Awaited<ReturnType<typeof openNodeSealEvidenceStore>>;
	close(): Promise<void>;
}>;
async function filename(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ts-drp-r9-signing-"));
	directories.push(directory);
	return join(directory, "signing.sqlite");
}
function open(file: string, initialization: "create" | "reopen" = "create"): SqliteSigningDatabase {
	const owner = new SqliteSigningDatabase({ filename: file, initialization });
	owners.push(owner);
	return owner;
}
afterEach(async () => {
	for (const close of aliasClosers.splice(0)) await close();
	for (const owner of participants.splice(0)) await owner.close();
	for (const owner of owners.splice(0)) await owner.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("SQLite public signing ports finalize genuine creator proofs and preserve exact custody across reopen", async () => {
	const file = await filename(),
		prepared = prepareCreatorActorFixture();
	const openActor = async (initialization: "create" | "reopen"): Promise<NativeCreatorHarness> => {
		const vote = await openNodeSealVoteStore({ filename: file, initialization });
		const evidence = await openNodeSealEvidenceStore({ filename: file, initialization: "reopen" });
		const signer = await createRecoverableFinalitySigner({ seed: new Uint8Array(32).fill(0x31) });
		expect(vote.observation.incarnation).toBe(evidence.observation.incarnation);
		const opened = await createCreatorSealActor({
			currentTrust: prepared.currentTrust,
			evidenceStore: evidence.store,
			signer: signer.signer,
			storageIncarnation: vote.observation.incarnation,
			voteStore: vote.store,
			onObservation: () => undefined,
		});
		if (!opened.ok) {
			await Promise.all([vote.close(), evidence.close()]);
			throw new Error(opened.reason);
		}
		const close = async (): Promise<void> => {
			await opened.actor.stop();
			await Promise.all([vote.close(), evidence.close()]);
		};
		aliasClosers.push(close);
		return { ...opened, vote, evidence, close };
	};
	const first = await openActor("create");
	const adapter = resolveSealStorePort(first.vote.store);
	if (adapter === undefined) throw new Error("missing genuine vote port");
	const raw = Object.freeze({ objectId: "forged", epoch: 0 });
	expect(await adapter.commitVote(raw)).toEqual({ ok: false, reason: "UNTRUSTED_VOTE_INTENT" });
	expect(await adapter.commitRoundChange(raw)).toEqual({ ok: false, reason: "UNTRUSTED_ROUND_CHANGE_INTENT" });
	expect(await adapter.commitQc(raw, raw)).toEqual({ ok: false, reason: "UNTRUSTED_VOTER_ENROLLMENT" });
	expect(await adapter.retireDetails(raw)).toEqual({ ok: false, reason: "UNTRUSTED_DETAIL_RETIREMENT_INTENT" });
	const result = await first.actor.close({ closeInput: prepared.closeInput });
	expect(result).toMatchObject({ ok: true });
	if (!result.ok) throw new Error(result.reason);
	expect(
		verifySealQC({ authority: prepared.authority, exactCanonicalQcBytes: result.exactCanonicalPrepareQcBytes })
	).toMatchObject({ ok: true, phase: "prepare", valueDigest: result.valueDigest });
	expect(
		verifySealQC({ authority: prepared.authority, exactCanonicalQcBytes: result.exactCanonicalCommitQcBytes })
	).toMatchObject({ ok: true, phase: "commit", valueDigest: result.valueDigest });
	const custody = await first.actor.acquireRecoveryDependencies([prepared.currentTrust as CurrentAnchorTrust]);
	const exactFrames = custody.readExactCanonicalRows();
	const votes = exactFrames.map(bytes => decodeCanonical(bytes) as unknown[]).filter(row => row[0] === "voteOutbox");
	// Vote and evidence custody expose the same physical rows independently.
	expect(new Set(votes.map(row => Buffer.from(encodeCanonical(row)).toString("hex"))).size).toBe(2);
	for (const [, , raw] of votes) {
		const row = raw as {phase: string; dispatched: boolean; carrier: {signature: Uint8Array}};
		expect(row.dispatched).toBe(true); // exact durable QC is the collector receipt
		const qc = decodeCanonical(row.phase === "prepare" ? result.exactCanonicalPrepareQcBytes : result.exactCanonicalCommitQcBytes) as any;
		expect(storedSealQcContainsVote(qc, row)).toBe(true);
		for (const altered of [{...qc, epoch: qc.epoch + 1}, {...qc, objectId: "foreign"},
			{...qc, phase: row.phase === "prepare" ? "commit" : "prepare"}, {...qc, proposalHash: "f".repeat(64)},
			{...qc, votes: []}, {...qc, votes: [...qc.votes, ...qc.votes]},
			{...qc, votes: qc.votes.map((member: object) => ({...member, signature: "0".repeat(128)}))}])
			expect(storedSealQcContainsVote(altered, row)).toBe(false);
		expect(storedSealQcContainsVote(qc, {...row, carrier: {...row.carrier, signature: new Uint8Array(64)}})).toBe(false);
	}
	expect(exactFrames.length).toBeGreaterThan(3);
	expect(exactFrames.reduce((n, bytes) => n + bytes.byteLength, 0)).toBeLessThanOrEqual(
		AHE_BOUNDED_READ_LIMITS.maxUnionBytes
	);
	const foreignWriter = new DatabaseSync(file);
	try {
		foreignWriter.exec("PRAGMA busy_timeout=0");
		expect(() => foreignWriter.exec("BEGIN IMMEDIATE")).toThrow();
		await custody.checkWhile(async () => {
			await Promise.resolve();
			expect(
				verifySealQC({ authority: prepared.authority, exactCanonicalQcBytes: result.exactCanonicalCommitQcBytes })
			).toMatchObject({ ok: true });
		});
		await custody.release();
		foreignWriter.exec("BEGIN IMMEDIATE");
		foreignWriter.exec("ROLLBACK");
	} finally {
		await custody.release();
		foreignWriter.close();
	}
	await first.close();
	const reopened = await openActor("reopen");
	expect(reopened.vote.observation.incarnation).toBe(first.vote.observation.incarnation);
	expect(reopened.vote.observation.pendingCount).toBe(0);
	expect(reopened.evidence.observation.evidenceCount).toBe(1);
	expect(reopened.actor.status()).toMatchObject({ phase: "finalized", terminal: false });
	const duplicate = await reopened.actor.close({ closeInput: prepared.closeInput });
	expect(duplicate).toMatchObject({ ok: true, duplicate: true });
	if (!duplicate.ok) throw new Error(duplicate.reason);
	expect(duplicate.exactCanonicalCommitQcBytes).toEqual(result.exactCanonicalCommitQcBytes);
	expect(duplicate.exactCanonicalPrepareQcBytes).toEqual(result.exactCanonicalPrepareQcBytes);
	expect(await reopened.actor.close({ closeInput: { ...prepared.closeInput, closeSetRoot: "f".repeat(64) } })).toEqual({
		ok: false,
		reason: "CLOSE_CONFLICT",
	});
	const after = await reopened.actor.acquireRecoveryDependencies([prepared.currentTrust as CurrentAnchorTrust]);
	expect(after.readExactCanonicalRows()).toEqual(exactFrames);
	await after.release();
});

test("SQLite QC receipt abort rolls back the QC and keeps the exact vote retryable across reopen", async () => {
	const file = await filename(), prepared = prepareCreatorActorFixture();
	let faultDatabase: DatabaseSync | undefined, triggerInstalled = false;
	const openActor = async (initialization: "create" | "reopen") => {
		const vote = await openNodeSealVoteStore({filename: file, initialization});
		const evidence = await openNodeSealEvidenceStore({filename: file, initialization: "reopen"});
		const signer = await createRecoverableFinalitySigner({seed: new Uint8Array(32).fill(0x31)});
		const opened = await createCreatorSealActor({currentTrust: prepared.currentTrust, evidenceStore: evidence.store,
			voteStore: vote.store, signer: signer.signer, storageIncarnation: vote.observation.incarnation, onObservation: event => {
				if (event.kind === "prepare_vote_committed" && !triggerInstalled && faultDatabase !== undefined) {
					faultDatabase.exec("CREATE TRIGGER fail_vote_receipt BEFORE UPDATE ON signing_rows WHEN NEW.family='voteOutbox' BEGIN SELECT RAISE(ABORT,'receipt crash'); END");
					triggerInstalled = true;
				}
			}});
		if (!opened.ok) throw Error(opened.reason);
		const close = async () => {await opened.actor.stop(); await Promise.all([vote.close(), evidence.close()]);};
		aliasClosers.push(close); return {...opened, vote, evidence, close};
	};
	const first = await openActor("create"), raw = new DatabaseSync(file);
	faultDatabase = raw;
	try {
		expect(await first.actor.close({closeInput: prepared.closeInput})).toMatchObject({ok: false});
		expect(triggerInstalled).toBe(true);
		await first.close();
		const stateBytes = raw.prepare("SELECT value FROM signing_rows WHERE family='signerState'").get() as {value: Uint8Array};
		const state = decodeCanonical(stateBytes.value) as {revision: number; highestPrepareQC: unknown};
		expect(state).toMatchObject({revision: 1, highestPrepareQC: null});
		const before = raw.prepare("SELECT value FROM signing_rows WHERE family='voteOutbox'").get() as {value: Uint8Array};
		const pending = decodeCanonical(before.value) as {dispatched: boolean; carrier: unknown};
		expect(pending.dispatched).toBe(false);
		raw.exec("DROP TRIGGER fail_vote_receipt");
		const reopened = await openActor("reopen");
		expect(reopened.vote.observation.pendingCount).toBe(1);
		expect(reopened.vote.observation.incarnation).toBe(first.vote.observation.incarnation);
		expect(await reopened.actor.close({closeInput: prepared.closeInput})).toMatchObject({ok: true});
		const read = await reopened.actor.acquireRecoveryDependencies([prepared.currentTrust as CurrentAnchorTrust]);
		try {
			const rows = read.readExactCanonicalRows().map(bytes => decodeCanonical(bytes) as unknown[]).filter(row => row[0] === "voteOutbox");
			expect(new Set(rows.map(row => Buffer.from(encodeCanonical(row)).toString("hex"))).size).toBe(2);
			expect(rows.every(row => (row[2] as {dispatched: boolean}).dispatched)).toBe(true);
			expect(rows.map(row => (row[2] as {carrier: unknown}).carrier)).toContainEqual(pending.carrier);
			await read.checkWhile(async () => undefined);
		} finally {await read.release();}
	} finally {raw.close();}
});

test("SQLite signing content reuse retains fresh custody, changed-byte refusal and cold reopen verification", async () => {
	const file = await filename(), prepared = prepareCreatorActorFixture();
	const protocol = await import("@ts-drp/protocol-v3/seal");
	const openActor = async (initialization: "create" | "reopen"): Promise<NativeCreatorHarness> => {
		const vote = await openNodeSealVoteStore({filename: file, initialization});
		const evidence = await openNodeSealEvidenceStore({filename: file, initialization: "reopen"});
		const signer = await createRecoverableFinalitySigner({seed: new Uint8Array(32).fill(0x31)});
		const opened = await createCreatorSealActor({currentTrust: prepared.currentTrust, evidenceStore: evidence.store,
			signer: signer.signer, storageIncarnation: vote.observation.incarnation, voteStore: vote.store, onObservation: () => undefined});
		if (!opened.ok) {await Promise.all([vote.close(), evidence.close()]); throw Error(opened.reason);}
		const close = async () => {await opened.actor.stop(); await Promise.all([vote.close(), evidence.close()]);};
		aliasClosers.push(close); return {...opened, vote, evidence, close};
	};
	const first = await openActor("create");
	expect(await first.actor.close({closeInput: prepared.closeInput})).toMatchObject({ok: true});
	const verifying = vi.spyOn(protocol, "verifySealQC"), opening = vi.spyOn(protocol, "openSealAuthority");
	const raw = new DatabaseSync(file);
	try {
		raw.exec("PRAGMA busy_timeout=0");
		const read = await first.actor.acquireRecoveryDependencies([prepared.currentTrust as CurrentAnchorTrust]);
		let frames: readonly Uint8Array[];
		try {
			frames = read.readExactCanonicalRows();
			expect(verifying.mock.calls.length).toBeGreaterThan(0);
			expect(() => raw.exec("BEGIN IMMEDIATE")).toThrow();
			await read.checkWhile(async () => undefined);
		} finally {await read.release();}
		verifying.mockClear(); opening.mockClear();
		const again = await first.actor.acquireRecoveryDependencies([prepared.currentTrust as CurrentAnchorTrust]);
		try {
			expect(again.readExactCanonicalRows()).toEqual(frames!);
			// Reuse only completed content verification: original authority opening,
			// native exclusion and both complete returned/charged vectors remain.
			expect(opening.mock.calls.length).toBeGreaterThan(0);
			expect(verifying).toHaveBeenCalledTimes(0);
			expect(() => raw.exec("BEGIN IMMEDIATE")).toThrow();
			const delivered = again.readExactCanonicalRows(); for (const bytes of delivered) bytes.fill(0xff);
			expect(again.readExactCanonicalRows()).toEqual(frames!);
			await again.checkWhile(async () => undefined);
		} finally {await again.release();}
		const stored = raw.prepare("SELECT row_key,value FROM signing_rows WHERE family='sealEvidence'").get();
		if (!(stored?.row_key instanceof Uint8Array) || !(stored.value instanceof Uint8Array)) throw Error("native evidence absent");
		const pristine = stored.value.slice(), key = stored.row_key.slice();
		const record = decodeCanonical(pristine) as Record<string, unknown>;
		raw.prepare("UPDATE signing_rows SET value=? WHERE family='sealEvidence' AND row_key=?")
			.run(encodeCanonical({...record, exactCanonicalCommitQcBytes: Uint8Array.of(0xff)}), key);
		await expect(first.actor.acquireRecoveryDependencies([prepared.currentTrust as CurrentAnchorTrust])).rejects.toThrow(/QC/u);
		raw.prepare("UPDATE signing_rows SET value=? WHERE family='sealEvidence' AND row_key=?").run(pristine, key);
		verifying.mockClear();
		const continued = await first.actor.acquireRecoveryDependencies([prepared.currentTrust as CurrentAnchorTrust]);
		try {expect(continued.readExactCanonicalRows()).toEqual(frames!); expect(verifying.mock.calls.length).toBeGreaterThan(0);}
		finally {await continued.release();}
		await first.close();
		const reopened = await openActor("reopen"); verifying.mockClear();
		const recovered = await reopened.actor.acquireRecoveryDependencies([prepared.currentTrust as CurrentAnchorTrust]);
		try {expect(recovered.readExactCanonicalRows()).toEqual(frames!); expect(verifying.mock.calls.length).toBeGreaterThan(0);}
		finally {await recovered.release();}
	} finally {raw.close(); verifying.mockRestore(); opening.mockRestore();}
});

test.each(["prepare_qc_committed", "commit_vote_committed"])(
	"SQLite public creator interrupted at %s reopens exact proofs and valid continuation",
	async (boundary) => {
		const file = await filename(),
			prepared = prepareCreatorActorFixture();
		const openActor = async (
			initialization: "create" | "reopen",
			interrupt: boolean
		): Promise<NativeCreatorHarness> => {
			const vote = await openNodeSealVoteStore({ filename: file, initialization });
			const evidence = await openNodeSealEvidenceStore({ filename: file, initialization: "reopen" });
			const signer = await createRecoverableFinalitySigner({ seed: new Uint8Array(32).fill(0x31) });
			const opened = await createCreatorSealActor({
				currentTrust: prepared.currentTrust,
				evidenceStore: evidence.store,
				storageIncarnation: vote.observation.incarnation,
				voteStore: vote.store,
				signer: signer.signer,
				onObservation: (event) => {
					if (interrupt && event.kind === boundary) throw new Error("injected after durable phase");
				},
			});
			if (!opened.ok) {
				await Promise.all([vote.close(), evidence.close()]);
				throw new Error(opened.reason);
			}
			const close = async (): Promise<void> => {
				await opened.actor.stop();
				await Promise.all([vote.close(), evidence.close()]);
			};
			aliasClosers.push(close);
			return { actor: opened.actor, vote, evidence, close };
		};
		const interrupted = await openActor("create", true);
		expect(await interrupted.actor.close({ closeInput: prepared.closeInput })).toEqual({
			ok: false,
			reason: "AMBIGUOUS_OUTCOME",
		});
		const adapter = resolveCreatorCloseEvidenceStore(interrupted.evidence.store);
		if (adapter === undefined) throw new Error("missing genuine evidence port");
		const prior = (await adapter.readAll())[0];
		if (prior === undefined || prior.exactCanonicalPrepareQcBytes === null)
			throw new Error("missing durable prepare proof");
		expect(
			verifySealQC({ authority: prepared.authority, exactCanonicalQcBytes: prior.exactCanonicalPrepareQcBytes })
		).toMatchObject({ ok: true, phase: "prepare" });
		expect(prior.phase).toBe(boundary === "prepare_qc_committed" ? "prepared" : "commit-voted");
		await interrupted.close();
		const resumed = await openActor("reopen", false);
		expect(resumed.vote.observation.incarnation).toBe(interrupted.vote.observation.incarnation);
		expect(resumed.vote.observation.pendingCount).toBe(boundary === "prepare_qc_committed" ? 0 : 1);
		const completed = await resumed.actor.close({ closeInput: prepared.closeInput });
		expect(completed).toMatchObject({ ok: true });
		if (!completed.ok) throw new Error(completed.reason);
		expect(completed.exactCanonicalPrepareQcBytes).toEqual(prior.exactCanonicalPrepareQcBytes);
		expect(
			verifySealQC({ authority: prepared.authority, exactCanonicalQcBytes: completed.exactCanonicalCommitQcBytes })
		).toMatchObject({ ok: true, phase: "commit", valueDigest: completed.valueDigest });
		const dependency = await resumed.actor.acquireRecoveryDependencies([prepared.currentTrust as CurrentAnchorTrust]);
		const frames = dependency.readExactCanonicalRows();
		expect(frames.reduce((n, bytes) => n + bytes.byteLength, 0)).toBeLessThanOrEqual(
			AHE_BOUNDED_READ_LIMITS.maxUnionBytes
		);
		await dependency.release();
	}
);

test("SQLite signing aliases share physical exclusion but independently revoke and join their admitted work", async () => {
	const file = await filename(),
		first = acquireSqliteSigningLease({ filename: file, initialization: "create" }),
		second = acquireSqliteSigningLease({ filename: file, initialization: "reopen" });
	aliasClosers.push(
		() => first.close(),
		() => second.close()
	);
	expect(first.database).toBe(second.database);
	const left = await first.retirement.acquireDependency({ objectId: "room" }),
		right = await second.retirement.acquireDependency({ objectId: "room" });
	expect(left.readExactCanonicalRows()).toEqual(right.readExactCanonicalRows());
	const writer = new DatabaseSync(file);
	try {
		writer.exec("PRAGMA busy_timeout=0");
		await left.release();
		await expect(left.check()).rejects.toThrow("READ_RELEASED");
		await right.check();
		expect(() => writer.exec("BEGIN IMMEDIATE")).toThrow();
		await first.close();
		await right.check();
		await expect(first.run(false, () => undefined)).rejects.toThrow("STORE_CLOSED");
		await right.release();
		writer.exec("BEGIN IMMEDIATE");
		writer.exec("ROLLBACK");
	} finally {
		writer.close();
	}
	await second.close();
	const reopened = acquireSqliteSigningLease({ filename: file, initialization: "reopen" });
	aliasClosers.push(() => reopened.close());
	expect(reopened.database.incarnation).toBe(first.database.incarnation);
});

test("SQLite evidence public port preserves exact phase CAS, conflicts, detachment and persisted reopen", async () => {
	const file = await filename(),
		opened = await openNodeSealEvidenceStore({ filename: file, initialization: "create" });
	aliasClosers.push(() => opened.close());
	const store = resolveCreatorCloseEvidenceStore(opened.store);
	if (store === undefined) throw new Error("missing genuine evidence port");
	const record: CreatorCloseEvidenceRecord = {
		anchor: "a".repeat(64),
		epoch: 0,
		objectId: "room",
		signerId: "creator",
		phase: "prepared",
		revision: 0,
		storageIncarnation: opened.observation.incarnation,
		valueDigest: "b".repeat(64),
		signerPublicKey: new Uint8Array(32),
		exactCanonicalCutValueBytes: new Uint8Array([1, 2]),
		exactCanonicalPrepareQcBytes: null,
		exactCanonicalCommitQcBytes: null,
		exactCanonicalTrustStateRecordBytes: null,
	};
	expect(await store.put(record, null)).toEqual({ ok: true, duplicate: false });
	record.exactCanonicalCutValueBytes[0] = 9;
	const rows = await store.readAll();
	expect(rows[0]?.exactCanonicalCutValueBytes).toEqual(new Uint8Array([1, 2]));
	const original = rows[0];
	if (original === undefined) throw new Error("missing persisted evidence");
	expect(await store.put(original, null)).toEqual({ ok: true, duplicate: true });
	expect(await store.put({ ...original, phase: "prepare-voted", revision: 1 }, "commit-voted")).toEqual({
		ok: false,
		reason: "EVIDENCE_CONFLICT",
	});
	expect(await store.put({ ...original, valueDigest: "c".repeat(64) }, "prepared")).toEqual({
		ok: false,
		reason: "EVIDENCE_CONFLICT",
	});
	expect(await store.readAll()).toEqual([original]);
	expect(await store.put({ ...original, phase: "prepare-voted", revision: 1 }, "prepared")).toEqual({
		ok: true,
		duplicate: false,
	});
	await opened.close();
	await expect(store.readAll()).rejects.toThrow("STORE_CLOSED");
	const reopened = await openNodeSealEvidenceStore({ filename: file, initialization: "reopen" });
	aliasClosers.push(() => reopened.close());
	expect(reopened.observation).toEqual({ incarnation: opened.observation.incarnation, evidenceCount: 1 });
	expect(await resolveCreatorCloseEvidenceStore(reopened.store)?.readAll()).toEqual([
		{ ...original, phase: "prepare-voted", revision: 1 },
	]);
});

const preparation = (throughEpoch: number, protectedEpochs: readonly number[] = []): SigningRetirementPreparation => ({
	throughEpoch,
	protectedEpochs,
	decisionDigest: "a".repeat(64),
	sourceProofDigest: "b".repeat(64),
});
function participant(database: SqliteSigningDatabase): SqliteSigningRetirementOwner {
	const owner = new SqliteSigningRetirementOwner(database);
	participants.push(owner);
	return owner;
}
function signerRow(
	epoch: number,
	signerId = "creator"
): Readonly<{
	objectId: string;
	epoch: number;
	signerId: string;
	revision: number;
	enteredRound: number;
	retiredBeforeRound: number;
}> {
	return { objectId: "room", epoch, signerId, revision: 0, enteredRound: 3, retiredBeforeRound: 1 };
}

test("SQLite signing captures genuine absence without metadata birth and charges every exact frame", async () => {
	const database = open(await filename()),
		owner = participant(database);
	await expect(owner.acquire({ objectId: "room" })).rejects.toThrow("SIGNING_ADDRESS_ABSENT");
	const empty = await owner.acquireDependency({ objectId: "room" });
	expect(empty.control).toMatchObject({ revision: 0, sequence: 0, active: null, completed: null });
	const frames = empty.readExactCanonicalRows();
	expect(frames.map((bytes) => decodeCanonical(bytes))).toEqual([
		["storageMeta", "incarnation", { key: "incarnation", value: database.incarnation }],
		["storageMeta", "ahe-retirement:room", null],
		["storageMeta", "signing-retirement:room", null],
	]);
	expect(empty.logicalBytes).toBe(frames.reduce((sum, bytes) => sum + bytes.byteLength, 0));
	expect(empty.imageDigest).toBe(Buffer.from(hashDomain("ts-drp/signing-native-image/v1", ...frames)).toString("hex"));
	expect("prepareFence" in empty).toBe(false);
	await empty.release();
	expect(database.transact(false, () => database.getMeta("signing-retirement:room"))).toBeUndefined();
});

test("SQLite signing fences retain protected holes and durable publication debt with no safety-floor regression", async () => {
	const file = await filename(),
		database = open(file),
		owner = participant(database);
	for (const epoch of [0, 1, 2])
		database.transact(true, () => database.put("signerState", ["room", epoch, "creator"], signerRow(epoch)));
	const key = ["room", 0, 3, "prepare", "creator"] as const;
	database.transact(true, () =>
		database.put("voteOutbox", key, {
			objectId: "room",
			epoch: 0,
			round: 3,
			phase: "prepare",
			signerId: "creator",
			dispatched: false,
			carrier: { signature: new Uint8Array(64), exactCanonicalPreimageBytes: new Uint8Array([1]) },
		})
	);
	const debt = await owner.acquire({ objectId: "room" });
	expect(await debt.prepareFence(preparation(2, [1]))).toEqual({ ok: false, reason: "SIGNING_DISPATCH_DEBT" });
	expect(database.transact(false, () => database.getMeta("signing-retirement:room"))).toBeUndefined();
	database.transact(true, () => {
		const row = database.get("voteOutbox", key) as object;
		database.put("voteOutbox", key, { ...row, dispatched: true });
	});
	const before = database.transact(false, () => readSqliteSigningImage(database, "room")).frames;
	const prepare = await owner.acquire({ objectId: "room" });
	expect(await prepare.prepareFence(preparation(2, [1]))).toMatchObject({
		ok: true,
		control: { revision: 1, sequence: 1 },
	});
	expect(database.transact(false, () => sqliteSigningMutationRefusal(database, "room", 0))).toBe("RETIREMENT_FENCED");
	expect(database.transact(false, () => sqliteSigningMutationRefusal(database, "room", 1))).toBeUndefined();
	const commit = await owner.acquire({ objectId: "room" });
	expect(await commit.commitPrepared()).toMatchObject({
		ok: true,
		control: { revision: 2, sequence: 1, active: null },
	});
	expect(database.transact(false, () => sqliteSigningMutationRefusal(database, "room", 2))).toBe("SIGNING_RETIRED");
	const invalid = await owner.acquire({ objectId: "room" });
	expect(await invalid.prepareFence(preparation(3, [0, 1]))).toEqual({
		ok: false,
		reason: "INVALID_RETIREMENT_FRONTIER",
	});
	await invalid.release();
	const after = database.transact(false, () => readSqliteSigningImage(database, "room")).frames;
	expect(after.slice(3)).toEqual(before.slice(3));
	await owner.close();
	const reopened = open(file, "reopen");
	expect(reopened.transact(false, () => sqliteSigningMutationRefusal(reopened, "room", 0))).toBe("SIGNING_RETIRED");
	expect(reopened.transact(false, () => reopened.get("signerState", ["room", 1, "creator"]))).toMatchObject({
		enteredRound: 3,
		retiredBeforeRound: 1,
	});
});

test("SQLite signing transition refuses a changed whole image after joining its original native read", async () => {
	const database = open(await filename()),
		owner = participant(database);
	database.transact(true, () => database.put("signerState", ["room", 0, "creator"], signerRow(0)));
	const captured = await owner.acquire({ objectId: "room" });
	const nativeTransaction = database.transact.bind(database);
	let inject = true;
	// Injection occurs only when the original held read has joined and the
	// intended CAS writer enters. It changes real native bytes, not its quote.
	const transaction = vi.spyOn(database, "transact").mockImplementation((write, action) => {
		if (write && inject) {
			inject = false;
			nativeTransaction(true, () =>
				database.put("signerState", ["room", 0, "creator"], { ...signerRow(0), revision: 1 })
			);
		}
		return nativeTransaction(write, action);
	});
	const pending = captured.prepareFence(preparation(0));
	try {
		expect(await pending).toEqual({ ok: false, reason: "NATIVE_IMAGE_CHANGED" });
	} finally {
		transaction.mockRestore();
	}
	expect(database.transact(false, () => database.getMeta("signing-retirement:room"))).toBeUndefined();
	await expect(captured.check()).rejects.toThrow("READ_RELEASED");
});

test("SQLite finalized-evidence drain resumes exact bounded batches without dropping protected rows", async () => {
	const file = await filename(),
		database = open(file),
		owner = participant(database);
	for (let epoch = 0; epoch < 19; epoch++)
		database.transact(true, () =>
			database.put("sealEvidence", ["room", epoch, "creator"], {
				...signerRow(epoch),
				phase: "finalized",
				storageIncarnation: database.incarnation,
			})
		);
	database.transact(true, () => database.put("signerState", ["room", 20, "creator"], signerRow(20)));
	const prepared = await owner.acquire({ objectId: "room" });
	expect(await prepared.prepareFence(preparation(18))).toMatchObject({ ok: true });
	const committed = await owner.acquire({ objectId: "room" });
	expect(await committed.commitPrepared()).toMatchObject({ ok: true });
	const image = database.transact(false, () => readSqliteSigningImage(database, "room"));
	const entries = image.frames.flatMap((bytes) => {
		const frame = decodeCanonical(bytes) as unknown[];
		return frame[0] === "sealEvidence"
			? [
					{
						key: frame[1] as readonly [string, number, string],
						revision: 0,
						frameDigest: signingRetirementFrameDigest(bytes),
					},
				]
			: [];
	});
	const plan = { baseControl: image.control, entries, sourceDataDigest: image.dataDigest };
	const begin = await owner.acquire({ objectId: "room" });
	expect(await begin.beginEvidenceDrain(plan)).toMatchObject({
		ok: true,
		control: { drain: { cursor: 0, batches: 0 } },
	});
	const first = await owner.acquire({ objectId: "room" });
	expect(await first.drainEvidenceBatch()).toMatchObject({ ok: true, control: { drain: { cursor: 16, batches: 1 } } });
	expect(database.transact(false, () => database.rows("sealEvidence", "room"))).toHaveLength(3);
	await owner.close();
	const reopened = open(file, "reopen"),
		continued = participant(reopened);
	const second = await continued.acquire({ objectId: "room" });
	expect(await second.drainEvidenceBatch()).toMatchObject({ ok: true, control: { drain: { cursor: 19, batches: 2 } } });
	expect(reopened.transact(false, () => reopened.rows("sealEvidence", "room"))).toHaveLength(0);
	expect(reopened.transact(false, () => reopened.get("signerState", ["room", 20, "creator"]))).toEqual(signerRow(20));
});

test("SQLite close revokes new signing immediately and joins admitted crypto before physical release", async () => {
	const file = await filename(),
		database = open(file),
		owner = participant(database),
		held = await owner.acquireSigningAdmission({ objectId: "room" });
	let closed = false;
	const closing = owner.close().then(() => {
		closed = true;
	});
	await expect(owner.acquireSigningAdmission({ objectId: "room" })).rejects.toThrow("STORE_CLOSED");
	await expect(held.check()).rejects.toThrow("READ_RELEASED");
	await Promise.resolve();
	expect(closed).toBe(false);
	const writer = new DatabaseSync(file);
	try {
		writer.exec("PRAGMA busy_timeout=0");
		expect(() => writer.exec("BEGIN IMMEDIATE")).toThrow();
	} finally {
		writer.close();
	}
	await held.release();
	await closing;
	expect(closed).toBe(true);
});

test("native signing database atomically persists rows and incarnation without creating on reopen", async () => {
	const file = await filename();
	expect(() => open(file, "reopen")).toThrow();
	await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	const owner = open(file),
		incarnation = owner.incarnation;
	const key = ["room", 0, "creator"] as const;
	const source = { objectId: "room", epoch: 0, signerId: "creator", revision: 1, bytes: new Uint8Array([1, 2]) };
	owner.transact(true, () => owner.put("sealEvidence", key, source));
	source.bytes[0] = 9;
	expect(owner.transact(false, () => owner.get("sealEvidence", key))).toMatchObject({ bytes: new Uint8Array([1, 2]) });
	expect(() =>
		owner.transact(true, () => {
			owner.put("sealEvidence", key, { ...source, revision: 2 });
			owner.putMeta("test", { key: "test", value: 1 });
			throw new Error("controlled precommit failure");
		})
	).toThrow("controlled precommit failure");
	expect(owner.transact(false, () => owner.get("sealEvidence", key))).toMatchObject({ revision: 1 });
	expect(owner.transact(false, () => owner.getMeta("test"))).toBeUndefined();
	expect(() => owner.get("sealEvidence", key)).toThrow("SIGNING_TRANSACTION_REQUIRED");
	expect(() => owner.transact(false, () => owner.delete("sealEvidence", key))).toThrow("SIGNING_READ_ONLY");
	expect(() => owner.transact(true, () => Promise.resolve(undefined))).toThrow("SIGNING_ASYNC_TRANSACTION_BODY");
	expect(() => owner.transact(true, () => owner.put("sealEvidence", key, source, true))).toThrow();
	await owner.close();
	const reopened = open(file, "reopen");
	expect(reopened.incarnation).toBe(incarnation);
	expect(reopened.transact(false, () => reopened.get("sealEvidence", key))).toMatchObject({
		revision: 1,
		bytes: new Uint8Array([1, 2]),
	});
});

test("native signing keys retain exact image order and admit byte bounds before value loading", async () => {
	const file = await filename(),
		owner = open(file);
	for (const signer of ["\ue000", "\u{10000}", "z"])
		owner.transact(true, () => owner.put("signerState", ["room", 0, signer], { signerId: signer }));
	expect(owner.transact(false, () => owner.rows("signerState", "room")).map((row) => row.key[2])).toEqual([
		"z",
		"\u{10000}",
		"\ue000",
	]);
	const native = new DatabaseSync(file);
	try {
		native
			.prepare("INSERT INTO signing_rows(family,object_id,epoch,row_key,value) VALUES(?,?,?,?,?)")
			.run(
				"sealEvidence",
				"poison",
				0,
				encodeCanonical(["poison", 0, "creator"]),
				new Uint8Array(AHE_BOUNDED_READ_LIMITS.maxUnionBytes + 1)
			);
	} finally {
		native.close();
	}
	expect(() => owner.transact(false, () => owner.get("sealEvidence", ["poison", 0, "creator"]))).toThrow(
		"SIGNING_IMAGE_FULL"
	);
	expect(() => owner.transact(false, () => owner.rows("sealEvidence", "poison"))).toThrow("SIGNING_IMAGE_FULL");
});

test("native signing reservations exclude a separate process writer and release actual SQLite custody", async () => {
	const file = await filename(),
		owner = open(file);
	const held = await owner.acquireNativeRead();
	const writer = (): ReturnType<typeof spawnSync> =>
		spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
		import {DatabaseSync} from 'node:sqlite'; const database=new DatabaseSync(process.argv[1]);
		database.exec('PRAGMA busy_timeout=0');
		try {database.exec('BEGIN IMMEDIATE');database.exec('ROLLBACK');}
		catch(error){process.exitCode=error.errcode===5?5:1;} finally{database.close();}
	`,
				file,
			],
			{ encoding: "utf8", timeout: 5000 }
		);
	expect(writer().status).toBe(5);
	await held.check();
	await held.release();
	expect(writer().status).toBe(0);
	await expect(held.check()).rejects.toThrow("NATIVE_READ_RESERVATION_RELEASED");
});

test("native signing currency refuses changed incarnation, unsupported schema and replaced backing file", async () => {
	const file = await filename(),
		owner = open(file);
	const native = new DatabaseSync(file);
	try {
		native
			.prepare("UPDATE signing_meta SET value=? WHERE key='incarnation'")
			.run(encodeCanonical({ key: "incarnation", value: "f".repeat(32) }));
	} finally {
		native.close();
	}
	expect(() => owner.transact(false, () => undefined)).toThrow("STORAGE_LOSS");
	await owner.close();
	const fresh = open(file, "reopen"),
		malformed = new DatabaseSync(file);
	try {
		malformed.exec("ALTER TABLE signing_rows ADD COLUMN unexpected TEXT");
	} finally {
		malformed.close();
	}
	expect(() => fresh.transact(false, () => undefined)).toThrow("SIGNING_UNSUPPORTED_SCHEMA");
	await fresh.close();
	expect(() => open(file, "reopen")).toThrow("SIGNING_UNSUPPORTED_SCHEMA");
	const otherFile = await filename(),
		original = open(otherFile),
		held = await original.acquireNativeRead();
	await rename(otherFile, otherFile + ".original");
	open(otherFile);
	await expect(held.check()).rejects.toThrow("STORAGE_LOSS");
	expect(() => original.transact(false, () => undefined)).toThrow("STORAGE_LOSS");
	await held.release();
});
