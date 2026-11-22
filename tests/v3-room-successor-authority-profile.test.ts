import { expectTypeOf, it } from "vitest";

import { CANVAS_GENESIS_PROFILE } from "../examples/canvas/src/profile.js";
import { CHAT_GENESIS_PROFILE } from "../examples/chat/src/profile.js";
import { GRID_GENESIS_PROFILE } from "../examples/grid/src/profile.js";
import { V3_CHAT_GENESIS_PROFILE } from "../examples/v3-chat/src/profile.js";
import type { V3RoomSuccessorAuthority } from "../examples/v3-room/src/index.js";

// Type-only: a room's authority reports the profile its genesis signed, so the public type names
// every profile a room can sign (the legacy direct rooms' creator-trusted-v1 and the shipped
// apps' and the v3-chat demo's creator-trusted-settlement-v1). Checked by tsc, not at run time.
it("the successor authority type names every profile a room can sign", () => {
	expectTypeOf<V3RoomSuccessorAuthority["profileId"]>().toEqualTypeOf<
		"creator-trusted-v1" | "creator-trusted-settlement-v1"
	>();
	for (const profile of [CANVAS_GENESIS_PROFILE, CHAT_GENESIS_PROFILE, GRID_GENESIS_PROFILE, V3_CHAT_GENESIS_PROFILE])
		expectTypeOf(profile.profileId).toExtend<V3RoomSuccessorAuthority["profileId"]>();
});
