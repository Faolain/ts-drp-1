import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import type { GenuineCreatorAdoptionFixture } from "./creator-adoption-contract.js";

export interface D108d1Oracle {
	readonly aclDigest: string;
	readonly anchorDigest: string;
	readonly epoch: 1;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly parametersDigest: string;
	readonly snapshotPayloadDigest: string;
	readonly stableTopic: string;
	readonly stateDigest: string;
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(bytes);
	if (
		decoded === null ||
		typeof decoded !== "object" ||
		Array.isArray(decoded) ||
		!Buffer.from(encodeCanonical(decoded)).equals(bytes)
	) {
		throw new TypeError("D.108d1 oracle carrier is not exact canonical bytes");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

function candidateBytes(
	fixture: GenuineCreatorAdoptionFixture,
	ref: Readonly<{ readonly byteLength: number; readonly digest: string }>
): Uint8Array {
	const candidates = fixture.evidence.proposed.candidates.filter(
		(candidate) => candidate.ref.digest === ref.digest && candidate.ref.byteLength === ref.byteLength
	);
	if (candidates.length !== 1) throw new TypeError("D.108d1 oracle candidate is unavailable");
	return Uint8Array.from(candidates[0]?.bytes as Uint8Array);
}

/**
 * Derives successor identity without trusting an activation result or caller DTO.
 * @param fixture - Genuine certified close evidence.
 * @returns Exact successor identity and stable topic.
 */
export function deriveD108d1Oracle(fixture: GenuineCreatorAdoptionFixture): D108d1Oracle {
	const successorTrust = canonicalRecord(candidateBytes(fixture, fixture.evidence.closeResult.successorTrustRef));
	if (!(successorTrust.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array)) {
		throw new TypeError("D.108d1 successor anchor bytes are unavailable");
	}
	const anchorBytes = Uint8Array.from(successorTrust.exactCanonicalCurrentAnchorPreimageBytes);
	const anchor = canonicalRecord(anchorBytes);
	const projection = canonicalRecord(fixture.evidence.exactCanonicalProjectionBytes);
	const manifest = canonicalRecord(fixture.evidence.declaration.exactCanonicalManifestBytes);
	const payload = canonicalRecord(fixture.evidence.exactCanonicalPayloadBytes);
	const anchorDigest = lowerHex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
	const payloadDigest = lowerHex(hashDomain("ts-drp/snapshot-payload/v3", fixture.evidence.exactCanonicalPayloadBytes));
	const objectId = String(anchor.objectId);
	const predecessorGenesisAnchorDigest = fixture.evidence.currentTrust.genesisAnchorDigest;
	const successorGenesisAnchorDigest = successorTrust.genesisAnchorDigest;
	if (
		typeof successorGenesisAnchorDigest !== "string" ||
		successorGenesisAnchorDigest !== predecessorGenesisAnchorDigest
	) {
		throw new TypeError("D.108d1 successor genesis identity diverged");
	}
	const genesisAnchorDigest = successorGenesisAnchorDigest;
	const stableTopicDigest = lowerHex(
		hashDomain(
			"ts-drp/live-topic/v3",
			new TextEncoder().encode(objectId),
			new TextEncoder().encode(genesisAnchorDigest)
		)
	);
	if (
		anchor.epoch !== 1 ||
		projection.kind !== "v3-live-generation-2" ||
		projection.version !== 2 ||
		projection.epoch !== 1 ||
		projection.anchorDigest !== anchorDigest ||
		projection.objectId !== objectId ||
		projection.parametersDigest !== anchor.parametersDigest ||
		projection.snapshotPayloadDigest !== payloadDigest ||
		manifest.payloadDigest !== payloadDigest ||
		payload.objectId !== objectId ||
		payload.epoch !== 0 ||
		payload.anchor !== fixture.evidence.currentTrust.currentAnchorDigest
	) {
		throw new TypeError("D.108d1 successor cross-carrier identity failed");
	}
	return Object.freeze({
		aclDigest: String(anchor.aclDigest),
		anchorDigest,
		epoch: 1 as const,
		genesisAnchorDigest,
		objectId,
		parametersDigest: String(anchor.parametersDigest),
		snapshotPayloadDigest: payloadDigest,
		stableTopic: `drp/v3/1/${stableTopicDigest}`,
		stateDigest: String(anchor.stateDigest),
	});
}
