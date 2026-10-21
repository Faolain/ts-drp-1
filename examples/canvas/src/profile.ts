/**
 * The trust profile the shipped Canvas signs into every new room's genesis, and the
 * latched-ACL version that profile requires. Tests import this so they follow the shipped
 * choice.
 *
 * `creator-trusted-settlement-v1` settles each Writer's issuance, so the room's existing
 * retirement drains old issued rows and a room's issuance stays bounded as it ages. The
 * legacy `creator-trusted-v1` profile has no settlement and keeps every row a Writer ever
 * issued. The protocol accepts the settlement profile only with a version-3 latched ACL.
 * Rooms keep the profile their genesis signed; this choice applies to new rooms only.
 */
export const CANVAS_GENESIS_PROFILE = Object.freeze({
	profileId: "creator-trusted-settlement-v1",
	latchedAclVersion: 3,
} as const);
