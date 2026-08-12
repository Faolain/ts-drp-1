import {
	assertDurableIssueScope,
	classifyDurableIssuanceTerminalSuppression,
	cloneDurableIssueCommit,
	compareDurableIssuanceCompoundKeys,
	copyAndValidateDurableIssueCommit,
	copyDurableIssuanceBytes,
	copyDurableIssueScope,
	createDurableIssuanceFailure,
	DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT,
	type DurableBuildAndSign,
	DurableIssuanceContractError,
	DurableIssuanceInvalidArgumentError,
	type DurableIssuanceNativeOutboxRecord,
	type DurableIssuanceOutboxRecord,
	type DurableIssuanceStore,
	type DurableIssueCommit,
	type DurableIssuedRecord,
	type DurableIssueScope,
	type DurableLineage,
	type DurableOutboxPageInput,
	isClosedDurableIssuanceRecord,
	isValidDurableAuthorSequence,
	isValidDurableScopeField,
	MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT,
} from "@ts-drp/issuance-store";

const DATABASE_SUFFIX = "--drp-issuance-v1";
const DATABASE_VERSION = 1;
const STORE_NAMES = ["lineages", "issuedRecords", "issuanceOutbox"] as const;
const LINEAGE_KEY_PATH = ["objectId", "author"] as const;
const RECORD_KEY_PATH = ["objectId", "author", "authorSequence"] as const;

interface NativeLineage extends DurableLineage, DurableIssueScope {}

interface NativeIssuedRecord extends DurableIssueScope {
	readonly authorSequence: number;
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

interface NativeOutboxRecord extends DurableIssueScope {
	readonly authorSequence: number;
	readonly digest: Uint8Array;
	readonly publishState: "pending" | "published";
}

interface TerminalReadback {
	readonly issuedRecord: DurableIssuedRecord | null;
	readonly lineage: DurableLineage;
	readonly outboxRecord: DurableIssuanceNativeOutboxRecord | null;
}

function invalid(message: string): DurableIssuanceInvalidArgumentError {
	return new DurableIssuanceInvalidArgumentError(message);
}

function substrate(
	message: string,
	retryClass: "transient" | "resource-exhausted" | "permanent"
): DurableIssuanceContractError {
	return createDurableIssuanceFailure("ISSUANCE_SUBSTRATE_FAILURE", message, retryClass);
}

function errorName(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && typeof Reflect.get(error, "name") === "string"
		? (Reflect.get(error, "name") as string)
		: undefined;
}

function mapOpenError(error: unknown): Error {
	const name = errorName(error);
	if (name === "VersionError" || name === "AbortError") {
		return createDurableIssuanceFailure("ISSUANCE_UNSUPPORTED_SCHEMA", "issuance database schema is unsupported");
	}
	if (name === "QuotaExceededError") return substrate("issuance database quota is exhausted", "resource-exhausted");
	return substrate("issuance database could not be opened", "transient");
}

function mapSubstrateError(error: unknown, message: string): Error {
	if (errorName(error) === "QuotaExceededError") return substrate(message, "resource-exhausted");
	return substrate(message, "transient");
}

function sameKeyPath(actual: string | string[] | null, expected: readonly string[]): boolean {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((part, index) => part === expected[index])
	);
}

function verifyStore(store: IDBObjectStore, keyPath: readonly string[]): void {
	if (store.autoIncrement || !sameKeyPath(store.keyPath, keyPath) || store.indexNames.length !== 0) {
		throw createDurableIssuanceFailure("ISSUANCE_UNSUPPORTED_SCHEMA", `unsupported ${store.name} schema`);
	}
}

function exactStoreNames(database: IDBDatabase): boolean {
	const actual = [...database.objectStoreNames].sort();
	const expected = [...STORE_NAMES].sort();
	return actual.length === expected.length && expected.every((name, index) => actual[index] === name);
}

function captureOptions(value: unknown): string {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw invalid("options must be a plain record");
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw invalid("options must be a plain record");
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 1 || keys[0] !== "primaryDatabaseName")
			throw invalid("options must contain only primaryDatabaseName");
		const descriptor = Object.getOwnPropertyDescriptor(value, "primaryDatabaseName");
		if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
			throw invalid("primaryDatabaseName must be an enumerable data property");
		}
		if (typeof descriptor.value !== "string" || descriptor.value.length === 0) {
			throw invalid("primaryDatabaseName must be a non-empty primitive string");
		}
		return descriptor.value;
	} catch (error) {
		if (error instanceof DurableIssuanceInvalidArgumentError) throw error;
		throw invalid("options could not be inspected as a closed record");
	}
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener(
			"abort",
			() => reject(transaction.error ?? new DOMException("transaction aborted", "AbortError")),
			{
				once: true,
			}
		);
		transaction.addEventListener(
			"error",
			() => reject(transaction.error ?? new DOMException("transaction failed", "AbortError")),
			{
				once: true,
			}
		);
	});
}

function strictTransaction(database: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
	let transaction: IDBTransaction;
	try {
		transaction = database.transaction([...STORE_NAMES], mode, { durability: "strict" });
	} catch (error) {
		throw mapSubstrateError(error, "strict issuance transaction is unavailable");
	}
	if (mode === "readwrite" && transaction.durability !== "strict") {
		try {
			transaction.abort();
		} catch {
			// The transaction may already have become inactive.
		}
		throw createDurableIssuanceFailure("ISSUANCE_DURABILITY_UNAVAILABLE", "IndexedDB did not retain strict durability");
	}
	return transaction;
}

function copyNativeLineage(value: unknown, scope: DurableIssueScope): DurableLineage | undefined {
	if (
		!isClosedDurableIssuanceRecord(value, ["author", "exhausted", "next", "objectId"]) ||
		value.author !== scope.author ||
		value.objectId !== scope.objectId ||
		typeof value.exhausted !== "boolean" ||
		!isValidDurableAuthorSequence(value.next) ||
		(value.exhausted && value.next !== Number.MAX_SAFE_INTEGER)
	) {
		return undefined;
	}
	return { exhausted: value.exhausted, next: value.next };
}

function copyNativeIssued(value: unknown): NativeIssuedRecord | undefined {
	if (
		!isClosedDurableIssuanceRecord(value, [
			"author",
			"authorSequence",
			"canonicalPreimageBytes",
			"digest",
			"objectId",
			"signature",
		]) ||
		!isValidDurableScopeField(value.author) ||
		!isValidDurableScopeField(value.objectId) ||
		!isValidDurableAuthorSequence(value.authorSequence)
	) {
		return undefined;
	}
	const canonicalPreimageBytes = copyDurableIssuanceBytes(value.canonicalPreimageBytes);
	const digest = copyDurableIssuanceBytes(value.digest);
	const signature = copyDurableIssuanceBytes(value.signature);
	if (canonicalPreimageBytes === undefined || digest === undefined || signature === undefined) return undefined;
	return {
		author: value.author,
		authorSequence: value.authorSequence,
		canonicalPreimageBytes,
		digest,
		objectId: value.objectId,
		signature,
	};
}

function copyNativeOutbox(value: unknown): NativeOutboxRecord | undefined {
	if (
		!isClosedDurableIssuanceRecord(value, ["author", "authorSequence", "digest", "objectId", "publishState"]) ||
		!isValidDurableScopeField(value.author) ||
		!isValidDurableScopeField(value.objectId) ||
		!isValidDurableAuthorSequence(value.authorSequence) ||
		(value.publishState !== "pending" && value.publishState !== "published")
	) {
		return undefined;
	}
	const digest = copyDurableIssuanceBytes(value.digest);
	if (digest === undefined) return undefined;
	return {
		author: value.author,
		authorSequence: value.authorSequence,
		digest,
		objectId: value.objectId,
		publishState: value.publishState,
	};
}

function commitFromIssued(row: NativeIssuedRecord): DurableIssueCommit {
	const scope = { author: row.author, objectId: row.objectId };
	const envelope = {
		canonicalPreimageBytes: new Uint8Array(row.canonicalPreimageBytes),
		digest: new Uint8Array(row.digest),
		signature: new Uint8Array(row.signature),
	};
	return cloneDurableIssueCommit({
		authorSequence: row.authorSequence,
		envelope,
		issuedRecord: { authorSequence: row.authorSequence, envelope, scope },
		outboxEntry: { authorSequence: row.authorSequence, envelope, scope },
	});
}

function nativeIssued(candidate: DurableIssueCommit): NativeIssuedRecord {
	return {
		...copyDurableIssueScope(candidate.issuedRecord.scope),
		authorSequence: candidate.authorSequence,
		canonicalPreimageBytes: new Uint8Array(candidate.envelope.canonicalPreimageBytes),
		digest: new Uint8Array(candidate.envelope.digest),
		signature: new Uint8Array(candidate.envelope.signature),
	};
}

function nativeOutbox(candidate: DurableIssueCommit): NativeOutboxRecord {
	return {
		...copyDurableIssueScope(candidate.outboxEntry.scope),
		authorSequence: candidate.authorSequence,
		digest: new Uint8Array(candidate.envelope.digest),
		publishState: "pending",
	};
}

function sameLineage(left: DurableLineage, right: DurableLineage): boolean {
	return left.next === right.next && left.exhausted === right.exhausted;
}

function lineageConsumed(lineage: DurableLineage, authorSequence: number): boolean {
	return lineage.next > authorSequence || (lineage.exhausted && lineage.next === authorSequence);
}

class BrowserIssuanceImplementation {
	readonly #database: IDBDatabase;
	readonly #transactions = new Set<IDBTransaction>();
	#closed = false;
	#closePromise?: Promise<void>;
	#resolveClose?: () => void;
	#poison?: DurableIssuanceContractError;

	constructor(database: IDBDatabase) {
		this.#database = database;
	}

	close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		this.#closed = true;
		this.#database.onversionchange = null;
		this.#database.close();
		this.#closePromise = new Promise<void>((resolve) => {
			this.#resolveClose = resolve;
			this.#finishCloseIfIdle();
		});
		return this.#closePromise;
	}

	versionchange(): void {
		void this.close();
	}

	async readLineage(scope: DurableIssueScope): Promise<DurableLineage> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		const detached = copyDurableIssueScope(scope);
		const transaction = this.#startTransaction("readonly");
		try {
			const raw = await requestResult(transaction.objectStore("lineages").get([detached.objectId, detached.author]));
			await transactionResult(transaction);
			if (raw === undefined) return { exhausted: false, next: 0 };
			const lineage = copyNativeLineage(raw, detached);
			if (lineage === undefined) throw this.#latchCorruption("stored lineage is malformed");
			return lineage;
		} catch (error) {
			if (this.#isClosedFailure(error)) throw error;
			throw mapSubstrateError(error, "lineage read failed");
		}
	}

	async readIssued(scope: DurableIssueScope, authorSequence: number): Promise<DurableIssueCommit | null> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		if (!isValidDurableAuthorSequence(authorSequence)) throw invalid("authorSequence must be a safe ordinal");
		const detached = copyDurableIssueScope(scope);
		const transaction = this.#startTransaction("readonly");
		try {
			const key = [detached.objectId, detached.author, authorSequence];
			const [rawIssued, rawOutbox, rawLineage] = await Promise.all([
				requestResult(transaction.objectStore("issuedRecords").get(key)),
				requestResult(transaction.objectStore("issuanceOutbox").get(key)),
				requestResult(transaction.objectStore("lineages").get([detached.objectId, detached.author])),
			]);
			await transactionResult(transaction);
			if (rawIssued === undefined && rawOutbox === undefined) return null;
			const row = rawIssued === undefined ? undefined : copyNativeIssued(rawIssued);
			const outbox = rawOutbox === undefined ? undefined : copyNativeOutbox(rawOutbox);
			const lineage =
				rawLineage === undefined ? { exhausted: false, next: 0 } : copyNativeLineage(rawLineage, detached);
			if (
				row === undefined ||
				outbox === undefined ||
				lineage === undefined ||
				row.objectId !== detached.objectId ||
				row.author !== detached.author ||
				row.authorSequence !== authorSequence ||
				outbox.objectId !== detached.objectId ||
				outbox.author !== detached.author ||
				outbox.authorSequence !== authorSequence ||
				!this.#bytesEqual(row.digest, outbox.digest) ||
				!(lineage.next > authorSequence || (lineage.exhausted && lineage.next === authorSequence))
			) {
				throw this.#latchCorruption("stored issued closure is incomplete or malformed");
			}
			return commitFromIssued(row);
		} catch (error) {
			if (this.#isClosedFailure(error)) throw error;
			throw mapSubstrateError(error, "issued-record read failed");
		}
	}

	async readOutboxPage(input: DurableOutboxPageInput = {}): Promise<readonly DurableIssuanceOutboxRecord[]> {
		this.#assertAvailable();
		const parsed = this.#parsePageInput(input);
		const transaction = this.#startTransaction("readonly");
		try {
			const [nativeRows, issuedRows, lineageRows] = await Promise.all([
				requestResult(transaction.objectStore("issuanceOutbox").getAll()),
				requestResult(transaction.objectStore("issuedRecords").getAll()),
				requestResult(transaction.objectStore("lineages").getAll()),
			]);
			await transactionResult(transaction);
			const lineageByScope = new Map<string, DurableLineage>();
			for (const raw of lineageRows) {
				if (
					!isClosedDurableIssuanceRecord(raw, ["author", "exhausted", "next", "objectId"]) ||
					!isValidDurableScopeField(raw.author) ||
					!isValidDurableScopeField(raw.objectId)
				) {
					throw this.#latchCorruption("stored lineage is malformed");
				}
				const scope = { author: raw.author, objectId: raw.objectId };
				const lineage = copyNativeLineage(raw, scope);
				const key = this.#scopeKey(scope);
				if (lineage === undefined || lineageByScope.has(key)) {
					throw this.#latchCorruption("stored lineage is malformed");
				}
				lineageByScope.set(key, lineage);
			}
			const issuedByKey = new Map<string, NativeIssuedRecord>();
			for (const raw of issuedRows) {
				const row = copyNativeIssued(raw);
				if (row === undefined) throw this.#latchCorruption("stored issued record is malformed");
				issuedByKey.set(this.#recordKey(row, row.authorSequence), row);
			}
			const records: DurableIssuanceOutboxRecord[] = [];
			for (const raw of nativeRows) {
				const outbox = copyNativeOutbox(raw);
				if (outbox === undefined) throw this.#latchCorruption("stored outbox record is malformed");
				const issued = issuedByKey.get(this.#recordKey(outbox, outbox.authorSequence));
				if (issued === undefined || !this.#bytesEqual(issued.digest, outbox.digest)) {
					throw this.#latchCorruption("outbox has no matching issued record");
				}
				const lineage = lineageByScope.get(this.#scopeKey(outbox));
				if (lineage === undefined || !lineageConsumed(lineage, outbox.authorSequence)) {
					throw this.#latchCorruption("stored outbox closure was not consumed by lineage");
				}
				issuedByKey.delete(this.#recordKey(outbox, outbox.authorSequence));
				const commit = commitFromIssued(issued);
				records.push({ commit, publishState: outbox.publishState });
			}
			if (issuedByKey.size !== 0) throw this.#latchCorruption("issued record has no matching outbox entry");
			return records
				.filter(({ commit }) => parsed.scope === undefined || this.#sameScope(commit.outboxEntry.scope, parsed.scope))
				.sort((left, right) =>
					compareDurableIssuanceCompoundKeys(this.#commitKey(left.commit), this.#commitKey(right.commit))
				)
				.filter(
					({ commit }) =>
						parsed.afterKey === null || compareDurableIssuanceCompoundKeys(this.#commitKey(commit), parsed.afterKey) > 0
				)
				.slice(0, parsed.limit)
				.map(({ commit, publishState }) => ({ commit: cloneDurableIssueCommit(commit), publishState }));
		} catch (error) {
			if (this.#isClosedFailure(error)) throw error;
			throw mapSubstrateError(error, "outbox read failed");
		}
	}

	async transactIssue(scope: DurableIssueScope, buildAndSign: DurableBuildAndSign): Promise<DurableIssueCommit> {
		this.#assertAvailable();
		assertDurableIssueScope(scope);
		if (typeof buildAndSign !== "function") throw invalid("buildAndSign must be a function");
		const detached = copyDurableIssueScope(scope);
		const prior = await this.readLineage(detached);
		if (prior.exhausted) throw createDurableIssuanceFailure("ISSUANCE_EXHAUSTED", "author sequence is exhausted");
		const built = await buildAndSign(prior.next);
		const candidate = copyAndValidateDurableIssueCommit(built, detached, prior.next);
		this.#assertAvailable();
		return this.#commitCandidate(detached, prior, candidate);
	}

	async terminalObservationForTest(scope: DurableIssueScope, authorSequence: number): Promise<TerminalReadback> {
		return this.#readTerminal(scope, authorSequence);
	}

	async #commitCandidate(
		scope: DurableIssueScope,
		prior: DurableLineage,
		candidate: DurableIssueCommit
	): Promise<DurableIssueCommit> {
		let transaction: IDBTransaction;
		try {
			transaction = this.#startTransaction("readwrite");
		} catch (error) {
			this.#assertAvailable();
			throw error;
		}
		let reason: Error | undefined;
		const terminal = transactionResult(transaction);
		try {
			const lineages = transaction.objectStore("lineages");
			const issued = transaction.objectStore("issuedRecords");
			const outbox = transaction.objectStore("issuanceOutbox");
			const rawPrior = await requestResult(lineages.get([scope.objectId, scope.author]));
			const current = rawPrior === undefined ? { exhausted: false, next: 0 } : copyNativeLineage(rawPrior, scope);
			if (current === undefined) {
				reason = this.#latchCorruption("stored lineage is malformed");
				transaction.abort();
			} else if (!sameLineage(current, prior)) {
				reason = createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", "author sequence changed while signing");
				transaction.abort();
			} else {
				const next: NativeLineage = {
					...scope,
					exhausted: prior.next === Number.MAX_SAFE_INTEGER,
					next: prior.next === Number.MAX_SAFE_INTEGER ? prior.next : prior.next + 1,
				};
				await requestResult(rawPrior === undefined ? lineages.add(next) : lineages.put(next));
				await requestResult(issued.add(nativeIssued(candidate)));
				await requestResult(outbox.add(nativeOutbox(candidate)));
			}
			await terminal;
			if (reason !== undefined) throw reason;
			const observation = await this.#readTerminal(scope, candidate.authorSequence);
			return classifyDurableIssuanceTerminalSuppression({ candidate, observation, priorLineage: prior, scope });
		} catch {
			await terminal.catch(() => undefined);
			if (reason !== undefined) throw reason;
			if (this.#poison !== undefined) throw this.#poison;
			let observation: TerminalReadback;
			try {
				observation = await this.#readTerminal(scope, candidate.authorSequence);
			} catch {
				if (this.#closed || this.#poison !== undefined) this.#assertAvailable();
				return classifyDurableIssuanceTerminalSuppression({
					candidate,
					observation: { unreadable: true },
					priorLineage: prior,
					scope,
				});
			}
			try {
				return classifyDurableIssuanceTerminalSuppression({ candidate, observation, priorLineage: prior, scope });
			} catch (classified) {
				if (this.#hasCode(classified, "ISSUANCE_RECOVERY_CORRUPT")) {
					throw this.#latchCorruption("terminal issuance readback is corrupt");
				}
				throw classified;
			}
		}
	}

	async #readTerminal(scope: DurableIssueScope, authorSequence: number): Promise<TerminalReadback> {
		const transaction = this.#startTransaction("readonly");
		const key = [scope.objectId, scope.author, authorSequence];
		const [rawLineage, rawIssued, rawOutbox] = await Promise.all([
			requestResult(transaction.objectStore("lineages").get([scope.objectId, scope.author])),
			requestResult(transaction.objectStore("issuedRecords").get(key)),
			requestResult(transaction.objectStore("issuanceOutbox").get(key)),
		]);
		await transactionResult(transaction);
		const lineage = rawLineage === undefined ? { exhausted: false, next: 0 } : copyNativeLineage(rawLineage, scope);
		const issued = rawIssued === undefined ? null : copyNativeIssued(rawIssued);
		const outbox = rawOutbox === undefined ? null : copyNativeOutbox(rawOutbox);
		if (lineage === undefined || issued === undefined || outbox === undefined) {
			throw this.#latchCorruption("terminal readback contains a malformed row");
		}
		return {
			issuedRecord:
				issued === null
					? null
					: {
							authorSequence: issued.authorSequence,
							envelope: {
								canonicalPreimageBytes: issued.canonicalPreimageBytes,
								digest: issued.digest,
								signature: issued.signature,
							},
							scope: { author: issued.author, objectId: issued.objectId },
						},
			lineage,
			outboxRecord:
				outbox === null
					? null
					: {
							authorSequence: outbox.authorSequence,
							digest: outbox.digest,
							publishState: outbox.publishState,
							scope: { author: outbox.author, objectId: outbox.objectId },
						},
		};
	}

	#startTransaction(mode: IDBTransactionMode): IDBTransaction {
		this.#assertAvailable();
		const transaction = strictTransaction(this.#database, mode);
		this.#transactions.add(transaction);
		const settled = (): void => {
			this.#transactions.delete(transaction);
			this.#finishCloseIfIdle();
		};
		transaction.addEventListener("complete", settled, { once: true });
		transaction.addEventListener("abort", settled, { once: true });
		return transaction;
	}

	#finishCloseIfIdle(): void {
		if (this.#closed && this.#transactions.size === 0) this.#resolveClose?.();
	}

	#assertAvailable(): void {
		if (this.#poison !== undefined) throw this.#poison;
		if (this.#closed) throw createDurableIssuanceFailure("ISSUANCE_STORE_CLOSED", "durable issuance store is closed");
	}

	#latchCorruption(message: string): DurableIssuanceContractError {
		this.#poison ??= Object.freeze(createDurableIssuanceFailure("ISSUANCE_RECOVERY_CORRUPT", message));
		return this.#poison;
	}

	#parsePageInput(input: DurableOutboxPageInput): {
		afterKey: readonly [string, string, number] | null;
		limit: number;
		scope?: DurableIssueScope;
	} {
		if (!this.#closedPageInput(input)) throw invalid("page input must be a closed record");
		if (input.scope !== undefined) assertDurableIssueScope(input.scope);
		const limit = input.limit === undefined ? DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT : input.limit;
		if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT) {
			throw invalid("page limit is outside the closed range");
		}
		const afterKey = input.afterKey ?? null;
		if (
			afterKey !== null &&
			(!Array.isArray(afterKey) ||
				afterKey.length !== 3 ||
				!isValidDurableScopeField(afterKey[0]) ||
				!isValidDurableScopeField(afterKey[1]) ||
				!isValidDurableAuthorSequence(afterKey[2]))
		) {
			throw invalid("afterKey must be a valid compound key");
		}
		return {
			afterKey: afterKey as readonly [string, string, number] | null,
			limit,
			...(input.scope === undefined ? {} : { scope: copyDurableIssueScope(input.scope) }),
		};
	}

	#closedPageInput(value: unknown): value is DurableOutboxPageInput {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const allowed = ["afterKey", "limit", "scope"];
		return Reflect.ownKeys(value).every((key) => {
			if (typeof key !== "string" || !allowed.includes(key)) return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
		});
	}

	#recordKey(scope: DurableIssueScope, authorSequence: number): string {
		return `${scope.objectId.length}:${scope.objectId}${scope.author.length}:${scope.author}:${authorSequence}`;
	}

	#scopeKey(scope: DurableIssueScope): string {
		return `${scope.objectId.length}:${scope.objectId}${scope.author.length}:${scope.author}`;
	}

	#commitKey(commit: DurableIssueCommit): readonly [string, string, number] {
		return [commit.outboxEntry.scope.objectId, commit.outboxEntry.scope.author, commit.authorSequence];
	}

	#sameScope(left: DurableIssueScope, right: DurableIssueScope): boolean {
		return left.author === right.author && left.objectId === right.objectId;
	}

	#bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}

	#hasCode(error: unknown, code: string): boolean {
		return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
	}

	#isClosedFailure(error: unknown): boolean {
		return error === this.#poison || this.#hasCode(error, "ISSUANCE_STORE_CLOSED");
	}
}

const implementationByStore = new WeakMap<DurableIssuanceStore, BrowserIssuanceImplementation>();

async function openIssuanceDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		let upgraded = false;
		let settled = false;
		let request: IDBOpenDBRequest;
		try {
			request = globalThis.indexedDB.open(name, DATABASE_VERSION);
		} catch (error) {
			reject(mapOpenError(error));
			return;
		}
		request.addEventListener("upgradeneeded", (event) => {
			try {
				if (event.oldVersion !== 0 || request.result.objectStoreNames.length !== 0) {
					throw createDurableIssuanceFailure("ISSUANCE_UNSUPPORTED_SCHEMA", "issuance database cannot be upgraded");
				}
				upgraded = true;
				request.result.createObjectStore("lineages", { autoIncrement: false, keyPath: [...LINEAGE_KEY_PATH] });
				request.result.createObjectStore("issuedRecords", { autoIncrement: false, keyPath: [...RECORD_KEY_PATH] });
				request.result.createObjectStore("issuanceOutbox", { autoIncrement: false, keyPath: [...RECORD_KEY_PATH] });
			} catch (error) {
				request.transaction?.abort();
				if (!settled) {
					settled = true;
					reject(error);
				}
			}
		});
		request.addEventListener("blocked", () => {
			if (!settled) {
				settled = true;
				reject(substrate("issuance database open was blocked", "transient"));
			}
		});
		request.addEventListener("error", () => {
			if (!settled) {
				settled = true;
				reject(mapOpenError(request.error));
			}
		});
		request.addEventListener("success", () => {
			if (settled) {
				request.result.close();
				return;
			}
			settled = true;
			if (request.result.version !== DATABASE_VERSION || !exactStoreNames(request.result)) {
				request.result.close();
				reject(createDurableIssuanceFailure("ISSUANCE_UNSUPPORTED_SCHEMA", "issuance database shape is unsupported"));
				return;
			}
			void upgraded;
			resolve(request.result);
		});
	});
}

async function admitDatabase(database: IDBDatabase): Promise<void> {
	let transaction: IDBTransaction | undefined;
	try {
		transaction = strictTransaction(database, "readwrite");
		verifyStore(transaction.objectStore("lineages"), LINEAGE_KEY_PATH);
		verifyStore(transaction.objectStore("issuedRecords"), RECORD_KEY_PATH);
		verifyStore(transaction.objectStore("issuanceOutbox"), RECORD_KEY_PATH);
		await transactionResult(transaction);
	} catch (error) {
		try {
			transaction?.abort();
		} catch {
			// The admission transaction may already be terminal.
		}
		if (error instanceof DurableIssuanceContractError) throw error;
		throw mapSubstrateError(error, "issuance database admission failed");
	}
}

/**
 * Creates one strict-durability browser issuance capability over a dedicated derived IndexedDB database.
 * @param options - Untrusted exact browser factory options.
 * @returns The five-method shared issuance capability.
 */
export async function createBrowserDurableIssuanceStoreImplementation(options: unknown): Promise<DurableIssuanceStore> {
	const primaryDatabaseName = captureOptions(options);
	const database = await openIssuanceDatabase(`${primaryDatabaseName}${DATABASE_SUFFIX}`);
	const implementation = new BrowserIssuanceImplementation(database);
	database.onversionchange = (): void => implementation.versionchange();
	try {
		await admitDatabase(database);
		const store = Object.assign(Object.create(null) as DurableIssuanceStore, {
			close: (): Promise<void> => implementation.close(),
			readIssued: (scope: DurableIssueScope, authorSequence: number) =>
				implementation.readIssued(scope, authorSequence),
			readLineage: (scope: DurableIssueScope) => implementation.readLineage(scope),
			readOutboxPage: (input?: DurableOutboxPageInput) => implementation.readOutboxPage(input),
			transactIssue: (scope: DurableIssueScope, buildAndSign: DurableBuildAndSign) =>
				implementation.transactIssue(scope, buildAndSign),
		});
		implementationByStore.set(store, implementation);
		return store;
	} catch (error) {
		database.onversionchange = null;
		database.close();
		throw error;
	}
}

/**
 * Private test-only access to a consistent native terminal observation.
 * @internal
 * @param store - Candidate facade created by this module.
 * @returns Its private implementation, if owned by this module.
 */
export function browserIssuanceImplementationForTest(
	store: DurableIssuanceStore
): BrowserIssuanceImplementation | undefined {
	return implementationByStore.get(store);
}
