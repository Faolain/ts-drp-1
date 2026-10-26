import { decodeCanonical } from "@ts-drp/canonical";

import { IssuanceVerifiedOnceBytes } from "./verified-once.js";

/** The scalar fields that durable issuance reads from a decoded preimage record. */
export interface DurablePreimageHeader {
	readonly kind: unknown;
	readonly protocolMajor: unknown;
	readonly epoch: unknown;
	readonly authorSequence: unknown;
	readonly author: unknown;
	readonly objectId: unknown;
}

// A decoded field that is not a primitive. Fresh decoded objects never equal any
// caller value, and neither does this module-private stand-in.
const OPAQUE_PREIMAGE_FIELD: unknown = Object.freeze({});
// Verify-once by exact preimage bytes (see verified-once.ts): every durable read
// re-checks the same immutable preimages, and only these scalars are ever read.
const preimageHeaders = new IssuanceVerifiedOnceBytes<DurablePreimageHeader>({ maxEntries: 1024, maxBytes: 4 * 1024 * 1024 });

/**
 * Decodes a canonical preimage once per exact bytes and projects its scalar header.
 * A non-record or undecodable preimage throws on every read and is never memoized.
 * @param canonicalPreimageBytes - Candidate canonical preimage bytes.
 * @returns The frozen header shared by every byte-identical preimage.
 */
export function durablePreimageHeader(canonicalPreimageBytes: Uint8Array): DurablePreimageHeader {
	return preimageHeaders.verify(canonicalPreimageBytes, () => {
		const decoded: unknown = decodeCanonical(canonicalPreimageBytes);
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
			throw new TypeError("durable preimage is not a record");
		const record = decoded as Record<string, unknown>;
		const scalar = (value: unknown): unknown => (value !== null && typeof value === "object" ? OPAQUE_PREIMAGE_FIELD : value);
		return Object.freeze({
			kind: scalar(record.kind),
			protocolMajor: scalar(record.protocolMajor),
			epoch: scalar(record.epoch),
			authorSequence: scalar(record.authorSequence),
			author: scalar(record.author),
			objectId: scalar(record.objectId),
		});
	});
}
