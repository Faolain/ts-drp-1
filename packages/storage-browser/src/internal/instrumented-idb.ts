import { parseStorageObjectId } from "@ts-drp/storage";

import type { KillHit, KillPoint } from "../killpoints.js";

export type WorkerFailureCode =
	| "UNSUPPORTED_CAPABILITY"
	| "INVALID_RUN_MESSAGE"
	| "INVALID_OBJECT_ID"
	| "UNEXPECTED_UPGRADE"
	| "DURABILITY_NOT_STRICT"
	| "PREFLIGHT_MISMATCH"
	| "REQUEST_ERROR"
	| "TRANSACTION_ABORT"
	| "ARM_STATE_ERROR"
	| "MANIFEST_MISMATCH"
	| "DRIVER_NOT_IMPLEMENTED";

export interface InstrumentedTransitionInput {
	readonly armed: KillPoint | null;
	readonly databaseName: string;
	readonly objectId: string;
	readonly signal: SharedArrayBuffer;
	onHit(hit: KillHit): void;
}

export type InstrumentedTransitionResult =
	| {
			readonly kind: "complete";
			readonly observed: readonly KillHit[];
			readonly transactionDurability: "strict";
	  }
	| {
			readonly kind: "failure";
			readonly code: WorkerFailureCode;
			readonly detail: string;
	  };

/**
 * Typed Phase 2b boundary. RED deliberately performs no IndexedDB mutation.
 * @param input - Closed transition input.
 * @returns The ratified closed not-implemented failure.
 */
export function runInstrumentedTransition(input: InstrumentedTransitionInput): Promise<InstrumentedTransitionResult> {
	const parsed = parseStorageObjectId(input.objectId);
	if (!parsed.ok || input.objectId !== "phase-2b-driver:0123456789abcdef0123456789abcdef") {
		return Promise.resolve({ kind: "failure", code: "INVALID_OBJECT_ID", detail: "objectId is outside Phase 2b" });
	}
	return Promise.resolve({
		kind: "failure",
		code: "DRIVER_NOT_IMPLEMENTED",
		detail: "Phase 2b RED boundary is inert; no IndexedDB requests were issued",
	});
}
