import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	type DurableIssuanceOutboxRecord,
	type DurableIssuanceStore,
	type DurableIssueCommit,
	type DurableIssueScope,
	type DurableLineage,
	MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT,
} from "@ts-drp/issuance-store";
import { CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE } from "@ts-drp/protocol-v3/creator-issuance-retirement";

export interface CreatorIssuanceRetirementBoundaryInput {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: number;
	readonly graphVertexDigests: Readonly<{ has(digest: string): boolean }>;
	readonly issuanceScope: DurableIssueScope;
	readonly issuanceStore: DurableIssuanceStore;
	readonly maxEpochVertices: number;
	readonly priorAdmittedAuthorSequence: number | null;
}

export interface CreatorIssuanceRetirementBoundary {
	readonly admittedAuthorSequence: number;
	readonly observedLineage: DurableLineage;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameIssuanceScope(left: DurableIssueScope, right: DurableIssueScope): boolean {
	return left.author === right.author && left.objectId === right.objectId;
}

function exactIssuanceCommit(commit: DurableIssueCommit, scope: DurableIssueScope, authorSequence: number): boolean {
	return (
		commit.authorSequence === authorSequence &&
		commit.issuedRecord.authorSequence === authorSequence &&
		commit.outboxEntry.authorSequence === authorSequence &&
		sameIssuanceScope(commit.issuedRecord.scope, scope) &&
		sameIssuanceScope(commit.outboxEntry.scope, scope) &&
		compareBytes(commit.envelope.canonicalPreimageBytes, commit.issuedRecord.envelope.canonicalPreimageBytes) === 0 &&
		compareBytes(commit.envelope.canonicalPreimageBytes, commit.outboxEntry.envelope.canonicalPreimageBytes) === 0 &&
		compareBytes(commit.envelope.digest, commit.issuedRecord.envelope.digest) === 0 &&
		compareBytes(commit.envelope.digest, commit.outboxEntry.envelope.digest) === 0 &&
		compareBytes(commit.envelope.signature, commit.issuedRecord.envelope.signature) === 0 &&
		compareBytes(commit.envelope.signature, commit.outboxEntry.envelope.signature) === 0
	);
}

function exactIssuancePair(
	left: DurableIssuanceOutboxRecord,
	right: Awaited<ReturnType<DurableIssuanceStore["readIssued"]>>,
	scope: DurableIssueScope,
	authorSequence: number
): boolean {
	return (
		right !== null &&
		exactIssuanceCommit(left.commit, scope, authorSequence) &&
		exactIssuanceCommit(right, scope, authorSequence) &&
		compareBytes(left.commit.envelope.canonicalPreimageBytes, right.envelope.canonicalPreimageBytes) === 0 &&
		compareBytes(left.commit.envelope.digest, right.envelope.digest) === 0 &&
		compareBytes(left.commit.envelope.signature, right.envelope.signature) === 0
	);
}

/**
 * Derives the largest dense admitted issuance prefix for one authenticated close.
 * This internal seam exists so every fail-closed derivation branch is directly executable.
 * @param input - Authenticated room head, exact issuance scope/store, and captured graph membership.
 * @returns The exact admitted boundary and observed non-exhausted lineage.
 */
export async function deriveCreatorIssuanceRetirementBoundary(
	input: CreatorIssuanceRetirementBoundaryInput
): Promise<CreatorIssuanceRetirementBoundary> {
	const lineage = await input.issuanceStore.readLineage(input.issuanceScope);
	if (lineage.exhausted) throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
	const rows: DurableIssuanceOutboxRecord[] = [];
	let afterKey: readonly [string, string, number] | null =
		input.priorAdmittedAuthorSequence === null
			? null
			: [input.issuanceScope.objectId, input.issuanceScope.author, input.priorAdmittedAuthorSequence];
	while (rows.length <= input.maxEpochVertices) {
		const limit = Math.min(MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT, input.maxEpochVertices + 1 - rows.length);
		const page = await input.issuanceStore.readOutboxPage({ afterKey, limit, scope: input.issuanceScope });
		if (page.length === 0) break;
		rows.push(...page);
		const last = page[page.length - 1] as DurableIssuanceOutboxRecord;
		afterKey = [input.issuanceScope.objectId, input.issuanceScope.author, last.commit.authorSequence];
		if (page.length < limit) break;
	}
	const firstExpected = input.priorAdmittedAuthorSequence === null ? 0 : input.priorAdmittedAuthorSequence + 1;
	if (rows.length > input.maxEpochVertices || lineage.next !== firstExpected + rows.length) {
		throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
	}
	let admitted = input.priorAdmittedAuthorSequence;
	let expected = firstExpected;
	let truncated = false;
	for (const row of rows) {
		if (row.commit.authorSequence !== expected) throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
		const issued = await input.issuanceStore.readIssued(input.issuanceScope, expected);
		if (!exactIssuancePair(row, issued, input.issuanceScope, expected)) {
			throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
		}
		const bytes = row.commit.envelope.canonicalPreimageBytes;
		const digest = hex(row.commit.envelope.digest);
		const decoded = decodeCanonical(bytes);
		if (
			!plainRecord(decoded) ||
			compareBytes(encodeCanonical(decoded), bytes) !== 0 ||
			hex(hashDomain("ts-drp/vertex/v3", bytes)) !== digest ||
			decoded.anchor !== input.currentAnchorDigest ||
			decoded.author !== input.issuanceScope.author ||
			decoded.epoch !== input.currentEpoch ||
			decoded.objectId !== input.issuanceScope.objectId ||
			decoded.authorSequence !== expected
		) {
			throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
		}
		const inGraph = input.graphVertexDigests.has(digest);
		if (inGraph && truncated) throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
		if (inGraph) admitted = expected;
		else truncated = true;
		expected += 1;
	}
	if (admitted === null || lineage.next <= admitted) {
		throw new TypeError(CREATOR_ISSUANCE_RETIREMENT_UNAVAILABLE);
	}
	return Object.freeze({ admittedAuthorSequence: admitted, observedLineage: Object.freeze({ ...lineage }) });
}
