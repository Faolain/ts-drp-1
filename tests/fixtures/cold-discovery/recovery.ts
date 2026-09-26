import { application, sign, unhex } from "./application.js";
import { observeAuthentication } from "./auth-observer.js";
import { observeNativeReads } from "./read-observer.js";
import { runtime } from "./runtime.js";
import type {
	Effects,
	NativeMutations,
	NativeOwners,
	RecoveryCase,
	RecoveryReport,
	RestartBootstrap,
} from "./types.js";
import { decodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import { reopenCreatorSuccessorAdoption } from "../../../packages/node/dist/src/creator-adoption-activate.js";
import { bindV3BlueprintLivePlane, type V3PlaneHandle } from "../../../packages/node/dist/src/v3-live.js";
import type { SnapshotQuarantineDeclaration } from "../../../packages/storage/dist/src/snapshot-transfer.js";

const BOOTSTRAP_KEYS = [
	"identity",
	"author",
	"catalogDigest",
	"detachedSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"exactCanonicalPinnedGenesisBootstrapOperationBytes",
	"pinnedGenesisAnchorDigest",
	"expectedRoomHead",
].sort();

/**
 * A restart accepts trusted carriers only; no setup oracle or snapshot material.
 * @param value
 */
export function validateBootstrap(value: unknown): RestartBootstrap {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(BOOTSTRAP_KEYS)
	)
		throw new Error("RESTART_ENVELOPE_NOT_ALLOWLISTED");
	const head = Reflect.get(value, "expectedRoomHead");
	if (
		head === null ||
		typeof head !== "object" ||
		JSON.stringify(Object.keys(head).sort()) !== JSON.stringify(["currentAnchorDigest", "epoch", "objectId"])
	)
		throw new Error("RESTART_HEAD_NOT_ALLOWLISTED");
	for (const key of BOOTSTRAP_KEYS.filter((key) => key !== "expectedRoomHead"))
		if (typeof Reflect.get(value, key) !== "string") throw new Error("RESTART_CARRIER_TYPE");
	return value as RestartBootstrap;
}

/**
 * Observe real owners, then invoke only the production public cold function.
 * @param bootstrap
 * @param mode
 * @param owners
 * @param mutations
 */
export async function recover(
	bootstrap: RestartBootstrap,
	mode: RecoveryCase,
	owners: NativeOwners,
	mutations: NativeMutations
): Promise<RecoveryReport> {
	validateBootstrap(bootstrap);
	const app = application();
	if (app.catalog.catalogDigest !== bootstrap.catalogDigest) throw new Error("RESTART_CATALOG_IDENTITY");
	const effects: Effects = {
		lookupScopes: [],
		lookupStates: [],
		lookupRetentions: [],
		acquisitions: 0,
		reads: 0,
		completes: 0,
		recoverObjects: [],
		recoverResults: [],
		authEvents: [],
		signs: 0,
		subscriptions: 0,
		publications: 0,
		mutations: 0,
		events: [],
	};
	effects.mutations += await mutations.before(mode, bootstrap);
	if (mutations.authMutation !== undefined) effects.authMutation = mutations.authMutation;
	const callerFloor = { ...bootstrap.expectedRoomHead };
	const snapshotStore = new Proxy({} as NativeOwners["snapshot"], {
		get(_target, key): unknown {
			const target = owners.snapshot;
			if (key === "lookupRecoveryDeclaration") {
				if (mode === "narrow-store") {
					effects.events.push("required-capability-missing");
					return undefined;
				}
				return async (
					...args: Parameters<typeof target.lookupRecoveryDeclaration>
				): ReturnType<typeof target.lookupRecoveryDeclaration> => {
					effects.lookupScopes.push({ ...args[0] });
					effects.events.push("lookup");
					if (mode === "lookup-rejected") throw new Error("INTENTIONAL_LOOKUP_REJECTION");
					const found = await target.lookupRecoveryDeclaration(...args);
					if (found.kind === "present") {
						effects.lookupStates.push(found.state);
						effects.lookupRetentions.push(found.retention);
					}
					effects.mutations += await mutations.after(mode, args[0]);
					return found;
				};
			}
			if (key === "openScope")
				return async (declaration: SnapshotQuarantineDeclaration): ReturnType<typeof target.openScope> => {
					effects.acquisitions += 1;
					effects.events.push("acquire");
					const scope = await target.openScope(declaration);
					return new Proxy({} as typeof scope, {
						get(_opened, property): unknown {
							const opened = scope;
							if (property === "complete")
								return async (...args: Parameters<typeof opened.complete>): ReturnType<typeof opened.complete> => {
									effects.completes += 1;
									effects.events.push("complete");
									return opened.complete(...args);
								};
							return Reflect.get(opened, property, opened);
						},
					});
				};
			return Reflect.get(target, key, target);
		},
	});
	const store = new Proxy({} as NativeOwners["ahe"], {
		get(_target, key): unknown {
			const target = owners.ahe;
			if (key === "recoverActiveGeneration")
				return async (
					...args: Parameters<typeof target.recoverActiveGeneration>
				): ReturnType<typeof target.recoverActiveGeneration> => {
					effects.recoverObjects.push(args[0]);
					effects.events.push("recover-active");
					const recovered = await target.recoverActiveGeneration(...args);
					effects.recoverResults.push(
						recovered.ok ? { ok: true, kind: recovered.value.kind } : { ok: false, reason: recovered.reason }
					);
					if (mode === "mutate-floor") {
						await Promise.resolve();
						callerFloor.objectId = `creator:${"f".repeat(32)}`;
						callerFloor.epoch += 1;
						callerFloor.currentAnchorDigest = "f".repeat(64);
						effects.events.push("caller-floor-mutated-after-await");
					}
					return recovered;
				};
			return Reflect.get(target, key, target);
		},
	});
	const input: Record<string, unknown> = {
		authenticationProfile: "creator-only",
		author: bootstrap.author,
		catalog: app.catalog,
		detachedSignature: unhex(bootstrap.detachedSignature),
		exactCanonicalAnchorPreimageBytes: unhex(bootstrap.exactCanonicalAnchorPreimageBytes),
		exactCanonicalParametersCarrierBytes: unhex(bootstrap.exactCanonicalParametersCarrierBytes),
		exactCanonicalPinnedGenesisBootstrapOperationBytes: unhex(
			bootstrap.exactCanonicalPinnedGenesisBootstrapOperationBytes
		),
		expectedRoomHead: callerFloor,
		issuanceStore: owners.issuance,
		liveJournalStore: owners.journal,
		pinnedGenesisAnchorDigest: bootstrap.pinnedGenesisAnchorDigest,
		snapshotStore,
		store,
		signRegisteredVertexDigest: async (bytes: Uint8Array) => {
			effects.signs += 1;
			return sign(bytes);
		},
		...runtime(`recovery-${bootstrap.identity}`, effects),
	};
	if (mode === "old-key" || mode === "missing-floor-old-key") input.snapshotDeclaration = { obsolete: true };
	if (mode === "missing-floor" || mode === "missing-floor-old-key") delete input.expectedRoomHead;
	if (mode === "invalid-floor") input.expectedRoomHead = { ...callerFloor, epoch: -1 };
	if (mode === "invalid-object") input.expectedRoomHead = { ...callerFloor, objectId: "not-a-storage-object" };
	if (mode === "wrong-floor") input.expectedRoomHead = { ...callerFloor, currentAnchorDigest: "f".repeat(64) };
	return observeAuthentication(
		(event) => {
			effects.authEvents.push(event);
		},
		() =>
			observeNativeReads(
				() => {
					effects.reads += 1;
					effects.events.push("read");
				},
				async () => {
					const result = await reopenCreatorSuccessorAdoption(input);
					const masked =
						result.ok === false &&
						result.kind === "malformed-input" &&
						!["old-key", "missing-floor", "missing-floor-old-key"].includes(mode) &&
						effects.recoverObjects.length === 0;
					const report: RecoveryReport = {
						mode,
						result: { ok: result.ok === true, kind: result.kind, detail: result.detail },
						effects,
						classification: masked ? "MASKED_BY_ENVELOPE_REJECTION" : "REACHED",
					};
					if (result.ok !== true) return report;
					const plane = result.handle as V3PlaneHandle;
					try {
						const head = plane.currentEphemeralAuthority();
						if (head !== undefined)
							report.head = { currentAnchorDigest: head.anchorDigest, epoch: head.epoch, objectId: head.objectId };
						const projection = bindV3BlueprintLivePlane({ plane, purpose: "projection-base" });
						if (!projection.ok) throw new Error("RECOVERED_PROJECTION_UNAVAILABLE");
						report.state = decodeCanonical(projection.exactCanonicalApplicationStateBytes);
						const issued = await plane.issueLocal({
							operations: [{ logicalTime: 100, operation: { action: "add", value: 7 } }],
							signRegisteredVertexDigest: input.signRegisteredVertexDigest as Parameters<
								V3PlaneHandle["issueLocal"]
							>[0]["signRegisteredVertexDigest"],
						});
						report.issued = { ok: issued.ok, kind: issued.kind };
						const published = await plane.publishPending();
						report.published = { ok: published.ok, kind: published.kind };
						return report;
					} finally {
						plane.deactivate();
					}
				}
			)
	);
}
