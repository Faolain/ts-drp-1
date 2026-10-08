import type { AheBoundedActiveRead } from "@ts-drp/storage";

/** Non-authority view of the prospective real operation-scoped production owner. */
export interface ProofAccounting {
	readonly chargedBytes: number;
	charge(exactBytes: Uint8Array): boolean;
}
export type AccountingFactory = (initialBlobs: AheBoundedActiveRead["blobs"]) => ProofAccounting;
export type CompositionMode = "below" | "equal" | "above" | "cap" | "equal-bytes" | "unequal-same-length";
