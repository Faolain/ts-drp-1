import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// fix/browser-rollover-member-stall, box m46 (tests/creator-retirement-crash-native.test.ts, edges 4 and
// 5, at the RED base 57751164 and with the cold-reopen fix 80fce43e, in all three runs): the creator was
// SIGKILLed after the snapshot store's commit 4 counted from a fresh ACTIVE AHE retirement preparation,
// the first state-changing snapshot commit inside the install (edges 2 and 3 there are read transactions
// and recover). That commit is the snapshot participant's prepareFence: the snapshot retirement control
// holds the coordinator's own active preparation. Every reopen then refused at once with "creator
// snapshot role reconciliation refused: snapshot-unavailable" (reconcileSnapshotRecoveryRoles, the
// turnover selection's requireLaw), before the install could resume the prepared participant (its
// participant layer validates a "prepared" phase against the coordinator's durable commitment). The
// room never closed again.
//
// The turnover selection is scheduling only. A fence the coordinator's own active preparation owns must
// be finished by that install; turnover must not change the pool under it, so the selection keeps the
// whole CURRENT pool and retires nothing until it completes, as a blocked completed fence does. A fence
// no active coordinator preparation owns still refuses.
//
// This executes the private production selection on data.
const path = new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const found: ts.FunctionDeclaration[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	const [only] = found;
	if (found.length !== 1 || only === undefined) throw Error(`PRIVATE_FUNCTION_NOT_UNIQUE:${name}:${found.length}`);
	return only.getText(parsed);
}
const code = ["completeSnapshotRecoveryInventoryIsPresent", "selectCurrentSnapshotTurnoverInventory"]
	.map(declaration)
	.join("\n");
const context = {
	closedRetirementEqual: (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right),
};
type Labels = { decisionDigest: string; sourceProofDigest: string };
type Selection = { survivingScopes: unknown[]; retiringScopes: unknown[] } | undefined;
const { selectCurrentSnapshotTurnoverInventory } = Function(
	...Object.keys(context),
	`"use strict";${
		ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } })
			.outputText
	}return { selectCurrentSnapshotTurnoverInventory };`
)(...Object.values(context)) as {
	selectCurrentSnapshotTurnoverInventory(
		selection: Selection,
		inventory: unknown,
		snapshot: unknown,
		currentHead: unknown,
		coordinatorActive?: Labels | null
	): Selection;
};

// Floor epoch 4. The pool holds the scopes of epochs 2, 3 and 4; the authenticated selection retires 2.
type Scope = { objectId: string; epoch: number; anchor: string; manifestDigest: string };
const scope = (epoch: number): Scope => ({
	objectId: "object",
	epoch,
	anchor: `a${epoch}`,
	manifestDigest: `m${epoch}`,
});
const SCOPES = [scope(2), scope(3), scope(4)];
const SELECTION = { survivingScopes: [scope(3), scope(4)], retiringScopes: [scope(2)] };
const HEAD = { objectId: "object", epoch: 4, currentAnchorDigest: "a4" };
// P2: the completed snapshot fence (closed epoch 1, protecting nothing the selection retires).
// P3: the coordinator's active preparation the killed install had fenced.
const P2 = { decisionDigest: "d2", sourceProofDigest: "s2", throughEpoch: 1, protectedScopes: [] };
const P3 = { decisionDigest: "d3", sourceProofDigest: "s3", throughEpoch: 2, protectedScopes: [] };
const labels = (p: Labels): Labels => ({ decisionDigest: p.decisionDigest, sourceProofDigest: p.sourceProofDigest });
const inventory = (full: boolean): unknown => ({
	custody: {},
	scopes: SCOPES.map((s) => ({ scope: s, incarnation: `i${s.epoch}`, contentBytes: 1 })),
	owner: { recoveryScopes: full ? 4 : 3, limits: { maxRecoveryScopes: 4 } },
});
const snapshot = (active: typeof P3 | null): unknown => ({
	control: {
		kind: "snapshot-retirement-control-1",
		objectId: "object",
		incarnation: "c",
		revision: active === null ? 4 : 5,
		sequence: active === null ? 2 : 3,
		active: active === null ? null : { sequence: 3, preparation: active },
		completed: P2,
	},
	image: {
		imageDigest: "image",
		scopeCount: SCOPES.length,
		chunkCount: 0,
		metadataBytes: 0,
		scopes: SCOPES.map((s) => ({ scope: s, incarnation: `i${s.epoch}` })),
	},
});
const KEEP_POOL = { survivingScopes: SCOPES, retiringScopes: [] };

describe("snapshot turnover selection with a prepared snapshot fence (box m46 edges 4 and 5)", () => {
	it("keeps the whole pool and retires nothing while the coordinator's own active preparation holds the fence", () => {
		expect(selectCurrentSnapshotTurnoverInventory(SELECTION, inventory(false), snapshot(P3), HEAD, labels(P3))).toEqual(
			KEEP_POOL
		);
	});

	it("refuses a fence no active coordinator preparation owns", () => {
		expect(selectCurrentSnapshotTurnoverInventory(SELECTION, inventory(false), snapshot(P3), HEAD, null)).toBe(
			undefined
		);
		expect(selectCurrentSnapshotTurnoverInventory(SELECTION, inventory(false), snapshot(P3), HEAD, labels(P2))).toBe(
			undefined
		);
	});

	it("refuses a joined fence on a full pool, as a blocked completed fence does", () => {
		expect(selectCurrentSnapshotTurnoverInventory(SELECTION, inventory(true), snapshot(P3), HEAD, labels(P3))).toBe(
			undefined
		);
	});

	it("leaves an idle control's selection unchanged, with or without a coordinator preparation", () => {
		expect(selectCurrentSnapshotTurnoverInventory(SELECTION, inventory(false), snapshot(null), HEAD)).toEqual(
			SELECTION
		);
		expect(
			selectCurrentSnapshotTurnoverInventory(SELECTION, inventory(false), snapshot(null), HEAD, labels(P3))
		).toEqual(SELECTION);
	});
});
