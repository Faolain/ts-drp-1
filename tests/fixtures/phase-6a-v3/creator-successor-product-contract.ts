import { createHash } from "node:crypto";
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
const D108E2B_CHAT_SHA256 = "af384cb45ad8cffb2e56e648bdb22ea92fb8b8a053376ec2a47c34284b95fd0f";

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
	"signRegisteredVertexDigest",
	"successorSnapshotDeclaration",
] as const);
const D108D2_CHAT_JOIN_INPUT_KEYS = Object.freeze([
	"channelName",
	"clientId",
	"databaseName",
	"invite",
	"successorSnapshotDeclaration",
] as const);

const ADOPTION_MARKER =
	/verifyCreatorSuccessorAdoption|commitCreatorSuccessorAdoption|activateCreatorSuccessorAdoption|reopenCreatorSuccessorAdoption/u;

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

function identifierCall(root: ts.Node | undefined, name: string): readonly ts.CallExpression[] {
	if (root === undefined) return Object.freeze([]);
	return descendants(root).filter(
		(node): node is ts.CallExpression =>
			ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
	);
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

function intrinsicReflectApply(root: ts.Node | undefined, name: string): readonly ts.CallExpression[] {
	if (root === undefined) return Object.freeze([]);
	return descendants(root).filter((node): node is ts.CallExpression => {
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

function decodesBoundedInvite(root: ts.Node | undefined): boolean {
	return identifierCall(root, "decodeCreatorInvite").some((call) => {
		const argument = call.arguments[0];
		return (
			argument !== undefined &&
			ts.isCallExpression(argument) &&
			ts.isIdentifier(argument.expression) &&
			argument.expression.text === "boundedMigrationCreatorInvite"
		);
	});
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
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
		"commitCreatorSuccessorAdoption",
		"activateCreatorSuccessorAdoption",
		"reopenCreatorSuccessorAdoption",
	].every((marker) => room.includes(marker));
	return Object.freeze({
		chatByteIdentical: createHash("sha256").update(chat).digest("hex") === D108E2B_CHAT_SHA256,
		chatHasNoDirectNodeAdoptionConsumer: !ADOPTION_MARKER.test(chat),
		chatInputAllowsOnlyDeclarationWhenProductExists:
			!productExists || sameStrings(interfaceKeys(chat, "JoinInput"), [...D108D2_CHAT_JOIN_INPUT_KEYS].sort()),
		noForbiddenProductReturn:
			!/return\s+[^;]*(?:intent|capability|activationResult|exactCanonicalTrust|snapshotReceipt|signingAuthority|displacedSource)/u.test(
				`${room}\n${chat}`
			),
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
 * @returns Whether activation and migration-invite bounds dominate allocation.
 */
export function d108e5SourceOwnership(): Readonly<{
	readonly activationBoundPrecedesCopy: boolean;
	readonly migrationInviteBoundOwnsEveryEncode: boolean;
}> {
	const room = read(D108E3_GREEN_PATHS[0]);
	const parsed = ts.createSourceFile("d108e5-room.ts", room, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const activation = uniqueVariableInitializer(parsed, "snapshotMigrationActivationInput");
	const activationBody = functionBlock(activation);
	const nestedActivationGuards = descendants(activationBody ?? parsed).filter(
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
	const activationCopies = activation === undefined ? [] : descendants(activation).filter(isIntrinsicCopy);
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
	const boundedEncodes = identifierCall(boundedInvite, "encodeCreatorInvite");
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
	const snapshotInvite = uniqueVariableInitializer(parsed, "snapshotMigrationInvite");
	const rehearsal = uniqueVariableInitializer(parsed, "performMigrationRehearsal");
	const migrationActivation = uniqueVariableInitializer(parsed, "performMigrationActivation");
	const boundedInviteCalls = identifierCall(parsed, "boundedMigrationCreatorInvite");
	const snapshotBoundedCalls = identifierCall(snapshotInvite, "boundedMigrationCreatorInvite");
	const rehearsalBoundedCalls = identifierCall(rehearsal, "boundedMigrationCreatorInvite");
	const activationBoundedCalls = identifierCall(migrationActivation, "boundedMigrationCreatorInvite");
	const activationInvite = uniqueVariableInitializer(migrationActivation ?? parsed, "targetCreatorInvite");
	const activationInviteEncodes = identifierCall(migrationActivation, "encodeCreatorInvite");
	const activationInviteEncode = activationInviteEncodes[0];
	const activationInviteEncodeArgument = activationInviteEncode?.arguments[0];
	const activationReencodeIsBounded =
		activationInvite !== undefined &&
		decodesBoundedInvite(activationInvite) &&
		activationInviteEncodes.length === 1 &&
		activationInviteEncode?.arguments.length === 1 &&
		activationInviteEncodeArgument !== undefined &&
		ts.isIdentifier(activationInviteEncodeArgument) &&
		activationInviteEncodeArgument.text === "targetCreatorInvite";
	return Object.freeze({
		activationBoundPrecedesCopy:
			activationBody !== undefined && activationGuard !== undefined && activationCopiesDominated,
		migrationInviteBoundOwnsEveryEncode:
			boundedInvite !== undefined &&
			boundedEncodeDominated &&
			identifierCall(boundedInvite, "exactRecord").length === 1 &&
			intrinsicReflectApply(boundedInvite, "INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER").length === 1 &&
			boundedInviteCalls.length === 3 &&
			snapshotBoundedCalls.length === 1 &&
			identifierCall(snapshotInvite, "encodeCreatorInvite").length === 0 &&
			rehearsalBoundedCalls.length === 1 &&
			decodesBoundedInvite(rehearsal) &&
			identifierCall(rehearsal, "encodeCreatorInvite").length === 0 &&
			activationBoundedCalls.length === 1 &&
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
