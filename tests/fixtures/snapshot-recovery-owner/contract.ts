import { verifySnapshotStreamWithReceipt } from "../../../packages/compaction/dist/src/snapshot-quarantine-receipt.js";
import type {
	SnapshotQuarantineDeclaration,
	SnapshotQuarantineScope,
	SnapshotQuarantineStatus,
	SnapshotVerificationReceipt,
} from "../../../packages/storage/src/snapshot-transfer.js";
import {
	createSnapshotQuarantineFixture,
	type SnapshotQuarantineFixture,
} from "../phase-4c-v3/snapshot-quarantine-contract.js";

export interface RecoveryLimits {
	readonly maxRecoveryScopes: number;
	readonly maxRecoveryContentBytes: number;
}
export interface RecoveryOwnerStatus {
	readonly limits: RecoveryLimits;
	readonly recoveryScopes: number;
	readonly recoveryContentBytes: number;
	readonly legacyUnclassifiedScopes: number;
	readonly legacyUnclassifiedContentBytes: number;
	readonly migration: "ready" | "classification-required";
}
export type RecoveryStatus = SnapshotQuarantineStatus & {
	readonly retention: "temporary" | "recovery" | "legacy-unclassified";
};
// Historical factory annotations retain the old surface when the production status gains retention.
export type Scope = Omit<SnapshotQuarantineScope<SnapshotVerificationReceipt>, "status" | "retainForRecovery"> & {
	status(
		options?: Readonly<{ signal?: AbortSignal }>
	): Promise<
		Readonly<{ expiresAt: number; kind: "open" | "poisoned" | "verified"; missingIndices: readonly number[] }>
	>;
};
export interface LegacyStore {
	openScope(declaration: SnapshotQuarantineDeclaration, options?: Readonly<{ signal?: AbortSignal }>): Promise<Scope>;
	close(): Promise<void>;
	sweepExpired(options?: Readonly<{ signal?: AbortSignal }>): Promise<number>;
}
export type RecoveryStore = Omit<LegacyStore, "openScope"> & {
	openScope(
		declaration: SnapshotQuarantineDeclaration,
		options?: Readonly<{ signal?: AbortSignal }>
	): Promise<SnapshotQuarantineScope<SnapshotVerificationReceipt>>;
	inspectRecovery(
		declaration: SnapshotQuarantineDeclaration,
		options?: Readonly<{ signal?: AbortSignal }>
	): Promise<Readonly<{ kind: "missing" }> | Readonly<{ kind: "present"; status: RecoveryStatus }>>;
	recoveryStatus(options?: Readonly<{ signal?: AbortSignal }>): Promise<RecoveryOwnerStatus>;
};
export interface OwnerImage {
	readonly version: number;
	readonly names: readonly string[];
	readonly schema: unknown;
	readonly ownerRows: unknown;
	readonly durableScopes: readonly Readonly<Record<string, unknown>>[];
	readonly durableChunks: readonly Readonly<Record<string, unknown>>[];
	readonly scopes: readonly Readonly<Record<string, unknown>>[];
	readonly chunks: readonly Readonly<Record<string, unknown>>[];
}
export interface RecoveryEnvironment {
	open(limits?: unknown, explicit?: boolean): Promise<RecoveryStore>;
	legacy(): Promise<LegacyStore>;
	image(): Promise<OwnerImage>;
	exists(): Promise<boolean>;
}
export const DEFAULT_LIMITS: RecoveryLimits = Object.freeze({
	maxRecoveryScopes: 4,
	maxRecoveryContentBytes: 268_435_456,
});
export const READY_STATUS: RecoveryOwnerStatus = Object.freeze({
	limits: DEFAULT_LIMITS,
	recoveryScopes: 0,
	recoveryContentBytes: 0,
	legacyUnclassifiedScopes: 0,
	legacyUnclassifiedContentBytes: 0,
	migration: "ready",
});
export const HANDLE_OPERATIONS = ["cancel", "read", "write", "complete", "missing", "status"] as const;
export type HandleOperation = (typeof HANDLE_OPERATIONS)[number];
export const COMMON_CASES = [
	"fresh",
	"temporary-status",
	"policy",
	"policy-invalid",
	"policy-shapes",
	"policy-concurrent",
	"inspect",
	"inspect-unwritten",
	"legacy-preservation",
	"legacy-debt",
	"legacy-mutations",
	"legacy-unknown-descriptors",
	"queued-release-cancel",
	"cancel-released-promise",
	"cancel-closed-promise",
	"cancel-aborted-promise",
	"promise-invocation-control",
	"absent-scope",
	"cross-store-aba",
	"temporary-regression",
	...HANDLE_OPERATIONS.map((name) => `aba-${name}` as const),
	...HANDLE_OPERATIONS.map((name) => `released-${name}` as const),
] as const;
export type CommonCase = (typeof COMMON_CASES)[number];

/**
 * Valid tiny fixture sharing the existing canonical manifest/chunk builder.
 * @param objectId - Isolated fixture identity.
 * @returns Exact declaration and payload chunks.
 */
export function fixture(objectId = "snapshot-recovery-owner"): SnapshotQuarantineFixture {
	return createSnapshotQuarantineFixture({ objectId, chunks: [Uint8Array.of(3, 5, 8, 13)] });
}

/**
 * Capture adapter errors without accepting arbitrary failure as success.
 * @param action - Actual adapter operation.
 * @returns Exact code, value or diagnostic.
 */
export async function outcome(action: () => unknown): Promise<{ code: string; value?: unknown; detail?: string }> {
	try {
		return { code: "none", value: await action() };
	} catch (error) {
		return {
			code:
				error !== null && typeof error === "object" && Reflect.has(error, "code")
					? String(Reflect.get(error, "code"))
					: "unclassified-error",
			detail: String(error),
		};
	}
}

/**
 * Distinguish an invocation-time exception from a returned rejecting promise.
 * @param action - Direct non-async invocation; do not wrap it in a promise first.
 * @returns Invocation shape and subsequent classified settlement.
 */
export async function promiseOutcome(
	action: () => unknown
): Promise<{ invocation: string; thenable: boolean; code: string }> {
	let returned: unknown;
	try {
		returned = action();
	} catch (error) {
		return {
			invocation: "threw",
			thenable: false,
			code: (
				await outcome(() => {
					throw error;
				})
			).code,
		};
	}
	const thenable =
		returned !== null &&
		(typeof returned === "object" || typeof returned === "function") &&
		typeof Reflect.get(returned, "then") === "function";
	return { invocation: "returned", thenable, code: (await outcome(() => returned)).code };
}

/**
 * Compare exact observations independently of property insertion order.
 * @param value - Detached observation.
 * @returns Stable scalar representation.
 */
export function stable(value: unknown): string {
	const normalize = (input: unknown): unknown => {
		if (input instanceof Uint8Array) return Array.from(input);
		if (Array.isArray(input)) return input.map(normalize);
		if (input !== null && typeof input === "object")
			return Object.fromEntries(
				Object.entries(input)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, entry]) => [key, normalize(entry)])
			);
		return input;
	};
	return JSON.stringify(normalize(value));
}

/**
 * Genuine receipt production without a fabricated verified marker.
 * @param scope - Actual adapter scope.
 * @param selected - Exact fixture declaration and chunks.
 * @returns Genuine receipt bound to this quarantine.
 */
export async function receiptFor(
	scope: Scope,
	selected: SnapshotQuarantineFixture
): Promise<SnapshotVerificationReceipt> {
	const stream = verifySnapshotStreamWithReceipt({
		exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
		expectedManifestDigest: selected.declaration.scope.manifestDigest,
		expectedScope: selected.declaration.scope,
		profile: { maxManifestBytes: 212_387, maxSnapshotBytes: 268_435_456, snapshotChunkBytes: 131_072 },
		quarantine: scope.verificationQuarantine,
		source: {
			read: (descriptor): Promise<Uint8Array> => {
				const bytes = selected.chunks[descriptor.index];
				if (bytes === undefined) throw new Error("fixture chunk absent");
				return Promise.resolve(new Uint8Array(bytes));
			},
		},
	});
	const receipt = await stream.receipt;
	await stream.completion;
	return receipt;
}

/**
 * Seed through the byte-frozen v1 factory and genuine verification path.
 * @param env - Isolated physical adapter environment.
 * @returns Legacy handles, fixtures and expected migration debt.
 */
export async function seedLegacy(env: RecoveryEnvironment): Promise<{
	readonly old: LegacyStore;
	readonly verified: SnapshotQuarantineFixture;
	readonly unfinished: SnapshotQuarantineFixture;
	readonly expiresAt: number;
	readonly debt: number;
}> {
	const old = await env.legacy();
	const verified = fixture("legacy-verified");
	const unfinished = fixture("legacy-unfinished");
	const completed = await old.openScope(verified.declaration);
	await completed.complete(await receiptFor(completed, verified));
	const pending = await old.openScope(unfinished.declaration);
	// An unfinished but byte-bearing scope discriminates hold from verified-only pinning.
	const descriptor = unfinished.declaration.chunks[0];
	const bytes = unfinished.chunks[0];
	if (descriptor === undefined || bytes === undefined) throw new Error("fixture missing chunk");
	await pending.verificationQuarantine.open(new AbortController().signal).write(descriptor, bytes);
	const expiresAt = (await pending.status()).expiresAt;
	await completed.release();
	await pending.release();
	return {
		old,
		verified,
		unfinished,
		expiresAt,
		debt: [verified, unfinished].reduce(
			(sum, selected) =>
				sum + selected.declaration.totalBytes + selected.declaration.exactCanonicalManifestBytes.byteLength,
			0
		),
	};
}

/**
 * One behavioral oracle shared by native IndexedDB and SQLite adapters.
 * @param name - Frozen discriminating case.
 * @param env - Isolated physical adapter environment.
 * @returns Observed adapter behavior for comparison with the independent expectation.
 */
export async function runCommonCase(name: CommonCase, env: RecoveryEnvironment): Promise<unknown> {
	const originalNow = Date.now;
	let now = 4_000;
	Date.now = (): number => now;
	try {
		if (name === "promise-invocation-control") {
			const error = Object.assign(new Error("invocation discriminator"), { code: "closed" });
			return {
				thrown: await promiseOutcome(() => {
					throw error;
				}),
				rejected: await promiseOutcome(() => Promise.reject(error)),
			};
		}
		if (name === "cancel-released-promise" || name === "cancel-closed-promise" || name === "cancel-aborted-promise") {
			const store = await env.open();
			const scope = await store.openScope(fixture(name).declaration);
			const controller = new AbortController();
			if (name === "cancel-released-promise") await scope.release();
			if (name === "cancel-closed-promise") await store.close();
			if (name === "cancel-aborted-promise") controller.abort();
			const before = await env.image();
			const result = await promiseOutcome(() => scope.cancel({ signal: controller.signal }));
			return { result, unchanged: stable(before) === stable(await env.image()) };
		}
		if (name === "fresh") {
			const store = await env.open();
			const owner = await store.recoveryStatus();
			return {
				owner,
				frozen: Object.isFrozen(owner) && Object.isFrozen(owner.limits),
				version: (await env.image()).version,
				hasRetentionApi: Reflect.has(await store.openScope(fixture().declaration), "retainForRecovery"),
			};
		}
		if (name === "temporary-status") {
			const store = await env.open();
			const selected = fixture();
			const scope = await store.openScope(selected.declaration);
			const before = await scope.status();
			await scope.complete(await receiptFor(scope, selected));
			const after = await scope.status();
			return { before, after };
		}
		if (name === "policy") {
			const limits = { maxRecoveryScopes: 2, maxRecoveryContentBytes: 40_000 };
			const opening = env.open(limits);
			limits.maxRecoveryScopes = 99;
			const store = await opening;
			const initial = await store.recoveryStatus();
			await store.close();
			const reopened = await env.open();
			const omitted = await reopened.recoveryStatus();
			await reopened.close();
			const equal = await env.open({ maxRecoveryScopes: 2, maxRecoveryContentBytes: 40_000 });
			await equal.close();
			const before = await env.image();
			const mismatch = await outcome(() => env.open({ maxRecoveryScopes: 3, maxRecoveryContentBytes: 40_000 }));
			return {
				initial: initial.limits,
				omitted: omitted.limits,
				mismatch: mismatch.code,
				unchanged: stable(before) === stable(await env.image()),
			};
		}
		if (name === "policy-invalid") {
			const codes: string[] = [];
			for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
				for (const key of ["maxRecoveryScopes", "maxRecoveryContentBytes"]) {
					codes.push((await outcome(() => env.open({ ...DEFAULT_LIMITS, [key]: value }))).code);
				}
			}
			return { codes, created: await env.exists() };
		}
		if (name === "policy-shapes") {
			const codes = [];
			for (const limits of [undefined, null, [], {}, { maxRecoveryScopes: 1 }, { ...DEFAULT_LIMITS, extra: true }])
				codes.push((await outcome(() => env.open(limits, true))).code);
			return { codes, created: await env.exists() };
		}
		if (name === "policy-concurrent") {
			const policies = [
				{ maxRecoveryScopes: 2, maxRecoveryContentBytes: 40_000 },
				{ maxRecoveryScopes: 3, maxRecoveryContentBytes: 50_000 },
			];
			const results = await Promise.all(policies.map(async (limits) => outcome(() => env.open(limits))));
			// A bounded lock refusal may be retried after the competing opener settles.
			for (const [index, result] of results.entries())
				if (result.code === "storage-failed") results[index] = await outcome(() => env.open(policies[index]));
			const codes = results.map(({ code }) => code).sort();
			const store = await env.open();
			const owner = await store.recoveryStatus();
			const winner = results.findIndex(({ code }) => code === "none");
			return { codes, winnerPersisted: stable(owner.limits) === stable(policies[winner]) };
		}
		if (name === "inspect") {
			const store = await env.open();
			const selected = fixture();
			const emptyBefore = await env.image();
			const missing = await store.inspectRecovery(selected.declaration);
			const missingUnchanged = stable(emptyBefore) === stable(await env.image());
			const scope = await store.openScope(selected.declaration);
			await scope.complete(await receiptFor(scope, selected));
			const current = await store.inspectRecovery(selected.declaration);
			now = (await scope.status()).expiresAt + 1;
			const before = await env.image();
			const expired = await store.inspectRecovery(selected.declaration);
			const manifest = new Uint8Array(selected.declaration.exactCanonicalManifestBytes);
			manifest[0] = Number(manifest[0]) ^ 1;
			const mismatch = await outcome(() =>
				store.inspectRecovery({ ...selected.declaration, exactCanonicalManifestBytes: manifest })
			);
			const descriptor = selected.declaration.chunks[0];
			if (descriptor === undefined) throw new Error("fixture descriptor absent");
			const mismatchedChunk = await outcome(() =>
				store.inspectRecovery({ ...selected.declaration, chunks: [{ ...descriptor, digest: "ff".repeat(32) }] })
			);
			const abort = new AbortController();
			abort.abort();
			const aborted = await outcome(() => store.inspectRecovery(selected.declaration, { signal: abort.signal }));
			const ownerAborted = await outcome(() => store.recoveryStatus({ signal: abort.signal }));
			return {
				missing,
				missingUnchanged,
				current,
				expired,
				mismatch: mismatch.code,
				mismatchedChunk: mismatchedChunk.code,
				aborted: aborted.code,
				ownerAborted: ownerAborted.code,
				unchanged: stable(before) === stable(await env.image()),
			};
		}
		if (name === "inspect-unwritten") {
			const store = await env.open();
			const selected = fixture();
			await store.openScope(selected.declaration);
			const descriptor = selected.declaration.chunks[0];
			if (descriptor === undefined) throw new Error("fixture descriptor absent");
			const before = await env.image();
			const changed = { ...selected.declaration, chunks: [{ ...descriptor, digest: "ff".repeat(32) }] };
			const mismatch = await outcome(() => store.inspectRecovery(changed));
			const sibling = createSnapshotQuarantineFixture({
				objectId: selected.declaration.scope.objectId,
				chunks: [Uint8Array.of(99)],
			});
			const conflict = await outcome(() => store.inspectRecovery(sibling.declaration));
			return {
				mismatch: mismatch.code,
				sibling: conflict.code,
				unchanged: stable(before) === stable(await env.image()),
			};
		}
		if (name === "queued-release-cancel") {
			const store = await env.open();
			const scope = await store.openScope(fixture().declaration);
			const before = await env.image();
			const cancel = outcome(() => scope.cancel());
			await scope.release();
			return { code: (await cancel).code, unchanged: stable(before) === stable(await env.image()) };
		}
		if (name === "absent-scope" || name === "cross-store-aba") {
			const store = await env.open();
			const selected = fixture();
			const stale = await store.openScope(selected.declaration);
			const port = stale.verificationQuarantine.open(new AbortController().signal);
			const receipt = await receiptFor(stale, selected);
			const second = await env.open();
			await (await second.openScope(selected.declaration)).cancel();
			const descriptor = selected.declaration.chunks[0];
			const bytes = selected.chunks[0];
			if (descriptor === undefined || bytes === undefined) throw new Error("fixture chunk absent");
			if (name === "cross-store-aba") {
				await receiptFor(await second.openScope(selected.declaration), selected);
				const before = await env.image();
				return {
					code: (await outcome(() => port.read(descriptor))).code,
					unchanged: stable(before) === stable(await env.image()),
				};
			}
			return {
				readMissing: (await port.read(descriptor)) === undefined,
				status: (await outcome(() => stale.status())).code,
				missing: (await outcome(() => stale.missingIndices())).code,
				complete: (await outcome(() => stale.complete(receipt))).code,
				write: (await outcome(() => port.write(descriptor, bytes))).code,
				cancel: (await outcome(() => stale.cancel())).code,
				scopes: (await env.image()).scopes.length,
			};
		}
		if (name.startsWith("aba-") || name.startsWith("released-")) {
			const store = await env.open();
			const selected = fixture();
			const stale = await store.openScope(selected.declaration);
			const port = stale.verificationQuarantine.open(new AbortController().signal);
			const receipt = await receiptFor(stale, selected);
			if (name.startsWith("released-")) await stale.release();
			else {
				await (await store.openScope(selected.declaration)).cancel();
				const replacement = await store.openScope(selected.declaration);
				await receiptFor(replacement, selected);
			}
			const before = await env.image();
			const descriptor = selected.declaration.chunks[0];
			const bytes = selected.chunks[0];
			if (descriptor === undefined || bytes === undefined) throw new Error("fixture descriptor absent");
			const operation = name.slice(name.indexOf("-") + 1) as HandleOperation;
			const actions: Record<HandleOperation, () => Promise<unknown>> = {
				cancel: () => stale.cancel(),
				read: () => port.read(descriptor),
				write: () => port.write(descriptor, bytes),
				complete: () => stale.complete(receipt),
				missing: () => stale.missingIndices(),
				status: () => stale.status(),
			};
			const result = await outcome(actions[operation]);
			return { code: result.code, unchanged: stable(before) === stable(await env.image()) };
		}
		if (name === "legacy-unknown-descriptors") {
			const old = await env.legacy();
			const selected = fixture("legacy-unknown");
			// V1 structurally admitted these exact bytes; migration must not decode them into invented facts.
			const declaration = { ...selected.declaration, exactCanonicalManifestBytes: Uint8Array.of(255) };
			await old.openScope(declaration);
			await old.close();
			const before = await env.image();
			const store = await env.open();
			const descriptor = declaration.chunks[0];
			if (descriptor === undefined) throw new Error("fixture descriptor absent");
			const changedDescriptor = { ...descriptor, digest: "ff".repeat(32) };
			const changed = { ...declaration, chunks: [changedDescriptor] };
			const observation = await store.inspectRecovery(changed);
			const scope = await store.openScope(changed);
			const bytes = selected.chunks[0];
			if (bytes === undefined) throw new Error("fixture chunk absent");
			const mutation = await outcome(() =>
				scope.verificationQuarantine.open(new AbortController().signal).write(changedDescriptor, bytes)
			);
			return {
				observation,
				mutation: mutation.code,
				unchanged:
					stable(before.scopes) === stable((await env.image()).scopes) &&
					stable(before.chunks) === stable((await env.image()).chunks),
			};
		}
		if (name.startsWith("legacy-")) {
			const seeded = await seedLegacy(env);
			await seeded.old.close();
			const before = await env.image();
			if (name === "legacy-preservation") now = seeded.expiresAt + 1;
			const store = await env.open(
				name === "legacy-debt" ? { maxRecoveryScopes: 1, maxRecoveryContentBytes: 1 } : undefined
			);
			if (name === "legacy-debt") {
				const owner = await store.recoveryStatus();
				return {
					owner,
					expectedDebt: seeded.debt,
					unchanged:
						stable(before.scopes) === stable((await env.image()).scopes) &&
						stable(before.chunks) === stable((await env.image()).chunks),
				};
			}
			if (name === "legacy-preservation") {
				const swept = await outcome(() => store.sweepExpired());
				const scope = await store.openScope(seeded.verified.declaration);
				const pending = await store.openScope(seeded.unfinished.declaration);
				const descriptor = seeded.verified.declaration.chunks[0];
				if (descriptor === undefined) throw new Error("fixture descriptor absent");
				const bytes = await scope.verificationQuarantine.open(new AbortController().signal).read(descriptor);
				const after = await env.image();
				return {
					sweepCode: swept.code,
					swept: swept.value,
					verified: await scope.status(),
					unfinished: await pending.status(),
					exactBytes: stable(bytes) === stable(seeded.verified.chunks[0]),
					unchanged: stable(before.scopes) === stable(after.scopes) && stable(before.chunks) === stable(after.chunks),
				};
			}
			const scope = await store.openScope(seeded.unfinished.declaration);
			const descriptor = seeded.unfinished.declaration.chunks[0];
			const bytes = seeded.unfinished.chunks[0];
			if (descriptor === undefined || bytes === undefined) throw new Error("fixture descriptor absent");
			const beforeMutations = await env.image();
			const codes = await Promise.all([
				outcome(() => store.openScope(fixture("must-not-create").declaration)),
				outcome(() => scope.verificationQuarantine.open(new AbortController().signal).write(descriptor, bytes)),
				outcome(() => scope.complete(Object.freeze({}))),
				outcome(() => scope.cancel()),
			]);
			const after = await env.image();
			return {
				codes: codes.map(({ code }) => code),
				unchanged:
					stable(beforeMutations) === stable(after) &&
					stable(before.scopes) === stable(after.scopes) &&
					stable(before.chunks) === stable(after.chunks),
			};
		}
		if (name === "temporary-regression") {
			const store = await env.open();
			const selected = fixture();
			const scope = await store.openScope(selected.declaration);
			await scope.complete(await receiptFor(scope, selected));
			const verified = (await scope.status()).kind;
			now = (await scope.status()).expiresAt;
			const expired = await store.sweepExpired();
			const image = await env.image();
			const cancel = await store.openScope(fixture("cancel-control").declaration);
			await cancel.cancel();
			return {
				verified,
				expired,
				expiredEmpty: image.scopes.length === 0 && image.chunks.length === 0,
				canceledEmpty: (await env.image()).scopes.length === 0,
			};
		}
		throw new Error(`unknown recovery-owner case ${name}`);
	} finally {
		Date.now = originalNow;
	}
}

/**
 * Frozen outcomes independent of either adapter's policy implementation.
 * @param name - Frozen discriminating case.
 * @returns Required observation.
 */
export function expectedCommonCase(name: CommonCase): unknown {
	if (name === "promise-invocation-control")
		return {
			thrown: { invocation: "threw", thenable: false, code: "closed" },
			rejected: { invocation: "returned", thenable: true, code: "closed" },
		};
	if (name === "cancel-released-promise" || name === "cancel-closed-promise" || name === "cancel-aborted-promise")
		return {
			result: {
				invocation: "returned",
				thenable: true,
				code: name === "cancel-aborted-promise" ? "aborted" : "closed",
			},
			unchanged: true,
		};
	const open = { kind: "open", retention: "temporary", expiresAt: 86_404_000, missingIndices: [0] };
	const verified = { ...open, kind: "verified", missingIndices: [] };
	if (name === "fresh") return { owner: READY_STATUS, frozen: true, version: 2, hasRetentionApi: true };
	if (name === "temporary-status") return { before: open, after: verified };
	if (name === "policy")
		return {
			initial: { maxRecoveryScopes: 2, maxRecoveryContentBytes: 40_000 },
			omitted: { maxRecoveryScopes: 2, maxRecoveryContentBytes: 40_000 },
			mismatch: "policy-mismatch",
			unchanged: true,
		};
	if (name === "policy-invalid") return { codes: Array.from({ length: 12 }, () => "malformed-input"), created: false };
	if (name === "policy-shapes") return { codes: Array.from({ length: 6 }, () => "malformed-input"), created: false };
	if (name === "policy-concurrent") return { codes: ["none", "policy-mismatch"], winnerPersisted: true };
	if (name === "inspect")
		return {
			missing: { kind: "missing" },
			missingUnchanged: true,
			current: { kind: "present", status: verified },
			expired: { kind: "present", status: verified },
			mismatch: "conflict",
			mismatchedChunk: "conflict",
			aborted: "aborted",
			ownerAborted: "aborted",
			unchanged: true,
		};
	if (name.startsWith("aba-")) return { code: "stale-scope", unchanged: true };
	if (name === "inspect-unwritten") return { mismatch: "conflict", sibling: "conflict", unchanged: true };
	if (name === "queued-release-cancel") return { code: "closed", unchanged: true };
	if (name === "absent-scope")
		return {
			readMissing: true,
			status: "expired",
			missing: "expired",
			complete: "expired",
			write: "expired",
			cancel: "none",
			scopes: 0,
		};
	if (name === "cross-store-aba") return { code: "stale-scope", unchanged: true };
	if (name.startsWith("released-")) return { code: "closed", unchanged: true };
	if (name === "legacy-preservation")
		return {
			sweepCode: "none",
			swept: 0,
			verified: { ...verified, retention: "legacy-unclassified" },
			unfinished: { ...verified, kind: "open", retention: "legacy-unclassified" },
			exactBytes: true,
			unchanged: true,
		};
	if (name === "legacy-debt") {
		const debt = [fixture("legacy-verified"), fixture("legacy-unfinished")].reduce(
			(sum, selected) =>
				sum + selected.declaration.totalBytes + selected.declaration.exactCanonicalManifestBytes.byteLength,
			0
		);
		return {
			owner: {
				...READY_STATUS,
				limits: { maxRecoveryScopes: 1, maxRecoveryContentBytes: 1 },
				legacyUnclassifiedScopes: 2,
				legacyUnclassifiedContentBytes: debt,
				migration: "classification-required",
			},
			expectedDebt: debt,
			unchanged: true,
		};
	}
	if (name === "legacy-mutations")
		return {
			codes: ["migration-required", "migration-required", "migration-required", "migration-required"],
			unchanged: true,
		};
	if (name === "legacy-unknown-descriptors")
		return {
			observation: { kind: "present", status: { ...open, retention: "legacy-unclassified" } },
			mutation: "migration-required",
			unchanged: true,
		};
	return { verified: "verified", expired: 1, expiredEmpty: true, canceledEmpty: true };
}
