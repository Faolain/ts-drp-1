import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { REPOSITORY_ROOT } from "./fixtures/phase-6a-v3/creator-successor-activation-contract.js";

const guidance = [
	"Authenticated replayable notification attempt, not an exactly-once external commit.",
	"Persistent consumers deduplicate side effects by authenticated vertex digest.",
	"Rejection fails the current session closed; failure, crash or cold reopen may replay notifications.",
];

function productionFiles(directory: string): string[] {
	return readdirSync(resolve(REPOSITORY_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
		if (["node_modules", "dist", "tests", "test", ".logs", ".git"].includes(entry.name)) return [];
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) return productionFiles(path);
		return path.includes("/src/") && /\.[cm]?tsx?$/.test(path) && !/\.(test|spec)\./.test(path) ? [path] : [];
	});
}

function parse(path: string): ts.SourceFile {
	return ts.createSourceFile(path, readFileSync(resolve(REPOSITORY_ROOT, path), "utf8"), ts.ScriptTarget.Latest, true);
}

function normalized(source: string): string {
	return source.replace(/\s+/g, " ").trim();
}

describe("D.110c-0c1f5b0v replayable callback contract", () => {
	it("documents both existing callback surfaces without changing their type shapes", () => {
		const room = parse("examples/v3-room/src/index.ts");
		const node = parse("packages/node/src/v3-live.ts");
		const roomInput = room.statements.find(
			(statement): statement is ts.InterfaceDeclaration =>
				ts.isInterfaceDeclaration(statement) && statement.name.text === "CreateV3RoomSessionInput"
		);
		const callback = roomInput?.members.find((member) => member.name?.getText(room) === "onAcceptedVertex");
		const sink = node.statements.find(
			(statement): statement is ts.TypeAliasDeclaration =>
				ts.isTypeAliasDeclaration(statement) && statement.name.text === "V3AdmittedVertexSink"
		);
		expect(callback).toBeDefined();
		expect(sink).toBeDefined();
		for (const [surface, source] of [
			[callback, room],
			[sink, node],
		] as const) {
			const comment = surface?.getFullText(source).slice(0, surface.getStart(source) - surface.pos) ?? "";
			for (const line of guidance) expect(comment).toContain(line);
		}
		expect(normalized(callback?.getText(room) ?? "")).toBe(
			"onAcceptedVertex(vertex: AdmittedReceivedVertexView): void | Promise<void>;"
		);
		expect(sink?.type.kind).toBe(ts.SyntaxKind.FunctionType);
	});

	it("pins the complete production consumer inventory to no-op and in-memory reconstruction callbacks", () => {
		const inventory: { path: string; callbacks: string[] }[] = [];
		for (const path of [...productionFiles("examples"), ...productionFiles("packages")].sort()) {
			const source = parse(path);
			const callbacks: string[] = [];
			function visit(node: ts.Node): void {
				if (
					(ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isShorthandPropertyAssignment(node)) &&
					["onAcceptedVertex", '"onAcceptedVertex"', "'onAcceptedVertex'"].includes(node.name.getText(source))
				)
					callbacks.push(normalized(node.getText(source)));
				ts.forEachChild(node, visit);
			}
			visit(source);
			if (callbacks.length > 0) inventory.push({ path, callbacks });
		}
		expect(inventory).toEqual([
			{ path: "examples/grid/src/v3-zone.ts", callbacks: ["onAcceptedVertex: () => undefined"] },
			{ path: "examples/v3-chat/src/index.ts", callbacks: ["onAcceptedVertex: () => undefined"] },
			{
				path: "examples/v3-room/src/index.ts",
				callbacks: [
					"onAcceptedVertex: (vertex: AdmittedReceivedVertexView): void | Promise<void> => { if (callbacksReady) return input.onAcceptedVertex(vertex); acceptedVertices.push(vertex); }",
					"onAcceptedVertex: acceptTarget",
					"onAcceptedVertex: (vertex: V3RoomAcceptedVertex): void => { for (const row of acceptedOperationsForVertex(input.application, vertex, targetRecordAuthority) ?? []) { reopenedAccepted.push(row); } }",
					'onAcceptedVertex: (vertex: V3RoomAcceptedVertex): void => { for (const row of acceptedOperationsForVertex(input.application, vertex, targetRecordAuthority) ?? []) { if (Reflect.get(row.operation, "action") === "migrationRecord") recoveredRecords.push(row); } }',
				],
			},
		]);
		const room = parse("examples/v3-room/src/index.ts");
		const collectors: string[] = [];
		function visit(node: ts.Node): void {
			if (ts.isVariableDeclaration(node) && node.name.getText(room) === "acceptTarget")
				collectors.push(normalized(node.initializer?.getText(room) ?? ""));
			ts.forEachChild(node, visit);
		}
		visit(room);
		expect(collectors).toEqual([
			'(vertex: V3RoomAcceptedVertex): void => { for (const row of acceptedOperationsForVertex(input.application, vertex, targetRecordAuthority) ?? []) { targetAccepted.push(row); if (Reflect.get(row.operation, "action") === "migrationRecord") recordVertexDigest = row.vertexDigest; } }',
		]);
		expect(room.text).toContain("const targetAccepted: V3RoomAcceptedOperation[] = [];");
		expect(room.text).toContain("const reopenedAccepted: V3RoomAcceptedOperation[] = [];");
		expect(room.text).toContain("const recoveredRecords: V3RoomAcceptedOperation[] = [];");
		expect(room.text).toContain("sameBytes(acceptedRowsEvidence(reopenedAccepted), completedTargetEvidence)");
		expect(room.text).toContain("sameBytes(exactReopenedState, firstProjection.exactCanonicalApplicationStateBytes)");
	});
});
