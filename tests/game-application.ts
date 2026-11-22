import { openTrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import type { V3OperationAdmissionPolicyFactory } from "@ts-drp/node/v3-live";
import type { V3RoomApplication, V3RoomProjectionAuthority, V3RoomProjectionInput } from "@ts-drp/node/v3-room";
import { prepareBlueprintAdmission, prepareBlueprintRuntime } from "@ts-drp/protocol-v3";
import { applyPreparedBlueprintOperation } from "@ts-drp/protocol-v3/blueprint-application";

export type GameKind = "fps" | "chess";
export interface GameProjection extends V3RoomProjectionAuthority {
	readonly game: Readonly<Record<string, unknown>>;
}
const STATE_LIMITS = Object.freeze({ maxBytes: 65536, maxDepth: 8, maxItems: 4096 });
const OPERATION_LIMITS = Object.freeze({ maxBytes: 256, maxDepth: 4, maxItems: 48 });
export function initialGameState(kind: GameKind, controller: string): Readonly<Record<string, unknown>> {
	if (!/^[0-9a-f]{64}$/u.test(controller)) throw new TypeError("game controller must be the enrolled owned author");
	return kind === "fps" ? {
		version: 1, kind, controller, step: 0, status: "playing",
		player: { x: 1, y: 2, heading: 0, health: 3, ammo: 3 }, bot: { x: 6, y: 2, health: 2 }, history: [],
	} : {
		version: 1, kind, controller, board: "RNBQKBNRPPPPPPPP................................pppppppprnbqkbnr",
		turn: 1, ply: 0, status: "playing", winner: 0, history: [],
	};
}

/** The compiler-produced runtime owns BOTH live projection and pre-effect
 * admission. This adapter introduces no parallel game reducer, signing
 * authority, portable permission or cleanup decision owner. */
export async function createNativeGameApplication(input: Readonly<{ kind: GameKind; catalogDirectory: string; controller: string }>) {
	const catalog = openTrustedBlueprintCatalog({ catalogDirectory: input.catalogDirectory });
	if (catalog.blueprintDigests.length !== 1) throw new TypeError("game needs its exact single-entry compiler catalog");
	const blueprintDigest = catalog.blueprintDigests[0]!;
	const resolved = catalog.resolve(blueprintDigest);
	const artifactId = input.kind === "fps" ? "r11-native-fps-arena.v1" : "r11-native-short-chess.v1";
	if (resolved.artifactId !== artifactId) throw new TypeError("game catalog artifact differs");
	const preparedBlueprintAdmission = prepareBlueprintAdmission({ canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes, expectedBlueprintDigest: blueprintDigest });
	const preparedBlueprintRuntime = await prepareBlueprintRuntime({ preparedBlueprintAdmission,
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes, expectedBlueprintDigest: blueprintDigest,
		exactArtifactBytes: resolved.exactArtifactBytes });
	const apply = (state: unknown, operation: Readonly<Record<string, unknown>>, author: string): Readonly<Record<string, unknown>> => {
		const result = applyPreparedBlueprintOperation({ expectedBlueprintDigest: blueprintDigest, preparedBlueprintRuntime,
			state, operation, executionContext: { author } });
		const canonical = encodeCanonical(result.state, STATE_LIMITS);
		return decodeCanonical(canonical, STATE_LIMITS) as Readonly<Record<string, unknown>>;
	};
	const genesis = apply(initialGameState(input.kind, input.controller), { action: "causalJoin" }, input.controller);
	const exactCanonicalGenesisStateBytes = encodeCanonical(genesis, STATE_LIMITS);
	const restore = (bytes: Uint8Array): Readonly<Record<string, unknown>> => {
		const decoded = decodeCanonical(bytes, STATE_LIMITS) as Readonly<Record<string, unknown>>;
		const valid = apply(decoded, { action: "causalJoin" }, input.controller);
		if (valid.kind !== input.kind || valid.controller !== input.controller ||
			!Buffer.from(encodeCanonical(valid, STATE_LIMITS)).equals(Buffer.from(bytes))) throw new TypeError("game authenticated snapshot differs");
		return valid;
	};
	const createOperationAdmissionPolicy: V3OperationAdmissionPolicyFactory = (context) => {
		let current = restore(context.authenticatedApplicationStateBytes ?? context.authenticatedClosedApplicationStateBytes ?? exactCanonicalGenesisStateBytes);
		const closedTranscriptValidation = context.authenticatedClosedApplicationStateBytes !== undefined && context.authenticatedApplicationStateBytes === undefined;
		return Object.freeze({ reserve(operation: Readonly<Record<string, unknown>>, authorContext?: Readonly<{ author: string }>) {
			let next: Readonly<Record<string, unknown>>;
			try {
				encodeCanonical(operation, OPERATION_LIMITS);
				if (authorContext?.author !== input.controller) return Object.freeze({ kind: "rejected" as const });
				// The native owner supplies authenticated closed/base bytes when
				// validating a predecessor transcript. Exact carried history is
				// membership evidence ONLY: duplicate never creates a new commit or
				// turns an ended game's operation into fresh authority. At most 128
				// commands survive a short game; all are included in snapshot/proof
				// bytes and removed only by the original lawful terminal planner.
				const exact = encodeCanonical(operation, OPERATION_LIMITS);
				const history = current.history as readonly Readonly<Record<string, unknown>>[];
				const identity = input.kind === "fps" ? operation.step : operation.ply;
				const old = history.find(row => (input.kind === "fps" ? row.step : row.ply) === identity);
				if (old !== undefined) {
					if (!Buffer.from(exact).equals(Buffer.from(encodeCanonical(old, OPERATION_LIMITS)))) return Object.freeze({ kind: "conflict" as const });
					// Existing native recovery supplies this closed-postimage context
					// solely to validate its authenticated predecessor transcript.
					// It needs a no-change reservation, not ordinary issue authority.
					if (closedTranscriptValidation) return Object.freeze({ kind: "fresh" as const, commit: (): "committed" => "committed", release: (): void => undefined });
					return Object.freeze({ kind: "duplicate" as const });
				}
				next = apply(current, operation, authorContext.author);
			} catch { return Object.freeze({ kind: "rejected" as const, reason: "encoding" as const }); }
			const before = current; let released = false, committed = false;
			return Object.freeze({ kind: "fresh" as const,
				commit: (): "committed" => {
					if (released || (!committed && current !== before)) throw new TypeError("game admission currency changed");
					if (!committed) { current = next; committed = true; }
					return "committed";
				}, release: (): void => { released = true; },
			});
		} });
	};
	const gameActions = input.kind === "fps" ? ["fpsMove", "fpsShot"] : ["chessMove"];
	const application: V3RoomApplication<GameProjection> = Object.freeze({
		catalog, canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes,
		snapshotReadPolicy: "authenticated-public" as const,
		bootstrapOperation: Object.freeze({ action: "causalJoin" }),
		// Existing room contract uses this exact action list for both settlement
		// and batching eligibility. This workload issues individual commands.
		batchableOperationActions: Object.freeze(gameActions),
		displacementPolicies: Object.freeze(Object.fromEntries(gameActions.map(action => [action, "rebase" as const]))),
		displacedOperationIdentity: (operation: Readonly<Record<string, unknown>>): string => `${input.kind}:${String(operation.step ?? operation.ply)}`,
		createGenesisApplicationStateBytes: (context: Readonly<{ objectId: string; exactCanonicalLatchedAclBytes: Uint8Array }>): Uint8Array => {
			const acl = decodeCanonical(context.exactCanonicalLatchedAclBytes) as Readonly<Record<string, unknown>>;
			const members = acl.members as readonly Readonly<Record<string, unknown>>[];
			if (acl.objectId !== context.objectId || !members.some(member => member.author === input.controller &&
				Array.isArray(member.groups) && member.groups.includes("writer"))) throw new TypeError("game controller is not authenticated in genesis ACL");
			return Uint8Array.from(exactCanonicalGenesisStateBytes);
		},
		projectAcceptedOperations: (projection: V3RoomProjectionInput): GameProjection => {
			let current = projection.authenticatedBase === undefined ? genesis : restore(projection.authenticatedBase.exactCanonicalApplicationStateBytes);
			for (const row of projection.currentEpochOperations) current = apply(current, row.operation, row.author);
			return Object.freeze({ game: current, transportPeerAuthors: Object.freeze([]), writerAuthors: Object.freeze([]) });
		},
		migration: Object.freeze({
			canonicalStateBytes: (projection: GameProjection): Uint8Array => encodeCanonical(projection.game, STATE_LIMITS),
			prepare: (): never => { throw new TypeError("R11 short-game workload does not claim cross-object migration"); },
		}),
	});
	return { application, blueprintDigest, createOperationAdmissionPolicy, exactCanonicalGenesisStateBytes, apply };
}
