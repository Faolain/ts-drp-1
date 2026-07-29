import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0g2i/transactional-issuance-contract.json" with { type: "json" };
import blueprintContract from "./fixtures/phase-0i-v3/blueprint-admission-package.json" with { type: "json" };

interface IssueScope {
	readonly author: string;
	readonly objectId: string;
}

interface LocalVertexInput {
	readonly anchor: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly logicalTime: number;
	readonly objectId: string;
	readonly operation: Readonly<Record<string, unknown>>;
}

interface SignedVertexEnvelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

interface IssuedVertexRecord {
	readonly authorSequence: number;
	readonly envelope: SignedVertexEnvelope;
	readonly scope: IssueScope;
}

interface IssuanceOutboxEntry {
	readonly authorSequence: number;
	readonly envelope: SignedVertexEnvelope;
	readonly scope: IssueScope;
}

interface IssueCommit {
	readonly authorSequence: number;
	readonly envelope: SignedVertexEnvelope;
	readonly issuedRecord: IssuedVertexRecord;
	readonly outboxEntry: IssuanceOutboxEntry;
}

type BuildAndSign = (authorSequence: number) => Promise<IssueCommit>;
type TransactIssue = (scope: IssueScope, buildAndSign: BuildAndSign) => Promise<IssueCommit>;

interface TransactionalVertexIssuer {
	issue(input: LocalVertexInput): Promise<IssueCommit>;
}

interface TransactionalIssuerOptions {
	readonly author: string;
	readonly preparedBlueprintAdmission?: unknown;
	readonly privateKeySeed: Uint8Array;
	readonly publicKey: {
		readonly bytes: Uint8Array;
		readonly format: "raw";
	};
	readonly transactIssue: TransactIssue;
}

interface ProtocolV3IssuanceSurface {
	createTransactionalVertexIssuer?(options: TransactionalIssuerOptions): TransactionalVertexIssuer;
	prepareBlueprintAdmission?(input: {
		readonly canonicalBlueprintPackageBytes: Uint8Array;
		readonly expectedBlueprintDigest: string;
	}): unknown;
}

interface StoredScopeState {
	readonly envelopes: readonly SignedVertexEnvelope[];
	readonly exhausted: boolean;
	readonly issuedRecords: readonly IssuedVertexRecord[];
	readonly next: number;
	readonly outbox: readonly IssuanceOutboxEntry[];
}

interface MutableScopeState {
	envelopes: SignedVertexEnvelope[];
	exhausted: boolean;
	issuedRecords: IssuedVertexRecord[];
	next: number;
	outbox: IssuanceOutboxEntry[];
}

interface DeferredSignal {
	readonly promise: Promise<void>;
	resolve(): void;
}

interface CommitGate {
	readonly entered: Promise<void>;
	release(): void;
}

interface PromiseOutcome<Value> {
	readonly status: "fulfilled" | "pending" | "rejected";
	readonly value?: Value;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const IMPLEMENTATION_PATH =
	process.env.PHASE_0G2I_IMPLEMENTATION_MODULE === undefined
		? resolve(CURRENT_DIRECTORY, contract.implementationModule)
		: resolve(CURRENT_DIRECTORY, "..", process.env.PHASE_0G2I_IMPLEMENTATION_MODULE);
const IMPLEMENTATION_URL = pathToFileURL(IMPLEMENTATION_PATH).href;
const implementationLoad = import(IMPLEMENTATION_URL)
	.then((loaded: unknown) => ({ loaded: loaded as ProtocolV3IssuanceSurface }))
	.catch((error: unknown) => ({ error }));
const EXPECTED_BLUEPRINT_DIGEST = "cabbcc65454211b2e258328632aba8b184c8abdb6fb9082b498714fad503b838";
const preparedIssuerAudit = { calls: 0 };

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("fixture hex must be lowercase and byte-aligned");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function deferredSignal(): DeferredSignal {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function scopeKey(scope: IssueScope): string {
	return `${scope.objectId.length}:${scope.objectId}${scope.author.length}:${scope.author}`;
}

function cloneScope(scope: IssueScope): IssueScope {
	return { author: scope.author, objectId: scope.objectId };
}

function cloneEnvelope(envelope: SignedVertexEnvelope): SignedVertexEnvelope {
	return {
		canonicalPreimageBytes: new Uint8Array(envelope.canonicalPreimageBytes),
		digest: new Uint8Array(envelope.digest),
		signature: new Uint8Array(envelope.signature),
	};
}

function cloneRecord(record: IssuedVertexRecord): IssuedVertexRecord {
	return {
		authorSequence: record.authorSequence,
		envelope: cloneEnvelope(record.envelope),
		scope: cloneScope(record.scope),
	};
}

function cloneOutboxEntry(entry: IssuanceOutboxEntry): IssuanceOutboxEntry {
	return {
		authorSequence: entry.authorSequence,
		envelope: cloneEnvelope(entry.envelope),
		scope: cloneScope(entry.scope),
	};
}

function input(objectId: string, requestOrdinal: number, overrides: Partial<LocalVertexInput> = {}): LocalVertexInput {
	return {
		anchor: contract.vertex.anchor,
		dependencies: contract.vertex.dependencies,
		epoch: contract.vertex.epoch,
		logicalTime: contract.vertex.logicalTime + requestOrdinal,
		objectId,
		operation: { ...contract.vertex.operation, requestOrdinal },
		...overrides,
	};
}

function expectedPreimage(
	value: LocalVertexInput,
	author: string,
	authorSequence: number
): Readonly<Record<string, unknown>> {
	return {
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId: value.objectId,
		epoch: value.epoch,
		anchor: value.anchor,
		author,
		authorSequence,
		logicalTime: value.logicalTime,
		dependencies: [...value.dependencies],
		operation: value.operation,
	};
}

function assertAuthenticatedCommit(
	commit: IssueCommit,
	value: LocalVertexInput,
	author: string,
	publicKey: Uint8Array
): void {
	const preimage = expectedPreimage(value, author, commit.authorSequence);
	const expectedBytes = encodeCanonical(preimage);
	const expectedDigest = hashDomain(contract.domain, expectedBytes);

	expect(commit.envelope.canonicalPreimageBytes).toEqual(expectedBytes);
	expect(decodeCanonical(commit.envelope.canonicalPreimageBytes)).toEqual(preimage);
	expect(commit.envelope.digest).toEqual(expectedDigest);
	expect(ed25519.verify(commit.envelope.signature, expectedDigest, publicKey, { zip215: false })).toBe(true);
	expect(commit.issuedRecord).toEqual({
		authorSequence: commit.authorSequence,
		envelope: commit.envelope,
		scope: { author, objectId: value.objectId },
	});
	expect(commit.outboxEntry).toEqual({
		authorSequence: commit.authorSequence,
		envelope: commit.envelope,
		scope: { author, objectId: value.objectId },
	});
}

function seededShuffle<Value>(values: readonly Value[], seed: number): Value[] {
	const shuffled = [...values];
	let state = seed >>> 0;
	for (let index = shuffled.length - 1; index > 0; index--) {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		const selected = state % (index + 1);
		const temporary = shuffled[index] as Value;
		shuffled[index] = shuffled[selected] as Value;
		shuffled[selected] = temporary;
	}
	return shuffled;
}

async function outcomeWithinMicrotasks<Value>(
	promise: Promise<Value>,
	budget = contract.microtaskBudget
): Promise<PromiseOutcome<Value>> {
	let outcome: PromiseOutcome<Value> = { status: "pending" };
	void promise.then(
		(value) => {
			outcome = { status: "fulfilled", value };
		},
		() => {
			outcome = { status: "rejected" };
		}
	);
	for (let turn = 0; turn < budget && outcome.status === "pending"; turn++) await Promise.resolve();
	return outcome;
}

async function requireIssuanceFactory(): Promise<(options: TransactionalIssuerOptions) => TransactionalVertexIssuer> {
	const result = await implementationLoad;
	if ("error" in result) {
		throw new Error("PHASE_0G2I_IMPLEMENTATION_MODULE_UNAVAILABLE", { cause: result.error });
	}
	const createTransactionalVertexIssuerUnprepared = result.loaded.createTransactionalVertexIssuer;
	if (typeof createTransactionalVertexIssuerUnprepared !== "function") {
		throw new Error("PHASE_0G2I_MISSING_EXPORT:createTransactionalVertexIssuer");
	}
	const prepareBlueprintAdmission = result.loaded.prepareBlueprintAdmission;
	if (typeof prepareBlueprintAdmission !== "function") {
		throw new Error("PHASE_0G2I_MISSING_EXPORT:prepareBlueprintAdmission");
	}
	const preparedBlueprintAdmission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes: encodeCanonical(blueprintContract.package),
		expectedBlueprintDigest: EXPECTED_BLUEPRINT_DIGEST,
	});
	return (options: TransactionalIssuerOptions): TransactionalVertexIssuer => {
		preparedIssuerAudit.calls++;
		return createTransactionalVertexIssuerUnprepared({ ...options, preparedBlueprintAdmission });
	};
}

/**
 * Ephemeral deterministic transaction test double.
 *
 * This models only the injected old-or-new transaction contract. It is not a
 * durable backend and makes no Phase 2l crash, restart, tab or process claim.
 */
class EphemeralIssueTransactionTestDouble {
	readonly selections: Array<{ readonly authorSequence: number; readonly scope: IssueScope }> = [];
	buildCalls = 0;
	commitAttempts = 0;
	maxPendingRequests = 0;
	pendingRequests = 0;
	transactCalls = 0;

	private readonly commitFailures = new Set<string>();
	private readonly commitGates = new Map<
		string,
		{
			readonly entered: DeferredSignal;
			readonly released: Promise<void>;
		}
	>();
	private readonly states = new Map<string, MutableScopeState>();
	private readonly tails = new Map<string, Promise<void>>();

	seedNext(scope: IssueScope, next: number): void {
		if (!Number.isSafeInteger(next) || next < 0) throw new RangeError("next must be a nonnegative safe integer");
		const state = this.mutableState(scope);
		if (state.envelopes.length !== 0 || state.issuedRecords.length !== 0 || state.outbox.length !== 0) {
			throw new Error("cannot reseed a nonempty test-double scope");
		}
		state.next = next;
	}

	failNextCommit(scope: IssueScope): void {
		this.commitFailures.add(scopeKey(scope));
	}

	blockNextCommit(scope: IssueScope): CommitGate {
		const key = scopeKey(scope);
		const entered = deferredSignal();
		const released = deferredSignal();
		this.commitGates.set(key, { entered, released: released.promise });
		return {
			entered: entered.promise,
			release: (): void => {
				released.resolve();
			},
		};
	}

	snapshot(scope: IssueScope): StoredScopeState {
		const state = this.states.get(scopeKey(scope));
		if (state === undefined) {
			return { envelopes: [], exhausted: false, issuedRecords: [], next: 0, outbox: [] };
		}
		return {
			envelopes: state.envelopes.map(cloneEnvelope),
			exhausted: state.exhausted,
			issuedRecords: state.issuedRecords.map(cloneRecord),
			next: state.next,
			outbox: state.outbox.map(cloneOutboxEntry),
		};
	}

	async transactIssue(scope: IssueScope, buildAndSign: BuildAndSign): Promise<IssueCommit> {
		this.transactCalls++;
		this.pendingRequests++;
		this.maxPendingRequests = Math.max(this.maxPendingRequests, this.pendingRequests);

		const key = scopeKey(scope);
		const previous = this.tails.get(key) ?? Promise.resolve();
		const unlocked = deferredSignal();
		const tail = previous.then(async () => unlocked.promise);
		this.tails.set(key, tail);
		await previous;

		try {
			const state = this.mutableState(scope);
			if (state.exhausted) {
				throw new RangeError("author sequence exhausted");
			}
			const authorSequence = state.next;
			this.selections.push({ authorSequence, scope: cloneScope(scope) });
			this.buildCalls++;
			const commit = await buildAndSign(authorSequence);
			this.assertCommitMatchesSelection(commit, scope, authorSequence);
			this.commitAttempts++;

			const gate = this.commitGates.get(key);
			if (gate !== undefined) {
				this.commitGates.delete(key);
				gate.entered.resolve();
				await gate.released;
			}
			if (this.commitFailures.delete(key)) throw new Error("injected commit failure");

			const committedEnvelope = cloneEnvelope(commit.envelope);
			const committedRecord = cloneRecord({ ...commit.issuedRecord, envelope: committedEnvelope });
			const committedOutbox = cloneOutboxEntry({ ...commit.outboxEntry, envelope: committedEnvelope });
			this.states.set(key, {
				envelopes: [...state.envelopes, committedEnvelope],
				exhausted: authorSequence === Number.MAX_SAFE_INTEGER,
				issuedRecords: [...state.issuedRecords, committedRecord],
				next: authorSequence === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : authorSequence + 1,
				outbox: [...state.outbox, committedOutbox],
			});
			return commit;
		} finally {
			this.pendingRequests--;
			unlocked.resolve();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}

	private assertCommitMatchesSelection(commit: IssueCommit, scope: IssueScope, authorSequence: number): void {
		const decoded = decodeCanonical(commit.envelope.canonicalPreimageBytes) as Readonly<Record<string, unknown>>;
		expect(commit.authorSequence, "closure result cannot overwrite the selected ordinal").toBe(authorSequence);
		expect(decoded.authorSequence, "signed canonical bytes must contain the selected ordinal").toBe(authorSequence);
		expect(decoded.objectId).toBe(scope.objectId);
		expect(decoded.author).toBe(scope.author);
		expect(commit.issuedRecord.authorSequence).toBe(authorSequence);
		expect(commit.issuedRecord.scope).toEqual(scope);
		expect(commit.outboxEntry.authorSequence).toBe(authorSequence);
		expect(commit.outboxEntry.scope).toEqual(scope);
	}

	private mutableState(scope: IssueScope): MutableScopeState {
		const key = scopeKey(scope);
		let state = this.states.get(key);
		if (state === undefined) {
			state = { envelopes: [], exhausted: false, issuedRecords: [], next: 0, outbox: [] };
			this.states.set(key, state);
		}
		return state;
	}
}

function issuerOptions(
	store: EphemeralIssueTransactionTestDouble,
	overrides: Partial<TransactionalIssuerOptions> = {}
): TransactionalIssuerOptions {
	const privateKeySeed = fromHex(contract.privateKeySeedHex);
	return {
		author: contract.author,
		privateKeySeed,
		publicKey: { bytes: ed25519.getPublicKey(privateKeySeed), format: "raw" },
		transactIssue: store.transactIssue.bind(store),
		...overrides,
	};
}

describe("Phase 0g(ii-I) injected transactional v3 issuance RED", () => {
	it("keeps the fixture input-only and labels the in-memory store as an ephemeral test double", () => {
		expect(Object.keys(contract)).toEqual([
			"implementationModule",
			"domain",
			"privateKeySeedHex",
			"mismatchedPrivateKeySeedHex",
			"author",
			"otherAuthor",
			"scopes",
			"vertex",
			"overlap",
			"microtaskBudget",
		]);
		expect(contract).not.toHaveProperty("expected");
		expect(contract).not.toHaveProperty("canonicalHex");
		expect(contract).not.toHaveProperty("digestHex");
		expect(contract).not.toHaveProperty("signatureHex");
		expect(contract.domain).toBe("ts-drp/vertex/v3");
		expect(EphemeralIssueTransactionTestDouble.name).toContain("Ephemeral");
		const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
		expect(source.match(/createTransactionalVertexIssuerUnprepared\s*\(/gu)).toHaveLength(1);
		expect(source).toMatch(
			/createTransactionalVertexIssuerUnprepared\(\{\s*\.\.\.options,\s*preparedBlueprintAdmission\s*\}\)/u
		);
	});

	it("routes a success-expected issuer call through production-prepared ABI at runtime", async () => {
		const createIssuer = await requireIssuanceFactory();
		const store = new EphemeralIssueTransactionTestDouble();
		preparedIssuerAudit.calls = 0;
		const commit = await createIssuer(issuerOptions(store)).issue(input(contract.scopes.primary, 0));

		expect(preparedIssuerAudit.calls).toBe(1);
		expect(commit.authorSequence).toBe(0);
		expect(store.transactCalls).toBe(1);
	});

	it("uses the coordinator-selected ordinal and author in the exact registered bytes, digest, and signature", async () => {
		const createIssuer = await requireIssuanceFactory();
		const store = new EphemeralIssueTransactionTestDouble();
		const options = issuerOptions(store);
		const issuer = createIssuer(options);
		const maliciousInput = {
			...input(contract.scopes.primary, 0),
			author: "caller-chosen-author",
			authorSequence: 8_888,
			kind: "caller-kind",
			protocolMajor: 2,
		} as LocalVertexInput;

		const first = await issuer.issue(maliciousInput);
		const secondInput = input(contract.scopes.primary, 1);
		const second = await issuer.issue(secondInput);

		expect(store.selections.map(({ authorSequence }) => authorSequence)).toEqual([0, 1]);
		expect([first.authorSequence, second.authorSequence]).toEqual([0, 1]);
		assertAuthenticatedCommit(first, maliciousInput, contract.author, options.publicKey.bytes);
		assertAuthenticatedCommit(second, secondInput, contract.author, options.publicKey.bytes);
		expect(first.envelope.canonicalPreimageBytes).not.toEqual(second.envelope.canonicalPreimageBytes);
		expect(first.envelope.digest).not.toEqual(second.envelope.digest);
		expect(ed25519.verify(first.envelope.signature, second.envelope.digest, options.publicKey.bytes)).toBe(false);
	});

	it("rejects a public/private key mismatch before transaction, digest, signing, publication, or commit", async () => {
		const createIssuer = await requireIssuanceFactory();
		const store = new EphemeralIssueTransactionTestDouble();
		const mismatchedPrivateKeySeed = fromHex(contract.mismatchedPrivateKeySeedHex);
		const options = issuerOptions(store, { privateKeySeed: mismatchedPrivateKeySeed });

		expect(() => createIssuer(options)).toThrow(/key|public|private/iu);
		expect(store.transactCalls).toBe(0);
		expect(store.buildCalls).toBe(0);
		expect(store.commitAttempts).toBe(0);
		expect(store.snapshot({ author: contract.author, objectId: contract.scopes.primary })).toEqual({
			envelopes: [],
			exhausted: false,
			issuedRecords: [],
			next: 0,
			outbox: [],
		});
	});

	it("detaches key material at construction and mutable input at the issue-call boundary", async () => {
		const createIssuer = await requireIssuanceFactory();
		const store = new EphemeralIssueTransactionTestDouble();
		const privateKeySeed = fromHex(contract.privateKeySeedHex);
		const declaredPublicKey = ed25519.getPublicKey(privateKeySeed);
		const expectedPublicKey = new Uint8Array(declaredPublicKey);
		const dependencies = [...contract.vertex.dependencies];
		const operation = {
			action: "append",
			nested: { value: "call-time-value" },
		};
		const mutableInput = input(contract.scopes.primary, 0, { dependencies, operation }) as {
			anchor: string;
			dependencies: string[];
			epoch: number;
			logicalTime: number;
			objectId: string;
			operation: {
				action: string;
				nested: { value: string };
			};
		};
		const callTimeInput = input(contract.scopes.primary, 0, {
			dependencies: [...dependencies],
			operation: {
				action: operation.action,
				nested: { value: operation.nested.value },
			},
		});
		const issuer = createIssuer({
			author: contract.author,
			privateKeySeed,
			publicKey: { bytes: declaredPublicKey, format: "raw" },
			transactIssue: store.transactIssue.bind(store),
		});

		const pending = issuer.issue(mutableInput);
		privateKeySeed.fill(0xff);
		declaredPublicKey.fill(0xee);
		mutableInput.anchor = "bc".repeat(32);
		mutableInput.dependencies[0] = "ef".repeat(32);
		mutableInput.epoch++;
		mutableInput.logicalTime++;
		mutableInput.objectId = contract.scopes.independent;
		mutableInput.operation.action = "mutated-after-issue";
		mutableInput.operation.nested.value = "mutated-after-issue";

		const committed = await pending;
		assertAuthenticatedCommit(committed, callTimeInput, contract.author, expectedPublicKey);
		expect(store.snapshot({ author: contract.author, objectId: contract.scopes.primary })).toMatchObject({
			exhausted: false,
			next: 1,
		});
		expect(store.snapshot({ author: contract.author, objectId: contract.scopes.independent })).toMatchObject({
			exhausted: false,
			next: 0,
		});
	});

	it("keeps signed material opaque across sync throw, async rejection, and commit failure; retry reuses the ordinal", async () => {
		const createIssuer = await requireIssuanceFactory();
		const optionsStore = new EphemeralIssueTransactionTestDouble();
		let syncCalls = 0;
		const syncThrowIssuer = createIssuer(
			issuerOptions(optionsStore, {
				transactIssue: () => {
					syncCalls++;
					throw new Error("injected synchronous transaction throw");
				},
			})
		);
		await expect(syncThrowIssuer.issue(input(contract.scopes.primary, 0))).rejects.toThrow(/synchronous/iu);
		expect(syncCalls).toBe(1);

		let builtBeforeAsyncRejection = 0;
		const asyncRejectIssuer = createIssuer(
			issuerOptions(optionsStore, {
				transactIssue: async (_scope, buildAndSign) => {
					await buildAndSign(0);
					builtBeforeAsyncRejection++;
					throw new Error("injected asynchronous transaction rejection");
				},
			})
		);
		await expect(asyncRejectIssuer.issue(input(contract.scopes.primary, 1))).rejects.toThrow(/asynchronous/iu);
		expect(builtBeforeAsyncRejection).toBe(1);

		const retryAfterBoundaryFailures = await createIssuer(issuerOptions(optionsStore)).issue(
			input(contract.scopes.primary, 2)
		);
		expect(retryAfterBoundaryFailures.authorSequence).toBe(0);
		expect(optionsStore.snapshot({ author: contract.author, objectId: contract.scopes.primary }).next).toBe(1);

		const store = new EphemeralIssueTransactionTestDouble();
		const scope = { author: contract.author, objectId: contract.scopes.primary };
		store.failNextCommit(scope);
		const issuer = createIssuer(issuerOptions(store));
		await expect(issuer.issue(input(scope.objectId, 3))).rejects.toThrow(/commit/iu);
		expect(store.snapshot(scope)).toEqual({
			envelopes: [],
			exhausted: false,
			issuedRecords: [],
			next: 0,
			outbox: [],
		});

		const retryInput = input(scope.objectId, 4);
		const retry = await issuer.issue(retryInput);
		expect(retry.authorSequence).toBe(0);
		expect(store.selections.map(({ authorSequence }) => authorSequence)).toEqual([0, 0]);
		expect(store.snapshot(scope)).toMatchObject({
			envelopes: [retry.envelope],
			exhausted: false,
			issuedRecords: [retry.issuedRecord],
			next: 1,
			outbox: [retry.outboxEntry],
		});
	});

	it("exposes counter, exact envelope, issued record, and outbox only after a successful commit", async () => {
		const createIssuer = await requireIssuanceFactory();
		const store = new EphemeralIssueTransactionTestDouble();
		const scope = { author: contract.author, objectId: contract.scopes.primary };
		const gate = store.blockNextCommit(scope);
		const value = input(scope.objectId, 0);
		const issuer = createIssuer(issuerOptions(store));
		const pendingIssue = issuer.issue(value);

		await gate.entered;
		const beforeCommit = await outcomeWithinMicrotasks(pendingIssue);
		expect(beforeCommit.status).toBe("pending");
		expect(store.snapshot(scope)).toEqual({
			envelopes: [],
			exhausted: false,
			issuedRecords: [],
			next: 0,
			outbox: [],
		});

		gate.release();
		const committed = await pendingIssue;
		const afterCommit = store.snapshot(scope);
		expect(afterCommit).toEqual({
			envelopes: [committed.envelope],
			exhausted: false,
			issuedRecords: [committed.issuedRecord],
			next: 1,
			outbox: [committed.outboxEntry],
		});
		assertAuthenticatedCommit(committed, value, contract.author, issuerOptions(store).publicKey.bytes);
	});

	it("retries a failed final slot, issues maximum-safe once, then rejects without wrap or mutation", async () => {
		const createIssuer = await requireIssuanceFactory();
		const store = new EphemeralIssueTransactionTestDouble();
		const scope = { author: contract.author, objectId: contract.scopes.primary };
		store.seedNext(scope, Number.MAX_SAFE_INTEGER);
		store.failNextCommit(scope);
		const issuer = createIssuer(issuerOptions(store));

		await expect(issuer.issue(input(scope.objectId, 0))).rejects.toThrow(/commit/iu);
		expect(store.snapshot(scope)).toEqual({
			envelopes: [],
			exhausted: false,
			issuedRecords: [],
			next: Number.MAX_SAFE_INTEGER,
			outbox: [],
		});

		const last = await issuer.issue(input(scope.objectId, 0));
		expect(last.authorSequence).toBe(Number.MAX_SAFE_INTEGER);
		expect(store.selections.map(({ authorSequence }) => authorSequence)).toEqual([
			Number.MAX_SAFE_INTEGER,
			Number.MAX_SAFE_INTEGER,
		]);
		const beforeExhaustedAttempt = store.snapshot(scope);
		expect(beforeExhaustedAttempt.exhausted).toBe(true);
		const buildCalls = store.buildCalls;
		const commitAttempts = store.commitAttempts;

		await expect(issuer.issue(input(scope.objectId, 1))).rejects.toThrow(/exhaust/iu);
		expect(store.buildCalls).toBe(buildCalls);
		expect(store.commitAttempts).toBe(commitAttempts);
		expect(store.snapshot(scope)).toEqual(beforeExhaustedAttempt);
		expect(store.snapshot(scope).next, "the exhausted counter must not wrap").toBe(Number.MAX_SAFE_INTEGER);
	});

	it("linearizes genuine seed-pinned async overlap across issuer instances sharing one structural scope", async () => {
		const createIssuer = await requireIssuanceFactory();
		const store = new EphemeralIssueTransactionTestDouble();
		const issuers = Array.from({ length: contract.overlap.issuerCount }, () => createIssuer(issuerOptions(store)));
		const requestOrdinals = seededShuffle(
			Array.from({ length: contract.overlap.requestCount }, (_, index) => index),
			contract.overlap.seed
		);
		const requests = requestOrdinals.map((requestOrdinal, index) => {
			const issuer = issuers[index % issuers.length];
			if (issuer === undefined) throw new Error("fixture requires at least one issuer");
			const value = input(contract.scopes.primary, requestOrdinal);
			return { promise: issuer.issue(value), value };
		});

		const commits = await Promise.all(requests.map(({ promise }) => promise));
		expect(store.maxPendingRequests, "requests must overlap before the per-scope lane drains").toBeGreaterThan(1);
		expect(commits.map(({ authorSequence }) => authorSequence).sort((left, right) => left - right)).toEqual(
			Array.from({ length: contract.overlap.requestCount }, (_, index) => index)
		);
		expect(new Set(commits.map(({ envelope }) => Buffer.from(envelope.digest).toString("hex"))).size).toBe(
			contract.overlap.requestCount
		);
		for (let index = 0; index < commits.length; index++) {
			const commit = commits[index];
			const request = requests[index];
			if (commit === undefined || request === undefined) throw new Error("overlap result length mismatch");
			assertAuthenticatedCommit(commit, request.value, contract.author, issuerOptions(store).publicKey.bytes);
		}

		const snapshot = store.snapshot({ author: contract.author, objectId: contract.scopes.primary });
		expect(snapshot.next).toBe(contract.overlap.requestCount);
		expect(snapshot.envelopes).toHaveLength(contract.overlap.requestCount);
		expect(snapshot.issuedRecords).toHaveLength(contract.overlap.requestCount);
		expect(snapshot.outbox).toHaveLength(contract.overlap.requestCount);
	});

	it("lets different scopes progress independently while one scope is suspended", async () => {
		const createIssuer = await requireIssuanceFactory();
		const store = new EphemeralIssueTransactionTestDouble();
		const issuer = createIssuer(issuerOptions(store));
		const otherAuthorIssuer = createIssuer(issuerOptions(store, { author: contract.otherAuthor }));
		const blockedScope = { author: contract.author, objectId: contract.scopes.primary };
		const independentScope = { author: contract.author, objectId: contract.scopes.independent };
		const sameObjectOtherAuthorScope = { author: contract.otherAuthor, objectId: contract.scopes.primary };
		const gate = store.blockNextCommit(blockedScope);
		const blocked = issuer.issue(input(blockedScope.objectId, 0));
		await gate.entered;

		const independent = issuer.issue(input(independentScope.objectId, 1));
		const sameObjectOtherAuthor = otherAuthorIssuer.issue(input(sameObjectOtherAuthorScope.objectId, 2));
		const independentBeforeRelease = await outcomeWithinMicrotasks(independent);
		const otherAuthorBeforeRelease = await outcomeWithinMicrotasks(sameObjectOtherAuthor);
		gate.release();
		const [blockedCommit, independentCommit, otherAuthorCommit] = await Promise.all([
			blocked,
			independent,
			sameObjectOtherAuthor,
		]);

		expect(independentBeforeRelease.status, "a global issuer mutex must not block an unrelated scope").toBe(
			"fulfilled"
		);
		expect(otherAuthorBeforeRelease.status, "scope identity must include author, not objectId alone").toBe("fulfilled");
		expect(blockedCommit.authorSequence).toBe(0);
		expect(independentCommit.authorSequence).toBe(0);
		expect(otherAuthorCommit.authorSequence).toBe(0);
		assertAuthenticatedCommit(
			otherAuthorCommit,
			input(sameObjectOtherAuthorScope.objectId, 2),
			contract.otherAuthor,
			issuerOptions(store).publicKey.bytes
		);
		expect(store.snapshot(blockedScope).next).toBe(1);
		expect(store.snapshot(independentScope).next).toBe(1);
		expect(store.snapshot(sameObjectOtherAuthorScope).next).toBe(1);
	});

	it("commits exactly one authenticated envelope, issued record, and outbox entry per successful request", async () => {
		const createIssuer = await requireIssuanceFactory();
		const store = new EphemeralIssueTransactionTestDouble();
		const issuer = createIssuer(issuerOptions(store));
		const scope = { author: contract.author, objectId: contract.scopes.primary };
		const values = Array.from({ length: 6 }, (_, index) => input(scope.objectId, index));
		const commits = await Promise.all(values.map(async (value) => issuer.issue(value)));
		const snapshot = store.snapshot(scope);

		expect(store.transactCalls).toBe(values.length);
		expect(store.buildCalls).toBe(values.length);
		expect(store.commitAttempts).toBe(values.length);
		expect(snapshot.envelopes).toHaveLength(values.length);
		expect(snapshot.issuedRecords).toHaveLength(values.length);
		expect(snapshot.outbox).toHaveLength(values.length);
		expect(snapshot.next).toBe(values.length);
		expect(snapshot.outbox.map(({ authorSequence }) => authorSequence)).toEqual(
			Array.from({ length: values.length }, (_, index) => index)
		);
		expect(new Set(snapshot.outbox.map(({ envelope }) => Buffer.from(envelope.digest).toString("hex"))).size).toBe(
			values.length
		);
		expect(commits.map(({ authorSequence }) => authorSequence)).toEqual(
			Array.from({ length: values.length }, (_, index) => index)
		);
	});
});
