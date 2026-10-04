/* eslint-disable jsdoc/require-jsdoc -- Test-owned executable oracle, not a product API. */
import { encodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import {
	type AheDurableStore,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	digestClosure,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	type GenerationRef,
	parseGenerationId,
	parseStorageObjectId,
	type PresentHead,
} from "../../../packages/storage/dist/src/index.js";

export const LIMITS = Object.freeze({
	maxObjectGenerations: 7,
	maxHeadBytes: 3326,
	maxGenerationBytes: 7307,
	maxClosureReferences: 7,
	maxBlobBytes: 65536,
	maxUnionBytes: 262144,
} as const);
export const OBJECT = must(parseStorageObjectId(`creator:${"a".repeat(32)}`));
export const OTHER = must(parseStorageObjectId(`creator:${"b".repeat(32)}`));
export const id = (n: number): GenerationId => must(parseGenerationId(n.toString(16).padStart(64, "0")));
export interface Reader {
	readonly head: PresentHead;
	readonly generations: readonly GenerationRecord[];
	readonly blobs: readonly Readonly<{ ref: GenerationRef; bytes: Uint8Array }>[];
	checkCurrent(): Promise<Result<{ kind: "current" }>>;
	release(): Promise<void>;
}
export type Result<T> = { ok: true; value: T } | { ok: false; reason: string; cause?: unknown };
type Acquisition = { kind: "empty"; head: ExpectedHead } | { kind: "present"; reader: Reader };
export interface Image {
	heads: { objectId: string; record: Uint8Array | null }[];
	generations: { objectId: unknown; generationId: unknown; record: Uint8Array }[];
	blobs: { digest: string; bytes: Uint8Array }[];
	promotions: { objectId: unknown; generationId: unknown; digest: string }[];
}
export type Edit =
	| { kind: "head"; record: Uint8Array | null }
	| { kind: "generation"; generationId: unknown; record: Uint8Array; replaceId?: unknown; insert?: boolean }
	| { kind: "delete-generation"; generationId: unknown }
	| { kind: "blob"; digest: string; bytes: Uint8Array | null; insert?: boolean }
	| { kind: "promotion"; generationId: unknown; digest: string; add?: boolean };
export interface Trace {
	modes: string[];
	writes: number;
	terminals: number;
	terminalKinds?: string[];
	transactionStores?: string[][];
	materialEvents?: string[];
	reads: {
		table: string;
		operation: string;
		query?: unknown;
		parameters?: unknown[];
		fields?: { name: string; type: string; bytes?: number; value?: unknown }[];
	}[];
}
export interface Environment {
	backend: "sqlite" | "idb" | "ephemeral";
	open(): Promise<AheDurableStore>;
	image(): Promise<Image>;
	edit(value: Edit): Promise<void>;
	observe<T>(
		action: () => Promise<T>,
		boundary?: (edge: "start" | "terminal") => void,
		nativeHook?: (
			edge: "request" | "success",
			table: string,
			operation: string,
			interrupt: () => void,
			key: unknown
		) => void
	): Promise<{ value: T; evidence: Trace }>;
	control(): Promise<Trace>;
}
export const CASES = Object.freeze([
	"active-zero",
	"active-two",
	"generic-union",
	"seven-all-states",
	"empty-debt",
	"eight-valid",
	"head-H+1",
	"generation-R+1",
	"selected-F+1",
	"unselected-F+1",
	"head-depth",
	"head-items",
	"generation-depth",
	"generation-items",
	"unselected-corruption",
	"two-adopted",
	"missing-parent",
	"wrong-parent-state",
	"wrong-parent-closure",
	"wrong-revision",
	"repeated-parent",
	"declared-B+1",
	"actual-B+1",
	"union-U+1",
	"B-U-boundary",
	"F-boundary",
	"shared-length-conflict",
	"own-promotion-missing",
	"older-promotion-missing",
	"older-blob-corrupt",
	"blob-missing",
	"blob-digest-corrupt",
	"blob-length-corrupt",
	"detached-input-output",
	"stale-changed",
	"stale-disappeared",
	"stale-corrupt",
	"release-independent",
	"release-queued-executing",
	"close-queued-executing",
	"close-before-release",
	"poison-before-release",
	"invalid-pre-I/O",
	"no-mutation-certificate",
	"preserve-mutation-certificate",
] as const);
export const SQLITE_KEYS = Object.freeze([
	"key-oversized-text",
	"key-multibyte-64-chars",
	"key-blob",
	"key-spelling",
	"invalid-overflow-sentinel",
] as const);
export const IDB_KEYS = Object.freeze([
	"key-array-above-old-bound",
	"key-number",
	"key-binary",
	"key-spelling",
	"key-scope",
	"invalid-overflow-sentinel",
] as const);
export type Case = (typeof CASES)[number] | (typeof SQLITE_KEYS)[number] | (typeof IDB_KEYS)[number];
export const EPHEMERAL_CASES = Object.freeze(["empty-debt", "eight-valid", "unselected-F+1"] as const);

export function check(value: unknown, label: string): asserts value {
	if (!value) throw new Error("AHE_ORACLE:" + label);
}
export function must<T>(result: { ok: true; value: T } | { ok: false; reason?: string }): T {
	if (!result.ok) throw new Error("AHE_SETUP:" + result.reason);
	return result.value;
}
export function stable(value: unknown): string {
	return JSON.stringify(value, (_key, field: unknown) =>
		field instanceof Uint8Array
			? { bytes: [...field] }
			: field instanceof ArrayBuffer
				? { bytes: [...new Uint8Array(field)] }
				: field
	);
}
export function assertNativeSelectedRead(
	observed: Pick<Reader, "head" | "generations" | "blobs">,
	expectedHead: PresentHead,
	expectedRecords: readonly GenerationRecord[],
	expectedImage: Pick<Image, "blobs" | "promotions">,
	trace?: Trace
): Map<GenerationRef["digest"], GenerationRef> {
	const bytesEqual = (actual: Uint8Array, expected: Uint8Array): boolean =>
		actual instanceof Uint8Array &&
		actual.byteLength === expected.byteLength &&
		actual.every((b, i) => b === expected[i]);
	const completeEqual = (actual: unknown, expected: unknown): boolean =>
		bytesEqual(encodeCanonical(actual), encodeCanonical(expected));
	check(completeEqual(observed.head, expectedHead), "complete returned head equals native head");
	check(
		completeEqual(observed.generations, expectedRecords),
		"complete selected generation records equal native records in exact order"
	);
	const union = new Map<GenerationRef["digest"], GenerationRef>();
	for (const generation of expectedRecords)
		for (const reference of generation.closure) {
			const previous = union.get(reference.digest);
			check(!previous || completeEqual(previous, reference), "native selected repeated refs agree completely");
			union.set(reference.digest, reference);
			if (trace) {
				check(
					expectedImage.promotions.some(
						(p) =>
							p.objectId === generation.objectId &&
							p.generationId === generation.generationId &&
							p.digest === reference.digest
					),
					"actual native selected own-generation promotion exists"
				);
				check(
					trace.reads.some((read) => {
						const key = read.parameters ?? (Array.isArray(read.query) ? read.query : []);
						return (
							read.table === "promotions" &&
							key.includes(generation.objectId) &&
							key.includes(generation.generationId) &&
							key.includes(reference.digest)
						);
					}),
					"each native-selected own-generation promotion exact lookup"
				);
			}
		}
	const returnedDigests = new Set(observed.blobs.map((blob) => blob.ref.digest));
	check(
		observed.blobs.length === union.size &&
			returnedDigests.size === observed.blobs.length &&
			[...union.keys()].every((digest) => returnedDigests.has(digest)),
		"exact distinct returned digest set equals native selected union"
	);
	for (const blob of observed.blobs) {
		const reference = union.get(blob.ref.digest),
			nativeBlob = expectedImage.blobs.find((b) => b.digest === blob.ref.digest);
		check(reference && nativeBlob, "every returned blob has a native selected ref and actual bytes");
		check(completeEqual(blob.ref, reference), "complete returned ref equals native ref including declared length");
		check(
			bytesEqual(blob.bytes, nativeBlob.bytes) &&
				blob.bytes.byteLength === reference.byteLength &&
				must(digestBlob(blob.bytes)) === reference.digest,
			"returned selected bytes equal actual native bytes with exact length and digest"
		);
	}
	return union;
}
export function payload(n: number, size = 5): Uint8Array {
	const bytes = new Uint8Array(size).fill(n);
	if (size) bytes[0] = n;
	return bytes;
}
export function ref(bytes: Uint8Array): GenerationRef {
	return { digest: must(digestBlob(bytes)), byteLength: bytes.byteLength };
}
export async function stage(
	store: AheDurableStore,
	n: number,
	head: ExpectedHead,
	bytes: readonly Uint8Array[],
	adopt = true
): Promise<ExpectedHead> {
	const closure = bytes.map(ref).sort((a, b) => a.digest.localeCompare(b.digest));
	must(await store.beginGeneration({ objectId: OBJECT, generationId: id(n), baseExpectedHead: head, closure }));
	for (const value of bytes) {
		must(await store.putCachedBlob({ objectId: OBJECT, generationId: id(n), digest: ref(value).digest, bytes: value }));
		if (store.capabilities.durability !== "ephemeral")
			must(await store.promoteReference({ objectId: OBJECT, generationId: id(n), digest: ref(value).digest }));
	}
	if (!adopt || store.capabilities.durability === "ephemeral") return head;
	must(await store.completeGeneration({ objectId: OBJECT, generationId: id(n) }));
	return must(await store.swapHead({ objectId: OBJECT, generationId: id(n), expectedHead: head })).head;
}
function record(image: Image, n: number): GenerationRecord {
	const row = image.generations.find((entry) => entry.generationId === id(n));
	check(row, "setup generation absent");
	return must(decodeGenerationRecordV1(row.record));
}
function head(image: Image): ExpectedHead {
	const bytes = image.heads.find((entry) => entry.objectId === OBJECT)?.record;
	return bytes == null ? { kind: "none", objectId: OBJECT } : must(decodeHeadRecordV1(bytes));
}
async function changeRecord(env: Environment, n: number, changes: Partial<GenerationRecord>): Promise<void> {
	const next = { ...record(await env.image(), n), ...changes };
	await env.edit({ kind: "generation", generationId: id(n), record: encodeGenerationRecordV1(next) });
}
export async function setup(name: Case, env: Environment, close = true): Promise<void> {
	const store = await env.open();
	try {
		let current: ExpectedHead = { kind: "none", objectId: OBJECT };
		const large = name === "declared-B+1" || name === "union-U+1" || name === "B-U-boundary";
		const count = name === "empty-debt" ? 0 : name === "selected-F+1" || name === "F-boundary" || large ? 1 : 3;
		for (let n = 1; n <= count; n++) {
			const blobs =
				name === "selected-F+1" || name === "F-boundary"
					? Array.from({ length: name === "F-boundary" ? 7 : 8 }, (_, j) => payload(j + 10))
					: large
						? Array.from({ length: name === "declared-B+1" ? 1 : name === "union-U+1" ? 5 : 4 }, (_, j) =>
								payload(j + 10, name === "declared-B+1" ? 65537 : 65536)
							)
						: [payload(n), payload(90)]; // Arbitrary generic bytes must not be silently excluded.
			current = await stage(store, n, current, blobs);
		}
		if (name === "seven-all-states" || name === "eight-valid" || name === "invalid-overflow-sentinel") {
			for (let n = 4; n <= (name === "seven-all-states" ? 7 : 8); n++)
				await stage(store, n, current, [payload(n)], false);
			if (store.capabilities.durability !== "ephemeral") {
				must(await store.completeGeneration({ objectId: OBJECT, generationId: id(4) }));
				must(await store.discardGeneration({ objectId: OBJECT, generationId: id(5) }));
			}
		}
		if (name === "empty-debt" || name === "unselected-F+1" || name === "unselected-corruption")
			await stage(
				store,
				9,
				current,
				Array.from({ length: name === "unselected-F+1" ? 8 : 1 }, (_, j) => payload(20 + j)),
				false
			);
	} finally {
		if (close) await store.close();
	}
	if (env.backend === "ephemeral") return;
	const image = await env.image();
	const active = record(
		image,
		name === "empty-debt" ? 9 : image.generations.some((g) => g.generationId === id(3)) ? 3 : 1
	);
	const encoded = (value: unknown): Uint8Array => encodeCanonical(value);
	if (name === "head-H+1") await env.edit({ kind: "head", record: new Uint8Array(3327).fill(255) });
	if (name === "generation-R+1")
		await env.edit({ kind: "generation", generationId: id(1), record: new Uint8Array(7308).fill(255) });
	if (name === "head-depth" || name === "head-items")
		await env.edit({
			kind: "head",
			record: encoded(name === "head-depth" ? { a: { b: { c: 1 } } } : Array(34).fill(0)),
		});
	if (name === "generation-depth" || name === "generation-items")
		await env.edit({
			kind: "generation",
			generationId: id(1),
			record: encoded(name === "generation-depth" ? { a: { b: { c: { d: { e: 1 } } } } } : Array(128).fill(0)),
		});
	if (name === "unselected-corruption")
		await env.edit({ kind: "generation", generationId: id(9), record: Uint8Array.of(255) });
	if (name === "two-adopted") await changeRecord(env, 1, { state: "Adopted" });
	if (name === "missing-parent") await env.edit({ kind: "delete-generation", generationId: id(2) });
	if (name === "wrong-parent-state") await changeRecord(env, 2, { state: "Complete" });
	if (name === "wrong-parent-closure" || name === "wrong-revision" || name === "repeated-parent") {
		check(active.baseExpectedHead.kind === "present", "base present");
		await changeRecord(env, 3, {
			baseExpectedHead: {
				...active.baseExpectedHead,
				...(name === "wrong-parent-closure"
					? { closureDigest: "f".repeat(64) as PresentHead["closureDigest"] }
					: name === "wrong-revision"
						? { revision: 77 as PresentHead["revision"] }
						: { generationId: id(3) }),
			},
		});
	}
	const target = active.closure.find((entry) => entry.digest !== ref(payload(90)).digest) ?? active.closure[0];
	check(target, "target ref");
	if (name === "actual-B+1") await env.edit({ kind: "blob", digest: target.digest, bytes: payload(3, 65537) });
	if (name === "blob-missing") await env.edit({ kind: "blob", digest: target.digest, bytes: null });
	if (name === "blob-digest-corrupt")
		await env.edit({ kind: "blob", digest: target.digest, bytes: payload(61, target.byteLength) });
	if (name === "blob-length-corrupt")
		await env.edit({ kind: "blob", digest: target.digest, bytes: payload(3, target.byteLength + 1) });
	if (name === "own-promotion-missing")
		await env.edit({ kind: "promotion", generationId: active.generationId, digest: ref(payload(90)).digest });
	if (name === "older-promotion-missing")
		await env.edit({ kind: "promotion", generationId: id(1), digest: ref(payload(90)).digest });
	if (name === "older-blob-corrupt")
		await env.edit({ kind: "blob", digest: ref(payload(1)).digest, bytes: payload(63) });
	if (name === "shared-length-conflict") {
		const prior = record(image, 2),
			closure = prior.closure.map((entry) =>
				entry.digest === ref(payload(90)).digest ? { ...entry, byteLength: entry.byteLength + 1 } : entry
			);
		await changeRecord(env, 2, { closure, closureDigest: must(digestClosure(closure)) });
		const newPrior = record(await env.image(), 2);
		check(active.baseExpectedHead.kind === "present", "base present");
		await changeRecord(env, 3, {
			baseExpectedHead: { ...active.baseExpectedHead, closureDigest: newPrior.closureDigest },
		});
	}
	if (name.startsWith("key-") || name === "invalid-overflow-sentinel") {
		const n = name === "invalid-overflow-sentinel" ? 8 : 1;
		const physical: unknown =
			name === "key-scope"
				? id(1)
				: name === "key-array-above-old-bound"
					? ["outside"]
					: name === "key-number"
						? 11
						: name === "key-blob" || name === "key-binary"
							? new Uint8Array(64).fill(97)
							: name === "key-oversized-text"
								? "z".repeat(131072)
								: name === "key-multibyte-64-chars"
									? "é".repeat(64)
									: name === "invalid-overflow-sentinel"
										? "z".repeat(64)
										: "A".repeat(64);
		const physicalRow = image.generations.find((entry) => entry.generationId === id(n));
		check(physicalRow, "physical malformed-key source row present");
		await env.edit({
			kind: "generation",
			generationId: id(n),
			replaceId: physical,
			record: record(image, n) && physicalRow.record,
		});
		if (name === "key-scope") {
			const wrong = {
				...record(image, 1),
				objectId: OTHER,
				baseExpectedHead: { kind: "none" as const, objectId: OTHER },
			};
			await env.edit({ kind: "generation", generationId: physical, record: encodeGenerationRecordV1(wrong) });
		}
	}
}

export async function precondition(name: Case, env: Environment): Promise<Record<string, unknown>> {
	const image = await env.image();
	check(image.generations.length > 0 && image.blobs.length > 0, "native fixture actual rows/bytes");
	const persisted = image.generations.map((row) => ({ row, decoded: decodeGenerationRecordV1(row.record) }));
	const decoded = persisted.flatMap((p) => (p.decoded.ok ? [p.decoded.value] : []));
	const active = decoded.find((g) => g.state === "Adopted"),
		physicalHead = image.heads.find((h) => h.objectId === OBJECT)?.record;
	if (name === "head-H+1") check(physicalHead?.byteLength === 3327, "actual H+1 head bytes");
	if (name === "generation-R+1")
		check(
			image.generations.some((g) => g.record.byteLength === 7308),
			"actual R+1 generation bytes"
		);
	if (name === "selected-F+1" || name === "unselected-F+1")
		check(
			decoded.some(
				(g) => g.closure.length === 8 && (name === "selected-F+1" ? g.state === "Adopted" : g.state === "Staged")
			),
			"actual valid eight-ref closure"
		);
	if (name === "F-boundary") check(active?.closure.length === 7, "actual seven-ref closure");
	if (name === "declared-B+1")
		check(
			active?.closure.some((r) => r.byteLength === 65537),
			"actual valid declared B+1"
		);
	if (name === "union-U+1" || name === "B-U-boundary")
		check(
			active?.closure.reduce((sum, r) => sum + r.byteLength, 0) === (name === "union-U+1" ? 327680 : 262144),
			"actual distinct selected U boundary"
		);
	if (name === "unselected-corruption")
		check(
			image.generations.some((g) => g.generationId === id(9) && stable(g.record) === stable(Uint8Array.of(255))),
			"actual unselected corrupt row"
		);
	if (name === "two-adopted")
		check(decoded.filter((g) => g.state === "Adopted").length === 2, "actual two Adopted rows");
	if (name === "missing-parent")
		check(
			!image.generations.some((g) => g.generationId === id(2)) &&
				active?.baseExpectedHead.kind === "present" &&
				active.baseExpectedHead.generationId === id(2),
			"actual referenced parent absent"
		);
	if (name === "wrong-parent-state")
		check(decoded.find((g) => g.generationId === id(2))?.state === "Complete", "actual parent state");
	if (name === "wrong-parent-closure")
		check(
			active?.baseExpectedHead.kind === "present" && active.baseExpectedHead.closureDigest === "f".repeat(64),
			"actual wrong parent closure"
		);
	if (name === "wrong-revision")
		check(
			active?.baseExpectedHead.kind === "present" && active.baseExpectedHead.revision === 77,
			"actual wrong base revision"
		);
	if (name === "repeated-parent")
		check(
			active?.baseExpectedHead.kind === "present" && active.baseExpectedHead.generationId === active.generationId,
			"actual repeated lineage id"
		);
	if (active && ["blob-missing", "blob-digest-corrupt", "blob-length-corrupt", "actual-B+1"].includes(name)) {
		const target = active.closure.find((r) => r.digest !== ref(payload(90)).digest);
		check(target, "selected target ref present");
		const blob = image.blobs.find((b) => b.digest === target.digest);
		check(
			name === "blob-missing"
				? !blob
				: blob &&
						(name === "actual-B+1"
							? blob.bytes.byteLength === 65537
							: name === "blob-length-corrupt"
								? blob.bytes.byteLength === target.byteLength + 1
								: blob.bytes.byteLength === target.byteLength && must(digestBlob(blob.bytes)) !== target.digest),
			"actual selected blob fault"
		);
	}
	if (name === "shared-length-conflict") {
		const shared = decoded.flatMap((g) => g.closure).filter((r) => r.digest === ref(payload(90)).digest);
		check(new Set(shared.map((r) => r.byteLength)).size === 2, "actual repeated digest declared-length conflict");
	}
	if (name === "head-depth" || name === "head-items")
		check(
			stable(physicalHead) ===
				stable(encodeCanonical(name === "head-depth" ? { a: { b: { c: 1 } } } : Array(34).fill(0))),
			"actual head decoder adversary"
		);
	if (name === "generation-depth" || name === "generation-items")
		check(
			stable(image.generations.find((g) => g.generationId === id(1))?.record) ===
				stable(
					encodeCanonical(name === "generation-depth" ? { a: { b: { c: { d: { e: 1 } } } } } : Array(128).fill(0))
				),
			"actual generation decoder adversary"
		);
	if (name === "eight-valid" || name === "invalid-overflow-sentinel")
		check(image.generations.length === 8, "actual eight rows");
	if (name === "seven-all-states") check(image.generations.length === 7, "actual seven rows");
	if (name === "empty-debt") check(head(image).kind === "none", "actual no head");
	if (name === "own-promotion-missing") {
		const digest = ref(payload(90)).digest;
		check(!image.promotions.some((p) => p.generationId === id(3) && p.digest === digest), "exact promotion absent");
		check(
			image.promotions.some((p) => p.generationId === id(2) && p.digest === digest),
			"other-generation substitute exists"
		);
	}
	if (name === "older-promotion-missing")
		check(
			!image.promotions.some((p) => p.generationId === id(1) && p.digest === ref(payload(90)).digest) &&
				image.promotions.some((p) => p.generationId === id(3) && p.digest === ref(payload(90)).digest),
			"actual older own promotion absent but current substitute exists"
		);
	if (name === "older-blob-corrupt")
		check(
			image.blobs.some(
				(b) => b.digest === ref(payload(1)).digest && b.bytes.byteLength === 5 && must(digestBlob(b.bytes)) !== b.digest
			),
			"actual older-only blob corrupt"
		);
	if (name === "key-array-above-old-bound") {
		const key = image.generations.find((g) => Array.isArray(g.generationId));
		check(key, "actual array key");
		check(
			indexedDB.cmp([OBJECT, key.generationId] as IDBValidKey[], [OBJECT, []]) > 0,
			"key really beyond old [] bound"
		);
	}
	if (name === "key-oversized-text")
		check(
			image.generations.some((g) => typeof g.generationId === "string" && g.generationId.length === 131072),
			"oversized TEXT stored"
		);
	if (name === "key-multibyte-64-chars")
		check(
			image.generations.some(
				(g) =>
					typeof g.generationId === "string" &&
					g.generationId.length === 64 &&
					new TextEncoder().encode(g.generationId).byteLength === 128
			),
			"64 chars !=64 bytes"
		);
	if (name === "key-blob" || name === "key-binary")
		check(
			image.generations.some((g) => g.generationId instanceof Uint8Array || g.generationId instanceof ArrayBuffer),
			"actual wrong-type binary key"
		);
	if (name === "key-number")
		check(
			image.generations.some((g) => g.generationId === 11),
			"actual numeric key"
		);
	if (name === "key-spelling")
		check(
			image.generations.some((g) => g.generationId === "A".repeat(64)),
			"actual 64-byte uppercase spelling"
		);
	if (name === "key-scope")
		check(
			persisted.some((p) => p.row.generationId === id(1) && p.decoded.ok && p.decoded.value.objectId === OTHER),
			"actual physical/canonical scope disagreement"
		);
	if (name === "invalid-overflow-sentinel")
		check(
			image.generations.at(-1)?.generationId === "z".repeat(64) && image.generations.length === 8,
			"actual invalid eighth sentinel"
		);
	const control = await env.control();
	check(
		env.backend === "ephemeral" || (control.writes === 0 && control.terminals >= 1 && control.modes.length === 1),
		"real native readonly control"
	);
	return {
		native: env.backend !== "ephemeral",
		rows: image.generations.length,
		headBytes: physicalHead?.byteLength ?? null,
		metadata: persisted.map((p) => ({
			bytes: p.row.record.byteLength,
			state: p.decoded.ok ? p.decoded.value.state : p.decoded.reason,
			refs: p.decoded.ok ? p.decoded.value.closure.length : null,
		})),
		blobs: image.blobs.map((b) => ({
			digest: b.digest,
			length: b.bytes.byteLength,
			actualDigest: must(digestBlob(b.bytes)),
		})),
		keys: image.generations.map((g) =>
			typeof g.generationId === "string" && g.generationId.length > 64
				? { type: "string", chars: g.generationId.length, bytes: new TextEncoder().encode(g.generationId).byteLength }
				: g.generationId instanceof Uint8Array || g.generationId instanceof ArrayBuffer
					? { type: "binary", bytes: g.generationId.byteLength }
					: g.generationId
		),
		control,
	};
}
function acquire(store: AheDurableStore, input: unknown): Promise<Result<Acquisition>> {
	const method: unknown = Reflect.get(store, "acquireBoundedActiveRead");
	check(typeof method === "function", "WIRING_RED:acquireBoundedActiveRead absent; deeper assertions masked");
	return Reflect.apply(method, store, [input]) as Promise<Result<Acquisition>>;
}
function input(name: Case): { objectId: typeof OBJECT; ancestorCount: 0 | 2; limits: typeof LIMITS } {
	return {
		objectId: OBJECT,
		ancestorCount: [
			"active-two",
			"generic-union",
			"missing-parent",
			"wrong-parent-state",
			"wrong-parent-closure",
			"wrong-revision",
			"repeated-parent",
			"shared-length-conflict",
			"own-promotion-missing",
			"older-promotion-missing",
			"older-blob-corrupt",
		].includes(name)
			? 2
			: 0,
		limits: { ...LIMITS },
	};
}
function reason(result: Result<unknown>, allowed: readonly string[]): void {
	check(
		!result.ok && allowed.includes(result.reason),
		"expected refusal " + allowed.join("|") + "; actual " + stable(result)
	);
}
function readOnly(trace: Trace): void {
	check(
		trace.writes === 0 &&
			trace.modes.every((mode) => mode === "readonly" || /^BEGIN(?:\s+(?:DEFERRED|TRANSACTION))?\s*;?$/iu.test(mode)),
		"readonly no writer reservation"
	);
	check(trace.terminals === trace.modes.length, "all native transactions terminal");
	check(
		!trace.reads.some(
			(r) =>
				r.operation === "getAll" ||
				r.operation === "count" ||
				(typeof r.query === "string" && /\bCOUNT\s*\(/iu.test(r.query))
		),
		"no whole-value getAll/count"
	);
	check(
		!trace.reads.some(
			(r) => r.table === "generations" && typeof r.query === "string" && !/\bLIMIT\b|generation_id\s*=/iu.test(r.query)
		),
		"no uncapped native generation scan or recovery fallback"
	);
}
function generationValues(trace: Trace): Trace["reads"] {
	return trace.reads.flatMap((r) =>
		r.table === "generations"
			? (r.fields ?? []).filter((f) => f.name === "record" && f.type === "bytes").map(() => r)
			: []
	);
}
function blobValues(trace: Trace): Trace["reads"] {
	return trace.reads.flatMap((r) =>
		r.table === "blobs" ? (r.fields ?? []).filter((f) => f.name === "bytes" && f.type === "bytes").map(() => r) : []
	);
}
export function isFullGenerationRecordRead(read: Trace["reads"][number]): boolean {
	if (read.table !== "generations") return false;
	if (read.operation === "getAll") return true;
	if (typeof read.query !== "string") return false;
	const projection = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+generations\b/iu.exec(read.query)?.[1];
	if (!projection) return false;
	const recordBearing =
		read.fields?.some((field) => field.name === "record" && field.type === "bytes") ||
		projection.split(",").some((column) => /^(?:generations\.)?(?:record|\*)(?:\s+AS\s+\w+)?$/iu.test(column.trim()));
	if (!recordBearing) return false;
	const where = read.query.split(/\bWHERE\b/iu)[1] ?? "";
	const exactObjectAndGeneration = /\bobject_id\s*=/iu.test(where) && /\bgeneration_id\s*=/iu.test(where);
	return !exactObjectAndGeneration;
}

export async function run(name: Case, env: Environment): Promise<Record<string, unknown>> {
	const proof = await precondition(name, env),
		before = stable(await env.image()),
		store = await env.open();
	let observation: Trace | undefined;
	let lifecycleCoverage: Record<string, unknown> | undefined;
	try {
		const captured = input(name);
		const pending = env.observe(() => acquire(store, captured));
		if (name === "detached-input-output") {
			captured.objectId = OTHER as typeof OBJECT;
			captured.ancestorCount = 2;
			Reflect.set(captured.limits, "maxObjectGenerations", 999);
		}
		const observed = await pending;
		observation = observed.evidence;
		readOnly(observation);
		const result = observed.value;
		const budget = [
			"eight-valid",
			"head-H+1",
			"generation-R+1",
			"selected-F+1",
			"unselected-F+1",
			"head-depth",
			"head-items",
			"generation-depth",
			"generation-items",
			"declared-B+1",
			"actual-B+1",
			"union-U+1",
		];
		const corruption = [
			"unselected-corruption",
			"two-adopted",
			"shared-length-conflict",
			"blob-missing",
			"blob-digest-corrupt",
			"blob-length-corrupt",
			"own-promotion-missing",
			"older-promotion-missing",
			"older-blob-corrupt",
			...SQLITE_KEYS,
			...IDB_KEYS,
		];
		if (budget.includes(name)) {
			reason(result, ["READ_BUDGET_EXCEEDED"]);
			if (name === "eight-valid") check(generationValues(observation).length === 0, "G+1 before generation values");
			if (name !== "actual-B+1") check(blobValues(observation).length === 0, "budget admission before blob values");
			if (env.backend === "sqlite" && name === "actual-B+1")
				check(blobValues(observation).length === 0, "actual B gate before SQLite BLOB projection");
			if (env.backend === "sqlite")
				check(
					!observation.reads.some((r) =>
						r.fields?.some(
							(f) =>
								f.type === "bytes" &&
								f.bytes !== undefined &&
								f.bytes > (f.name === "head_record" ? 3326 : f.name === "record" ? 7307 : 65536)
						)
					),
					"SQLite native byte gate before value projection"
				);
			const probe = await store.readHead(OTHER);
			check(probe.ok, "read budget nonpoisoning owner");
		} else if (corruption.includes(name)) {
			reason(
				result,
				name === "older-promotion-missing"
					? ["BLOB_UNPROMOTED", "ADOPTED_BLOB_UNPROMOTED"]
					: name === "older-blob-corrupt"
						? ["BLOB_CORRUPT", "ADOPTED_BLOB_CORRUPT"]
						: name === "own-promotion-missing"
							? ["ADOPTED_BLOB_UNPROMOTED"]
							: name === "blob-missing"
								? ["ADOPTED_BLOB_MISSING"]
								: name.startsWith("blob-")
									? ["ADOPTED_BLOB_CORRUPT"]
									: ["NON_CANONICAL_RECORD", "HEAD_CONFLICT", "ILLEGAL_TRANSITION", "BLOB_CORRUPT"]
			);
			reason(await store.readHead(OTHER), ["STORE_POISONED"]);
			if (name.startsWith("key-") || name === "invalid-overflow-sentinel") {
				if (name !== "key-scope")
					check(generationValues(observation).length === 0, "physical key before generation values");
				if (env.backend === "sqlite")
					check(
						!observation.reads.some(
							(r) => r.table === "generations" && r.fields?.some((f) => f.type === "bytes" && f.name !== "record")
						),
						"wrong-type physical BLOB key not projected"
					);
				check(
					!observation.reads.some((r) =>
						r.fields?.some(
							(f) => f.bytes !== undefined && f.bytes > 64 && f.name !== "head_record" && f.name !== "record"
						)
					),
					"unchecked SQLite physical key never projected"
				);
			}
		} else if (
			["missing-parent", "wrong-parent-state", "wrong-parent-closure", "wrong-revision", "repeated-parent"].includes(
				name
			)
		) {
			reason(
				result,
				name === "missing-parent"
					? ["GENERATION_NOT_FOUND"]
					: name === "wrong-parent-closure"
						? ["BASE_HEAD_MISMATCH", "HEAD_CONFLICT"]
						: ["ILLEGAL_TRANSITION", "BASE_HEAD_MISMATCH", "HEAD_CONFLICT"]
			);
		} else if (name === "empty-debt") {
			check(
				result.ok && result.value.kind === "empty" && result.value.head.kind === "none",
				"no-head unadopted debt is empty"
			);
		} else {
			check(result.ok && result.value.kind === "present", "present acquisition");
			const reader = result.value.reader,
				expectedImage = await env.image(),
				expectedHead = head(expectedImage);
			check(expectedHead.kind === "present", "actual native present head");
			const expectedIds =
				captured.ancestorCount === 2 && name !== "detached-input-output"
					? [id(3), id(2), id(1)]
					: [expectedHead.generationId];
			const expectedRecords = expectedIds.map((generationId) => {
				const row = expectedImage.generations.find(
					(g) => g.objectId === expectedHead.objectId && g.generationId === generationId
				);
				check(row, "exact selected native metadata row present");
				return must(decodeGenerationRecordV1(row.record));
			});
			const union = assertNativeSelectedRead(
				reader,
				expectedHead,
				expectedRecords,
				expectedImage,
				env.backend === "ephemeral" ? undefined : observation
			);
			check(
				Object.isFrozen(reader.head) &&
					Object.isFrozen(reader.generations) &&
					reader.generations.every(
						(g) =>
							Object.isFrozen(g) &&
							Object.isFrozen(g.baseExpectedHead) &&
							Object.isFrozen(g.closure) &&
							g.closure.every(Object.isFrozen)
					) &&
					Object.isFrozen(reader.blobs) &&
					reader.blobs.every((b) => Object.isFrozen(b) && Object.isFrozen(b.ref)),
				"frozen structural output"
			);
			check(env.backend === "ephemeral" || observation.modes.length === 1, "same single native acquisition snapshot");
			check(
				generationValues(observation).length <= 7 && blobValues(observation).length <= union.size,
				"bounded serial metadata/distinct blobs"
			);
			if (env.backend !== "ephemeral") {
				check(
					generationValues(observation).length === expectedImage.generations.length,
					"every admitted metadata row validated exactly once"
				);
			}
			if (name === "detached-input-output") {
				Reflect.set(reader.head, "revision", 999);
				const firstGeneration = reader.generations[0],
					firstBlob = reader.blobs[0];
				check(firstGeneration && firstBlob, "detached outputs present");
				Reflect.set(firstGeneration, "generationId", id(99));
				firstBlob.bytes.fill(255);
				check((await reader.checkCurrent()).ok, "returned mutation cannot alter private head");
				const fresh = must(await acquire(store, input("active-zero")));
				check(fresh.kind === "present", "fresh present");
				check(
					fresh.reader.blobs.every((b) => must(digestBlob(b.bytes)) === b.ref.digest),
					"bytes detached from store"
				);
				await fresh.reader.release();
			}
			if (name.startsWith("stale-")) {
				check(expectedHead.kind === "present", "present fixture head");
				await env.edit({
					kind: "head",
					record:
						name === "stale-disappeared"
							? null
							: name === "stale-corrupt"
								? Uint8Array.of(255)
								: encodeHeadRecordV1({ ...expectedHead, revision: 99 as PresentHead["revision"] }),
				});
				const fresh = await env.observe(() => reader.checkCurrent());
				readOnly(fresh.evidence);
				reason(fresh.value, [name === "stale-corrupt" ? "NON_CANONICAL_RECORD" : "READ_STALE_HEAD"]);
				check(
					fresh.evidence.reads.every((r) => r.table === "objects" || r.table === "other"),
					"checkCurrent only fresh bounded head"
				);
			}
			if (name === "release-independent") {
				const second = must(await acquire(store, input("active-zero")));
				check(second.kind === "present", "second reader");
				await reader.release();
				await reader.release();
				reason(await reader.checkCurrent(), ["READ_RELEASED"]);
				check(
					(await second.reader.checkCurrent()).ok && (await store.readHead(OBJECT)).ok,
					"release other reader/owner unaffected"
				);
				await second.reader.release();
			}
			if (name === "release-queued-executing" || name === "close-queued-executing") {
				let closing: Promise<void> | undefined,
					released = false,
					first: Promise<Result<{ kind: "current" }>> | undefined,
					second: Promise<Result<{ kind: "current" }>> | undefined;
				const order: string[] = [];
				let secondAdmittedAtStart = false;
				const race = await env.observe(
					async () => {
						order.push("first-requested");
						first = reader.checkCurrent();
						order.push("first-admitted");
						second = reader.checkCurrent();
						order.push("second-admitted");
						return Promise.all([first, second]);
					},
					(edge) => {
						order.push("native-" + edge);
						if (edge === "start" && !released) {
							secondAdmittedAtStart = second !== undefined;
							released = true;
							order.push("release-or-close-requested");
							closing = name === "release-queued-executing" ? reader.release() : store.close();
							void closing.then(() => {
								order.push("release-or-close-settled");
							});
						}
					}
				);
				const [executingOutcome, laterOutcome] = race.value;
				check(released && executingOutcome?.ok, "actually executing check drains terminal outcome");
				check(laterOutcome, "later check outcome present");
				reason(laterOutcome, [name === "release-queued-executing" ? "READ_RELEASED" : "STORE_CLOSED"]);
				await closing;
				readOnly(race.evidence);
				check(
					order.indexOf("release-or-close-settled") > order.indexOf("native-terminal"),
					"release/close drains executing native terminal"
				);
				// No forced scheduler or delayed native callback: synchronous owners only establish new-after-release refusal.
				lifecycleCoverage = {
					order,
					secondAdmittedAtStart,
					genuineQueuedJobCovered: secondAdmittedAtStart,
					qualification: secondAdmittedAtStart
						? "admitted second job did not start before release/close"
						: "synchronous first start preceded second admission; queued policy requires source review",
				};
			}
			if (name === "close-before-release") {
				await reader.release();
				await store.close();
				reason(await reader.checkCurrent(), ["STORE_CLOSED"]);
			}
			if (name === "poison-before-release") {
				await env.edit({ kind: "head", record: Uint8Array.of(255) });
				await store.readHead(OBJECT);
				await reader.release();
				reason(await reader.checkCurrent(), ["STORE_POISONED"]);
			}
			if (name === "invalid-pre-I/O") {
				for (const invalid of [
					null,
					{ ...input(name), ancestorCount: 1 },
					{ ...input(name), objectId: "" },
					{ ...input(name), extra: true },
					{ ...input(name), limits: { ...LIMITS, maxUnionBytes: 262145 } },
					{ ...input(name), limits: { ...LIMITS, extra: 1 } },
				]) {
					const rejected = await env.observe(() => acquire(store, invalid));
					reason(rejected.value, ["INVALID_ARGUMENT"]);
					check(
						rejected.evidence.modes.length === 0 && rejected.evidence.reads.length === 0,
						"invalid captured input before native I/O"
					);
				}
				await store.close();
				const malformed = await env.observe(() => acquire(store, { ...input(name), ancestorCount: 1 }));
				reason(malformed.value, ["INVALID_ARGUMENT"]);
				check(
					malformed.evidence.reads.length === 0 && malformed.evidence.modes.length === 0,
					"malformed captured input precedes closed owner native scheduling"
				);
				reason(await acquire(store, input(name)), ["STORE_CLOSED"]);
			}
			if (name === "no-mutation-certificate") {
				const ordinary = await env.observe(() => store.completeGeneration({ objectId: OBJECT, generationId: id(3) }));
				check(
					ordinary.evidence.reads.some(isFullGenerationRecordRead),
					"read did not install global mutation certificate"
				);
			}
			if (name === "preserve-mutation-certificate") {
				// Certificate established ONLY through existing recovery; valid overbudget read may not clear it.
				must(await store.recoverActiveGeneration(OBJECT));
				for (let n = 4; n <= 8; n++) await stage(store, n, reader.head, [payload(n)], false);
				reason(await acquire(store, input(name)), ["READ_BUDGET_EXCEEDED"]);
				const ordinary = await env.observe(() => store.completeGeneration({ objectId: OBJECT, generationId: id(3) }));
				check(
					!ordinary.evidence.reads.some(isFullGenerationRecordRead),
					"budget read did not clear existing mutation certificate"
				);
			}
			await reader.release();
		}
		if (!name.startsWith("stale-") && name !== "poison-before-release" && name !== "preserve-mutation-certificate")
			check(stable(await env.image()) === before, "whole logical census unchanged no repair/pin/fallback");
		return { case: name, passed: true, proof, observation, lifecycleCoverage };
	} catch (error) {
		return {
			case: name,
			passed: false,
			proof,
			observation,
			failure: error instanceof Error ? error.message : String(error),
			unchanged: stable(await env.image()) === before,
		};
	} finally {
		await store.close();
	}
}
