import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export const REQUIRED_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-5e-v3/creator-relearn-contract.ts",
	"tests/fixtures/phase-5e-v3/creator-relearn-driver.ts",
	"tests/phase-5e-creator-relearn-red.test.ts",
	"packages/storage-browser/tests/assets/phase-5e-creator-relearn-entry.ts",
	"packages/storage-browser/tests/phase-5e-creator-relearn.pw.ts",
	"packages/storage-browser/playwright.phase-5e-creator-relearn.config.ts",
	"packages/storage-browser/tests/process/phase-5e-creator-relearn-death-child.ts",
]);

export const REQUIRED_GREEN_PATHS = Object.freeze([
	"packages/network/src/node.ts",
	"packages/network/src/seal.ts",
	"packages/network/package.json",
	"packages/node/src/creator-seal.ts",
	"packages/node/package.json",
	"packages/storage-browser/src/seal-evidence.ts",
	"packages/storage-browser/src/internal/seal-evidence-store.ts",
	"packages/storage-browser/tests/phase-4c-browser-server.ts",
	"vite.config.mts",
]);

export const NEW_SEMANTIC_OWNERS = Object.freeze(["packages/network/src/seal.ts", "packages/node/src/creator-seal.ts"]);

export const CREATOR_RELEARN_PROTOCOL = "/ts-drp/v3/seal-evidence/1.0.0" as const;
export const CREATOR_RELEARN_LIMITS = Object.freeze({
	maxEvidenceBytes: 262_144,
	queryTimeoutMs: 10_000,
});
export const CREATOR_RELEARN_STATUSES = Object.freeze([
	"equivocation",
	"ready",
	"relearn-required",
	"relearning",
	"stalled",
]);
export const CREATOR_RELEARN_FAILURES = Object.freeze([
	"ABORTED",
	"EQUIVOCATION",
	"MALFORMED_EVIDENCE",
	"NO_AUTHENTICATED_EVIDENCE",
	"QUERY_TIMEOUT",
	"SIGNING_BLOCKED",
	"UNAUTHORIZED_PEER",
]);
export const CREATOR_RELEARN_REQUEST_FIELDS = Object.freeze(["anchor", "epoch", "kind", "objectId"]);
export const CREATOR_RELEARN_RESPONSE_FIELDS = Object.freeze([
	"carrier",
	"exactCanonicalCommitQcBytes",
	"exactCanonicalCutValueBytes",
	"exactCanonicalTrustStateRecordBytes",
	"kind",
	"signerPublicKey",
]);
export const EXPECTED_EXPORTS = Object.freeze({
	network: Object.freeze(["SEAL_EVIDENCE_PROTOCOL", "createSealEvidenceProtocolPort"]),
	node: Object.freeze(["recoverCreatorSealContinuity"]),
});

export interface CreatorRelearnReadiness {
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
 * @returns Closed missing-owner/export/alias roster.
 */
export function creatorRelearnReadiness(): CreatorRelearnReadiness {
	const missing = NEW_SEMANTIC_OWNERS.filter((path) => !existsSync(resolve(REPOSITORY_ROOT, path)));
	if (missing.length === 0) {
		const networkExports = packageExports("packages/network/package.json");
		const nodeExports = packageExports("packages/node/package.json");
		if (!networkExports.includes("./seal")) missing.push("@ts-drp/network/seal export");
		if (!nodeExports.includes("./creator-seal")) missing.push("@ts-drp/node/creator-seal export");
		const vite = readFileSync(resolve(REPOSITORY_ROOT, "vite.config.mts"), "utf8");
		for (const subpath of ["@ts-drp/network/seal", "@ts-drp/node/creator-seal"]) {
			if (!vite.includes(`"${subpath}"`)) missing.push(`${subpath} Vite alias`);
		}
		const browserEvidence = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-browser/src/seal-evidence.ts"),
			"utf8"
		);
		for (const method of ["persistPeerEvidence", "restorePeerEvidence", "servePeerEvidence"]) {
			if (!browserEvidence.includes(method)) missing.push(`browser evidence ${method}`);
		}
	}
	return Object.freeze({ missing: Object.freeze([...missing]), ready: missing.length === 0 });
}

/**
 * Returns the exact sorted enumerable runtime keys of one module.
 * @param value - Candidate runtime module.
 * @returns Frozen sorted key roster.
 */
export function exactKeys(value: object): readonly string[] {
	return Object.freeze(Object.keys(value).sort());
}
