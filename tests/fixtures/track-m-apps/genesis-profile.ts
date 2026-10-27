import type { AppKind, LongRoomOptions } from "./long-room-driver.js";
import { CANVAS_GENESIS_PROFILE } from "../../../examples/canvas/src/profile.js";
import { CHAT_GENESIS_PROFILE } from "../../../examples/chat/src/profile.js";
import { GRID_GENESIS_PROFILE } from "../../../examples/grid/src/profile.js";

export type GenesisProfile = Readonly<{ profileId: string; latchedAclVersion: number }>;

/**
 * Each shipped application's own exported genesis profile (examples/<app>/src/profile.ts): the
 * long room signs exactly what the shipped page signs, so the two cannot drift apart.
 */
export const SHIPPED_GENESIS_PROFILES: Readonly<Record<AppKind, GenesisProfile>> = Object.freeze({
	canvas: CANVAS_GENESIS_PROFILE,
	chat: CHAT_GENESIS_PROFILE,
	grid: GRID_GENESIS_PROFILE,
});

/** The explicit opt-in override (`profile: "trusted-v1"`, ACTIVE_ENDURANCE_PROFILE=trusted-v1). */
export const TRUSTED_V1_OVERRIDE: GenesisProfile = Object.freeze({
	profileId: "creator-trusted-v1",
	latchedAclVersion: 1,
});

/**
 * The profile and latched-ACL version the long room's creator signs into genesis: the app's own
 * exported profile, unless the run opts in to the legacy `trusted-v1` override (Grid and Chat
 * only; the protocol requires a version-1 ACL for it and version 3 for the settlement profile).
 * @param options - The long-room options.
 * @returns The signed profile identifier and latched-ACL version.
 */
export function genesisProfileFor(options: Pick<LongRoomOptions, "app" | "profile">): GenesisProfile {
	if (options.profile === "trusted-v1") {
		if (options.app === "canvas") throw new TypeError("LONG_ROOM_PROFILE_OVERRIDE_GRID_OR_CHAT_ONLY");
		return TRUSTED_V1_OVERRIDE;
	}
	if (options.profile !== undefined && options.profile !== "settlement-v1")
		throw new TypeError(`LONG_ROOM_PROFILE_UNKNOWN:${String(options.profile)}`);
	return SHIPPED_GENESIS_PROFILES[options.app];
}
