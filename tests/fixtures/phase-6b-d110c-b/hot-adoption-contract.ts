import { openD110cARepeatCloseFixture } from "../phase-6b-d110c-a/repeat-close-contract.js";

export const D110C_B_HOT_ADOPTION_COMPLETE = "D110C_B_HOT_ADOPTION_COMPLETE";

export interface D110cBHotAdoptionEvidence {
	readonly activation: Readonly<Record<string, unknown>>;
	readonly activeAuthority: Readonly<Record<string, unknown>> | undefined;
	readonly closeEpoch: number;
	readonly commit: Readonly<Record<string, unknown>>;
	readonly diagnostic: typeof D110C_B_HOT_ADOPTION_COMPLETE;
	readonly duplicateActivation: Readonly<Record<string, unknown>>;
	readonly duplicateCommit: Readonly<Record<string, unknown>>;
	readonly duplicateHandleIdentity: boolean;
	readonly durableHeadAfterVerification: unknown;
	readonly durableHeadBeforeVerification: unknown;
	readonly issued: Readonly<Record<string, unknown>>;
	readonly mutants: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly oldIssue: Readonly<Record<string, unknown>>;
	readonly published: Readonly<Record<string, unknown>>;
	readonly successorEpoch: number;
	readonly verification: Readonly<Record<string, unknown>>;
}

export interface D110cBHotAdoptionFixture {
	readonly evidence: D110cBHotAdoptionEvidence;
	close(): Promise<void>;
}

export interface D110cBPostTransferEvidence {
	readonly retirement: Readonly<{
		readonly oldIssue: Readonly<Record<string, unknown>>;
		readonly result: Readonly<Record<string, unknown>>;
	}>;
	readonly terminalize: Readonly<{
		readonly oldIssue: Readonly<Record<string, unknown>>;
		readonly result: Readonly<Record<string, unknown>>;
	}>;
}

/**
 * Advances the genuine D.110c-a epoch-one close through hot epoch-two activation.
 * The retained fixture owns every close, trust, snapshot, and durable-storage fact.
 * @returns One-shot GREEN evidence and the inherited cleanup owner.
 */
export async function openD110cBHotAdoptionFixture(): Promise<D110cBHotAdoptionFixture> {
	const fixture = await openD110cARepeatCloseFixture();
	try {
		const observed = await fixture.advancePendingSuccessor();
		return Object.freeze({
			close: fixture.close,
			evidence: Object.freeze({
				activation: observed.activation,
				activeAuthority: observed.activeAuthority,
				closeEpoch: fixture.evidence.closeResult.epoch,
				commit: observed.committed,
				diagnostic: D110C_B_HOT_ADOPTION_COMPLETE,
				duplicateActivation: observed.duplicateActivation,
				duplicateCommit: observed.duplicateCommit,
				duplicateHandleIdentity: observed.duplicateHandleIdentity,
				durableHeadAfterVerification: observed.afterHead,
				durableHeadBeforeVerification: observed.beforeHead,
				issued: observed.issued,
				mutants: observed.mutants,
				oldIssue: observed.oldIssue,
				published: observed.published,
				successorEpoch: fixture.evidence.closeResult.successorEpoch,
				verification: observed.verification,
			}),
		});
	} catch (error) {
		await fixture.close();
		throw error;
	}
}

/**
 * Exercises the two post-transfer fail-closed boundaries in isolated genuine rooms.
 * @returns Terminalization failure and in-flight retirement/CAS-loss evidence.
 */
export async function runD110cBPostTransferMutants(): Promise<D110cBPostTransferEvidence> {
	const terminalizeFixture = await openD110cARepeatCloseFixture({
		objectId: `creator:${"d".repeat(32)}`,
		retainedControls: false,
	});
	let terminalize;
	try {
		terminalize = await terminalizeFixture.failPendingSuccessor("terminalize");
	} finally {
		await terminalizeFixture.close();
	}
	const retirementFixture = await openD110cARepeatCloseFixture({
		objectId: `creator:${"e".repeat(32)}`,
		retainedControls: false,
	});
	try {
		return Object.freeze({
			retirement: await retirementFixture.failPendingSuccessor("retirement"),
			terminalize,
		});
	} finally {
		await retirementFixture.close();
	}
}
