import { verifySnapshotStreamWithReceipt } from "../../../packages/compaction/dist/src/snapshot-quarantine-receipt.js";
import {
	snapshotQuarantineContract,
	type SnapshotQuarantineDeclaration,
	type SnapshotQuarantineScopeKey,
} from "../../../packages/storage/src/snapshot-transfer.js";
import { createSnapshotQuarantineFixture } from "../phase-4c-v3/snapshot-quarantine-contract.js";
import type {
	SnapshotRecoveryDeclarationLookup,
	SnapshotRecoveryDeclarationReader,
} from "../phase-4c-v3/snapshot-quarantine-types.js";
import {
	fixture,
	type LegacyStore,
	outcome,
	promiseOutcome,
	receiptFor,
	type RecoveryStore,
	stable,
} from "../snapshot-recovery-owner/contract.js";

export const MASKED = "MASKED_BY_ABSENT_DECLARATION_DISCOVERY_API";
export type Key = SnapshotQuarantineScopeKey;
export type Row = Record<string, unknown>;
export interface Observation {
	cursorAdvances?: number;
	materialized?: { fields: { name: string; type: string; bytes?: number; value?: unknown; fingerprint?: string }[] }[];
	transactions: number;
	modes: string[];
	reads: { operation: string; table: string; query: unknown; count?: number; value?: unknown; plan?: string[] }[];
	writes: number;
	terminal: boolean;
}
export interface DiscoveryEnvironment {
	backend: "sqlite" | "indexeddb";
	open(): Promise<RecoveryStore>;
	legacy(): Promise<LegacyStore>;
	image(): Promise<unknown>;
	row(key: Key): Promise<Row>;
	put(row: Row): Promise<void>;
	remove(key: Key): Promise<void>;
	chunks(key: Key, operation: "delete" | "corrupt" | "descriptor"): Promise<void>;
	observe(action: () => Promise<unknown>): Promise<{ value: unknown; evidence: Observation }>;
	failStorage(action: () => Promise<unknown>): Promise<unknown>;
	nativeControl(): Promise<unknown>;
}
/**
 *
 * @param value
 * @param expected
 * @param label
 */
export function check(value: unknown, expected: unknown, label: string): void {
	if (stable(value) !== stable(expected))
		throw new Error(`${label}: expected ${stable(expected)}, observed ${stable(value)}`);
}
/**
 *
 * @param store
 */
export function reader(store: RecoveryStore): SnapshotRecoveryDeclarationReader {
	if (typeof Reflect.get(store, "lookupRecoveryDeclaration") !== "function") throw new Error(MASKED);
	return store as RecoveryStore & SnapshotRecoveryDeclarationReader;
}
/**
 *
 * @param key
 */
export function capture(key: Key): Key {
	const method: unknown = Reflect.get(snapshotQuarantineContract, "captureScope");
	if (typeof method !== "function") throw new Error(`${MASKED}: shared captureScope`);
	return Reflect.apply(method, snapshotQuarantineContract, [key]) as Key;
}
/**
 *
 * @param value
 */
export function present(
	value: SnapshotRecoveryDeclarationLookup
): Extract<SnapshotRecoveryDeclarationLookup, { kind: "present" }> {
	if (value.kind !== "present") throw new Error("expected present declaration");
	return value;
}
const states = ["open", "poisoned", "verified"] as const;
const retentions = ["temporary", "recovery", "legacy-unclassified"] as const;
export const CORRUPTIONS = [
	"manifest-invalid",
	"manifest-noncanonical",
	"manifest-oversized",
	"manifest-string",
	"manifest-empty",
	"identity-object",
	"identity-epoch",
	"identity-anchor",
	"identity-digest",
	"long-object",
	"total-mismatch",
	"total-negative",
	"total-unsafe",
	"total-fraction",
	"total-string",
	"count-mismatch",
	"count-negative",
	"count-unsafe",
	"count-fraction",
	"count-string",
	"count-over-limit",
	"expiry-negative",
	"expiry-unsafe",
	"expiry-fraction",
	"expiry-string",
	"state-invalid",
	"state-oversized",
	"state-bytes",
	"retention-invalid",
	"retention-oversized",
	"retention-bytes",
	"incarnation-empty",
	"incarnation-oversized",
	"incarnation-bytes",
	"incarnation-nul-oversized",
	"descriptors-null",
	"descriptors-string",
	"descriptors-oversized",
	"descriptors-bytes",
	"descriptors-empty",
	"descriptors-nul-oversized",
	"descriptor-index",
	"descriptor-length",
	"descriptor-digest",
	"descriptor-extra",
	"descriptor-order",
	"legacy-descriptors",
] as const;
export const DISCOVERY_CASES = [
	"missing",
	"hit",
	"exact-valid-competitor",
	"exact-corrupt-competitor",
	"exact-poisoned-competitor",
	"conflict-valid",
	"conflict-corrupt",
	"neighbor-object",
	"neighbor-epoch",
	"neighbor-anchor",
	...retentions.flatMap((retention) => states.map((state) => `matrix:${retention}:${state}`)),
	"expired",
	"no-chunks",
	"bad-chunks",
	"legacy",
	"legacy-chunk-mismatch",
	"legacy-undecodable",
	...CORRUPTIONS.map((name) => `corrupt:${name}`),
	"alias-isolation",
	"entry-key-capture",
	"entry-signal-capture",
	"pre-abort",
	"queued-abort",
	"closed",
	"queue-before-close",
	"malformed-null",
	"malformed-extra",
	"malformed-object",
	"malformed-epoch",
	"malformed-anchor",
	"malformed-digest",
	"malformed-getter",
	"round-trip",
	"race-delete",
	"race-replace",
	"storage-failed",
] as const;
export const IDB_CASES = [
	"row-extra",
	"row-missing",
	...["number", "date", "string", "binary", "array", "nested-array", "oversized-key"].flatMap((kind) => [
		`occupancy:${kind}`,
		`priority:${kind}`,
	]),
];

/**
 *
 * @param kind
 */
export function fourthKey(kind: string): IDBValidKey {
	switch (kind) {
		case "number":
			return -Infinity;
		case "date":
			return new Date(0);
		case "binary":
			return Uint8Array.of(0, 255);
		case "array":
			return [];
		case "nested-array":
			return [[[]]];
		case "oversized-key":
			return new Uint8Array(300_000);
		default:
			return "ff".repeat(32);
	}
}
/**
 *
 * @param evidence
 * @param exact
 * @param backend
 * @param key
 */
export function bounded(
	evidence: Observation,
	exact: boolean,
	backend: DiscoveryEnvironment["backend"],
	key?: Key
): void {
	check(evidence.transactions, 1, "one lookup transaction");
	check(evidence.writes, 0, "lookup never mutates");
	check(evidence.terminal, true, "settles after native transaction terminal");
	check(evidence.reads.filter((read) => read.table === "chunks").length, 0, "zero chunk operations");
	const reads = evidence.reads.filter((read) => read.table === "scopes");
	if (backend === "indexeddb") {
		check(evidence.cursorAdvances, 0, "occupancy cursor stops at first key");
		check(evidence.modes, ["readonly"], "native readonly mode");
		check(reads.filter((read) => read.operation === "get").length, 1, "one exact body request");
		if (!key) throw new Error("captured exact key required for IndexedDB observation");
		const tuple = [key.objectId, key.epoch, key.anchor, key.manifestDigest];
		const query = reads.find((read) => read.operation === "get")?.query;
		check(
			query,
			Array.isArray(query) ? tuple : { lower: tuple, upper: tuple, lowerOpen: false, upperOpen: false },
			"IndexedDB body get addresses exact captured four-field key"
		);
		check(reads.length, exact ? 1 : 2, "miss-only key probe");
		for (const read of reads.filter((read) => read.operation !== "get")) {
			check(["getKey", "openKeyCursor", "getAllKeys"].includes(read.operation), true, "key-only probe");
			if (read.operation === "getAllKeys") check(read.count, 1, "bounded getAllKeys");
		}
	} else {
		check(evidence.modes, ["BEGIN"], "existing sqlite transaction semantics");
		const bindsDigest = (read: Observation["reads"][number]): boolean =>
			(read.plan?.join(" ") ?? "").includes("manifest_digest=?");
		const occupancy = reads.filter((read) => !bindsDigest(read));
		check(occupancy.length <= (exact ? 0 : 1), true, "SQLite occupancy is miss-only and at most one native request");
		check(
			reads.length > 0 && bindsDigest(reads[0] as Observation["reads"][number]),
			true,
			"SQLite starts with an exact-key read"
		);
		if (occupancy.length) check(reads.at(-1), occupancy[0], "SQLite occupancy follows exact miss reads");
		for (const read of reads) {
			const plan = read.plan?.join(" ") ?? "";
			check(
				/SEARCH\s+\S+\s+USING/i.test(plan) && !/SCAN\s+\S+/i.test(plan),
				true,
				"native query plan uses indexed scope search"
			);
			check(
				["object_id", "epoch", "anchor"].every((field) => plan.includes(`${field}=?`)),
				true,
				"native plan binds complete identity prefix"
			);
			const sql = String(read.query).toLowerCase();
			check(
				/where/.test(sql) && /object_id/.test(sql) && /epoch/.test(sql) && /anchor/.test(sql),
				true,
				"indexed identity query"
			);
			check(/count\s*\(/.test(sql), false, "no count scan");
			check(
				/manifest_digest\s*=/.test(sql) || /limit\s+1|exists\s*\(/.test(sql),
				true,
				"bounded exact or occupancy query"
			);
			if (!plan.includes("manifest_digest=?")) {
				const values = Array.isArray(read.value) ? read.value : [read.value];
				check(
					values.every(
						(value) =>
							!value ||
							(typeof value === "object" &&
								Object.values(value).every(
									(field) => typeof field === "number" || typeof field === "bigint" || typeof field === "boolean"
								))
					),
					true,
					"occupancy returns existence scalar only, never competing fields"
				);
			}
		}
		const bodies = reads
			.flatMap((read) => (Array.isArray(read.value) ? read.value : [read.value]))
			.filter(
				(value) => value && typeof value === "object" && Object.values(value).some((field) => ArrayBuffer.isView(field))
			);
		check(bodies.length <= 1, true, "at most one materialized exact body");
	}
}

/**
 *
 * @param evidence
 * @param rejected
 * @param rejected.value
 * @param rejected.maxBytes
 */
export async function preCopy(evidence: Observation, rejected?: { value: unknown; maxBytes: number }): Promise<void> {
	if (!evidence.materialized) throw new Error("native bridge materialization evidence absent");
	let rejectedFingerprint: string | undefined;
	if (rejected) {
		const value = rejected.value;
		if (typeof value !== "string" && !(value instanceof Uint8Array))
			throw new Error("variable metadata control requires string or bytes");
		const bytes = typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value);
		if (bytes.byteLength > rejected.maxBytes)
			rejectedFingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
				.map((value) => value.toString(16).padStart(2, "0"))
				.join("");
	}
	for (const field of evidence.materialized.flatMap((read) => read.fields)) {
		if (field.type === "bytes" || field.type === "string") {
			const limit =
				field.type === "bytes" ? SQLITE_MATERIALIZATION_LIMITS.blobBytes : SQLITE_MATERIALIZATION_LIMITS.textBytes;
			check(
				typeof field.bytes === "number" && field.bytes <= limit,
				true,
				"native variable metadata materialization stays within existing representation bounds"
			);
			if (rejectedFingerprint && rejected && typeof field.bytes === "number" && field.bytes > rejected.maxBytes) {
				if (!field.fingerprint) throw new Error("native variable metadata fingerprint absent");
				check(
					field.fingerprint === rejectedFingerprint,
					false,
					"oversized injected field is not copied under any alias"
				);
			}
		}
	}
}

// Independent expected bounds: 2048 descriptors, maximum index 2047, 128KiB
// chunk lengths and 64-character hex digests. All current writer tokens fit
// within the resulting ASCII JSON TEXT envelope; manifest bytes use their own
// existing protocol ceiling. Storage type/refusal is asserted separately.
export const SQLITE_MATERIALIZATION_LIMITS = Object.freeze({
	blobBytes: 212387,
	textBytes: 2 + 2048 * JSON.stringify({ index: 2047, byteLength: 131072, digest: "f".repeat(64) }).length + 2047,
	stateBytes: "verified".length,
	retentionBytes: "legacy-unclassified".length,
	incarnationBytes: 36,
});

function corrupt(row: Row, name: string, declaration: SnapshotQuarantineDeclaration): void {
	const scalar = (prefix: string, field: string): boolean => {
		if (!name.startsWith(prefix)) return false;
		const kind = name.slice(prefix.length);
		row[field] =
			kind === "negative"
				? -1
				: kind === "unsafe"
					? Number.MAX_SAFE_INTEGER + 1
					: kind === "fraction"
						? 0.5
						: kind === "string"
							? "invalid-number"
							: kind === "over-limit"
								? 2049
								: Number(row[field]) + 1;
		return true;
	};
	if (scalar("total-", "totalBytes") || scalar("count-", "chunkCount") || scalar("expiry-", "expiresAt")) return;
	if (name.startsWith("identity-") || name === "long-object") {
		const field =
			name === "identity-epoch"
				? "epoch"
				: name === "identity-anchor"
					? "anchor"
					: name === "identity-digest"
						? "manifestDigest"
						: "objectId";
		row[field] =
			name === "long-object"
				? "x".repeat(5000)
				: field === "epoch"
					? 9
					: field === "objectId"
						? "different"
						: "ee".repeat(32);
		return;
	}
	if (name.startsWith("manifest-")) {
		row.exactCanonicalManifestBytes =
			name === "manifest-string"
				? "not-bytes"
				: name === "manifest-oversized"
					? new Uint8Array(212388)
					: name === "manifest-empty"
						? new Uint8Array()
						: name === "manifest-noncanonical"
							? new Uint8Array([...declaration.exactCanonicalManifestBytes, 0])
							: Uint8Array.of(255);
		return;
	}
	for (const field of ["state", "retention", "incarnation"])
		if (name.startsWith(`${field}-`)) {
			row[field] = name.endsWith("bytes")
				? Uint8Array.of(1)
				: name.endsWith("empty")
					? ""
					: name.includes("nul-")
						? "x\0" + "x".repeat(300000)
						: name.endsWith("oversized")
							? "x".repeat(100000)
							: "invalid";
			return;
		}
	if (name === "legacy-descriptors") {
		row.retention = "legacy-unclassified";
		return;
	}
	if (name.startsWith("descriptors-")) {
		row.descriptors = name.endsWith("null")
			? null
			: name.endsWith("bytes")
				? Uint8Array.of(1)
				: name.endsWith("empty")
					? "[]"
					: name.includes("nul-")
						? "[\0" + " ".repeat(300000)
						: name.endsWith("oversized")
							? " ".repeat(300000)
							: "not-json";
		return;
	}
	const descriptors = declaration.chunks.map((value) => ({ ...value }));
	const first = descriptors[0];
	if (!first) throw new Error("descriptor absent");
	if (name === "descriptor-index") first.index = 1;
	if (name === "descriptor-length") first.byteLength++;
	if (name === "descriptor-digest") first.digest = "ee".repeat(32);
	if (name === "descriptor-extra") Reflect.set(first, "extra", true);
	if (name === "descriptor-order") descriptors.reverse();
	row.descriptors = JSON.stringify(descriptors);
}
/**
 *
 * @param name
 * @param env
 * @param setupOnly
 */
export async function runDiscoveryCase(name: string, env: DiscoveryEnvironment, setupOnly = false): Promise<unknown> {
	if (name === "native-control") return env.nativeControl();
	let store: RecoveryStore | undefined;
	try {
		const selected =
			name === "corrupt:descriptor-order" || name === "round-trip"
				? createSnapshotQuarantineFixture({
						objectId: "discovery-main",
						chunks: [new Uint8Array(131072).fill(5), Uint8Array.of(9, 8)],
					})
				: fixture("discovery-main");
		let declaration = selected.declaration;
		if (name.startsWith("legacy")) {
			const old = await env.legacy();
			if (name === "legacy-undecodable")
				declaration = { ...declaration, exactCanonicalManifestBytes: Uint8Array.of(255) };
			const handle = await old.openScope(declaration);
			if (name === "legacy-chunk-mismatch") await receiptFor(handle, selected);
			await old.close();
		}
		store = await env.open();
		const owner = store;
		if (!name.startsWith("legacy")) await store.openScope(declaration);
		let key = { ...declaration.scope };
		let expectedKind = "present";
		let expectedCode = "none";
		let expectedState = "open";
		let expectedRetention = name.startsWith("legacy") ? "legacy-unclassified" : "temporary";
		let exact = true;
		let rejectedMetadata: { value: unknown; maxBytes: number } | undefined;
		if (name.startsWith("matrix:")) {
			const [, retention, state] = name.split(":");
			if (!retention || !state) throw new Error("matrix fields absent");
			const row = await env.row(key);
			row.retention = retention;
			row.state = state;
			if (retention === "legacy-unclassified") row.descriptors = null;
			await env.put(row);
			expectedState = state;
			expectedRetention = retention;
			if (retention === "recovery" && state !== "verified") expectedCode = "poisoned";
		}
		if (
			name === "missing" ||
			name.startsWith("conflict-") ||
			name.startsWith("neighbor-") ||
			name.startsWith("occupancy:")
		) {
			await env.remove(key);
			exact = false;
			expectedKind = "missing";
		}
		if (
			name.includes("competitor") ||
			name.startsWith("conflict-") ||
			name.startsWith("neighbor-") ||
			name.includes("occupancy:") ||
			name.startsWith("priority:")
		) {
			const other = createSnapshotQuarantineFixture({ objectId: "discovery-main", chunks: [Uint8Array.of(2, 4)] });
			const row: Row = {
				...other.declaration.scope,
				exactCanonicalManifestBytes: other.declaration.exactCanonicalManifestBytes,
				totalBytes: other.declaration.totalBytes,
				chunkCount: 1,
				expiresAt: Date.now() + 86400000,
				state: "open",
				retention: "temporary",
				incarnation: "discovery-competitor",
				descriptors: JSON.stringify(other.declaration.chunks),
			};
			if (name.includes("corrupt") || name.startsWith("occupancy:") || name.startsWith("priority:"))
				row.exactCanonicalManifestBytes = Uint8Array.of(255);
			if (name.startsWith("occupancy:") || name.startsWith("priority:"))
				row.manifestDigest = fourthKey(name.split(":")[1] ?? "");
			if (name === "neighbor-object") row.objectId = "discovery-neighbor";
			if (name === "neighbor-epoch") row.epoch = key.epoch + 1;
			if (name === "neighbor-anchor") row.anchor = `${key.anchor}\u0000`;
			await env.put(row);
			if (name.startsWith("conflict-") || name.startsWith("occupancy:")) expectedCode = "conflict";
			if (name === "exact-poisoned-competitor") {
				const own = await env.row(key);
				own.exactCanonicalManifestBytes = Uint8Array.of(255);
				await env.put(own);
				expectedCode = "poisoned";
			}
		}
		if (name === "expired") {
			const row = await env.row(key);
			row.expiresAt = 1;
			await env.put(row);
		}
		if (name === "no-chunks" || name === "bad-chunks" || name === "legacy-chunk-mismatch") {
			if (name === "bad-chunks") {
				const handle = await store.openScope(declaration);
				await receiptFor(handle, selected);
			}
			await env.chunks(
				key,
				name === "no-chunks" ? "delete" : name === "legacy-chunk-mismatch" ? "descriptor" : "corrupt"
			);
		}
		if (name.startsWith("corrupt:")) {
			const row = await env.row(key);
			corrupt(row, name.slice(8), declaration);
			if (/oversized$|bytes$|manifest-string$/.test(name)) {
				const field = name.slice(8).split("-")[0] ?? "";
				const bounds: Record<string, number> = {
					manifest: SQLITE_MATERIALIZATION_LIMITS.blobBytes,
					descriptors: SQLITE_MATERIALIZATION_LIMITS.textBytes,
					state: SQLITE_MATERIALIZATION_LIMITS.stateBytes,
					retention: SQLITE_MATERIALIZATION_LIMITS.retentionBytes,
					incarnation: SQLITE_MATERIALIZATION_LIMITS.incarnationBytes,
				};
				const maxBytes = bounds[field];
				if (maxBytes === undefined) throw new Error("corrupt metadata bound absent");
				rejectedMetadata = { value: row[field === "manifest" ? "exactCanonicalManifestBytes" : field], maxBytes };
			}
			if (name.includes("identity-") || name === "corrupt:long-object") {
				await env.remove(key);
				key = {
					objectId: String(row.objectId),
					epoch: Number(row.epoch),
					anchor: String(row.anchor),
					manifestDigest: String(row.manifestDigest),
				};
				declaration = { ...declaration, scope: key };
				if (name === "corrupt:long-object") {
					await store.openScope(declaration);
					rejectedMetadata = { value: key.objectId, maxBytes: 0 };
				}
			}
			await env.put(row);
			expectedCode = "poisoned";
		}
		if (name === "legacy-undecodable") expectedCode = "poisoned";
		if (name === "row-extra" || name === "row-missing") {
			const row = await env.row(key);
			if (name === "row-extra") row.unexpected = true;
			else delete row.incarnation;
			await env.put(row);
			expectedCode = "poisoned";
		}
		if (name === "storage-failed")
			check(
				((await env.failStorage(() => outcome(() => owner.inspectRecovery(declaration)))) as { code: string }).code,
				"storage-failed",
				"fault injection reaches existing native storage error mapping"
			);
		if (name === "closed") {
			await store.close();
			expectedCode = "closed";
		}
		const before = stable(await env.image());
		if (setupOnly) return { case: name, setupValidated: true };
		const api = reader(store); // Native setup ran; downstream behavior remains explicitly masked on absent API.
		if (name === "storage-failed") {
			check(
				((await env.failStorage(() => outcome(() => api.lookupRecoveryDeclaration(key)))) as { code: string }).code,
				"storage-failed",
				"discovery preserves transaction error mapping"
			);
			check(stable(await env.image()), before, "failed storage nonmutation");
			return { case: name, passed: true };
		}
		if (name.startsWith("malformed-")) {
			let input: unknown = { ...key };
			if (name === "malformed-null") input = null;
			else if (name === "malformed-extra") Reflect.set(input as object, "extra", true);
			else if (name === "malformed-getter")
				Object.defineProperty(input, "objectId", {
					get() {
						throw new Error("hostile getter");
					},
				});
			else
				Reflect.set(
					input as object,
					name === "malformed-object" ? "objectId" : name.slice(10) === "digest" ? "manifestDigest" : name.slice(10),
					name === "malformed-epoch" ? -1 : ""
				);
			check(
				await promiseOutcome(() => api.lookupRecoveryDeclaration(input as Key)),
				{
					invocation: "returned",
					thenable: true,
					code: name === "malformed-getter" ? "unclassified-error" : "malformed-input",
				},
				"malformed promise"
			);
			check(stable(await env.image()), before, "malformed nonmutation");
			return { case: name, passed: true };
		}
		const controller = new AbortController();
		if (name === "pre-abort") controller.abort();
		const options = { signal: controller.signal };
		if (["pre-abort", "queued-abort", "entry-signal-capture"].includes(name)) expectedCode = "aborted";
		if (
			name === "closed" ||
			expectedCode === "aborted" ||
			name === "queue-before-close" ||
			name === "entry-key-capture"
		) {
			let capturedResult: SnapshotRecoveryDeclarationLookup | undefined;
			const pending = promiseOutcome(() =>
				api.lookupRecoveryDeclaration(key, options).then((value) => {
					capturedResult = value;
				})
			);
			if (name === "entry-key-capture") key.objectId = "mutated-after-entry";
			if (name === "entry-signal-capture") options.signal = new AbortController().signal;
			if (name === "queued-abort" || name === "entry-signal-capture") controller.abort();
			if (name === "queue-before-close") await store.close();
			check(await pending, { invocation: "returned", thenable: true, code: expectedCode }, "entry lifecycle");
			if (name === "entry-key-capture") {
				if (!capturedResult) throw new Error("entry result absent");
				check(present(capturedResult).declaration, declaration, "entry captures original exact declaration");
			}
			check(stable(await env.image()), before, "lifecycle nonmutation");
			return { case: name, passed: true };
		}
		const observed = await env.observe(() => outcome(() => api.lookupRecoveryDeclaration(key)));
		const result = observed.value as Awaited<ReturnType<typeof outcome>>;
		check(result.code, expectedCode, "lookup settlement");
		bounded(observed.evidence, exact, env.backend, key);
		if (env.backend === "sqlite") await preCopy(observed.evidence, rejectedMetadata);
		check(stable(await env.image()), before, "exact durable image and owner census unchanged");
		if (name === "legacy-undecodable" || name === "corrupt:long-object" || name === "corrupt:identity-object")
			check(
				(await store.inspectRecovery(declaration)).kind,
				"present",
				"historical permissive inspection differential"
			);
		if (expectedCode !== "none") return { case: name, passed: true, evidence: observed.evidence };
		const resultValue = result.value as SnapshotRecoveryDeclarationLookup;
		check(resultValue.kind, expectedKind, "result discriminant");
		if (expectedKind === "missing") {
			check(Object.keys(resultValue), ["kind"], "missing exact shape");
			check(Object.isFrozen(resultValue), true, "frozen missing");
			return { case: name, passed: true, evidence: observed.evidence };
		}
		const hit = present(resultValue);
		check(Object.keys(hit).sort(), ["declaration", "expiresAt", "kind", "retention", "state"], "present exact shape");
		check(hit.declaration, declaration, "canonical reconstructed declaration including descriptor order");
		check(hit.state, expectedState, "state");
		check(hit.retention, expectedRetention, "retention");
		check(hit.expiresAt, (await env.row(key)).expiresAt, "expiry unchanged");
		check(
			[hit, hit.declaration, hit.declaration.scope, hit.declaration.chunks, ...hit.declaration.chunks].every(
				Object.isFrozen
			),
			true,
			"frozen detached hierarchy"
		);
		check(capture(hit.declaration.scope), key, "shared scope capture");
		if (name === "legacy-chunk-mismatch")
			check(
				(await outcome(() => owner.inspectRecovery(hit.declaration))).code,
				"conflict",
				"legacy existing inspection still binds chunks"
			);
		if (name === "alias-isolation") {
			const other = present(await api.lookupRecoveryDeclaration(key));
			check(
				hit !== other &&
					hit.declaration !== other.declaration &&
					hit.declaration.scope !== other.declaration.scope &&
					hit.declaration.chunks !== other.declaration.chunks &&
					hit.declaration.exactCanonicalManifestBytes !== other.declaration.exactCanonicalManifestBytes,
				true,
				"independent owned results"
			);
			hit.declaration.exactCanonicalManifestBytes.fill(0);
			check(other.declaration, declaration, "mutable bytes independent");
			check(present(await api.lookupRecoveryDeclaration(key)).declaration, declaration, "later lookup unaffected");
			check(stable(await env.image()), before, "alias nonmutation");
		}
		if (name === "round-trip") {
			check((await store.inspectRecovery(hit.declaration)).kind, "present", "old inspect round trip");
			const handle = await store.openScope(hit.declaration);
			check(handle.scope, key, "old open binding");
			await handle.complete(await receiptFor(handle, selected));
		}
		if (name === "race-delete" || name === "race-replace") {
			await env.remove(key);
			const handle = await store.openScope(hit.declaration);
			if (name === "race-replace") {
				await receiptFor(handle, selected);
				await env.chunks(key, "corrupt");
			}
			const stream = verifySnapshotStreamWithReceipt({
				exactCanonicalManifestBytes: hit.declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: key.manifestDigest,
				expectedScope: key,
				profile: { maxManifestBytes: 212387, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 },
				quarantine: handle.verificationQuarantine,
				source: handle.verificationQuarantine.open(new AbortController().signal),
			});
			const [receipt, completion] = await Promise.all([
				outcome(() => stream.receipt),
				outcome(() => stream.completion),
			]);
			check(receipt.code !== "none" && completion.code !== "none", true, "existing verifier rejects raced bytes");
		}
		return { case: name, passed: true, evidence: observed.evidence };
	} finally {
		await store?.close();
	}
}
