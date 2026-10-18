/* eslint-disable jsdoc/require-jsdoc -- Test-only live-frame observation; never a product authority factory. */
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";

import type { CreatorClosedRollbackProofAccounting } from "../../../packages/node/src/internal/creator-closed-rollback-data.js";

export interface Frame {
	readonly requirement: object;
	readonly proofLedger: object;
	readonly accounting: CreatorClosedRollbackProofAccounting;
	readonly successorTrust: CurrentAnchorTrust;
	readonly fullUnionBytes: number;
}
let ledger: object | undefined;
let accounting: CreatorClosedRollbackProofAccounting | undefined;
let fullUnionBytes = 0;
let hook: ((frame: Frame) => Promise<void>) | undefined;
export const events: string[] = [];
export const signedDispatches: { maxBytes: unknown; chargedBytes: number | undefined; backend: string }[] = [];
export function arm(next?: (frame: Frame) => Promise<void>): void {
	ledger = undefined;
	accounting = undefined;
	fullUnionBytes = 0;
	hook = next;
	events.length = 0;
	signedDispatches.length = 0;
}
export function observeLedger(
	value: CreatorClosedRollbackProofAccounting,
	blobs: readonly { bytes: Uint8Array }[]
): void {
	ledger = value;
	accounting = value;
	fullUnionBytes = blobs.reduce((sum, blob) => sum + blob.bytes.length, 0);
	events.push("real-reader-full-union");
}
export async function observeRequirement(
	requirement: object | undefined,
	successorTrust: CurrentAnchorTrust
): Promise<void> {
	if (!requirement || !ledger || !accounting) throw new Error("GENUINE_DERIVATION_NOT_REACHED");
	events.push("genuine-requirement-before-destination");
	await hook?.({ requirement, proofLedger: ledger, accounting, successorTrust, fullUnionBytes });
	events.push("live-frame-hook-joined");
}
export function observeSignedRead(input: unknown, backend: string): void {
	// Inspect only data descriptors: even the capture observer must not invoke accessors.
	let maxBytes: unknown;
	try {
		if (input && typeof input === "object") maxBytes = Object.getOwnPropertyDescriptor(input, "maxBytes")?.value;
	} catch {
		/* Original product capture still owns refusal. */
	}
	signedDispatches.push({ maxBytes, chargedBytes: accounting?.chargedBytes, backend });
}
