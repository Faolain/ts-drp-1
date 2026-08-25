import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createSnapshotQuarantineFixture,
	runSnapshotQuarantineBehaviorContract,
	SNAPSHOT_QUARANTINE_RETENTION_MS,
	SNAPSHOT_QUARANTINE_SCHEMA,
	type SnapshotQuarantineFixture,
} from "../../../tests/fixtures/phase-4c-v3/snapshot-quarantine-contract.js";
import type {
	NodeSnapshotQuarantineModule,
	SnapshotChunkDescriptor,
	SnapshotQuarantinePort,
	SnapshotQuarantineReceiptModule,
	SnapshotQuarantineScope,
	SnapshotQuarantineStore,
	SnapshotVerificationReceipt,
} from "../../../tests/fixtures/phase-4c-v3/snapshot-quarantine-types.js";

const OWNER_PATH = resolve(fileURLToPath(new URL("../src/snapshot-transfer.ts", import.meta.url)));
const NODE_MODULE_PATH: string = "../src/snapshot-transfer.js";
const RECEIPT_MODULE_PATH: string = "../../compaction/src/snapshot-quarantine-receipt.js";
const ownerExists = (await import("node:fs")).existsSync(OWNER_PATH);
const CHILD = fileURLToPath(new URL("./fixtures/phase-4c-b-snapshot-quarantine-crash-child.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

function fixture(): SnapshotQuarantineFixture {
	return createSnapshotQuarantineFixture({ objectId: "phase-4c-b-node" });
}

function databaseFilename(primaryFilename: string): string {
	return `${primaryFilename}${SNAPSHOT_QUARANTINE_SCHEMA.node.databaseSuffix}`;
}

function rawCounts(primaryFilename: string): Readonly<{ chunks: number; scopes: number }> {
	const database = new DatabaseSync(databaseFilename(primaryFilename), { readOnly: true });
	try {
		const chunks = database.prepare("SELECT COUNT(*) AS count FROM snapshot_chunks").get()?.count;
		const scopes = database.prepare("SELECT COUNT(*) AS count FROM snapshot_scopes").get()?.count;
		return { chunks: Number(chunks), scopes: Number(scopes) };
	} finally {
		database.close();
	}
}

async function loadOwner(): Promise<NodeSnapshotQuarantineModule> {
	return (await import(NODE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
}

async function openStore(): Promise<{
	primaryFilename: string;
	store: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
}> {
	const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cb-node-"));
	temporaryDirectories.push(directory);
	const primaryFilename = join(directory, "primary.sqlite");
	const owner = await loadOwner();
	return { primaryFilename, store: owner.createNodeSnapshotQuarantineStore({ primaryFilename }) };
}

function port(
	scope: SnapshotQuarantineScope<SnapshotVerificationReceipt>,
	signal = new AbortController().signal
): SnapshotQuarantinePort {
	return scope.verificationQuarantine.open(signal);
}

async function expectCode(action: Promise<unknown>, code: string): Promise<void> {
	await expect(action).rejects.toMatchObject({ code });
}

afterEach(() => {
	vi.useRealTimers();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe.skipIf(!ownerExists)("Phase 4c-b genuine Node SQLite quarantine RED", () => {
	it("shares one backend-neutral carrier, resume, duplicate and conflict contract", async () => {
		const { primaryFilename, store } = await openStore();
		const observed = await runSnapshotQuarantineBehaviorContract({ fixture: fixture(), store });
		expect(observed).toMatchObject({
			conflict: "conflict",
			declarationFailures: [
				"malformed-input",
				"malformed-input",
				"malformed-input",
				"malformed-input",
				"invalid-carrier",
				"invalid-carrier",
				"invalid-carrier",
			],
			detachedRead: true,
			foreign: "malformed-input",
			missing: [0, 2],
			poisoned: "poisoned",
		});
		expect(observed.duplicateExpiry).toBe(observed.firstExpiry);
		expect(rawCounts(primaryFilename)).toEqual({ chunks: 0, scopes: 0 });
		await store.close();
	});

	it("commits the manifest first in a separate exact-schema database", async () => {
		const { primaryFilename, store } = await openStore();
		const selected = fixture();
		const scope = await store.openScope(selected.declaration);
		expect(await scope.missingIndices()).toEqual([0, 1, 2]);
		expect(rawCounts(primaryFilename)).toEqual({ chunks: 0, scopes: 1 });
		const database = new DatabaseSync(databaseFilename(primaryFilename), { readOnly: true });
		try {
			expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
			expect(database.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
			expect(database.prepare("PRAGMA synchronous").get()?.synchronous).toBe(2);
			expect(
				database
					.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
					.all()
					.map(({ name }) => name)
			).toEqual(["snapshot_chunks", "snapshot_scopes"]);
			expect(
				database
					.prepare("PRAGMA table_xinfo(snapshot_scopes)")
					.all()
					.map(({ name }) => name)
			).toEqual(SNAPSHOT_QUARANTINE_SCHEMA.node.scopeColumns);
			expect(
				database
					.prepare("PRAGMA table_xinfo(snapshot_chunks)")
					.all()
					.map(({ name }) => name)
			).toEqual(SNAPSHOT_QUARANTINE_SCHEMA.node.chunkColumns);
			const row = database.prepare("SELECT * FROM snapshot_scopes").get() as Record<string, unknown>;
			expect(row).toMatchObject({
				anchor: selected.declaration.scope.anchor,
				chunk_count: 3,
				epoch: selected.declaration.scope.epoch,
				manifest_digest: selected.declaration.scope.manifestDigest,
				object_id: selected.declaration.scope.objectId,
				state: "open",
				total_bytes: 262_149,
			});
			expect(new Uint8Array(row.exact_manifest_bytes as Uint8Array)).toEqual(
				selected.declaration.exactCanonicalManifestBytes
			);
		} finally {
			database.close();
		}
		await store.close();
	});

	it("resumes exact non-prefix gaps and makes exact duplicates non-refreshing", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000);
		const { primaryFilename, store } = await openStore();
		const selected = fixture();
		let scope = await store.openScope(selected.declaration);
		const writer = port(scope);
		await writer.write(selected.declaration.chunks[1] as SnapshotChunkDescriptor, selected.chunks[1] as Uint8Array);
		expect(await scope.missingIndices()).toEqual([0, 2]);
		const firstExpiry = (await scope.status()).expiresAt;
		vi.setSystemTime(2_100);
		await writer.write(selected.declaration.chunks[1] as SnapshotChunkDescriptor, selected.chunks[1] as Uint8Array);
		expect((await scope.status()).expiresAt).toBe(firstExpiry);
		await scope.release();
		await store.close();

		const owner = await loadOwner();
		const reopened = owner.createNodeSnapshotQuarantineStore({ primaryFilename });
		scope = await reopened.openScope(selected.declaration);
		expect(await scope.missingIndices()).toEqual([0, 2]);
		await reopened.close();
	});

	it("poisons an occupied-index conflict atomically without overwriting first bytes", async () => {
		const { store } = await openStore();
		const selected = fixture();
		const scope = await store.openScope(selected.declaration);
		const writer = port(scope);
		const descriptor = selected.declaration.chunks[0] as SnapshotChunkDescriptor;
		await writer.write(descriptor, selected.chunks[0] as Uint8Array);
		await expectCode(writer.write(descriptor, new Uint8Array(descriptor.byteLength).fill(9)), "conflict");
		expect(await scope.status()).toMatchObject({ kind: "poisoned" });
		await expectCode(scope.complete(Object.freeze({}) as SnapshotVerificationReceipt), "poisoned");
		const retained = await writer.read(descriptor);
		expect(retained).toEqual(selected.chunks[0]);
		await store.close();
	});

	it("expires at the exact fixed boundary and explicit cancel removes scope and chunks", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const { primaryFilename, store } = await openStore();
		const selected = fixture();
		let scope = await store.openScope(selected.declaration);
		await port(scope).write(
			selected.declaration.chunks[0] as SnapshotChunkDescriptor,
			selected.chunks[0] as Uint8Array
		);
		const expiresAt = (await scope.status()).expiresAt;
		expect(expiresAt).toBe(4_000 + SNAPSHOT_QUARANTINE_RETENTION_MS);
		vi.setSystemTime(expiresAt - 1);
		expect(await store.sweepExpired()).toBe(0);
		vi.setSystemTime(expiresAt);
		expect(await store.sweepExpired()).toBe(1);
		expect(rawCounts(primaryFilename)).toEqual({ chunks: 0, scopes: 0 });

		vi.setSystemTime(expiresAt + 1);
		scope = await store.openScope(selected.declaration);
		await port(scope).write(
			selected.declaration.chunks[0] as SnapshotChunkDescriptor,
			selected.chunks[0] as Uint8Array
		);
		await scope.cancel();
		await scope.cancel();
		expect(rawCounts(primaryFilename)).toEqual({ chunks: 0, scopes: 0 });
		await store.close();
	});

	it("fails incomplete and aborted work before receipt consumption or durable mutation", async () => {
		const { primaryFilename, store } = await openStore();
		const selected = fixture();
		const scope = await store.openScope(selected.declaration);
		await expectCode(scope.complete(Object.freeze({}) as SnapshotVerificationReceipt), "incomplete");
		const controller = new AbortController();
		controller.abort(new Error("aborted"));
		await expectCode(
			store.openScope(
				{ ...selected.declaration, scope: { ...selected.declaration.scope, epoch: 5 } },
				{ signal: controller.signal }
			),
			"aborted"
		);
		expect(rawCounts(primaryFilename)).toEqual({ chunks: 0, scopes: 1 });
		await store.close();
	});

	it("releases without deletion, closes quiescently and refuses every later effect", async () => {
		const { primaryFilename, store } = await openStore();
		const selected = fixture();
		const scope = await store.openScope(selected.declaration);
		const writer = port(scope);
		await writer.discard();
		expect(rawCounts(primaryFilename)).toEqual({ chunks: 0, scopes: 1 });
		await expectCode(
			writer.write(selected.declaration.chunks[0] as SnapshotChunkDescriptor, selected.chunks[0] as Uint8Array),
			"closed"
		);
		await store.close();
		await expectCode(store.openScope(selected.declaration), "closed");
	});

	it("aborts before a transaction and makes close await already admitted durable work", async () => {
		const { primaryFilename, store } = await openStore();
		const selected = fixture();
		const scope = await store.openScope(selected.declaration);
		const controller = new AbortController();
		const aborted = port(scope, controller.signal);
		controller.abort(new Error("stop-before-write"));
		await expectCode(
			aborted.write(selected.declaration.chunks[0] as SnapshotChunkDescriptor, selected.chunks[0] as Uint8Array),
			"aborted"
		);
		expect(rawCounts(primaryFilename)).toEqual({ chunks: 0, scopes: 1 });
		const admitted = port(scope);
		const writing = admitted.write(
			selected.declaration.chunks[0] as SnapshotChunkDescriptor,
			selected.chunks[0] as Uint8Array
		);
		const closing = store.close();
		await writing;
		await closing;
		expect(rawCounts(primaryFilename)).toEqual({ chunks: 1, scopes: 1 });
		await expectCode(
			admitted.write(selected.declaration.chunks[1] as SnapshotChunkDescriptor, selected.chunks[1] as Uint8Array),
			"closed"
		);
	});

	it("copies bounded carriers before await and rejects unsupported schema exactly", async () => {
		const { primaryFilename, store } = await openStore();
		const selected = fixture();
		const cleanManifest = new Uint8Array(selected.declaration.exactCanonicalManifestBytes);
		const opening = store.openScope(selected.declaration);
		selected.declaration.exactCanonicalManifestBytes.fill(0);
		const scope = await opening;
		await scope.release();
		const reopened = await store.openScope({ ...selected.declaration, exactCanonicalManifestBytes: cleanManifest });
		expect(await reopened.status()).toMatchObject({ kind: "open" });
		const descriptor = selected.declaration.chunks[0] as SnapshotChunkDescriptor;
		const cleanChunk = new Uint8Array(selected.chunks[0] as Uint8Array);
		const mutableChunk = new Uint8Array(cleanChunk);
		const writing = port(reopened).write(descriptor, mutableChunk);
		mutableChunk.fill(0);
		await writing;
		const firstRead = await port(reopened).read(descriptor);
		expect(firstRead).toEqual(cleanChunk);
		firstRead?.fill(0);
		expect(await port(reopened).read(descriptor)).toEqual(cleanChunk);
		await expectCode(
			store.openScope({
				...selected.declaration,
				exactCanonicalManifestBytes: new Uint8Array(212_388),
				scope: { ...selected.declaration.scope, objectId: "phase-4c-b-node-hostile" },
			}),
			"invalid-carrier"
		);
		await store.close();

		const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cb-node-schema-"));
		temporaryDirectories.push(directory);
		const foreignPrimary = join(directory, "primary.sqlite");
		const foreign = new DatabaseSync(databaseFilename(foreignPrimary));
		foreign.exec("CREATE TABLE foreign_table(value TEXT)");
		foreign.exec("PRAGMA user_version=2");
		foreign.close();
		const owner = await loadOwner();
		expect(() => owner.createNodeSnapshotQuarantineStore({ primaryFilename: foreignPrimary })).toThrowError(
			expect.objectContaining({ code: "unsupported-schema" })
		);
		expect(rawCounts(primaryFilename)).toEqual({ chunks: 0, scopes: 1 });
	});

	it("consumes one genuine terminal receipt exactly once and persists only an opaque verified reference", async () => {
		const { primaryFilename, store } = await openStore();
		const selected = fixture();
		const scope = await store.openScope(selected.declaration);
		const receiptOwner = (await import(RECEIPT_MODULE_PATH)) as SnapshotQuarantineReceiptModule;
		const stream = receiptOwner.verifySnapshotStreamWithReceipt({
			exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
			expectedManifestDigest: selected.declaration.scope.manifestDigest,
			expectedScope: selected.declaration.scope,
			profile: { maxManifestBytes: 212_387, maxSnapshotBytes: 268_435_456, snapshotChunkBytes: 131_072 },
			quarantine: scope.verificationQuarantine,
			source: {
				read: (descriptor) => Promise.resolve(new Uint8Array(selected.chunks[descriptor.index] as Uint8Array)),
			},
		});
		const receipt = await stream.receipt;
		await expect(stream.completion).resolves.toMatchObject({ chunkCount: 3, exactByteLength: 262_149 });
		const competing = await Promise.allSettled([scope.complete(receipt), scope.complete(receipt)]);
		expect(competing.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		const rejected = competing.filter(({ status }) => status === "rejected") as PromiseRejectedResult[];
		expect(rejected).toHaveLength(1);
		expect(rejected[0]?.reason).toMatchObject({ code: "receipt-invalid" });
		const reference = (competing.find(({ status }) => status === "fulfilled") as PromiseFulfilledResult<unknown>).value;
		expect(reference).toEqual({
			chunkCount: 3,
			exactByteLength: 262_149,
			scope: selected.declaration.scope,
		});
		expect(await scope.status()).toMatchObject({ kind: "verified", missingIndices: [] });
		expect(rawCounts(primaryFilename)).toEqual({ chunks: 3, scopes: 1 });
		await expectCode(scope.complete(receipt), "receipt-invalid");
		await scope.release();
		await store.close();
		const owner = await loadOwner();
		const reopenedStore = owner.createNodeSnapshotQuarantineStore({ primaryFilename });
		const reopened = await reopenedStore.openScope(selected.declaration);
		expect(await reopened.status()).toMatchObject({ kind: "verified", missingIndices: [] });
		await expectCode(reopened.complete(receipt), "receipt-invalid");
		await reopenedStore.close();
	});

	it("survives genuine SIGKILL at manifest and chunk transaction edges as exact old XOR new", async () => {
		for (const target of [
			{ edge: "begin", operation: "manifest", raw: { chunks: 0, scopes: 0 } },
			{ edge: "commit", operation: "manifest", raw: { chunks: 0, scopes: 1 } },
			{ edge: "begin", operation: "chunk", raw: { chunks: 0, scopes: 1 } },
			{ edge: "commit", operation: "chunk", raw: { chunks: 1, scopes: 1 } },
		] as const) {
			const directory = mkdtempSync(join(tmpdir(), `ts-drp-phase4cb-node-death-${target.operation}-${target.edge}-`));
			temporaryDirectories.push(directory);
			const primaryFilename = join(directory, "primary.sqlite");
			const child = spawn(process.execPath, [CHILD, primaryFilename, JSON.stringify(target)], {
				cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			await new Promise<void>((resolvePromise, reject) => {
				const timeout = setTimeout(
					() => reject(new Error(`missing ${target.operation}:${target.edge} checkpoint`)),
					10_000
				);
				child.on("message", (message: { edge?: string; kind?: string; operation?: string }) => {
					if (message.kind === "checkpoint" && message.operation === target.operation && message.edge === target.edge) {
						clearTimeout(timeout);
						child.kill("SIGKILL");
						resolvePromise();
					}
				});
				child.once("error", reject);
			});
			await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
			expect(child.signalCode).toBe("SIGKILL");
			expect(rawCounts(primaryFilename)).toEqual(target.raw);
			const owner = await loadOwner();
			const store = owner.createNodeSnapshotQuarantineStore({ primaryFilename });
			const selected = fixture();
			const scope = await store.openScope(selected.declaration);
			expect(await scope.missingIndices()).toEqual(target.raw.chunks === 1 ? [1, 2] : [0, 1, 2]);
			expect(rawCounts(primaryFilename).scopes).toBe(1);
			await store.close();
		}
	});
});
