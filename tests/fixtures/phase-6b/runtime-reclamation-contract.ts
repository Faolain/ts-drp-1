import { MessageQueueManager } from "@ts-drp/message-queue";
import type { Message } from "@ts-drp/types";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { fakeNetwork } from "../phase-4b-v3/live-snapshot.js";
import {
	type GenuineCreatorAdoptionFixture,
	openGenuineCreatorAdoptionFixture,
} from "../phase-6a-v3/creator-adoption-contract.js";
import { type D108d1Oracle, deriveD108d1Oracle } from "../phase-6a-v3/creator-successor-activation-contract.js";
import { commitD108d1aFixture } from "../phase-6a-v3/creator-successor-handle-identity-contract.js";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export const D109D_RED_PATHS = Object.freeze([
	"tests/fixtures/phase-6b/runtime-reclamation-contract.ts",
	"tests/phase-6b-runtime-reclamation-red.test.ts",
] as const);

export const D109D_GREEN_PATHS = Object.freeze([
	"packages/node/src/internal/runtime-reclamation.ts",
	"packages/node/src/v3-live.ts",
	"packages/node/src/creator-close.ts",
] as const);

export const D109D_INPUT_KEYS = Object.freeze(["aheReceipt", "issuanceReceipt", "successor"] as const);

export const D109D_ERROR_CODES = Object.freeze([
	"D109D_INVALID_ARGUMENT",
	"D109D_RECEIPT_MISMATCH",
	"D109D_IDENTITY_MISMATCH",
	"D109D_RUNTIME_NOT_READY",
	"D109D_INTERNAL_INVARIANT",
] as const);

export const D109D_SUCCESS_KEYS = Object.freeze([
	"after",
	"before",
	"closedEpoch",
	"objectId",
	"ok",
	"replay",
	"successorEpoch",
] as const);

export const D109D_RECEIPT_MUTANTS = Object.freeze([
	"missing-ahe-receipt",
	"missing-issuance-receipt",
	"extra-input-key",
	"accessor-input",
	"proxy-input",
	"issuance-extra-key",
	"ahe-extra-key",
	"shared-object",
	"shared-closed-epoch",
	"issuance-scope-author",
	"issuance-scope-object",
	"snapshot-manifest-digest",
	"commit-qc-digest",
	"commit-qc-byte-length",
	"commit-qc-duplicate",
	"ahe-head-object",
	"ahe-head-revision",
	"ahe-head-generation",
	"ahe-active-generation",
	"ahe-availability-policy",
	"ahe-rollback-first",
	"ahe-rollback-floor",
	"ahe-floor-generation",
	"ahe-floor-former-head",
	"ahe-floor-replacement-head",
	"issuance-partial-prefix",
	"issuance-boundary-above",
] as const);

export const D109D_IDENTITY_MUTANTS = Object.freeze([
	"structural-fake",
	"copied-handle",
	"proxy-handle",
	"predecessor-handle",
	"inactive-handle",
	"foreign-handle",
	"snapshot-closed-handle",
] as const);

export const D109D_REPLAY_AUTHORITY_MUTANTS = Object.freeze([
	"object-id",
	"closed-epoch",
	"successor-epoch",
	"issuance-scope",
	"issuance-boundary",
	"issuance-observed-lineage",
	"snapshot-manifest-digest",
	"commit-qc-ref",
	"ahe-adopted-head",
	"ahe-active-generation",
	"ahe-reclaimed-generation-ids",
	"ahe-rollback-identities",
	"ahe-floor-identities",
	"availability-policy",
] as const);

export const D109D_REPLAY_OUTCOME_FIELDS = Object.freeze([
	"issuanceReceipt.deletedAuthorSequenceRange",
	"aheReceipt.deletedBlobDigests",
	"aheReceipt.deletedGenerationIds",
	"aheReceipt.deletedPromotionCount",
	"aheReceipt.floor.normalizedThisCall",
] as const);

export const D109D_CENSUS_KEYS = Object.freeze([
	"applicationAuthors",
	"applicationCharges",
	"applicationVertices",
	"blueprintState",
	"causalityIndex",
	"creatorCloseDerivedCommitment",
	"creatorCloseDurableReplay",
	"creatorCloseGraph",
	"creatorClosePersistedSnapshot",
	"creatorCloseStagedSnapshot",
	"displacedRebaseCursor",
	"displacedSource",
	"epochBytes",
	"graphVersion",
	"hotPredecessor",
	"latchedOperations",
	"pendingIngress",
	"pendingIngressBytes",
	"publication",
	"quarantine",
	"rebase",
	"retainedPayloadMetadata",
] as const);

export const D109D_PRECEDENCE = Object.freeze([
	"shape",
	"receipt-internal",
	"identity",
	"registration-bound",
	"readiness",
	"internal",
] as const);

export type D109dErrorCode = (typeof D109D_ERROR_CODES)[number];

export interface D109dCandidateModule {
	reclaimInstalledV3Runtime?(input: unknown): Promise<Readonly<Record<string, unknown>>>;
}

export interface D109dHotFixture {
	readonly base: GenuineCreatorAdoptionFixture;
	readonly oracle: D108d1Oracle;
	readonly predecessor: object;
	readonly successor: Readonly<{
		deactivate(): void | Promise<void>;
		issueLocal(input: unknown): Promise<Readonly<Record<string, unknown>>>;
		publishPending(): Promise<Readonly<Record<string, unknown>>>;
		readonly topic: string;
	}>;
	close(): Promise<void>;
}

/**
 * Opens the inherited genuine close -> verify -> commit -> hot-activate path.
 * The future receipt builder consumes D.109b/D.109c maintenance owners without
 * changing this product path or synthesizing successful receipts.
 * @returns Genuine predecessor and current successor handles plus trusted oracle.
 */
export async function openD109dHotFixture(): Promise<D109dHotFixture> {
	const base = await openGenuineCreatorAdoptionFixture();
	let successor: D109dHotFixture["successor"] | undefined;
	try {
		const prepared = await commitD108d1aFixture(base);
		const activationModule = (await import(
			pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-activate.ts")).href
		)) as {
			activateCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>>;
		};
		const activated = await activationModule.activateCreatorSuccessorAdoption({
			capability: prepared.capability,
			handle: base.handle,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: fakeNetwork(`d109d-${crypto.randomUUID()}`),
			onAdmittedVertex: () => undefined,
		});
		if (activated.ok !== true || activated.handle === null || typeof activated.handle !== "object") {
			throw new TypeError(`D109D_HOT_ACTIVATION_FAILED:${String(activated.kind)}`);
		}
		successor = activated.handle as D109dHotFixture["successor"];
		return Object.freeze({
			base,
			close: async () => {
				await Promise.resolve(successor?.deactivate());
				await base.close();
			},
			oracle: deriveD108d1Oracle(base),
			predecessor: base.handle,
			successor,
		});
	} catch (error) {
		await Promise.resolve(successor?.deactivate());
		await base.close();
		throw error;
	}
}

/**
 * Returns the future internal owner when all three private seams exist.
 * @returns Dynamically imported package-internal candidate module.
 */
export async function d109dCandidate(): Promise<D109dCandidateModule> {
	return import(pathToFileURL(resolve(REPOSITORY_ROOT, D109D_GREEN_PATHS[0])).href) as Promise<D109dCandidateModule>;
}

/**
 * Reports the exact composite GREEN readiness seam.
 * @returns Frozen missing-fact roster and readiness decision.
 */
export function d109dReadiness(): Readonly<{ readonly missing: readonly string[]; readonly ready: boolean }> {
	const read = (relative: string): string => {
		const absolute = resolve(REPOSITORY_ROOT, relative);
		return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
	};
	const owner = read(D109D_GREEN_PATHS[0]);
	const live = read(D109D_GREEN_PATHS[1]);
	const close = read(D109D_GREEN_PATHS[2]);
	const facts = Object.freeze({
		creatorCloseRelease: /installCreatorCloseRuntimeRelease/u.test(close),
		internalOwner: /export\s+(?:async\s+)?function\s+reclaimInstalledV3Runtime\s*\(/u.test(owner),
		liveKernel: /installV3RuntimeReclamationKernel/u.test(live),
	});
	const missing = Object.entries(facts)
		.filter(([, value]) => !value)
		.map(([key]) => key);
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

/**
 * Enforces the internal-only scope and legacy-runtime exclusion.
 * @returns Frozen source-governance facts.
 */
export function d109dSourceGovernance(): Readonly<Record<string, boolean>> {
	const read = (relative: string): string => readFileSync(resolve(REPOSITORY_ROOT, relative), "utf8");
	const root = read("packages/node/src/index.ts");
	const manifest = read("packages/node/package.json");
	const live = read("packages/node/src/v3-live.ts");
	return Object.freeze({
		noLegacyObjectBinding: !/@ts-drp\/object/u.test(live),
		noManifestExport: !/runtime-reclamation/u.test(manifest),
		noProductHandleMethod: !/reclaimInstalledV3Runtime/u.test(
			live.match(/export interface V3PlaneHandle[\s\S]*?^\}/mu)?.[0] ?? ""
		),
		noRootExport: !/runtime-reclamation|reclaimInstalledV3Runtime/u.test(root),
	});
}

/**
 * Reads one stable error code without relying on an error class.
 * @param value - Candidate refusal value.
 * @returns Stable code when present.
 */
export function d109dErrorCode(value: unknown): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const code = Reflect.get(value, "code");
	return typeof code === "string" ? code : undefined;
}

/**
 * Recursive frozen-result oracle.
 * @param value - Candidate value.
 * @param seen - Previously visited objects.
 * @returns Whether every reachable object is frozen.
 */
export function d109dDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value !== "object") return true;
	if (seen.has(value)) return true;
	seen.add(value);
	if (!Object.isFrozen(value)) return false;
	for (const entry of Object.values(value)) if (!d109dDeepFrozen(entry, seen)) return false;
	return true;
}
