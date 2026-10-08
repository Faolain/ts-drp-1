import { consumeSnapshotVerificationReceipt } from "../../../packages/compaction/dist/src/snapshot-quarantine-receipt.js";
import type {
	SnapshotQuarantineScope,
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
