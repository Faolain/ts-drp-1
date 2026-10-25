import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CompactMerkleAccumulator, merkleLeafHash, merkleNodeHash, verifyInclusion } from "@ts-drp/compaction";
import {
	digestBlob,
	type ArchiveAppendDeclaration,
	type ArchiveAppendCapacityBound,
	type ArchiveCapacityDeclaration,
	type ArchiveCapacityPromise,
	type ArchiveArtifactRef,
	type ArchiveIndexPosition,
	type ArchivePreparedAppend,
	type ArchiveStorage,
	type ArchiveStorageCapacity,
	type ArchiveStorageRead,
	type ArchiveStorageStatus,
} from "@ts-drp/storage";
import { snapshotQuarantineContract } from "@ts-drp/storage/snapshot-transfer";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

import { SqliteNativeReadReservationOwner } from "./internal/native-read-reservation.js";
import { sqliteFilename } from "./internal/sqlite-filename.js";
import { cachedStatement } from "./internal/sqlite-statement-cache.js";

export interface NodeArchiveStorageOptions {
	readonly filename: string;
	readonly initialization: "create" | "reopen";
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
	readonly capacity: ArchiveStorageCapacity;
}

const DIGEST = /^[0-9a-f]{64}$/u;
const SCHEMA = [
	"CREATE TABLE archive_control (id INTEGER PRIMARY KEY CHECK(id=1), bytes BLOB NOT NULL) STRICT",
	"CREATE TABLE archive_artifacts (digest TEXT PRIMARY KEY, byte_length INTEGER NOT NULL CHECK(byte_length>0), ref_bytes BLOB NOT NULL, bytes BLOB NOT NULL CHECK(length(bytes)=byte_length)) STRICT",
	"CREATE TABLE archive_leaves (leaf_index INTEGER PRIMARY KEY, digest TEXT NOT NULL, start_ordinal INTEGER NOT NULL, end_ordinal INTEGER NOT NULL, charge INTEGER NOT NULL) STRICT",
	"CREATE TABLE archive_nodes (start INTEGER NOT NULL, size INTEGER NOT NULL, hash BLOB NOT NULL CHECK(length(hash)=32), charge INTEGER NOT NULL, PRIMARY KEY(start,size)) STRICT",
];
type CompactIndex = { size: number; peaks: Array<Uint8Array | null> };
interface Pending {
	declaration: ArchiveAppendDeclaration;
	intentDigest: string;
	reservedBytes: number;
	reservedArtifacts: number;
	prepared: ArchivePreparedAppend | null;
	frontier: CompactIndex | null;
}
interface CapacityPromise extends Omit<ArchiveCapacityPromise,"declaration"|"promiseDigest"|"reservedEncodedBytes"|"reservedArtifacts"> {
	declaration: ArchiveCapacityDeclaration;
	promiseDigest: string;
	reservedEncodedBytes: number;
	reservedArtifacts: number;
	currentReservedBytes: number;
	currentReservedArtifacts: number;
}
interface Control {
	objectId: string;
	pinnedGenesisAnchorDigest: string;
	capacity: ArchiveStorageCapacity;
	position: ArchiveIndexPosition;
	frontier: CompactIndex;
	storedArtifactBytes: number;
	storedArtifacts: number;
	storedArtifactMetadataBytes: number;
	storedIndexMetadataBytes: number;
	lastCompleted: Readonly<{
		intentDigest: string;
		declaration: ArchiveAppendDeclaration;
		expected: ArchiveIndexPosition;
		target: ArchiveIndexPosition;
	}> | null;
	pending: Pending | null;
	capacityPromise: CapacityPromise | null;
}

const failure = (code: string): Error => Object.assign(new Error(code), { code });
function integer(value: unknown, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
		throw failure("ARCHIVE_INVALID_ARGUMENT");
	return value;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !DIGEST.test(value)) throw failure("ARCHIVE_INVALID_ARGUMENT");
	return value;
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
		Reflect.ownKeys(value).length !== keys.length
	)
		throw failure("ARCHIVE_INVALID_ARGUMENT");
	const output: Record<string, unknown> = {};
	for (const key of keys) {
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (property?.enumerable !== true || !("value" in property)) throw failure("ARCHIVE_INVALID_ARGUMENT");
		output[key] = property.value;
	}
	return output;
}
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const hashBytes = (value: string): Uint8Array =>
	Uint8Array.from(digest(value).match(/../gu)!, (part) => Number.parseInt(part, 16));
const sum = (left: number, right: number): number => integer(left + right);
const same = (left: unknown, right: unknown): boolean =>
	compareBytes(encodeCanonical(left), encodeCanonical(right)) === 0;
function position(value: unknown): ArchiveIndexPosition {
	const p = fields(value, ["revision", "root", "size", "lastOrdinal"]);
	const lastOrdinal = integer(p.lastOrdinal, -1),
		size = integer(p.size);
	if ((size === 0) !== (lastOrdinal === -1)) throw failure("ARCHIVE_INVALID_ARGUMENT");
	return Object.freeze({ revision: integer(p.revision), root: digest(p.root), size, lastOrdinal });
}
function capacity(value: unknown): ArchiveStorageCapacity {
	const keys = [
		"maxArtifactBytes",
		"maxTotalEncodedBytes",
		"maxArtifacts",
		"maxAppendArtifacts",
		"maxAppendEncodedBytes",
		"maxControlBytes",
		"maxReadPageEntries",
		"maxReadPageBytes",
		"maxReadHandles",
		"maxQueuedCalls",
	];
	const input = fields(value, keys);
	for (const key of keys) input[key] = integer(input[key], 1);
	return Object.freeze(input) as unknown as ArchiveStorageCapacity;
}
function ref(value: unknown, c: ArchiveStorageCapacity): ArchiveArtifactRef {
	const kind = Object.getOwnPropertyDescriptor(value, "kind")?.value;
	const r = fields(
			value,
			kind === "chunk"
				? ["kind", "digest", "byteLength", "startOrdinal", "chunkIndex"]
				: ["kind", "digest", "byteLength"]
		),
		byteLength = integer(r.byteLength, 1);
	if (byteLength > c.maxArtifactBytes) throw failure("ARCHIVE_CAPACITY");
	if (kind === "segment" || kind === "index-entry") return { kind, digest: digest(r.digest), byteLength };
	if (kind === "chunk")
		return {
			kind,
			digest: digest(r.digest),
			byteLength,
			startOrdinal: integer(r.startOrdinal),
			chunkIndex: integer(r.chunkIndex),
		};
	throw failure("ARCHIVE_INVALID_ARGUMENT");
}
function bytes(value: Uint8Array, limit: number): Uint8Array {
	if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > limit)
		throw failure("ARCHIVE_CAPACITY");
	return snapshotQuarantineContract.captureExactBytes(value, "archive artifact bytes", limit);
}
function blobDigest(value: Uint8Array): string {
	const result = digestBlob(value);
	if (!result.ok) throw failure("ARCHIVE_INVALID_ARGUMENT");
	return result.value;
}
function decode(value: Uint8Array, limit: number): unknown {
	const limits = { maxBytes: limit, maxDepth: 16, maxItems: 1_000_000 };
	const decoded = decodeCanonical(value, limits);
	if (compareBytes(encodeCanonical(decoded, limits), value) !== 0) throw failure("ARCHIVE_CORRUPT");
	return decoded;
}

/** Direct native object-scoped storage; local mechanical completion never authorizes a Cut. */
export function createNodeArchiveStorage(options: NodeArchiveStorageOptions): ArchiveStorage {
	const o = fields(options, ["filename", "initialization", "objectId", "pinnedGenesisAnchorDigest", "capacity"]);
	if (
		typeof o.filename !== "string" ||
		o.filename.length === 0 ||
		o.filename.includes("\0") ||
		typeof o.objectId !== "string" ||
		o.objectId.length === 0 ||
		o.objectId.length > 1024 ||
		(o.initialization !== "create" && o.initialization !== "reopen")
	)
		throw failure("ARCHIVE_INVALID_ARGUMENT");
	const filename = resolve(o.filename),
		objectId = o.objectId,
		genesis = digest(o.pinnedGenesisAnchorDigest),
		c = capacity(o.capacity);
	if (c.maxControlBytes > c.maxTotalEncodedBytes) throw failure("ARCHIVE_CAPACITY");
	const database = new DatabaseSync(sqliteFilename(filename, o.initialization), {
		allowExtension: false,
		enableDoubleQuotedStringLiterals: false,
	});
	const reservations = new SqliteNativeReadReservationOwner(filename);
	let closed = false,
		closing: Promise<void> | undefined;
	const jobs = new Set<Promise<unknown>>(),
		reads = new Set<ArchiveStorageRead>();
	let tail: Promise<void> = Promise.resolve();
	const open = (): void => {
		if (closed) throw failure("ARCHIVE_CLOSED");
	};
	const transact = <T>(write: boolean, operation: () => T): T => {
		open();
		database.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		try {
			const result = operation();
			database.exec("COMMIT");
			return result;
		} catch (cause) {
			try {
				database.exec("ROLLBACK");
			} catch {}
			throw cause;
		}
	};
	const encodeControl = (control: Control): Uint8Array =>
		encodeCanonical(control, { maxBytes: c.maxControlBytes, maxDepth: 16, maxItems: 1_000_000 });
	const save = (control: Control): void => {
		const encoded = encodeControl(control);
		if (
			sum(
				sum(sum(control.storedArtifactBytes, control.storedArtifactMetadataBytes), control.storedIndexMetadataBytes),
				sum(c.maxControlBytes, control.pending?.reservedBytes ?? 0)
				+ (control.capacityPromise?.reservedEncodedBytes ?? 0)
			) > c.maxTotalEncodedBytes
		)
			throw failure("ARCHIVE_CAPACITY");
		if (
			sum(
				control.storedArtifacts,
				sum(control.pending?.reservedArtifacts ?? 0, control.capacityPromise?.reservedArtifacts ?? 0)
			) > c.maxArtifacts
		)
			throw failure("ARCHIVE_CAPACITY");
		cachedStatement(
			database,
			"INSERT INTO archive_control(id,bytes) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes"
		).run(encoded);
	};
	const load = (): Control => {
		const width = cachedStatement(database, "SELECT length(bytes) AS width FROM archive_control WHERE id=1").get()
			?.width;
		if (typeof width !== "number" || width < 1 || width > c.maxControlBytes) throw failure("ARCHIVE_CORRUPT");
		const raw = cachedStatement(database, "SELECT bytes FROM archive_control WHERE id=1").get()?.bytes;
		if (!(raw instanceof Uint8Array)) throw failure("ARCHIVE_CORRUPT");
		const value = fields(decode(raw, c.maxControlBytes), [
			"objectId",
			"pinnedGenesisAnchorDigest",
			"capacity",
			"position",
			"frontier",
			"storedArtifactBytes",
			"storedArtifacts",
			"storedArtifactMetadataBytes",
			"storedIndexMetadataBytes",
			"lastCompleted",
			"pending",
			"capacityPromise",
		]);
		if (
			value.objectId !== objectId ||
			value.pinnedGenesisAnchorDigest !== genesis ||
			!same(capacity(value.capacity), c)
		)
			throw failure("ARCHIVE_SCOPE_OR_POLICY_MISMATCH");
		const p = position(value.position),
			frontier = CompactMerkleAccumulator.fromSnapshot(value.frontier as CompactIndex).snapshot();
		if (frontier.size !== p.size || hex(CompactMerkleAccumulator.fromSnapshot(frontier).root()) !== p.root)
			throw failure("ARCHIVE_CORRUPT");
		integer(value.storedArtifactBytes);
		integer(value.storedArtifacts);
		integer(value.storedArtifactMetadataBytes);
		integer(value.storedIndexMetadataBytes);
		if (
			integer(value.storedArtifacts) > c.maxArtifacts ||
			sum(
				sum(integer(value.storedArtifactBytes), integer(value.storedArtifactMetadataBytes)),
				integer(value.storedIndexMetadataBytes)
			) > c.maxTotalEncodedBytes
		)
			throw failure("ARCHIVE_CORRUPT");
		if (value.lastCompleted !== null) {
			const last = fields(value.lastCompleted, ["intentDigest", "declaration", "expected", "target"]);
			digest(last.intentDigest);
			const declaration = captureDeclaration(last.declaration as ArchiveAppendDeclaration);
			if (!same(declaration.expected, position(last.expected)) ||
				hex(hashDomain("ts-drp-storage/archive-append/v1", encodeCanonical(declaration))) !== last.intentDigest || declaration.targetRoot !== p.root ||
				p.size !== declaration.expected.size + declaration.indexEntries.length ||
				p.revision !== declaration.expected.revision + 1 || !same(position(last.target), p)) throw failure("ARCHIVE_CORRUPT");
		}
		if (value.pending !== null) {
			const pending = fields(value.pending, ["declaration", "intentDigest", "reservedBytes", "reservedArtifacts", "prepared", "frontier"]);
			const declaration = captureDeclaration(pending.declaration as ArchiveAppendDeclaration);
			if (
				!same(declaration.expected, p) ||
				hex(hashDomain("ts-drp-storage/archive-append/v1", encodeCanonical(declaration))) !==
					digest(pending.intentDigest) ||
				integer(pending.reservedBytes) > c.maxAppendEncodedBytes
				|| integer(pending.reservedArtifacts) > declaration.artifacts.length
			)
				throw failure("ARCHIVE_CORRUPT");
			if ((pending.frontier === null) !== (pending.prepared === null)) throw failure("ARCHIVE_CORRUPT");
			if (pending.prepared !== null) {
				const prepared = fields(pending.prepared, ["kind", "intentDigest", "target", "verifiedArtifactBytes"]);
				const target = position(prepared.target),
					next = CompactMerkleAccumulator.fromSnapshot(pending.frontier as CompactIndex);
				if (
					prepared.kind !== "native-prepared-archive-append" ||
					prepared.intentDigest !== pending.intentDigest ||
					target.revision !== sum(p.revision, 1) ||
					target.size !== sum(p.size, declaration.indexEntries.length) ||
					target.root !== declaration.targetRoot ||
					next.size !== target.size ||
					hex(next.root()) !== target.root ||
					integer(prepared.verifiedArtifactBytes) !==
						declaration.artifacts.reduce((total, artifact) => sum(total, artifact.byteLength), 0)
				)
					throw failure("ARCHIVE_CORRUPT");
			}
		}
		if (value.capacityPromise !== null) {
			const promise = fields(value.capacityPromise, ["declaration","promiseDigest","reservedEncodedBytes","reservedArtifacts",
				"maxControlByteLength","currentReservedBytes","currentReservedArtifacts"]);
			const declaration = captureCapacityDeclaration(promise.declaration as ArchiveCapacityDeclaration);
			if (capacityPromiseId(declaration) !== digest(promise.promiseDigest) ||
				!same(declaration.expected,p) || integer(promise.currentReservedBytes) > integer(promise.reservedEncodedBytes) ||
				integer(promise.currentReservedArtifacts) > integer(promise.reservedArtifacts) || promise.maxControlByteLength !== c.maxControlBytes) throw failure("ARCHIVE_CORRUPT");
		}
		const captured = value as unknown as Control;
		if (sum(captured.storedArtifacts,sum(captured.pending?.reservedArtifacts ?? 0,captured.capacityPromise?.reservedArtifacts ?? 0)) > c.maxArtifacts ||
			sum(sum(sum(captured.storedArtifactBytes,captured.storedArtifactMetadataBytes),captured.storedIndexMetadataBytes),
				sum(c.maxControlBytes,sum(captured.pending?.reservedBytes ?? 0,captured.capacityPromise?.reservedEncodedBytes ?? 0))) > c.maxTotalEncodedBytes)
			throw failure("ARCHIVE_CORRUPT");
		return { ...value, position: p, frontier } as unknown as Control;
	};
	try {
		database.exec("PRAGMA busy_timeout=1000");
		if (o.initialization === "create") {
			if (
				cachedStatement(database, "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() !==
				undefined
			)
				throw failure("ARCHIVE_CREATE_REQUIRES_EMPTY_STORE");
			database.exec("PRAGMA journal_mode=WAL");
			database.exec("PRAGMA synchronous=FULL");
			transact(true, () => {
				if (
					cachedStatement(database, "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() !==
					undefined
				)
					throw failure("ARCHIVE_CREATE_REQUIRES_EMPTY_STORE");
				for (const sql of SCHEMA) database.exec(sql);
				const accumulator = new CompactMerkleAccumulator();
				save({
					objectId,
					pinnedGenesisAnchorDigest: genesis,
					capacity: c,
					position: { revision: 0, root: hex(accumulator.root()), size: 0, lastOrdinal: -1 },
					frontier: accumulator.snapshot(),
					storedArtifactBytes: 0,
					storedArtifacts: 0,
					storedArtifactMetadataBytes: 0,
					storedIndexMetadataBytes: 0,
					lastCompleted: null,
					pending: null,
					capacityPromise: null,
				});
			});
		}
		const schema = cachedStatement(
			database,
			"SELECT sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
		).all();
		if (schema.length !== SCHEMA.length || schema.map((row) => row.sql).some((sql) => !SCHEMA.includes(sql as string)))
			throw failure("ARCHIVE_UNSUPPORTED_SCHEMA");
		if (cachedStatement(database, "PRAGMA journal_mode").get()?.journal_mode !== "wal")
			throw failure("ARCHIVE_UNSUPPORTED_DURABILITY");
		database.exec("PRAGMA synchronous=FULL");
		load();
	} catch (cause) {
		database.close();
		throw cause;
	}

	const admit = <T>(operation: () => T | Promise<T>, capture?: () => void, delivery?: () => void): Promise<T> => {
		if (closed) return Promise.reject(failure("ARCHIVE_CLOSED"));
		if (jobs.size >= c.maxQueuedCalls) return Promise.reject(failure("ARCHIVE_CAPACITY"));
		let captureFailure: unknown;
		const task = tail
			.then(() => {
				open();
				if (captureFailure !== undefined) throw captureFailure;
				return operation();
			})
			.then((result) => {
				open();
				delivery?.();
				return result;
			});
		jobs.add(task);
		// One fresh FIFO turn includes asynchronous native acquisition and final delivery.
		// Failure rejects this call only; the next admitted turn still runs.
		tail = task.then(
			() => undefined,
			() => undefined
		);
		try {
			capture?.();
		} catch (cause) {
			captureFailure = cause;
		}
		void task.then(
			() => jobs.delete(task),
			() => jobs.delete(task)
		);
		return task;
	};
	const readArtifact = (reference: ArchiveArtifactRef): Uint8Array => {
		const width = cachedStatement(
			database,
			"SELECT byte_length,length(bytes) AS width FROM archive_artifacts WHERE digest=?"
		).get(reference.digest);
		if (width?.byte_length !== reference.byteLength || width.width !== reference.byteLength)
			throw failure("ARCHIVE_ARTIFACT_MISSING_OR_ALTERED");
		const raw = cachedStatement(database, "SELECT bytes FROM archive_artifacts WHERE digest=?").get(
			reference.digest
		)?.bytes;
		if (!(raw instanceof Uint8Array)) throw failure("ARCHIVE_CORRUPT");
		const exact = bytes(raw, c.maxArtifactBytes);
		if (!same(lookupArtifact(reference.digest), reference) || artifactDigest(reference, exact) !== reference.digest)
			throw failure("ARCHIVE_ARTIFACT_MISSING_OR_ALTERED");
		return exact;
	};
	const artifactDigest = (reference: ArchiveArtifactRef, exact: Uint8Array): string => {
		if (reference.kind === "segment") return hex(hashDomain("ts-drp/archive-segment/v3", exact));
		if (reference.kind === "chunk")
			return hex(
				hashDomain(
					"ts-drp/archive-chunk/v3",
					encodeCanonical(objectId),
					encodeCanonical(reference.startOrdinal),
					encodeCanonical(reference.chunkIndex),
					exact
				)
			);
		return blobDigest(exact);
	};
	const lookupArtifact = (id: string): ArchiveArtifactRef => {
		const width = cachedStatement(
			database,
			"SELECT length(ref_bytes) AS width FROM archive_artifacts WHERE digest=?"
		).get(digest(id))?.width;
		if (typeof width !== "number" || width < 1 || width > c.maxControlBytes)
			throw failure("ARCHIVE_ARTIFACT_MISSING_OR_ALTERED");
		const exact = cachedStatement(database, "SELECT ref_bytes FROM archive_artifacts WHERE digest=?").get(
			id
		)?.ref_bytes;
		if (!(exact instanceof Uint8Array)) throw failure("ARCHIVE_CORRUPT");
		const reference = ref(decode(exact, c.maxControlBytes), c);
		if (reference.digest !== id) throw failure("ARCHIVE_CORRUPT");
		return reference;
	};
	const entryFields = (exact: Uint8Array): Record<string, unknown> => {
		const entry = fields(decode(exact, c.maxArtifactBytes), [
			"objectId",
			"startOrdinal",
			"endOrdinal",
			"recordCount",
			"segmentDigest",
			"payloadDigest",
		]);
		if (
			entry.objectId !== objectId ||
			integer(entry.endOrdinal) !== sum(integer(entry.startOrdinal), integer(entry.recordCount, 1) - 1)
		)
			throw failure("ARCHIVE_INDEX_RANGE_INVALID");
		digest(entry.segmentDigest);
		digest(entry.payloadDigest);
		return entry;
	};
	const node = (start: number, size: number): Uint8Array => {
		const row = cachedStatement(database, "SELECT hash FROM archive_nodes WHERE start=? AND size=?").get(start, size);
		if (row?.hash instanceof Uint8Array && row.hash.byteLength === 32) return new Uint8Array(row.hash);
		if (row !== undefined) throw failure("ARCHIVE_CORRUPT");
		if (size < 2 || 2 ** Math.floor(Math.log2(size)) === size) throw failure("ARCHIVE_INDEX_NODE_MISSING");
		const split = 2 ** Math.floor(Math.log2(size - 1));
		return merkleNodeHash(node(start, split), node(start + split, size - split));
	};
	const path = (leaf: number, start: number, size: number): Uint8Array[] => {
		if (size === 1) return [];
		const split = 2 ** Math.floor(Math.log2(size - 1));
		return leaf < split
			? [...path(leaf, start, split), node(start + split, size - split)]
			: [...path(leaf - split, start + split, size - split), node(start, split)];
	};
	const proof = (leafIndex: number, size: number) => ({
		leafIndex,
		treeSize: size,
		auditPath: path(leafIndex, 0, size),
	});
	const verifyLast = (control: Control): void => {
		if (control.position.size === 0) return;
		const leaf = cachedStatement(database, "SELECT digest FROM archive_leaves WHERE leaf_index=?").get(
			control.position.size - 1
		);
		if (typeof leaf?.digest !== "string") throw failure("ARCHIVE_INDEX_FRONTIER_MISSING");
		const exact = readArtifact(lookupArtifact(leaf.digest));
		if (
			entryFields(exact).endOrdinal !== control.position.lastOrdinal ||
			!verifyInclusion(exact, proof(control.position.size - 1, control.position.size), hashBytes(control.position.root))
		)
			throw failure("ARCHIVE_INDEX_FRONTIER_ALTERED");
	};
	function captureDeclaration(input: ArchiveAppendDeclaration): ArchiveAppendDeclaration {
		const d = fields(input, [
			"objectId",
			"pinnedGenesisAnchorDigest",
			"sourceEpoch",
			"sourceAnchorDigest",
			"sourceCloseSetRoot",
			"expected",
			"targetRoot",
			"artifacts",
			"indexEntries",
		]);
		if (
			d.objectId !== objectId ||
			d.pinnedGenesisAnchorDigest !== genesis ||
			!Array.isArray(d.artifacts) ||
			!Array.isArray(d.indexEntries) ||
			d.artifacts.length < 1 ||
			d.indexEntries.length < 1 ||
			d.indexEntries.length > d.artifacts.length
		)
			throw failure("ARCHIVE_INVALID_ARGUMENT");
		if (d.artifacts.length > c.maxAppendArtifacts)
			throw Object.assign(failure("ARCHIVE_CAPACITY"), {
				capacityKind: "append-artifacts", requiredArtifacts: d.artifacts.length,
				maxAppendArtifacts: c.maxAppendArtifacts,
			});
		const artifacts = d.artifacts.map((item) => ref(item, c)),
			indexEntries = d.indexEntries.map((item) => ref(item, c));
		if (
			new Set(artifacts.map((item) => item.digest)).size !== artifacts.length ||
			new Set(indexEntries.map((item) => item.digest)).size !== indexEntries.length ||
			indexEntries.some((item) => item.kind !== "index-entry" || !artifacts.some((artifact) => same(item, artifact)))
		)
			throw failure("ARCHIVE_INVALID_ARGUMENT");
		if (artifacts.reduce((total, artifact) => sum(total, artifact.byteLength), 0) > c.maxAppendEncodedBytes)
			throw failure("ARCHIVE_CAPACITY");
		return {
			objectId,
			pinnedGenesisAnchorDigest: genesis,
			sourceEpoch: integer(d.sourceEpoch),
			sourceAnchorDigest: digest(d.sourceAnchorDigest),
			sourceCloseSetRoot: digest(d.sourceCloseSetRoot),
			expected: position(d.expected),
			targetRoot: digest(d.targetRoot),
			artifacts,
			indexEntries,
		};
	}
	const intentId = (declaration: ArchiveAppendDeclaration): string =>
		hex(
			hashDomain(
				"ts-drp-storage/archive-append/v1",
				encodeCanonical(declaration, { maxBytes: c.maxControlBytes, maxDepth: 16, maxItems: 1_000_000 })
			)
		);
	const pendingFor = (control: Control, id: string): Pending => {
		const pending = control.pending;
		if (
			pending === null ||
			pending.intentDigest !== digest(id) ||
			intentId(captureDeclaration(pending.declaration)) !== id
		)
			throw failure("ARCHIVE_INTENT_CONFLICT");
		return pending;
	};
	const metadataCharge = (value: unknown): number => encodeCanonical(value).byteLength;
	function captureCapacityBound(value: unknown): ArchiveAppendCapacityBound {
		const bound = fields(value,["artifactBytes","artifactCount","indexEntries","maxArtifactBytes"]);
		for (const key of Object.keys(bound)) integer(bound[key]);
		const result = bound as unknown as ArchiveAppendCapacityBound;
		if ((result.artifactCount === 0) !== (result.artifactBytes === 0) || result.indexEntries > result.artifactCount ||
			(result.artifactCount === 0 && (result.maxArtifactBytes !== 0 || result.indexEntries !== 0)) ||
			(result.artifactCount > 0 && (result.maxArtifactBytes < 1 || result.indexEntries < 1 ||
				result.artifactBytes < result.artifactCount || result.maxArtifactBytes > result.artifactBytes))) throw failure("ARCHIVE_INVALID_ARGUMENT");
		if (result.artifactCount > c.maxAppendArtifacts || result.artifactBytes > c.maxAppendEncodedBytes ||
			result.maxArtifactBytes > c.maxArtifactBytes) throw Object.assign(failure("ARCHIVE_CAPACITY"),{capacityKind:"prospective-append",required:result,capacity:c});
		return Object.freeze({...result});
	}
	function captureCapacityDeclaration(value: ArchiveCapacityDeclaration): ArchiveCapacityDeclaration {
		const request = fields(value,["objectId","pinnedGenesisAnchorDigest","sourceEpoch","sourceAnchorDigest","expected","current","continuation"]);
		if (request.objectId !== objectId || request.pinnedGenesisAnchorDigest !== genesis) throw failure("ARCHIVE_SCOPE_OR_POLICY_MISMATCH");
		return Object.freeze({objectId,pinnedGenesisAnchorDigest:genesis,sourceEpoch:integer(request.sourceEpoch),
			sourceAnchorDigest:digest(request.sourceAnchorDigest),expected:position(request.expected),
			current:captureCapacityBound(request.current),continuation:captureCapacityBound(request.continuation)});
	}
	function capacityPromiseId(declaration: ArchiveCapacityDeclaration): string {
		return hex(hashDomain("ts-drp-storage/archive-capacity-promise/v1",encodeCanonical(declaration)));
	}
	function capacityWidth(bound: ArchiveAppendCapacityBound, initialSize: number): number {
		if (bound.artifactCount === 0) return 0;
		// Digests below are width placeholders only; no declaration/artifact or
		// accepted proof is constructed from them. Every unknown ref is charged.
		let reserve = sum(bound.artifactBytes,bound.artifactCount * metadataCharge({kind:"chunk",digest:"0".repeat(64),
			byteLength:bound.maxArtifactBytes,startOrdinal:Number.MAX_SAFE_INTEGER,chunkIndex:Number.MAX_SAFE_INTEGER}));
		let size = initialSize;
		for (let i = 0; i < bound.indexEntries; i++) {
			reserve = sum(reserve,metadataCharge({leafIndex:size,digest:"0".repeat(64),startOrdinal:Number.MAX_SAFE_INTEGER,endOrdinal:Number.MAX_SAFE_INTEGER}));
			let count = size,width = 1;
			reserve = sum(reserve,metadataCharge({start:size,size:width,hash:new Uint8Array(32)}));
			while (count % 2 === 1) { width *= 2;
				reserve = sum(reserve,metadataCharge({start:size + 1 - width,size:width,hash:new Uint8Array(32)}));
				count = Math.floor(count / 2);
			}
			size = sum(size,1);
		}
		if (reserve > c.maxAppendEncodedBytes) throw Object.assign(failure("ARCHIVE_CAPACITY"),{capacityKind:"prospective-native-append",requiredEncodedBytes:reserve,maxAppendEncodedBytes:c.maxAppendEncodedBytes});
		return reserve;
	}
	const publicPromise = (promise: NonNullable<Control["capacityPromise"]>): ArchiveCapacityPromise => Object.freeze({
		declaration:captureCapacityDeclaration(promise.declaration),promiseDigest:promise.promiseDigest,
		reservedEncodedBytes:promise.reservedEncodedBytes,reservedArtifacts:promise.reservedArtifacts,maxControlByteLength:c.maxControlBytes});
	const status = (control: Control): ArchiveStorageStatus => ({
		maxControlByteLength:c.maxControlBytes,
		position: control.position,
		storedArtifactBytes: control.storedArtifactBytes,
		storedArtifacts: control.storedArtifacts,
		storedArtifactMetadataBytes: control.storedArtifactMetadataBytes,
		storedIndexMetadataBytes: control.storedIndexMetadataBytes,
		reservedAppendBytes: control.pending?.reservedBytes ?? 0,
		capacityPromise:control.capacityPromise === null ? null : publicPromise(control.capacityPromise),
		pending:
			control.pending === null
				? null
				: { intentDigest: control.pending.intentDigest, prepared: control.pending.prepared !== null },
	});

	return {
		inspect: () => admit(() => transact(false, () => status(load()))),
		reserveCapacity: (declaration) => {
			let captured!: ArchiveCapacityDeclaration;
			return admit(() => transact(true,() => {
				const control = load();
				if (!same(control.position,captured.expected)) throw failure("ARCHIVE_STALE_POSITION");
				const pending = control.pending;
				if (pending !== null && (control.capacityPromise === null || pending.declaration.sourceEpoch !== captured.sourceEpoch ||
					pending.declaration.sourceAnchorDigest !== captured.sourceAnchorDigest || !same(pending.declaration.expected,captured.expected)))
					throw failure("ARCHIVE_INTENT_CONFLICT");
				verifyLast(control);
				const old = control.capacityPromise;
				const sameBasis = old !== null && old.declaration.sourceEpoch === captured.sourceEpoch && old.declaration.sourceAnchorDigest === captured.sourceAnchorDigest;
				if (old !== null && !sameBasis) {
					const completed = control.lastCompleted;
					if (completed === null || completed.declaration.sourceEpoch !== old.declaration.sourceEpoch ||
						completed.declaration.sourceAnchorDigest !== old.declaration.sourceAnchorDigest ||
						captured.sourceEpoch !== old.declaration.sourceEpoch + 1 || !same(completed.target,control.position))
						throw failure("ARCHIVE_CAPACITY_BASIS_CONFLICT");
				}
				const union = (left: ArchiveAppendCapacityBound,right: ArchiveAppendCapacityBound): ArchiveAppendCapacityBound => ({
					artifactBytes:Math.max(left.artifactBytes,right.artifactBytes),artifactCount:Math.max(left.artifactCount,right.artifactCount),
					indexEntries:Math.max(left.indexEntries,right.indexEntries),maxArtifactBytes:Math.max(left.maxArtifactBytes,right.maxArtifactBytes)});
				if (old !== null) captured = Object.freeze({...captured,
					current:union(captured.current,sameBasis ? old.declaration.current : old.declaration.continuation),
					continuation:sameBasis ? union(captured.continuation,old.declaration.continuation) : captured.continuation});
				// A same-intent partial append already owns its CURRENT quota. Resume
				// never reserves/spends those bytes or artifacts a second time.
				const currentBytes = pending === null ? capacityWidth(captured.current,control.position.size) : 0;
				const continuationBytes = capacityWidth(captured.continuation,sum(control.position.size,
					pending?.declaration.indexEntries.length ?? captured.current.indexEntries));
				// Unused prior custody is not refunded by a quote/release/retry. Only
				// the existing certified close's completed position can advance basis.
				const reservedEncodedBytes = Math.max(sum(currentBytes,continuationBytes),old?.reservedEncodedBytes ?? 0);
				const currentArtifacts = pending === null ? captured.current.artifactCount : 0;
				const reservedArtifacts = Math.max(sum(currentArtifacts,captured.continuation.artifactCount),old?.reservedArtifacts ?? 0);
				control.capacityPromise = {declaration:captured,promiseDigest:capacityPromiseId(captured),reservedEncodedBytes,reservedArtifacts,maxControlByteLength:c.maxControlBytes,
					currentReservedBytes:Math.max(currentBytes,old?.currentReservedBytes ?? 0),
					currentReservedArtifacts:Math.max(currentArtifacts,old?.currentReservedArtifacts ?? 0)};
				// Complete future control serializers fit BEFORE admission. These
				// placeholders are widths only and never enter source verification,
				// a prepared append or any signed message.
				const sizeDeclaration = (bound: ArchiveAppendCapacityBound,expected: ArchiveIndexPosition,epoch: number): ArchiveAppendDeclaration => ({
					objectId,pinnedGenesisAnchorDigest:genesis,sourceEpoch:epoch,sourceAnchorDigest:captured.sourceAnchorDigest,
					sourceCloseSetRoot:"0".repeat(64),expected,targetRoot:"0".repeat(64),
					artifacts:Array.from({length:bound.artifactCount},() => ({kind:"chunk" as const,digest:"0".repeat(64),byteLength:bound.maxArtifactBytes,
						startOrdinal:Number.MAX_SAFE_INTEGER,chunkIndex:Number.MAX_SAFE_INTEGER})),
					indexEntries:Array.from({length:bound.indexEntries},() => ({kind:"index-entry" as const,digest:"0".repeat(64),byteLength:bound.maxArtifactBytes}))});
				const sizeTarget = (expected: ArchiveIndexPosition,bound: ArchiveAppendCapacityBound): ArchiveIndexPosition => ({
					root:"0".repeat(64),revision:sum(expected.revision,1),size:sum(expected.size,bound.indexEntries),lastOrdinal:Number.MAX_SAFE_INTEGER});
				const currentDeclaration = sizeDeclaration(captured.current,control.position,captured.sourceEpoch);
				const currentTarget = sizeTarget(control.position,captured.current);
				const sizePending = (declaration: ArchiveAppendDeclaration,target: ArchiveIndexPosition,bytes: number): Pending => ({
					declaration,intentDigest:"0".repeat(64),reservedBytes:bytes,reservedArtifacts:declaration.artifacts.length,
					prepared:{kind:"native-prepared-archive-append",intentDigest:"0".repeat(64),target,verifiedArtifactBytes:Number.MAX_SAFE_INTEGER},
					frontier:{size:target.size,peaks:Array.from({length:target.size === 0 ? 0 : Math.floor(Math.log2(target.size)) + 1},() => new Uint8Array(32))}});
				encodeControl({...control,pending:sizePending(currentDeclaration,currentTarget,currentBytes)});
				if (captured.continuation.artifactCount !== 0) {
					const continuation = sizeDeclaration(captured.continuation,currentTarget,sum(captured.sourceEpoch,1));
					const target = sizeTarget(currentTarget,captured.continuation);
					encodeControl({...control,position:currentTarget,lastCompleted:{intentDigest:"0".repeat(64),declaration:currentDeclaration,expected:control.position,target:currentTarget},
						pending:sizePending(continuation,target,continuationBytes)});
				}
				save(control);
				return publicPromise(control.capacityPromise);
			}),() => {captured = captureCapacityDeclaration(declaration);});
		},
		readAppendDeclaration: (input) => {
			let epoch!: number, anchor!: string, closeRoot!: string;
			return admit(() => transact(false, () => {
				const control = load(), matches = (declaration: ArchiveAppendDeclaration) => declaration.sourceEpoch === epoch &&
					declaration.sourceAnchorDigest === anchor && declaration.sourceCloseSetRoot === closeRoot;
				const pending = control.pending !== null && matches(control.pending.declaration) ? control.pending : null;
				const completed = control.lastCompleted !== null && matches(control.lastCompleted.declaration) ? control.lastCompleted : null;
				if (pending !== null && completed !== null) throw failure("ARCHIVE_INTENT_CONFLICT");
				if (pending !== null) return Object.freeze({ intentDigest: pending.intentDigest, declaration: captureDeclaration(pending.declaration),
					phase: pending.prepared === null ? "writing" as const : "prepared" as const });
				if (completed === null) return null;
				verifyLast(control);
				return Object.freeze({ intentDigest: completed.intentDigest, declaration: captureDeclaration(completed.declaration), phase: "committed" as const });
			}), () => {
				const captured = fields(input, ["sourceEpoch", "sourceAnchorDigest", "sourceCloseSetRoot"]);
				epoch = integer(captured.sourceEpoch); anchor = digest(captured.sourceAnchorDigest); closeRoot = digest(captured.sourceCloseSetRoot);
			});
		},
		beginAppend: (declaration) => {
			let captured!: ArchiveAppendDeclaration;
			return admit(
				() => {
					const id = intentId(captured);
					return transact(true, () => {
						const control = load();
						if (control.pending !== null) {
							const pending = pendingFor(control, id);
							if (!same(pending.declaration, captured)) throw failure("ARCHIVE_INTENT_CONFLICT");
							return {
								intentDigest: id,
								phase: pending.prepared === null ? ("writing" as const) : ("prepared" as const),
							};
						}
						if (
							control.lastCompleted?.intentDigest === id &&
							same(control.lastCompleted.expected, captured.expected) &&
							control.position.root === captured.targetRoot
						) {
							verifyLast(control);
							return { intentDigest: id, phase: "committed" as const };
						}
						if (!same(control.position, captured.expected)) throw failure("ARCHIVE_STALE_POSITION");
						verifyLast(control);
						let reserve = 0,
							newArtifacts = 0;
						for (const artifact of captured.artifacts) {
							const prior = cachedStatement(database, "SELECT byte_length FROM archive_artifacts WHERE digest=?").get(
								artifact.digest
							);
							if (prior === undefined) {
								reserve = sum(reserve, sum(artifact.byteLength, metadataCharge(artifact)));
								newArtifacts++;
							} else {
								if (prior.byte_length !== artifact.byteLength || !same(lookupArtifact(artifact.digest), artifact))
									throw failure("ARCHIVE_ARTIFACT_MISSING_OR_ALTERED");
								readArtifact(artifact);
							}
						}
						if (sum(control.storedArtifacts, newArtifacts) > c.maxArtifacts) throw failure("ARCHIVE_CAPACITY");
						// Reserve complete canonical leaf/node widths at maximum actual target positions.
						// Node count is exact from binary carry, not a room-age-dependent whole-store scan.
						let size = control.position.size;
						for (const artifact of captured.indexEntries) {
							reserve = sum(
								reserve,
								metadataCharge({
									leafIndex: size,
									digest: artifact.digest,
									startOrdinal: Number.MAX_SAFE_INTEGER,
									endOrdinal: Number.MAX_SAFE_INTEGER,
								})
							);
							let count = size,
								width = 1;
							reserve = sum(reserve, metadataCharge({ start: size, size: width, hash: new Uint8Array(32) }));
							while (count % 2 === 1) {
								width *= 2;
								reserve = sum(
									reserve,
									metadataCharge({ start: size + 1 - width, size: width, hash: new Uint8Array(32) })
								);
								count = Math.floor(count / 2);
							}
							size = sum(size, 1);
						}
						if (reserve > c.maxAppendEncodedBytes) throw failure("ARCHIVE_CAPACITY");
						if (control.capacityPromise !== null) {
							const promise = control.capacityPromise,basis = promise.declaration;
							if (basis.sourceEpoch !== captured.sourceEpoch || basis.sourceAnchorDigest !== captured.sourceAnchorDigest ||
								!same(basis.expected,captured.expected)) throw failure("ARCHIVE_CAPACITY_BASIS_CONFLICT");
							if (reserve > promise.currentReservedBytes || newArtifacts > promise.currentReservedArtifacts ||
								captured.artifacts.length > basis.current.artifactCount || captured.indexEntries.length > basis.current.indexEntries ||
								captured.artifacts.reduce((n,ref) => sum(n,ref.byteLength),0) > basis.current.artifactBytes ||
								captured.artifacts.some(ref => ref.byteLength > basis.current.maxArtifactBytes)) throw failure("ARCHIVE_CAPACITY");
							promise.reservedEncodedBytes -= reserve; promise.currentReservedBytes -= reserve;
							promise.reservedArtifacts -= newArtifacts; promise.currentReservedArtifacts -= newArtifacts;
						}
						control.pending = {
							declaration: captured,
							intentDigest: id,
							reservedBytes: reserve,
							reservedArtifacts: newArtifacts,
							prepared: null,
							frontier: null,
						};
						// Whole future control must fit BEFORE accepting the durable intent.
						// Placeholder hashes/maximum ordinal are sizing only, never native or portable authority.
						const peakCount = size === 0 ? 0 : Math.floor(Math.log2(size)) + 1;
						const sizingPeaks = Array.from({ length: peakCount }, (_, level) =>
							Math.floor(size / 2 ** level) % 2 === 1 ? new Uint8Array(32) : null
						);
						const target = {
							revision: sum(control.position.revision, 1),
							root: captured.targetRoot,
							size,
							lastOrdinal: Number.MAX_SAFE_INTEGER,
						};
						encodeControl({
							...control,
							storedArtifactBytes: Number.MAX_SAFE_INTEGER,
							storedArtifactMetadataBytes: Number.MAX_SAFE_INTEGER,
							storedArtifacts: Number.MAX_SAFE_INTEGER,
							storedIndexMetadataBytes: Number.MAX_SAFE_INTEGER,
							pending: {
								...control.pending,
								prepared: {
									kind: "native-prepared-archive-append",
									intentDigest: id,
									target,
									verifiedArtifactBytes: captured.artifacts.reduce(
										(total, artifact) => sum(total, artifact.byteLength),
										0
									),
								},
								frontier: { size, peaks: sizingPeaks },
							},
						});
						encodeControl({
							...control,
							storedArtifactBytes: Number.MAX_SAFE_INTEGER,
							storedArtifactMetadataBytes: Number.MAX_SAFE_INTEGER,
							storedArtifacts: Number.MAX_SAFE_INTEGER,
							storedIndexMetadataBytes: Number.MAX_SAFE_INTEGER,
							position: target,
							frontier: { size, peaks: sizingPeaks },
							pending: null,
							lastCompleted: { intentDigest: id, declaration: captured, expected: control.position, target },
						});
						save(control);
						return { intentDigest: id, phase: "writing" as const };
					});
				},
				() => {
					captured = captureDeclaration(declaration);
				}
			);
		},
		writeArtifact: (input) => {
			let capturedId!: string, reference!: ArchiveArtifactRef, exact!: Uint8Array;
			return admit(
				() => {
					if (exact.byteLength !== reference.byteLength || artifactDigest(reference, exact) !== reference.digest)
						throw failure("ARCHIVE_ARTIFACT_MISSING_OR_ALTERED");
					transact(true, () => {
						const control = load(),
							pending = pendingFor(control, capturedId);
						if (!pending.declaration.artifacts.some((artifact) => same(artifact, reference)))
							throw failure("ARCHIVE_ARTIFACT_NOT_DECLARED");
						const prior = cachedStatement(database, "SELECT byte_length FROM archive_artifacts WHERE digest=?").get(
							reference.digest
						);
						if (prior !== undefined) {
							if (compareBytes(readArtifact(reference), exact) !== 0)
								throw failure("ARCHIVE_ARTIFACT_MISSING_OR_ALTERED");
							return;
						}
						const metadata = metadataCharge(reference);
						if (pending.prepared !== null || pending.reservedBytes < sum(exact.byteLength, metadata))
							throw failure("ARCHIVE_INTENT_CONFLICT");
						cachedStatement(
							database,
							"INSERT INTO archive_artifacts(digest,byte_length,ref_bytes,bytes) VALUES(?,?,?,?)"
						).run(reference.digest, reference.byteLength, encodeCanonical(reference), exact);
						control.storedArtifactBytes = sum(control.storedArtifactBytes, exact.byteLength);
						control.storedArtifacts++;
						pending.reservedArtifacts--;
						control.storedArtifactMetadataBytes = sum(control.storedArtifactMetadataBytes, metadata);
						pending.reservedBytes -= sum(exact.byteLength, metadata);
						save(control);
						if (compareBytes(readArtifact(reference), exact) !== 0)
							throw failure("ARCHIVE_ARTIFACT_MISSING_OR_ALTERED");
					});
				},
				() => {
					const captured = fields(input, ["intentDigest", "ref", "bytes"]);
					capturedId = digest(captured.intentDigest);
					reference = ref(captured.ref, c);
					exact = bytes(captured.bytes as Uint8Array, reference.byteLength);
				}
			);
		},
		prepareAppend: (id) =>
			admit(() =>
				transact(true, () => {
					const control = load(),
						pending = pendingFor(control, id);
					let verifiedArtifactBytes = 0;
					for (const artifact of pending.declaration.artifacts) {
						readArtifact(artifact);
						verifiedArtifactBytes = sum(verifiedArtifactBytes, artifact.byteLength);
					}
					const verifyPrepared = (): ArchivePreparedAppend => {
						const prepared = pending.prepared;
						if (prepared === null) throw failure("ARCHIVE_READBACK_FAILED");
						for (const [offset, artifact] of pending.declaration.indexEntries.entries()) {
							const exact = readArtifact(artifact),
								entry = entryFields(exact);
							const row = cachedStatement(
								database,
								"SELECT leaf_index,digest,start_ordinal FROM archive_leaves WHERE leaf_index=?"
							).get(sum(pending.declaration.expected.size, offset));
							if (row?.digest !== artifact.digest || row.start_ordinal !== integer(entry.startOrdinal))
								throw failure("ARCHIVE_READBACK_FAILED");
							if (
								typeof row?.leaf_index !== "number" ||
								!verifyInclusion(exact, proof(row.leaf_index, prepared.target.size), hashBytes(prepared.target.root))
							)
								throw failure("ARCHIVE_READBACK_FAILED");
						}
						return prepared;
					};
					if (pending.prepared !== null) return verifyPrepared();
					const accumulator = CompactMerkleAccumulator.fromSnapshot(control.frontier);
					let ordinal = control.position.lastOrdinal;
					const insertNode = (start: number, size: number, hash: Uint8Array): void => {
						const charge = metadataCharge({ start, size, hash });
						if (pending.reservedBytes < charge) throw failure("ARCHIVE_CAPACITY");
						const existing = cachedStatement(database, "SELECT hash FROM archive_nodes WHERE start=? AND size=?").get(
							start,
							size
						);
						if (existing !== undefined) {
							if (!(existing.hash instanceof Uint8Array) || compareBytes(existing.hash, hash) !== 0)
								throw failure("ARCHIVE_CORRUPT");
							return;
						}
						cachedStatement(database, "INSERT INTO archive_nodes(start,size,hash,charge) VALUES(?,?,?,?)").run(
							start,
							size,
							hash,
							charge
						);
						pending.reservedBytes -= charge;
						control.storedIndexMetadataBytes = sum(control.storedIndexMetadataBytes, charge);
					};
					for (const artifact of pending.declaration.indexEntries) {
						const exact = readArtifact(artifact),
							entry = entryFields(exact),
							leafIndex = accumulator.size;
						if (entry.startOrdinal !== sum(ordinal, 1)) throw failure("ARCHIVE_INDEX_RANGE_INVALID");
						const charge = metadataCharge({
							leafIndex,
							digest: artifact.digest,
							startOrdinal: entry.startOrdinal,
							endOrdinal: entry.endOrdinal,
						});
						if (pending.reservedBytes < charge) throw failure("ARCHIVE_CAPACITY");
						cachedStatement(
							database,
							"INSERT INTO archive_leaves(leaf_index,digest,start_ordinal,end_ordinal,charge) VALUES(?,?,?,?,?)"
						).run(leafIndex, artifact.digest, integer(entry.startOrdinal), integer(entry.endOrdinal), charge);
						pending.reservedBytes -= charge;
						control.storedIndexMetadataBytes = sum(control.storedIndexMetadataBytes, charge);
						let hash = merkleLeafHash(exact),
							count = leafIndex,
							size = 1;
						insertNode(leafIndex, size, hash);
						while (count % 2 === 1) {
							hash = merkleNodeHash(node(leafIndex + 1 - size * 2, size), hash);
							size *= 2;
							insertNode(leafIndex + 1 - size, size, hash);
							count = Math.floor(count / 2);
						}
						accumulator.append(exact);
						ordinal = integer(entry.endOrdinal);
					}
					if (hex(accumulator.root()) !== pending.declaration.targetRoot) throw failure("ARCHIVE_TARGET_ROOT_MISMATCH");
					const target = {
						revision: sum(control.position.revision, 1),
						root: pending.declaration.targetRoot,
						size: accumulator.size,
						lastOrdinal: ordinal,
					};
					pending.frontier = accumulator.snapshot();
					if (control.capacityPromise !== null) {
						control.capacityPromise.reservedEncodedBytes = sum(control.capacityPromise.reservedEncodedBytes,pending.reservedBytes);
						control.capacityPromise.currentReservedBytes = sum(control.capacityPromise.currentReservedBytes,pending.reservedBytes);
					}
					pending.reservedBytes = 0;
					pending.prepared = {
						kind: "native-prepared-archive-append",
						intentDigest: id,
						target,
						verifiedArtifactBytes,
					};
					save(control);
					return verifyPrepared();
				})
			),
		commitPreparedAppend: (input) => {
			let id!: string, expected!: ArchiveIndexPosition;
			return admit(
				() =>
					transact(true, () => {
						const control = load();
						if (
							control.pending === null &&
							control.lastCompleted?.intentDigest === id &&
							same(control.lastCompleted.expected, expected)
						) {
							verifyLast(control);
							return control.position;
						}
						const pending = pendingFor(control, id);
						if (!same(control.position, expected) || pending.prepared === null || pending.frontier === null)
							throw failure("ARCHIVE_STALE_POSITION");
						for (const artifact of pending.declaration.artifacts) readArtifact(artifact);
						control.lastCompleted = { intentDigest: id, declaration: pending.declaration,
							expected: control.position, target: pending.prepared.target };
						control.position = pending.prepared.target;
						control.frontier = pending.frontier;
						control.pending = null;
						if (control.capacityPromise !== null) {
							// Position follows the exact committed append; source epoch/anchor
							// stay unchanged until the authenticated owner asks to advance.
							const declaration = {...control.capacityPromise.declaration,expected:control.position};
							control.capacityPromise.declaration = declaration;
							control.capacityPromise.promiseDigest = capacityPromiseId(declaration);
						}
						verifyLast(control);
						save(control);
						return control.position;
					}),
				() => {
					const captured = fields(input, ["intentDigest", "expected"]);
					id = digest(captured.intentDigest);
					expected = position(captured.expected);
				}
			);
		},
		acquireRead: (expected) => {
			let captured!: ArchiveIndexPosition;
			return admit(
				async () => {
					if (reads.size >= c.maxReadHandles) throw failure("ARCHIVE_CAPACITY");
					const held = await reservations.acquire();
					let released = false,
						releaseTask: Promise<void> | undefined;
					const readJobs = new Set<Promise<unknown>>();
					const current = async (): Promise<void> => {
						if (closed || released) throw failure("ARCHIVE_READ_REVOKED");
						await held.check();
						if (closed || released) throw failure("ARCHIVE_READ_REVOKED");
						if (!same(load().position, captured)) throw failure("ARCHIVE_STALE_POSITION");
					};
					const read = <T>(operation: () => T, capture?: () => void): Promise<T> => {
						if (released || closed) return Promise.reject(failure("ARCHIVE_READ_REVOKED"));
						const job = admit(
							async () => {
								await current();
								const result = operation();
								await current();
								return result;
							},
							capture,
							() => {
								if (closed || released) throw failure("ARCHIVE_READ_REVOKED");
							}
						);
						if (jobs.has(job)) {
							readJobs.add(job);
							void job.then(
								() => readJobs.delete(job),
								() => readJobs.delete(job)
							);
						}
						return job;
					};
					const handle: ArchiveStorageRead = {
						position: captured,
						readIndexFrontier: () => read(() => {
							const frontier = load().frontier;
							const snapshot = CompactMerkleAccumulator.fromSnapshot(frontier).snapshot();
							if (snapshot.size !== captured.size ||
								hex(CompactMerkleAccumulator.fromSnapshot(snapshot).root()) !== captured.root)
								throw failure("ARCHIVE_CORRUPT");
							if (encodeCanonical(snapshot).byteLength > c.maxReadPageBytes) throw failure("ARCHIVE_CAPACITY");
							return Object.freeze({ size: snapshot.size,
								peaks: Object.freeze(snapshot.peaks.map(peak => peak === null ? null : Uint8Array.from(peak))) });
						}),
						lookupArtifact: (id) => {
							let capturedId!: string;
							return read(
								() => lookupArtifact(capturedId),
								() => {
									capturedId = digest(id);
								}
							);
						},
						readArtifact: (reference) => {
							let capturedRef!: ArchiveArtifactRef;
							return read(
								() => readArtifact(capturedRef),
								() => {
									capturedRef = ref(reference, c);
								}
							);
						},
						readIndexPage: (input) => {
							let limit!: number, after!: number;
							return read(
								() => {
									if (limit > c.maxReadPageEntries) throw failure("ARCHIVE_CAPACITY");
									const rows = cachedStatement(
										database,
										"SELECT leaf_index,digest FROM archive_leaves WHERE leaf_index>? AND leaf_index<? ORDER BY leaf_index LIMIT ?"
									).all(after, captured.size, limit);
									const page = [];
									let total = 0;
									for (const row of rows) {
										if (typeof row.digest !== "string" || typeof row.leaf_index !== "number")
											throw failure("ARCHIVE_CORRUPT");
										const metadata = cachedStatement(
											database,
											"SELECT byte_length FROM archive_artifacts WHERE digest=?"
										).get(row.digest);
										const width = integer(metadata?.byte_length, 1),
											audit = proof(row.leaf_index, captured.size);
										total = sum(total, sum(width, audit.auditPath.length * 32));
										if (total > c.maxReadPageBytes) throw failure("ARCHIVE_CAPACITY");
										const exact = readArtifact(lookupArtifact(row.digest));
										if (!verifyInclusion(exact, audit, hashBytes(captured.root)))
											throw failure("ARCHIVE_READBACK_FAILED");
										page.push({ leafIndex: row.leaf_index, exactCanonicalEntryBytes: exact, proof: audit });
									}
									return Object.freeze(page);
								},
								() => {
									const capturedPage = fields(input, ["afterLeafIndex", "limit"]);
									limit = integer(capturedPage.limit, 1);
									after = capturedPage.afterLeafIndex === null ? -1 : integer(capturedPage.afterLeafIndex);
								}
							);
						},
						check: () => read(() => undefined),
						release: () => {
							released = true;
							return (releaseTask ??= (async () => {
								await Promise.allSettled([...readJobs]);
								await held.release();
								reads.delete(handle);
							})());
						},
					};
					try {
						await current();
						open();
						reads.add(handle);
						return handle;
					} catch (cause) {
						await handle.release();
						throw cause;
					}
				},
				() => {
					captured = position(expected);
				}
			);
		},
		close: () => {
			closed = true;
			reservations.revoke();
			return (closing ??= (async () => {
				await Promise.allSettled([...jobs]);
				await Promise.all([...reads].map((read) => read.release()));
				await reservations.close();
				database.close();
			})());
		},
	};
}
