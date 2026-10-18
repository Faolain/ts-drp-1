import { publishUnrelatedHead } from "./ahe-race.js";
import { validateBootstrap } from "./bootstrap.js";
import { freshEffects, observe, trace } from "./observer.js";
import { observedSnapshot } from "./snapshot-observation.js";
import {
	type NativeMutations,
	type OwnerCase,
	ownerCases,
	type RecoveryCase,
	type RecoveryOwners,
	type RecoveryReport,
	type RestartBootstrap,
} from "./types.js";
import { recoverPendingCreatorSuccessorAdoption } from "../../../packages/node/dist/src/creator-adoption-recover.js";
import {
	type AheDurableStore,
	parseStorageObjectId,
	type PresentHead,
} from "../../../packages/storage/dist/src/index.js";
import { application, unhex } from "../cold-discovery/application.js";
import { observeNativeReads } from "../cold-discovery/read-observer.js";
/**
 * Run the named pending-only fixture seam.
 * @param bootstrap - Explicit fixture-owned input for this isolated control.
 * @param mode - Explicit fixture-owned input for this isolated control.
 * @param owners - Explicit fixture-owned input for this isolated control.
 * @param mutations - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function recoveryInput(
	bootstrap: RestartBootstrap,
	mode: RecoveryCase,
	owners: RecoveryOwners,
	mutations: NativeMutations
): Promise<{ input: Record<string, unknown>; effects: RecoveryReport["effects"] }> {
	validateBootstrap(bootstrap);
	const app = application();
	if (app.catalog.catalogDigest !== bootstrap.catalogDigest) throw new Error("PENDING_CATALOG_IDENTITY");
	const effects = freshEffects(),
		ownerMode = (ownerCases as readonly string[]).includes(mode) ? (mode as OwnerCase) : "verified";
	effects.mutations += await mutations.before(ownerMode, bootstrap);
	const previous = { ...bootstrap.expectedPreviousRoomHead },
		next = { ...bootstrap.expectedNextRoomHead };
	const snapshotStore = observedSnapshot(
		owners.snapshot,
		effects,
		["mixed-unavailable", "divergent-mixed-unavailable"].includes(mode) ? mode : ownerMode,
		mutations
	);
	let initialRead = true;
	let rereadCandidate: string | null = null;
	const store = new Proxy({} as AheDurableStore, {
		get(_target, key): unknown {
			const target = owners.ahe;
			if (key === "readHead")
				return async (...args: Parameters<AheDurableStore["readHead"]>) => {
					trace({ site: "read-head" });
					if (mode === "unexpected-read") throw new Error("INTENTIONAL_READ_THROW");
					if (mode === "storage-failed") return { ok: false, reason: "storage-failed" };
					const result = await target.readHead(...args);
					if (initialRead && mode === "mutate-heads") {
						initialRead = false;
						await Promise.resolve();
						Object.assign(previous, {
							objectId: "creator:" + "f".repeat(32),
							epoch: 88,
							currentAnchorDigest: "f".repeat(64),
						});
						Object.assign(next, {
							objectId: "creator:" + "e".repeat(32),
							epoch: 89,
							currentAnchorDigest: "e".repeat(64),
						});
						trace({ site: "heads-mutated-after-await" });
					}
					return result;
				};
			if (key === "readGenerationPage")
				return async (...args: Parameters<AheDurableStore["readGenerationPage"]>) => {
					trace({ site: "lineage" });
					if (mode === "lineage-failed") return { ok: false, reason: "storage-failed" };
					const result = await target.readGenerationPage(...args);
					if (mode === "duplicate-id" && result.ok)
						return {
							...result,
							value: { ...result.value, generations: [...result.value.generations, result.value.generations[0]] },
						};

					return result;
				};
			if (key === "swapHead")
				return async (...args: Parameters<AheDurableStore["swapHead"]>) => {
					effects.swaps.push(args[0].generationId);
					rereadCandidate = args[0].generationId;
					trace({ site: "cas" }, rereadCandidate);
					if (mode === "failed-cas") {
						trace({ site: "failed-cas-applied", ok: true }, rereadCandidate);
						return { ok: false, reason: "storage-failed" };
					}
					const result = await target.swapHead(...args);
					if (mode === "reread-unrelated" && result.ok) {
						await publishUnrelatedHead(target, result.value.head);
						effects.mutations++;
						trace({ site: "unrelated-head-race", ok: true }, rereadCandidate);
					}
					if (mode === "lost-cas") {
						trace({ site: "lost-cas-response-applied", ok: result.ok }, rereadCandidate);
						throw new Error("INTENTIONAL_LOST_CAS_RESPONSE");
					}
					return result;
				};
			if (key === "recoverActiveGeneration")
				return async (...args: Parameters<AheDurableStore["recoverActiveGeneration"]>) => {
					effects.rereads++;
					trace({ site: "active-reread" }, rereadCandidate);
					if (mode === "reread-failed") {
						trace({ site: "reread-failure-applied", ok: true }, rereadCandidate);
						return { ok: false, reason: "storage-failed" };
					}
					return target.recoverActiveGeneration(...args);
				};
			return Reflect.get(target, key, target);
		},
	});
	const input: Record<string, unknown> = {
		authenticationProfile: "creator-only",
		catalog: app.catalog,
		detachedSignature: unhex(bootstrap.detachedSignature),
		exactCanonicalAnchorPreimageBytes: unhex(bootstrap.exactCanonicalAnchorPreimageBytes),
		exactCanonicalParametersCarrierBytes: unhex(bootstrap.exactCanonicalParametersCarrierBytes),
		expectedPreviousRoomHead: previous,
		expectedNextRoomHead: next,
		pinnedGenesisAnchorDigest: bootstrap.pinnedGenesisAnchorDigest,
		snapshotStore,
		store,
	};
	if (mode === "retained-key") input.snapshotDeclaration = { obsolete: true };
	if (mode === "retained-undefined") input.snapshotDeclaration = undefined;
	if (mode === "missing-key") delete input.expectedPreviousRoomHead;
	if (mode === "extra-key") input.extra = true;
	if (mode === "accessor") Object.defineProperty(input, "catalog", { enumerable: true, get: () => app.catalog });
	if (mode === "symbol") input[Symbol("unexpected") as unknown as string] = true;
	if (mode === "non-plain") Object.setPrototypeOf(input, null);
	if (mode === "invalid-previous") input.expectedPreviousRoomHead = { ...previous, epoch: -1 };
	if (mode === "invalid-next") input.expectedNextRoomHead = { ...next, epoch: -1 };
	if (mode === "invalid-object") input.expectedPreviousRoomHead = { ...previous, objectId: "invalid" };
	if (mode === "wrong-previous") input.expectedPreviousRoomHead = { ...previous, currentAnchorDigest: "f".repeat(64) };
	if (mode === "wrong-next") input.expectedNextRoomHead = { ...next, currentAnchorDigest: "f".repeat(64) };
	if (mode === "wrong-profile") input.authenticationProfile = "byzantine";
	if (mode === "nonconsecutive") input.expectedNextRoomHead = { ...next, epoch: next.epoch + 1 };
	if (mode === "catalog-rejected")
		input.catalog = {
			...app.catalog,
			resolve: (): never => {
				throw new Error("INTENTIONAL_CATALOG_REJECT");
			},
		};
	if (mode === "parameters-rejected") input.exactCanonicalParametersCarrierBytes = new Uint8Array([1]);
	return { input, effects };
}
/**
 * Run the named pending-only fixture seam.
 * @param bootstrap - Explicit fixture-owned input for this isolated control.
 * @param mode - Explicit fixture-owned input for this isolated control.
 * @param owners - Explicit fixture-owned input for this isolated control.
 * @param prepared - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function executeRecovery(
	bootstrap: RestartBootstrap,
	mode: RecoveryCase,
	owners: RecoveryOwners,
	prepared: Awaited<ReturnType<typeof recoveryInput>>
): Promise<RecoveryReport> {
	const parsed = parseStorageObjectId(bootstrap.expectedPreviousRoomHead.objectId);
	if (!parsed.ok) throw new Error("RESTART_OBJECT");
	const before = await owners.ahe.readHead(parsed.value);
	const durableBefore = before.ok && before.value.kind === "present" ? before.value : null;
	const result = await observe(prepared.effects, () =>
		observeNativeReads(
			() => {
				prepared.effects.reads++;
				trace({ site: "native-read" });
			},
			() => recoverPendingCreatorSuccessorAdoption(prepared.input)
		)
	);
	const after = await owners.ahe.readHead(parsed.value);
	const durableAfter = after.ok && after.value.kind === "present" ? after.value : null;
	const malformedControls = [
		"retained-key",
		"retained-undefined",
		"missing-key",
		"extra-key",
		"accessor",
		"symbol",
		"non-plain",
	];
	const masked =
		result.ok === false &&
		result.kind === "malformed-input" &&
		prepared.effects.traces.length === 0 &&
		!malformedControls.includes(mode);
	return {
		mode,
		result,
		effects: prepared.effects,
		durableBefore: durableBefore as PresentHead | null,
		durableAfter: durableAfter as PresentHead | null,
		classification: masked ? "MASKED_BY_ENVELOPE_REJECTION" : "REACHED",
	};
}
/**
 * Run the named pending-only fixture seam.
 * @param bootstrap - Explicit fixture-owned input for this isolated control.
 * @param mode - Explicit fixture-owned input for this isolated control.
 * @param owners - Explicit fixture-owned input for this isolated control.
 * @param mutations - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function recover(
	bootstrap: RestartBootstrap,
	mode: RecoveryCase,
	owners: RecoveryOwners,
	mutations: NativeMutations
): Promise<RecoveryReport> {
	return executeRecovery(bootstrap, mode, owners, await recoveryInput(bootstrap, mode, owners, mutations));
}
