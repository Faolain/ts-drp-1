import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";

function parseSource(path: URL): ts.SourceFile {
	const sourceText = readFileSync(path, "utf8");
	return ts.createSourceFile(path.pathname, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function nameText(node: ts.Node): string | undefined {
	if (ts.isPrivateIdentifier(node)) return node.text.slice(1);
	return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
}

function classMemberNames(sourceFile: ts.SourceFile, className: string): Set<string> | undefined {
	for (const statement of sourceFile.statements) {
		if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue;
		return new Set(
			statement.members.flatMap((member) => {
				const name = member.name ? nameText(member.name) : undefined;
				return name === undefined ? [] : [name];
			})
		);
	}
	return undefined;
}

function nameTokenCount(sourceFile: ts.SourceFile, name: string): number {
	let count = 0;
	const visit = (node: ts.Node): void => {
		if (nameText(node) === name) count++;
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return count;
}

test("Phase 0q-b1 removes the write-dead reconciliation latch without publishing a success flag", () => {
	const applierSource = parseSource(new URL("../src/drp-applier.ts", import.meta.url));
	const errorSource = parseSource(new URL("../src/errors.ts", import.meta.url));
	const objectRootSource = parseSource(new URL("../src/index.ts", import.meta.url));
	const objectTypesSource = parseSource(new URL("../../types/src/object.ts", import.meta.url));
	const applierMembers = classMemberNames(applierSource, "DRPVertexApplier");

	expect(
		{
			applierFound: applierMembers !== undefined,
			legacyPrivateLatchDeclared: applierMembers?.has("hasUnreconciledLiveState") ?? false,
			legacyPrivateLatchNameTokens:
				nameTokenCount(applierSource, "hasUnreconciledLiveState") +
				nameTokenCount(errorSource, "hasUnreconciledLiveState"),
			notificationQueueFound: applierMembers?.has("notificationQueue") ?? false,
			publicSuccessFlagNameTokens:
				nameTokenCount(applierSource, "liveStateUnreconciled") +
				nameTokenCount(errorSource, "liveStateUnreconciled") +
				nameTokenCount(objectRootSource, "liveStateUnreconciled") +
				nameTokenCount(objectTypesSource, "liveStateUnreconciled"),
		},
		"the deleted reconciliation path must leave neither a private latch nor a public field that labels torn state as success"
	).toEqual({
		applierFound: true,
		legacyPrivateLatchDeclared: false,
		legacyPrivateLatchNameTokens: 0,
		notificationQueueFound: true,
		publicSuccessFlagNameTokens: 0,
	});
});

test("the dead-latch absence detector includes TypeScript private identifiers", () => {
	const syntheticSource = ts.createSourceFile(
		"synthetic-private-latch.ts",
		"class DRPVertexApplier { #hasUnreconciledLiveState = false; }",
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);

	expect({
		memberNames: [...(classMemberNames(syntheticSource, "DRPVertexApplier") ?? [])],
		nameTokens: nameTokenCount(syntheticSource, "hasUnreconciledLiveState"),
	}).toEqual({
		memberNames: ["hasUnreconciledLiveState"],
		nameTokens: 1,
	});
});
