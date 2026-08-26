import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export const REQUIRED_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-5e-v3/creator-actor-contract.ts",
	"tests/fixtures/phase-5e-v3/creator-actor-driver.ts",
	"tests/phase-5e-creator-actor-red.test.ts",
	"packages/storage-browser/tests/assets/phase-5e-creator-actor-entry.ts",
	"packages/storage-browser/tests/phase-5e-creator-actor.pw.ts",
	"packages/storage-browser/playwright.phase-5e-creator-actor.config.ts",
]);

export const REQUIRED_GREEN_PATHS = Object.freeze([
	"packages/keychain/src/finality.ts",
	"packages/seal/src/creator.ts",
	"packages/seal/src/internal/creator-close-intent.ts",
	"packages/seal/package.json",
	"packages/storage-browser/src/seal-evidence.ts",
	"packages/storage-browser/src/seal-vote.ts",
	"packages/storage-browser/src/internal/schema-idb.ts",
	"packages/storage-browser/src/internal/seal-evidence-store.ts",
	"packages/storage-browser/src/internal/seal-vote-store.ts",
	"packages/storage-browser/src/internal/seal-vote-test-control.ts",
	"packages/storage-browser/package.json",
	"packages/storage-browser/tests/phase-5c-seal-vote-schema.pw.ts",
	"packages/storage-browser/tests/assets/phase-5d-round-change-entry.ts",
	"vite.config.mts",
]);

export const NEW_SEMANTIC_OWNERS = Object.freeze([
	"packages/seal/src/creator.ts",
	"packages/seal/src/internal/creator-close-intent.ts",
	"packages/storage-browser/src/seal-evidence.ts",
	"packages/storage-browser/src/internal/seal-evidence-store.ts",
]);

export const EXPECTED_SCHEMA_V3 = Object.freeze({
	stores: Object.freeze([
		Object.freeze({ autoIncrement: false, indexes: Object.freeze([]), keyPath: "digest", name: "blobs" }),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "generationId"]),
			name: "generations",
		}),
		Object.freeze({ autoIncrement: false, indexes: Object.freeze([]), keyPath: "objectId", name: "objects" }),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "generationId", "digest"]),
			name: "promotions",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "signerId"]),
			name: "sealEvidence",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "signerId"]),
			name: "signerState",
		}),
		Object.freeze({ autoIncrement: false, indexes: Object.freeze([]), keyPath: "key", name: "storageMeta" }),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "round", "phase", "signerId"]),
			name: "voteOutbox",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "round", "phase", "signerId"]),
			name: "voteSlots",
		}),
	]),
	version: 3,
});

export const EXACT_VOTE_TRANSACTION_STORES = Object.freeze(["signerState", "storageMeta", "voteOutbox", "voteSlots"]);

export const EXPECTED_EXPORTS = Object.freeze({
	creator: Object.freeze(["createCreatorSealActor"]),
	evidence: Object.freeze(["openBrowserSealEvidenceStore"]),
	finality: Object.freeze(["createRecoverableFinalitySigner", "signCreatorAnchorRequest", "signSealRegisteredDigest"]),
});

export const CRASH_CHECKPOINTS = Object.freeze([
	"before-evidence-commit",
	"after-evidence-commit",
	"after-prepare-vote-commit",
	"after-prepare-qc-commit",
	"after-commit-vote-commit",
	"after-commit-qc-commit",
	"after-successor-complete",
]);

export const MUTANT_REJECTIONS = Object.freeze({
	AMBIGUOUS_COMMIT_RETRY: "AMBIGUOUS_OUTCOME",
	CONFLICTING_CLOSE: "CLOSE_CONFLICT",
	COPIED_ACTOR: "UNTRUSTED_CREATOR_ACTOR",
	DUPLICATE_EXACT_BYTES: "exact-replay",
	EVIDENCE_AFTER_SIGN: "EVIDENCE_ORDER_VIOLATION",
	FOREIGN_SIGNER: "SIGNER_NOT_AUTHORIZED",
	PROVISIONAL_CARRIER: "PROVISIONAL_CARRIER_RELEASE",
	RAW_DIGEST_SIGN: "UNTRUSTED_SIGNING_REQUEST",
	REOPEN_CORRUPT_QC: "DURABLE_QC_INVALID",
	STOP_LATE_EFFECT: "STOPPED",
});

export interface CreatorActorReadiness {
	readonly missing: readonly string[];
	readonly ready: boolean;
}

function exactRuntimeExports(path: string): readonly string[] {
	const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, path), "utf8")) as Readonly<{
		readonly exports?: Readonly<Record<string, unknown>>;
	}>;
	return Object.keys(manifest.exports ?? {}).sort();
}

/**
 * Returns the sole product-readiness fact after independent RED controls run.
 * @returns Closed missing-owner roster and readiness result.
 */
export function creatorActorReadiness(): CreatorActorReadiness {
	const missing = NEW_SEMANTIC_OWNERS.filter((path) => !existsSync(resolve(REPOSITORY_ROOT, path)));
	if (missing.length === 0) {
		const sealExports = exactRuntimeExports("packages/seal/package.json");
		const browserExports = exactRuntimeExports("packages/storage-browser/package.json");
		if (!sealExports.includes("./creator")) missing.push("@ts-drp/seal/creator export");
		if (!sealExports.includes("./internal/creator-close-intent")) {
			missing.push("@ts-drp/seal/internal/creator-close-intent export");
		}
		if (!browserExports.includes("./seal-evidence")) missing.push("@ts-drp/storage-browser/seal-evidence export");
		const vite = readFileSync(resolve(REPOSITORY_ROOT, "vite.config.mts"), "utf8");
		for (const subpath of [
			"@ts-drp/seal/creator",
			"@ts-drp/seal/internal/creator-close-intent",
			"@ts-drp/storage-browser/seal-evidence",
		]) {
			if (!vite.includes(`"${subpath}"`)) missing.push(`${subpath} Vite alias`);
		}
	}
	return Object.freeze({ missing: Object.freeze([...missing]), ready: missing.length === 0 });
}

/**
 * Returns one stable enumerable-key roster.
 * @param value - Candidate module or contract record.
 * @returns Sorted enumerable string keys.
 */
export function exactKeys(value: object): readonly string[] {
	return Object.freeze(Object.keys(value).sort());
}
