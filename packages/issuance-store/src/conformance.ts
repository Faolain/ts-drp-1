import {
	durableIssuanceBytesEqual as bytesEqual,
	cloneDurableIssueCommit as cloneCommit,
	copyDurableIssueScope as cloneScope,
	compareDurableIssuanceCompoundKeys as compareCompoundKey,
	type DurableIssuanceCompoundKey as CompoundKey,
	copyAndValidateDurableIssueCommit as copyAndValidateCommit,
	copyDurableIssuanceBytes as copyBytes,
	copyDurableIssuedRecord as copyIssuedRecord,
	createDurableIssuanceFailure as failure,
	DurableIssuanceInvalidArgumentError as InvalidArgumentFailure,
	isClosedDurableIssuanceRecord as isRecord,
	type DurableIssuanceContractError as IssuanceFailure,
	durablePreimageMatchesScopeAndSequence as preimageMatches,
	durableIssueScopesEqual as sameScope,
	DurableIssuanceUnknownOutcomeError as UnknownOutcomeFailure,
	assertDurableIssueScope as validateScope,
	isValidDurableAuthorSequence as validOrdinal,
	isValidDurableScopeField as validScopeField,
} from "./contract.js";
import { DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT, MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT } from "./types.js";
import type {
	DurableBuildAndSign,
	DurableIssuanceOutboxRecord,
	DurableIssuancePublishState,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssuedRecord,
	DurableIssueScope,
	DurableLineage,
	DurableOutboxPageInput,
} from "./types.js";

export { DURABLE_ISSUANCE_ERROR_CODES, DURABLE_ISSUANCE_RETRY_CLASSES } from "./types.js";

export const TERMINAL_SUPPRESSION_AMBIGUITY_CASES = Object.freeze(
	(["browser", "node"] as const).flatMap((backend) =>
		(["exact-pair", "absent-old", "foreign-pair", "torn-or-inconsistent", "unreadable"] as const).map((edge) =>
			Object.freeze([backend, edge] as const)
		)
	)
);

interface NativeOutboxRecord {
	readonly authorSequence: number;
	readonly digest: Uint8Array;
	readonly publishState: DurableIssuancePublishState;
	readonly scope: DurableIssueScope;
}

export interface TerminalObservation {
	readonly issuedRecord: DurableIssuedRecord | null;
	readonly lineage: DurableLineage;
	readonly outboxRecord: NativeOutboxRecord | null;
}

export interface TerminalClassificationInput {
	readonly candidate: DurableIssueCommit;
	readonly observation: TerminalObservation | { readonly unreadable: true };
	readonly priorLineage: DurableLineage;
	readonly scope: DurableIssueScope;
}

export interface EphemeralDurableIssuanceStoreOptions {
	readonly initialLineages?: readonly {
		readonly exhausted: boolean;
		readonly next: number;
		readonly scope: DurableIssueScope;
	}[];
	readonly initialPoison?: "recovery-corrupt";
}

function scopeKey(scope: DurableIssueScope): string {
	return `${scope.objectId.length}:${scope.objectId}${scope.author.length}:${scope.author}`;
}

function recordKey(scope: DurableIssueScope, authorSequence: number): string {
	return `${scopeKey(scope)}:${authorSequence}`;
}

function sameLineage(left: DurableLineage, right: DurableLineage): boolean {
	return left.next === right.next && left.exhausted === right.exhausted;
}

function cloneLineage(lineage: DurableLineage): DurableLineage {
	return { exhausted: lineage.exhausted, next: lineage.next };
}

function isSemanticallyValidLineage(lineage: DurableLineage): boolean {
	return !lineage.exhausted || lineage.next === Number.MAX_SAFE_INTEGER;
}

function copyExactLineage(value: unknown, source: "caller" | "durable-observation"): DurableLineage {
	const exact =
		isRecord(value, ["exhausted", "next"]) && typeof value.exhausted === "boolean" && validOrdinal(value.next)
			? { exhausted: value.exhausted, next: value.next }
			: undefined;
	if (exact === undefined || !isSemanticallyValidLineage(exact)) {
		if (source === "caller") {
			throw new InvalidArgumentFailure("prior lineage must be an exact safe lineage record");
		}
		throw failure("ISSUANCE_RECOVERY_CORRUPT", "durable observation contains a malformed lineage");
	}
	return exact;
}

function isClosedOutboxPageInput(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const allowedKeys = ["afterKey", "limit", "scope"] as const;
	return Reflect.ownKeys(value).every((key) => {
		if (typeof key !== "string" || !allowedKeys.includes(key as (typeof allowedKeys)[number])) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
	});
}

function outboxKey(record: DurableIssuanceOutboxRecord): CompoundKey {
	return [
		record.commit.outboxEntry.scope.objectId,
		record.commit.outboxEntry.scope.author,
		record.commit.authorSequence,
	];
}

function validateLineage(value: DurableLineage): void {
	if (!validOrdinal(value.next) || typeof value.exhausted !== "boolean") {
		throw new InvalidArgumentFailure("lineage must contain a safe next ordinal and exhaustion discriminator");
	}
}

function recoveryPoison(): IssuanceFailure {
	return Object.freeze(failure("ISSUANCE_RECOVERY_CORRUPT", "durable issuance state is corrupt"));
}

class EphemeralDurableIssuanceStore implements DurableIssuanceStore {
	readonly #issued = new Map<string, DurableIssueCommit>();
	readonly #lineages = new Map<string, DurableLineage>();
	readonly #outbox = new Map<string, DurableIssuanceOutboxRecord>();
	#closed = false;
	readonly #poison?: IssuanceFailure;

	constructor(options: EphemeralDurableIssuanceStoreOptions = {}) {
		let poison = options.initialPoison === "recovery-corrupt" ? recoveryPoison() : undefined;
		for (const initial of options.initialLineages ?? []) {
			validateScope(initial.scope);
			validateLineage(initial);
			if (!isSemanticallyValidLineage(initial)) {
				poison ??= recoveryPoison();
				continue;
			}
			this.#lineages.set(scopeKey(initial.scope), {
				exhausted: initial.exhausted,
				next: initial.next,
			});
		}
		if (poison !== undefined) this.#poison = poison;
	}

	async close(): Promise<void> {
		await Promise.resolve();
		this.#closed = true;
	}

	async readIssued(scope: DurableIssueScope, authorSequence: number): Promise<DurableIssueCommit | null> {
		await Promise.resolve();
		this.#assertAvailable();
		validateScope(scope);
		if (!validOrdinal(authorSequence)) throw new InvalidArgumentFailure("authorSequence must be a safe ordinal");
		const record = this.#issued.get(recordKey(scope, authorSequence));
		return record === undefined ? null : cloneCommit(record);
	}

	async readLineage(scope: DurableIssueScope): Promise<DurableLineage> {
		await Promise.resolve();
		this.#assertAvailable();
		validateScope(scope);
		return cloneLineage(this.#lineages.get(scopeKey(scope)) ?? { exhausted: false, next: 0 });
	}

	async readOutboxPage(input: DurableOutboxPageInput = {}): Promise<readonly DurableIssuanceOutboxRecord[]> {
		await Promise.resolve();
		this.#assertAvailable();
		if (!isClosedOutboxPageInput(input)) {
			throw new InvalidArgumentFailure("page input must contain only own enumerable data options");
		}
		const pageInput = input as DurableOutboxPageInput;
		if (pageInput.scope !== undefined) validateScope(pageInput.scope);
		const limit = pageInput.limit === undefined ? DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT : pageInput.limit;
		if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT) {
			throw new InvalidArgumentFailure("page limit is outside the closed range");
		}
		const afterKey = pageInput.afterKey ?? null;
		if (
			afterKey !== null &&
			(!Array.isArray(afterKey) ||
				afterKey.length !== 3 ||
				!validScopeField(afterKey[0]) ||
				!validScopeField(afterKey[1]) ||
				!validOrdinal(afterKey[2]))
		) {
			throw new InvalidArgumentFailure("afterKey must be a valid compound issuance key");
		}
		const validatedAfterKey = afterKey as CompoundKey | null;
		return [...this.#outbox.values()]
			.filter((record) => pageInput.scope === undefined || sameScope(record.commit.outboxEntry.scope, pageInput.scope))
			.sort((left, right) => compareCompoundKey(outboxKey(left), outboxKey(right)))
			.filter((record) => validatedAfterKey === null || compareCompoundKey(outboxKey(record), validatedAfterKey) > 0)
			.slice(0, limit)
			.map((record) => ({ commit: cloneCommit(record.commit), publishState: record.publishState }));
	}

	async transactIssue(scope: DurableIssueScope, buildAndSign: DurableBuildAndSign): Promise<DurableIssueCommit> {
		this.#assertAvailable();
		validateScope(scope);
		if (typeof buildAndSign !== "function") {
			throw new InvalidArgumentFailure("buildAndSign must be a function");
		}
		const detachedScope = cloneScope(scope);
		const key = scopeKey(detachedScope);
		const prior = cloneLineage(this.#lineages.get(key) ?? { exhausted: false, next: 0 });
		if (prior.exhausted) throw failure("ISSUANCE_EXHAUSTED", "author sequence lineage is exhausted");

		const candidate = copyAndValidateCommit(await buildAndSign(prior.next), detachedScope, prior.next);
		this.#assertAvailable();
		const current = this.#lineages.get(key) ?? { exhausted: false, next: 0 };
		if (!sameLineage(current, prior)) {
			throw failure("ISSUANCE_RETRY_REQUIRED", "author sequence lineage changed during signing");
		}
		const durableKey = recordKey(detachedScope, prior.next);
		if (this.#issued.has(durableKey) || this.#outbox.has(durableKey)) {
			throw failure("ISSUANCE_RECOVERY_CORRUPT", "issuance key already exists at the selected lineage");
		}
		const durable = cloneCommit(candidate);
		this.#lineages.set(key, {
			exhausted: prior.next === Number.MAX_SAFE_INTEGER,
			next: prior.next === Number.MAX_SAFE_INTEGER ? prior.next : prior.next + 1,
		});
		this.#issued.set(durableKey, durable);
		this.#outbox.set(durableKey, { commit: durable, publishState: "pending" });
		return cloneCommit(durable);
	}

	#assertAvailable(): void {
		if (this.#poison !== undefined) throw this.#poison;
		if (this.#closed) throw failure("ISSUANCE_STORE_CLOSED", "durable issuance store is closed");
	}
}

function consumed(lineage: DurableLineage, ordinal: number): boolean {
	return lineage.next > ordinal || (lineage.exhausted && lineage.next === ordinal);
}

function recordMatches(record: DurableIssuedRecord, expected: DurableIssuedRecord, requireEnvelope: boolean): boolean {
	return (
		record.authorSequence === expected.authorSequence &&
		sameScope(record.scope, expected.scope) &&
		(!requireEnvelope ||
			(bytesEqual(record.envelope.canonicalPreimageBytes, expected.envelope.canonicalPreimageBytes) &&
				bytesEqual(record.envelope.digest, expected.envelope.digest) &&
				bytesEqual(record.envelope.signature, expected.envelope.signature)))
	);
}

function copyNativeOutboxRecord(value: unknown): NativeOutboxRecord | undefined {
	if (
		!isRecord(value, ["authorSequence", "digest", "publishState", "scope"]) ||
		!validOrdinal(value.authorSequence) ||
		(value.publishState !== "pending" && value.publishState !== "published")
	) {
		return undefined;
	}
	const digest = copyBytes(value.digest);
	try {
		validateScope(value.scope);
	} catch {
		return undefined;
	}
	if (digest === undefined) return undefined;
	return {
		authorSequence: value.authorSequence,
		digest,
		publishState: value.publishState,
		scope: cloneScope(value.scope),
	};
}

function outboxMatchesIssued(outbox: NativeOutboxRecord, issued: DurableIssuedRecord): boolean {
	return (
		outbox.authorSequence === issued.authorSequence &&
		sameScope(outbox.scope, issued.scope) &&
		bytesEqual(outbox.digest, issued.envelope.digest) &&
		(outbox.publishState === "pending" || outbox.publishState === "published")
	);
}

/**
 * Classifies one bounded terminal-suppression readback without persisting an attempt token.
 * @param input - Private candidate, prior lineage and one consistent durable observation.
 * @returns The detached durable candidate when the observation proves it committed.
 */
export function classifyTerminalSuppression(input: TerminalClassificationInput): DurableIssueCommit {
	validateScope(input.scope);
	const scope = cloneScope(input.scope);
	const priorLineage = copyExactLineage(input.priorLineage, "caller");
	if (priorLineage.exhausted) {
		throw new InvalidArgumentFailure("prior lineage must remain selectable during terminal classification");
	}
	let candidate: DurableIssueCommit;
	try {
		candidate = copyAndValidateCommit(input.candidate, scope, priorLineage.next);
	} catch {
		throw new InvalidArgumentFailure("candidate must close the exact prior-lineage ordinal");
	}
	if ("unreadable" in input.observation) throw new UnknownOutcomeFailure(scope);
	const { issuedRecord, lineage, outboxRecord } = input.observation;
	const observedLineage = copyExactLineage(lineage, "durable-observation");
	const isConsumed = consumed(observedLineage, candidate.authorSequence);
	const observedIssued = issuedRecord === null ? null : copyIssuedRecord(issuedRecord);
	const observedOutbox = outboxRecord === null ? null : copyNativeOutboxRecord(outboxRecord);
	if (
		(issuedRecord !== null && observedIssued === undefined) ||
		(outboxRecord !== null && observedOutbox === undefined)
	) {
		throw failure("ISSUANCE_RECOVERY_CORRUPT", "terminal readback contains a malformed durable row");
	}

	if (
		observedIssued !== null &&
		observedIssued !== undefined &&
		observedOutbox !== null &&
		observedOutbox !== undefined &&
		isConsumed &&
		recordMatches(observedIssued, candidate.issuedRecord, true) &&
		outboxMatchesIssued(observedOutbox, observedIssued)
	) {
		return cloneCommit(candidate);
	}
	if (issuedRecord === null && outboxRecord === null && sameLineage(observedLineage, priorLineage)) {
		throw failure("ISSUANCE_SUBSTRATE_FAILURE", "commit was definitively not applied", "transient");
	}
	if (
		observedIssued !== null &&
		observedIssued !== undefined &&
		observedOutbox !== null &&
		observedOutbox !== undefined &&
		isConsumed &&
		recordMatches(observedIssued, candidate.issuedRecord, false) &&
		preimageMatches(observedIssued.envelope.canonicalPreimageBytes, scope, candidate.authorSequence) &&
		outboxMatchesIssued(observedOutbox, observedIssued)
	) {
		throw failure("ISSUANCE_RETRY_REQUIRED", "another candidate committed the selected ordinal");
	}
	throw failure("ISSUANCE_RECOVERY_CORRUPT", "terminal readback does not form one durable closure");
}

/**
 * Creates the explicitly non-durable conformance control used by backend-independent tests.
 * @param options - Optional initial lineage and corruption state.
 * @returns A fresh ephemeral implementation of the durable issuance shape.
 */
export function createEphemeralDurableIssuanceStore(
	options: EphemeralDurableIssuanceStoreOptions = {}
): DurableIssuanceStore {
	const implementation = new EphemeralDurableIssuanceStore(options);
	return {
		close: () => implementation.close(),
		readIssued: (scope, authorSequence) => implementation.readIssued(scope, authorSequence),
		readLineage: (scope) => implementation.readLineage(scope),
		readOutboxPage: (input) => implementation.readOutboxPage(input),
		transactIssue: (scope, buildAndSign) => implementation.transactIssue(scope, buildAndSign),
	};
}
