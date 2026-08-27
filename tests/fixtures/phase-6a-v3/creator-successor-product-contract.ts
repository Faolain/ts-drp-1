import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export const D108D2_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts",
	"tests/phase-6a-creator-successor-product-red.test.ts",
	"packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts",
	"packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts",
	"packages/storage-browser/playwright.phase-6a-creator-successor-product.config.ts",
	"tests/fixtures/phase-6a-v3/creator-adoption-contract.ts",
	"tests/phase-6a-creator-adoption-red.test.ts",
	"tests/fixtures/phase-6a-v3/creator-adoption-commit-contract.ts",
	"tests/phase-6a-creator-adoption-commit-red.test.ts",
	"tests/fixtures/phase-6a-v3/creator-successor-activation-contract.ts",
	"tests/phase-6a-creator-successor-activation-red.test.ts",
] as const);

export const D108D2_GREEN_PATHS = Object.freeze([
	"examples/v3-room/src/index.ts",
	"examples/v3-chat/src/index.ts",
] as const);

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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Enforces the product-only ownership and non-escalation boundary around D.108d2.
 * @returns Frozen source-governance facts.
 */
export function d108d2SourceGovernance(): Readonly<Record<string, boolean>> {
	const room = read(D108D2_GREEN_PATHS[0]);
	const chat = read(D108D2_GREEN_PATHS[1]);
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
		chatHasNoDirectNodeAdoptionConsumer: !ADOPTION_MARKER.test(chat),
		chatInputAllowsOnlyDeclarationWhenProductExists:
			!productExists || sameStrings(interfaceKeys(chat, "JoinInput"), [...D108D2_CHAT_JOIN_INPUT_KEYS].sort()),
		exactTwoGreenOwners:
			D108D2_GREEN_PATHS.length === 2 &&
			D108D2_GREEN_PATHS[0] === "examples/v3-room/src/index.ts" &&
			D108D2_GREEN_PATHS[1] === "examples/v3-chat/src/index.ts",
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
