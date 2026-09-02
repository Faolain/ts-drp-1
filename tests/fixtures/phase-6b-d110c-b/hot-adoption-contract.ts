import { openD110cARepeatCloseFixture } from "../phase-6b-d110c-a/repeat-close-contract.js";

export const D110C_B_EPOCH_PINNED_PREDECESSOR = "D110C_B_EPOCH_PINNED_PREDECESSOR";

export interface D110cBHotAdoptionEvidence {
	readonly diagnostic: typeof D110C_B_EPOCH_PINNED_PREDECESSOR;
	readonly closeEpoch: number;
	readonly durableHeadAfterVerification: unknown;
	readonly durableHeadBeforeVerification: unknown;
	readonly issued: Readonly<Record<string, unknown>>;
	readonly published: Readonly<Record<string, unknown>>;
	readonly successorEpoch: number;
	readonly verification: Readonly<Record<string, unknown>>;
}

export interface D110cBHotAdoptionFixture {
	readonly evidence: D110cBHotAdoptionEvidence;
	close(): Promise<void>;
}

/**
 * Observes the general verifier against the genuine D.110c-a epoch-one close.
 * The retained fixture owns every close, trust, snapshot, and durable-storage fact.
 * @returns One-shot RED evidence and the inherited cleanup owner.
 */
export async function openD110cBHotAdoptionFixture(): Promise<D110cBHotAdoptionFixture> {
	const fixture = await openD110cARepeatCloseFixture();
	try {
		const observed = await fixture.verifyPendingSuccessor();
		return Object.freeze({
			close: fixture.close,
			evidence: Object.freeze({
				closeEpoch: fixture.evidence.closeResult.epoch,
				diagnostic: D110C_B_EPOCH_PINNED_PREDECESSOR,
				durableHeadAfterVerification: observed.afterHead,
				durableHeadBeforeVerification: observed.beforeHead,
				issued: fixture.evidence.issued,
				published: fixture.evidence.published,
				successorEpoch: fixture.evidence.closeResult.successorEpoch,
				verification: observed.result,
			}),
		});
	} catch (error) {
		await fixture.close();
		throw error;
	}
}
