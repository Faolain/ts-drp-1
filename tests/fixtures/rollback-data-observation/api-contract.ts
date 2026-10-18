// Required prospective private API gate. Unresolved product import is intentional uncompensated RED.
import {
	authenticateCreatorClosedRollbackData,
	type CreatorClosedRollbackDataInput,
	type CreatorClosedRollbackDataResult,
	resolveCreatorClosedRollbackDataObservation,
	type VerifiedCreatorClosedRollbackData,
} from "../../../packages/node/src/internal/creator-closed-rollback-data.js";
/**
 *
 * @param input
 */
export function required(input: CreatorClosedRollbackDataInput): Promise<CreatorClosedRollbackDataResult> {
	return authenticateCreatorClosedRollbackData(input);
}
/**
 *
 * @param token
 */
export function privateResolution(token: VerifiedCreatorClosedRollbackData): unknown {
	return resolveCreatorClosedRollbackDataObservation(token);
}
// A caller declaration is not part of the accepted seam.
/**
 *
 * @param input
 */
export function noDeclaration(input: CreatorClosedRollbackDataInput): void {
	// @ts-expect-error No caller-held declaration selects rollback bytes.
	void input.snapshotDeclaration;
	// @ts-expect-error No caller stable head bypasses actual host reads.
	void input.expectedRoomHead;
}
type ExpectedKind =
	| "malformed-input"
	| "floor-unavailable"
	| "floor-invalid"
	| "floor-pending"
	| "floor-stale"
	| "ahe-empty"
	| "ahe-rejected"
	| "chain-invalid"
	| "snapshot-unavailable"
	| "snapshot-not-ready"
	| "snapshot-invalid"
	| "anchor-unavailable"
	| "anchor-invalid"
	| "proof-budget-exceeded"
	| "blueprint-invalid"
	| "aborted"
	| "release-failed"
	| "internal-invariant";
type ActualKind = Extract<CreatorClosedRollbackDataResult, { ok: false }>["kind"];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export const closedFailureUnion: Equal<ActualKind, ExpectedKind> = true;
