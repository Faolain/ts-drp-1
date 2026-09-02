/* eslint-disable @typescript-eslint/explicit-function-return-type -- This deterministic evidence gate is plain Node ESM. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const [adoption, commit, activation, room] = await Promise.all([
	read("packages/node/src/creator-adoption.ts"),
	read("packages/node/src/creator-adoption-commit.ts"),
	read("packages/node/src/creator-adoption-activate.ts"),
	read("examples/v3-room/src/index.ts"),
]);

function section(source, start, end) {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	if (from < 0 || to < 0) throw new TypeError(`D110C_B_SOURCE_SECTION_MISSING:${start}`);
	return source.slice(from, to);
}

const chain = section(adoption, "function verifyChain(", "async function verifySnapshot(");
const projection = section(adoption, "function projection(", "function successorCommitMaterial(");
const commitMaterial = section(adoption, "function successorCommitMaterial(", "function creatorSuccessorLiveSeed(");
const liveSeed = section(
	adoption,
	"function creatorSuccessorLiveSeed(",
	"export async function verifyCreatorSuccessorAdoption("
);
const authenticatedTerminal = section(
	commit,
	"async function authenticatedTerminal(",
	"async function authenticatedStaged("
);
const authenticatedStaged = section(commit, "async function authenticatedStaged(", "function successfulMutation(");
const activateMaterial = section(
	activation,
	"async function activateMaterial(",
	"/**\n * Activates one freshly committed"
);
const roomAdoption = section(
	room,
	"const performCreatorSuccessorAdoption = async (): Promise<void> => {",
	"const adoptCreatorSuccessor = (): Promise<void> => {"
);
const roomAuthority = section(room, "export interface V3RoomSuccessorAuthority", "export interface V3RoomHead");
const successorAuthority = section(room, "function successorAuthority(", "function digest(");

const predicates = Object.freeze({
	activationDeletesTopicWithoutOwnerToken:
		/await Promise\.resolve\(rawHandle\.deactivate\(\)\);\s*activeOwners\.delete\(topic\);\s*await lock\?\.release\(\);/u.test(
			activateMaterial
		),
	activationSameBindingsReturnsExistingWrapper:
		/sameBindings\(existing\.bindings, bindings\)\s*\? success\(material, existing\.handle\)/u.test(activateMaterial),
	commitStagedRequiresGenerationOnePredecessor: authenticatedStaged.includes(
		'canonicalRecord(bytes)?.kind === "v3-live-generation-1"'
	),
	commitTerminalRequiresGenerationOnePredecessor: authenticatedTerminal.includes(
		'canonicalRecord(bytes)?.kind === "v3-live-generation-1"'
	),
	currentChainRequiresGenerationOneProjection: chain.includes(
		'.filter((candidate) => candidate?.kind === "v3-live-generation-1")'
	),
	liveSeedRequiresGenerationOnePredecessor: liveSeed.includes(
		'canonicalRecord(bytes)?.kind === "v3-live-generation-1"'
	),
	productHasNoPostAdoptionCloseBind: !roomAdoption.includes("bindCreatorLiveClose"),
	productHasOneTransitionLatch: roomAdoption.includes("if (successorProjectionAuthority !== null) return;"),
	productPublicAuthorityEpochIsLiteralOne: roomAuthority.includes("readonly epoch: 1;"),
	productReturnedAuthorityEpochIsLiteralOne: successorAuthority.includes("epoch: 1 as const"),
	productTrustEpochIsLiteralOne: successorAuthority.includes("currentEpoch !== 1"),
	projectionGraphEpochIsLiteralOne: /vertices:\s*\[\s*\{[\s\S]*?epoch: 1,/u.test(projection),
	projectionRecordEpochIsLiteralOne: /const bytes = encodeCanonical\(\{[\s\S]*?epoch: 1,/u.test(projection),
	successorCommitRequiresGenerationOnePredecessor: commitMaterial.includes('decoded?.kind === "v3-live-generation-1"'),
});

const failed = Object.entries(predicates).filter(([, value]) => value !== true);
process.stdout.write(`${JSON.stringify({ failed: failed.map(([name]) => name), predicates }, null, 2)}\n`);
if (failed.length > 0) throw new TypeError(`D110C_B_SOURCE_SHAPE_MISMATCH:${failed.map(([name]) => name).join(",")}`);
