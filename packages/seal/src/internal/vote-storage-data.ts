import { decodeCanonical, hashDomain } from "@ts-drp/canonical";

export interface StoredSealCarrier {
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly signature: Uint8Array;
}

export interface PendingVoteRow {
	readonly carrier: StoredSealCarrier;
	readonly epoch: number;
	readonly objectId: string;
	readonly phase: "commit" | "prepare" | "round-change";
	readonly round: number;
	readonly signerId: string;
	readonly dispatched: boolean;
}

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get as (
	this: ArrayBuffer
) => number;

const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get as
	| ((this: ArrayBuffer) => boolean)
	| undefined;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;

const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get as (
	this: Uint8Array
) => ArrayBufferLike;

const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get as (
	this: Uint8Array
) => number;

const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get as (
	this: Uint8Array
) => number;

/**
 *
 * @param value
 * @param expectedLength
 * @param maximumLength
 */
function exactBytes(value: unknown, expectedLength?: number, maximumLength = 65_536): Uint8Array {
	try {
		if (Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new TypeError("invalid byte carrier");
		const bytes = value as Uint8Array;
		const length = Reflect.apply(typedArrayByteLength, bytes, []) as number;
		if (length > maximumLength || (expectedLength !== undefined && length !== expectedLength)) {
			throw new TypeError("invalid byte length");
		}
		if ((Reflect.apply(typedArrayByteOffset, bytes, []) as number) !== 0) throw new TypeError("invalid byte offset");
		const buffer = Reflect.apply(typedArrayBuffer, bytes, []) as ArrayBufferLike;
		if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) throw new TypeError("invalid backing buffer");
		if ((Reflect.apply(arrayBufferByteLength, buffer, []) as number) !== length)
			throw new TypeError("invalid buffer length");
		if (arrayBufferResizable !== undefined && (Reflect.apply(arrayBufferResizable, buffer, []) as boolean)) {
			throw new TypeError("resizable buffer is unsupported");
		}
		return Uint8Array.from(bytes);
	} catch {
		throw new TypeError("invalid exact byte carrier");
	}
}

/**
 *
 * @param value
 */
function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

/**
 *
 * @param value
 */
function safeNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 *
 * @param value
 */
function copiedCarrier(value: unknown): StoredSealCarrier | undefined {
	if (!plainRecord(value)) return undefined;
	try {
		return Object.freeze({
			exactCanonicalPreimageBytes: exactBytes(value.exactCanonicalPreimageBytes),
			signature: exactBytes(value.signature, 64, 64),
		});
	} catch {
		return undefined;
	}
}

/**
 *
 * @param input
 * @param input.epoch
 * @param input.objectId
 * @param input.round
 * @param input.phase
 * @param input.signerId
 */
function voteKey(input: {
	readonly epoch: number;
	readonly objectId: string;
	readonly round: number;
	readonly phase: "commit" | "prepare" | "round-change";
	readonly signerId: string;
}): [string, number, number, "commit" | "prepare" | "round-change", string] {
	return [input.objectId, input.epoch, input.round, input.phase, input.signerId];
}

/**
 *
 * @param value
 */
function copiedPendingRow(value: unknown): PendingVoteRow | undefined {
	if (!plainRecord(value)) return undefined;
	const carrier = copiedCarrier(value.carrier);
	if (
		carrier === undefined ||
		typeof value.objectId !== "string" ||
		!safeNonnegative(value.epoch) ||
		!safeNonnegative(value.round) ||
		(value.phase !== "prepare" && value.phase !== "commit" && value.phase !== "round-change") ||
		typeof value.signerId !== "string" ||
		typeof value.dispatched !== "boolean"
	) {
		return undefined;
	}
	return Object.freeze({
		carrier,
		dispatched: value.dispatched,
		epoch: value.epoch,
		objectId: value.objectId,
		phase: value.phase,
		round: value.round,
		signerId: value.signerId,
	});
}

/** Exact receipt matching, not QC authentication. The voter must first verify
 * and successfully commit this QC under its genuine enrolled authority. A QC
 * containing the exact local carrier proves delivery to its quorum/collector
 * (including the local q=1 collector), not delivery to every room recipient.
 * Native owners use this only inside that SAME successful QC transaction. */
export function storedSealQcContainsVote(qc: unknown, value: unknown): boolean {
	try {
		const row = copiedPendingRow(value);
		if (row === undefined || row.phase === "round-change" || !plainRecord(qc) ||
			qc.kind !== "drp-seal-qc" || qc.objectId !== row.objectId || qc.epoch !== row.epoch ||
			qc.round !== row.round || qc.phase !== row.phase || !Array.isArray(qc.votes)) return false;
		const vote = decodeCanonical(row.carrier.exactCanonicalPreimageBytes);
		if (!plainRecord(vote) || vote.kind !== "drp-seal-vote" || vote.objectId !== row.objectId ||
			vote.epoch !== row.epoch || vote.round !== row.round || vote.phase !== row.phase || vote.signerId !== row.signerId ||
			vote.proposalHash !== qc.proposalHash || vote.proposalDigest !== qc.proposalDigest) return false;
		const matches = qc.votes.filter(member => plainRecord(member) && member.signerId === row.signerId);
		const member = matches[0];
		const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
		return matches.length === 1 && member !== undefined &&
			member.voteDigest === hex(hashDomain("ts-drp/seal-vote/v3", row.carrier.exactCanonicalPreimageBytes)) &&
			member.signature === hex(row.carrier.signature);
	} catch { return false; }
}
export {
	exactBytes as storedSealExactBytes,
	plainRecord as storedSealPlainRecord,
	safeNonnegative as storedSealSafeNonnegative,
	copiedCarrier as copyStoredSealCarrier,
	voteKey as storedSealVoteKey,
	copiedPendingRow as copyStoredPendingVoteRow,
};
