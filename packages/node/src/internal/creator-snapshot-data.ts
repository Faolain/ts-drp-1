import type { ResolvedBlueprintBytes, TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import registry from "@ts-drp/protocol-v3/registry/registry-v1.json" with { type: "json" };

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
export function canonicalCreatorDataRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined {
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

/**
 * Domain digest spelling for exact canonical byte bindings.
 * @returns Lowercase domain digest.
 * @param domain - Registered digest domain.
 * @param bytes - Exact canonical carrier bytes.
 */
export function creatorDataDigest(domain: string, bytes: Uint8Array): string {
	return Array.from(hashDomain(domain, bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
):
	| Readonly<{
			payload: Readonly<Record<string, unknown>>;
			manifest: Readonly<Record<string, unknown>>;
			successorAclBytes: Uint8Array;
	  }>
	| undefined {
	try {
		const payload = canonicalCreatorDataRecord(payloadBytes);
		const manifest = canonicalCreatorDataRecord(manifestBytes);
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
