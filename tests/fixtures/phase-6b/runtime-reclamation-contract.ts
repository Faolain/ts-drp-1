import { decodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit } from "@ts-drp/issuance-store";
import type {
	DurableIssuancePruningMaintenance,
	DurableIssuancePruningReceipt,
} from "@ts-drp/issuance-store/maintenance";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { type AheDurableStore, type PresentHead } from "@ts-drp/storage";
import type { AheReclamationMaintenance, AheReclamationReceipt } from "@ts-drp/storage/maintenance";
import type { Message } from "@ts-drp/types";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ClosedEpochCleanupPlan } from "../../../packages/node/src/internal/closed-epoch-cleanup.js";
import { fakeNetwork } from "../phase-4b-v3/live-snapshot.js";
import {
	bytesForRef,
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
	"packages/node/src/creator-adoption.ts",
	"packages/node/src/internal/creator-successor-live.ts",
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
	readonly committedHead: PresentHead;
	readonly oracle: D108d1Oracle;
	readonly predecessor: object;
	readonly successor: Readonly<{
		deactivate(): void | Promise<void>;
		issueLocal(input: unknown): Promise<Readonly<Record<string, unknown>>>;
		publishPending(): Promise<Readonly<Record<string, unknown>>>;
		readRebaseOutbox(): Promise<Readonly<Record<string, unknown>>>;
		readonly topic: string;
	}>;
	close(): Promise<void>;
}

export interface D109dReceiptFixture {
	readonly aheReceipt: AheReclamationReceipt;
	readonly aheReplayReceipt: AheReclamationReceipt;
	readonly issuancePartialReceipt: DurableIssuancePruningReceipt;
	readonly issuanceReceipt: DurableIssuancePruningReceipt;
	readonly issuanceReplayReceipt: DurableIssuancePruningReceipt;
}

/**
 * Opens the inherited genuine close -> verify -> commit -> hot-activate path.
 * The future receipt builder consumes D.109b/D.109c maintenance owners without
 * changing this product path or synthesizing successful receipts.
 * @param mode - Same-transport hot handoff or independent-transport cold activation.
 * @returns Genuine predecessor and current successor handles plus trusted oracle.
 */
async function openD109dFixture(mode: "cold" | "hot"): Promise<D109dHotFixture> {
	const base = await openGenuineCreatorAdoptionFixture();
	let successor: D109dHotFixture["successor"] | undefined;
	try {
		const prepared = await commitD108d1aFixture(base);
		const runtimeBindings =
			mode === "hot"
				? base.runtimeBindings
				: Object.freeze({
						messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
						networkNode: fakeNetwork(`d109d-cold-${crypto.randomUUID()}`),
						onAdmittedVertex: () => undefined,
					});
		const activationModule = (await import(
			pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-activate.ts")).href
		)) as {
			activateCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>>;
		};
		const activated = await activationModule.activateCreatorSuccessorAdoption({
			capability: prepared.capability,
			handle: base.handle,
			...runtimeBindings,
		});
		if (activated.ok !== true || activated.handle === null || typeof activated.handle !== "object") {
			throw new TypeError(`D109D_HOT_ACTIVATION_FAILED:${String(activated.kind)}`);
		}
		successor = activated.handle as D109dHotFixture["successor"];
		return Object.freeze({
			base,
			committedHead: prepared.head as PresentHead,
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
 * Opens the genuine same-transport handoff with a reachable retired registration.
 * @returns Genuine hot successor fixture.
 */
export function openD109dHotFixture(): Promise<D109dHotFixture> {
	return openD109dFixture("hot");
}

/**
 * Opens genuine successor material on a separate transport without a retired registration.
 * @returns Genuine cold successor fixture.
 */
export function openD109dColdFixture(): Promise<D109dHotFixture> {
	return openD109dFixture("cold");
}

function copiedCommit(commit: DurableIssueCommit): DurableIssueCommit {
	const envelope = Object.freeze({
		canonicalPreimageBytes: Uint8Array.from(commit.envelope.canonicalPreimageBytes),
		digest: Uint8Array.from(commit.envelope.digest),
		signature: Uint8Array.from(commit.envelope.signature),
	});
	const scope = Object.freeze({ ...commit.issuedRecord.scope });
	return Object.freeze({
		authorSequence: commit.authorSequence,
		envelope,
		issuedRecord: Object.freeze({ authorSequence: commit.authorSequence, envelope, scope }),
		outboxEntry: Object.freeze({ authorSequence: commit.authorSequence, envelope, scope }),
	});
}

async function d109dIssuanceReceipt(
	fixture: D109dHotFixture,
	commits: readonly DurableIssueCommit[],
	throughAuthorSequence: number,
	label: string
): Promise<
	Readonly<{ readonly first: DurableIssuancePruningReceipt; readonly replay: DurableIssuancePruningReceipt }>
> {
	const directory = mkdtempSync(join(tmpdir(), `d109d-${label}-`));
	const issuanceModule = (await import(
		pathToFileURL(resolve(REPOSITORY_ROOT, "packages/storage-node/src/issuance.ts")).href
	)) as {
		createNodeDurableIssuanceStore(options: { readonly primaryFilename: string }): DurableIssuanceStore;
	};
	const maintenanceModule = (await import(
		pathToFileURL(resolve(REPOSITORY_ROOT, "packages/storage-node/src/issuance-maintenance.ts")).href
	)) as {
		resolveNodeDurableIssuancePruningMaintenance(
			store: DurableIssuanceStore
		): DurableIssuancePruningMaintenance | undefined;
	};
	const store = issuanceModule.createNodeDurableIssuanceStore({ primaryFilename: join(directory, "issuance.sqlite") });
	try {
		for (const source of commits) {
			const committed = await store.transactIssue(source.issuedRecord.scope, (authorSequence) => {
				if (authorSequence !== source.authorSequence) throw new TypeError("D109D_ISSUANCE_COPY_SEQUENCE_MISMATCH");
				return Promise.resolve(copiedCommit(source));
			});
			await store.compareAndMarkOutboxPublished({
				authorSequence: committed.authorSequence,
				digest: Uint8Array.from(committed.envelope.digest),
				scope: committed.issuedRecord.scope,
			});
		}
		const maintenance = maintenanceModule.resolveNodeDurableIssuancePruningMaintenance(store);
		if (maintenance === undefined) throw new TypeError("D109D_NODE_ISSUANCE_MAINTENANCE_MISSING");
		const state = await maintenance.inspectPruningState(fixture.base.evidence.issuanceScope);
		const input = d109dIssuancePruningInput(fixture, state, throughAuthorSequence);
		const first = await maintenance.prunePublishedPrefix(input);
		const replay = await maintenance.prunePublishedPrefix(input);
		return Object.freeze({ first, replay });
	} finally {
		await store.close();
		rmSync(directory, { force: true, recursive: true });
	}
}

function d109dIssuancePruningInput(
	fixture: D109dHotFixture,
	state: Awaited<ReturnType<DurableIssuancePruningMaintenance["inspectPruningState"]>>,
	throughAuthorSequence: number
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		closedEpoch: fixture.base.evidence.closeResult.epoch,
		commitQcRef: fixture.base.evidence.closeResult.commitQcRef,
		expectedLineage: state.lineage,
		expectedPrunedThroughAuthorSequence: state.prunedThroughAuthorSequence,
		scope: state.scope,
		snapshotManifestDigest: fixture.base.evidence.declaration.scope.manifestDigest,
		throughAuthorSequence,
	});
}

async function d109dAheReceipts(
	fixture: D109dHotFixture,
	plan: ClosedEpochCleanupPlan
): Promise<Readonly<{ readonly first: AheReclamationReceipt; readonly replay: AheReclamationReceipt }>> {
	const maintenanceModule = (await import(
		pathToFileURL(resolve(REPOSITORY_ROOT, "packages/storage-node/dist/src/maintenance.js")).href
	)) as {
		resolveNodeAheReclamationMaintenance(store: AheDurableStore): AheReclamationMaintenance | undefined;
	};
	const maintenance = maintenanceModule.resolveNodeAheReclamationMaintenance(fixture.base.evidence.aheBackend);
	if (maintenance === undefined) throw new TypeError("D109D_NODE_AHE_MAINTENANCE_MISSING");
	const input = Object.freeze({
		activeGenerationId: plan.activeGenerationId,
		availabilityPolicyDigest: plan.availabilityPolicyDigest,
		closedEpoch: plan.closedEpoch,
		expectedHead: plan.expectedHead,
		lineageFloor: plan.lineageFloor,
		objectId: plan.objectId,
		rollbackGenerationIds: plan.rollbackGenerationIds,
	});
	try {
		const first = await maintenance.reclaimClosedEpoch(input);
		const replay = await maintenance.reclaimClosedEpoch(input);
		return Object.freeze({ first, replay });
	} catch (error) {
		const code = error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
		const message = error instanceof Error ? error.message : String(error);
		throw new TypeError(`D109D_AHE_RECLAMATION_FAILED:${String(code)}:${message}`);
	}
}

/**
 * Produces owner-issued D.109b and D.109c receipts for the exact genuine
 * successor registration.
 * @param fixture - Genuine committed and activated hot successor.
 * @returns First-call, replay, and genuine partial-prefix receipt evidence.
 */
export async function createD109dReceipts(fixture: D109dHotFixture): Promise<D109dReceiptFixture> {
	const sourceOutbox = await fixture.base.evidence.issuanceStore.readOutboxPage({
		scope: fixture.base.evidence.issuanceScope,
	});
	for (const { commit } of sourceOutbox) {
		await fixture.base.evidence.issuanceStore.compareAndMarkOutboxPublished({
			authorSequence: commit.authorSequence,
			digest: Uint8Array.from(commit.envelope.digest),
			scope: fixture.base.evidence.issuanceScope,
		});
	}
	const published = await fixture.base.evidence.issuanceStore.readOutboxPage({
		scope: fixture.base.evidence.issuanceScope,
	});
	if (!published.every(({ publishState }) => publishState === "published")) {
		throw new TypeError("D109D_GENUINE_OUTBOX_NOT_PUBLISHED");
	}
	const commits = Object.freeze(published.map(({ commit }) => copiedCommit(commit)));
	const boundary = fixture.base.evidence.localIssued.authorSequence;
	if (boundary < 1 || commits.at(-1)?.authorSequence !== boundary) {
		throw new TypeError("D109D_GENUINE_DISPLACED_BOUNDARY_INVALID");
	}
	const partial = await d109dIssuanceReceipt(fixture, commits, boundary - 1, "partial");
	const genuineMaintenance = fixture.base.evidence.issuanceMaintenance;
	const genuineState = await genuineMaintenance.inspectPruningState(fixture.base.evidence.issuanceScope);
	const genuineInput = d109dIssuancePruningInput(fixture, genuineState, boundary);
	const issuance = Object.freeze({
		first: await genuineMaintenance.prunePublishedPrefix(genuineInput),
		replay: await genuineMaintenance.prunePublishedPrefix(genuineInput),
	});

	const inspection = await fixture.base.handle.inspectDurableHead();
	if (inspection.head.generationId !== fixture.committedHead.generationId) {
		throw new TypeError("D109D_GENUINE_HEAD_CHANGED");
	}
	const generations = Object.freeze([
		...fixture.base.evidence.generations.map((record) =>
			Object.freeze({
				...record,
				state:
					record.generationId === fixture.base.evidence.proposed.head.generationId
						? ("Superseded" as const)
						: record.state,
			})
		),
		Object.freeze({
			baseExpectedHead: fixture.base.evidence.proposed.head,
			closure: Object.freeze(inspection.references.map((reference) => Object.freeze({ ...reference }))),
			closureDigest: inspection.head.closureDigest,
			generationId: inspection.head.generationId,
			objectId: inspection.head.objectId,
			state: "Adopted" as const,
		}),
	]);
	const cut = decodeCanonical(
		bytesForRef(fixture.base.evidence.proposed, fixture.base.evidence.closeResult.cutValueRef)
	) as Readonly<Record<string, unknown>>;
	const planner = (await import(
		pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/internal/closed-epoch-cleanup.ts")).href
	)) as {
		planClosedEpochCleanup(
			input: unknown
		): Readonly<
			{ readonly ok: false; readonly reason: string } | { readonly ok: true; readonly plan: ClosedEpochCleanupPlan }
		>;
	};
	const planned = planner.planClosedEpochCleanup({
		adoption: Object.freeze({ activeHead: fixture.committedHead, adopted: true }),
		availabilityPolicyDigest: String(cut.availabilityPolicyDigest),
		close: Object.freeze({
			closedEpoch: fixture.base.evidence.closeResult.epoch,
			commitQcRef: fixture.base.evidence.closeResult.commitQcRef,
			objectId: fixture.committedHead.objectId,
			verified: true,
		}),
		expectedHead: fixture.committedHead,
		generations,
		issuance: Object.freeze({
			complete: true,
			lineage: issuance.first.observedLineage,
			prunedThroughAuthorSequence: null,
			rows: Object.freeze(
				published.map(({ commit, publishState }) =>
					Object.freeze({
						authorSequence: commit.authorSequence,
						epoch: fixture.base.evidence.closeResult.epoch,
						issued: true,
						outbox: true,
						publishState,
					})
				)
			),
			scope: fixture.base.evidence.issuanceScope,
			throughAuthorSequence: boundary,
		}),
		snapshot: Object.freeze({
			adopted: true,
			manifestDigest: fixture.base.evidence.declaration.scope.manifestDigest,
		}),
	});
	if (!planned.ok) throw new TypeError(`D109D_GENUINE_CLEANUP_PLAN_REFUSED:${planned.reason}`);
	const ahe = await d109dAheReceipts(fixture, planned.plan);
	return Object.freeze({
		aheReceipt: ahe.first,
		aheReplayReceipt: ahe.replay,
		issuancePartialReceipt: partial.first,
		issuanceReceipt: issuance.first,
		issuanceReplayReceipt: issuance.replay,
	});
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
