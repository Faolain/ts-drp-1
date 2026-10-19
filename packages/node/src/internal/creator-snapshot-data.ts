import type { ResolvedBlueprintBytes, TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { decodeCanonicalExactness } from "@ts-drp/canonical/exact";
import type { CloseSetHistoryCommitment } from "@ts-drp/compaction";
import type { PromotionSource } from "@ts-drp/protocol-v3/internal/creator-forward-promotion";
import { openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import registry from "@ts-drp/protocol-v3/registry/registry-v1.json" with { type: "json" };
import { AHE_BOUNDED_READ_LIMITS, digestBlob } from "@ts-drp/storage";

export interface CreatorSnapshotCatalogIdentity {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly catalogDigest: string;
	readonly runtimeProfile: string;
}

/**
 * Canonical whole-record decoder shared by byte-only observation and adoption.
 * @returns A canonical whole record or undefined.
 * @param bytes - Exact canonical carrier bytes.
 */
function canonicalCreatorDataRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined {
	try {
		const value = decodeCanonical(bytes);
		return value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			compareBytes(encodeCanonical(value), bytes) === 0
			? (value as Readonly<Record<string, unknown>>)
			: undefined;
	} catch {
		return undefined;
	}
}

const EXACTNESS_VIEW_OVERRIDES = ["buffer", "byteLength", "byteOffset", "length"] as const;

/**
 * The same whole-record decoder over ONE decode. When that decode proves
 * default-limit canonicality the re-encode comparison is skipped; otherwise,
 * and for any view whose length/backing could be intercepted, the original
 * decode-encode-compare path runs unchanged.
 * @returns A canonical whole record or undefined.
 * @param bytes - Exact canonical carrier bytes.
 */
function canonicalCreatorDataRecordByExactness(bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined {
	if (!(bytes instanceof Uint8Array) || Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
		EXACTNESS_VIEW_OVERRIDES.some(name => Object.hasOwn(bytes, name)) || !(bytes.buffer instanceof ArrayBuffer))
		return canonicalCreatorDataRecord(bytes);
	try {
		const { value, exact } = decodeCanonicalExactness(bytes);
		return value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			(exact || compareBytes(encodeCanonical(value), bytes) === 0)
			? (value as Readonly<Record<string, unknown>>)
			: undefined;
	} catch {
		return undefined;
	}
}

export { canonicalCreatorDataRecordByExactness as canonicalCreatorDataRecord };

/**
 * Private syntax reuse for one lifecycle inspection/sizing tree or explicitly
 * owned bounded read-only acquisition job.
 * This is neither authentication nor native currency: callers retain every
 * original check and charge. Cached parsed values never escape: full-value
 * consumers receive detached copies; selectors receive only frozen scalars.
 * Every hit compares the supplied bytes with a detached exact capture, because
 * readonly candidate wrappers do not make their Uint8Array contents immutable.
 * Fresh native readers may return different arrays containing identical bytes.
 * Those copies share syntax within this same owner, not native observations or
 * authentication. Aliases are not retained and consume no additional entries.
 * Retention is capped by the existing bounded-read inventory; overflow parses
 * normally rather than changing admission. A read-only job may reuse parsing
 * across I/O only while retaining its captured carriers, comparing exact bytes
 * on every access and keeping every fresh context/authentication/native check.
 * That owner must discard this reader after completion/refusal and joined work;
 * parsed syntax never supplies authority or survives into another job.
 */
export function createCreatorCanonicalSyntaxReader() {
	const Bytes = Uint8Array, Floats32 = Float32Array, Floats64 = Float64Array,
		Ints32 = Int32Array, Uints32 = Uint32Array, Sequences = Array, Maps = Map, Sets = Set;
	const isArray = Array.isArray, objectCreate = Object.create, objectPrototype = Object.getPrototypeOf,
		objectKeys = Object.keys, defineProperty = Object.defineProperty;
	const mapForEach = Map.prototype.forEach, mapSet = Map.prototype.set,
		setForEach = Set.prototype.forEach, setAdd = Set.prototype.add;
	// The input to this copier is exclusively the private output of the genuine
	// canonical decoder, not arbitrary caller data. It preserves the decoded
	// domain/prototypes without another string parse or canonical normalization.
	const detach = (value: unknown): unknown => {
		if (value === null || typeof value !== "object") return value;
		if (value instanceof Bytes) return new Bytes(value);
		if (value instanceof Floats32) return new Floats32(value);
		if (value instanceof Floats64) return new Floats64(value);
		if (value instanceof Ints32) return new Ints32(value);
		if (value instanceof Uints32) return new Uints32(value);
		if (isArray(value)) {
			const output = new Sequences<unknown>(value.length);
			for (let index = 0; index < value.length; index++) output[index] = detach(value[index]);
			return output;
		}
		if (value instanceof Maps) {
			const output = new Maps<unknown, unknown>();
			mapForEach.call(value, (item: unknown, key: unknown) => mapSet.call(output, detach(key), detach(item)));
			return output;
		}
		if (value instanceof Sets) {
			const output = new Sets<unknown>();
			setForEach.call(value, (item: unknown) => setAdd.call(output, detach(item)));
			return output;
		}
		const output = objectCreate(objectPrototype(value)) as Record<string, unknown>;
		for (const key of objectKeys(value)) defineProperty(output, key, {
			value: detach((value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true,
		});
		return output;
	};
	const entries = new Maps<Uint8Array, {
		bytes: Uint8Array;
		value: unknown;
		recordChecked: boolean;
		record?: Readonly<Record<string, unknown>>;
	}>();
	let retainedBytes = 0;
	let live = true;
	const maximumEntries = AHE_BOUNDED_READ_LIMITS.maxObjectGenerations * AHE_BOUNDED_READ_LIMITS.maxClosureReferences;
	const read = (bytes: Uint8Array): NonNullable<ReturnType<typeof entries.get>> => {
		if (!live) {
			const captured = new Bytes(bytes);
			return {bytes: captured, value: decodeCanonical(captured), recordChecked: false,
				record: undefined as Readonly<Record<string, unknown>> | undefined};
		}
		const previous = entries.get(bytes);
		if (previous !== undefined && compareBytes(previous.bytes, bytes) === 0) {
			if (!live) return read(bytes);
			// Recency describes syntax use only, never admission or native currency.
			entries.delete(bytes);
			entries.set(bytes, previous);
			return previous;
		}
		if (!live) return read(bytes);
		if (previous !== undefined) {
			entries.delete(bytes);
			retainedBytes -= previous.bytes.byteLength;
		}
		// Native sub-readers detach their buffers. Object identity therefore
		// cannot identify distinct evidence. Reuse only a complete exact-byte
		// match to this owner's private capture; lengths merely select candidates.
		// Do not enroll the new alias: arbitrarily many copies must not enlarge
		// retention, or keep a released acquisition's syntax alive in another job.
		let matching: {key: Uint8Array; entry: typeof previous} | undefined;
		mapForEach.call(entries, (entry: NonNullable<typeof previous>, key: Uint8Array) => {
			if (matching === undefined && entry.bytes.byteLength === bytes.byteLength && compareBytes(entry.bytes, bytes) === 0)
				matching = {key, entry};
		});
		if (!live) return read(bytes);
		if (matching !== undefined) {
			entries.delete(matching.key);
			entries.set(matching.key, matching.entry!);
			return matching.entry!;
		}
		const captured = new Bytes(bytes);
		const entry = { bytes: captured, value: decodeCanonical(captured), recordChecked: false,
			record: undefined as Readonly<Record<string, unknown>> | undefined };
		if (live && maximumEntries > 0 && captured.byteLength <= AHE_BOUNDED_READ_LIMITS.maxUnionBytes) {
			// Decode first. A malformed/oversized newcomer must not evict another
			// successful syntax fact. All data/codec/roundtrip rules remain original;
			// only cold private parse copies leave this unchanged bounded inventory.
			while (entries.size >= maximumEntries || captured.byteLength > AHE_BOUNDED_READ_LIMITS.maxUnionBytes - retainedBytes) {
				const oldest = entries.keys().next().value;
				const cold = oldest === undefined ? undefined : entries.get(oldest);
				if (oldest === undefined || cold === undefined) break;
				entries.delete(oldest);
				retainedBytes -= cold.bytes.byteLength;
			}
			if (entries.size < maximumEntries && captured.byteLength <= AHE_BOUNDED_READ_LIMITS.maxUnionBytes - retainedBytes) {
				entries.set(bytes, entry);
				retainedBytes += captured.byteLength;
			}
		}
		return entry;
	};
	const selectionFields = (record: Readonly<Record<string, unknown>>) => Object.freeze({
		kind: typeof record.kind === "string" ? record.kind : undefined,
		epoch: typeof record.epoch === "number" ? record.epoch : undefined,
		currentEpoch: typeof record.currentEpoch === "number" ? record.currentEpoch : undefined,
		phase: typeof record.phase === "string" ? record.phase : undefined,
		currentAclDigest: typeof record.currentAclDigest === "string" ? record.currentAclDigest : undefined,
	});
	const checkedRecord = (bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined => {
		const entry = read(bytes);
		if (!entry.recordChecked) {
			const value = entry.value;
			entry.record = value !== null && typeof value === "object" && !isArray(value) &&
				compareBytes(encodeCanonical(value), entry.bytes) === 0
				? value as Readonly<Record<string, unknown>> : undefined;
			entry.recordChecked = true;
		}
		return entry.record;
	};
	return Object.freeze({
		release: (): void => { live = false; entries.clear(); retainedBytes = 0; },
		decode: (bytes: Uint8Array): unknown => detach(read(bytes).value),
		// Scalars and an optional detached anchor carrier come from ONE exact
		// read. Never combine metadata from one mutable capture with a later
		// field read, or clone all of its unrelated sibling representations.
		metadata: (bytes: Uint8Array, includeCurrentAnchor = false): Readonly<Record<string, unknown>> | undefined => {
			try {
				const value = read(bytes).value;
				if (value === null || typeof value !== "object" || isArray(value)) return undefined;
				const record = value as Readonly<Record<string, unknown>>;
				const output: Record<string, unknown> = {...selectionFields(record)};
				for (const key of ["objectId", "previousAnchor", "snapshotManifestDigest", "successorAclDigest", "aclDigest",
					"currentAnchorDigest", "genesisAnchorDigest", "profileId", "historyRoot"])
					output[key] = typeof record[key] === "string" ? record[key] : undefined;
				output.historySize = typeof record.historySize === "number" ? record.historySize : undefined;
				if (includeCurrentAnchor) output.exactCanonicalCurrentAnchorPreimageBytes =
					record.exactCanonicalCurrentAnchorPreimageBytes instanceof Bytes ? new Bytes(record.exactCanonicalCurrentAnchorPreimageBytes) : undefined;
				return Object.freeze(output);
			} catch { return undefined; }
		},
		selection: (bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined => {
			try {
				const value = read(bytes).value;
				if (value === null || typeof value !== "object" || isArray(value)) return undefined;
				return selectionFields(value as Readonly<Record<string, unknown>>);
			} catch {
				return undefined;
			}
		},
		// Scalar-only consumers still require the original canonical roundtrip.
		// Reusing its private validation fact avoids cloning the whole candidate;
		// decode-only selection above deliberately retains its different rule.
		canonicalSelection: (bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined => {
			try {
				const record = checkedRecord(bytes);
				return record === undefined ? undefined : selectionFields(record);
			} catch {
				return undefined;
			}
		},
		// The same bounded syntax owner also reads whole snapshots. This avoids
		// throwing away its already canonical-checked payload/manifest merely
		// because a later stage needs their commitments. Only private parsed
		// syntax is reused: every supplied cut/profile binding and content hash
		// below is checked anew, and callers receive detached values. There is
		// deliberately no public parsed-record argument to the fresh validator.
		snapshot: (payloadBytes: Uint8Array, manifestBytes: Uint8Array,
			cut: Readonly<Record<string, unknown>>, profileId?: string): CreatorSnapshotData | undefined => {
			try {
				const validated = validateCreatorSnapshotRecords(payloadBytes,
					checkedRecord(payloadBytes), checkedRecord(manifestBytes), cut, profileId);
				return validated === undefined ? undefined : Object.freeze({
					payload: detach(validated.payload) as Readonly<Record<string, unknown>>,
					manifest: detach(validated.manifest) as Readonly<Record<string, unknown>>,
					successorAclBytes: new Bytes(validated.successorAclBytes),
				});
			} catch {
				return undefined;
			}
		},
		record: (bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined => {
			try {
				const record = checkedRecord(bytes);
				return record === undefined ? undefined : detach(record) as Readonly<Record<string, unknown>>;
			} catch {
				return undefined;
			}
		},
	});
}

/**
 * Domain digest spelling for exact canonical byte bindings.
 * @returns Lowercase domain digest.
 * @param domain - Registered digest domain.
 * @param bytes - Exact canonical carrier bytes.
 */
export function creatorDataDigest(domain: string, bytes: Uint8Array): string {
	return Array.from(hashDomain(domain, bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface CreatorSnapshotData {
	readonly payload: Readonly<Record<string, unknown>>;
	readonly manifest: Readonly<Record<string, unknown>>;
	readonly successorAclBytes: Uint8Array;
}

/**
 * Validates complete registered snapshot bytes and application/ACL commitments.
 * It has no storage or completion access; returned data is operation-local.
 * @param payloadBytes - Complete actual snapshot payload.
 * @param manifestBytes - Canonical manifest already admitted by its owner.
 * @param cut - Authenticated closed cut.
 * @param profileId - Optional authenticated profile for successor ACL opening.
 * @returns Pure validated data, or undefined.
 */
export function validateCreatorSnapshotData(
	payloadBytes: Uint8Array,
	manifestBytes: Uint8Array,
	cut: Readonly<Record<string, unknown>>,
	profileId?: string
): CreatorSnapshotData | undefined {
	try {
		return validateCreatorSnapshotRecords(payloadBytes,
			canonicalCreatorDataRecord(payloadBytes), canonicalCreatorDataRecord(manifestBytes), cut, profileId);
	} catch {
		return undefined;
	}
}

/** The original complete snapshot predicate. Its parsed inputs are supplied
 * only by the fresh public byte validator or the private exact-byte syntax
 * owner above. This helper is not an alternative authority/input boundary. */
function validateCreatorSnapshotRecords(
	payloadBytes: Uint8Array,
	payload: Readonly<Record<string, unknown>> | undefined,
	manifest: Readonly<Record<string, unknown>> | undefined,
	cut: Readonly<Record<string, unknown>>,
	profileId?: string
): CreatorSnapshotData | undefined {
	try {
		const fields = registry.kinds.snapshotPayload.fields;
		if (
			payload === undefined ||
			manifest === undefined ||
			Reflect.ownKeys(payload).length !== fields.length ||
			fields.some(
				(field) => !Object.hasOwn(payload, field.name) || (field.const !== null && payload[field.name] !== field.const)
			) ||
			payload.schemaVersion !== manifest.schemaVersion ||
			!Number.isSafeInteger(payload.schemaVersion) ||
			(payload.schemaVersion as number) < 1 ||
			payload.anchor !== manifest.anchor ||
			payload.anchor !== cut.previousAnchor ||
			payload.objectId !== cut.objectId ||
			payload.objectId !== manifest.objectId ||
			payload.epoch !== cut.epoch ||
			payload.epoch !== manifest.epoch ||
			payload.archiveIndexRoot !== cut.archiveIndexRoot ||
			payload.blueprintDigest !== cut.blueprintDigest ||
			manifest.totalBytes !== payloadBytes.byteLength ||
			manifest.stateDigest !== cut.stateDigest ||
			manifest.aclDigest !== cut.aclDigest ||
			creatorDataDigest("ts-drp/snapshot-payload/v3", payloadBytes) !== manifest.payloadDigest ||
			creatorDataDigest("ts-drp/state/v3", encodeCanonical(payload.application)) !== manifest.stateDigest
		)
			return undefined;
		const successorAclBytes = encodeCanonical(payload.acl);
		if (creatorDataDigest("ts-drp/latched-acl/v3", successorAclBytes) !== manifest.aclDigest) return undefined;
		if (
			profileId !== undefined &&
			!openCanonicalLatchedAclSnapshot({
				exactCanonicalLatchedAclBytes: successorAclBytes,
				expectedAclDigest: String(cut.aclDigest),
				expectedEpoch: Number(cut.epoch) + 1,
				expectedObjectId: String(cut.objectId),
				expectedProfileId: profileId,
			}).ok
		)
			return undefined;
		return Object.freeze({ payload, manifest, successorAclBytes });
	} catch {
		return undefined;
	}
}

/**
 * Resolves trusted local artifact policy against authenticated projection identity.
 * @param catalog - Captured trusted catalog receiver.
 * @param blueprintDigest - Authenticated blueprint identity.
 * @param expected - Exact projection catalog identity.
 * @returns Validated local blueprint bytes or undefined.
 */
export function verifiedCreatorSnapshotCatalog(
	catalog: TrustedBlueprintCatalog,
	blueprintDigest: unknown,
	expected: CreatorSnapshotCatalogIdentity
): ResolvedBlueprintBytes | undefined {
	try {
		if (typeof blueprintDigest !== "string") return undefined;
		const resolved = catalog.resolve(blueprintDigest);
		return resolved.blueprintDigest === blueprintDigest &&
			resolved.blueprintDigest === expected.blueprintDigest &&
			resolved.artifactDigest === creatorDataDigest("ts-drp/blueprint-artifact/v3", resolved.exactArtifactBytes) &&
			resolved.artifactDigest === expected.artifactDigest &&
			resolved.artifactId === expected.artifactId &&
			resolved.runtimeProfile === expected.runtimeProfile &&
			resolved.evidence.catalogDigest === expected.catalogDigest &&
			resolved.evidence.catalogDigest === catalog.catalogDigest
			? resolved
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Captures the compact catalog identity of one canonical projection.
 * @returns Compact identity or undefined.
 * @param projection - Actual canonical projection.
 */
export function creatorSnapshotCatalogIdentity(
	projection: Readonly<Record<string, unknown>>
): CreatorSnapshotCatalogIdentity | undefined {
	const keys = ["artifactDigest", "artifactId", "blueprintDigest", "catalogDigest", "runtimeProfile"] as const;
	if (keys.some((key) => typeof projection[key] !== "string")) return undefined;
	return Object.freeze(
		Object.fromEntries(keys.map((key) => [key, projection[key]]))
	) as unknown as CreatorSnapshotCatalogIdentity;
}

/**
 * Binds the common live publication identity to authenticated anchor policy.
 * @param projection - Unique actual live projection.
 * @param anchor - Genuine authenticated anchor preimage.
 * @param anchorDigest - Genuine trust anchor digest.
 * @returns Whether object, epoch and every latched policy identity agree.
 */
export function creatorSnapshotProjectionAuthorityMatches(
	projection: Readonly<Record<string, unknown>>,
	anchor: Readonly<Record<string, unknown>>,
	anchorDigest: string
): boolean {
	return (
		projection.kind === (anchor.epoch === 0 ? "v3-live-generation-1" : "v3-live-generation-2") &&
		(anchor.epoch === 0 || projection.version === 2) &&
		projection.trustProfile === "creator-only" &&
		projection.anchorDigest === anchorDigest &&
		projection.epoch === anchor.epoch &&
		projection.objectId === anchor.objectId &&
		projection.blueprintDigest === anchor.blueprintDigest &&
		projection.parametersDigest === anchor.parametersDigest &&
		projection.profileDigest === anchor.profileDigest &&
		projection.signerSetDigest === anchor.signerSetDigest
	);
}

/**
 * Checks successor publication commitments shared with cold/pending adoption.
 * @param projection - Actual unique successor projection.
 * @param anchor - Authenticated successor anchor.
 * @param anchorDigest - Genuine trust identity.
 * @param manifestDigest - Authenticated exact manifest identity.
 * @param manifest - Actual decoded manifest.
 * @returns Whether every publication binding matches.
 */
export function creatorSnapshotProjectionMatches(
	projection: Readonly<Record<string, unknown>>,
	anchor: Readonly<Record<string, unknown>>,
	anchorDigest: string,
	manifestDigest: string,
	manifest: Readonly<Record<string, unknown>>
): boolean {
	return (
		!Object.hasOwn(projection, "promotedSnapshotSource") &&
		projection.kind === "v3-live-generation-2" &&
		creatorSnapshotProjectionAuthorityMatches(projection, anchor, anchorDigest) &&
		projection.aclDigest === anchor.aclDigest &&
		projection.historyRoot === anchor.historyRoot &&
		projection.historySize === anchor.historySize &&
		projection.archiveIndexRoot === anchor.archiveIndexRoot &&
		projection.snapshotManifestDigest === manifestDigest &&
		projection.snapshotPayloadDigest === manifest.payloadDigest &&
		projection.stateDigest === manifest.stateDigest
	);
}

/**
 * Explicit selected-base binding, usable only after whole signed-decision verification.
 * @param projection - Actual promoted live projection from the native closure.
 * @param anchor - Authenticated current anchor, including current operational ACL and history.
 * @param anchorDigest - Authenticated current anchor identity.
 * @param source - Source from the complete verified forward-promotion decision.
 * @param manifest - Exact selected historical snapshot manifest.
 * @returns Whether current scope and historical application bytes are both exact.
 */
export function creatorPromotedSnapshotProjectionMatches(
	projection: Readonly<Record<string, unknown>>,
	anchor: Readonly<Record<string, unknown>>,
	anchorDigest: string,
	source: PromotionSource,
	manifest: Readonly<Record<string, unknown>>
): boolean {
	try {
		return (
			creatorSnapshotProjectionAuthorityMatches(projection, anchor, anchorDigest) &&
			projection.aclDigest === anchor.aclDigest &&
			projection.historyRoot === anchor.historyRoot &&
			projection.historySize === anchor.historySize &&
			projection.archiveIndexRoot === anchor.archiveIndexRoot &&
			compareBytes(encodeCanonical(projection.promotedSnapshotSource), encodeCanonical(source)) === 0 &&
			projection.snapshotManifestDigest === source.manifestRef.digest &&
			projection.snapshotPayloadDigest === source.payloadDigest &&
			manifest.payloadDigest === source.payloadDigest &&
			projection.stateDigest === source.stateDigest &&
			manifest.stateDigest === source.stateDigest &&
			anchor.stateDigest === source.stateDigest
		);
	} catch {
		return false;
	}
}

/**
 * Original canonical projection field constructor; byte output grants no adoption custody.
 * @param input - Original captured input facts.
 * @returns Original owner-derived bytes or sizing result; no authority is minted.
 */
export function encodeCreatorSuccessorProjection(
	input: Readonly<{
		currentAnchor: Readonly<Record<string, unknown>>;
		successorAnchor: Readonly<Record<string, unknown>>;
		successorAnchorBytes: Uint8Array;
		successorAnchorDigest: string;
		parameters: Readonly<Record<string, unknown>>;
		history: Pick<CloseSetHistoryCommitment, "historyRoot" | "historySize" | "historySnapshot">;
		catalog: Pick<ResolvedBlueprintBytes, "artifactDigest" | "artifactId" | "evidence" | "runtimeProfile">;
		snapshotManifestDigest: string;
		snapshotPayloadDigest: unknown;
		promotedSource?: PromotionSource;
	}>
): Uint8Array {
	const ordered = encodeCanonical({
		kind: "v3-live-order-1",
		vertexHashes: [input.successorAnchorDigest],
	});
	const graph = encodeCanonical({
		charges: [{ byteCharge: input.successorAnchorBytes.byteLength, hash: input.successorAnchorDigest }],
		kind: "v3-live-graph-1",
		vertices: [
			{
				dependencies: [],
				epoch: Number(input.successorAnchor.epoch),
				hash: input.successorAnchorDigest,
				kind: "drp-epoch-anchor",
				objectId: input.successorAnchor.objectId,
			},
		],
	});
	const orderDigest = digestBlob(ordered);
	const graphDigest = digestBlob(graph);
	if (!orderDigest.ok || !graphDigest.ok) throw new TypeError("creator projection digest failed");
	return encodeCanonical(creatorSuccessorProjectionFields({
		...input, successorAnchorByteLength: input.successorAnchorBytes.byteLength,
		successorEpoch: Number(input.successorAnchor.epoch), graphDigest: graphDigest.value,
		orderedVertexHashesDigest: orderDigest.value,
	}));
}

/** Original projection field schema, shared with scalar resource slots. This
 * does not hash, encode, authenticate or mint an adopted generation/source. */
export function creatorSuccessorProjectionFields(input: Readonly<{
	currentAnchor: Readonly<Record<string, unknown>>; successorAnchor: Readonly<Record<string, unknown>>;
	successorAnchorByteLength: unknown; successorAnchorDigest: unknown; successorEpoch: unknown;
	parameters: Readonly<Record<string, unknown>>;
	history: Readonly<{historyRoot: unknown; historySize: unknown; historySnapshot: unknown}>;
	catalog: Readonly<{artifactDigest: unknown; artifactId: unknown; evidence: Readonly<{catalogDigest: unknown}>;
		runtimeProfile: unknown}>;
	snapshotManifestDigest: unknown; snapshotPayloadDigest: unknown;
	graphDigest: unknown; orderedVertexHashesDigest: unknown; promotedSource?: PromotionSource;
}>): Readonly<Record<string, unknown>> {
	return {
		aclDigest: input.successorAnchor.aclDigest,
		anchorDigest: input.successorAnchorDigest,
		archiveIndexRoot: input.successorAnchor.archiveIndexRoot,
		artifactDigest: input.catalog.artifactDigest,
		artifactId: input.catalog.artifactId,
		blueprintDigest: input.successorAnchor.blueprintDigest,
		byteCharge: input.successorAnchorByteLength,
		catalogDigest: input.catalog.evidence.catalogDigest,
		compactHistory: input.history.historySnapshot,
		epoch: input.successorEpoch,
		graphDigest: input.graphDigest,
		historyRoot: input.history.historyRoot,
		historySize: input.history.historySize,
		kind: "v3-live-generation-2",
		maxDependencies: input.parameters.maxDependencies,
		maxEpochBytes: input.parameters.maxEpochBytes,
		maxEpochVertices: input.parameters.maxEpochVertices,
		objectId: input.successorAnchor.objectId,
		orderedVertexHashesDigest: input.orderedVertexHashesDigest,
		parametersDigest: input.successorAnchor.parametersDigest,
		previousHistoryRoot: input.currentAnchor.historyRoot,
		previousHistorySize: input.currentAnchor.historySize,
		profileDigest: input.successorAnchor.profileDigest,
		runtimeProfile: input.catalog.runtimeProfile,
		signerSetDigest: input.successorAnchor.signerSetDigest,
		snapshotManifestDigest: input.promotedSource?.manifestRef.digest ?? input.snapshotManifestDigest,
		snapshotPayloadDigest: input.snapshotPayloadDigest,
		stateDigest: input.successorAnchor.stateDigest,
		trustProfile: "creator-only",
		vertexCount: 1,
		version: 2,
		...(input.promotedSource === undefined ? {} : { promotedSnapshotSource: input.promotedSource }),
	};
}
