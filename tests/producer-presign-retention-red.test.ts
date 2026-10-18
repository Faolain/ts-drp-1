import "fake-indexeddb/auto";
import * as compaction from "@ts-drp/compaction";
import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";

import {
	aheImage,
	assertNoDependence,
	assertRetained,
	assertSignedIdentity,
	assertTwoCheckpoints,
	barrier,
	charge,
	chunksFor,
	indexedDbPrecommitFault,
	openProducerFixture,
	pastTemporaryTtl,
	type ProducerFixture,
	type ScopeObservation,
	snapshotImage,
	sqlitePrecommitFault,
} from "./fixtures/producer-presign-retention/fixture.js";
import { receiptFor, fixture as snapshotFixture } from "./fixtures/snapshot-recovery-owner/contract.js";

type CloseResult = Awaited<ReturnType<ProducerFixture["prepared"]["handle"]["close"]>>;
type Outcome =
	| { readonly kind: "success"; readonly result: CloseResult }
	| { readonly kind: "rejected"; readonly error: unknown };

function observeCommitment(fixture: ProducerFixture, fail?: () => Error | undefined): { restore(): void } {
	const actual = compaction.deriveCloseSetHistoryCommitment;
	const spy = vi.spyOn(compaction, "deriveCloseSetHistoryCommitment").mockImplementation((input) => {
		fixture.record({ lane: "commitment", name: "derive" });
		const error = fail?.();
		if (error !== undefined) throw error;
		return actual(input);
	});
	return { restore: () => spy.mockRestore() };
}

function close(fixture: ProducerFixture): Promise<Outcome> {
	return fixture.prepared.handle.close().then(
		(result) => {
			fixture.record({
				lane: "close",
				name: "success",
				detail: { epoch: result.epoch, successorEpoch: result.successorEpoch },
			});
			return { kind: "success" as const, result };
		},
		(error: unknown) => ({ kind: "rejected" as const, error })
	);
}

function firstScope(fixture: ProducerFixture): ScopeObservation {
	const scope = fixture.scopes[0];
	assert.ok(scope, "PRODUCER_PERSISTENCE_NOT_ENTERED");
	assert.equal(scope.completed, true, "genuine verification must complete before this oracle");
	assert.equal(scope.decorated.verificationQuarantine, scope.backend.verificationQuarantine);
	return scope;
}

function retainedCalled(scope: ScopeObservation): void {
	assert.equal(
		scope.retentionCalls,
		1,
		"PRODUCER_MISSING_RETENTION: persistSnapshot must call retention on its original completed handle"
	);
}

async function success(fixture: ProducerFixture, outcome: Outcome, scope: ScopeObservation): Promise<void> {
	assert.equal(
		outcome.kind,
		"success",
		`genuine close rejected: ${outcome.kind === "rejected" ? String(outcome.error) : ""}`
	);
	if (outcome.kind !== "success") return;
	assert.equal(scope.released, true);
	await assertSignedIdentity(fixture, outcome.result, scope);
	await assertRetained(fixture, scope);
}

function hasCause(error: unknown, wanted: Error): boolean {
	if (error === wanted) return true;
	if (error === null || typeof error !== "object") return false;
	return hasCause(Reflect.get(error, "cause"), wanted);
}

async function temporaryControl(fixture: ProducerFixture): Promise<void> {
	const selected = snapshotFixture(`producer-unrelated-expired-${crypto.randomUUID()}`);
	const temporary = await fixture.owner.openScope(selected.declaration);
	await temporary.release();
}

function report(fixture: ProducerFixture, caseName: string): void {
	console.info(
		"PRODUCER_PRESIGN_CASE",
		JSON.stringify({
			adapter: fixture.adapter,
			caseName,
			beforeClose: fixture.beforeClose,
			persistenceEntries: fixture.persistenceEntries,
			operations: fixture.operations,
			scopes: fixture.scopes.map((scope) => ({
				id: scope.id,
				scope: scope.declaration.scope,
				completed: scope.completed,
				released: scope.released,
				retentionCalls: scope.retentionCalls,
				retained: scope.retained,
			})),
		})
	);
}

for (const adapter of ["SQLite/Node", "browser-adapter/fake-IndexedDB"] as const) {
	describe(`1b-1 producer pre-sign retention — ${adapter}`, () => {
		it("case 1: awaits retention on the same completed unreleased handle before commitment/replay/cut/vote/publication, then survives TTL", async () => {
			const fixture = await openProducerFixture({ adapter });
			const spy = observeCommitment(fixture);
			const hold = barrier();
			let pending: Promise<Outcome> | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				fixture.beforeRetention = async (scope): Promise<void> => {
					assert.equal(scope.completed, true);
					assert.equal(scope.released, false);
					hold.enter();
					await hold.released;
				};
				const earlyEffect = new Promise<string>((resolve) => {
					fixture.onOperation = (operation): void => {
						if (operation.lane !== "snapshot") resolve(`EARLY_${operation.lane}:${operation.name}`);
					};
				});
				pending = close(fixture);
				const entered = await Promise.race([
					hold.entered.then(() => "RETENTION_ENTERED"),
					earlyEffect,
					pending.then((outcome) => `EARLY_CLOSE_${outcome.kind}`),
					new Promise<string>((resolve) => {
						timer = setTimeout(() => resolve("RETENTION_SETUP_TIMEOUT"), 2_000);
					}),
				]);
				assert.equal(entered, "RETENTION_ENTERED", `PRODUCER_RETENTION_ORDERING:${entered}`);
				if (timer !== undefined) clearTimeout(timer);
				const scope = firstScope(fixture);
				retainedCalled(scope);
				expect(await scope.backend.status()).toMatchObject({ kind: "verified", retention: "temporary" });
				assert.equal(scope.released, false);
				await assertNoDependence(fixture);
				const settledWhileHeld = await Promise.race([
					pending.then(() => true),
					new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
				]);
				assert.equal(settledWhileHeld, false, "close must remain unsettled throughout the entered hold");
				await assertNoDependence(fixture);
				fixture.onOperation = undefined;
				hold.release();
				await success(fixture, await pending, scope);
				await temporaryControl(fixture);
				await pastTemporaryTtl(async () => {
					expect(await fixture.owner.sweepExpired()).toBe(1);
					await assertRetained(fixture, scope);
				});
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				hold.release();
				await pending;
				report(fixture, "1-awaited-ordering");
				spy.restore();
				await fixture.close();
			}
		});

		it("case 2: real finite-owner refusal precedes close dependence and leaves only its own collectible temporary residue", async () => {
			const fixture = await openProducerFixture({
				adapter,
				recoveryLimits: { maxRecoveryScopes: 2, maxRecoveryContentBytes: 268_435_456 },
			});
			const spy = observeCommitment(fixture);
			try {
				const fillers = [snapshotFixture("producer-capacity-filler-a"), snapshotFixture("producer-capacity-filler-b")];
				for (const selected of fillers) {
					const scope = await fixture.owner.openScope(selected.declaration);
					await scope.complete(await receiptFor(scope, selected));
					await scope.retainForRecovery();
					await scope.release();
				}
				const before = await snapshotImage(fixture);
				expect(before.scopes).toHaveLength(2);
				expect(before.scopes.every((row) => (row.objectId ?? row.object_id) !== fixture.prepared.objectId)).toBe(true);
				const ownerBefore = await fixture.owner.recoveryStatus();
				expect(ownerBefore.recoveryScopes).toBe(2);
				const outcome = await close(fixture);
				const scope = firstScope(fixture);
				retainedCalled(scope);
				assert.equal(outcome.kind, "rejected", "real recovery-full owner error must reject this close");
				if (outcome.kind === "rejected") expect(outcome.error).toMatchObject({ code: "recovery-full" });
				await assertNoDependence(fixture);
				expect(await fixture.owner.recoveryStatus()).toEqual(ownerBefore);
				const after = await snapshotImage(fixture);
				expect(after.scopes).toHaveLength(3);
				const ownRows = after.scopes.filter(
					(row) => (row.objectId ?? row.object_id) === scope.declaration.scope.objectId
				);
				expect(ownRows).toHaveLength(1);
				expect(ownRows[0]).toMatchObject({ state: "verified", retention: "temporary" });
				const fillerIds = new Set(fillers.map((selected) => selected.declaration.scope.objectId));
				expect(after.scopes.filter((row) => fillerIds.has(String(row.objectId ?? row.object_id)))).toEqual(
					before.scopes
				);
				expect(after.chunks.filter((row) => fillerIds.has(String(row.objectId ?? row.object_id)))).toEqual(
					before.chunks
				);
				for (const selected of fillers) {
					const retained = await fixture.owner.openScope(selected.declaration);
					expect(await chunksFor(retained, selected.declaration)).toEqual(selected.chunks);
					await retained.release();
				}
				await pastTemporaryTtl(async () => {
					expect(await fixture.owner.sweepExpired()).toBe(1);
					expect(await fixture.owner.inspectRecovery(scope.declaration)).toEqual({ kind: "missing" });
					expect(await snapshotImage(fixture)).toEqual(before);
					expect(await fixture.owner.recoveryStatus()).toEqual(ownerBefore);
				});
			} finally {
				report(fixture, "2-real-capacity-refusal");
				spy.restore();
				await fixture.close();
			}
		});

		it("case 3: genuine in-transaction precommit fault rejects without charge/effects; same binding retries exact scope once", async () => {
			const fixture = await openProducerFixture({ adapter });
			const spy = observeCommitment(fixture);
			const fault =
				adapter === "SQLite/Node"
					? sqlitePrecommitFault(fixture.primaryFilename)
					: indexedDbPrecommitFault(fixture.snapshotDatabaseName);
			try {
				if ("controller" in fault) fixture.retentionSignal = fault.controller.signal;
				const outcome = await close(fixture);
				const first = firstScope(fixture);
				retainedCalled(first);
				assert.equal(outcome.kind, "rejected");
				if (outcome.kind === "rejected") expect(hasCause(outcome.error, fault.error)).toBe(true);
				if ("controller" in fault) expect(fault.evidence).toEqual({ ownerWrites: 1, aborts: 1 });
				else expect(fault.evidence).toEqual({ commitsIntercepted: 1, ownedInsideTransaction: true });
				await assertNoDependence(fixture);
				expect(await fixture.owner.recoveryStatus()).toMatchObject({ recoveryScopes: 0, recoveryContentBytes: 0 });
				const beforeRetry = await snapshotImage(fixture);
				expect(beforeRetry.scopes).toHaveLength(1);
				expect(beforeRetry.scopes[0]).toMatchObject({ state: "verified", retention: "temporary" });
				fault.restore();
				fixture.retentionSignal = undefined;
				const retry = await close(fixture);
				expect(fixture.scopes).toHaveLength(2);
				const second = fixture.scopes[1];
				assert.ok(second);
				expect(second.declaration).toEqual(first.declaration);
				expect(second.chunks).toEqual(first.chunks);
				retainedCalled(second);
				await success(fixture, retry, second);
				const afterRetry = await snapshotImage(fixture);
				expect(afterRetry.chunks).toEqual(beforeRetry.chunks);
				expect(afterRetry.scopes).toEqual(beforeRetry.scopes.map((row) => ({ ...row, retention: "recovery" })));
				expect(fixture.operations.filter((event) => event.name === "cancel")).toEqual([]);
			} finally {
				fault.restore();
				report(fixture, "3-real-precommit-fault");
				spy.restore();
				await fixture.close();
			}
		});

		it("case 4: committed retention with lost acknowledgement stops close; TTL and same-binding retry preserve identity and single charge", async () => {
			const fixture = await openProducerFixture({ adapter });
			const spy = observeCommitment(fixture);
			const lostAck = new Error("INJECTED_PRODUCER_RETENTION_ACK_LOSS");
			try {
				fixture.afterRetention = (): Promise<void> => Promise.reject(lostAck);
				const outcome = await close(fixture);
				const first = firstScope(fixture);
				retainedCalled(first);
				assert.equal(outcome.kind, "rejected");
				if (outcome.kind === "rejected") expect(outcome.error).toBe(lostAck);
				assert.equal(first.retained, true);
				assert.equal(first.released, true);
				await assertNoDependence(fixture);
				await assertRetained(fixture, first);
				await temporaryControl(fixture);
				await pastTemporaryTtl(async () => {
					expect(await fixture.owner.sweepExpired()).toBe(1);
					await assertRetained(fixture, first);
				});
				const beforeRetry = await snapshotImage(fixture);
				fixture.afterRetention = undefined;
				const retry = await close(fixture);
				expect(fixture.scopes).toHaveLength(2);
				const second = fixture.scopes[1];
				assert.ok(second);
				expect(second.declaration).toEqual(first.declaration);
				expect(second.chunks).toEqual(first.chunks);
				retainedCalled(second);
				await success(fixture, retry, second);
				expect(await snapshotImage(fixture)).toEqual(beforeRetry);
				expect(fixture.operations.filter((event) => event.name === "cancel")).toEqual([]);
			} finally {
				report(fixture, "4-lost-acknowledgement");
				spy.restore();
				await fixture.close();
			}
		});

		it("case 5: first post-persistence commitment failure precedes replay/seal; retained debt survives, cached retry never reopens or promotes", async () => {
			const fixture = await openProducerFixture({ adapter });
			const injected = new Error("INJECTED_PRODUCER_POST_PERSISTENCE_COMMITMENT_FAILURE");
			let armed = true;
			const spy = observeCommitment(fixture, () => {
				if (!armed) return undefined;
				armed = false;
				return injected;
			});
			try {
				const outcome = await close(fixture);
				const scope = firstScope(fixture);
				assert.equal(outcome.kind, "rejected");
				if (outcome.kind === "rejected") expect(outcome.error).toBe(injected);
				retainedCalled(scope);
				assert.equal(scope.retained, true, "PRODUCER_PERSISTENCE_CACHE_MUST_MEAN_RETAINED");
				assert.equal(scope.released, true, "persistSnapshot must have completed its finally before derivation");
				const entry = assertTwoCheckpoints(fixture);
				const events = fixture.operations.slice(entry.operationCount);
				expect(events.filter((event) => event.lane === "commitment")).toHaveLength(1);
				expect(events.filter((event) => event.lane !== "snapshot" && event.lane !== "commitment")).toEqual([]);
				expect(await aheImage(fixture.prepared)).toEqual(entry.ahe);
				await assertRetained(fixture, scope);
				await temporaryControl(fixture);
				await pastTemporaryTtl(async () => {
					expect(await fixture.owner.sweepExpired()).toBe(1);
					await assertRetained(fixture, scope);
				});
				const beforeRetry = await snapshotImage(fixture);
				const persistenceEvents = fixture.operations.filter((event) => event.lane === "snapshot");
				await success(fixture, await close(fixture), scope);
				expect(fixture.scopes).toHaveLength(1);
				expect(fixture.persistenceEntries).toHaveLength(1);
				expect(fixture.operations.filter((event) => event.lane === "snapshot")).toEqual(persistenceEvents);
				expect(fixture.operations.filter((event) => event.lane === "commitment")).toHaveLength(2);
				expect(await snapshotImage(fixture)).toEqual(beforeRetry);
				expect((await fixture.owner.recoveryStatus()).recoveryContentBytes).toBe(charge(scope.declaration));
			} finally {
				report(fixture, "5-post-persistence-failure-cache");
				spy.restore();
				await fixture.close();
			}
		});
	});
}
