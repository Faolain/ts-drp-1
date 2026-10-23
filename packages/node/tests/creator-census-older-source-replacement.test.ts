import { readFileSync } from "node:fs";
import ts from "typescript";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

// Track X, decision row 60 (R6, owner's R6-A): the recovery census recognizes a displaced own
// source as settled by a completed nonportable replacement (completedNonportableReplacementChunk)
// by deriving the replacement again with deriveOwnedReplacement, which needs the source epoch's
// ACL; only the immediately closed epoch's resolves. For a source older than that, completion is
// recognized with the original immutable policy's derivation (derivePolicyReplacement): the source
// stays authenticated by the census's own classification, and the plan entry and replacement rows
// are checked as before. This executes the private production functions on data: the
// classification, the issuance store and the nested-source check are premises here.
const path = new URL("../src/v3-live.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const found: ts.FunctionDeclaration[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	if (found.length !== 1) throw Error(`PRIVATE_FUNCTION_NOT_UNIQUE:${name}:${found.length}`);
	return found[0]!.getText(parsed);
}
const code = [
	"ownSourceSettlementIsComplete",
	"completedNonportableReplacementChunk",
	"olderSourcePolicyReplacementChunk",
	"derivePolicyReplacement",
	"derivePolicySettlement",
	"settlementSourceOperations",
]
	.map(declaration)
	.join("\n");

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const plain = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
const context = {
	isObject: (value: unknown) => value !== null && typeof value === "object",
	ObjectFreeze: Object.freeze,
	ArrayIsArray: Array.isArray,
	NumberIsSafeInteger: Number.isSafeInteger,
	encodeCanonical,
	decodeCanonical,
	hashDomain,
	sameBytes,
	lowerHexDigest: (value: Uint8Array) => Buffer.from(value).toString("hex"),
	sameScope: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
	AUTHOR_FENCE_ACTION: "$drp.author-fence.v1",
	APPLICATION_BATCH_ACTION: "applicationBatch",
	isReservedBatchAction: () => false,
	settlementProfileFor: () => "v1",
	creatorOriginalIssuanceStore: (registration: { store: unknown }) => registration.store,
	outboxRowSnapshot: ({ commit }: { commit: unknown }) => commit ?? undefined,
	classifyRebaseRow: (registration: { classify(row: unknown): unknown }, row: unknown) => registration.classify(row),
	validRebaseRow: () => true,
	verifyNestedNativeSource: async () => true,
	snapshotClosedRecord: () => undefined,
	PORTABLE_SETTLEMENT_SOURCE_KEYS: [],
	verifyCreatorSettlementSourceSelection: () => false,
	creatorSettlementSelectionBytes: () => new Uint8Array(),
	resolveCreatorSettlementAuthor: () => "creator",
	isV3ApplicationAuthorAuthorized: (authorization: { writers: string[] }, author: string) =>
		authorization.writers.includes(author),
	applicationBatchEntries: () => undefined,
	// The source epoch's ACL does not resolve: the original derivation refuses, as for any source
	// older than the immediately closed epoch.
	deriveOwnedReplacement: () => {
		throw new TypeError("original replacement source Writer authority is unavailable");
	},
	currentRegistration: () => true,
	isControlOperation: (operation: { action?: unknown }) =>
		typeof operation.action === "string" && operation.action.startsWith("$drp."),
	rebaseIntents: (_payload: unknown, authenticated: { vertex: { operation: unknown } }) => [
		{ operation: authenticated.vertex.operation, logicalTime: 0, operationCount: 1, operationIndex: 0 },
	],
	detachedCanonicalOperation: (operation: unknown) => plain(operation),
	canonicalRecord: (value: unknown, keys: readonly string[]) =>
		value !== null &&
		typeof value === "object" &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => key in value)
			? (value as Record<string, unknown>)
			: undefined,
	ISSUANCE_RETIREMENT_LIMITS: { maxBytes: 1 << 20 },
	SETTLEMENT_REPLACEMENT_MAX_INTENTS: 64,
	SETTLEMENT_REPLACEMENT_DIGEST_LIMITS: { maxBytes: 1 << 20, maxDepth: 16, maxItems: 65536 },
};
const functions = Function(
	...Object.keys(context),
	`"use strict";${
		ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } })
			.outputText
	}return { ownSourceSettlementIsComplete };`
)(...Object.values(context)) as {
	ownSourceSettlementIsComplete(
		registration: unknown,
		selected: unknown,
		plan: unknown
	): Promise<boolean>;
};

const scope = { author: "writer", objectId: "room" };
const move = { action: "placeBlock", id: "seal-1-1", kind: "gold", x: 9, y: 5 };
const rebased = { ...move, rebased: true };
const digest = (sequence: number) => Uint8Array.of(sequence);
const row = (authorSequence: number, epoch: number, operation: unknown) => ({
	scope,
	authorSequence,
	digest: digest(authorSequence),
	epoch,
	operation,
});
const classify = (value: ReturnType<typeof row>) => ({
	kind: "displaced",
	row: value,
	authenticated: {
		author: scope.author,
		authorSequence: value.authorSequence,
		digest: Buffer.from(digest(value.authorSequence)).toString("hex"),
		admitted: { epoch: value.epoch, anchor: `anchor-${value.epoch}`, logicalTime: 0 },
		vertex: { operation: value.operation },
	},
});
const proposal = (operations: unknown) =>
	hashDomain(
		"ts-drp/settlement-transform-proposal/v1",
		encodeCanonical(operations, { maxBytes: 1 << 20, maxDepth: 16, maxItems: 65536 })
	);

interface Case {
	sourceEpoch?: number;
	replacement?: unknown;
	issued?: boolean;
	disposition?: string;
	refusal?: Uint8Array;
	policy?: "expire" | "manual-review" | "rebase" | "transform";
	sourceDigest?: Uint8Array;
	replacementSequence?: number | null;
}

async function completed(input: Case = {}): Promise<boolean> {
	const issued = new Map<number, unknown>();
	if (input.issued !== false) issued.set(9, row(9, 3, input.replacement ?? rebased));
	const registration = {
		payload: {
			parameters: { maxEpochVertices: 8 },
			trust: { trust: { profileId: "creator-trusted-settlement-v1" } },
			provenance: { epoch: 3, blueprintDigest: "blueprint" },
			input: {
				settlementPolicy: {
					blueprintDigest: "blueprint",
					derive: (operations: readonly Record<string, unknown>[]) => ({
						disposition: input.policy ?? "rebase",
						operations: input.policy === "expire" || input.policy === "manual-review" ? [] :
							operations.map((operation) => ({ ...operation, rebased: true })),
					}),
				},
			},
		},
		authorization: { writers: [scope.author] },
		issuanceScope: scope,
		store: { readIssued: async (_scope: unknown, sequence: number) => issued.get(sequence) ?? null },
		classify,
	};
	const plan = {
		entries: [
			{
				sourceSequence: 7,
				sourceDigest: input.sourceDigest ?? digest(7),
				disposition: input.disposition ?? "rebase",
				replacementSequence: input.replacementSequence === undefined ? 9 : input.replacementSequence,
				...(input.refusal === undefined
					? {}
					: { transformRefusal: { version: 1, kind: "admission-refused", proposedIntentDigest: input.refusal } }),
			},
		],
	};
	return functions.ownSourceSettlementIsComplete(
		registration,
		classify(row(7, input.sourceEpoch ?? 1, move)),
		plan
	);
}

describe("R6-A: a completed nonportable replacement of a source older than the closed epoch", () => {
	it("is recognized by the immutable policy's derivation", async () => {
		expect(await completed()).toBe(true);
		// A recorded admission refusal: the replacement is the source's own operations under the
		// policy proposal's digest.
		expect(
			await completed({
				policy: "transform",
				disposition: "transform",
				refusal: proposal([rebased]),
				replacement: move,
			})
		).toBe(true);
	});

	it("fails closed on a mismatched derivation", async () => {
		// The replacement is not the policy's derivation of the source.
		expect(await completed({ replacement: move })).toBe(false);
		expect(await completed({ replacement: { ...rebased, y: 6 } })).toBe(false);
		// The plan's disposition differs from the policy's.
		expect(await completed({ disposition: "transform" })).toBe(false);
		// A recorded refusal whose proposal digest is not the policy's.
		expect(
			await completed({ policy: "transform", disposition: "transform", refusal: proposal([move]), replacement: move })
		).toBe(false);
		// A refusal with the policy's digest, but the replacement is not the source's own operations.
		expect(
			await completed({
				policy: "transform",
				disposition: "transform",
				refusal: proposal([rebased]),
				replacement: rebased,
			})
		).toBe(false);
	});

	it("fails closed when the plan entry's replacement rows are absent", async () => {
		expect(await completed({ issued: false })).toBe(false);
	});

	it("keeps the original derivation for the immediately closed epoch", async () => {
		// The closed epoch's source must resolve its ACL through deriveOwnedReplacement; the policy
		// derivation is not a fallback for it.
		expect(await completed({ sourceEpoch: 2 })).toBe(false);
		expect(await completed({ sourceEpoch: 3 })).toBe(false);
	});
});


describe("shared own-source completion for expiry and review", () => {
	it("recognizes expiry only when the immutable policy derives expiry for the exact source", async () => {
		expect(await completed({ policy: "expire", disposition: "expire", replacementSequence: null, issued: false })).toBe(true);
		expect(await completed({ disposition: "expire", replacementSequence: null })).toBe(false);
		expect(await completed({ policy: "expire", disposition: "expire", replacementSequence: null,
			sourceDigest: digest(8) })).toBe(false);
		expect(await completed({ policy: "expire", disposition: "expire" })).toBe(false);
	});
	it("keeps manual-review unresolved even with a fabricated completed link", async () => {
		expect(await completed({ policy: "manual-review", disposition: "manual-review", replacementSequence: null })).toBe(false);
		expect(await completed({ policy: "manual-review", disposition: "manual-review" })).toBe(false);
	});
});
