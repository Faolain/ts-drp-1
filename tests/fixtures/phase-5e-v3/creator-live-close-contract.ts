import { decodeCanonical } from "@ts-drp/canonical";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export const REQUIRED_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-5e-v3/creator-live-close-contract.ts",
	"tests/phase-5e-creator-live-close-red.test.ts",
	"packages/storage-browser/tests/phase-5e-creator-live-close.pw.ts",
	"packages/storage-browser/playwright.phase-5e-creator-live-close.config.ts",
	"packages/storage-browser/tests/assets/phase-5e-creator-live-close-entry.ts",
]);

export const REQUIRED_GREEN_PATHS = Object.freeze([
	"packages/control-plane/src/creator-trust-advance.ts",
	"packages/control-plane/package.json",
	"packages/node/src/creator-close.ts",
	"packages/node/src/v3-live.ts",
	"packages/node/package.json",
	"examples/v3-room/src/index.ts",
	"examples/v3-chat/src/index.ts",
	"vite.config.mts",
]);

export const CREATOR_LIVE_CLOSE_EXPORTS = Object.freeze({
	controlPlane: Object.freeze(["inspectCreatorTrustAdvance"]),
	node: Object.freeze(["bindCreatorLiveClose"]),
});

export const CREATOR_TRUST_TEXT = "Creator-certified; one of one; not Byzantine-fault-tolerant." as const;
export const CREATOR_CONTINUITY_STATES = Object.freeze(["continuous", "relearning", "stalled"]);
export const CREATOR_LIFECYCLE_STATES = Object.freeze(["active", "sealed", "successor-pending-adoption"]);
export const CREATOR_ADVANCE_REJECTIONS = Object.freeze([
	"BYTE_REPLAY",
	"EPOCH_EQUIVOCATION",
	"EPOCH_GAP",
	"ROLLBACK",
	"TRUST_CLOSURE_INVALID",
]);

export interface CreatorLiveCloseReadiness {
	readonly missing: readonly string[];
	readonly ready: boolean;
}

function packageExports(path: string): readonly string[] {
	const parsed = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, path), "utf8")) as Readonly<{
		readonly exports?: Readonly<Record<string, unknown>>;
	}>;
	return Object.keys(parsed.exports ?? {}).sort();
}

/**
 * Returns the sole product-readiness fact after every independent RED oracle runs.
 * @returns Closed missing-owner, export and alias roster.
 */
export function creatorLiveCloseReadiness(): CreatorLiveCloseReadiness {
	const missing = REQUIRED_GREEN_PATHS.filter((path) => !existsSync(resolve(REPOSITORY_ROOT, path)));
	if (existsSync(resolve(REPOSITORY_ROOT, "packages/control-plane/src/creator-trust-advance.ts"))) {
		if (!packageExports("packages/control-plane/package.json").includes("./creator-trust-advance")) {
			missing.push("@ts-drp/control-plane/creator-trust-advance export");
		}
	}
	if (existsSync(resolve(REPOSITORY_ROOT, "packages/node/src/creator-close.ts"))) {
		if (!packageExports("packages/node/package.json").includes("./creator-close")) {
			missing.push("@ts-drp/node/creator-close export");
		}
	}
	const vite = readFileSync(resolve(REPOSITORY_ROOT, "vite.config.mts"), "utf8");
	for (const subpath of ["@ts-drp/control-plane/creator-trust-advance", "@ts-drp/node/creator-close"]) {
		if (!vite.includes(`"${subpath}"`)) missing.push(`${subpath} Vite alias`);
	}
	return Object.freeze({ missing: Object.freeze([...missing]), ready: missing.length === 0 });
}

export type IndependentAdvanceClassification =
	| Readonly<{ readonly ok: true; readonly kind: "successor" }>
	| Readonly<{
			readonly ok: false;
			readonly reason: "BYTE_REPLAY" | "EPOCH_EQUIVOCATION" | "EPOCH_GAP" | "ROLLBACK";
	  }>;

/**
 * Independently classifies the closed epoch relation without writing storage.
 * @param current - Authenticated current epoch and anchor identity.
 * @param candidateExactTrustBytes - Candidate exact successor trust carrier.
 * @returns Closed advancement classification.
 */
export function classifyIndependentAdvance(
	current: Readonly<{ readonly anchor: string; readonly epoch: number }>,
	candidateExactTrustBytes: Uint8Array
): IndependentAdvanceClassification {
	const decoded = decodeCanonical(candidateExactTrustBytes) as Readonly<Record<string, unknown>>;
	const candidateEpoch = decoded.currentEpoch;
	const candidateAnchor = decoded.currentAnchorDigest;
	if (candidateEpoch === current.epoch && candidateAnchor === current.anchor) {
		return Object.freeze({ ok: false as const, reason: "BYTE_REPLAY" as const });
	}
	if (candidateEpoch === current.epoch) {
		return Object.freeze({ ok: false as const, reason: "EPOCH_EQUIVOCATION" as const });
	}
	if (typeof candidateEpoch !== "number" || candidateEpoch < current.epoch) {
		return Object.freeze({ ok: false as const, reason: "ROLLBACK" as const });
	}
	if (candidateEpoch !== current.epoch + 1) {
		return Object.freeze({ ok: false as const, reason: "EPOCH_GAP" as const });
	}
	return Object.freeze({ kind: "successor" as const, ok: true as const });
}

export interface ModelGenerationRef {
	readonly byteLength: number;
	readonly digest: string;
}

export interface ModelHead {
	readonly closureDigest: string;
	readonly generationId: string;
	readonly objectId: string;
	readonly revision: number;
}

/**
 * Independent combined-generation oracle: one old trust ref is replaced and every other ref survives.
 * @param input - Current closure, exact trust refs and certified proof refs.
 * @returns Sorted successor closure.
 */
export function expectedCombinedClosure(
	input: Readonly<{
		current: readonly ModelGenerationRef[];
		currentTrustRef: ModelGenerationRef;
		proofRefs: readonly ModelGenerationRef[];
		successorTrustRef: ModelGenerationRef;
	}>
): readonly ModelGenerationRef[] {
	const retained = input.current.filter(({ digest }) => digest !== input.currentTrustRef.digest);
	if (retained.length !== input.current.length - 1) throw new TypeError("current trust ref must occur exactly once");
	const combined = [...retained, input.successorTrustRef, ...input.proofRefs];
	if (new Set(combined.map(({ digest }) => digest)).size !== combined.length) {
		throw new TypeError("combined closure refs must be unique");
	}
	return Object.freeze([...combined].sort((left, right) => left.digest.localeCompare(right.digest)));
}

/**
 * Models the required reopen decision after an ambiguous sole head CAS.
 * @param expectedSuccessor - Exact staged successor head.
 * @param reopened - Authoritative head reopened after ambiguity.
 * @returns Whether the exact successor committed or another generation won.
 */
export function resolveIndependentAmbiguousSwap(
	expectedSuccessor: ModelHead,
	reopened: ModelHead
): "committed" | "conflict" {
	return expectedSuccessor.objectId === reopened.objectId &&
		expectedSuccessor.generationId === reopened.generationId &&
		expectedSuccessor.closureDigest === reopened.closureDigest &&
		expectedSuccessor.revision === reopened.revision
		? "committed"
		: "conflict";
}

/**
 * Returns sorted enumerable module keys.
 * @param value - Runtime module namespace.
 * @returns Frozen exact key roster.
 */
export function exactKeys(value: object): readonly string[] {
	return Object.freeze(Object.keys(value).sort());
}
