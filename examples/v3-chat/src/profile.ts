/**
 * The trust profile the v3-chat demo signs into every new room's genesis, and the latched-ACL
 * version that profile requires. Tests import this so they follow the demo's choice.
 *
 * `creator-trusted-settlement-v1` settles each Writer's issuance, so the room's retirement drains
 * old issued rows and a room's issuance stays bounded as it ages; the demo rolls its rooms over by
 * its own policy (rollover.ts), as the shipped apps do. The protocol accepts the settlement profile
 * only with a version-3 latched ACL. Rooms keep the profile their genesis signed; this choice
 * applies to new rooms only.
 */
export const V3_CHAT_GENESIS_PROFILE = Object.freeze({
	profileId: "creator-trusted-settlement-v1",
	latchedAclVersion: 3,
} as const);
