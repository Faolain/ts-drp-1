import type { DurableIssuanceOutboxRecord, DurableIssueScope } from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
// eslint-disable-next-line import/no-unresolved -- Workspace subpath resolves after the required package build.
import { CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE } from "@ts-drp/protocol-v3/creator-issuance-retirement";

import {
	type D110cARepeatCloseFixture,
	openD110cARepeatCloseFixture,
} from "../phase-6b-d110c-a/repeat-close-contract.js";

export const D110C_0C1B_RED_TOKEN = "D110C_0C1B_COMMITTED_ISSUANCE_RECOVERY_REQUIRED" as const;
export const D110C_0C1B_PREBOUND_REFUSAL = "creator snapshot export failed: not-active" as const;

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
		return assertCommittedFailure(captured, journalWriteDelegated);
	} finally {
		await fixture?.close();
	}
}
