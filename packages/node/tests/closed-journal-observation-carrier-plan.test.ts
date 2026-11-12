import { readFileSync } from "node:fs";

import { CanonicalEncodingError, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// fix/maintenance-image-capacity C1: the journal observation carrier {control, image, canonicalRows} is one encode
// under the close's 786,432-byte cap (CLOSED_RETIREMENT_BYTES, the one-bound rule). A drain control carries its plan,
// and the plan carries the exact native frame of every received row it retires. At beginDrain each of those frames is
// byte-equal to a row the same carrier still holds in canonicalRows, so the carrier held the collectible rows twice.
// j19/j23 (5 Writers, epoch 2's adoption drain) stopped there: 692 rows of about 1.1 KB (764,717 B) plus a plan of
// 520,499 B for epoch 0's 385 rows, 1,304,739/786,432 at the forecast's journal observation site.

const CAP = { maxBytes: 786_432, maxItems: 65_536, maxDepth: 128 };
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("creator-closed-rollback-data.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string | undefined {
	const found = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
	return found?.getText(parsed);
}
// The owner's carrier function and whatever helpers it uses, compiled from the owner's own declarations.
const OWNERS = ["creatorIssuanceMaintenanceObservationCarriers", "closedJournalObservationControl", "closedJournalDrainPlanCarriers",
	"closedJournalObservationRowsDigest", "closedRetirementBytes", "closedRetirementDigest", "closedObservationCarrierBytes"];
const compiled = new Function("encodeCanonical", "hashDomain", "CLOSED_RETIREMENT_BYTES", "CanonicalEncodingError", "requireLaw",
	"maintenanceWidthAtom", `${OWNERS.flatMap(name => declaration(name) ?? []).map(text => ts.transpile(text, { target: ts.ScriptTarget.ES2022 })).join("\n")}
	return {carriers: creatorIssuanceMaintenanceObservationCarriers, carrierBytes: closedObservationCarrierBytes};`)(
	encodeCanonical, hashDomain, CAP, CanonicalEncodingError,
	(ok: boolean, reason = "internal-invariant") => { if (!ok) throw new TypeError(reason); }, Symbol("maintenance-width")) as {
	carriers: (input: Record<string, unknown>) => readonly unknown[];
	carrierBytes: (value: unknown) => Uint8Array | undefined;
};

const objectId = "j19-room";
const hex = (seed: number) => (seed.toString(16).padStart(8, "0")).repeat(8);
const scopes = [0, 1, 2].map(epoch => ({ objectId, epoch, anchorDigest: hex(0xa0 + epoch) }));
// A received native row (SQLite shape): about 1,105 B per frame, as j19 measured.
function receivedFrame(scope: (typeof scopes)[number], sequence: number): Uint8Array {
	return encodeCanonical(["accepted_entries", [scope.objectId, scope.epoch, scope.anchorDigest, sequence], {
		journal_sequence: sequence, vertex_digest: hex(scope.epoch * 1000 + sequence), source_kind: "received",
		received_preimage: new Uint8Array(764).fill(sequence & 0xff), received_signature: new Uint8Array(64).fill(7) }]);
}
const header = (scope: (typeof scopes)[number], next: number) => encodeCanonical(["scopes",
	[scope.objectId, scope.epoch, scope.anchorDigest], { object_id: scope.objectId, epoch: scope.epoch,
		anchor_digest: scope.anchorDigest, next_journal_sequence: next }]);
const perEpoch = [385, 160, 147]; // 692 rows; epoch 0's 385 are collectible at epoch 2's adoption (throughEpoch 0).
const frames = scopes.map((scope, index) => Array.from({ length: perEpoch[index]! }, (_, sequence) => receivedFrame(scope, sequence)));
const canonicalRows = scopes.flatMap((scope, index) => [header(scope, perEpoch[index]!), ...frames[index]!]);
const rowsBytes = encodeCanonical(canonicalRows, { maxBytes: 4_194_304 }).byteLength;
const image = { imageDigest: hex(0xbeef), scopeCount: 3, rowCount: 692, byteCharge: rowsBytes };
const completed = { decisionDigest: hex(0xd1), sourceProofDigest: hex(0xd2), throughEpoch: 0,
	protectedScopes: [scopes[1], scopes[2]] };
const baseControl = { kind: "v3-live-journal-retirement-control-2", objectId, incarnation: hex(0xc0), revision: 6, sequence: 3,
	active: null, completed, drain: null };
function planFor(rows: readonly Uint8Array[]) {
	return { baseControl, sourceImage: image, prefixes: [{ scope: scopes[0], highWatermark: rows.length, rows: rows.map((bytes, sequence) => ({
		journalSequence: sequence, vertexDigest: hex(sequence), author: hex(0x5000 + (sequence % 4)), authorSequence: sequence,
		nativeFrameDigest: [...hashDomain("ts-drp/live-journal-native-frame/v1", bytes)].map(b => b.toString(16).padStart(2, "0")).join(""),
		exactCanonicalNativeFrameBytes: bytes })) }], retiredEmptyHeaders: [], protectedHeaderScopes: [scopes[1], scopes[2]] };
}
const drainControl = (plan: unknown, cursor = 0) => ({ ...baseControl, revision: 7 + cursor / 16, drain: { plan, cursor, batches: cursor / 16,
	residualImageDigest: hex(0xe0) } });
const rest = { snapshot: null, ahe: null, floor: null, floorImage: null, snapshotInventory: null };

describe("journal observation carrier at j19 widths (C1)", () => {
	it("the fixture has j19's widths: about 765 KB of rows, a plan of about 520 KB for epoch 0's 385 rows", () => {
		expect(rowsBytes).toBeGreaterThan(760_000);
		expect(rowsBytes).toBeLessThan(CAP.maxBytes);
		const planBytes = encodeCanonical(planFor(frames[0]!), { maxBytes: 4_194_304 }).byteLength;
		expect(planBytes).toBeGreaterThan(480_000);
		expect(planBytes).toBeLessThan(CAP.maxBytes);
	});

	it("a drain control's carrier fits the one encode cap: the plan rides by digest, not beside the rows it duplicates", () => {
		const carrier = compiled.carriers({ journal: { control: drainControl(planFor(frames[0]!)), image, canonicalRows }, ...rest })[0];
		const bytes = compiled.carrierBytes(carrier);
		const width = encodeCanonical(carrier, { maxBytes: 4_194_304 }).byteLength;
		expect(width, `journal observation carrier ${width}/${CAP.maxBytes}`).toBeLessThanOrEqual(CAP.maxBytes);
		expect(bytes).toBeDefined();
		// Rows plus less than 2 KB: control, image and one {scope, highWatermark, rowsDigest} prefix.
		expect(width - rowsBytes).toBeLessThan(2_048);
	});

	it("every journal observation carrier the owner encodes or sizes holds its control through the one projection", () => {
		// The real carriers (creatorIssuanceMaintenanceObservationCarriers) and every forecast/readiness mirror of them:
		// {control, image, canonicalRows} records given to an encoder or width measure. A mirror that kept the whole plan
		// would refuse what the carrier itself now encodes (or admit what it cannot).
		const MEASURES = new Set(["closedRetirementBytes", "maintenanceCanonicalWidth", "observe", "exactWidth", "record",
			"canonicalRecordResourceForSizing"]);
		const unwrap = (node: ts.Expression): ts.Expression =>
			ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ? unwrap(node.expression) : node;
		const projected = (node: ts.Expression): boolean => {
			const value = unwrap(node);
			if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) return false;
			if (value.expression.text === "closedJournalObservationControl") return true;
			// A resource footprint of the projected control (readiness geometry).
			return value.expression.text === "resource" && value.arguments.length === 1 && projected(value.arguments[0]!);
		};
		const offenders: string[] = [];
		const check = (literal: ts.ObjectLiteralExpression, viaOwner: boolean): void => {
			const names = literal.properties.map(property => property.name?.getText(parsed));
			if (!names.includes("control") || !names.includes("image") || !names.includes("canonicalRows")) return;
			const control = literal.properties.find(property => property.name?.getText(parsed) === "control");
			const initializer = control !== undefined && ts.isPropertyAssignment(control) ? control.initializer : undefined;
			// The resource program's journalControl composes its drain from the owner (checked below).
			if (initializer !== undefined && ts.isIdentifier(initializer) && initializer.text === "journalControl") return;
			// creatorIssuanceMaintenanceObservationCarriers projects a value or width-tree control itself; a footprint must
			// already be the projection's.
			if (initializer !== undefined && (projected(initializer) || (viaOwner && !(ts.isCallExpression(unwrap(initializer)) &&
				(unwrap(initializer) as ts.CallExpression).expression.getText(parsed) === "resource")))) return;
			offenders.push(`${parsed.getLineAndCharacterOfPosition(literal.getStart()).line + 1}: ${literal.getText(parsed).slice(0, 90)}`);
		};
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
				const callee = node.expression.text;
				for (const argument of node.arguments) {
					const value = unwrap(argument);
					if (!ts.isObjectLiteralExpression(value)) continue;
					if (MEASURES.has(callee)) check(value, false);
					if (callee === "creatorIssuanceMaintenanceObservationCarriers")
						for (const property of value.properties)
							if (ts.isPropertyAssignment(property) && property.name.getText(parsed) === "journal" &&
								ts.isObjectLiteralExpression(unwrap(property.initializer)))
								check(unwrap(property.initializer) as ts.ObjectLiteralExpression, true);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(parsed);
		expect(offenders).toEqual([]);
		const owner = declaration("creatorIssuanceMaintenanceObservationCarriers") ?? "";
		expect(owner).toMatch(/closedJournalObservationControl\(/u);
		// The resource program's semantic journal progress holds the owner's observed plan.
		const progress = source.slice(source.indexOf("const semanticJournalProgress"), source.indexOf("const journalControl = maximum("));
		expect(progress).toMatch(/closedJournalDrainPlanCarriers|journalPlanCarriers\.observed/u);
	});

	it("a carrier with no drain is unchanged", () => {
		const carrier = compiled.carriers({ journal: { control: baseControl, image, canonicalRows }, ...rest })[0];
		expect(encodeCanonical(carrier, { maxBytes: 4_194_304 })).toEqual(
			encodeCanonical({ control: baseControl, image, canonicalRows }, { maxBytes: 4_194_304 }));
	});
});
