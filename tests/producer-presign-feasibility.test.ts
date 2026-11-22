import "fake-indexeddb/auto";
import { decodeCanonical } from "@ts-drp/canonical";
import * as compaction from "@ts-drp/compaction";
import { verifySnapshotStreamWithReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";

import { openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import {
	assertSignedIdentity,
	assertTwoCheckpoints,
	barrier,
	chunksFor,
	indexedDbPrecommitFault,
	openProducerFixture,
	snapshotImage,
	sqlitePrecommitFault,
} from "./fixtures/producer-presign-retention/fixture.js";
import { receiptFor, fixture as snapshotFixture } from "./fixtures/snapshot-recovery-owner/contract.js";

it("precondition: exported commitment spy intercepts the dynamically imported genuine close", async () => {
	const stacks: string[] = [];
	const actual = compaction.deriveCloseSetHistoryCommitment;
	const spy = vi.spyOn(compaction, "deriveCloseSetHistoryCommitment").mockImplementation((input) => {
		stacks.push(new Error("commitment-observation").stack ?? "");
		return actual(input);
	});
	try {
		const fixture = await openGenuineCreatorAdoptionFixture();
		try {
			expect(
				stacks.some((stack) => stack.includes("creator-close.ts")),
				JSON.stringify(stacks)
			).toBe(true);
		} finally {
			await fixture.close();
		}
	} finally {
		spy.mockRestore();
	}
});

for (const adapter of ["SQLite/Node", "browser-adapter/fake-IndexedDB"] as const) {
	it(`precondition: ${adapter} genuine queued issue delays staging; only its journal append precedes persistence and its content is folded`, async () => {
		const fixture = await openProducerFixture({ adapter });
		const hold = barrier();
		let pendingClose: ReturnType<typeof fixture.prepared.handle.close> | undefined;
		const issue = fixture.prepared.plane.issueLocal({
			operations: [{ logicalTime: 3, operation: { action: "add", value: 7 } }],
			signRegisteredVertexDigest: async (digest) => {
				hold.enter();
				await hold.released;
				return fixture.prepared.signRegisteredVertexDigest(digest);
			},
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const entered = await Promise.race([
				hold.entered.then(() => "entered"),
				issue.then(() => "settled-before-signing-hold"),
				new Promise<string>((resolve) => {
					timer = setTimeout(() => resolve("signing-hold-timeout"), 2_000);
				}),
			]);
			expect(entered).toBe("entered");
			if (timer !== undefined) clearTimeout(timer);
			pendingClose = fixture.prepared.handle.close();
			const progressed = await Promise.race([
				pendingClose.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
			]);
			expect(progressed).toBe(false);
			expect(fixture.persistenceEntries).toEqual([]);
			expect(fixture.scopes).toEqual([]);
			expect(fixture.operations.slice(fixture.beforeClose.operationCount)).toEqual([]);
			hold.release();
			expect(await issue).toMatchObject({ ok: true });
			const result = await pendingClose;
			const entry = fixture.persistenceEntries[0];
			assert.ok(entry);
			const staging = entry.operations.slice(fixture.beforeClose.operationCount);
			expect(staging).toEqual([{ lane: "journal", name: "appendAccepted" }]);
			expect(entry.ahe).toEqual(fixture.beforeClose.ahe);
			const scope = fixture.scopes[0];
			assert.ok(scope);
			const payload = decodeCanonical(Uint8Array.from(Buffer.concat(scope.chunks))) as { application: unknown };
			expect(payload.application).toBe(10);
			expect(result.closedVertexCount).toBe(3);
			await assertSignedIdentity(fixture, result, scope);
			console.info(
				"PRODUCER_QUEUED_STAGING_CONTROL",
				JSON.stringify({
					adapter,
					beforeClose: fixture.beforeClose,
					persistenceEntry: entry,
					staging,
					application: payload.application,
					closedVertexCount: result.closedVertexCount,
				})
			);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			hold.release();
			await Promise.allSettled([issue, ...(pendingClose === undefined ? [] : [pendingClose])]);
			await fixture.close();
		}
	});

	it(`precondition: ${adapter} real strict retention and zero-write temporary/recovery reverification`, async () => {
		const fixture = await openProducerFixture({ adapter });
		try {
			expect((await snapshotImage(fixture)).version).toBe(2);
			expect(await fixture.owner.recoveryStatus()).toMatchObject({
				migration: "ready",
				recoveryScopes: 0,
				recoveryContentBytes: 0,
			});
			const selected = snapshotFixture(`producer-retry-precondition-${adapter}`);
			const first = await fixture.owner.openScope(selected.declaration);
			await first.complete(await receiptFor(first, selected));
			await first.release();
			for (const retention of ["temporary", "recovery"]) {
				const scope = await fixture.owner.openScope(selected.declaration);
				try {
					expect(await scope.status()).toMatchObject({ kind: "verified", retention });
					const before = await snapshotImage(fixture);
					let sourceReads = 0;
					const verified = verifySnapshotStreamWithReceipt({
						exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
						expectedManifestDigest: selected.declaration.scope.manifestDigest,
						expectedScope: selected.declaration.scope,
						profile: { maxManifestBytes: 212_387, maxSnapshotBytes: 268_435_456, snapshotChunkBytes: 131_072 },
						quarantine: scope.verificationQuarantine,
						source: {
							read: () => {
								sourceReads += 1;
								throw new Error("UNEXPECTED_RETRY_SOURCE_FETCH");
							},
						},
					});
					await verified.completion;
					const completed = await scope.complete(await verified.receipt);
					expect(completed.scope).toEqual(selected.declaration.scope);
					expect(sourceReads).toBe(0);
					const after = await snapshotImage(fixture);
					expect(after.chunks).toEqual(before.chunks);
					expect(after.scopes).toEqual(before.scopes);
					expect(await chunksFor(scope, selected.declaration)).toEqual(selected.chunks);
					await scope.retainForRecovery();
					expect(await fixture.owner.recoveryStatus()).toMatchObject({
						recoveryScopes: 1,
						recoveryContentBytes:
							selected.declaration.totalBytes + selected.declaration.exactCanonicalManifestBytes.byteLength,
					});
					console.info(
						"PRODUCER_REVERIFICATION_CONTROL",
						JSON.stringify({
							adapter,
							initialRetention: retention,
							sourceReads,
							exactUnchangedChunkImage: true,
							exactUnchangedScopeImage: true,
							owner: await fixture.owner.recoveryStatus(),
						})
					);
				} finally {
					await scope.release();
				}
			}
			if (adapter === "browser-adapter/fake-IndexedDB") {
				const strict = fixture.strict.filter(
					(event) => event.database === `${fixture.snapshotDatabaseName}--drp-snapshot-quarantine-v1`
				);
				expect(strict.length).toBeGreaterThanOrEqual(2);
				expect(strict.every((event) => event.requested === "strict" && event.reported === "strict")).toBe(true);
				console.info("PRODUCER_STRICT_IDB_CONTROL", JSON.stringify(strict));
			}
		} finally {
			await fixture.close();
		}
	});

	it(`precondition: ${adapter} fault enters actual promotion transaction and rolls back real writes`, async () => {
		const fixture = await openProducerFixture({ adapter });
		let restore = (): void => undefined;
		try {
			const selected = snapshotFixture(`producer-precommit-precondition-${adapter}`);
			const scope = await fixture.owner.openScope(selected.declaration);
			await scope.complete(await receiptFor(scope, selected));
			const before = await snapshotImage(fixture);
			const fault =
				adapter === "SQLite/Node"
					? sqlitePrecommitFault(fixture.primaryFilename)
					: indexedDbPrecommitFault(fixture.snapshotDatabaseName);
			restore = fault.restore;
			let caught: unknown;
			try {
				await scope.retainForRecovery("controller" in fault ? { signal: fault.controller.signal } : undefined);
			} catch (error) {
				caught = error;
			}
			assert.ok(caught, "real transaction injection must reject");
			expect(containsCause(caught, fault.error)).toBe(true);
			if ("controller" in fault) expect(fault.evidence).toEqual({ ownerWrites: 1, aborts: 1 });
			else expect(fault.evidence).toEqual({ commitsIntercepted: 1, ownedInsideTransaction: true });
			restore();
			expect(await snapshotImage(fixture)).toEqual(before);
			expect(await fixture.owner.recoveryStatus()).toMatchObject({ recoveryScopes: 0, recoveryContentBytes: 0 });
			await scope.retainForRecovery();
			expect(await scope.status()).toMatchObject({ kind: "verified", retention: "recovery" });
			console.info(
				"PRODUCER_REAL_PRECOMMIT_CONTROL",
				JSON.stringify({ adapter, faultEvidence: fault.evidence, exactRollbackImage: true, preservedCause: true })
			);
			await scope.release();
		} finally {
			restore();
			await fixture.close();
		}
	});

	it(`precondition: ${adapter} preserves original minted seal ports and receipt quarantine; classifies staging`, async () => {
		const fixture = await openProducerFixture({ adapter });
		const actual = compaction.deriveCloseSetHistoryCommitment;
		const stacks: string[] = [];
		const spy = vi.spyOn(compaction, "deriveCloseSetHistoryCommitment").mockImplementation((input) => {
			stacks.push(new Error("producer-commitment").stack ?? "");
			fixture.operations.push({ lane: "commitment", name: "derive" });
			return actual(input);
		});
		try {
			const result = await fixture.prepared.handle.close();
			const entry = assertTwoCheckpoints(fixture);
			expect(stacks.some((stack) => stack.includes("creator-close.ts"))).toBe(true);
			expect(fixture.scopes).toHaveLength(1);
			const scope = fixture.scopes[0];
			assert.ok(scope);
			expect(scope.decorated.verificationQuarantine).toBe(scope.backend.verificationQuarantine);
			expect(scope.completed).toBe(true);
			expect(scope.released).toBe(true);
			await assertSignedIdentity(fixture, result, scope);
			const postEntry = fixture.operations.slice(entry.operationCount);
			expect(postEntry.some((event) => event.lane === "journal" && event.name === "readPage")).toBe(true);
			expect(postEntry.some((event) => event.lane === "seal" && event.name === "enrollment-call")).toBe(true);
			expect(postEntry.some((event) => event.lane === "seal" && event.name === "sealEvidence:put")).toBe(true);
			for (const phase of ["prepare", "commit"]) {
				expect(
					postEntry.some(
						(event) =>
							event.lane === "seal" &&
							event.name === "voteSlots:add" &&
							(event.detail as { phase?: string }).phase === phase
					)
				).toBe(true);
			}
			expect(postEntry.some((event) => event.lane === "ahe" && event.name === "swapHead")).toBe(true);
			expect(postEntry.some((event) => event.lane === "close")).toBe(true);
			console.info(
				"PRODUCER_INSTRUMENTATION_CONTROL",
				JSON.stringify({
					adapter,
					beforeClose: fixture.beforeClose,
					persistenceEntry: entry,
					operations: fixture.operations,
					strict: fixture.strict,
					originalQuarantine: scope.decorated.verificationQuarantine === scope.backend.verificationQuarantine,
					genuineSignedIdentity: true,
				})
			);
		} finally {
			spy.mockRestore();
			await fixture.close();
		}
	});
}

function containsCause(error: unknown, wanted: Error): boolean {
	if (error === wanted) return true;
	if (error === null || typeof error !== "object" || !Reflect.has(error, "cause")) return false;
	return containsCause(Reflect.get(error, "cause"), wanted);
}
