import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	assertSignedIdentity,
	charge,
	chunksFor,
	openProducerFixture,
	pastTemporaryTtl,
	snapshotImage,
} from "./fixtures/producer-presign-retention/fixture.js";
import {
	assertHeldProducerCheckpoint,
	assertNativeTermination,
	assertObservedPersistenceBoundary,
	buildNativeProducerChild,
	type NativeMessage,
	runNativeProducerChild,
} from "./fixtures/producer-presign-retention/native-parent.js";
import type { SnapshotQuarantineDeclaration } from "../packages/storage/src/snapshot-transfer.js";
import { createSqliteAheDurableStore } from "../packages/storage-node/src/index.js";
import { createNodeSnapshotQuarantineStore } from "../packages/storage-node/src/snapshot-transfer.js";

/**
 * The expected payload stays in the parent; the child sends no payload or live handles.
 * @returns Genuine independently generated declaration and exact snapshot chunks.
 */
async function expectedProducerContent(): Promise<{
	declaration: SnapshotQuarantineDeclaration;
	chunks: readonly Uint8Array[];
}> {
	const control = await openProducerFixture({ adapter: "SQLite/Node" });
	try {
		const result = await control.prepared.handle.close();
		const scope = control.scopes[0];
		assert.ok(scope && scope.completed);
		await assertSignedIdentity(control, result, scope);
		return { declaration: scope.declaration, chunks: scope.chunks };
	} finally {
		await control.close();
	}
}

async function coldSnapshot(
	primaryFilename: string,
	message: NativeMessage,
	expected: Awaited<ReturnType<typeof expectedProducerContent>>
): Promise<void> {
	assert.ok(message.declaration && message.owner);
	expect(message.declaration).toEqual(expected.declaration);
	const declaration = message.declaration;
	const raw = await snapshotImage({ adapter: "SQLite/Node", primaryFilename, snapshotDatabaseName: "unused-native" });
	expect(raw.version).toBe(2);
	expect(raw.owner).toHaveLength(1);
	expect(raw.owner[0]).toMatchObject({
		recovery_scopes: 1,
		recovery_content_bytes: charge(declaration),
		legacy_unclassified_scopes: 0,
		legacy_unclassified_content_bytes: 0,
	});
	expect(raw.scopes).toHaveLength(2);
	const row = raw.scopes.find((candidate) => candidate.object_id === declaration.scope.objectId);
	assert.ok(row);
	expect(row).toMatchObject({
		object_id: declaration.scope.objectId,
		epoch: declaration.scope.epoch,
		anchor: declaration.scope.anchor,
		manifest_digest: declaration.scope.manifestDigest,
		state: "verified",
		retention: "recovery",
	});
	expect(row.exact_manifest_bytes).toEqual(expected.declaration.exactCanonicalManifestBytes);
	const rawChunks = raw.chunks.filter((candidate) => candidate.object_id === declaration.scope.objectId);
	expect(rawChunks).toHaveLength(expected.chunks.length);
	for (const [index, chunk] of rawChunks.entries()) {
		const descriptor = declaration.chunks[index];
		const expectedChunk = expected.chunks[index];
		assert.ok(descriptor && expectedChunk);
		expect(chunk).toMatchObject({
			epoch: declaration.scope.epoch,
			anchor: declaration.scope.anchor,
			manifest_digest: declaration.scope.manifestDigest,
			chunk_index: index,
			chunk_digest: descriptor.digest,
			byte_length: expectedChunk.byteLength,
		});
		expect(chunk.exact_bytes).toEqual(expected.chunks[index]);
	}
	const store = createNodeSnapshotQuarantineStore({ primaryFilename });
	try {
		expect(await store.recoveryStatus()).toEqual(message.owner);
		await pastTemporaryTtl(async () => {
			expect(await store.sweepExpired()).toBe(1);
			expect(await store.recoveryStatus()).toEqual(message.owner);
			const reopened = await store.openScope(declaration);
			try {
				expect(await reopened.status()).toMatchObject({ kind: "verified", retention: "recovery" });
				expect(await chunksFor(reopened, declaration)).toEqual(expected.chunks);
			} finally {
				await reopened.release();
			}
		});
	} finally {
		await store.close();
	}
}

async function coldAhe(aheFilename: string, message: NativeMessage, expected: "entry" | "boundary"): Promise<void> {
	assert.ok(message.beforeClose && message.persistenceEntries?.[0] && message.boundary);
	const store = createSqliteAheDurableStore({ filename: aheFilename });
	try {
		const baseline = expected === "entry" ? message.persistenceEntries[0].ahe : message.boundary.ahe;
		assert.ok(baseline.head.ok && baseline.head.value.kind === "present");
		const objectId = baseline.head.value.objectId;
		expect({
			head: await store.readHead(objectId),
			generations: await store.readGenerationPage({ objectId, limit: 128 }),
		}).toEqual(baseline);
	} finally {
		await store.close();
	}
}

describe("1b-1 native producer SQLite snapshot/AHE boundary — real fake-IDB seal stores are observation-only across death", () => {
	it("precondition: real successful close evidence/votes are seen; a deliberately late committed retention checkpoint is rejected and held child is cold-reopened", async () => {
		const directory = mkdtempSync(join(tmpdir(), "producer-native-control-"));
		let cleanupSafe = true;
		try {
			const expected = await expectedProducerContent();
			const built = await buildNativeProducerChild(directory);
			const primaryFilename = join(directory, "snapshot.sqlite");
			const aheFilename = join(directory, "ahe.sqlite");
			cleanupSafe = false;
			const result = await runNativeProducerChild({
				...built,
				directory,
				primaryFilename,
				aheFilename,
				mode: "late-retention-control",
			});
			cleanupSafe = result.cleanupSafe;
			console.info("PRODUCER_NATIVE_LATE_CONTROL", JSON.stringify({ result, build: built }));
			assertNativeTermination(result);
			const held = result.messages.find((message) => message.kind === "late-checkpoint");
			assert.ok(held?.boundary && held.persistenceEntries?.[0]);
			const operations = held.boundary.operations.slice(held.persistenceEntries[0].operationCount);
			expect(operations.some((event) => event.lane === "seal" && event.name === "enrollment-call")).toBe(true);
			expect(operations.some((event) => event.lane === "seal" && event.name === "sealEvidence:put")).toBe(true);
			for (const phase of ["prepare", "commit"])
				expect(
					operations.some(
						(event) => event.name === "voteSlots:add" && (event.detail as { phase?: string }).phase === phase
					)
				).toBe(true);
			expect(operations.some((event) => event.lane === "close" && event.name === "success")).toBe(true);
			expect(operations.some((event) => event.lane === "ahe" && event.name === "swapHead")).toBe(true);
			expect(() => assertObservedPersistenceBoundary(held)).toThrow(/cut\/vote\/replay\/publication already occurred/u);
			await coldSnapshot(primaryFilename, held, expected);
			await coldAhe(aheFilename, held, "boundary");
		} finally {
			if (cleanupSafe) rmSync(directory, { recursive: true, force: true });
			else console.error("PRODUCER_NATIVE_DIRECTORY_PRESERVED_UNCONFIRMED_EXIT", directory);
		}
	}, 20_000);

	it("case 6: real producer retention commits before synchronous hold/death; exact cold bytes/charge survive TTL with no new AHE generation/head or pre-kill cut/votes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "producer-native-red-"));
		let cleanupSafe = true;
		try {
			const expected = await expectedProducerContent();
			const built = await buildNativeProducerChild(directory);
			const primaryFilename = join(directory, "snapshot.sqlite");
			const aheFilename = join(directory, "ahe.sqlite");
			cleanupSafe = false;
			const result = await runNativeProducerChild({
				...built,
				directory,
				primaryFilename,
				aheFilename,
				mode: "producer",
			});
			cleanupSafe = result.cleanupSafe;
			console.info("PRODUCER_NATIVE_CASE_6", JSON.stringify({ result, build: built }));
			assertNativeTermination(result);
			const firstTerminal = result.messages.find((message) =>
				["checkpoint", "early-effect", "early-close-success"].includes(message.kind)
			);
			assert.ok(
				firstTerminal,
				"native producer must emit explicit entered checkpoint or early completion/effects, not setup timeout"
			);
			assertHeldProducerCheckpoint(firstTerminal);
			await coldSnapshot(primaryFilename, firstTerminal, expected);
			await coldAhe(aheFilename, firstTerminal, "entry");
		} finally {
			if (cleanupSafe) rmSync(directory, { recursive: true, force: true });
			else console.error("PRODUCER_NATIVE_DIRECTORY_PRESERVED_UNCONFIRMED_EXIT", directory);
		}
	}, 20_000);
});
