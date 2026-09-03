import {
	type DurableIssuanceOutboxRecord,
	type DurableIssuanceStore,
	DurableIssuanceUnknownOutcomeError,
	type DurableIssueScope,
} from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
// eslint-disable-next-line import/no-unresolved -- Workspace subpath resolves after the required package build.
import { CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE } from "@ts-drp/protocol-v3/creator-issuance-retirement";

import {
	type D110cARepeatCloseFixture,
	openD110cARepeatCloseFixture,
} from "../phase-6b-d110c-a/repeat-close-contract.js";

export const D110C_0C1B_RED_TOKEN = "D110C_0C1B_COMMITTED_ISSUANCE_RECOVERY_REQUIRED" as const;
export const D110C_0C1B_PREBOUND_REFUSAL = "creator snapshot export failed: not-active" as const;
export const D110C_0C1B_UNBOUND_REFUSAL = "D110C_A_CLOSE_BIND_FAILED:CREATOR_CLOSE_UNAVAILABLE" as const;

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

interface CapturedCommittedFailure {
	readonly after: readonly DurableIssuanceOutboxRecord[];
	readonly before: readonly DurableIssuanceOutboxRecord[];
	readonly issue: Readonly<Record<string, unknown>>;
	readonly scope: DurableIssueScope;
}

export interface D110c0c1bRedEvidence {
	readonly currentCloseAdvanced: false;
	readonly firstCloseError: typeof D110C_0C1B_PREBOUND_REFUSAL;
	readonly issueKind: "journal-rejected";
	readonly journalWriteDelegated: false;
	readonly pendingRowDelta: 1;
	readonly recoveredIssueKind: "accepted";
	readonly recoveredSequenceDelta: 1;
	readonly recoveredTargetRows: 1;
	readonly repeatCloseError: typeof D110C_0C1B_PREBOUND_REFUSAL;
	readonly secondIssueKind: "admission-rejected";
	readonly secondIssueRowDelta: 0;
}

export interface D110c0c1bUnknownOutcomeEvidence {
	readonly bindError: typeof D110C_0C1B_UNBOUND_REFUSAL;
	readonly issueKind: "admission-rejected";
	readonly pendingRowDelta: 1;
	readonly transactDelegated: true;
}

function deferred(): Deferred {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return Object.freeze({ promise, resolve: resolvePromise });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sameOutboxAddress(left: DurableIssuanceOutboxRecord, right: DurableIssuanceOutboxRecord): boolean {
	return (
		left.commit.authorSequence === right.commit.authorSequence &&
		left.commit.issuedRecord.scope.author === right.commit.issuedRecord.scope.author &&
		left.commit.issuedRecord.scope.objectId === right.commit.issuedRecord.scope.objectId
	);
}

function assertCommittedFailure(
	captured: CapturedCommittedFailure | undefined,
	journalWriteDelegated: boolean
): D110c0c1bRedEvidence {
	if (captured === undefined) throw new TypeError("D110C_0C1B_COMMITTED_FAILURE_EVIDENCE_MISSING");
	if (captured.issue.ok !== false || captured.issue.kind !== "journal-rejected") {
		throw new TypeError("D110C_0C1B_JOURNAL_FAILURE_CLASS_MISMATCH");
	}
	if (journalWriteDelegated) throw new TypeError("D110C_0C1B_TARGET_JOURNAL_WRITE_DELEGATED");
	const added = captured.after.filter((after) => !captured.before.some((before) => sameOutboxAddress(before, after)));
	if (added.length !== 1 || added[0]?.publishState !== "pending") {
		throw new TypeError("D110C_0C1B_PENDING_ROW_EVIDENCE_INVALID");
	}
	const target = added[0];
	if (
		target.commit.issuedRecord.scope.author !== captured.scope.author ||
		target.commit.issuedRecord.scope.objectId !== captured.scope.objectId
	) {
		throw new TypeError("D110C_0C1B_PENDING_ROW_SCOPE_MISMATCH");
	}
	return Object.freeze({
		currentCloseAdvanced: false as const,
		firstCloseError: D110C_0C1B_PREBOUND_REFUSAL,
		issueKind: "journal-rejected" as const,
		journalWriteDelegated: false as const,
		pendingRowDelta: 1 as const,
		recoveredIssueKind: "accepted" as const,
		recoveredSequenceDelta: 1 as const,
		recoveredTargetRows: 1 as const,
		repeatCloseError: D110C_0C1B_PREBOUND_REFUSAL,
		secondIssueKind: "admission-rejected" as const,
		secondIssueRowDelta: 0 as const,
	});
}

/**
 * Drives one genuine committed-issuance failure against an already adopted
 * epoch-one successor. Current code closes across the omitted row and reaches
 * the stale-row retirement error on the next genuine close; GREEN refuses the
 * first close and leaves the durable row for authenticated recovery.
 * @returns The desired fail-closed evidence, or throws the exact RED token when
 * current production advances across the committed failure.
 */
export async function proveD110c0c1bCommittedIssuanceRecovery(): Promise<D110c0c1bRedEvidence> {
	let armed = false;
	let entered = deferred();
	let release = deferred();
	const journalWriteDelegated = false;
	let captured: CapturedCommittedFailure | undefined;
	let repeatCloseError: string | undefined;
	let recoveredIssue: Readonly<Record<string, unknown>> | undefined;
	let recoveredSequenceDelta: number | undefined;
	let recoveredTargetRows: number | undefined;
	let secondIssue: Readonly<Record<string, unknown>> | undefined;
	let secondIssueRowDelta: number | undefined;
	const decorateLiveJournalStore = (store: DurableLiveJournalStore): DurableLiveJournalStore =>
		Object.freeze({
			appendAccepted: async (input) => {
				if (!armed || input.sourceKind !== "local-issued") return store.appendAccepted(input);
				armed = false;
				entered.resolve();
				await release.promise;
				throw new TypeError("D110C_0C1B_INJECTED_JOURNAL_REJECTION");
			},
			close: () => store.close(),
			installEpochAnchor: (input) => store.installEpochAnchor(input),
			installGenesis: (input) => store.installGenesis(input),
			readiness: (input) => store.readiness(input),
			readPage: (input) => store.readPage(input),
		});

	let fixture: D110cARepeatCloseFixture | undefined;
	try {
		fixture = await openD110cARepeatCloseFixture({
			afterRepeatCloseFailure: async ({
				closeHandle,
				issuanceScope,
				issuanceStore,
				plane,
				recoverCurrentSuccessor,
				signRegisteredVertexDigest,
			}) => {
				try {
					await closeHandle.close();
					throw new TypeError("D110C_0C1B_REPEAT_CLOSE_UNEXPECTED_SUCCESS");
				} catch (error) {
					repeatCloseError = errorMessage(error);
				}
				const before = await issuanceStore.readOutboxPage({ limit: 128, scope: issuanceScope });
				secondIssue = await plane.issueLocal({
					operations: Object.freeze([
						Object.freeze({ logicalTime: 43, operation: Object.freeze({ action: "add", value: 23 }) }),
					]),
					signRegisteredVertexDigest,
				});
				const after = await issuanceStore.readOutboxPage({ limit: 128, scope: issuanceScope });
				secondIssueRowDelta = after.length - before.length;
				const recovered = await recoverCurrentSuccessor();
				if (recovered.ok !== true || recovered.handle === null || typeof recovered.handle !== "object") {
					throw new TypeError("D110C_0C1B_RECOVERY_FAILED");
				}
				const recoveredPlane = recovered.handle as typeof plane;
				const target = captured?.after.filter(
					(row) => !captured?.before.some((beforeRow) => sameOutboxAddress(beforeRow, row))
				)[0];
				if (target === undefined) throw new TypeError("D110C_0C1B_RECOVERED_TARGET_UNAVAILABLE");
				recoveredTargetRows = (await issuanceStore.readOutboxPage({ limit: 128, scope: issuanceScope })).filter((row) =>
					sameOutboxAddress(target, row)
				).length;
				recoveredIssue = await recoveredPlane.issueLocal({
					operations: Object.freeze([
						Object.freeze({ logicalTime: 44, operation: Object.freeze({ action: "add", value: 29 }) }),
					]),
					signRegisteredVertexDigest,
				});
				recoveredSequenceDelta = Number(recoveredIssue.authorSequence) - target.commit.authorSequence;
			},
			beforeRepeatClose: async ({ issuanceScope, issuanceStore, plane, signRegisteredVertexDigest }) => {
				const before = await issuanceStore.readOutboxPage({ limit: 128, scope: issuanceScope });
				entered = deferred();
				release = deferred();
				armed = true;
				const issued = plane.issueLocal({
					operations: Object.freeze([
						Object.freeze({ logicalTime: 42, operation: Object.freeze({ action: "add", value: 19 }) }),
					]),
					signRegisteredVertexDigest,
				});
				await entered.promise;
				const completed = (async (): Promise<Readonly<Record<string, unknown>>> => {
					const issue = await issued;
					const after = await issuanceStore.readOutboxPage({ limit: 128, scope: issuanceScope });
					captured = Object.freeze({ after, before, issue, scope: issuanceScope });
					return issue;
				})();
				return Object.freeze({ completed, release: () => release.resolve() });
			},
			creator: Object.freeze({ decorateLiveJournalStore }),
			retainedControls: false,
		});

		const committed = assertCommittedFailure(captured, journalWriteDelegated);
		if (
			fixture.evidence.closeResult.epoch !== 1 ||
			fixture.evidence.closeResult.successorEpoch !== 2 ||
			fixture.evidence.closeResult.ok !== true
		) {
			throw new TypeError("D110C_0C1B_CURRENT_CLOSE_DID_NOT_ADVANCE");
		}
		await fixture.advancePendingSuccessor();
		const nextCloseError = await fixture.attemptCurrentSuccessorClose();
		if (nextCloseError !== CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE) {
			throw new TypeError(`D110C_0C1B_NEXT_CLOSE_CLASS_MISMATCH:${nextCloseError}`);
		}
		void committed;
		throw new TypeError(D110C_0C1B_RED_TOKEN);
	} catch (error) {
		const message = errorMessage(error);
		if (message === D110C_0C1B_RED_TOKEN || message !== D110C_0C1B_PREBOUND_REFUSAL) throw error;
		if (
			repeatCloseError !== D110C_0C1B_PREBOUND_REFUSAL ||
			secondIssue?.ok !== false ||
			secondIssue.kind !== "admission-rejected" ||
			secondIssueRowDelta !== 0 ||
			recoveredIssue?.ok !== true ||
			recoveredIssue.kind !== "accepted" ||
			recoveredSequenceDelta !== 1 ||
			recoveredTargetRows !== 1
		) {
			throw new TypeError(
				`D110C_0C1B_POST_REFUSAL_HALT_INVALID:${JSON.stringify({
					recoveredIssue,
					recoveredSequenceDelta,
					recoveredTargetRows,
					repeatCloseError,
					secondIssue,
					secondIssueRowDelta,
				})}`
			);
		}
		return assertCommittedFailure(captured, journalWriteDelegated);
	} finally {
		await fixture?.close();
	}
}

/**
 * Delegates one genuine no-policy issuance commit, then converts only its
 * post-commit acknowledgement into the issuance store's exact unknown-outcome
 * error. The active registration must halt before creator-close is bound.
 * @returns Exact durable-row and bind-refusal evidence.
 */
export async function proveD110c0c1bUnknownIssuanceOutcome(): Promise<D110c0c1bUnknownOutcomeEvidence> {
	let armed = false;
	let transactDelegated = false;
	let issue: Readonly<Record<string, unknown>> | undefined;
	let pendingRowDelta: number | undefined;
	const decorateIssuanceStore = (store: DurableIssuanceStore): DurableIssuanceStore =>
		Object.freeze({
			close: () => store.close(),
			compareAndMarkOutboxPublished: (input) => store.compareAndMarkOutboxPublished(input),
			readIssued: (scope, authorSequence) => store.readIssued(scope, authorSequence),
			readLineage: (scope) => store.readLineage(scope),
			readOutboxPage: (input) => store.readOutboxPage(input),
			transactIssue: async (scope, buildAndSign) => {
				const commit = await store.transactIssue(scope, buildAndSign);
				if (!armed) return commit;
				armed = false;
				transactDelegated = true;
				throw new DurableIssuanceUnknownOutcomeError(scope);
			},
		});

	try {
		await openD110cARepeatCloseFixture({
			beforeRepeatCloseBinding: async ({ issuanceScope, issuanceStore, plane, signRegisteredVertexDigest }) => {
				const before = await issuanceStore.readOutboxPage({ limit: 128, scope: issuanceScope });
				armed = true;
				issue = await plane.issueLocal({
					operations: Object.freeze([
						Object.freeze({ logicalTime: 42, operation: Object.freeze({ action: "add", value: 17 }) }),
					]),
					signRegisteredVertexDigest,
				});
				const after = await issuanceStore.readOutboxPage({ limit: 128, scope: issuanceScope });
				pendingRowDelta = after.length - before.length;
			},
			creator: Object.freeze({ decorateIssuanceStore }),
			retainedControls: false,
		});
		throw new TypeError("D110C_0C1B_UNBOUND_CLOSE_UNEXPECTED_SUCCESS");
	} catch (error) {
		const bindError = errorMessage(error);
		if (bindError !== D110C_0C1B_UNBOUND_REFUSAL) throw error;
		if (issue?.ok !== false || issue.kind !== "admission-rejected" || pendingRowDelta !== 1 || !transactDelegated) {
			throw new TypeError("D110C_0C1B_UNKNOWN_OUTCOME_EVIDENCE_INVALID");
		}
		return Object.freeze({
			bindError: D110C_0C1B_UNBOUND_REFUSAL,
			issueKind: "admission-rejected" as const,
			pendingRowDelta: 1 as const,
			transactDelegated: true as const,
		});
	}
}
