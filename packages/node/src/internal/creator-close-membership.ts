import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { buildMerkleTree, type CloseSetHistoryCommitment } from "@ts-drp/compaction";
import { LIVE_JOURNAL_RETIREMENT_LIMITS, type LiveJournalScope } from "@ts-drp/live-journal";

export const CREATOR_CLOSE_MEMBERSHIP_KIND = "creator-close-membership-1" as const;
export const CREATOR_CLOSE_MEMBERSHIP_MAX_BYTES = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes;
/** The original full-PRE membership schema. Resource slots do not commit a
 * close set, verify original signatures, or authorize journal retirement. */
export function creatorCloseMembershipFields(
	input: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
	return {
		kind: CREATOR_CLOSE_MEMBERSHIP_KIND,
		cutValueDigest: input.cutValueDigest,
		scope: input.scope,
		historyStart: input.historyStart,
		exactCanonicalLatchedAclBytes: input.exactCanonicalLatchedAclBytes,
		orderedVertexDigests: input.orderedVertexDigests,
		localVertexWitnesses: input.localVertexWitnesses,
	};
}
const LIMITS = {
	maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes,
	maxDepth: 32,
	maxItems: 65_536,
};
const KEYS =
	"cutValueDigest,exactCanonicalLatchedAclBytes,historyStart,kind,localVertexWitnesses,orderedVertexDigests,scope";
const SCOPE_KEYS = "anchorDigest,epoch,objectId";
const ACL_KEYS = "epoch,kind,members,objectId,permissionless,version";
const WITNESS_KEYS = "detachedSignature,exactCanonicalPreimageBytes,vertexDigest";
const DIGEST = /^[0-9a-f]{64}$/u;

export interface CreatorCloseLocalVertexWitnessInput {
	readonly vertexDigest: string;
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly detachedSignature: Uint8Array;
}

export type CreatorCloseLocalVertexWitness = CreatorCloseLocalVertexWitnessInput;

export interface CreatorCloseMembership {
	readonly scope: LiveJournalScope;
	readonly cutValueDigest: string;
	readonly historyStart: number;
	/** Original closed source ACL; its signed anchor digest is verified by the caller. */
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	/** Exact close-set order, not native journal ordinal order. */
	readonly orderedVertexDigests: readonly Uint8Array[];
	/** Only locally issued members need this retained original carrier. */
	readonly localVertexWitnesses: readonly CreatorCloseLocalVertexWitness[];
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
		? (value as Record<string, unknown>)
		: undefined;
}

function safe(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedBytes(value: Uint8Array): Uint8Array {
	if (!(value instanceof Uint8Array) || value.byteLength > LIMITS.maxBytes)
		throw new TypeError("creator close membership bytes exceed the native image bound");
	return new Uint8Array(value);
}

function cutFacts(
	bytes: Uint8Array,
	maxEpochVertices: number
):
	| Readonly<{
			scope: LiveJournalScope;
			cutValueDigest: string;
			historyStart: number;
			count: number;
			root: string;
			historyRoot: unknown;
			historySize: number;
	  }>
	| undefined {
	const cut = record(decodeCanonical(bytes, LIMITS));
	const parameters = record(cut?.parameters);
	if (
		cut === undefined ||
		cut.kind !== "drp-hard-epoch-cut" ||
		cut.protocolMajor !== 3 ||
		typeof cut.objectId !== "string" ||
		cut.objectId.length === 0 ||
		cut.objectId.length > 1024 ||
		!safe(cut.epoch) ||
		typeof cut.previousAnchor !== "string" ||
		!DIGEST.test(cut.previousAnchor) ||
		!safe(cut.closeSetCount) ||
		!safe(cut.historySize) ||
		!safe(cut.previousHistorySize) ||
		cut.closeSetCount > cut.historySize ||
		cut.historySize - cut.closeSetCount !== cut.previousHistorySize ||
		!safe(maxEpochVertices) ||
		maxEpochVertices < 1 ||
		parameters?.maxEpochVertices !== maxEpochVertices ||
		cut.closeSetCount >= maxEpochVertices ||
		cut.closeSetCount > Math.floor(LIMITS.maxBytes / 32) ||
		typeof cut.closeSetRoot !== "string" ||
		!DIGEST.test(cut.closeSetRoot) ||
		typeof cut.historyRoot !== "string" ||
		!DIGEST.test(cut.historyRoot) ||
		compareBytes(bytes, encodeCanonical(cut, LIMITS)) !== 0
	)
		return undefined;
	return Object.freeze({
		scope: Object.freeze({
			objectId: cut.objectId,
			epoch: cut.epoch,
			anchorDigest: cut.previousAnchor,
		}),
		cutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", bytes)),
		historyStart: cut.historySize - cut.closeSetCount,
		count: cut.closeSetCount,
		root: cut.closeSetRoot,
		historyRoot: cut.historyRoot,
		historySize: cut.historySize,
	});
}

function historyLeaf(scope: LiveJournalScope, historyStart: number, index: number, digest: string): Uint8Array {
	return encodeCanonical(
		{
			epoch: scope.epoch,
			kind: "drp-history-leaf",
			objectId: scope.objectId,
			ordinal: historyStart + index,
			protocolMajor: 3,
			vertexHash: digest,
		},
		LIMITS
	);
}

function closedAcl(value: unknown, scope: LiveJournalScope): Uint8Array | undefined {
	if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > LIMITS.maxBytes) return undefined;
	const bytes = boundedBytes(value);
	const acl = record(decodeCanonical(bytes, LIMITS));
	if (
		acl === undefined ||
		Object.keys(acl).sort().join(",") !== ACL_KEYS ||
		acl.kind !== "drp-v3-latched-acl" ||
		acl.objectId !== scope.objectId ||
		acl.epoch !== scope.epoch ||
		typeof acl.permissionless !== "boolean" ||
		![1, 2, 3].includes(acl.version as number) ||
		!Array.isArray(acl.members) ||
		compareBytes(bytes, encodeCanonical(acl, LIMITS)) !== 0
	)
		return undefined;
	for (const item of acl.members) {
		const member = record(item);
		if (
			member === undefined ||
			Object.keys(member).sort().join(",") !== "author,finalityKey,groups" ||
			typeof member.author !== "string" ||
			!DIGEST.test(member.author) ||
			!(member.finalityKey === null || (typeof member.finalityKey === "string" && DIGEST.test(member.finalityKey))) ||
			!Array.isArray(member.groups) ||
			member.groups.some(
				(group) => typeof group !== "string" || !["admin", "finality", "referee", "writer"].includes(group)
			)
		)
			return undefined;
	}
	return bytes;
}

function localWitnesses(
	value: unknown,
	scope: LiveJournalScope,
	members: ReadonlySet<string>,
	retainedBytes: number
): readonly CreatorCloseLocalVertexWitness[] | undefined {
	if (!Array.isArray(value) || value.length > members.size) return undefined;
	const seen = new Set<string>(),
		identities = new Set<string>();
	const result: CreatorCloseLocalVertexWitness[] = [];
	let byteCharge = members.size * 32 + retainedBytes;
	if (byteCharge > LIMITS.maxBytes) return undefined;
	for (const item of value) {
		const witness = record(item);
		if (
			witness === undefined ||
			Object.keys(witness).sort().join(",") !== WITNESS_KEYS ||
			typeof witness.vertexDigest !== "string" ||
			!DIGEST.test(witness.vertexDigest) ||
			!(witness.detachedSignature instanceof Uint8Array) ||
			witness.detachedSignature.byteLength !== 64 ||
			!(witness.exactCanonicalPreimageBytes instanceof Uint8Array)
		)
			return undefined;
		const witnessByteCharge = witness.exactCanonicalPreimageBytes.byteLength + 64 + 64;
		if (witnessByteCharge > LIMITS.maxBytes - byteCharge) return undefined;
		byteCharge += witnessByteCharge;
		const preimage = boundedBytes(witness.exactCanonicalPreimageBytes);
		const signature = boundedBytes(witness.detachedSignature);
		const hash = witness.vertexDigest;
		const vertex = record(decodeCanonical(preimage, LIMITS));
		if (
			!members.has(hash) ||
			seen.has(hash) ||
			hex(hashDomain("ts-drp/vertex/v3", preimage)) !== hash ||
			vertex === undefined ||
			compareBytes(preimage, encodeCanonical(vertex, LIMITS)) !== 0 ||
			vertex.kind !== "drp-vertex" ||
			vertex.protocolMajor !== 3 ||
			vertex.objectId !== scope.objectId ||
			vertex.epoch !== scope.epoch ||
			vertex.anchor !== scope.anchorDigest ||
			typeof vertex.author !== "string" ||
			vertex.author.length === 0 ||
			vertex.author.length > 1024 ||
			!safe(vertex.authorSequence)
		)
			return undefined;
		const identity = JSON.stringify([vertex.author, vertex.authorSequence]);
		if (identities.has(identity)) return undefined;
		seen.add(hash);
		identities.add(identity);
		result.push(
			Object.freeze({
				vertexDigest: hash,
				exactCanonicalPreimageBytes: preimage,
				detachedSignature: signature,
			})
		);
	}
	return Object.freeze(result);
}

/**
 * Opens native membership material against the caller's independently authenticated
 * Cut and its signed epoch capacity. It verifies exact membership bytes, not Cut/QC
 * signatures, original vertex signatures, dependency availability or deletion law.
 */
export async function openCreatorCloseMembership(
	input: Readonly<{
		bytes: Uint8Array;
		exactCanonicalCutValueBytes: Uint8Array;
		maxEpochVertices: number;
	}>
): Promise<CreatorCloseMembership | undefined> {
	try {
		const bytes = boundedBytes(input.bytes);
		const cutBytes = boundedBytes(input.exactCanonicalCutValueBytes);
		const cut = cutFacts(cutBytes, input.maxEpochVertices);
		const carrier = record(decodeCanonical(bytes, LIMITS));
		const scope = record(carrier?.scope);
		const packed = carrier?.orderedVertexDigests;
		if (
			cut === undefined ||
			carrier === undefined ||
			Object.keys(carrier).sort().join(",") !== KEYS ||
			carrier.kind !== CREATOR_CLOSE_MEMBERSHIP_KIND ||
			carrier.cutValueDigest !== cut.cutValueDigest ||
			carrier.historyStart !== cut.historyStart ||
			scope === undefined ||
			Object.keys(scope).sort().join(",") !== SCOPE_KEYS ||
			scope.objectId !== cut.scope.objectId ||
			scope.epoch !== cut.scope.epoch ||
			scope.anchorDigest !== cut.scope.anchorDigest ||
			!(packed instanceof Uint8Array) ||
			packed.byteLength !== cut.count * 32 ||
			compareBytes(bytes, encodeCanonical(carrier, LIMITS)) !== 0
		)
			return undefined;
		const digests: Uint8Array[] = [];
		const leaves: Uint8Array[] = [];
		const seen = new Set<string>();
		for (let index = 0; index < cut.count; index++) {
			const digest = packed.slice(index * 32, (index + 1) * 32);
			const hash = hex(digest);
			if (seen.has(hash)) return undefined;
			seen.add(hash);
			digests.push(digest);
			leaves.push(historyLeaf(cut.scope, cut.historyStart, index, hash));
		}
		const aclBytes = closedAcl(carrier.exactCanonicalLatchedAclBytes, cut.scope);
		if (aclBytes === undefined) return undefined;
		const witnesses = localWitnesses(carrier.localVertexWitnesses, cut.scope, seen, aclBytes.byteLength);
		if (witnesses === undefined) return undefined;
		if (hex((await buildMerkleTree(leaves)).root) !== cut.root) return undefined;
		return Object.freeze({
			scope: cut.scope,
			cutValueDigest: cut.cutValueDigest,
			historyStart: cut.historyStart,
			exactCanonicalLatchedAclBytes: aclBytes,
			orderedVertexDigests: Object.freeze(digests),
			localVertexWitnesses: witnesses,
		});
	} catch {
		return undefined;
	}
}

/**
 * Rebinds a verified digest list to the receiving owner's original local rows.
 * Transport uses no witnesses; a receiver supplies only its own signed member
 * rows. The signed Cut authenticates the list even when other members were never
 * delivered. Neither the list nor these witnesses confer a deletion capability.
 */
export async function rewriteCreatorCloseMembershipWitnesses(
	input: Readonly<{
		bytes: Uint8Array;
		exactCanonicalCutValueBytes: Uint8Array;
		maxEpochVertices: number;
		localVertexWitnesses: readonly CreatorCloseLocalVertexWitnessInput[];
	}>
): Promise<Uint8Array> {
	const membership = await openCreatorCloseMembership(input);
	if (membership === undefined) throw new TypeError("creator membership differs from authenticated Cut");
	const packed = new Uint8Array(membership.orderedVertexDigests.length * 32);
	for (const [index, digest] of membership.orderedVertexDigests.entries()) packed.set(digest, index * 32);
	const witnesses = localWitnesses(
		input.localVertexWitnesses,
		membership.scope,
		new Set(membership.orderedVertexDigests.map(hex)),
		membership.exactCanonicalLatchedAclBytes.byteLength
	);
	if (witnesses === undefined) throw new TypeError("creator received local witness differs from membership");
	return encodeCanonical(
		creatorCloseMembershipFields({
			cutValueDigest: membership.cutValueDigest,
			scope: membership.scope,
			historyStart: membership.historyStart,
			exactCanonicalLatchedAclBytes: membership.exactCanonicalLatchedAclBytes,
			orderedVertexDigests: packed,
			localVertexWitnesses: witnesses,
		}),
		LIMITS
	);
}

/**
 * Captures the genuine close owner's complete ordered commitment before original
 * issuance preimages disappear. The output is bounded native lifecycle material,
 * not portable authority, an AHE closure extension or a deletion capability.
 */
export async function encodeCreatorCloseMembership(
	input: Readonly<{
		exactCanonicalCutValueBytes: Uint8Array;
		commitment: CloseSetHistoryCommitment;
		maxEpochVertices: number;
		exactCanonicalLatchedAclBytes: Uint8Array;
		/** Freshly verified original close replay; no re-signing or target-context transfer. */
		localVertexWitnesses: readonly CreatorCloseLocalVertexWitnessInput[];
	}>
): Promise<Uint8Array> {
	const cutBytes = boundedBytes(input.exactCanonicalCutValueBytes);
	const cut = cutFacts(cutBytes, input.maxEpochVertices);
	// The new carrier takes an own data property, never accessor-supplied ACL authority.
	const aclProperty = Object.getOwnPropertyDescriptor(input, "exactCanonicalLatchedAclBytes");
	if (aclProperty === undefined || !("value" in aclProperty) || aclProperty.enumerable !== true || cut === undefined)
		throw new TypeError("creator close original ACL must be an own data property");
	const aclBytes = closedAcl(aclProperty.value, cut.scope);
	if (aclBytes === undefined) throw new TypeError("creator close original ACL differs from source context");
	const commitment = input.commitment;
	if (
		cut === undefined ||
		commitment.anchorHash !== cut.scope.anchorDigest ||
		commitment.closeSetCount !== cut.count ||
		commitment.closeSetRoot !== cut.root ||
		commitment.historySize !== cut.historySize ||
		commitment.historyRoot !== cut.historyRoot ||
		!Array.isArray(commitment.closeSetEntries) ||
		commitment.closeSetEntries.length !== cut.count ||
		!Array.isArray(commitment.closeSetOrder) ||
		commitment.closeSetOrder.length !== cut.count
	)
		throw new TypeError("creator close membership commitment differs from the authenticated Cut");
	const packed = new Uint8Array(cut.count * 32);
	for (let index = 0; index < cut.count; index++) {
		const entry = commitment.closeSetEntries[index]!;
		const digest = commitment.closeSetOrder[index]!;
		if (
			typeof digest !== "string" ||
			!DIGEST.test(digest) ||
			entry.vertexHash !== digest ||
			entry.ordinal !== cut.historyStart + index ||
			!(entry.exactCanonicalHistoryLeafBytes instanceof Uint8Array) ||
			compareBytes(entry.exactCanonicalHistoryLeafBytes, historyLeaf(cut.scope, cut.historyStart, index, digest)) !== 0
		)
			throw new TypeError("creator close membership entry differs from its original history leaf");
		for (let byte = 0; byte < 32; byte++)
			packed[index * 32 + byte] = Number.parseInt(digest.slice(byte * 2, byte * 2 + 2), 16);
	}
	const witnesses = localWitnesses(
		input.localVertexWitnesses,
		cut.scope,
		new Set(commitment.closeSetOrder),
		aclBytes.byteLength
	);
	if (witnesses === undefined) throw new TypeError("creator close local witness differs from original membership");
	const bytes = encodeCanonical(
		creatorCloseMembershipFields({
			cutValueDigest: cut.cutValueDigest,
			scope: cut.scope,
			historyStart: cut.historyStart,
			exactCanonicalLatchedAclBytes: aclBytes,
			orderedVertexDigests: packed,
			localVertexWitnesses: witnesses.map(({ vertexDigest, exactCanonicalPreimageBytes, detachedSignature }) => ({
				vertexDigest,
				exactCanonicalPreimageBytes,
				detachedSignature,
			})),
		}),
		LIMITS
	);
	if (
		(await openCreatorCloseMembership({
			bytes,
			exactCanonicalCutValueBytes: cutBytes,
			maxEpochVertices: input.maxEpochVertices,
		})) === undefined
	)
		throw new TypeError("creator close membership root differs from the authenticated Cut");
	return bytes;
}
