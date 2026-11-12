import { readFileSync } from "node:fs";

import { encodeCanonical } from "@ts-drp/canonical";
import ts from "typescript";
import { expect, it } from "vitest";

// fix/maintenance-image-capacity, j22 (bx_6ytwadfw, 5-Writer received-refusal case, epoch 2 -> 3): readiness
// admitted ordinary moves while every phase it checked (the move, the close's membership row and the successor's
// header, the successor's own fence) fit the journal carrier's encode cap (786,432). The successor's mandatory
// adoption fence then quoted its own horizon (its fence, the NEXT successor's header, that successor's fence)
// from the journal readiness had filled: afterLocal 786,257, afterSuccessor 787,903, afterSuccessorLocal
// 788,459. The fence was refused (MAINTENANCE_NATIVE_IMAGE_EXHAUSTED 787,903/786,432) and the room stopped.
// Readiness must reserve exactly that horizon: the same live-journal function measures it (fenceHorizon) and the
// composer bounds it like every other phase.

const CARRIER_CAP = 786_432;
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("creator-closed-rollback-data.ts", source, ts.ScriptTarget.Latest, true);

function find<T extends ts.Node>(test: (node: ts.Node) => node is T): T {
	const found: T[] = [];
	const visit = (node: ts.Node): void => { if (test(node)) found.push(node); ts.forEachChild(node, visit); };
	visit(parsed);
	if (found.length !== 1) throw new TypeError(`expected one node, found ${found.length}`);
	return found[0]!;
}

it("an ordinary admission whose own phases fit but whose successor fence's horizon does not is refused (j22 widths)", () => {
	const phases = find((node): node is ts.ForOfStatement => ts.isForOfStatement(node) &&
		node.statement.getText(parsed).includes("const wrapperWidth = maintenanceCanonicalWidth({"));
	const capacity = find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) && node.name.text === "journalCapacityFor");
	const phase = (canonicalRowsBytes: number, rowCount: number) => ({ scopeCount: 4, rowCount, nativeImageBytes: canonicalRowsBytes + 9_000,
		canonicalRowsBytes, canonicalRowBytes: [] as number[] });
	// The ordinary move's own phases (rows) end under the cap; the fence horizon is j22's.
	const journal = { afterLocal: phase(781_500, 707), afterSuccessor: phase(785_100, 708), afterSuccessorLocal: phase(785_656, 709),
		fenceHorizon: { afterSuccessor: phase(787_745, 710), afterSuccessorLocal: phase(788_301, 711) } };
	const nativeObservations: {width: number; maxBytes: number}[] = [];
	const bindings = {
		journal, journalAfterLocalControl: { revision: 10 }, journalAfterSuccessorControl: { revision: 11 },
		finalJournalControl: { revision: 12 }, digest: "d".repeat(64), nativeObservations, preclose: false,
		finalJournalCapacity: undefined, capacityDimensions: undefined,
		maintenanceEncodedWidth: (width: number) => new Uint8Array(width),
		maintenanceCanonicalWidth: (value: unknown) => encodeCanonical(value, { maxBytes: 4 * 1024 * 1024 }).byteLength,
		LIVE_JOURNAL_RETIREMENT_LIMITS: { maxImageBytes: 2_097_152 },
		CLOSED_RETIREMENT_BYTES: { maxBytes: CARRIER_CAP, maxItems: 65_536, maxDepth: 128 },
	};
	const code = ts.transpile(`const ${capacity.getText(parsed)};\n${phases.getText(parsed)}`, { target: ts.ScriptTarget.ES2022 });
	new Function(...Object.keys(bindings), code)(...Object.values(bindings));
	const exceeding = nativeObservations.filter(({width, maxBytes}) => width > maxBytes);
	// The move's own three phases fit; the two horizon phases (the fence's afterSuccessor and afterSuccessorLocal) do not.
	expect(nativeObservations.slice(0, 3).every(({width, maxBytes}) => width <= maxBytes)).toBe(true);
	expect(exceeding.length, "the successor fence's horizon is bounded like every other phase").toBe(2);
	expect(exceeding.every(({maxBytes}) => maxBytes === CARRIER_CAP)).toBe(true);
});

it("the composer asks the one live-journal function for the fence horizon on ordinary quotes", () => {
	expect(source).toContain("...(preclose ? {} : { fenceHorizon: true }),");
});
