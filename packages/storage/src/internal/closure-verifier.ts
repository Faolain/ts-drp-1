import { decodeGenerationRecordV1, encodeGenerationRecordV1 } from "../codecs.js";
import type { GenerationRecord, GenerationRef, StorageRejectionReason, StoreResult } from "../types.js";
import { digestBlob } from "../values.js";

type Mode = "adopted" | "candidate";
type Failure = Extract<
	StorageRejectionReason,
	| "ADOPTED_BLOB_CORRUPT"
	| "ADOPTED_BLOB_MISSING"
	| "ADOPTED_BLOB_UNPROMOTED"
	| "BLOB_CORRUPT"
	| "BLOB_MISSING"
	| "BLOB_UNPROMOTED"
>;
export type Session = Readonly<Record<never, never>>;
export type Authorization = Readonly<Record<never, never>>;
export type Request = Readonly<{ kind: "blob" | "promotion"; reference: GenerationRef }>;
type State = {
	generation: GenerationRecord;
	encoded: Uint8Array;
	mode: Mode;
	index: number;
	phase: "blob" | "complete" | "failed" | "promotion";
	failure?: Failure;
};
const sessions = new WeakMap<object, State>();
const authorizations = new WeakMap<object, Readonly<{ encoded: Uint8Array; mode: Mode }>>();
const handle = (): Readonly<Record<never, never>> => Object.freeze(Object.create(null) as Record<never, never>);
function state(session: Session): State {
	const value = sessions.get(session);
	if (value === undefined) throw new TypeError("unknown closure verification session");
	return value;
}
function mapped(mode: Mode, problem: "corrupt" | "missing" | "unpromoted"): Failure {
	if (mode === "candidate")
		return problem === "unpromoted" ? "BLOB_UNPROMOTED" : problem === "missing" ? "BLOB_MISSING" : "BLOB_CORRUPT";
	return problem === "unpromoted"
		? "ADOPTED_BLOB_UNPROMOTED"
		: problem === "missing"
			? "ADOPTED_BLOB_MISSING"
			: "ADOPTED_BLOB_CORRUPT";
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false;
	return true;
}

/**
 * Starts a detached closure-verification session.
 * @param generation - Canonical generation value to bind.
 * @param mode - Candidate or adopted failure taxonomy.
 * @returns An opaque session handle.
 */
export function start(generation: GenerationRecord, mode: Mode): Session {
	const encoded = encodeGenerationRecordV1(generation);
	const decoded = decodeGenerationRecordV1(new Uint8Array(encoded));
	if (!decoded.ok) throw new TypeError("invalid canonical generation");
	const session = handle();
	sessions.set(session, {
		generation: decoded.value,
		encoded,
		mode,
		index: 0,
		phase: decoded.value.closure.length === 0 ? "complete" : "promotion",
	});
	return session;
}
/**
 * Reads the next authoritative verification request.
 * @param session - Opaque session handle.
 * @returns A frozen request, or null when verification has ended.
 */
export function next(session: Session): Request | null {
	const value = state(session);
	if (value.phase === "complete" || value.phase === "failed") return null;
	const reference = value.generation.closure[value.index];
	if (reference === undefined) throw new Error("closure verifier index escaped closure");
	return Object.freeze({ kind: value.phase, reference: Object.freeze({ ...reference }) });
}
/**
 * Supplies promotion evidence for the current request.
 * @param session - Opaque session handle.
 * @param present - Whether the exact promotion row exists.
 */
export function acceptPromotion(session: Session, present: boolean): void {
	const value = state(session);
	if (value.phase !== "promotion") throw new TypeError("out-of-order promotion");
	if (!present) {
		value.failure = mapped(value.mode, "unpromoted");
		value.phase = "failed";
	} else value.phase = "blob";
}
/**
 * Supplies blob bytes for the current request.
 * @param session - Opaque session handle.
 * @param blob - Exact persisted bytes, or absence.
 */
export function acceptBlob(session: Session, blob: unknown): void {
	const value = state(session);
	if (value.phase !== "blob") throw new TypeError("out-of-order blob");
	const reference = value.generation.closure[value.index];
	if (reference === undefined) throw new Error("closure verifier index escaped closure");
	if (blob === null || blob === undefined) {
		value.failure = mapped(value.mode, "missing");
		value.phase = "failed";
		return;
	}
	if (!(blob instanceof Uint8Array) || blob.byteLength !== reference.byteLength) {
		value.failure = mapped(value.mode, "corrupt");
		value.phase = "failed";
		return;
	}
	const digest = digestBlob(blob);
	if (!digest.ok || digest.value !== reference.digest) {
		value.failure = mapped(value.mode, "corrupt");
		value.phase = "failed";
		return;
	}
	value.index++;
	value.phase = value.index === value.generation.closure.length ? "complete" : "promotion";
}
/**
 * Finishes verification after all requests have been supplied.
 * @param session - Opaque session handle.
 * @returns An opaque authorization or the stable closure failure.
 */
export function finish(session: Session): StoreResult<Authorization> {
	const value = state(session);
	if (value.phase === "failed") return { ok: false, reason: value.failure as Failure };
	if (value.phase !== "complete") return { ok: false, reason: "INVALID_ARGUMENT" };
	const authorization = handle();
	authorizations.set(authorization, { encoded: new Uint8Array(value.encoded), mode: value.mode });
	return { ok: true, value: authorization };
}
/**
 * Checks that an authorization binds the complete canonical record and mode.
 * @param authorization - Candidate opaque authorization.
 * @param generation - Canonical generation that must match exactly.
 * @param mode - Candidate or adopted verification mode.
 * @returns Whether the authorization is genuine and exactly bound.
 */
export function accepts(
	authorization: unknown,
	generation: GenerationRecord,
	mode: Mode
): authorization is Authorization {
	if (typeof authorization !== "object" || authorization === null) return false;
	const issued = authorizations.get(authorization);
	if (issued === undefined || issued.mode !== mode) return false;
	try {
		return equalBytes(issued.encoded, encodeGenerationRecordV1(generation));
	} catch {
		return false;
	}
}
