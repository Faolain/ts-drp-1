import { encodeCanonical } from "@ts-drp/canonical";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-2l-a/shared-issuance-contract.json" with { type: "json" };

interface DurableIssueScope {
	readonly author: string;
	readonly objectId: string;
}

interface DurableSignedEnvelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

interface DurableIssuedRecord {
	readonly authorSequence: number;
	readonly envelope: DurableSignedEnvelope;
	readonly scope: DurableIssueScope;
}

type DurableIssuanceOutboxEntry = DurableIssuedRecord;

interface DurableIssueCommit {
	readonly authorSequence: number;
	readonly envelope: DurableSignedEnvelope;
	readonly issuedRecord: DurableIssuedRecord;
	readonly outboxEntry: DurableIssuanceOutboxEntry;
}

interface DurableIssuanceOutboxRecord {
	readonly commit: DurableIssueCommit;
	readonly publishState: "pending" | "published";
}

interface DurableLineage {
	readonly exhausted: boolean;
	readonly next: number;
}

interface DurableIssuanceStore {
	compareAndMarkOutboxPublished(input: {
		readonly authorSequence: number;
		readonly digest: Uint8Array;
		readonly scope: DurableIssueScope;
	}): Promise<void>;
	transactIssue(
		scope: DurableIssueScope,
		buildAndSign: (authorSequence: number) => Promise<DurableIssueCommit>
	): Promise<DurableIssueCommit>;
	readIssued(scope: DurableIssueScope, authorSequence: number): Promise<DurableIssueCommit | null>;
	readOutboxPage(input?: {
		readonly afterKey?: readonly [string, string, number] | null;
		readonly limit?: number;
		readonly scope?: DurableIssueScope;
	}): Promise<readonly DurableIssuanceOutboxRecord[]>;
	readLineage(scope: DurableIssueScope): Promise<DurableLineage>;
	close(): Promise<void>;
}

interface IssuanceError extends Error {
	readonly code: string;
	readonly retryClass?: string;
	readonly scope?: DurableIssueScope;
}

interface TerminalObservation {
	readonly issuedRecord: DurableIssuedRecord | null;
	readonly lineage: DurableLineage;
	readonly outboxRecord: {
		readonly authorSequence: number;
		readonly digest: Uint8Array;
		readonly publishState: "pending" | "published";
		readonly scope: DurableIssueScope;
	} | null;
}

interface TerminalClassificationInput {
	readonly candidate: DurableIssueCommit;
	readonly observation: TerminalObservation | { readonly unreadable: true };
	readonly priorLineage: DurableLineage;
	readonly scope: DurableIssueScope;
}

interface ConformanceSurface {
	readonly DURABLE_ISSUANCE_ERROR_CODES: readonly string[];
	readonly DURABLE_ISSUANCE_RETRY_CLASSES: readonly string[];
	readonly TERMINAL_SUPPRESSION_AMBIGUITY_CASES: readonly (readonly [string, string])[];
	classifyTerminalSuppression(input: TerminalClassificationInput): DurableIssueCommit;
	createEphemeralDurableIssuanceStore(options?: {
		readonly initialLineages?: readonly {
			readonly exhausted: boolean;
			readonly next: number;
			readonly scope: DurableIssueScope;
		}[];
		readonly initialPoison?: "recovery-corrupt";
	}): DurableIssuanceStore;
}

function missingOwnerError(): Error {
	return new Error("PHASE_2L_A_IMPLEMENTATION_MODULE_UNAVAILABLE");
}

const ABSENT_STORE: DurableIssuanceStore = {
	close: () => Promise.reject(missingOwnerError()),
	compareAndMarkOutboxPublished: () => Promise.reject(missingOwnerError()),
	readIssued: () => Promise.reject(missingOwnerError()),
	readLineage: () => Promise.reject(missingOwnerError()),
	readOutboxPage: () => Promise.reject(missingOwnerError()),
	transactIssue: () => Promise.reject(missingOwnerError()),
};

const ABSENT_SURFACE: ConformanceSurface = {
	DURABLE_ISSUANCE_ERROR_CODES: [],
	DURABLE_ISSUANCE_RETRY_CLASSES: [],
	TERMINAL_SUPPRESSION_AMBIGUITY_CASES: [],
	classifyTerminalSuppression: () => {
		throw missingOwnerError();
	},
	createEphemeralDurableIssuanceStore: () => ABSENT_STORE,
};

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const IMPLEMENTATION_PATH =
	process.env.PHASE_2L_A_IMPLEMENTATION_MODULE === undefined
		? resolve(CURRENT_DIRECTORY, "fixtures/phase-2l-a", contract.implementationModule)
		: resolve(REPOSITORY_ROOT, process.env.PHASE_2L_A_IMPLEMENTATION_MODULE);
const implementationLoad = import(pathToFileURL(IMPLEMENTATION_PATH).href)
	.then((loaded: unknown) => ({ loaded: loaded as ConformanceSurface }))
	.catch(() => ({ loaded: ABSENT_SURFACE }));

const SCOPE: DurableIssueScope = { author: "alice", objectId: "room:general" };

async function requireSurface(): Promise<ConformanceSurface> {
	const result = await implementationLoad;
	for (const name of [
		"DURABLE_ISSUANCE_ERROR_CODES",
		"DURABLE_ISSUANCE_RETRY_CLASSES",
		"TERMINAL_SUPPRESSION_AMBIGUITY_CASES",
		"classifyTerminalSuppression",
		"createEphemeralDurableIssuanceStore",
	] as const) {
		if (!(name in result.loaded)) throw new Error(`PHASE_2L_A_MISSING_EXPORT:${name}`);
	}
	return result.loaded;
}

function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

function cloneScope(scope: DurableIssueScope): DurableIssueScope {
	return { author: scope.author, objectId: scope.objectId };
}

function commitFor(scope: DurableIssueScope, authorSequence: number, seed = authorSequence + 1): DurableIssueCommit {
	const envelope: DurableSignedEnvelope = {
		canonicalPreimageBytes: encodeCanonical({
			author: scope.author,
			authorSequence,
			kind: "drp-vertex",
			objectId: scope.objectId,
			protocolMajor: 3,
		}),
		digest: bytes(seed & 0xff, 0xd1),
		signature: bytes(seed & 0xff, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope: cloneScope(scope) },
		outboxEntry: { authorSequence, envelope, scope: cloneScope(scope) },
	};
}

function expectCode(error: unknown, code: string): IssuanceError {
	expect(error).toBeInstanceOf(Error);
	expect(error).toMatchObject({ code });
	return error as IssuanceError;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected promise rejection");
}

function durableKey(record: DurableIssuanceOutboxRecord): readonly [string, string, number] {
	return [
		record.commit.outboxEntry.scope.objectId,
		record.commit.outboxEntry.scope.author,
		record.commit.authorSequence,
	];
}

function nativeOutboxRow(
	commit: DurableIssueCommit,
	publishState: "pending" | "published"
): NonNullable<TerminalObservation["outboxRecord"]> {
	return {
		authorSequence: commit.authorSequence,
		digest: commit.envelope.digest,
		publishState,
		scope: commit.outboxEntry.scope,
	};
}

describe("Phase 2l-a package and closed contract", () => {
	it("publishes the exact closed error, retry and ten-case ambiguity registries", async () => {
		const surface = await requireSurface();
		expect(surface.DURABLE_ISSUANCE_ERROR_CODES).toEqual(contract.errorCodes);
		expect(surface.DURABLE_ISSUANCE_RETRY_CLASSES).toEqual(contract.retryClasses);
		expect(surface.TERMINAL_SUPPRESSION_AMBIGUITY_CASES).toEqual(contract.terminalSuppressionCases);
		expect(Object.isFrozen(surface.DURABLE_ISSUANCE_ERROR_CODES)).toBe(true);
		expect(Object.isFrozen(surface.DURABLE_ISSUANCE_RETRY_CLASSES)).toBe(true);
		expect(Object.isFrozen(surface.TERMINAL_SUPPRESSION_AMBIGUITY_CASES)).toBe(true);
		expect(
			new Set(surface.TERMINAL_SUPPRESSION_AMBIGUITY_CASES.map(([backend, edge]) => `${backend}:${edge}`))
		).toHaveLength(10);
	});

	it("has only canonical at runtime and keeps protocol-v3 out of source, runtime and declarations", async () => {
		const packageRoot = resolve(REPOSITORY_ROOT, "packages/issuance-store");
		const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			exports?: Record<string, unknown>;
		};
		expect(packageJson.dependencies).toEqual({ "@ts-drp/canonical": "0.11.0" });
		expect(packageJson.devDependencies).toEqual({ "@ts-drp/protocol-v3": "0.11.0" });
		expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual([".", "./conformance"]);

		const inspect = async (directory: string): Promise<string> => {
			const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
				.filter((entry) => entry.isFile() && /\.(?:[cm]?[jt]s|d\.ts)$/u.test(entry.name))
				.map((entry) => resolve(entry.parentPath, entry.name));
			return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
		};
		expect(await inspect(resolve(packageRoot, "src"))).not.toContain("@ts-drp/protocol-v3");
		expect(await inspect(resolve(packageRoot, "dist"))).not.toContain("@ts-drp/protocol-v3");
	});

	it("exposes exactly the store methods and creates only pending immutable rows", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore();
		expect(Object.keys(store).sort()).toEqual([
			"close",
			"compareAndMarkOutboxPublished",
			"readIssued",
			"readLineage",
			"readOutboxPage",
			"transactIssue",
		]);
		const result = await store.transactIssue(SCOPE, (selected) => Promise.resolve(commitFor(SCOPE, selected, 19)));
		expect(result.authorSequence).toBe(0);
		expect(await store.readLineage(SCOPE)).toEqual({ exhausted: false, next: 1 });
		expect(await store.readIssued(SCOPE, 0)).toEqual(result);
		expect(await store.readOutboxPage()).toEqual([{ commit: result, publishState: "pending" }]);
	});
});

describe("Phase 2l-a validation, copying and promise behavior", () => {
	it("selects zero, calls the closure exactly once and does not rehash or verify arbitrary non-empty bytes", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore();
		let calls = 0;
		const result = await store.transactIssue(SCOPE, (selected) => {
			calls++;
			expect(selected).toBe(0);
			return Promise.resolve(commitFor(SCOPE, selected, 0xa7));
		});
		expect(calls).toBe(1);
		expect(result.envelope.digest).toEqual(bytes(0xa7, 0xd1));
		expect(result.envelope.signature).toEqual(bytes(0xa7, 0x51));
	});

	it("rejects public misuse asynchronously with the exact TypeError code and no build", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore();
		let calls = 0;
		const invoke = (): Promise<DurableIssueCommit> =>
			store.transactIssue({ author: "", objectId: SCOPE.objectId }, (selected) => {
				calls++;
				return Promise.resolve(commitFor(SCOPE, selected));
			});
		let promise!: Promise<DurableIssueCommit>;
		expect(() => {
			promise = invoke();
		}).not.toThrow();
		const error = expectCode(await captureRejection(promise), "ISSUANCE_INVALID_ARGUMENT");
		expect(error).toBeInstanceOf(TypeError);
		expect(calls).toBe(0);
	});

	it.each([
		{ author: "a".repeat(contract.maximumScopeUtf16Units + 1), objectId: "ok" },
		{ author: "ok", objectId: "o".repeat(contract.maximumScopeUtf16Units + 1) },
		{ author: new String("boxed"), objectId: "ok" },
	])("rejects non-primitive, empty or over-bound scope fields without consuming", async (badScope) => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore();
		const error = await captureRejection(
			store.transactIssue(badScope as unknown as DurableIssueScope, (selected) =>
				Promise.resolve(commitFor(SCOPE, selected))
			)
		);
		expectCode(error, "ISSUANCE_INVALID_ARGUMENT");
		expect(await store.readLineage(SCOPE)).toEqual({ exhausted: false, next: 0 });
	});

	it("propagates a closure synchronous throw and rejection unchanged with old state", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		for (const failure of [new Error("sync-build"), new RangeError("async-build")]) {
			const store = createEphemeralDurableIssuanceStore();
			const callback =
				failure instanceof RangeError
					? (): Promise<DurableIssueCommit> => Promise.reject(failure)
					: (((): Promise<DurableIssueCommit> => {
							throw failure;
						}) as unknown as (ordinal: number) => Promise<DurableIssueCommit>);
			const promise = store.transactIssue(SCOPE, callback);
			expect(promise).toBeInstanceOf(Promise);
			expect(await captureRejection(promise)).toBe(failure);
			expect(await store.readLineage(SCOPE)).toEqual({ exhausted: false, next: 0 });
			expect(await store.readOutboxPage()).toEqual([]);
		}
	});

	it("rejects selected ordinal, scope, canonical-preimage and equal-envelope mismatches as commit-invalid", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const mutants: ((selected: number) => DurableIssueCommit)[] = [
			(selected): DurableIssueCommit => ({ ...commitFor(SCOPE, selected), authorSequence: selected + 1 }),
			(selected): DurableIssueCommit => ({
				...commitFor(SCOPE, selected),
				issuedRecord: { ...commitFor(SCOPE, selected).issuedRecord, scope: { ...SCOPE, author: "mallory" } },
			}),
			(selected): DurableIssueCommit => ({
				...commitFor(SCOPE, selected),
				envelope: {
					...commitFor(SCOPE, selected).envelope,
					canonicalPreimageBytes: encodeCanonical({ ...SCOPE, authorSequence: selected + 1 }),
				},
			}),
			(selected): DurableIssueCommit => ({
				...commitFor(SCOPE, selected),
				outboxEntry: {
					...commitFor(SCOPE, selected).outboxEntry,
					envelope: { ...commitFor(SCOPE, selected).envelope, digest: bytes(0xff) },
				},
			}),
		];
		for (const mutant of mutants) {
			const store = createEphemeralDurableIssuanceStore();
			expectCode(
				await captureRejection(store.transactIssue(SCOPE, (selected) => Promise.resolve(mutant(selected)))),
				"ISSUANCE_COMMIT_INVALID"
			);
			expect(await store.readLineage(SCOPE)).toEqual({ exhausted: false, next: 0 });
		}
	});

	it("rejects extra, inherited or accessor-backed commit records instead of normalizing a wider native shape", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const candidates: ((selected: number) => DurableIssueCommit)[] = [
			(selected): DurableIssueCommit => Object.assign(commitFor(SCOPE, selected), { extra: true }),
			(selected): DurableIssueCommit => {
				const candidate = commitFor(SCOPE, selected);
				return Object.create({ extra: true }, Object.getOwnPropertyDescriptors(candidate)) as DurableIssueCommit;
			},
			(selected): DurableIssueCommit => {
				const candidate = commitFor(SCOPE, selected);
				Object.defineProperty(candidate.issuedRecord, "scope", {
					configurable: true,
					enumerable: true,
					get: () => SCOPE,
				});
				return candidate;
			},
		];
		for (const candidate of candidates) {
			const store = createEphemeralDurableIssuanceStore();
			expectCode(
				await captureRejection(store.transactIssue(SCOPE, (selected) => Promise.resolve(candidate(selected)))),
				"ISSUANCE_COMMIT_INVALID"
			);
			expect(await store.readOutboxPage()).toEqual([]);
		}
	});

	it.each(["canonicalPreimageBytes", "digest", "signature"] as const)(
		"rejects empty %s and never persists it",
		async (field) => {
			const { createEphemeralDurableIssuanceStore } = await requireSurface();
			const store = createEphemeralDurableIssuanceStore();
			const error = await captureRejection(
				store.transactIssue(SCOPE, (selected) => {
					const candidate = commitFor(SCOPE, selected);
					const envelope = { ...candidate.envelope, [field]: bytes() };
					return Promise.resolve({
						...candidate,
						envelope,
						issuedRecord: { ...candidate.issuedRecord, envelope },
						outboxEntry: { ...candidate.outboxEntry, envelope },
					});
				})
			);
			expectCode(error, "ISSUANCE_COMMIT_INVALID");
			expect(await store.readOutboxPage()).toEqual([]);
		}
	);

	it("rejects SharedArrayBuffer-backed views before persistence", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore();
		const shared = new Uint8Array(new SharedArrayBuffer(8));
		shared.fill(7);
		const error = await captureRejection(
			store.transactIssue(SCOPE, (selected) => {
				const candidate = commitFor(SCOPE, selected);
				const envelope = { ...candidate.envelope, digest: shared };
				return Promise.resolve({
					...candidate,
					envelope,
					issuedRecord: { ...candidate.issuedRecord, envelope },
					outboxEntry: { ...candidate.outboxEntry, envelope },
				});
			})
		);
		expectCode(error, "ISSUANCE_COMMIT_INVALID");
		expect(await store.readOutboxPage()).toEqual([]);
	});

	it("copies before persistence and returns fresh detached graphs on every read and success", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore();
		const source = commitFor(SCOPE, 0, 44);
		const result = await store.transactIssue(SCOPE, () => Promise.resolve(source));
		source.envelope.digest.fill(0);
		result.envelope.digest.fill(1);
		result.issuedRecord.envelope.signature.fill(2);
		const first = await store.readIssued(SCOPE, 0);
		const second = await store.readIssued(SCOPE, 0);
		expect(first?.envelope.digest).toEqual(bytes(44, 0xd1));
		expect(first?.envelope.signature).toEqual(bytes(44, 0x51));
		expect(first).not.toBe(second);
		expect(first?.envelope).not.toBe(second?.envelope);
		first?.envelope.digest.fill(3);
		expect((await store.readIssued(SCOPE, 0))?.envelope.digest).toEqual(bytes(44, 0xd1));
	});
});

describe("Phase 2l-a lineage and deterministic concurrency", () => {
	it("issues MAX_SAFE_INTEGER exactly once, marks exhausted and never computes or builds +1", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore({
			initialLineages: [{ exhausted: false, next: Number.MAX_SAFE_INTEGER, scope: SCOPE }],
		});
		let calls = 0;
		const final = await store.transactIssue(SCOPE, (selected) => {
			calls++;
			expect(selected).toBe(Number.MAX_SAFE_INTEGER);
			return Promise.resolve(commitFor(SCOPE, selected, 91));
		});
		expect(final.authorSequence).toBe(Number.MAX_SAFE_INTEGER);
		expect(await store.readLineage(SCOPE)).toEqual({ exhausted: true, next: Number.MAX_SAFE_INTEGER });
		const error = await captureRejection(
			store.transactIssue(SCOPE, (selected) => {
				calls++;
				return Promise.resolve(commitFor(SCOPE, selected));
			})
		);
		expectCode(error, "ISSUANCE_EXHAUSTED");
		expect(calls).toBe(1);
	});

	it("leaves a failed final-slot build selectable for one later successful retry", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore({
			initialLineages: [{ exhausted: false, next: Number.MAX_SAFE_INTEGER, scope: SCOPE }],
		});
		const failure = new Error("signer offline");
		expect(await captureRejection(store.transactIssue(SCOPE, () => Promise.reject(failure)))).toBe(failure);
		expect(await store.readLineage(SCOPE)).toEqual({ exhausted: false, next: Number.MAX_SAFE_INTEGER });
		await store.transactIssue(SCOPE, (selected) => Promise.resolve(commitFor(SCOPE, selected)));
		expect(await store.readLineage(SCOPE)).toEqual({ exhausted: true, next: Number.MAX_SAFE_INTEGER });
	});

	it("reports a final-slot CAS loser as retry-required even though the winner exhausted the lineage", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore({
			initialLineages: [{ exhausted: false, next: Number.MAX_SAFE_INTEGER, scope: SCOPE }],
		});
		let entered = 0;
		let release!: () => void;
		const barrier = new Promise<void>((resolveBarrier) => {
			release = resolveBarrier;
		});
		const outcomes = await Promise.allSettled(
			[1, 2].map((seed) =>
				store.transactIssue(SCOPE, async (selected) => {
					entered++;
					if (entered === 2) release();
					await barrier;
					return commitFor(SCOPE, selected, seed);
				})
			)
		);
		expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		const loser = outcomes.find(({ status }) => status === "rejected");
		if (loser?.status !== "rejected") throw new Error("missing final-slot CAS loser");
		expectCode(loser.reason, "ISSUANCE_RETRY_REQUIRED");
		expect(await store.readLineage(SCOPE)).toEqual({ exhausted: true, next: Number.MAX_SAFE_INTEGER });
	});

	it("makes one synchronized same-scope winner and private retry-required CAS losers without rebuilding", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore();
		let entered = 0;
		let release!: () => void;
		const barrier = new Promise<void>((resolveBarrier) => {
			release = resolveBarrier;
		});
		const calls = Array.from({ length: 5 }, (_, index) =>
			store.transactIssue(SCOPE, async (selected) => {
				entered++;
				if (entered === 5) release();
				await barrier;
				return commitFor(SCOPE, selected, index + 10);
			})
		);
		const outcomes = await Promise.allSettled(calls);
		const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
		const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
		expect(entered).toBe(5);
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(4);
		for (const outcome of rejected) {
			if (outcome.status !== "rejected") continue;
			const error = expectCode(outcome.reason, "ISSUANCE_RETRY_REQUIRED");
			expect(Object.keys(error)).not.toEqual(
				expect.arrayContaining(["authorSequence", "digest", "candidate", "token"])
			);
		}
		expect(await store.readLineage(SCOPE)).toEqual({ exhausted: false, next: 1 });
		expect(await store.readOutboxPage()).toHaveLength(1);
	});

	it("allows scope B to finish while scope A is suspended inside its one build", async () => {
		const surface = await requireSurface();
		if (surface === ABSENT_SURFACE) throw missingOwnerError();
		const { createEphemeralDurableIssuanceStore } = surface;
		const store = createEphemeralDurableIssuanceStore();
		let releaseA!: () => void;
		const aGate = new Promise<void>((resolveGate) => {
			releaseA = resolveGate;
		});
		let enteredA!: () => void;
		const aEntered = new Promise<void>((resolveEntered) => {
			enteredA = resolveEntered;
		});
		const scopeB = { author: "bob", objectId: "world:1" };
		const a = store.transactIssue(SCOPE, async (selected) => {
			enteredA();
			await aGate;
			return commitFor(SCOPE, selected);
		});
		await aEntered;
		const b = await store.transactIssue(scopeB, (selected) => Promise.resolve(commitFor(scopeB, selected)));
		expect(b.authorSequence).toBe(0);
		releaseA();
		await expect(a).resolves.toMatchObject({ authorSequence: 0 });
	});
});

describe("Phase 2l-a paging, terminal readback and poisoning", () => {
	it("uses the exact default/bounds, optional scope and UTF-16 compound-key comparator", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore();
		const scopes = [
			{ author: "z", objectId: "\ue000" },
			{ author: "a", objectId: "😀" },
			{ author: "a", objectId: "a" },
		];
		for (const scope of scopes) {
			await store.transactIssue(scope, (selected) => Promise.resolve(commitFor(scope, selected)));
		}
		const ordered = await store.readOutboxPage();
		expect(ordered.map(durableKey)).toEqual([
			["a", "a", 0],
			["😀", "a", 0],
			["\ue000", "z", 0],
		]);
		expect(await store.readOutboxPage({ afterKey: ["a", "a", 0], limit: 1 })).toEqual([ordered[1]]);
		expect(await store.readOutboxPage({ scope: scopes[0] })).toEqual([ordered[2]]);
		for (const limit of [0, -1, 1.5, contract.maximumPageLimit + 1]) {
			const error = await captureRejection(store.readOutboxPage({ limit }));
			expectCode(error, "ISSUANCE_INVALID_ARGUMENT");
		}
		for (const afterKey of [
			["", "a", 0],
			["a", "", 0],
			["a", "a", -1],
			["a", "a", Number.MAX_SAFE_INTEGER + 1],
		] as const) {
			expectCode(await captureRejection(store.readOutboxPage({ afterKey })), "ISSUANCE_INVALID_ARGUMENT");
		}
		expectCode(await captureRejection(store.readIssued(SCOPE, -1)), "ISSUANCE_INVALID_ARGUMENT");

		const defaultStore = createEphemeralDurableIssuanceStore();
		for (let index = 0; index < contract.defaultPageLimit + 1; index++) {
			const scope = { author: "page", objectId: `item:${index.toString().padStart(3, "0")}` };
			await defaultStore.transactIssue(scope, (selected) => Promise.resolve(commitFor(scope, selected)));
		}
		expect(await defaultStore.readOutboxPage()).toHaveLength(contract.defaultPageLimit);
		expect(await defaultStore.readOutboxPage({ limit: contract.maximumPageLimit })).toHaveLength(
			contract.defaultPageLimit + 1
		);
	});

	it("classifies exact pending or published candidate rows as durable success, even after later advance", async () => {
		const { classifyTerminalSuppression } = await requireSurface();
		const candidate = commitFor(SCOPE, 3, 50);
		for (const publishState of ["pending", "published"] as const) {
			const result = classifyTerminalSuppression({
				candidate,
				observation: {
					issuedRecord: candidate.issuedRecord,
					lineage: { exhausted: false, next: 9 },
					outboxRecord: nativeOutboxRow(candidate, publishState),
				},
				priorLineage: { exhausted: false, next: 3 },
				scope: SCOPE,
			});
			expect(result).toEqual(candidate);
			expect(result).not.toBe(candidate);
		}
	});

	it("classifies absent-old, foreign-pair, torn and unreadable observations by the exact five-case table", async () => {
		const { classifyTerminalSuppression } = await requireSurface();
		const candidate = commitFor(SCOPE, 3, 50);
		const foreign = commitFor(SCOPE, 3, 51);
		const base = { candidate, priorLineage: { exhausted: false, next: 3 }, scope: SCOPE };
		const absent = (): DurableIssueCommit =>
			classifyTerminalSuppression({
				...base,
				observation: {
					issuedRecord: null,
					lineage: { exhausted: false, next: 3 },
					outboxRecord: null,
				},
			});
		expect(() => absent()).toThrowError(expect.objectContaining({ code: "ISSUANCE_SUBSTRATE_FAILURE" }));
		try {
			absent();
		} catch (error) {
			expect((error as IssuanceError).retryClass).toBeOneOf(contract.retryClasses);
		}

		expect(() =>
			classifyTerminalSuppression({
				...base,
				observation: {
					issuedRecord: foreign.issuedRecord,
					lineage: { exhausted: false, next: 4 },
					outboxRecord: nativeOutboxRow(foreign, "pending"),
				},
			})
		).toThrowError(expect.objectContaining({ code: "ISSUANCE_RETRY_REQUIRED" }));

		const corruptObservations: TerminalObservation[] = [
			{
				issuedRecord: candidate.issuedRecord,
				lineage: { exhausted: false, next: 4 },
				outboxRecord: null,
			},
			{
				issuedRecord: candidate.issuedRecord,
				lineage: { exhausted: false, next: 4 },
				outboxRecord: { ...nativeOutboxRow(candidate, "pending"), digest: bytes(0xff) },
			},
			{
				issuedRecord: null,
				lineage: { exhausted: false, next: 4 },
				outboxRecord: null,
			},
			{
				issuedRecord: candidate.issuedRecord,
				lineage: { exhausted: false, next: 3 },
				outboxRecord: nativeOutboxRow(candidate, "pending"),
			},
		];
		for (const observation of corruptObservations) {
			expect(() => classifyTerminalSuppression({ ...base, observation })).toThrowError(
				expect.objectContaining({ code: "ISSUANCE_RECOVERY_CORRUPT" })
			);
		}

		let unknown: IssuanceError | undefined;
		try {
			classifyTerminalSuppression({ ...base, observation: { unreadable: true } });
		} catch (error) {
			unknown = expectCode(error, "ISSUANCE_OUTCOME_UNKNOWN");
		}
		expect(unknown).toBeDefined();
		expect(Object.keys(unknown ?? {}).sort()).toEqual(["code", "scope"]);
		expect(unknown).not.toHaveProperty("authorSequence");
		expect(unknown).not.toHaveProperty("digest");
		expect(unknown).not.toHaveProperty("token");
		expect(() => absent()).toThrowError(expect.objectContaining({ code: "ISSUANCE_SUBSTRATE_FAILURE" }));
	});

	it("treats final MAX lineage as consumed only when exhausted", async () => {
		const { classifyTerminalSuppression } = await requireSurface();
		const candidate = commitFor(SCOPE, Number.MAX_SAFE_INTEGER, 73);
		for (const exhausted of [false, true]) {
			const invoke = (): DurableIssueCommit =>
				classifyTerminalSuppression({
					candidate,
					observation: {
						issuedRecord: candidate.issuedRecord,
						lineage: { exhausted, next: Number.MAX_SAFE_INTEGER },
						outboxRecord: nativeOutboxRow(candidate, "pending"),
					},
					priorLineage: { exhausted: false, next: Number.MAX_SAFE_INTEGER },
					scope: SCOPE,
				});
			if (exhausted) expect(invoke()).toEqual(candidate);
			else expect(invoke).toThrowError(expect.objectContaining({ code: "ISSUANCE_RECOVERY_CORRUPT" }));
		}
	});

	it("latches one recovery-corrupt error across every operation while close remains idempotent", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore({ initialPoison: "recovery-corrupt" });
		const operations = [
			store.readLineage(SCOPE),
			store.readIssued(SCOPE, 0),
			store.readOutboxPage(),
			store.transactIssue(SCOPE, (selected) => Promise.resolve(commitFor(SCOPE, selected))),
		];
		const errors = await Promise.all(operations.map(captureRejection));
		for (const error of errors) expectCode(error, "ISSUANCE_RECOVERY_CORRUPT");
		expect(new Set(errors)).toHaveLength(1);
		await expect(store.close()).resolves.toBeUndefined();
		await expect(store.close()).resolves.toBeUndefined();
	});

	it("rejects every post-close operation with one closed code and never returns partial data", async () => {
		const { createEphemeralDurableIssuanceStore } = await requireSurface();
		const store = createEphemeralDurableIssuanceStore();
		await store.close();
		for (const operation of [
			store.readLineage(SCOPE),
			store.readIssued(SCOPE, 0),
			store.readOutboxPage(),
			store.transactIssue(SCOPE, (selected) => Promise.resolve(commitFor(SCOPE, selected))),
		]) {
			expectCode(await captureRejection(operation), "ISSUANCE_STORE_CLOSED");
		}
	});
});
