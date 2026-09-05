import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
	assertExactDeathRegistry,
	errorShape,
	type Phase3a1bP2Commit,
	phase3a1bP2Commit,
	type Phase3a1bP2Store,
	PHASE_3A1B_P2_DEATH_TUPLES,
	PHASE_3A1B_P2_METHODS,
	PHASE_3A1B_P2_OTHER_SCOPE,
	PHASE_3A1B_P2_SCOPE,
} from "./fixtures/phase-3a1b-p2-outbox-publication-contract.js";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIRECTORY, "..");
const ISSUANCE_TYPES = path.join(ROOT, "packages/issuance-store/src/types.ts");
const ISSUANCE_CONFORMANCE = path.join(ROOT, "packages/issuance-store/src/conformance.ts");
const ISSUANCE_TERMINAL = path.join(ROOT, "packages/issuance-store/src/terminal.ts");
const ISSUANCE_INDEX = path.join(ROOT, "packages/issuance-store/src/index.ts");

interface IssuanceSurface {
	readonly DURABLE_ISSUANCE_ERROR_CODES: readonly string[];
	readonly DURABLE_ISSUANCE_RETRY_CLASSES: readonly string[];
	readonly TERMINAL_SUPPRESSION_AMBIGUITY_CASES: readonly unknown[];
	createEphemeralDurableIssuanceStore(options?: { readonly initialPoison?: "recovery-corrupt" }): Phase3a1bP2Store;
}

function source(relative: string): string {
	return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new TypeError(`missing ${label}`);
	return value;
}

async function loadConformance(): Promise<IssuanceSurface> {
	const candidate = pathToFileURL(path.join(ROOT, "packages/issuance-store/dist/src/conformance.js")).href;
	return (await import(candidate)) as IssuanceSurface;
}

async function runtimeNames(relative: string): Promise<readonly string[]> {
	return Object.keys(await import(pathToFileURL(path.join(ROOT, relative)).href)).sort();
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function durableIssuanceStoreMethodNames(text: string): readonly string[] {
	const unit = ts.createSourceFile(ISSUANCE_TYPES, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declaration = unit.statements.find(
		(statement): statement is ts.InterfaceDeclaration =>
			ts.isInterfaceDeclaration(statement) && statement.name.text === "DurableIssuanceStore"
	);
	if (declaration === undefined) throw new TypeError("missing DurableIssuanceStore interface declaration");
	return declaration.members
		.map((member) => {
			if (!ts.isMethodSignature(member) && !ts.isPropertySignature(member)) {
				throw new TypeError("unexpected DurableIssuanceStore interface member shape");
			}
			if (!ts.isIdentifier(member.name)) throw new TypeError("non-identifier DurableIssuanceStore member");
			return member.name.text;
		})
		.sort();
}

async function rejected(run: () => unknown): Promise<unknown> {
	let value: unknown;
	try {
		value = run();
	} catch (error) {
		throw new TypeError(`compareAndMarkOutboxPublished threw synchronously: ${String(error)}`);
	}
	try {
		await Promise.resolve(value);
	} catch (error) {
		return error;
	}
	throw new TypeError("expected publication transition rejection");
}

function exactMethods(value: object): readonly string[] {
	return Object.keys(value).sort();
}

function snapshotCommit(commit: Phase3a1bP2Commit): unknown {
	return {
		authorSequence: commit.authorSequence,
		digest: [...commit.envelope.digest],
		preimage: [...commit.envelope.canonicalPreimageBytes],
		signature: [...commit.envelope.signature],
		scope: { ...commit.outboxEntry.scope },
	};
}

function methodBody(text: string, name: string): string | undefined {
	const start = text.search(new RegExp(`(?:async\\s+)?${name}\\s*\\(`, "u"));
	if (start < 0) return undefined;
	const bodyStart = text.indexOf("{", start);
	if (bodyStart < 0) return undefined;
	let depth = 0;
	for (let index = bodyStart; index < text.length; index++) {
		if (text[index] === "{") depth++;
		if (text[index] === "}" && --depth === 0) return text.slice(start, index + 1);
	}
	return undefined;
}

type OracleOutcome =
	| "invalid"
	| "poison"
	| "published"
	| "transient"
	| "unknown"
	| "unchanged-caller"
	| "unchanged-durable";

const ORACLE_OUTCOMES = Object.freeze({
	"ambiguous-pending": "transient",
	"caller-copy": "unchanged-caller",
	"consumed-absent": "poison",
	"foreign-digest": "invalid",
	"malformed-closure": "poison",
	"never-issued": "invalid",
	"pending": "published",
	"published": "published",
	"successful-pending": "poison",
	"unreadable": "unknown",
	"unrelated-state": "unchanged-durable",
} satisfies Readonly<Record<string, OracleOutcome>>);

type OracleCase = keyof typeof ORACLE_OUTCOMES;
interface OracleObservation {
	readonly callerCopied: boolean;
	readonly closure: "absent" | "complete" | "malformed";
	readonly commit: "ambiguous" | "success";
	readonly consumed: boolean;
	readonly digestMatches: boolean;
	readonly preserveDurable: boolean;
	readonly probe: "caller" | "durable" | "transition";
	readonly publishState: "pending" | "published";
	readonly readback: "pending" | "published" | "unreadable";
}

interface OraclePolicy {
	readonly absentConsumed: OracleOutcome;
	readonly absentFresh: OracleOutcome;
	readonly ambiguousPending: OracleOutcome;
	readonly foreignDigest: OracleOutcome;
	readonly malformed: OracleOutcome;
	readonly publishedInput: OracleOutcome;
	readonly successfulPending: OracleOutcome;
	readonly unreadable: OracleOutcome;
}

const CORRECT_POLICY: OraclePolicy = Object.freeze({
	absentConsumed: "poison",
	absentFresh: "invalid",
	ambiguousPending: "transient",
	foreignDigest: "invalid",
	malformed: "poison",
	publishedInput: "published",
	successfulPending: "poison",
	unreadable: "unknown",
});

const OBSERVATIONS: Readonly<Record<OracleCase, OracleObservation>> = Object.freeze({
	"ambiguous-pending": {
		callerCopied: true,
		closure: "complete",
		commit: "ambiguous",
		consumed: true,
		digestMatches: true,
		preserveDurable: true,
		probe: "transition",
		publishState: "pending",
		readback: "pending",
	},
	"caller-copy": {
		callerCopied: true,
		closure: "complete",
		commit: "success",
		consumed: true,
		digestMatches: true,
		preserveDurable: true,
		probe: "caller",
		publishState: "pending",
		readback: "published",
	},
	"consumed-absent": {
		callerCopied: true,
		closure: "absent",
		commit: "success",
		consumed: true,
		digestMatches: true,
		preserveDurable: true,
		probe: "transition",
		publishState: "pending",
		readback: "pending",
	},
	"foreign-digest": {
		callerCopied: true,
		closure: "complete",
		commit: "success",
		consumed: true,
		digestMatches: false,
		preserveDurable: true,
		probe: "transition",
		publishState: "pending",
		readback: "pending",
	},
	"malformed-closure": {
		callerCopied: true,
		closure: "malformed",
		commit: "success",
		consumed: true,
		digestMatches: true,
		preserveDurable: true,
		probe: "transition",
		publishState: "pending",
		readback: "pending",
	},
	"never-issued": {
		callerCopied: true,
		closure: "absent",
		commit: "success",
		consumed: false,
		digestMatches: true,
		preserveDurable: true,
		probe: "transition",
		publishState: "pending",
		readback: "pending",
	},
	"pending": {
		callerCopied: true,
		closure: "complete",
		commit: "success",
		consumed: true,
		digestMatches: true,
		preserveDurable: true,
		probe: "transition",
		publishState: "pending",
		readback: "published",
	},
	"published": {
		callerCopied: true,
		closure: "complete",
		commit: "success",
		consumed: true,
		digestMatches: true,
		preserveDurable: true,
		probe: "transition",
		publishState: "published",
		readback: "published",
	},
	"successful-pending": {
		callerCopied: true,
		closure: "complete",
		commit: "success",
		consumed: true,
		digestMatches: true,
		preserveDurable: true,
		probe: "transition",
		publishState: "pending",
		readback: "pending",
	},
	"unreadable": {
		callerCopied: true,
		closure: "complete",
		commit: "ambiguous",
		consumed: true,
		digestMatches: true,
		preserveDurable: true,
		probe: "transition",
		publishState: "pending",
		readback: "unreadable",
	},
	"unrelated-state": {
		callerCopied: true,
		closure: "complete",
		commit: "success",
		consumed: true,
		digestMatches: true,
		preserveDurable: true,
		probe: "durable",
		publishState: "pending",
		readback: "published",
	},
});

class ReferencePublicationStore {
	readonly #policy: OraclePolicy;
	constructor(policy: OraclePolicy) {
		this.#policy = policy;
	}
	mark(observation: OracleObservation): OracleOutcome {
		if (observation.probe === "caller") return observation.callerCopied ? "unchanged-caller" : "published";
		if (observation.probe === "durable") return observation.preserveDurable ? "unchanged-durable" : "published";
		if (observation.closure === "absent") {
			return observation.consumed ? this.#policy.absentConsumed : this.#policy.absentFresh;
		}
		if (observation.closure === "malformed") return this.#policy.malformed;
		if (!observation.digestMatches) return this.#policy.foreignDigest;
		if (observation.publishState === "published" && observation.readback === "published") {
			return this.#policy.publishedInput;
		}
		if (observation.readback === "unreadable") return this.#policy.unreadable;
		if (observation.readback === "pending") {
			return observation.commit === "success" ? this.#policy.successfulPending : this.#policy.ambiguousPending;
		}
		return observation.callerCopied ? "published" : "unchanged-caller";
	}
}

const MUTANTS = Object.freeze([
	["accept-foreign-digest", "foreign-digest", { foreignDigest: "published" }],
	["accept-never-issued", "never-issued", { absentFresh: "published" }],
	["classify-consumed-absent-invalid", "consumed-absent", { absentConsumed: "invalid" }],
	["drop-digest-comparison", "foreign-digest", { foreignDigest: "published" }],
	["drop-issued-validation", "malformed-closure", { malformed: "published" }],
	["drop-lineage-validation", "consumed-absent", { absentConsumed: "invalid" }],
	["drop-pending-guard", "published", { publishedInput: "poison" }],
	["drop-preimage-validation", "malformed-closure", { malformed: "published" }],
	["expose-unknown-material", "unreadable", { unreadable: "published" }],
	["fabricate-unreadable-success", "unreadable", { unreadable: "published" }],
	["mutate-issued-bytes", "unrelated-state", { preserveDurable: false }],
	["mutate-lineage", "unrelated-state", { preserveDurable: false }],
	["mutate-outbox-digest", "unrelated-state", { preserveDurable: false }],
	["produce-commit-invalid", "ambiguous-pending", { ambiguousPending: "poison" }],
	["produce-exhausted", "foreign-digest", { foreignDigest: "poison" }],
	["produce-retry-required", "foreign-digest", { foreignDigest: "transient" }],
	["repair-corruption", "malformed-closure", { malformed: "published" }],
	["resolve-successful-pending", "successful-pending", { successfulPending: "published" }],
	["retain-caller-digest", "caller-copy", { callerCopied: false }],
	["reuse-terminal-classifier", "foreign-digest", { foreignDigest: "transient" }],
	["skip-readback", "successful-pending", { successfulPending: "published" }],
	["swap-ambiguous-taxonomy", "ambiguous-pending", { ambiguousPending: "poison" }],
] as const);

describe("D.93.29 Seam 2 shared durable publication contract", () => {
	it("keeps the exact independent Node and browser death registries causal", () => {
		assertExactDeathRegistry();
		expect(PHASE_3A1B_P2_DEATH_TUPLES).toHaveLength(14);
	});

	it("kills every named semantic mutation without rejecting the valid transition control", () => {
		expect(new Set(MUTANTS.map(([name]) => name)).size).toBe(MUTANTS.length);
		for (const caseId of Object.keys(ORACLE_OUTCOMES) as OracleCase[]) {
			expect(new ReferencePublicationStore(CORRECT_POLICY).mark(OBSERVATIONS[caseId]), caseId).toBe(
				ORACLE_OUTCOMES[caseId]
			);
		}
		for (const [mutation, caseId, change] of MUTANTS) {
			const policy = { ...CORRECT_POLICY, ...change } as OraclePolicy;
			const observation = { ...OBSERVATIONS[caseId], ...change } as OracleObservation;
			expect(new ReferencePublicationStore(policy).mark(observation), mutation).not.toBe(ORACLE_OUTCOMES[caseId]);
		}
		expect(new ReferencePublicationStore(CORRECT_POLICY).mark(OBSERVATIONS.pending)).toBe("published");
		expect(new ReferencePublicationStore(CORRECT_POLICY).mark(OBSERVATIONS.published)).toBe("published");
	});

	it("freezes the erased input and exact eight-method owner without widening runtime registries", () => {
		const types = fs.readFileSync(ISSUANCE_TYPES, "utf8");
		expect(types).toMatch(
			/export interface DurableOutboxPublicationTransitionInput\s*\{\s*readonly authorSequence: number;\s*readonly digest: Uint8Array;\s*readonly scope: DurableIssueScope;\s*\}/u
		);
		expect(types).toContain(
			"compareAndMarkOutboxPublished(input: DurableOutboxPublicationTransitionInput): Promise<void>;"
		);
		expect(durableIssuanceStoreMethodNames(types)).toEqual(PHASE_3A1B_P2_METHODS);

		const terminal = fs.readFileSync(ISSUANCE_TERMINAL, "utf8");
		const index = fs.readFileSync(ISSUANCE_INDEX, "utf8");
		expect(terminal).not.toContain("compareAndMarkOutboxPublished");
		expect(index).not.toContain("compareAndMarkOutboxPublished");
		expect(index).not.toContain("DurableOutboxPublicationTransitionInput");
		expect(source("packages/protocol-v3/src/index.ts")).not.toContain("compareAndMarkOutboxPublished");
		expect(source("packages/node/src/index.ts")).not.toContain("compareAndMarkOutboxPublished");
	});

	it("updates all genuine facade owners to eight while retaining the named stale mutant", () => {
		const owners = [
			"tests/phase-2l-a-shared-issuance-contract.test.ts",
			"packages/storage-browser/tests/phase-2l-b-browser-issuance-red.pw.ts",
			"packages/storage-node/tests/phase-2l-c-node-issuance-red.test.ts",
			"packages/storage-node/src/internal/node-issuance-store.ts",
			"packages/storage-browser/src/internal/browser-issuance-store.ts",
		];
		for (const owner of owners) {
			expect(source(owner), owner).toContain("compareAndMarkOutboxPublished");
		}
		for (const owner of ["packages/storage-node/src/issuance.ts", "packages/storage-browser/src/issuance.ts"]) {
			expect(source(owner), owner).toContain("eight-method");
		}
		expect(source("packages/storage-node/tests/phase-2l-c-node-issuance-corrective-red.test.ts")).toContain(
			"six-method"
		);
		const mutant = source("packages/storage-node/tests/fixtures/phase-2l-c-five-method-mutant.mjs");
		expect(mutant).not.toContain("compareAndMarkOutboxPublished");
		expect(mutant).toContain("five-method");
		expect(source("tests/phase-3a1-a-live-preparation-red.test.ts")).toContain('"compareAndMarkOutboxPublished"');
	});

	it("publishes one exact ephemeral closure, copies input and preserves unrelated durable facts", async () => {
		const surface = await loadConformance();
		const beforeErrors = [...surface.DURABLE_ISSUANCE_ERROR_CODES];
		const beforeRetries = [...surface.DURABLE_ISSUANCE_RETRY_CLASSES];
		const beforeAmbiguity = JSON.stringify(surface.TERMINAL_SUPPRESSION_AMBIGUITY_CASES);
		const store = surface.createEphemeralDurableIssuanceStore();
		expect(exactMethods(store)).toEqual(PHASE_3A1B_P2_METHODS);
		const primary = await store.transactIssue(PHASE_3A1B_P2_SCOPE, (ordinal) =>
			Promise.resolve(phase3a1bP2Commit(PHASE_3A1B_P2_SCOPE, ordinal, 41))
		);
		const unrelated = await store.transactIssue(PHASE_3A1B_P2_OTHER_SCOPE, (ordinal) =>
			Promise.resolve(phase3a1bP2Commit(PHASE_3A1B_P2_OTHER_SCOPE, ordinal, 73))
		);
		const beforePrimary = snapshotCommit(primary);
		const beforeUnrelated = snapshotCommit(unrelated);
		const digest = new Uint8Array(primary.envelope.digest);
		const result = store.compareAndMarkOutboxPublished({
			authorSequence: 0,
			digest,
			scope: { ...PHASE_3A1B_P2_SCOPE },
		});
		expect(result).toBeInstanceOf(Promise);
		digest.fill(0);
		await expect(result).resolves.toBeUndefined();
		await expect(
			store.compareAndMarkOutboxPublished({
				authorSequence: 0,
				digest: new Uint8Array(primary.envelope.digest),
				scope: PHASE_3A1B_P2_SCOPE,
			})
		).resolves.toBeUndefined();
		const page = await store.readOutboxPage();
		expect(page.map(({ publishState }) => publishState)).toEqual(["published", "pending"]);
		expect(snapshotCommit(required(page[0], "addressed outbox row").commit)).toEqual(beforePrimary);
		expect(snapshotCommit(required(page[1], "unrelated outbox row").commit)).toEqual(beforeUnrelated);
		expect(await store.readLineage(PHASE_3A1B_P2_SCOPE)).toEqual({ exhausted: false, next: 1 });
		expect(surface.DURABLE_ISSUANCE_ERROR_CODES).toEqual(beforeErrors);
		expect(surface.DURABLE_ISSUANCE_RETRY_CLASSES).toEqual(beforeRetries);
		expect(JSON.stringify(surface.TERMINAL_SUPPRESSION_AMBIGUITY_CASES)).toBe(beforeAmbiguity);
		await store.close();
	});

	it("rejects the closed misuse table asynchronously before state changes and keeps invalid addressing non-poisoning", async () => {
		const store = (await loadConformance()).createEphemeralDurableIssuanceStore();
		const commit = await store.transactIssue(PHASE_3A1B_P2_SCOPE, (ordinal) =>
			Promise.resolve(phase3a1bP2Commit(PHASE_3A1B_P2_SCOPE, ordinal, 91))
		);
		const valid = { authorSequence: 0, digest: new Uint8Array(commit.envelope.digest), scope: PHASE_3A1B_P2_SCOPE };
		const invalid: readonly unknown[] = [
			null,
			[],
			{},
			{ ...valid, extra: true },
			{ authorSequence: -1, digest: valid.digest, scope: valid.scope },
			{ authorSequence: 0, digest: new Uint8Array(), scope: valid.scope },
			Object.defineProperty({ authorSequence: 0, digest: valid.digest }, "scope", {
				enumerable: true,
				get: () => valid.scope,
			}),
			Object.assign(Object.create({ authorSequence: 0 }), { digest: valid.digest, scope: valid.scope }),
			{ ...valid, [Symbol("hidden")]: true },
		];
		for (const value of invalid) {
			const error = await rejected(() => Reflect.apply(store.compareAndMarkOutboxPublished, store, [value]));
			expect(errorShape(error)).toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT" });
			expect((await store.readOutboxPage())[0]?.publishState).toBe("pending");
		}
		const absent = await rejected(() =>
			store.compareAndMarkOutboxPublished({ ...valid, authorSequence: 1, digest: new Uint8Array(valid.digest) })
		);
		expect(errorShape(absent)).toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT" });
		const foreign = await rejected(() =>
			store.compareAndMarkOutboxPublished({ ...valid, digest: Uint8Array.of(0xff, 0xee) })
		);
		expect(errorShape(foreign)).toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT" });
		await expect(
			store.compareAndMarkOutboxPublished({ ...valid, digest: new Uint8Array(valid.digest) })
		).resolves.toBeUndefined();
		await store.close();
		const closed = await rejected(() =>
			store.compareAndMarkOutboxPublished({ ...valid, digest: new Uint8Array(valid.digest) })
		);
		expect(errorShape(closed)).toMatchObject({ code: "ISSUANCE_STORE_CLOSED" });
	});

	it("latches the executable ephemeral corruption control across the sixth method and existing reads", async () => {
		const store = (await loadConformance()).createEphemeralDurableIssuanceStore({
			initialPoison: "recovery-corrupt",
		});
		const first = await rejected(() =>
			store.compareAndMarkOutboxPublished({
				authorSequence: 0,
				digest: Uint8Array.of(41, 0xd1),
				scope: PHASE_3A1B_P2_SCOPE,
			})
		);
		const second = await rejected(() => store.readLineage(PHASE_3A1B_P2_SCOPE));
		expect(errorShape(first)).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
		expect(second).toBe(first);
		await expect(store.close()).resolves.toBeUndefined();
	});

	it("keeps publication adapter-local and forbids classifier/schema/export sediment", () => {
		const conformance = fs.readFileSync(ISSUANCE_CONFORMANCE, "utf8");
		expect(conformance).toContain("compareAndMarkOutboxPublished");
		expect(conformance).not.toMatch(
			/classifyDurableIssuanceTerminalSuppression[\s\S]{0,400}compareAndMarkOutboxPublished/u
		);
		for (const file of [
			"packages/issuance-store/src/terminal.ts",
			"packages/issuance-store/src/index.ts",
			"packages/storage-node/src/index.ts",
			"packages/storage-browser/src/index.ts",
			"packages/protocol-v3/src/index.ts",
			"packages/node/src/index.ts",
		]) {
			expect(source(file), file).not.toContain("compareAndMarkOutboxPublished");
		}
		const issuanceManifest = JSON.parse(source("packages/issuance-store/package.json")) as Record<string, unknown>;
		const nodeManifest = JSON.parse(source("packages/storage-node/package.json")) as Record<string, unknown>;
		const browserManifest = JSON.parse(source("packages/storage-browser/package.json")) as Record<string, unknown>;
		const protocolManifest = JSON.parse(source("packages/protocol-v3/package.json")) as Record<string, unknown>;
		expect(issuanceManifest.exports).toEqual({
			".": { import: "./dist/src/index.js", types: "./dist/src/index.d.ts" },
			"./conformance": { import: "./dist/src/conformance.js", types: "./dist/src/conformance.d.ts" },
			"./maintenance": { import: "./dist/src/maintenance.js", types: "./dist/src/maintenance.d.ts" },
		});
		expect(Object.keys((nodeManifest.exports as Record<string, unknown>) ?? {}).sort()).toEqual([
			".",
			"./issuance",
			"./issuance-maintenance",
			"./live-journal",
			...(Object.hasOwn((nodeManifest.exports as Record<string, unknown>) ?? {}, "./maintenance")
				? ["./maintenance"]
				: []),
			"./snapshot-transfer",
		]);
		expect(Object.keys((browserManifest.exports as Record<string, unknown>) ?? {}).sort()).toEqual([
			".",
			"./issuance",
			"./issuance-maintenance",
			"./live-journal",
			...(Object.hasOwn((browserManifest.exports as Record<string, unknown>) ?? {}, "./maintenance")
				? ["./maintenance"]
				: []),
			"./seal-evidence",
			"./seal-vote",
			"./snapshot-transfer",
		]);
		expect(
			(protocolManifest.dependencies as Record<string, unknown> | undefined)?.["@ts-drp/issuance-store"]
		).toBeUndefined();
	});

	it("keeps the exact runtime roots and immutable classifier owners while forbidding publication claims", async () => {
		expect(await runtimeNames("packages/issuance-store/dist/src/conformance.js")).toEqual([
			"DURABLE_ISSUANCE_ERROR_CODES",
			"DURABLE_ISSUANCE_RETRY_CLASSES",
			"TERMINAL_SUPPRESSION_AMBIGUITY_CASES",
			"classifyTerminalSuppression",
			"createEphemeralDurableIssuanceStore",
			"resolveEphemeralDurableIssuancePruningMaintenance",
		]);
		expect(await runtimeNames("packages/issuance-store/dist/src/index.js")).toEqual([
			"DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT",
			"DURABLE_ISSUANCE_ERROR_CODES",
			"DURABLE_ISSUANCE_RETRY_CLASSES",
			"DurableIssuanceContractError",
			"DurableIssuanceInvalidArgumentError",
			"DurableIssuanceUnknownOutcomeError",
			"MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT",
			"MAXIMUM_DURABLE_ISSUANCE_SCOPE_UTF16_UNITS",
			"applySettlementPlanEffect",
			"assertDurableIssueScope",
			"captureSettlementPlanWriteInput",
			"classifyDurableIssuanceTerminalSuppression",
			"cloneDurableIssueCommit",
			"cloneDurableSignedEnvelope",
			"cloneSettlementPlan",
			"compareDurableIssuanceCompoundKeys",
			"copyAndValidateDurableIssueCommit",
			"copyDurableIssuanceBytes",
			"copyDurableIssueScope",
			"copyDurableIssuedRecord",
			"copyDurableSignedEnvelope",
			"copySettlementPlan",
			"copySettlementPlanEffect",
			"createDurableIssuanceFailure",
			"durableIssuanceBytesEqual",
			"durableIssueScopesEqual",
			"durablePreimageMatchesScopeAndSequence",
			"isClosedDurableIssuanceRecord",
			"isValidDurableAuthorSequence",
			"isValidDurableScopeField",
		]);
		expect(sha256(source("packages/issuance-store/src/contract.ts"))).toBe(
			"49ac5a1d2b44f69a6becc3f3bcd4e44c2d4e178512a0d8489ae28766fa636cf7"
		);
		expect(sha256(source("packages/issuance-store/src/terminal.ts"))).toBe(
			"a71b32967ca152c12b10adad4f3303696fb42d4379892cc27c4937af19d42a4a"
		);
		expect(sha256(source("packages/issuance-store/src/index.ts"))).toBe(
			"62b3b2c62e7cc230820ba56e8867be76f17861dde3b45d645c2855a11b6afa93"
		);
		for (const owner of [
			"packages/issuance-store/src/conformance.ts",
			"packages/storage-node/src/internal/node-issuance-store.ts",
			"packages/storage-browser/src/internal/browser-issuance-store.ts",
			"packages/storage-node/src/issuance.ts",
			"packages/storage-browser/src/issuance.ts",
		]) {
			expect(source(owner), owner).not.toMatch(/peer receipt|remote admission|network exactly-once|exactly once/iu);
		}
	});

	it("pins the existing closed taxonomy and post-close precedence in every implementation owner", () => {
		for (const owner of [
			"packages/issuance-store/src/conformance.ts",
			"packages/storage-node/src/internal/node-issuance-store.ts",
			"packages/storage-browser/src/internal/browser-issuance-store.ts",
		]) {
			const ownerSource = source(owner);
			const neighborhood = required(
				methodBody(ownerSource, "compareAndMarkOutboxPublished"),
				`${owner}: compareAndMarkOutboxPublished method`
			);
			for (const code of [
				"ISSUANCE_INVALID_ARGUMENT",
				"ISSUANCE_OUTCOME_UNKNOWN",
				"ISSUANCE_RECOVERY_CORRUPT",
				"ISSUANCE_STORE_CLOSED",
				"ISSUANCE_SUBSTRATE_FAILURE",
			]) {
				expect(ownerSource, `${owner}: ${code}`).toContain(code);
			}
			for (const forbidden of ["ISSUANCE_COMMIT_INVALID", "ISSUANCE_EXHAUSTED", "ISSUANCE_RETRY_REQUIRED"]) {
				expect(neighborhood, `${owner}: ${forbidden}`).not.toContain(forbidden);
			}
			expect(neighborhood).not.toMatch(/peer receipt|network exactly-once|remote admission/iu);
		}
	});
});
