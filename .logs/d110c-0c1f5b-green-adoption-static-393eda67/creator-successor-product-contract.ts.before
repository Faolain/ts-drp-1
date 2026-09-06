import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export const D108E2B_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts",
	"tests/phase-6a-creator-successor-product-red.test.ts",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts",
	"packages/storage-browser/playwright.phase-6a-creator-successor-product.config.ts",
] as const);

export const D108E2B_GREEN_PATHS = Object.freeze(["examples/v3-room/src/index.ts"] as const);

export const D108D2_AUTHORITY_KEYS = Object.freeze([
	"aclDigest",
	"anchorDigest",
	"epoch",
	"genesisAnchorDigest",
	"lifecycle",
	"objectId",
	"profileId",
] as const);

export const D108D2_BROWSER_BEHAVIORS = Object.freeze([
	"hot creator adoption exposes oracle authority and issues through the replacement handle",
	"established peer cold reopen accepts the genuine epoch-one live operation",
	"fresh late peer cold reopen accepts the targeted retained epoch-one operation",
] as const);

export const D108E2B_BROWSER_BEHAVIORS = Object.freeze([
	"concurrent adoption shares one success and one underlying transition",
	"concurrent adoption shares one real verification failure",
	"close joins a paused adoption before releasing lifetime ownership",
	"predecessor deactivation failure cleans the replacement before escaping",
] as const);

export const D108E2C_PRODUCT_BROWSER_BEHAVIORS = Object.freeze([
	"close at the post-activation gate cleans the successor exactly once",
	"close at the post-predecessor-deactivation gate preserves causal cleanup",
] as const);

export const D108E3_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts",
	"tests/phase-6a-creator-successor-product-red.test.ts",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts",
] as const);

export const D108E3_GREEN_PATHS = Object.freeze(["examples/v3-room/src/index.ts"] as const);

export const D108E3_BROWSER_BEHAVIORS = Object.freeze([
	"cleanup failure preserves the predecessor failure in an ordered aggregate",
	"activation failure remains primary while close joins adoption",
	"drain failure still shuts down and releases browser ownership",
	"drain and shutdown failure preserve ordered primary and cleanup errors",
	"rehearsal blocks later adoption until its migration record releases",
	"activation blocks later adoption until terminal transition releases",
	"adoption blocks later rehearsal until verification releases",
	"adoption blocks later activation until verification releases",
	"overlapping rehearsal retains the existing fast-fail fence",
	"independent room sessions do not share one lifetime queue",
	"a failed adoption releases the lifetime queue for retry",
	"accepted-vertex failure cannot deadlock queued adoption and shutdown",
] as const);

export const D108E5_BROWSER_BEHAVIORS = Object.freeze([
	"redirect-pending adoption stays ahead of rehearsal",
	"redirect-pending adoption stays ahead of activation",
	"activation bytes are bounded before call-time copy",
	"migration invites are bounded before call-time encoding",
] as const);

const D108D2_ROOM_INPUT_KEYS = Object.freeze([
	"application",
	"author",
	"createOperationAdmissionPolicy",
	"creatorFinalitySigner",
	"creatorInvite",
	"databaseName",
	"initialLogicalTime",
	"issuanceDatabaseName",
	"migrationDatabaseNamespace",
	"objectId",
	"onAcceptedVertex",
	"onMigrationTarget",
	"onProjection",
	"openTransport",
	"publicKeyBytes",
	"rebaseSourceInvite",
	"roomHeadAuthority",
	"signRegisteredVertexDigest",
	"successorSnapshotDeclaration",
] as const);
const D108D2_CHAT_JOIN_INPUT_KEYS = Object.freeze([
	"channelName",
	"clientId",
	"databaseName",
	"invite",
	"roomHead",
	"successorSnapshotDeclaration",
] as const);

const ADOPTION_MARKER =
	/verifyCreatorSuccessorAdoption|stageCreatorSuccessorAdoption|publishStagedCreatorSuccessorAdoption|recoverPendingCreatorSuccessorAdoption|activateCreatorSuccessorAdoption|reopenCreatorSuccessorAdoption/u;

function read(path: string): string {
	const absolute = resolve(REPOSITORY_ROOT, path);
	return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
}

function exampleSources(directory: string): readonly Readonly<{ readonly path: string; readonly source: string }>[] {
	const absolute = resolve(REPOSITORY_ROOT, directory);
	if (!existsSync(absolute)) return Object.freeze([]);
	return Object.freeze(
		readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
			const path = `${directory}/${entry.name}`;
			if (entry.isDirectory()) return exampleSources(path);
			return entry.isFile() && /\.(?:mts|ts)$/u.test(entry.name) ? [Object.freeze({ path, source: read(path) })] : [];
		})
	);
}

function interfaceKeys(source: string, name: string): readonly string[] {
	const parsed = ts.createSourceFile("d108d2-source.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const declaration = parsed.statements.find(
		(statement): statement is ts.InterfaceDeclaration =>
			ts.isInterfaceDeclaration(statement) && statement.name.text === name
	);
	if (declaration === undefined) return Object.freeze([]);
	return Object.freeze(
		declaration.members
			.map((member) => member.name?.getText(parsed))
			.filter((key): key is string => key !== undefined)
			.sort()
	);
}

function descendants(root: ts.Node): readonly ts.Node[] {
	const selected: ts.Node[] = [];
	const visit = (node: ts.Node): void => {
		selected.push(node);
		ts.forEachChild(node, visit);
	};
	visit(root);
	return selected;
}

function executableDescendants(root: ts.Node): readonly ts.Node[] {
	const selected: ts.Node[] = [];
	const visit = (node: ts.Node): void => {
		selected.push(node);
		if (node !== root && ts.isFunctionLike(node)) return;
		ts.forEachChild(node, visit);
	};
	visit(root);
	return selected;
}

function uniqueVariableInitializer(root: ts.Node, name: string): ts.Expression | undefined {
	const matches = descendants(root).filter(
		(node): node is ts.VariableDeclaration =>
			ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
	);
	return matches.length === 1 ? matches[0]?.initializer : undefined;
}

function functionBlock(value: ts.Expression | undefined): ts.Block | undefined {
	if (value === undefined || (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value))) return undefined;
	return ts.isBlock(value.body) ? value.body : undefined;
}

function executableVariableInitializer(root: ts.Node | undefined, name: string): ts.Expression | undefined {
	if (root === undefined) return undefined;
	const matches = executableDescendants(root).filter(
		(node): node is ts.VariableDeclaration =>
			ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
	);
	return matches.length === 1 ? matches[0]?.initializer : undefined;
}

function directVariableInitializer(block: ts.Block | undefined, name: string): ts.Expression | undefined {
	if (block === undefined) return undefined;
	const matches = block.statements.flatMap((statement) =>
		ts.isVariableStatement(statement)
			? statement.declarationList.declarations.filter(
					(declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name
				)
			: []
	);
	return matches.length === 1 ? matches[0]?.initializer : undefined;
}

function identifierCall(root: ts.Node | undefined, name: string): readonly ts.CallExpression[] {
	if (root === undefined) return Object.freeze([]);
	return descendants(root).filter(
		(node): node is ts.CallExpression =>
			ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
	);
}

function executableIdentifierCall(root: ts.Node | undefined, name: string): readonly ts.CallExpression[] {
	if (root === undefined) return Object.freeze([]);
	return executableDescendants(root).filter(
		(node): node is ts.CallExpression =>
			ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
	);
}

function identifierCallExpression(value: ts.Expression | undefined, name: string): ts.CallExpression | undefined {
	return value !== undefined &&
		ts.isCallExpression(value) &&
		ts.isIdentifier(value.expression) &&
		value.expression.text === name
		? value
		: undefined;
}

function unwrapExpression(value: ts.Expression): ts.Expression {
	let selected = value;
	while (
		ts.isAsExpression(selected) ||
		ts.isTypeAssertionExpression(selected) ||
		ts.isParenthesizedExpression(selected) ||
		ts.isNonNullExpression(selected)
	) {
		selected = selected.expression;
	}
	return selected;
}

function isIdentifierExpression(value: ts.Expression | undefined, name: string): boolean {
	return value !== undefined && ts.isIdentifier(unwrapExpression(value)) && unwrapExpression(value).text === name;
}

function isBoundGuard(
	statement: ts.Statement,
	identifier: string,
	limit: number,
	message: string
): statement is ts.IfStatement {
	if (!ts.isIfStatement(statement) || !ts.isBinaryExpression(statement.expression)) return false;
	const condition = statement.expression;
	if (
		condition.operatorToken.kind !== ts.SyntaxKind.GreaterThanToken ||
		!ts.isIdentifier(condition.left) ||
		condition.left.text !== identifier ||
		!ts.isNumericLiteral(condition.right) ||
		Number(condition.right.text) !== limit
	) {
		return false;
	}
	const branch = ts.isBlock(statement.thenStatement)
		? statement.thenStatement.statements.length === 1
			? statement.thenStatement.statements[0]
			: undefined
		: statement.thenStatement;
	if (branch === undefined || !ts.isThrowStatement(branch) || !ts.isNewExpression(branch.expression)) return false;
	const thrown = branch.expression;
	const argument = thrown.arguments?.[0];
	return (
		ts.isIdentifier(thrown.expression) &&
		thrown.expression.text === "TypeError" &&
		thrown.arguments?.length === 1 &&
		argument !== undefined &&
		ts.isStringLiteral(argument) &&
		argument.text === message
	);
}

function directStatement(node: ts.Node, block: ts.Block): ts.Statement | undefined {
	let selected = node;
	while (selected.parent !== undefined && selected.parent !== block) selected = selected.parent;
	return block.statements.find((statement) => statement === selected);
}

function isIntrinsicCopy(node: ts.Node): boolean {
	if (
		ts.isNewExpression(node) &&
		ts.isIdentifier(node.expression) &&
		(node.expression.text === "INTRINSIC_UINT8_ARRAY" || node.expression.text === "Uint8Array")
	) {
		return true;
	}
	return (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		node.expression.expression.text === "Reflect" &&
		node.expression.name.text === "apply" &&
		node.arguments.length > 0 &&
		node.arguments[0] !== undefined &&
		ts.isIdentifier(node.arguments[0]) &&
		node.arguments[0].text === "INTRINSIC_UINT8_ARRAY_SET"
	);
}

function executableIntrinsicReflectApply(root: ts.Node | undefined, name: string): readonly ts.CallExpression[] {
	if (root === undefined) return Object.freeze([]);
	return executableDescendants(root).filter((node): node is ts.CallExpression => {
		if (
			!ts.isCallExpression(node) ||
			!ts.isPropertyAccessExpression(node.expression) ||
			!ts.isIdentifier(node.expression.expression) ||
			node.expression.expression.text !== "Reflect" ||
			node.expression.name.text !== "apply"
		) {
			return false;
		}
		const argument = node.arguments[0];
		return argument !== undefined && ts.isIdentifier(argument) && argument.text === name;
	});
}

function boundedDecodeExpression(value: ts.Expression | undefined):
	| Readonly<{
			readonly boundedCall: ts.CallExpression;
			readonly decodeCall: ts.CallExpression;
	  }>
	| undefined {
	const decodeCall = identifierCallExpression(value, "decodeCreatorInvite");
	if (decodeCall === undefined || decodeCall.arguments.length !== 1) return undefined;
	const boundedCall = identifierCallExpression(decodeCall.arguments[0], "boundedMigrationCreatorInvite");
	return boundedCall !== undefined && boundedCall.arguments.length === 1
		? Object.freeze({ boundedCall, decodeCall })
		: undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const D108D2_FORBIDDEN_PRODUCT_RETURNS = Object.freeze([
	"intent",
	"capability",
	"activationResult",
	"exactCanonicalTrust",
	"snapshotReceipt",
	"signingAuthority",
	"displacedSource",
] as const);

/**
 * Checks direct exported/global return shapes and their local construction aliases.
 * @param source - One room/chat module, injectable only for diagnostic mutants.
 * @returns False for a sensitive carrier or an unparseable product surface.
 */
export function d108d2HasClosedProductReturns(source: string): boolean {
	const fileName = "/d108d2-product.ts";
	const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const host: ts.CompilerHost = {
		getSourceFile: (name) => (name === fileName ? parsed : undefined),
		getDefaultLibFileName: () => "lib.d.ts",
		writeFile: () => undefined,
		getCurrentDirectory: () => "/",
		getDirectories: () => [],
		fileExists: (name) => name === fileName,
		readFile: (name) => (name === fileName ? source : undefined),
		getCanonicalFileName: (name) => name,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
	};
	const program = ts.createProgram([fileName], { noLib: true, noResolve: true, noEmit: true }, host);
	if (program.getSyntacticDiagnostics(parsed).length !== 0) return false;
	const checker = program.getTypeChecker();
	const sensitive = new Set<string>(D108D2_FORBIDDEN_PRODUCT_RETURNS);
	const active = new Set<ts.Node>();
	const key = (name: ts.PropertyName): string | undefined =>
		ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
			? name.text
			: ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)
				? name.expression.text
				: undefined;
	const resolveSymbol = (node: ts.Node): ts.Symbol | undefined => {
		const symbol = checker.getSymbolAtLocation(node);
		return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
			? checker.getAliasedSymbol(symbol)
			: symbol;
	};
	const inspectBody = (node: ts.FunctionLikeDeclaration): boolean => {
		if (node.body === undefined || active.has(node)) return false;
		active.add(node);
		const found = ts.isBlock(node.body)
			? executableDescendants(node.body).some(
					(item) => ts.isReturnStatement(item) && item.expression !== undefined && inspect(item.expression)
				)
			: inspect(node.body);
		active.delete(node);
		return found;
	};
	const inspectDeclaration = (node: ts.Declaration): boolean => {
		if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node))
			return inspectBody(node);
		return ts.isVariableDeclaration(node) && node.initializer !== undefined ? inspect(node.initializer) : false;
	};
	const inspect = (raw: ts.Expression): boolean => {
		const value = unwrapExpression(raw);
		if (active.has(value)) return false;
		if (ts.isAwaitExpression(value) || ts.isSatisfiesExpression(value)) return inspect(value.expression);
		if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return inspectBody(value);
		if (ts.isIdentifier(value)) {
			if (sensitive.has(value.text)) return true;
			active.add(value);
			const found = resolveSymbol(value)?.declarations?.some(inspectDeclaration) === true;
			active.delete(value);
			return found;
		}
		if (ts.isObjectLiteralExpression(value))
			return value.properties.some((property) => {
				if (ts.isSpreadAssignment(property)) return inspect(property.expression);
				const name = key(property.name);
				if (name === undefined || sensitive.has(name)) return true;
				if (ts.isPropertyAssignment(property)) return inspect(property.initializer);
				if (ts.isShorthandPropertyAssignment(property))
					return checker.getShorthandAssignmentValueSymbol(property)?.declarations?.some(inspectDeclaration) === true;
				return ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)
					? inspectBody(property)
					: false;
			});
		if (ts.isArrayLiteralExpression(value))
			return value.elements.some((item) => inspect(ts.isSpreadElement(item) ? item.expression : item));
		if (ts.isConditionalExpression(value)) return inspect(value.whenTrue) || inspect(value.whenFalse);
		// Assignment and comma return their right operand; logical assignments may return either.
		if (ts.isBinaryExpression(value)) {
			if ([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.CommaToken].includes(value.operatorToken.kind))
				return inspect(value.right);
			return [
				ts.SyntaxKind.AmpersandAmpersandToken,
				ts.SyntaxKind.BarBarToken,
				ts.SyntaxKind.QuestionQuestionToken,
				ts.SyntaxKind.AmpersandAmpersandEqualsToken,
				ts.SyntaxKind.BarBarEqualsToken,
				ts.SyntaxKind.QuestionQuestionEqualsToken,
			].includes(value.operatorToken.kind)
				? inspect(value.left) || inspect(value.right)
				: // All remaining binary operators compute a primitive, rather than return an operand.
					false;
		}
		if (ts.isPropertyAccessExpression(value)) return sensitive.has(value.name.text);
		if (ts.isElementAccessExpression(value))
			return ts.isStringLiteral(value.argumentExpression) && sensitive.has(value.argumentExpression.text);
		if (ts.isCallExpression(value)) {
			if (
				ts.isPropertyAccessExpression(value.expression) &&
				ts.isIdentifier(value.expression.expression) &&
				((value.expression.expression.text === "Object" && value.expression.name.text === "freeze") ||
					(value.expression.expression.text === "Promise" && value.expression.name.text === "resolve"))
			)
				return value.arguments.some(inspect);
			// Follow directly returned local factories (the room delegates to its owned factory).
			return (
				ts.isIdentifier(value.expression) &&
				resolveSymbol(value.expression)?.declarations?.some(inspectDeclaration) === true
			);
		}
		return false;
	};
	for (const statement of parsed.statements) {
		const exported =
			ts.canHaveModifiers(statement) &&
			ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
		if (exported && ts.isFunctionDeclaration(statement) && inspectBody(statement)) return false;
		if (
			exported &&
			ts.isVariableStatement(statement) &&
			statement.declarationList.declarations.some(inspectDeclaration)
		)
			return false;
		if (ts.isExportAssignment(statement) && inspect(statement.expression)) return false;
		if (
			ts.isExportDeclaration(statement) &&
			statement.exportClause !== undefined &&
			ts.isNamedExports(statement.exportClause)
		) {
			if (
				statement.exportClause.elements.some((item) => resolveSymbol(item.name)?.declarations?.some(inspectDeclaration))
			)
				return false;
		}
	}
	for (const node of descendants(parsed)) {
		if (
			!ts.isCallExpression(node) ||
			!ts.isPropertyAccessExpression(node.expression) ||
			!ts.isIdentifier(node.expression.expression) ||
			node.expression.expression.text !== "Object"
		)
			continue;
		const target = node.arguments[0];
		if (target === undefined || !ts.isIdentifier(target) || !["globalThis", "window"].includes(target.text)) continue;
		if (node.expression.name.text === "assign" && node.arguments.slice(1).some(inspect)) return false;
		if (node.expression.name.text === "defineProperty" && node.arguments[2] !== undefined && inspect(node.arguments[2]))
			return false;
	}
	return true;
}

/**
 * Enforces the product-only ownership and non-escalation boundary around D.108d2.
 * @returns Frozen source-governance facts.
 */
export function d108d2SourceGovernance(): Readonly<Record<string, boolean>> {
	const room = read(D108E2B_GREEN_PATHS[0]);
	const chat = read("examples/v3-chat/src/index.ts");
	const root = read("packages/node/src/index.ts");
	const productExists = /adoptCreatorSuccessor\s*\(/u.test(room);
	const consumers = exampleSources("examples").filter(({ source }) => ADOPTION_MARKER.test(source));
	const roomConsumesAll = [
		"verifyCreatorSuccessorAdoption",
		"stageCreatorSuccessorAdoption",
		"publishStagedCreatorSuccessorAdoption",
		"recoverPendingCreatorSuccessorAdoption",
		"activateCreatorSuccessorAdoption",
		"reopenCreatorSuccessorAdoption",
	].every((marker) => room.includes(marker));
	return Object.freeze({
		chatHasNoDirectNodeAdoptionConsumer: !ADOPTION_MARKER.test(chat),
		chatOwnsOnlyReviewedRoomHeadCapability:
			/V3RoomHeadAuthority/u.test(chat) && /roomHeadAuthority:\s*chatRoomHeadAuthority/u.test(chat),
		chatInputAllowsOnlyDeclarationWhenProductExists:
			!productExists || sameStrings(interfaceKeys(chat, "JoinInput"), [...D108D2_CHAT_JOIN_INPUT_KEYS].sort()),
		noForbiddenProductReturn: d108d2HasClosedProductReturns(room) && d108d2HasClosedProductReturns(chat),
		noNodeRootWidening: !ADOPTION_MARKER.test(root),
		roomInputAllowsOnlyDeclarationWhenProductExists:
			!productExists ||
			sameStrings(interfaceKeys(room, "CreateV3RoomSessionInput"), [...D108D2_ROOM_INPUT_KEYS].sort()),
		roomIsSoleConsumerWhenProductExists:
			!productExists ||
			(roomConsumesAll && consumers.length === 1 && consumers[0]?.path === "examples/v3-room/src/index.ts"),
	});
}

/**
 * Pins D.108e5's two pre-copy owners through parsed TypeScript structure.
 * @param room - Room source, injectable only for fail-closed source-shape mutants.
 * @returns Whether activation and migration-invite bounds dominate allocation.
 */
export function d108e5SourceOwnership(room = read(D108E3_GREEN_PATHS[0])): Readonly<{
	readonly activationBoundPrecedesCopy: boolean;
	readonly migrationInviteBoundOwnsEveryEncode: boolean;
}> {
	const parsed = ts.createSourceFile("d108e5-room.ts", room, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const activation = uniqueVariableInitializer(parsed, "snapshotMigrationActivationInput");
	const activationBody = functionBlock(activation);
	const activationNodes = activationBody === undefined ? [] : executableDescendants(activationBody);
	const nestedActivationGuards = activationNodes.filter(
		(node): node is ts.IfStatement =>
			ts.isIfStatement(node) &&
			isBoundGuard(node, "byteLength", 49_152, "v3 room migration activation record is unbounded")
	);
	const activationGuard = nestedActivationGuards.length === 1 ? nestedActivationGuards[0] : undefined;
	const activationGuardBlock =
		activationGuard !== undefined && ts.isBlock(activationGuard.parent) ? activationGuard.parent : undefined;
	const activationGuardIndex =
		activationGuard !== undefined && activationGuardBlock !== undefined
			? activationGuardBlock.statements.indexOf(activationGuard)
			: -1;
	const activationCopies = activationNodes.filter(isIntrinsicCopy);
	const activationCopiesDominated =
		activationGuardBlock !== undefined &&
		activationGuardIndex >= 0 &&
		activationCopies.length === 3 &&
		activationCopies.every((copy) => {
			const statement = directStatement(copy, activationGuardBlock);
			return statement !== undefined && activationGuardBlock.statements.indexOf(statement) > activationGuardIndex;
		});

	const boundedInvite = uniqueVariableInitializer(parsed, "boundedMigrationCreatorInvite");
	const boundedInviteBody = functionBlock(boundedInvite);
	const inviteGuards =
		boundedInviteBody?.statements.filter((statement) =>
			isBoundGuard(statement, "exactCanonicalByteLength", 65_536, "v3 room migration target invite is unbounded")
		) ?? [];
	const inviteGuard = inviteGuards.length === 1 ? inviteGuards[0] : undefined;
	const boundedEncodes = executableIdentifierCall(boundedInviteBody, "encodeCreatorInvite");
	const boundedEncode = boundedEncodes[0];
	const boundedEncodeStatement =
		boundedInviteBody !== undefined && boundedEncodes.length === 1 && boundedEncode !== undefined
			? directStatement(boundedEncode, boundedInviteBody)
			: undefined;
	const boundedEncodeDominated =
		boundedInviteBody !== undefined &&
		inviteGuard !== undefined &&
		boundedEncodeStatement !== undefined &&
		ts.isReturnStatement(boundedEncodeStatement) &&
		boundedInviteBody.statements.indexOf(boundedEncodeStatement) > boundedInviteBody.statements.indexOf(inviteGuard);
	const fieldsInitializer = directVariableInitializer(boundedInviteBody, "fields");
	const fieldsCall = identifierCallExpression(fieldsInitializer, "exactRecord");
	const byteFieldLoops =
		boundedInviteBody?.statements.filter(
			(statement): statement is ts.ForOfStatement =>
				ts.isForOfStatement(statement) &&
				ts.isIdentifier(statement.expression) &&
				statement.expression.text === "CREATOR_INVITE_BYTE_FIELDS" &&
				statement.initializer.declarations.length === 1 &&
				statement.initializer.declarations[0] !== undefined &&
				ts.isIdentifier(statement.initializer.declarations[0].name) &&
				statement.initializer.declarations[0].name.text === "field"
		) ?? [];
	const byteFieldLoop = byteFieldLoops.length === 1 ? byteFieldLoops[0] : undefined;
	const fieldValueInitializer = executableVariableInitializer(byteFieldLoop, "fieldValue");
	const byteLengthGetters = executableIntrinsicReflectApply(
		boundedInviteBody,
		"INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER"
	);
	const byteLengthGetter = byteLengthGetters[0];
	const byteLengthAssignments =
		byteFieldLoop === undefined
			? []
			: executableDescendants(byteFieldLoop).filter(
					(node): node is ts.BinaryExpression =>
						ts.isBinaryExpression(node) &&
						node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
						ts.isIdentifier(node.left) &&
						node.left.text === "byteLength" &&
						node.right === byteLengthGetter
				);
	const byteLengthPushes =
		byteFieldLoop === undefined
			? []
			: executableDescendants(byteFieldLoop).filter(
					(node): node is ts.CallExpression =>
						ts.isCallExpression(node) &&
						ts.isPropertyAccessExpression(node.expression) &&
						ts.isIdentifier(node.expression.expression) &&
						node.expression.expression.text === "byteLengths" &&
						node.expression.name.text === "push" &&
						node.arguments.length === 1 &&
						isIdentifierExpression(node.arguments[0], "byteLength")
				);
	const exactLengthInitializer = directVariableInitializer(boundedInviteBody, "exactCanonicalByteLength");
	const exactLengthCall =
		exactLengthInitializer !== undefined && ts.isCallExpression(exactLengthInitializer)
			? exactLengthInitializer
			: undefined;
	const boundedMetadataIsLive =
		fieldsCall !== undefined &&
		fieldsCall.arguments.length === 2 &&
		isIdentifierExpression(fieldsCall.arguments[0], "value") &&
		isIdentifierExpression(fieldsCall.arguments[1], "CREATOR_INVITE_MATERIAL_KEYS") &&
		executableIdentifierCall(boundedInviteBody, "exactRecord").length === 1 &&
		byteFieldLoop !== undefined &&
		fieldValueInitializer !== undefined &&
		ts.isElementAccessExpression(fieldValueInitializer) &&
		isIdentifierExpression(fieldValueInitializer.expression, "fields") &&
		isIdentifierExpression(fieldValueInitializer.argumentExpression, "field") &&
		byteLengthGetters.length === 1 &&
		byteLengthGetter !== undefined &&
		byteLengthGetter.arguments.length === 3 &&
		isIdentifierExpression(byteLengthGetter.arguments[1], "fieldValue") &&
		byteLengthAssignments.length === 1 &&
		byteLengthPushes.length === 1 &&
		exactLengthCall !== undefined &&
		ts.isPropertyAccessExpression(exactLengthCall.expression) &&
		isIdentifierExpression(exactLengthCall.expression.expression, "byteLengths") &&
		exactLengthCall.expression.name.text === "reduce" &&
		boundedEncode !== undefined &&
		boundedEncode.arguments.length === 1 &&
		isIdentifierExpression(boundedEncode.arguments[0], "fields");
	const snapshotInvite = uniqueVariableInitializer(parsed, "snapshotMigrationInvite");
	const snapshotInviteBody = functionBlock(snapshotInvite);
	const rehearsal = uniqueVariableInitializer(parsed, "performMigrationRehearsal");
	const rehearsalBody = functionBlock(rehearsal);
	const migrationActivation = uniqueVariableInitializer(parsed, "performMigrationActivation");
	const migrationActivationBody = functionBlock(migrationActivation);
	const boundedInviteCalls = identifierCall(parsed, "boundedMigrationCreatorInvite");
	const snapshotBoundedReturns =
		snapshotInviteBody?.statements.filter(
			(statement): statement is ts.ReturnStatement =>
				ts.isReturnStatement(statement) &&
				identifierCallExpression(statement.expression, "boundedMigrationCreatorInvite") !== undefined
		) ?? [];
	const snapshotBoundedCall =
		snapshotBoundedReturns.length === 1
			? identifierCallExpression(snapshotBoundedReturns[0]?.expression, "boundedMigrationCreatorInvite")
			: undefined;
	const rehearsalInvite = executableVariableInitializer(rehearsalBody, "targetMaterial");
	const rehearsalDecode = boundedDecodeExpression(rehearsalInvite);
	const activationInvite = executableVariableInitializer(migrationActivationBody, "targetCreatorInvite");
	const activationDecode = boundedDecodeExpression(activationInvite);
	const activationInviteEncodes = executableIdentifierCall(migrationActivationBody, "encodeCreatorInvite");
	const activationInviteEncode = activationInviteEncodes[0];
	const activationInviteEncodeArgument = activationInviteEncode?.arguments[0];
	const activationReencodeIsBounded =
		activationDecode !== undefined &&
		executableIdentifierCall(migrationActivationBody, "decodeCreatorInvite").length === 1 &&
		activationInviteEncodes.length === 1 &&
		activationInviteEncode?.arguments.length === 1 &&
		activationInviteEncodeArgument !== undefined &&
		ts.isIdentifier(activationInviteEncodeArgument) &&
		activationInviteEncodeArgument.text === "targetCreatorInvite";
	const expectedBoundedInviteCalls = [
		snapshotBoundedCall,
		rehearsalDecode?.boundedCall,
		activationDecode?.boundedCall,
	].filter((call): call is ts.CallExpression => call !== undefined);
	return Object.freeze({
		activationBoundPrecedesCopy:
			activationBody !== undefined && activationGuard !== undefined && activationCopiesDominated,
		migrationInviteBoundOwnsEveryEncode:
			boundedInvite !== undefined &&
			boundedEncodeDominated &&
			boundedMetadataIsLive &&
			boundedInviteCalls.length === 3 &&
			expectedBoundedInviteCalls.length === 3 &&
			boundedInviteCalls.every((call) => expectedBoundedInviteCalls.includes(call)) &&
			executableIdentifierCall(snapshotInviteBody, "encodeCreatorInvite").length === 0 &&
			rehearsalDecode !== undefined &&
			executableIdentifierCall(rehearsalBody, "decodeCreatorInvite").length === 1 &&
			executableIdentifierCall(rehearsalBody, "encodeCreatorInvite").length === 0 &&
			activationReencodeIsBounded,
	});
}

/**
 * Validates the exact frozen product authority projection without opening node authority.
 * @param value - Candidate room/chat authority value.
 * @returns Whether the value is the exact epoch-one creator projection.
 */
export function isD108d2Authority(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Readonly<Record<string, unknown>>;
	if (
		Reflect.ownKeys(record).length !== D108D2_AUTHORITY_KEYS.length ||
		!D108D2_AUTHORITY_KEYS.every((key) => Object.hasOwn(record, key))
	) {
		return false;
	}
	return (
		typeof record.aclDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(record.aclDigest) &&
		typeof record.anchorDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(record.anchorDigest) &&
		record.epoch === 1 &&
		typeof record.genesisAnchorDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(record.genesisAnchorDigest) &&
		record.lifecycle === "active" &&
		typeof record.objectId === "string" &&
		record.objectId.length > 0 &&
		record.profileId === "creator-trusted-v1"
	);
}

/**
 * Validates one exact D.110c-b successor-authority projection at the supplied epoch.
 * @param value - Candidate room/chat authority value.
 * @param expectedEpoch - Positive safe authenticated epoch expected by the caller.
 * @returns Whether the candidate has the unchanged authority key roster and exact epoch.
 */
export function isD110cBSuccessorAuthority(value: unknown, expectedEpoch: number): boolean {
	if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) return false;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Readonly<Record<string, unknown>>;
	if (
		Reflect.ownKeys(record).length !== D108D2_AUTHORITY_KEYS.length ||
		!D108D2_AUTHORITY_KEYS.every((key) => Object.hasOwn(record, key))
	) {
		return false;
	}
	return (
		typeof record.aclDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(record.aclDigest) &&
		typeof record.anchorDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(record.anchorDigest) &&
		record.epoch === expectedEpoch &&
		typeof record.genesisAnchorDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(record.genesisAnchorDigest) &&
		record.lifecycle === "active" &&
		typeof record.objectId === "string" &&
		record.objectId.length > 0 &&
		record.profileId === "creator-trusted-v1"
	);
}
