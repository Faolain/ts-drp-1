import { decodeCanonical, encodeCanonical, hashDomain } from "../../../packages/canonical/dist/src/index.js";
import archived from "../phase-3a1b-p4/material.json" with { type: "json" };

export interface AnchorMaterial {
	readonly scope: { readonly objectId: string; readonly epoch: number; readonly anchorDigest: string };
	readonly bytes: Uint8Array;
	readonly install: {
		readonly objectId: string;
		readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
		readonly detachedAnchorSignature: Uint8Array;
		readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	};
}

function fromHex(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
}

/**
 * Makes exact existing canonical fixture carriers; signatures are storage fixtures, not external authority.
 * @param epoch - Installed scope epoch.
 * @param changes - Canonical field mutations for integrity controls.
 * @returns Exact storage-admitted fixture material, without external trust claims.
 */
export function anchorMaterial(epoch = 0, changes: Readonly<Record<string, unknown>> = {}): AnchorMaterial {
	const genesis = fromHex(archived.anchorHex);
	const fields = decodeCanonical(genesis) as Record<string, unknown>;
	const bytes =
		epoch === 0 && Object.keys(changes).length === 0 ? genesis : encodeCanonical({ ...fields, epoch, ...changes });
	const anchorDigest = Array.from(hashDomain("ts-drp/epoch-anchor/v3", bytes), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	return {
		bytes,
		install: {
			detachedAnchorSignature: fromHex(archived.signatureHex),
			exactCanonicalAnchorPreimageBytes: bytes,
			exactCanonicalParametersCarrierBytes: fromHex(archived.parametersHex),
			objectId: archived.objectId,
		},
		scope: { anchorDigest, epoch, objectId: archived.objectId },
	};
}

export const ANCHOR_CASES = [
	"genesis",
	"non-genesis",
	"neighbor-missing",
	"smaller-budget",
	"zero",
	"invalid-input",
	"oversize",
	"empty",
	"non-byte",
	"hash",
	"scope",
	"noncanonical",
	"unrelated-carriers",
	"capture",
	"close",
	"capture-close",
	"poison-close",
	"executing-close",
	"independent-session",
	"native-failure",
	"replace-delete",
] as const;
export type AnchorCase = (typeof ANCHOR_CASES)[number];

export interface JournalProbe {
	readAnchorPreimage(input: unknown): Promise<unknown>;
	close(): Promise<void>;
}

/**
 * Wiring failure is recorded, never replaced with a synthetic implementation.
 * @param store - The actual existing native owner.
 * @param input - The call record supplied unchanged to the required method.
 * @returns Actual product result, or the explicit absent-API wiring marker.
 */
export function readAnchor(store: unknown, input: unknown): Promise<unknown> {
	const owner = store as JournalProbe;
	if (typeof owner.readAnchorPreimage !== "function") return Promise.resolve({ wiring: "missing-readAnchorPreimage" });
	return owner.readAnchorPreimage(input);
}

/**
 * Captures an actual native return exactly once, before any intentional returned-byte mutation.
 * This is not idempotent: a transport wrapper's freezing is not the native record's observation.
 * Serializes only returned anchor bytes, without claiming typed-array deep freezing.
 * @param result - Actual returned record.
 * @returns A transport-safe view with explicit record/scope freezing observations.
 */
export function summarize(result: unknown): unknown {
	if (typeof result !== "object" || result === null) return result;
	const record = result as Record<string, unknown>;
	return record.kind === "present"
		? {
				...record,
				exactCanonicalAnchorPreimageBytes: Array.from(record.exactCanonicalAnchorPreimageBytes as Uint8Array),
				frozen: Object.isFrozen(record),
				scopeFrozen: Object.isFrozen(record.scope),
			}
		: result;
}
