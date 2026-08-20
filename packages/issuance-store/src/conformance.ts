import {
	cloneDurableIssueCommit as cloneCommit,
	copyDurableIssueScope as cloneScope,
	isClosedDurableIssuanceRecord as closedRecord,
	compareDurableIssuanceCompoundKeys as compareCompoundKey,
	type DurableIssuanceCompoundKey as CompoundKey,
	copyAndValidateDurableIssueCommit as copyAndValidateCommit,
	copyDurableIssuanceBytes as copyBytes,
	createDurableIssuanceFailure as failure,
	DurableIssuanceInvalidArgumentError as InvalidArgumentFailure,
	type DurableIssuanceContractError as IssuanceFailure,
	durablePreimageMatchesScopeAndSequence as preimageMatches,
	durableIssuanceBytesEqual as sameBytes,
	durableIssueScopesEqual as sameScope,
	assertDurableIssueScope as validateScope,
	isValidDurableAuthorSequence as validOrdinal,
	isValidDurableScopeField as validScopeField,
} from "./contract.js";
import { DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT, MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT } from "./types.js";
import type {
	DurableBuildAndSign,
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
	DurableLineage,
	DurableOutboxPageInput,
	DurableOutboxPublicationTransitionInput,
} from "./types.js";

export {
	classifyDurableIssuanceTerminalSuppression as classifyTerminalSuppression,
	type DurableIssuanceTerminalClassificationInput as TerminalClassificationInput,
	type DurableIssuanceTerminalObservation as TerminalObservation,
} from "./terminal.js";

export { DURABLE_ISSUANCE_ERROR_CODES, DURABLE_ISSUANCE_RETRY_CLASSES } from "./types.js";

export const TERMINAL_SUPPRESSION_AMBIGUITY_CASES = Object.freeze(
	(["browser", "node"] as const).flatMap((backend) =>
		(["exact-pair", "absent-old", "foreign-pair", "torn-or-inconsistent", "unreadable"] as const).map((edge) =>
			Object.freeze([backend, edge] as const)
		)
	)
);

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

function capturePublicationInput(input: unknown): DurableOutboxPublicationTransitionInput {
	try {
		if (!closedRecord(input, ["authorSequence", "digest", "scope"])) {
			throw new InvalidArgumentFailure("publication input must be an exact own-data record");
		}
		validateScope(input.scope);
		const scope = cloneScope(input.scope);
		if (!validOrdinal(input.authorSequence)) {
			throw new InvalidArgumentFailure("publication input contains an invalid ordinal");
		}
		const digest = copyBytes(input.digest);
		if (digest === undefined) throw new InvalidArgumentFailure("publication input contains an invalid digest");
		return { authorSequence: input.authorSequence, digest, scope };
	} catch (error) {
		if (error instanceof InvalidArgumentFailure) throw error;
		throw new InvalidArgumentFailure("publication input could not be inspected as a closed record");
	}
}

class EphemeralDurableIssuanceStore implements DurableIssuanceStore {
	readonly #issued = new Map<string, DurableIssueCommit>();
	readonly #lineages = new Map<string, DurableLineage>();
	readonly #outbox = new Map<string, DurableIssuanceOutboxRecord>();
	#closed = false;
	#poison?: IssuanceFailure;

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

	// Async is intentional: all capability failures are Promise rejections.
	// eslint-disable-next-line @typescript-eslint/require-await
	async compareAndMarkOutboxPublished(input: DurableOutboxPublicationTransitionInput): Promise<void> {
		// Backends add ISSUANCE_SUBSTRATE_FAILURE and ISSUANCE_OUTCOME_UNKNOWN;
		// every owner retains ISSUANCE_INVALID_ARGUMENT, ISSUANCE_RECOVERY_CORRUPT,
		// and ISSUANCE_STORE_CLOSED with the same precedence.
		this.#assertAvailable();
		const { authorSequence, digest, scope } = capturePublicationInput(input);
		const key = recordKey(scope, authorSequence);
		const issued = this.#issued.get(key);
		const outbox = this.#outbox.get(key);
		const lineage = this.#lineages.get(scopeKey(scope)) ?? { exhausted: false, next: 0 };
		const consumed = lineage.next > authorSequence || (lineage.exhausted && lineage.next === authorSequence);
		if (issued === undefined && outbox === undefined && !consumed) {
			throw new InvalidArgumentFailure("publication address has never been issued");
		}
		if (issued === undefined || outbox === undefined || !consumed) throw this.#latchCorruption();
		const commit = outbox.commit;
		const complete =
			commit.authorSequence === authorSequence &&
			issued.authorSequence === authorSequence &&
			sameScope(commit.outboxEntry.scope, scope) &&
			sameScope(commit.issuedRecord.scope, scope) &&
			sameScope(issued.outboxEntry.scope, scope) &&
			sameScope(issued.issuedRecord.scope, scope) &&
			sameBytes(commit.envelope.digest, issued.envelope.digest) &&
			sameBytes(commit.envelope.digest, commit.outboxEntry.envelope.digest) &&
			sameBytes(commit.envelope.digest, commit.issuedRecord.envelope.digest) &&
			preimageMatches(issued.envelope.canonicalPreimageBytes, scope, authorSequence);
		if (!complete) throw this.#latchCorruption();
		if (!sameBytes(commit.envelope.digest, digest)) {
			throw new InvalidArgumentFailure("publication digest does not identify the issued closure");
		}
		if (outbox.publishState === "pending") {
			this.#outbox.set(key, { commit, publishState: "published" });
		}
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

	#latchCorruption(): IssuanceFailure {
		this.#poison ??= recoveryPoison();
		return this.#poison;
	}
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
		compareAndMarkOutboxPublished: (input) => implementation.compareAndMarkOutboxPublished(input),
		readIssued: (scope, authorSequence) => implementation.readIssued(scope, authorSequence),
		readLineage: (scope) => implementation.readLineage(scope),
		readOutboxPage: (input) => implementation.readOutboxPage(input),
		transactIssue: (scope, buildAndSign) => implementation.transactIssue(scope, buildAndSign),
	};
}
