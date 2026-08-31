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

function variableInitializer(source: string, name: string): string | undefined {
	const parsed = ts.createSourceFile("d108e5-source.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	let selected: string | undefined;
	const visit = (node: ts.Node): void => {
		if (
			selected === undefined &&
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === name
		) {
			selected = node.initializer?.getText(parsed);
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	return selected;
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
	const activation = variableInitializer(room, "snapshotMigrationActivationInput");
	const boundedInvite = variableInitializer(room, "boundedMigrationCreatorInvite");
	const activationText = activation ?? "";
	const boundedInviteText = boundedInvite ?? "";
	const parsed = ts.createSourceFile("d108e5-room.ts", room, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	let boundedInviteCalls = 0;
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "boundedMigrationCreatorInvite"
		) {
			boundedInviteCalls += 1;
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	const activationBound = activationText.indexOf("49_152");
	const activationCopy = activationText.search(/new\s+INTRINSIC_UINT8_ARRAY/u);
	return Object.freeze({
		activationBoundPrecedesCopy: activationBound >= 0 && activationCopy >= 0 && activationBound < activationCopy,
		migrationInviteBoundOwnsEveryEncode:
			boundedInvite !== undefined &&
			boundedInviteText.includes("65_536") &&
			boundedInviteText.includes("exactRecord") &&
			boundedInviteText.includes("INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER") &&
			boundedInviteCalls >= 3,
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
