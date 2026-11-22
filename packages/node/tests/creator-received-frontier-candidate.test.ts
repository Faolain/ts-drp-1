import { readFileSync } from "node:fs";
import ts from "typescript";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

// Track X, decision row 60 (R5b, owner's B2): a recipient's closed-membership carrier candidate
// subtracts, per author that the successor's creator-signed settlement record names, every row
// beyond that author's terminalThrough. The candidate is never membership: the recipient records
// it only when its close-set commitment equals the signed Cut's (recordCreatorReceivedClosedMembership).
// An author the record does not name keeps all its rows, so an outside row of such an author
// leaves the commitment unequal and no carrier is recorded. This executes the private production
// functions on data.
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
	"creatorReceivedFrontierCandidate",
	"creatorReceivedSettlementTerminalThrough",
	"creatorReceivedCutWithout",
]
	.map(declaration)
	.join("\n");
const context = {
	ObjectFreeze: Object.freeze,
	IntrinsicMap: Map,
	Uint8ArrayConstructor: Uint8Array,
	ArrayIsArray: Array.isArray,
	NumberIsSafeInteger: Number.isSafeInteger,
	isObject: (value: unknown) => value !== null && typeof value === "object",
	ownDataValue: (value: object, key: string) => Object.getOwnPropertyDescriptor(value, key)?.value,
	decodeCanonical,
	CREATOR_AUTHOR_SETTLEMENT_KIND: "drp-creator-author-settlement-state",
};
type Candidate = { frontier: string[]; charges: Map<string, number>; members: ReadonlySet<string> } | undefined;
const functions = Function(
	...Object.keys(context),
	`"use strict";${
		ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } })
			.outputText
	}return { creatorReceivedFrontierCandidate, creatorReceivedSettlementTerminalThrough };`
)(...Object.values(context)) as {
	creatorReceivedFrontierCandidate(
		registration: unknown,
		graph: unknown,
		through: ReadonlyMap<string, number | null>
	): Candidate;
	creatorReceivedSettlementTerminalThrough(
		bytes: unknown,
		scope: unknown
	): ReadonlyMap<string, number | null> | undefined;
};

const anchor = "aa".repeat(32);
const registration = { payload: { provenance: { anchorDigest: anchor } } };
const scope = { objectId: "room", epoch: 3, anchorDigest: anchor };
// creator c0 <- writer A a4 <- A's move after the seal a5; writer B b6 <- B's move after the seal b7 (depends
// on a4); author X x2 (depends on c0).
const rows = [
	["c0", "creator", 0, [anchor]],
	["a4", "writer-a", 4, ["c0"]],
	["a5", "writer-a", 5, ["a4"]],
	["b6", "writer-b", 6, ["c0"]],
	["b7", "writer-b", 7, ["b6", "a4"]],
	["x2", "writer-x", 2, ["c0"]],
] as const;
const graph = (included: readonly string[] = rows.map(([digest]) => digest)) => ({
	authors: new Map(
		rows
			.filter(([digest]) => included.includes(digest))
			.map(([digest, author, authorSequence]) => [digest, { author, authorSequence }])
	),
	vertices: new Map<string, { dependencies: readonly string[] }>(
		rows.filter(([digest]) => included.includes(digest)).map(([digest, , , dependencies]) => [digest, { dependencies }])
	),
	charges: new Map(
		rows.filter(([digest]) => included.includes(digest)).map(([digest], index) => [digest, 100 + index])
	),
});
const through = (entries: readonly (readonly [string, number | null])[]) => new Map(entries);
const settlement = (fields: Record<string, unknown> = {}) =>
	encodeCanonical({
		kind: "drp-creator-author-settlement-state",
		objectId: scope.objectId,
		closedEpoch: scope.epoch,
		closedAnchorDigest: scope.anchorDigest,
		frontiers: [
			["creator", 0, 0],
			["writer-a", 0, 4],
			["writer-b", 1, 6],
		],
		...fields,
	});

describe("R5b: the received carrier candidate subtracts rows beyond each named author's terminalThrough", () => {
	it("removes every named author's rows beyond its terminalThrough, own and received alike", () => {
		const candidate = functions.creatorReceivedFrontierCandidate(
			registration,
			graph(["c0", "a4", "a5", "b6", "b7"]),
			through([
				["creator", 0],
				["writer-a", 4],
				["writer-b", 6],
			])
		);
		expect([...(candidate?.members ?? [])]).toEqual(["c0", "a4", "b6"]);
		expect([...(candidate?.charges.keys() ?? [])]).toEqual(["c0", "a4", "b6"]);
		expect(candidate?.frontier).toEqual(["a4", "b6"]);
	});

	it("(c) keeps every row of an author the settlement record does not name", () => {
		const candidate = functions.creatorReceivedFrontierCandidate(
			registration,
			graph(),
			through([
				["creator", 0],
				["writer-a", 4],
				["writer-b", 6],
			])
		);
		// x2 stays: the candidate's commitment then differs from a Cut without it, so no carrier.
		expect([...(candidate?.members ?? [])]).toEqual(["c0", "a4", "b6", "x2"]);
	});

	it("removes all rows of an author whose terminalThrough is null, and nothing when nothing is beyond", () => {
		const candidate = functions.creatorReceivedFrontierCandidate(
			registration,
			graph(["c0", "a4", "b6"]),
			through([
				["creator", 0],
				["writer-a", 4],
				["writer-b", null],
			])
		);
		expect([...(candidate?.members ?? [])]).toEqual(["c0", "a4"]);
		expect(
			functions.creatorReceivedFrontierCandidate(
				registration,
				graph(["c0", "a4"]),
				through([
					["creator", 0],
					["writer-a", 4],
				])
			)
		).toBeUndefined();
	});

	it("refuses a candidate whose remaining vertex depends on a subtracted row", () => {
		// b7 is in the Cut by B's terminalThrough, but depends on a5, which A's subtracts.
		const dependent = graph(["c0", "a4", "a5", "b6", "b7"]);
		dependent.vertices.set("b7", { dependencies: ["b6", "a5"] });
		expect(
			functions.creatorReceivedFrontierCandidate(
				registration,
				dependent,
				through([
					["creator", 0],
					["writer-a", 4],
					["writer-b", 7],
				])
			)
		).toBeUndefined();
	});

	it("reads terminalThrough only from a settlement record of this exact closed scope", () => {
		expect([...(functions.creatorReceivedSettlementTerminalThrough(settlement(), scope) ?? [])]).toEqual([
			["creator", 0],
			["writer-a", 4],
			["writer-b", 6],
		]);
		expect(functions.creatorReceivedSettlementTerminalThrough(null, scope)).toBeUndefined();
		expect(functions.creatorReceivedSettlementTerminalThrough(settlement({ closedEpoch: 2 }), scope)).toBeUndefined();
		expect(
			functions.creatorReceivedSettlementTerminalThrough(settlement({ closedAnchorDigest: "bb".repeat(32) }), scope)
		).toBeUndefined();
		expect(
			functions.creatorReceivedSettlementTerminalThrough(settlement({ kind: "drp-hard-epoch-cut" }), scope)
		).toBeUndefined();
		expect(
			functions.creatorReceivedSettlementTerminalThrough(
				settlement({
					frontiers: [
						["writer-a", 0, 4],
						["writer-a", 0, 5],
					],
				}),
				scope
			)
		).toBeUndefined();
		expect(
			functions.creatorReceivedSettlementTerminalThrough(settlement({ frontiers: [["writer-a", 0, -1]] }), scope)
		).toBeUndefined();
	});
});
