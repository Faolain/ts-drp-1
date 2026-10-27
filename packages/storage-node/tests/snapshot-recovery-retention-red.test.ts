import { snapshotQuarantineContract, snapshotRetirementContract } from "@ts-drp/storage/snapshot-transfer";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeSnapshotQuarantineStore as createLegacy } from "./fixtures/legacy-snapshot-transfer.mjs";
import { allowOutOfBandWrites } from "./fixtures/out-of-band-sqlite.js";
import { createSnapshotQuarantineFixture } from "../../../tests/fixtures/phase-4c-v3/snapshot-quarantine-contract.js";
import type {
	LegacyStore,
	OwnerImage,
	RecoveryStore,
} from "../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import { fixture, outcome, receiptFor, stable } from "../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import {
	expectedOrphanedCloseScopeCase,
	expectedRetentionCase,
	expectedTemporaryAdmissionCase,
	ORPHANED_CLOSE_SCOPE_CASES,
	RETENTION_CASES,
	type RetentionEnvironment,
	runOrphanedCloseScopeCase,
	runRetentionCase,
	runTemporaryAdmissionCase,
	TEMPORARY_ADMISSION_CASES,
} from "../../../tests/fixtures/snapshot-recovery-retention/contract.js";
import { createNodeSnapshotQuarantineStore } from "../src/snapshot-transfer.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
it("native snapshot admission image observes absent control without installing retirement authority", async () => {
	const directory = mkdtempSync(join(tmpdir(), "snapshot-admission-image-"));
	directories.push(directory);
	const primaryFilename = join(directory, "primary.sqlite");
	const filename = `${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`;
	const objectId = "snapshot-admission-image";
	let owner = createNodeSnapshotQuarantineStore({ primaryFilename });
	const nativeRows = (): unknown => {
		const db = new DatabaseSync(filename, { readOnly: true });
		try {
			return {
				owner: db.prepare("SELECT * FROM snapshot_owner_v2").all(),
				controls: db.prepare("SELECT * FROM snapshot_retirement_controls").all(),
				scopes: db.prepare("SELECT * FROM snapshot_scopes_v2").all(),
				chunks: db.prepare("SELECT * FROM snapshot_chunks_v2").all(),
			};
		} finally {
			db.close();
		}
	};
	try {
		const read = owner.readRetirementAdmissionImage;
		const retirement = owner.readRetirementImage;
		const acquire = owner.acquireRetirementControl;
		if (read === undefined || retirement === undefined || acquire === undefined)
			throw new Error("native admission image port absent");
		const before = nativeRows();
		const empty = await read({ objectId });
		expect(empty).toMatchObject({
			control: null,
			image: { scopeCount: 0, chunkCount: 0, metadataBytes: 0, scopes: [] },
		});
		expect(empty.image.imageDigest).toMatch(/^[0-9a-f]{64}$/u);
		expect(await outcome(() => retirement({ objectId }))).toMatchObject({ code: "incomplete" });
		expect(await outcome(() => acquire({ objectId }))).toMatchObject({ code: "incomplete" });
		expect(await outcome(() => read({ objectId: "" }))).toMatchObject({ code: "malformed-input" });
		expect(nativeRows()).toEqual(before);
		await owner.close();
		owner = createNodeSnapshotQuarantineStore({ primaryFilename });
		const reopenedRead = owner.readRetirementAdmissionImage;
		const reopenedRetirement = owner.readRetirementImage;
		const reopenedAcquire = owner.acquireRetirementControl;
		if (reopenedRead === undefined || reopenedRetirement === undefined || reopenedAcquire === undefined)
			throw new Error("reopened native admission image port absent");
		expect(await reopenedRead({ objectId })).toEqual(empty);
		const selected = createSnapshotQuarantineFixture({ objectId, epoch: 0, chunks: [Uint8Array.of(3, 5, 8)] });
		const scope = await owner.openScope(selected.declaration);
		try {
			await scope.complete(await receiptFor(scope, selected));
			await scope.retainForRecovery();
		} finally {
			await scope.release();
		}
		const installed = await reopenedRead({ objectId });
		expect(installed.control).toBeNull();
		expect(installed.image.scopeCount).toBe(1);
		expect(installed.image.imageDigest).not.toBe(empty.image.imageDigest);
		expect(await reopenedRetirement({ objectId })).toEqual(installed);
		const view = await reopenedAcquire({ objectId });
		try {
			expect(await reopenedRead({ objectId })).toEqual({
				control: view.control,
				image: installed.image,
			});
		} finally {
			await view.release();
		}
	} finally {
		await owner.close();
	}
});
it("native snapshot noncreating retirement source includes temporary metadata", async () => {
	const directory = mkdtempSync(join(tmpdir(), "snapshot-source-image-"));
	directories.push(directory);
	const primaryFilename = join(directory, "primary.sqlite");
	const filename = `${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`;
	const objectId = "snapshot-source-image";
	let owner = createNodeSnapshotQuarantineStore({ primaryFilename });
	try {
		for (const epoch of [0, 1]) {
			const selected = createSnapshotQuarantineFixture({ objectId, epoch, chunks: [Uint8Array.of(3, 5, 8)] });
			const scope = await owner.openScope(selected.declaration);
			try {
				await scope.complete(await receiptFor(scope, selected));
				if (epoch === 0) await scope.retainForRecovery();
			} finally {
				await scope.release();
			}
		}
		const read = owner.readRetirementImage;
		const acquire = owner.acquireRetirementControl;
		const inventory = owner.captureRecoveryRoleInventory;
		if (read === undefined || acquire === undefined || inventory === undefined)
			throw new Error("native source port absent");
		const before = await read({ objectId });
		expect(before.control).toBeNull();
		expect(before.image).toMatchObject({ scopeCount: 2, chunkCount: 2 });
		const census = await inventory({ objectId });
		expect(census.scopes).toHaveLength(1);
		const db = new DatabaseSync(filename);
		try {
			expect(db.prepare("SELECT count(*) AS n FROM snapshot_retirement_controls").get()?.n).toBe(0);
		} finally {
			db.close();
		}
		const view = await acquire({ objectId });
		try {
			const born = await read({ objectId });
			expect(born.image).toEqual(before.image);
			expect(born.control).toEqual(view.control);
		} finally {
			await view.release();
		}
		const stale = await acquire({ objectId });
		const raw = new DatabaseSync(filename);
		try {
			// This separate native connection lacks the owner's connection-local UDF.
			// Admit only this negative fixture's exact temporary metadata UPDATE,
			// and only while the actual addressed control is still idle.
			raw.function("snapshot_writer_v4", (event, selectedObject, epoch, anchor, manifestDigest, incarnation) => {
				const row = raw.prepare("SELECT record FROM snapshot_retirement_controls WHERE object_id=?").get(objectId);
				const control = snapshotRetirementContract.decodeControl(row?.record);
				const selected = stale.image.scopes.find((entry) => entry.scope.epoch === 1);
				if (
					event !== "UPDATE" ||
					selectedObject !== objectId ||
					epoch !== 1 ||
					selected === undefined ||
					anchor !== selected.scope.anchor ||
					manifestDigest !== selected.scope.manifestDigest ||
					incarnation !== selected.incarnation ||
					control.active !== null ||
					control.completed !== null ||
					!snapshotRetirementContract.allows(control, selected.scope, selected.incarnation)
				)
					throw new Error("foreign metadata fixture exceeded its unfenced scope");
				return 1;
			});
			raw.prepare("UPDATE snapshot_scopes_v2 SET expires_at=expires_at+1 WHERE object_id=? AND epoch=1").run(objectId);
		} finally {
			raw.close();
		}
		expect((await inventory({ objectId })).scopes).toEqual(census.scopes);
		const changed = await read({ objectId });
		expect(changed.image.imageDigest).not.toBe(before.image.imageDigest);
		expect(changed.control).toEqual(stale.control);
		expect(
			await outcome(() =>
				stale.prepareFence({
					decisionDigest: "33".repeat(32),
					sourceProofDigest: "44".repeat(32),
					throughEpoch: 0,
					protectedScopes: stale.image.scopes.filter((entry) => entry.scope.epoch === 0),
				})
			)
		).toMatchObject({ code: "stale-scope" });
		expect(await read({ objectId })).toEqual(changed);
		await owner.close();
		owner = createNodeSnapshotQuarantineStore({ primaryFilename });
		const reopened = owner.readRetirementImage;
		if (reopened === undefined) throw new Error("reopened source port absent");
		expect(await reopened({ objectId })).toEqual(changed);
	} finally {
		await owner.close();
	}
});
it("native cold four-reference classification marker stays held and rejects mismatched completed control", async () => {
	const directory = mkdtempSync(join(tmpdir(), "snapshot-classification-marker-"));
	directories.push(directory);
	const primaryFilename = join(directory, "primary.sqlite");
	const filename = `${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`;
	const objectId = "r".repeat(64);
	let owner = createNodeSnapshotQuarantineStore({ primaryFilename });
	try {
		for (const epoch of [0, 1, 2, 3]) {
			const selected = createSnapshotQuarantineFixture({ objectId, epoch, chunks: [Uint8Array.of(3, 5, 8)] });
			const scope = await owner.openScope(selected.declaration);
			try {
				await scope.complete(await receiptFor(scope, selected));
				await scope.retainForRecovery();
			} finally {
				await scope.release();
			}
		}
		const acquire = owner.acquireRetirementControl;
		const inventory = owner.captureRecoveryRoleInventory;
		if (acquire === undefined || inventory === undefined) throw new Error("native marker ports absent");
		const captured = await inventory({ objectId });
		const intent = snapshotQuarantineContract.captureClassificationIntent({
			objectId,
			decisionDigest: "d".repeat(64),
			sourceProofDigest: "e".repeat(64),
			promoted: captured.scopes.map(({ scope, incarnation, contentBytes }) => ({ scope, incarnation, contentBytes })),
		});
		expect(intent.promoted).toHaveLength(4);
		const pointer = JSON.stringify(intent);
		expect(Buffer.byteLength(pointer)).toBeGreaterThan(1024);
		const prepare = await acquire({ objectId });
		try {
			await prepare.prepareFence({
				decisionDigest: intent.decisionDigest,
				sourceProofDigest: intent.sourceProofDigest,
				throughEpoch: 3,
				protectedScopes: intent.promoted.map(({ scope, incarnation }) => ({ scope, incarnation })),
			});
		} finally {
			await prepare.release();
		}
		const commit = await acquire({ objectId });
		try {
			await commit.commitPrepared({
				decisionDigest: intent.decisionDigest,
				sourceProofDigest: intent.sourceProofDigest,
			});
		} finally {
			await commit.release();
		}
		const before = await owner.readRetirementImage?.({ objectId });
		const accounting = await owner.recoveryStatus();
		await owner.close();
		// A persisted-marker fixture, not an authenticated classification permit:
		// admit only this owner-row update while no native owner is open. The
		// original control was prepared/committed through its real native methods.
		const raw = new DatabaseSync(filename);
		let contentBefore: unknown;
		try {
			contentBefore = {
				scopes: raw.prepare("SELECT * FROM snapshot_scopes_v2 ORDER BY epoch").all(),
				chunks: raw.prepare("SELECT * FROM snapshot_chunks_v2 ORDER BY epoch,chunk_index").all(),
			};
			raw.function("snapshot_writer_v4", { varargs: true }, (event) => {
				if (event !== "owner") throw new Error("fixture refuses content mutation");
				return 1;
			});
			raw.prepare("UPDATE snapshot_owner_v2 SET classification_intent=? WHERE id=1").run(pointer);
		} finally {
			raw.close();
		}
		owner = createNodeSnapshotQuarantineStore({ primaryFilename });
		const pending = await owner.recoveryStatus();
		expect(pending).toEqual({ ...accounting, migration: "classification-required", classificationIntent: intent });
		expect(pending.legacyUnclassifiedScopes).toBe(0);
		const reopened = await owner.readRetirementImage?.({ objectId });
		expect(reopened?.image.scopes).toEqual(before?.image.scopes);
		expect(reopened?.image.scopeCount).toBe(before?.image.scopeCount);
		expect(reopened?.image.chunkCount).toBe(before?.image.chunkCount);
		expect(reopened?.image.metadataBytes).toBe(before?.image.metadataBytes);
		// The owner marker legitimately changes the whole-image digest.
		expect(reopened?.image.imageDigest).not.toBe(before?.image.imageDigest);
		expect(reopened?.control).toEqual(before?.control);
		await owner.close();
		const corrupt = new DatabaseSync(filename);
		try {
			if (before === undefined || before.control === null || before.control.completed === null)
				throw new Error("completed marker fixture absent");
			const changed = {
				...before.control,
				completed: { ...before.control.completed, sourceProofDigest: "f".repeat(64) },
			};
			corrupt
				.prepare("UPDATE snapshot_retirement_controls SET record=? WHERE object_id=?")
				.run(snapshotRetirementContract.encodeControl(changed), objectId);
		} finally {
			corrupt.close();
		}
		expect(await outcome(() => createNodeSnapshotQuarantineStore({ primaryFilename }))).toMatchObject({
			code: "poisoned",
		});
		const persisted = new DatabaseSync(filename, { readOnly: true });
		try {
			expect(
				persisted.prepare("SELECT classification_intent FROM snapshot_owner_v2 WHERE id=1").get()?.classification_intent
			).toBe(pointer);
			expect({
				scopes: persisted.prepare("SELECT * FROM snapshot_scopes_v2 ORDER BY epoch").all(),
				chunks: persisted.prepare("SELECT * FROM snapshot_chunks_v2 ORDER BY epoch,chunk_index").all(),
			}).toEqual(contentBefore);
		} finally {
			persisted.close();
		}
	} finally {
		await owner.close();
	}
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
			// Storage damage is out-of-band: past the owner's snapshot_writer_v4 fence.
			const db = allowOutOfBandWrites(new DatabaseSync(filename));
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
	for (const name of TEMPORARY_ADMISSION_CASES)
		it(`native temporary admission ${name}`, async () => {
			expect(await runTemporaryAdmissionCase(name, environment())).toEqual(expectedTemporaryAdmissionCase(name));
		});
	for (const name of ORPHANED_CLOSE_SCOPE_CASES)
		it(`native orphaned close scope ${name} is visible to the admission image`, async () => {
			expect(await runOrphanedCloseScopeCase(name, environment())).toEqual(expectedOrphanedCloseScopeCase(name));
		});
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
