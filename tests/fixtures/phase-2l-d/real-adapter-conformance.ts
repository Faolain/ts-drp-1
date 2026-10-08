import { encodeCanonical } from "@ts-drp/canonical";
import type {
	DurableIssuanceError,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "@ts-drp/issuance-store";

export interface Phase2lDAdapterConformanceReport {
	readonly builderFailures: readonly string[];
	readonly builderFailureOldState: readonly boolean[];
	readonly builderInvocations: number;
	readonly closedCode: string;
	readonly copy: {
		readonly durableDigest: readonly number[];
		readonly durableSignature: readonly number[];
		readonly durableScope: DurableIssueScope;
		readonly freshRead: boolean;
		readonly returnedDetached: boolean;
		readonly sourceDetached: boolean;
		readonly sourceDigest: readonly number[];
	};
	readonly invalidCodes: readonly string[];
	readonly invalidOldState: readonly boolean[];
	readonly invalidTypeErrors: readonly boolean[];
	readonly malformedCode: string;
	readonly malformedLineage: { readonly exhausted: boolean; readonly next: number };
	readonly malformedOldState: boolean;
	readonly pendingCount: number;
	readonly scopeBoundary: {
		readonly accepted1024: boolean;
		readonly acceptedBuilderCalls: number;
		readonly rejected1025Code: string;
		readonly rejectedBuilderCalls: number;
	};
}

function scope(suffix: string): DurableIssueScope {
	return { author: `author:${suffix}`, objectId: `object:${suffix}` };
}

function commit(scopeValue: DurableIssueScope, authorSequence: number, seed = 17): DurableIssueCommit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({ ...scopeValue, authorSequence }),
		digest: Uint8Array.of(seed, 0xd1),
		signature: Uint8Array.of(seed, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope: scopeValue },
		outboxEntry: { authorSequence, envelope, scope: scopeValue },
	};
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected promise rejection");
}

function code(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as DurableIssuanceError).code)
		: "NO_ISSUANCE_CODE";
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function scopeEqual(left: DurableIssueScope, right: DurableIssueScope): boolean {
	return left.author === right.author && left.objectId === right.objectId;
}

function isInvalidTypeError(error: unknown): boolean {
	return (
		error instanceof TypeError &&
		error.name === "DurableIssuanceTypeError" &&
		code(error) === "ISSUANCE_INVALID_ARGUMENT"
	);
}

async function isOldState(store: DurableIssuanceStore, scopeValue: DurableIssueScope): Promise<boolean> {
	const [lineage, issued, outbox] = await Promise.all([
		store.readLineage(scopeValue),
		store.readIssued(scopeValue, 0),
		store.readOutboxPage({ scope: scopeValue }),
	]);
	return lineage.next === 0 && !lineage.exhausted && issued === null && outbox.length === 0;
}

/**
 * Executes the observable Phase 2l-d closure through one real adapter.
 * The caller owns backend construction, physical cleanup and backend-specific evidence.
 * @param store - One real browser or Node durable issuance capability.
 * @returns The backend-neutral observable report.
 */
export async function runPhase2lDRealAdapterConformance(
	store: DurableIssuanceStore
): Promise<Phase2lDAdapterConformanceReport> {
	const syncFailure = new RangeError("phase-2l-d-sync-builder");
	const asyncFailure = new URIError("phase-2l-d-async-builder");
	const syncScope = scope("sync-rejection");
	const asyncScope = scope("async-rejection");
	const syncObserved = await rejection(
		store.transactIssue(syncScope, () => {
			throw syncFailure;
		})
	);
	const asyncObserved = await rejection(store.transactIssue(asyncScope, () => Promise.reject(asyncFailure)));
	const builderFailureOldState = await Promise.all([isOldState(store, syncScope), isOldState(store, asyncScope)]);

	const malformedScope = scope("malformed");
	const malformed = await rejection(
		store.transactIssue(malformedScope, (selected) => {
			const candidate = commit(malformedScope, selected);
			return Promise.resolve({
				...candidate,
				issuedRecord: { ...candidate.issuedRecord, authorSequence: selected + 1 },
			});
		})
	);
	const malformedLineage = await store.readLineage(malformedScope);
	const malformedOldState = await isOldState(store, malformedScope);

	const successScope = scope("success");
	const expectedSuccessScope = { ...successScope };
	let builderInvocations = 0;
	const source = commit(successScope, 0, 29);
	const sourcePreimage = new Uint8Array(source.envelope.canonicalPreimageBytes);
	const sourceDigest = new Uint8Array(source.envelope.digest);
	const sourceSignature = new Uint8Array(source.envelope.signature);
	const issued = await store.transactIssue(successScope, (selected) => {
		builderInvocations++;
		if (selected !== 0) throw new Error(`unexpected selected ordinal ${selected}`);
		return Promise.resolve(source);
	});
	const sourceDigestBeforeMutation = [...source.envelope.digest];
	source.envelope.canonicalPreimageBytes.fill(0);
	source.envelope.digest.fill(0);
	source.envelope.signature.fill(0);
	(source.issuedRecord.scope as { author: string }).author = "mutated-source-author";
	(source.outboxEntry.scope as { objectId: string }).objectId = "mutated-source-object";
	const afterSourceMutation = await store.readIssued(expectedSuccessScope, 0);
	if (afterSourceMutation === null) throw new Error("source mutation erased durable issuance");
	issued.envelope.canonicalPreimageBytes.fill(1);
	issued.envelope.digest.fill(1);
	issued.envelope.signature.fill(1);
	(issued.issuedRecord.scope as { author: string }).author = "mutated-return-author";
	(issued.outboxEntry.scope as { objectId: string }).objectId = "mutated-return-object";
	const readA = await store.readIssued(expectedSuccessScope, 0);
	const readB = await store.readIssued(expectedSuccessScope, 0);
	if (readA === null || readB === null) throw new Error("successful issuance was not durably readable");
	const outbox = await store.readOutboxPage({ scope: expectedSuccessScope });
	const sourceDetached =
		bytesEqual(afterSourceMutation.envelope.canonicalPreimageBytes, sourcePreimage) &&
		bytesEqual(afterSourceMutation.envelope.digest, sourceDigest) &&
		bytesEqual(afterSourceMutation.envelope.signature, sourceSignature) &&
		scopeEqual(afterSourceMutation.issuedRecord.scope, expectedSuccessScope) &&
		scopeEqual(afterSourceMutation.outboxEntry.scope, expectedSuccessScope);
	const returnedDetached =
		bytesEqual(readA.envelope.canonicalPreimageBytes, sourcePreimage) &&
		bytesEqual(readA.envelope.digest, sourceDigest) &&
		bytesEqual(readA.envelope.signature, sourceSignature) &&
		scopeEqual(readA.issuedRecord.scope, expectedSuccessScope) &&
		scopeEqual(readA.outboxEntry.scope, expectedSuccessScope);
	const outboxDetached =
		outbox.length === 1 &&
		outbox[0] !== undefined &&
		outbox[0].commit !== readA &&
		outbox[0].commit.envelope !== readA.envelope &&
		bytesEqual(outbox[0].commit.envelope.canonicalPreimageBytes, sourcePreimage) &&
		bytesEqual(outbox[0].commit.envelope.digest, sourceDigest) &&
		bytesEqual(outbox[0].commit.envelope.signature, sourceSignature) &&
		scopeEqual(outbox[0].commit.issuedRecord.scope, expectedSuccessScope) &&
		scopeEqual(outbox[0].commit.outboxEntry.scope, expectedSuccessScope);

	const acceptedScope = { author: "a".repeat(1024), objectId: "object:scope-boundary" };
	let acceptedBuilderCalls = 0;
	const acceptedBoundary = await store.transactIssue(acceptedScope, (selected) => {
		acceptedBuilderCalls++;
		return Promise.resolve(commit(acceptedScope, selected, 31));
	});
	const rejectedScope = { author: "a".repeat(1025), objectId: "object:scope-boundary" };
	let rejectedBuilderCalls = 0;
	const rejectedBoundary = await rejection(
		store.transactIssue(rejectedScope, (selected) => {
			rejectedBuilderCalls++;
			return Promise.resolve(commit(rejectedScope, selected, 32));
		})
	);

	const cleanInvalidScope = scope("invalid-shape");
	const invalidScope = { ...cleanInvalidScope, extra: true } as unknown as DurableIssueScope;
	let invalidBuilderCalls = 0;
	const invalidScopeError = await rejection(
		store.transactIssue(invalidScope, (selected) => {
			invalidBuilderCalls++;
			return Promise.resolve(commit(scope("unreachable"), selected));
		})
	);
	const nonfunctionScope = scope("nonfunction");
	const nonfunctionError = await rejection(
		store.transactIssue(nonfunctionScope, null as unknown as (authorSequence: number) => Promise<DurableIssueCommit>)
	);
	const invalidErrors = [invalidScopeError, nonfunctionError];
	const invalidOldState = [
		invalidBuilderCalls === 0 && (await isOldState(store, cleanInvalidScope)),
		await isOldState(store, nonfunctionScope),
	];

	await store.close();
	const closed = await rejection(store.readLineage(scope("closed")));

	return {
		builderFailures: [
			syncObserved === syncFailure ? "sync-identity" : "sync-wrapped",
			asyncObserved === asyncFailure ? "async-identity" : "async-wrapped",
		],
		builderFailureOldState,
		builderInvocations,
		closedCode: code(closed),
		copy: {
			durableDigest: [...readA.envelope.digest],
			durableSignature: [...readA.envelope.signature],
			durableScope: readA.issuedRecord.scope,
			freshRead:
				readA !== readB &&
				readA.envelope !== readB.envelope &&
				readA.envelope.canonicalPreimageBytes !== readB.envelope.canonicalPreimageBytes &&
				readA.envelope.digest !== readB.envelope.digest &&
				readA.envelope.signature !== readB.envelope.signature &&
				readA.issuedRecord.scope !== readB.issuedRecord.scope &&
				readA.outboxEntry.scope !== readB.outboxEntry.scope &&
				outboxDetached,
			returnedDetached,
			sourceDetached,
			sourceDigest: sourceDigestBeforeMutation,
		},
		invalidCodes: invalidErrors.map(code),
		invalidOldState,
		invalidTypeErrors: invalidErrors.map(isInvalidTypeError),
		malformedCode: code(malformed),
		malformedLineage,
		malformedOldState,
		pendingCount: outbox.filter(({ publishState }) => publishState === "pending").length,
		scopeBoundary: {
			accepted1024: acceptedBoundary.authorSequence === 0,
			acceptedBuilderCalls,
			rejected1025Code: code(rejectedBoundary),
			rejectedBuilderCalls,
		},
	};
}
