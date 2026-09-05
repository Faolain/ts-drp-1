import { decodeCanonical } from "@ts-drp/canonical";
import { digestBlob, digestClosure, type GenerationRef, type PresentHead } from "@ts-drp/storage";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export const D108C_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6a-v3/creator-adoption-commit-contract.ts",
	"tests/phase-6a-creator-adoption-commit-red.test.ts",
	"tests/fixtures/phase-6a-v3/creator-adoption-contract.ts",
	"packages/storage-node/tests/fixtures/phase-6a-creator-adoption-commit-child.mjs",
	"packages/storage-node/tests/phase-6a-creator-adoption-commit-death-red.test.ts",
	"packages/storage-browser/tests/assets/phase-6a-creator-adoption-commit-entry.ts",
	"packages/storage-browser/tests/process/phase-6a-creator-adoption-commit-child.ts",
	"packages/storage-browser/tests/phase-6a-creator-adoption-commit-global-setup.ts",
	"packages/storage-browser/tests/phase-6a-creator-adoption-commit.pw.ts",
	"packages/storage-browser/playwright.phase-6a-creator-adoption-commit.config.ts",
] as const);

export const D108C_GREEN_PATHS = Object.freeze([
	"packages/node/src/creator-adoption-commit.ts",
	"packages/node/src/internal/creator-adoption-intent.ts",
	"packages/node/src/creator-adoption.ts",
	"packages/node/package.json",
] as const);

export const CREATOR_ADOPTION_COMMIT_EXPORTS = Object.freeze(["commitCreatorSuccessorAdoption"] as const);
export const CREATOR_ADOPTION_COMMIT_INPUT_KEYS = Object.freeze(["handle", "intent"] as const);
export const CREATOR_ADOPTION_COMMIT_SUCCESS_KEYS = Object.freeze([
	"capability",
	"descriptor",
	"head",
	"lifecycle",
	"ok",
	"recovery",
] as const);
export const CREATOR_ADOPTION_COMMIT_FAILURE_KINDS = Object.freeze([
	"malformed-input",
	"intent-unavailable",
	"recovery-failed",
	"chain-invalid",
	"pending-old",
	"stale-head",
	"storage-failed",
	"internal-invariant",
] as const);
export const D108C_MUTATION_OPERATIONS = Object.freeze([
	"beginGeneration",
	"putCachedBlob",
	"promoteReference",
	"completeGeneration",
	"swapHead",
] as const);
export const D108C_REQUEST_EDGES = Object.freeze(["before-request", "commit-then-throw", "after-request"] as const);
export const D108C_TRANSACTION_EDGES = Object.freeze(["before-commit", "after-commit"] as const);

export interface D108cCandidateModule {
	commitCreatorSuccessorAdoption?(input: unknown): Promise<Readonly<Record<string, unknown>>>;
}

export interface D108cTerminalInput {
	readonly candidateClosure: readonly GenerationRef[];
	readonly pendingHead: PresentHead;
	readonly recovered: Readonly<{
		readonly head: PresentHead;
		readonly references: readonly GenerationRef[];
		readonly state: string;
	}>;
}

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

/**
 * Independent terminal oracle: the candidate generation id is deliberately irrelevant.
 * @param input - Pending sentinel, candidate closure and recovered active state.
 * @returns Exact old/new/conflict classification.
 */
export function classifyD108cTerminal(input: D108cTerminalInput): "active-new" | "pending-old" | "stale-head" {
	const { candidateClosure, pendingHead, recovered } = input;
	if (
		recovered.head.objectId === pendingHead.objectId &&
		recovered.head.generationId === pendingHead.generationId &&
		recovered.head.revision === pendingHead.revision &&
		recovered.head.closureDigest === pendingHead.closureDigest
	) {
		return "pending-old";
	}
	const closureDigest = digestClosure(candidateClosure);
	return closureDigest.ok &&
		recovered.state === "Adopted" &&
		recovered.head.objectId === pendingHead.objectId &&
		recovered.head.revision === pendingHead.revision + 1 &&
		recovered.head.closureDigest === closureDigest.value &&
		recovered.references.length === candidateClosure.length &&
		candidateClosure.every((ref, index) => sameRef(ref, recovered.references[index] as GenerationRef))
		? "active-new"
		: "stale-head";
}

/**
 * Independent candidate-closure oracle for the single live-projection replacement.
 * @param pending - Exact pending closure.
 * @param predecessorLiveRef - Authenticated generation-1 live projection ref.
 * @param generation2Bytes - Exact canonical generation-2 projection bytes.
 * @returns Strictly sorted candidate closure and new projection ref.
 */
export function deriveD108cCandidateClosure(
	pending: readonly GenerationRef[],
	predecessorLiveRef: GenerationRef,
	generation2Bytes: Uint8Array
): Readonly<{ readonly closure: readonly GenerationRef[]; readonly projectionRef: GenerationRef }> {
	const decoded = decodeCanonical(generation2Bytes) as Readonly<Record<string, unknown>>;
	if (
		decoded.kind !== "v3-live-generation-2" ||
		pending.filter((ref) => sameRef(ref, predecessorLiveRef)).length !== 1
	) {
		throw new TypeError("invalid D.108c candidate material");
	}
	const digest = digestBlob(generation2Bytes);
	if (!digest.ok) throw new TypeError("invalid D.108c projection digest");
	const projectionRef = Object.freeze({ byteLength: generation2Bytes.byteLength, digest: digest.value });
	const closure = Object.freeze(
		[...pending.filter((ref) => !sameRef(ref, predecessorLiveRef)), projectionRef].sort((left, right) =>
			left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
		)
	);
	if (new Set(closure.map(({ digest: value }) => value)).size !== closure.length) {
		throw new TypeError("duplicate D.108c candidate ref");
	}
	return Object.freeze({ closure, projectionRef });
}

/**
 * Returns the finite request-edge roster after candidate closure construction.
 * @param candidateRefCount - Exact candidate closure cardinality.
 * @returns Every numbered logical request edge.
 */
export function d108cRequestFaultRoster(candidateRefCount: number): readonly string[] {
	if (!Number.isSafeInteger(candidateRefCount) || candidateRefCount < 1) throw new TypeError("invalid ref count");
	const operations = ["beginGeneration", "putCachedBlob"];
	for (let index = 0; index < candidateRefCount; index += 1) operations.push(`promoteReference:${index}`);
	operations.push("completeGeneration", "swapHead");
	return Object.freeze(operations.flatMap((operation) => D108C_REQUEST_EDGES.map((edge) => `${operation}:${edge}`)));
}

/**
 * Returns the finite native transaction-edge roster.
 * @param candidateRefCount - Exact candidate closure cardinality.
 * @returns Every numbered native commit edge.
 */
export function d108cTransactionFaultRoster(candidateRefCount: number): readonly string[] {
	if (!Number.isSafeInteger(candidateRefCount) || candidateRefCount < 1) throw new TypeError("invalid ref count");
	const operations = ["beginGeneration", "putCachedBlob"];
	for (let index = 0; index < candidateRefCount; index += 1) operations.push(`promoteReference:${index}`);
	operations.push("completeGeneration", "swapHead");
	return Object.freeze(
		operations.flatMap((operation) => D108C_TRANSACTION_EDGES.map((edge) => `${operation}:${edge}`))
	);
}

/**
 * Returns whether the exact four production owners and export are ready.
 * @returns Composite readiness with exact missing owners.
 */
export function d108cReadiness(): Readonly<{ readonly missing: readonly string[]; readonly ready: boolean }> {
	const missing: string[] = D108C_GREEN_PATHS.filter((path) => !existsSync(resolve(REPOSITORY_ROOT, path)));
	const manifestPath = resolve(REPOSITORY_ROOT, "packages/node/package.json");
	if (existsSync(manifestPath)) {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly exports?: Record<string, unknown> };
		if (!("./creator-adoption-commit" in (manifest.exports ?? {}))) missing.push("package export");
	}
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

/**
 * Inspects the frozen production boundary without importing the candidate.
 * @returns Root/product/effect/export governance facts.
 */
export function d108cSourceGovernance(): Readonly<{
	readonly exactFailureVocabulary: boolean;
	readonly exactNonRootExport: boolean;
	readonly noActivationOrIssueEffects: boolean;
	readonly noDirectChatCommitConsumer: boolean;
	readonly noRootExport: boolean;
	readonly privateCapabilityConsumer: boolean;
	readonly retainedCommitHasNoProductConsumer: boolean;
	readonly roomOwnsStagedPublicationWhenProductExists: boolean;
}> {
	const read = (path: string): string => {
		const absolute = resolve(REPOSITORY_ROOT, path);
		return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
	};
	const owner = read(D108C_GREEN_PATHS[0]);
	const internal = read(D108C_GREEN_PATHS[1]);
	const root = read("packages/node/src/index.ts");
	const room = read("examples/v3-room/src/index.ts");
	const chat = read("examples/v3-chat/src/index.ts");
	const productExists = /adoptCreatorSuccessor\s*\(/u.test(room);
	const roomConsumesStagedPublication =
		/@ts-drp\/node\/creator-adoption-stage/u.test(room) &&
		/stageCreatorSuccessorAdoption/u.test(room) &&
		/publishStagedCreatorSuccessorAdoption/u.test(room);
	const manifest = JSON.parse(read("packages/node/package.json")) as {
		readonly exports?: Readonly<Record<string, unknown>>;
	};
	const entry = manifest.exports?.["./creator-adoption-commit"] as Readonly<Record<string, unknown>> | undefined;
	return Object.freeze({
		exactFailureVocabulary: CREATOR_ADOPTION_COMMIT_FAILURE_KINDS.every((kind) => owner.includes(`"${kind}"`)),
		exactNonRootExport:
			entry?.types === "./dist/src/creator-adoption-commit.d.ts" &&
			entry.import === "./dist/src/creator-adoption-commit.js",
		noActivationOrIssueEffects: !/activateV3LivePlane|issueLocal|transactIssue|subscribe|routeV3Ingress/u.test(owner),
		noDirectChatCommitConsumer: !/commitCreatorSuccessorAdoption|creator-adoption-commit/u.test(chat),
		noRootExport: !/commitCreatorSuccessorAdoption|creator-adoption-commit/u.test(root),
		privateCapabilityConsumer: /function\s+consumePreparedCreatorSuccessorAdoption\s*\(/u.test(internal),
		retainedCommitHasNoProductConsumer: !/commitCreatorSuccessorAdoption|@ts-drp\/node\/creator-adoption-commit/u.test(
			room
		),
		roomOwnsStagedPublicationWhenProductExists: !productExists || roomConsumesStagedPublication,
	});
}
