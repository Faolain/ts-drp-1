import type { V3RoomCreatorInviteMaterial, V3RoomHeadState } from "../../../examples/v3-room/src/index.js";

export type Scenario =
	| "genesis"
	| "stable-1"
	| "stable-2"
	| "pending-old-1"
	| "pending-new-1"
	| "pending-old-2"
	| "pending-new-2"
	| "lost-commit-1"
	| "failed-reread-1";
export type Fault =
	| "none"
	| "begin-unavailable"
	| "publication"
	| "commit-unavailable"
	| "commit-lost-response"
	| "reread-unavailable";
export type RecoveryFault =
	| "none"
	| "missing-metadata"
	| "poisoned"
	| "missing-chunk"
	| "corrupt-chunk"
	| "replace-after-lookup"
	| "floor-lost"
	| "floor-invalid"
	| "floor-unavailable"
	| "wrong-head"
	| "floor-ahead"
	| "historic-floor-ahead"
	| "genesis-over-successor";
export interface Bootstrap {
	readonly identity: string;
	readonly invite: V3RoomCreatorInviteMaterial;
	readonly objectId: string;
	readonly profile: "creator-trusted-v1" | "creator-trusted-settlement-v1";
}
export interface SetupReport {
	readonly bootstrap: Bootstrap;
	readonly expectedProjection: unknown;
	readonly floor: V3RoomHeadState;
	readonly genesis: V3RoomHeadState;
	readonly priorStable: V3RoomHeadState;
	readonly durableHead: unknown;
	readonly interrupted: string | null;
	readonly trace: readonly Record<string, unknown>[];
}
export interface Report {
	detail: string;
	projection?: unknown;
	afterIssue?: unknown;
	authority?: unknown;
	durableHead?: unknown;
	floor?: V3RoomHeadState | null;
	trace: Record<string, unknown>[];
	native?: unknown;
	downstream: string[];
}
