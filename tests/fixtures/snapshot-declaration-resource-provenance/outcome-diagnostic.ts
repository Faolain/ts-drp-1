import assert from "node:assert/strict";

import { gateStatus } from "./outcome.js";

// Synthetic child receipts only: gate classification, never a product-parser model.
const names = [
	"compatibility",
	"hookReached",
	"freshCapturedDecoder",
	"replacementMode",
	"noRetainedSharedDecoder",
	"boundedChunks",
	"boundedPieces",
	"reusedCapturedEncoder",
	"immediatePieceComparisonAndFinalOrdering",
	"nativeCarryBound",
	"rejectFirstMismatch",
];
const green = Object.fromEntries(
	["node", "nodeBundled", "chromium", "firefox", "webkit"].map((engine) => [
		engine,
		{
			cases: 171,
			encoderControl: true,
			checks: Object.fromEntries(
				names.map((name) => [name, { passed: name === "rejectFirstMismatch" ? 1 : 171, failed: 0 }])
			),
		},
	])
);
const red = structuredClone(green);
assert.ok(red.node);
red.node.checks.boundedChunks = { passed: 1, failed: 170 };
const failedControl = structuredClone(red);
assert.ok(failedControl.webkit);
failedControl.webkit.encoderControl = false;
const ok = Array.from({ length: 4 }, () => ({ status: 0 }));
const receipt = { completed: true, run: "diagnostic", status: 0, summarySha256: "same-file-hash" };
const results = [
	["all-green", gateStatus(ok, { status: 0 }, receipt, green, "diagnostic", "same-file-hash"), 0],
	["legitimate-red", gateStatus(ok, { status: 1 }, { ...receipt, status: 1 }, red, "diagnostic", "same-file-hash"), 1],
	[
		"failed-strict",
		gateStatus(
			[{ status: 1 }, ...ok.slice(1)],
			{ status: 1 },
			{ ...receipt, status: 1 },
			red,
			"diagnostic",
			"same-file-hash"
		),
		2,
	],
	[
		"failed-controls",
		gateStatus(ok, { status: 2 }, { ...receipt, status: 2 }, failedControl, "diagnostic", "same-file-hash"),
		2,
	],
	[
		"timeout",
		gateStatus(
			ok,
			{ status: null, signal: "SIGTERM", error: "ETIMEDOUT" },
			receipt,
			green,
			"diagnostic",
			"same-file-hash"
		),
		2,
	],
	["missing-completion-exit1", gateStatus(ok, { status: 1 }, undefined, red, "diagnostic", "same-file-hash"), 2],
	[
		"incomplete-engines",
		gateStatus(ok, { status: 1 }, { ...receipt, status: 1 }, { node: red.node }, "diagnostic", "same-file-hash"),
		2,
	],
	["stale-run-receipt", gateStatus(ok, { status: 1 }, { ...receipt, status: 1 }, red, "new-run", "same-file-hash"), 2],
	[
		"summary-hash-mismatch",
		gateStatus(ok, { status: 1 }, { ...receipt, status: 1 }, red, "diagnostic", "different-hash"),
		2,
	],
] as const;
for (const [name, actual, expected] of results) assert.equal(actual, expected, name);
console.log(JSON.stringify({ kind: "gate-child-result-evaluation-only", results }, null, 2));
