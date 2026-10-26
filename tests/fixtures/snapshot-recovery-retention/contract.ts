import { decodeCanonical, encodeCanonical, hashDomain } from "../../../packages/canonical/src/index.js";
import { consumeSnapshotVerificationReceipt } from "../../../packages/compaction/dist/src/snapshot-quarantine-receipt.js";
import type {
	SnapshotQuarantineDeclaration,
	SnapshotQuarantineScope,
	SnapshotRecoveryStore,
	SnapshotVerificationReceipt,
} from "../../../packages/storage/src/snapshot-transfer.js";
import { createSnapshotQuarantineFixture } from "../phase-4c-v3/snapshot-quarantine-contract.js";
import {
	fixture,
	outcome,
	type OwnerImage,
	promiseOutcome,
	receiptFor,
	type RecoveryEnvironment,
	seedLegacy,
	stable,
} from "../snapshot-recovery-owner/contract.js";

export type RetentionScope = SnapshotQuarantineScope<SnapshotVerificationReceipt>;
export type Fault =
	| "missing"
	| "extra"
	| "extra-oversized"
	| "extra-string"
	| "descriptor-corrupt"
	| "identity-conflict"
	| "poisoned-state"
	| "corrupt"
	| "missing-extra"
	| "owned-open-missing"
	| "owned-open-conflict"
	| "owned-open-missing-conflict"
	| "owned-verified-missing";
export interface RetentionEnvironment extends RecoveryEnvironment {
	fault(kind: Fault, objectId: string, charge: number): Promise<void>;
}

export const TEMPORARY_ADMISSION_CASES = ["count", "declared-bytes", "protected-expiry"] as const;
export type TemporaryAdmissionCase = (typeof TEMPORARY_ADMISSION_CASES)[number];

/**
 * Offered metadata only: no enormous payload is allocated or claimed verified.
 * @param objectId Fixture identity.
 * @param totalBytes Reserved declared chunk bytes.
 * @returns An unverified offered declaration.
 */
function offeredDeclaration(objectId: string, totalBytes: number): SnapshotQuarantineDeclaration {
	const original = createSnapshotQuarantineFixture({ objectId, epoch: 0, chunks: [Uint8Array.of(7)] });
	const chunks = Array.from({ length: Math.ceil(totalBytes / 131_072) }, (_, index) => ({
		index,
		byteLength: Math.min(131_072, totalBytes - index * 131_072),
		digest: "77".repeat(32),
	}));
	const manifest = decodeCanonical(original.declaration.exactCanonicalManifestBytes) as Record<string, unknown>;
	const exactCanonicalManifestBytes = encodeCanonical({ ...manifest, chunks, totalBytes });
	const manifestDigest = Array.from(hashDomain("ts-drp/snapshot-manifest/v3", exactCanonicalManifestBytes))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return { chunks, totalBytes, exactCanonicalManifestBytes, scope: { ...original.declaration.scope, manifestDigest } };
}

/**
 * Same original native environment and images; no policy substitution or fake storage.
 * @param name Focused admission scenario.
 * @param env Existing native fixture environment.
 * @returns Native observations for the scenario.
 */
export async function runTemporaryAdmissionCase(
	name: TemporaryAdmissionCase,
	env: RetentionEnvironment
): Promise<unknown> {
	let store = await env.open();
	const scopes: SnapshotQuarantineScope<SnapshotVerificationReceipt>[] = [];
	const originalNow = Date.now;
	try {
		if (name === "protected-expiry") {
			let now = originalNow();
			Date.now = (): number => now;
			const selected = createSnapshotQuarantineFixture({
				objectId: "temporary-protected-expiry",
				epoch: 0,
				chunks: [Uint8Array.of(7)],
			});
			const first = await store.openScope(selected.declaration);
			scopes.push(first);
			await first.complete(await receiptFor(first, selected));
			const native = store as unknown as SnapshotRecoveryStore<SnapshotVerificationReceipt>;
			const acquire = native.acquireRetirementControl;
			if (acquire === undefined) throw new Error("native retirement control port absent");
			const view = await acquire({ objectId: selected.declaration.scope.objectId });
			await view.prepareFence({
				decisionDigest: "33".repeat(32),
				sourceProofDigest: "44".repeat(32),
				throughEpoch: 0,
				protectedScopes: view.image.scopes,
			});
			await view.release();
			now = (await first.status()).expiresAt + 1;
			await first.release();
			await store.close();
			store = await env.open();
			const sweptProtected = await store.sweepExpired();
			for (let index = 0; index < 31; index++)
				scopes.push(
					await store.openScope(
						createSnapshotQuarantineFixture({
							objectId: `temporary-new-${index}`,
							chunks: [Uint8Array.of(index + 1)],
						}).declaration
					)
				);
			const before = stable(await env.image());
			const overflow = createSnapshotQuarantineFixture({
				objectId: "temporary-protected-overflow",
				chunks: [Uint8Array.of(88)],
			});
			const refused = await outcome(() => store.openScope(overflow.declaration));
			const unchanged = before === stable(await env.image());
			const exact = await store.openScope(selected.declaration);
			scopes.push(exact);
			const protectedCancel = await outcome(() => exact.cancel());
			const protectedUnchanged = before === stable(await env.image());
			const reopenedNative = store as unknown as SnapshotRecoveryStore<SnapshotVerificationReceipt>;
			const reopenedAcquire = reopenedNative.acquireRetirementControl;
			if (reopenedAcquire === undefined) throw new Error("native retirement control port absent");
			const releaseHold = await reopenedAcquire({ objectId: selected.declaration.scope.objectId });
			await releaseHold.abortPrepared({ decisionDigest: "33".repeat(32), sourceProofDigest: "44".repeat(32) });
			await releaseHold.release();
			const sweptAfterAbort = await store.sweepExpired();
			scopes.push(await store.openScope(overflow.declaration));
			return {
				refused: refused.code,
				unchanged,
				protectedCancel: protectedCancel.code,
				protectedUnchanged,
				sweptProtected,
				sweptAfterAbort,
				retainedScopes: (await env.image()).durableScopes.length,
				recoveryScopes: (await store.recoveryStatus()).recoveryScopes,
			};
		}
		if (name === "declared-bytes") {
			const half = 134_217_728;
			const a = offeredDeclaration("temporary-byte-a", half),
				b = offeredDeclaration("temporary-byte-b", half);
			const overflow = offeredDeclaration("temporary-byte-overflow", 1);
			const first = await store.openScope(a),
				second = await store.openScope(b);
			scopes.push(first, second);
			await first.release();
			const before = stable(await env.image());
			const refused = await outcome(() => store.openScope(overflow));
			const unchanged = before === stable(await env.image());
			const exact = await store.openScope(a);
			scopes.push(exact);
			await store.close();
			store = await env.open();
			const coldBefore = stable(await env.image());
			const cold = await outcome(() => store.openScope(overflow));
			const coldUnchanged = coldBefore === stable(await env.image());
			const canceled = await store.openScope(a);
			scopes.push(canceled);
			await canceled.cancel();
			const retry = await store.openScope(offeredDeclaration("temporary-byte-retry", half));
			scopes.push(retry);
			const image = await env.image();
			return {
				refused: refused.code,
				unchanged,
				cold: cold.code,
				coldUnchanged,
				exactResume: exact.scope.manifestDigest === a.scope.manifestDigest,
				reservedChunkBytes: image.durableScopes.reduce(
					(sum, row) => sum + Number(row.total_bytes ?? row.totalBytes),
					0
				),
				retainedScopes: image.durableScopes.length,
				storedChunks: image.durableChunks.length,
				policy: { maxTemporaryScopes: 32, maxTemporaryChunkBytes: 268_435_456 },
			};
		}
		const fixtures = Array.from({ length: 32 }, (_, index) =>
			createSnapshotQuarantineFixture({
				objectId: `temporary-count-${index.toString().padStart(2, "0")}`,
				epoch: 0,
				chunks: [Uint8Array.of(index + 1)],
			})
		);
		for (const selected of fixtures) scopes.push(await store.openScope(selected.declaration));
		const verified = scopes[0],
			poisoned = scopes[1],
			released = scopes[2],
			verifiedFixture = fixtures[0],
			poisonedFixture = fixtures[1],
			releasedFixture = fixtures[2];
		if (
			verified === undefined ||
			poisoned === undefined ||
			released === undefined ||
			verifiedFixture === undefined ||
			poisonedFixture === undefined ||
			releasedFixture === undefined
		)
			throw new Error("temporary count fixture is incomplete");
		await verified.complete(await receiptFor(verified, verifiedFixture));
		const poisonPort = poisoned.verificationQuarantine.open(new AbortController().signal);
		const poisonDescriptor = poisonedFixture.declaration.chunks[0],
			poisonBytes = poisonedFixture.chunks[0];
		if (poisonDescriptor === undefined || poisonBytes === undefined) throw new Error("poison fixture chunk absent");
		await poisonPort.write(poisonDescriptor, poisonBytes);
		await outcome(() => poisonPort.write(poisonDescriptor, Uint8Array.of(255)));
		await released.release();
		const native = store as unknown as SnapshotRecoveryStore<SnapshotVerificationReceipt>;
		const acquire = native.acquireRetirementControl;
		if (acquire === undefined) throw new Error("native retirement control port absent");
		const view = await acquire({ objectId: verifiedFixture.declaration.scope.objectId });
		await view.prepareFence({
			decisionDigest: "33".repeat(32),
			sourceProofDigest: "44".repeat(32),
			throughEpoch: 0,
			protectedScopes: view.image.scopes,
		});
		await view.release();
		const before = stable(await env.image());
		const overflow = createSnapshotQuarantineFixture({
			objectId: "temporary-count-overflow",
			chunks: [Uint8Array.of(99)],
		});
		const refused = await outcome(() => store.openScope(overflow.declaration));
		const unchanged = before === stable(await env.image());
		const exact = await store.openScope(verifiedFixture.declaration);
		scopes.push(exact);
		const protectedCancel = await outcome(() => exact.cancel());
		const protectedUnchanged = before === stable(await env.image());
		await store.close();
		store = await env.open();
		const coldBefore = stable(await env.image());
		const cold = await outcome(() => store.openScope(overflow.declaration));
		const coldUnchanged = coldBefore === stable(await env.image());
		const canceled = await store.openScope(releasedFixture.declaration);
		scopes.push(canceled);
		await canceled.cancel();
		const competitor = await env.open();
		let competition: readonly string[];
		try {
			const candidate = createSnapshotQuarantineFixture({
				objectId: "temporary-count-competing",
				chunks: [Uint8Array.of(98)],
			});
			const results = await Promise.all([
				outcome(() => store.openScope(overflow.declaration)),
				outcome(() => competitor.openScope(candidate.declaration)),
			]);
			for (const result of results)
				if (result.code === "none") scopes.push(result.value as SnapshotQuarantineScope<SnapshotVerificationReceipt>);
			competition = results.map((result) => result.code).sort();
		} finally {
			await competitor.close();
		}
		const promoted = await store.openScope(verifiedFixture.declaration);
		scopes.push(promoted);
		await promoted.retainForRecovery();
		const afterPromotion = await store.openScope(
			createSnapshotQuarantineFixture({ objectId: "temporary-count-after-promotion", chunks: [Uint8Array.of(100)] })
				.declaration
		);
		scopes.push(afterPromotion);
		const image = await env.image();
		return {
			refused: refused.code,
			unchanged,
			cold: cold.code,
			coldUnchanged,
			protectedCancel: protectedCancel.code,
			protectedUnchanged,
			exactResume: exact.scope.manifestDigest === verifiedFixture.declaration.scope.manifestDigest,
			poisoned: image.durableScopes.some((row) => row.state === "poisoned"),
			competition,
			temporaryScopes: image.durableScopes.filter((row) => row.retention === "temporary").length,
			recoveryScopes: (await store.recoveryStatus()).recoveryScopes,
			retainedScopes: image.durableScopes.length,
			policy: { maxTemporaryScopes: 32, maxTemporaryChunkBytes: 268_435_456 },
		};
	} finally {
		Date.now = originalNow;
		for (const scope of scopes) await scope.release();
		await store.close();
	}
}

/**
 * Expected native observations under the approved aggregate temporary policy.
 * @param name Focused admission scenario.
 * @returns Exact expected observations.
 */
export function expectedTemporaryAdmissionCase(name: TemporaryAdmissionCase): unknown {
	if (name === "protected-expiry")
		return {
			refused: "temporary-full",
			unchanged: true,
			protectedCancel: "recovery-owned",
			protectedUnchanged: true,
			sweptProtected: 0,
			sweptAfterAbort: 1,
			retainedScopes: 32,
			recoveryScopes: 0,
		};
	const common = {
		refused: "temporary-full",
		unchanged: true,
		cold: "temporary-full",
		coldUnchanged: true,
		exactResume: true,
		policy: { maxTemporaryScopes: 32, maxTemporaryChunkBytes: 268_435_456 },
	};
	return name === "declared-bytes"
		? { ...common, reservedChunkBytes: 268_435_456, retainedScopes: 2, storedChunks: 0 }
		: {
				...common,
				protectedCancel: "recovery-owned",
				protectedUnchanged: true,
				poisoned: true,
				competition: ["none", "temporary-full"],
				temporaryScopes: 32,
				recoveryScopes: 1,
				retainedScopes: 33,
			};
}
export const RETENTION_CASES = [
	"promote",
	"multichunk",
	"retry",
	"retry-full",
	"release-reopen-past-ttl",
	"legacy-barrier",
	"identity-conflict",
	"poisoned-state",
	"concurrent-same",
	"cross-store-same",
	"cross-store-compete",
	"count-full",
	"content-full",
	"manifest-charge",
	"unverified",
	"unverified-full",
	"closed-store",
	"absent",
	"expiry",
	"released",
	"aborted",
	"queued-abort",
	"options-capture",
	"queued-release",
	"aba",
	"protected",
	"past-ttl",
	"missing",
	"extra",
	"extra-oversized",
	"extra-string",
	"descriptor-corrupt",
	"corrupt",
	"missing-extra",
	"owned-open-missing",
	"owned-open-conflict",
	"owned-verified-missing",
	"owned-complete-missing",
	"owned-complete-conflict",
	"owned-complete-combined",
	"owned-combined-write-missing",
	"owned-combined-write-conflict",
	"owned-retain-missing",
	"owned-retain-conflict",
	"uncertainty-ttl-race",
	"supersede-lower-temporary",
] as const;
export type RetentionCase = (typeof RETENTION_CASES)[number];

/**
 * Invoke the runtime method without manufacturing a production interface before GREEN.
 * @param scope - Actual current adapter handle.
 * @param options - Optional cancellation signal.
 * @returns Runtime method result, preserving invocation shape.
 */
export function retain(scope: RetentionScope, options?: Readonly<{ signal?: AbortSignal }>): unknown {
	const method: unknown = Reflect.get(scope, "retainForRecovery");
	if (typeof method !== "function") throw new Error("RED: retainForRecovery API absent; native mechanism masked");
	return Reflect.apply(method, scope, [options]);
}

function combinedFaultWitness(image: OwnerImage, selected: ReturnType<typeof fixture>, expiry: number): unknown {
	const scope = image.durableScopes.find(
		(row) => (row.object_id ?? row.objectId) === selected.declaration.scope.objectId
	);
	const rows = image.durableChunks.filter(
		(row) => (row.object_id ?? row.objectId) === selected.declaration.scope.objectId
	);
	const occupied = rows.find((row) => (row.chunk_index ?? row.index) === 1);
	const bytes = occupied?.exact_bytes ?? occupied?.exactBytes;
	const expected = selected.chunks[1];
	return {
		missingIndexAbsent: !rows.some((row) => (row.chunk_index ?? row.index) === 0),
		occupiedIndexLengthExact:
			bytes instanceof Uint8Array && expected !== undefined && bytes.byteLength === expected.byteLength,
		occupiedBytesConflict: bytes instanceof Uint8Array && expected !== undefined && stable(bytes) !== stable(expected),
		ownedNonverified: scope?.retention === "recovery" && scope.state === "open",
		expiryPreserved: (scope?.expires_at ?? scope?.expiresAt) === expiry,
	};
}
const EXPECTED_COMBINED_FAULT = {
	missingIndexAbsent: true,
	occupiedIndexLengthExact: true,
	occupiedBytesConflict: true,
	ownedNonverified: true,
	expiryPreserved: true,
};

function promotionOnly(before: string, after: OwnerImage, objectId: string, charge: number): boolean {
	const temporary = (row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
		row.object_id === objectId || row.objectId === objectId ? { ...row, retention: "temporary" } : row;
	if (!Array.isArray(after.ownerRows)) throw new Error("owner image lacks row collection");
	const ownerRows = after.ownerRows.map((row: Record<string, unknown>) => {
		if (Reflect.has(row, "recovery_scopes"))
			return {
				...row,
				recovery_scopes: Number(row.recovery_scopes) - 1,
				recovery_content_bytes: Number(row.recovery_content_bytes) - charge,
			};
		return {
			...row,
			recoveryScopes: Number(row.recoveryScopes) - 1,
			recoveryContentBytes: Number(row.recoveryContentBytes) - charge,
		};
	});
	return (
		before ===
		stable({
			...after,
			ownerRows,
			scopes: after.scopes.map(temporary),
			durableScopes: after.durableScopes.map(temporary),
		})
	);
}

/**
 * Run the same behavioral oracle on native SQLite and IndexedDB owners.
 * @param name - Normative case selector.
 * @param env - Isolated physical owner and labeled fault injector.
 * @returns Detached observation for exact comparison.
 */
export async function runRetentionCase(name: RetentionCase, env: RetentionEnvironment): Promise<unknown> {
	const originalNow = Date.now;
	let now = 2_000_000_000_000;
	Date.now = (): number => now;
	if (name === "supersede-lower-temporary") {
		// A receive that died after opening its predecessor scope (then a checkpoint
		// past that epoch) leaves a temporary scope no install can ever retain. The
		// next retention of the SAME object at a higher epoch supersedes it; a
		// recovery scope, a higher temporary scope and another object's scope stay.
		try {
			const store = await env.open();
			try {
				const opened = async (objectId: string, epoch: number, verified: boolean): Promise<RetentionScope> => {
					const selected = createSnapshotQuarantineFixture({
						objectId,
						epoch,
						chunks: [Uint8Array.of(3, 5, epoch, 13)],
					});
					const scope = await store.openScope(selected.declaration);
					if (verified) await scope.complete(await receiptFor(scope, selected));
					return scope;
				};
				const recovered = await opened("retention-supersede", 0, true);
				await retain(recovered);
				await recovered.release();
				const handles = [
					await opened("retention-supersede", 1, true),
					await opened("retention-supersede", 2, false),
					await opened("retention-supersede", 5, true),
					await opened("retention-other", 1, true),
				];
				const current = await opened("retention-supersede", 3, true);
				const before = (await env.image()).durableScopes.length;
				await retain(current);
				for (const handle of [...handles, current]) await handle.release();
				const rows = (await env.image()).durableScopes
					.map((row) => [row.object_id ?? row.objectId, Number(row.epoch), row.retention])
					.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
				return { before, rows, recoveryScopes: (await store.recoveryStatus()).recoveryScopes };
			} finally {
				await store.close();
			}
		} finally {
			Date.now = originalNow;
		}
	}
	if (name === "legacy-barrier") {
		try {
			const legacy = await seedLegacy(env);
			await legacy.old.close();
			const migrated = await env.open();
			try {
				const scope = await migrated.openScope(legacy.verified.declaration);
				const before = stable(await env.image());
				return { ...(await promiseOutcome(() => retain(scope))), unchanged: before === stable(await env.image()) };
			} finally {
				await migrated.close();
			}
		} finally {
			Date.now = originalNow;
		}
	}
	const selected =
		name === "multichunk" || name.includes("combined")
			? createSnapshotQuarantineFixture({
					objectId: "retention-multi",
					chunks: [new Uint8Array(131_072).fill(37), Uint8Array.of(1, 9, 4)],
				})
			: fixture("retention-main");
	const charge = selected.declaration.totalBytes + selected.declaration.exactCanonicalManifestBytes.byteLength;
	const limits = {
		maxRecoveryScopes: name === "count-full" || name === "cross-store-compete" || name === "retry-full" ? 1 : 4,
		maxRecoveryContentBytes:
			name === "content-full" || name === "retry-full"
				? charge
				: name === "manifest-charge"
					? selected.declaration.totalBytes
					: 268_435_456,
	};
	const store = await env.open(limits);
	try {
		const scope = await store.openScope(selected.declaration);
		const spare = name.startsWith("owned-complete") ? await receiptFor(scope, selected) : undefined;
		if (name === "unverified-full") await receiptFor(scope, selected);
		else if (name !== "unverified") await scope.complete(await receiptFor(scope, selected));
		const expiry = (await scope.status()).expiresAt;
		if (name === "owned-combined-write-missing" || name === "owned-combined-write-conflict") {
			await env.fault("owned-open-missing-conflict", selected.declaration.scope.objectId, charge);
			const beforeImage = await env.image();
			const before = stable(beforeImage);
			const index = name === "owned-combined-write-missing" ? 0 : 1;
			const descriptor = selected.declaration.chunks[index];
			const bytes = selected.chunks[index];
			if (descriptor === undefined || bytes === undefined) throw new Error("combined fault fixture incomplete");
			const result = await outcome(() =>
				scope.verificationQuarantine.open(new AbortController().signal).write(descriptor, bytes)
			);
			return {
				code: result.code,
				unchanged: before === stable(await env.image()),
				injection: "raw-owned-nonverified-missing-and-corrupt-occupied-bytes",
				faultWitness: combinedFaultWitness(beforeImage, selected, expiry),
			};
		}
		if (name === "owned-retain-missing" || name === "owned-retain-conflict") {
			await env.fault(
				name === "owned-retain-missing" ? "owned-open-missing" : "owned-open-conflict",
				selected.declaration.scope.objectId,
				charge
			);
			const before = stable(await env.image());
			return { ...(await promiseOutcome(() => retain(scope))), unchanged: before === stable(await env.image()) };
		}
		if (spare !== undefined) {
			await env.fault(
				name === "owned-complete-combined"
					? "owned-open-missing-conflict"
					: name === "owned-complete-missing"
						? "owned-open-missing"
						: "owned-open-conflict",
				selected.declaration.scope.objectId,
				charge
			);
			const beforeImage = await env.image();
			const before = stable(beforeImage);
			const result = await outcome(() => scope.complete(spare));
			const authority = await outcome(() =>
				consumeSnapshotVerificationReceipt({
					expectedScope: selected.declaration.scope,
					quarantine: scope.verificationQuarantine,
					receipt: spare,
				})
			);
			return {
				code: result.code,
				receiptPreserved: authority.code === "none",
				...(name === "owned-complete-combined"
					? { faultWitness: combinedFaultWitness(beforeImage, selected, expiry) }
					: {}),
				unchanged: before === stable(await env.image()),
			};
		}
		if (name === "owned-open-missing" || name === "owned-open-conflict" || name === "owned-verified-missing") {
			await env.fault(name, selected.declaration.scope.objectId, charge);
			const before = stable(await env.image());
			const descriptor = selected.declaration.chunks[0];
			const originalBytes = selected.chunks[0];
			if (descriptor === undefined || originalBytes === undefined) throw new Error("fault control fixture absent");
			const bytes = name === "owned-open-conflict" ? new Uint8Array(originalBytes).fill(99) : originalBytes;
			const write = await outcome(() =>
				scope.verificationQuarantine.open(new AbortController().signal).write(descriptor, bytes)
			);
			const cancel = await outcome(() => scope.cancel());
			return { write: write.code, cancel: cancel.code, unchanged: before === stable(await env.image()) };
		}
		if (
			[
				"missing",
				"extra",
				"extra-oversized",
				"extra-string",
				"descriptor-corrupt",
				"identity-conflict",
				"poisoned-state",
				"corrupt",
				"missing-extra",
			].includes(name)
		)
			await env.fault(name as Fault, selected.declaration.scope.objectId, charge);
		if (name === "released") await scope.release();
		if (name === "closed-store") await store.close();
		if (name === "absent") await scope.cancel();
		if (name === "expiry") now = expiry;
		if (name === "aba") {
			await scope.cancel();
			await store.openScope(selected.declaration);
		}
		if (name === "uncertainty-ttl-race") {
			await store.close();
			const reopened = await env.open();
			try {
				const inspection = await reopened.inspectRecovery(selected.declaration);
				now = expiry;
				const replacement = await reopened.openScope(selected.declaration);
				const before = stable(await env.image());
				const result = await outcome(() => retain(replacement));
				return {
					inspected: inspection.kind,
					code: result.code,
					unchanged: before === stable(await env.image()),
					recoveryScopes: (await reopened.recoveryStatus()).recoveryScopes,
				};
			} finally {
				await reopened.close();
			}
		}
		const before = stable(await env.image());
		if (name === "cross-store-same" || name === "cross-store-compete") {
			const second = await env.open();
			try {
				const otherFixture = name === "cross-store-same" ? selected : fixture("retention-competitor");
				const other = await second.openScope(otherFixture.declaration);
				if (name === "cross-store-compete") await other.complete(await receiptFor(other, otherFixture));
				const results = await Promise.all([outcome(() => retain(scope)), outcome(() => retain(other))]);
				const owner = await store.recoveryStatus();
				return {
					codes: results.map((result) => result.code).sort(),
					recoveryScopes: owner.recoveryScopes,
					chargedOne:
						owner.recoveryContentBytes === charge ||
						owner.recoveryContentBytes ===
							otherFixture.declaration.totalBytes + otherFixture.declaration.exactCanonicalManifestBytes.byteLength,
				};
			} finally {
				await second.close();
			}
		}
		if (
			[
				"unverified",
				"unverified-full",
				"closed-store",
				"absent",
				"expiry",
				"released",
				"aborted",
				"queued-abort",
				"options-capture",
				"queued-release",
				"aba",
				"missing",
				"extra",
				"extra-oversized",
				"extra-string",
				"descriptor-corrupt",
				"identity-conflict",
				"poisoned-state",
				"corrupt",
				"missing-extra",
				"manifest-charge",
			].includes(name)
		) {
			const controller = new AbortController();
			if (name === "aborted") controller.abort();
			const options = { signal: controller.signal };
			const pending = promiseOutcome(() => retain(scope, options));
			if (name === "options-capture") options.signal = new AbortController().signal;
			if (name === "queued-abort" || name === "options-capture") controller.abort();
			if (name === "queued-release") await scope.release();
			return { ...(await pending), unchanged: before === stable(await env.image()) };
		}
		const result = await outcome(() =>
			name === "concurrent-same" ? Promise.all([retain(scope), retain(scope)]) : retain(scope)
		);
		if (result.code !== "none")
			return { code: result.code, detail: result.detail, nativeMechanism: "masked-before-retention" };
		const promotedImage = await env.image();
		if (!promotionOnly(before, promotedImage, selected.declaration.scope.objectId, charge))
			return { code: "mutation-outside-retention-and-counters" };
		const promoted = stable(promotedImage);
		if (name === "release-reopen-past-ttl") {
			await scope.release();
			await store.close();
			now = expiry + 10_000;
			const reopened = await env.open();
			try {
				const inspected = await reopened.inspectRecovery(selected.declaration);
				const current = await reopened.openScope(selected.declaration);
				const descriptor = selected.declaration.chunks[0];
				if (descriptor === undefined) throw new Error("fixture incomplete");
				const bytes = await current.verificationQuarantine.open(new AbortController().signal).read(descriptor);
				await retain(current);
				return {
					inspected: inspected.kind,
					kind: (await current.status()).kind,
					bytesExact: stable(bytes) === stable(selected.chunks[0]),
					unchanged: promoted === stable(await env.image()),
					recoveryScopes: (await reopened.recoveryStatus()).recoveryScopes,
				};
			} finally {
				await reopened.close();
			}
		}
		if (name === "retry" || name === "retry-full") {
			if (name === "retry-full") now = expiry + 1;
			await retain(scope);
			return {
				unchanged: promoted === stable(await env.image()),
				recoveryScopes: (await store.recoveryStatus()).recoveryScopes,
			};
		}
		if (name === "count-full" || name === "content-full") {
			const otherFixture = fixture("retention-other");
			const other = await store.openScope(otherFixture.declaration);
			await other.complete(await receiptFor(other, otherFixture));
			const beforeOther = stable(await env.image());
			return { code: (await outcome(() => retain(other))).code, unchanged: beforeOther === stable(await env.image()) };
		}
		if (name === "protected" || name === "past-ttl") {
			now = name === "past-ttl" ? expiry + 10_000 : expiry;
			const cancel = await outcome(() => scope.cancel());
			const swept = await store.sweepExpired();
			await retain(scope);
			return {
				cancel: cancel.code,
				swept,
				unchanged: promoted === stable(await env.image()),
				kind: (await scope.status()).kind,
				inspection: (await store.inspectRecovery(selected.declaration)).kind,
			};
		}
		const status = await scope.status();
		const owner = await store.recoveryStatus();
		return {
			kind: status.kind,
			retention: status.retention,
			expiryPreserved: status.expiresAt === expiry,
			recoveryScopes: owner.recoveryScopes,
			chargedExactly: owner.recoveryContentBytes === charge,
		};
	} finally {
		Date.now = originalNow;
		await store.close();
	}
}

/**
 * Normative outcomes are shared, never inferred from the adapter result.
 * @param name - Normative case selector.
 * @returns Expected behavior independent of actual observations.
 */
export function expectedRetentionCase(name: RetentionCase): unknown {
	if (name === "supersede-lower-temporary")
		return {
			before: 6,
			rows: [
				["retention-other", 1, "temporary"],
				["retention-supersede", 0, "recovery"],
				["retention-supersede", 3, "recovery"],
				["retention-supersede", 5, "temporary"],
			],
			recoveryScopes: 2,
		};
	if (name === "owned-combined-write-missing" || name === "owned-combined-write-conflict")
		return {
			code: "poisoned",
			unchanged: true,
			injection: "raw-owned-nonverified-missing-and-corrupt-occupied-bytes",
			faultWitness: EXPECTED_COMBINED_FAULT,
		};
	if (name === "release-reopen-past-ttl")
		return { inspected: "present", kind: "verified", bytesExact: true, unchanged: true, recoveryScopes: 1 };
	if (name === "cross-store-same" || name === "cross-store-compete")
		return {
			codes: name === "cross-store-same" ? ["none", "none"] : ["none", "recovery-full"],
			recoveryScopes: 1,
			chargedOne: true,
		};
	if (name.startsWith("owned-complete"))
		return {
			code: "poisoned",
			receiptPreserved: true,
			unchanged: true,
			...(name === "owned-complete-combined" ? { faultWitness: EXPECTED_COMBINED_FAULT } : {}),
		};
	if (name === "owned-open-missing" || name === "owned-open-conflict" || name === "owned-verified-missing")
		return {
			write: name === "owned-verified-missing" ? "closed" : "poisoned",
			cancel: "recovery-owned",
			unchanged: true,
		};
	if (name === "uncertainty-ttl-race")
		return { inspected: "present", code: "incomplete", unchanged: true, recoveryScopes: 0 };
	const codes: Partial<Record<RetentionCase, string>> = {
		"unverified": "incomplete",
		"owned-retain-missing": "poisoned",
		"owned-retain-conflict": "poisoned",
		"unverified-full": "incomplete",
		"closed-store": "closed",
		"absent": "expired",
		"expiry": "expired",
		"released": "closed",
		"aborted": "aborted",
		"queued-abort": "aborted",
		"options-capture": "aborted",
		"legacy-barrier": "migration-required",
		"identity-conflict": "conflict",
		"poisoned-state": "poisoned",
		"queued-release": "closed",
		"aba": "stale-scope",
		"missing": "incomplete",
		"extra": "poisoned",
		"extra-oversized": "poisoned",
		"extra-string": "poisoned",
		"descriptor-corrupt": "poisoned",
		"corrupt": "poisoned",
		"missing-extra": "poisoned",
		"manifest-charge": "recovery-full",
	};
	if (codes[name]) return { invocation: "returned", thenable: true, code: codes[name], unchanged: true };
	if (name === "retry" || name === "retry-full") return { unchanged: true, recoveryScopes: 1 };
	if (name === "count-full" || name === "content-full") return { code: "recovery-full", unchanged: true };
	if (name === "protected" || name === "past-ttl")
		return { cancel: "recovery-owned", swept: 0, unchanged: true, kind: "verified", inspection: "present" };
	return { kind: "verified", retention: "recovery", expiryPreserved: true, recoveryScopes: 1, chargedExactly: true };
}
