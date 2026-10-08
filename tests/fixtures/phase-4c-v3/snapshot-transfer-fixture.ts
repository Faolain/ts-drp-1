import type { SnapshotQuarantineFixture } from "./snapshot-quarantine-contract.js";
import type { SnapshotQuarantineDeclaration } from "./snapshot-quarantine-types.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "../../../packages/canonical/src/index.js";

export interface SnapshotExportFixture {
	readonly applicationStateDigest: string;
	readonly exactCanonicalPayloadBytes: Uint8Array;
	readonly payloadDigest: string;
}

function lowerHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function digest(domain: string, ...parts: readonly Uint8Array[]): string {
	return lowerHex(hashDomain(domain, ...parts));
}

/**
 * Decodes one exact canonical snapshot record for an independent test oracle.
 * @param exactCanonicalBytes - Exact canonical record bytes.
 * @returns Decoded closed-record candidate.
 */
export function exactSnapshotRecord(exactCanonicalBytes: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(new Uint8Array(exactCanonicalBytes));
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("snapshot fixture record is invalid");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

/**
 * Builds the frozen manifest/chunk projection from one genuine D.99 export.
 * @param exported - Genuine closed snapshot export.
 * @returns Detached canonical manifest, descriptors and chunk bodies.
 */
export function createSnapshotTransferFixture(exported: SnapshotExportFixture): SnapshotQuarantineFixture {
	const payload = exactSnapshotRecord(exported.exactCanonicalPayloadBytes);
	const aclBytes = encodeCanonical(payload.acl);
	const chunks = Object.freeze(
		Array.from(
			{ length: Math.ceil(exported.exactCanonicalPayloadBytes.byteLength / 131_072) },
			(_, index) => new Uint8Array(exported.exactCanonicalPayloadBytes.slice(index * 131_072, (index + 1) * 131_072))
		)
	);
	const descriptors = Object.freeze(
		chunks.map((chunk, index) =>
			Object.freeze({
				byteLength: chunk.byteLength,
				digest: digest("ts-drp/snapshot-chunk/v3", encodeCanonical(index), chunk),
				index,
			})
		)
	);
	if (
		typeof payload.anchor !== "string" ||
		typeof payload.epoch !== "number" ||
		typeof payload.objectId !== "string" ||
		typeof payload.schemaVersion !== "number"
	) {
		throw new TypeError("snapshot payload metadata is invalid");
	}
	const manifest = Object.freeze({
		aclDigest: digest("ts-drp/latched-acl/v3", aclBytes),
		anchor: payload.anchor,
		chunks: descriptors,
		encodingVersion: "drp-canonical-profile-1",
		epoch: payload.epoch,
		kind: "drp-snapshot-manifest",
		objectId: payload.objectId,
		payloadDigest: exported.payloadDigest,
		protocolMajor: 3,
		schemaVersion: payload.schemaVersion,
		stateDigest: exported.applicationStateDigest,
		totalBytes: exported.exactCanonicalPayloadBytes.byteLength,
	});
	const exactCanonicalManifestBytes = encodeCanonical(manifest);
	const scope = Object.freeze({
		anchor: payload.anchor,
		epoch: payload.epoch,
		manifestDigest: digest("ts-drp/snapshot-manifest/v3", exactCanonicalManifestBytes),
		objectId: payload.objectId,
	});
	const declaration: SnapshotQuarantineDeclaration = Object.freeze({
		chunks: descriptors,
		exactCanonicalManifestBytes,
		scope,
		totalBytes: exported.exactCanonicalPayloadBytes.byteLength,
	});
	return Object.freeze({ chunks, declaration });
}
