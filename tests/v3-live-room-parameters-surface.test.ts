import { encodeCanonical } from "@ts-drp/canonical";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The room's application state limit (a per-room creation parameter) adds no name to @ts-drp/node/v3-live's
// public surface (phase-4b-v3-live-snapshot-composition-red pins that roster). The room parameters record
// as the native plane opens it (the registry fields within their ranges, the registered extension, exact
// canonical bytes) has one owner, an internal module that the plane (v3-live) and the room's invite
// authentication (v3-room) both use, so an invite the plane would refuse is refused before any host
// acquisition without a public bridge between the two.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "packages/node/src/internal/v3-room-parameters.ts";

function exportedNames(relative: string): readonly string[] {
	const unit = ts.createSourceFile(
		relative,
		readFileSync(path.resolve(ROOT, relative), "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	const names: string[] = [];
	for (const statement of unit.statements) {
		const exported = ts.canHaveModifiers(statement)
			? ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
			: false;
		if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause))
			for (const element of statement.exportClause.elements) names.push(element.name.text);
		if (!exported) continue;
		if (ts.isVariableStatement(statement))
			for (const declaration of statement.declarationList.declarations)
				if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
		if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement)) &&
			statement.name !== undefined
		)
			names.push(statement.name.text);
	}
	return names;
}

const base = {
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
};

describe("the room's application state limit and the v3-live public surface", () => {
	it("adds no v3-live export: the parameters record's plane judgement lives in an internal owner", () => {
		const names = exportedNames("packages/node/src/v3-live.ts");
		expect(names, "no public bridge for the invite's parameters check").not.toContain(
			"v3RoomParametersApplicationStateLimit"
		);
		expect(names, "the migration record's state bound is the room's own constant").not.toContain(
			"MIGRATION_RECORD_STATE_BYTES"
		);
		expect(existsSync(path.resolve(ROOT, OWNER)), "the internal owner exists").toBe(true);
		expect(exportedNames(OWNER)).toContain("v3RoomParametersApplicationStateLimit");
		const room = readFileSync(path.resolve(ROOT, "packages/node/src/v3-room.ts"), "utf8");
		expect(room).toMatch(/from "\.\/internal\/v3-room-parameters\.js"/u);
	});

	it("the internal owner judges the record as the plane opens it", async () => {
		if (!existsSync(path.resolve(ROOT, OWNER))) expect.fail(`${OWNER} does not exist`);
		const owner = (await import(/* @vite-ignore */ path.resolve(ROOT, OWNER))) as {
			v3RoomParametersApplicationStateLimit(bytes: Uint8Array): number | undefined;
		};
		const limit = (record: Readonly<Record<string, unknown>>): number | undefined =>
			owner.v3RoomParametersApplicationStateLimit(encodeCanonical(record));
		expect(limit(base), "absent: the default").toBe(32_768);
		expect(limit({ ...base, maxApplicationStateBytes: 98_304 })).toBe(98_304);
		expect(limit({ ...base, maxApplicationStateBytes: 131_072 })).toBe(131_072);
		expect(limit({ ...base, maxApplicationStateBytes: 131_073 }), "above the ceiling").toBeUndefined();
		expect(limit({ ...base, maxApplicationStateBytes: 32_767 }), "below the default").toBeUndefined();
		expect(limit({ ...base, unknownField: 1 }), "an unknown field").toBeUndefined();
		expect(limit({ ...base, maxDependencies: 257 }), "a registry field out of range").toBeUndefined();
		const { maxEpochVertices: _omitted, ...missing } = base;
		expect(limit(missing), "a required registry field missing").toBeUndefined();
		const bytes = encodeCanonical(base);
		expect(owner.v3RoomParametersApplicationStateLimit(new Uint8Array([...bytes, 0])), "noncanonical").toBeUndefined();
	});
});
