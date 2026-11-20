import { readFileSync } from "node:fs";
import ts from "typescript";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

// fix/browser-rollover-member-stall, blocker (c) of rule R (replacement retarget).
//
// Rule R defers an install's replacements when the creator's next offer is already queued: the displaced
// row stays an unreplaced plan entry and the next install replaces it. That install's registration holds
// the source authority of the epoch it just closed only (displacedSource: the predecessor plane's prepared
// payload and ACL; historicalIssuance: the closed epoch's verified ACL). A row deferred at the install to
// E (its source epoch E-1 = that install's displaced source) is two epochs back at the install to E+1,
// whose displaced source is E: the authority of E-1 was dropped with the predecessor registration, and
// deriveOwnedReplacement refused ("original replacement source Writer authority is unavailable"; box diag
// d2 on the chain RED, 2026-11-14).
//
// The successor keeps the authorities its predecessor held for earlier epochs (keptDisplacedSources), the
// same authenticated objects, bounded by the own-row settlement window (a row past it expires and its move
// is given back), and the replacement resolves its source's authority by the row's own signed epoch and
// anchor (displacedSourceFor). The original check is unchanged: the author must be a Writer under the
// source epoch's ACL.
//
// This executes the private production functions on data, like creator-census-older-source-replacement:
// classification, the issuance store and the admission policy are premises here.
const path = new URL("../src/v3-live.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
function declarations(name: string): ts.FunctionDeclaration[] {
	const found: ts.FunctionDeclaration[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	return found;
}
function declaration(name: string): string {
	const found = declarations(name);
	if (found.length !== 1) throw Error(`PRIVATE_FUNCTION_NOT_UNIQUE:${name}:${found.length}`);
	return found[0]!.getText(parsed);
}
// The fix's helpers are absent at the RED base; the derivation itself is always present.
const present = (name: string): boolean => declarations(name).length === 1;
const names = [
	"deriveOwnedReplacement",
	"derivePolicyReplacement",
	"derivePolicySettlement",
	"settlementOwnRowWindowExpired",
	...["displacedSourceFor", "keptDisplacedSources"].filter(present),
];
const code = names.map(declaration).join("\n");

const plain = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
const context = {
	ObjectFreeze: Object.freeze,
	ArrayIsArray: Array.isArray,
	NumberIsSafeInteger: Number.isSafeInteger,
	encodeCanonical,
	decodeCanonical,
	hashDomain,
	sameBytes: (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0,
	currentRegistration: () => true,
	// Premise: an authorization is a Writer list (the real check is authorizeLatchedApplicationWrite).
	isV3ApplicationAuthorAuthorized: (authorization: { writers: string[] }, author: string) =>
		authorization.writers.includes(author),
	verifiedNestedNativeSources: new WeakSet(),
	// No verified historical owner names a source older than the immediately closed epoch.
	resolveVerifiedHistoricalSourceAcl: () => undefined,
	isControlOperation: (operation: { action?: unknown }) =>
		typeof operation.action === "string" && operation.action.startsWith("$drp."),
	rebaseIntents: (_payload: unknown, authenticated: { vertex: { operation: unknown } }) => [
		{ operation: authenticated.vertex.operation, logicalTime: 0, operationCount: 1, operationIndex: 0 },
	],
	detachedCanonicalOperation: (operation: unknown) => plain(operation),
	canonicalRecord: (value: unknown, keys: readonly string[]) =>
		value !== null && typeof value === "object" && Object.keys(value).length === keys.length &&
		keys.every((key) => key in value)
			? (value as Record<string, unknown>)
			: undefined,
	ownDataValue: (value: object, key: string) => Reflect.get(value, key),
	ISSUANCE_RETIREMENT_LIMITS: { maxBytes: 1 << 20 },
	SETTLEMENT_REPLACEMENT_MAX_INTENTS: 64,
	SETTLEMENT_REPLACEMENT_DIGEST_LIMITS: { maxBytes: 1 << 20, maxDepth: 16, maxItems: 65536 },
	V3_SETTLEMENT_OWN_WINDOW_EPOCHS: 4,
};
const functions = Function(
	...Object.keys(context),
	`"use strict";${
		ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } })
			.outputText
	}return { deriveOwnedReplacement, keptDisplacedSources: typeof keptDisplacedSources === "function" ? keptDisplacedSources : undefined };`
)(...Object.values(context)) as {
	deriveOwnedReplacement(registration: unknown, selected: unknown, input: unknown): { disposition: string; operations: unknown[] };
	keptDisplacedSources?: (predecessor: unknown, successorEpoch: number) => readonly unknown[];
};

const writer = "writer";
const scope = { author: writer, objectId: "room" };
const move = { action: "placeBlock", id: "seal-1-1", kind: "gold", x: 9, y: 5 };
const policy = {
	blueprintDigest: "blueprint",
	derive: (operations: readonly Record<string, unknown>[]) => ({
		disposition: "rebase",
		operations: operations.map((operation) => ({ ...operation, rebased: true })),
	}),
};
const prepared = (epoch: number, objectId = "room", genesis = "genesis") => ({
	parameters: { maxEpochVertices: 8 },
	trust: { trust: { profileId: "creator-trusted-settlement-v1", genesisAnchorDigest: genesis } },
	provenance: { epoch, anchorDigest: `anchor-${epoch}`, blueprintDigest: "blueprint", objectId },
	input: { settlementPolicy: policy },
});
const authority = (epoch: number, writers: string[] = [writer], objectId = "room", genesis = "genesis") => ({
	authorization: { writers },
	pinnedGenesisAnchorDigest: "genesis-pin",
	prepared: prepared(epoch, objectId, genesis),
});
const displaced = (epoch: number, anchor = `anchor-${epoch}`) => ({
	kind: "displaced",
	row: { scope, authorSequence: 7, digest: Uint8Array.of(7) },
	authenticated: {
		author: writer,
		authorSequence: 7,
		digest: "07",
		admitted: { epoch, anchor, logicalTime: 0 },
		vertex: { operation: move },
	},
});
// The install to epoch 6: its displaced source is epoch 5 (the epoch it closed).
const registration = (older?: readonly unknown[]) => ({
	payload: prepared(6),
	authorization: { writers: [writer] },
	issuanceScope: scope,
	displacedSource: authority(5),
	...(older === undefined ? {} : { olderDisplacedSources: older }),
});
const input = { operations: [{ operation: { ...move, rebased: true } }], planEffect: { kind: "replacement", sourceSequence: 7 } };
const derive = (value: unknown, selected: unknown) => functions.deriveOwnedReplacement(value, selected, input);
const UNAVAILABLE = "original replacement source Writer authority is unavailable";

describe("rule R blocker (c): the source authority of a row displaced more than one epoch back", () => {
	it("still derives a replacement of a row of the immediately closed epoch", () => {
		expect(derive(registration(), displaced(5))).toMatchObject({ disposition: "rebase", operations: [{ ...move, rebased: true }] });
	});

	it("derives a deferred row's replacement two epochs back from the authority the successor kept", () => {
		expect(derive(registration([authority(4)]), displaced(4))).toMatchObject({
			disposition: "rebase",
			operations: [{ ...move, rebased: true }],
		});
		// Three epochs back, still inside the settlement window.
		expect(derive(registration([authority(4), authority(3)]), displaced(3))).toMatchObject({ disposition: "rebase" });
	});

	it("keeps the original check: the author must be a Writer under the source epoch's own ACL", () => {
		// Kept, but the author was not a Writer in epoch 4: refused, even though it is one now.
		expect(() => derive(registration([authority(4, ["someone-else"])]), displaced(4))).toThrow(UNAVAILABLE);
		// Nothing kept for epoch 4.
		expect(() => derive(registration([authority(3)]), displaced(4))).toThrow(UNAVAILABLE);
		expect(() => derive(registration(), displaced(4))).toThrow(UNAVAILABLE);
		// The row's signed anchor is not the kept epoch's anchor.
		expect(() => derive(registration([authority(4)]), displaced(4, "anchor-forked"))).toThrow(UNAVAILABLE);
	});

	it("the successor keeps its predecessor's earlier authorities, inside the settlement window only", () => {
		const keep = functions.keptDisplacedSources;
		expect(keep, "keptDisplacedSources (the successor keeps the predecessor's displaced source)").toBeTypeOf("function");
		// The install to 6 from the epoch-5 plane, whose displaced source is 4 and which kept 3 and 2.
		const predecessor = {
			payload: prepared(5),
			displacedSource: authority(4),
			olderDisplacedSources: [authority(3), authority(2)],
		};
		const kept = keep!(predecessor, 6) as readonly ReturnType<typeof authority>[];
		// Epoch 2 is at the window's edge for 6 (2 <= 6 - 4): its rows expire, so it is dropped.
		expect(kept.map((value) => value.prepared.provenance.epoch)).toEqual([4, 3]);
		// The same authenticated objects, nothing reauthorized.
		expect(kept[0]!.prepared).toBe(predecessor.displacedSource.prepared);
		expect(kept[0]!.authorization).toBe(predecessor.displacedSource.authorization);
		// Never another object's (a migration source), another genesis (a native branch) or a later epoch.
		expect(
			keep!({ payload: prepared(5), displacedSource: authority(4, [writer], "other-room") }, 6)
		).toEqual([]);
		expect(keep!({ payload: prepared(5), displacedSource: authority(4, [writer], "room", "other-genesis") }, 6)).toEqual([]);
		expect(keep!({ payload: prepared(5), displacedSource: authority(5) }, 6)).toEqual([]);
		expect(
			keep!({ payload: prepared(5), displacedSource: { ...authority(4), activationVertexDigest: "ab".repeat(32) } }, 6)
		).toEqual([]);
		expect(keep!({ payload: prepared(5) }, 6)).toEqual([]);
	});
});
