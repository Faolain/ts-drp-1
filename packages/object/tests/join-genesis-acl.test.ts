/**
 * RED contracts for creator-bound object ids (defensive hardening).
 *
 * The object id must commit to its creator so that every replica derives the
 * identical genesis ACL — the creator as sole admin and finality signer,
 * equivalent to createPermissionlessACL(creatorPeerId) — locally from the id,
 * with zero network trust. No root ACL is ever adopted from the network: a
 * root supplied by a non-creator peer must grant that peer nothing.
 *
 * These tests pin the contract through public behavior only (what a DRPObject
 * built with { id } and no acl derives), not through any particular id string
 * encoding, so GREEN remains free to choose the encoding.
 */
import { describe, expect, test } from "vitest";

import { createObject, createPermissionlessACL, DRPObject, HashGraph } from "../src/index.js";
import { stateFromDRP } from "../src/state.js";

const CREATOR = "creator-peer";
const JOINER = "joiner-peer";
const OTHER = "other-peer";
const ATTACKER = "attacker-peer";

describe("creator-bound genesis ACL", () => {
	test("a fresh joiner derives the creator's genesis authority from the object id alone", () => {
		const created = createObject({ peerId: CREATOR });
		const joiner = new DRPObject({ peerId: JOINER, id: created.id });

		expect(joiner.acl.query_isAdmin(CREATOR)).toBe(true);
		expect(joiner.acl.query_isFinalitySigner(CREATOR)).toBe(true);
		expect(joiner.acl.query_isAdmin(JOINER)).toBe(false);
		expect(joiner.acl.query_isFinalitySigner(JOINER)).toBe(false);
		expect(joiner.acl.query_isAdmin(OTHER)).toBe(false);
		expect(joiner.acl.query_isFinalitySigner(OTHER)).toBe(false);

		// Genesis is exactly the creator's permissionless ACL, derived locally.
		expect(joiner.acl.query_getFinalitySigners()).toEqual(createPermissionlessACL(CREATOR).query_getFinalitySigners());
	});

	test("a root ACL from a non-creator peer cannot seize authority over a joined object", async () => {
		const created = createObject({ peerId: CREATOR });
		const joiner = new DRPObject({ peerId: JOINER, id: created.id });

		// The root a non-creator would craft for this id: itself as admin + finality signer.
		const attackerRoot = stateFromDRP(createPermissionlessACL(ATTACKER));

		// Deliver it through both adoption entrypoints the sync layer uses today.
		// Rejecting loudly (throwing) is an acceptable secure outcome; adopting is not.
		// SYNC_ACCEPT path: object.merge(vertices, rootACLState)
		await joiner.merge([], attackerRoot).catch(() => {});
		// FETCH_STATE_RESPONSE path: object.setACLState(rootHash, aclState)
		try {
			joiner.setACLState(HashGraph.rootHash, attackerRoot);
		} catch {
			// a thrown rejection still blocks the attack
		}

		expect(joiner.acl.query_isAdmin(ATTACKER)).toBe(false);
		expect(joiner.acl.query_isFinalitySigner(ATTACKER)).toBe(false);
		expect(joiner.acl.query_isAdmin(CREATOR)).toBe(true);
		expect(joiner.acl.query_isFinalitySigner(CREATOR)).toBe(true);
		expect([...joiner.acl.query_getFinalitySigners().keys()]).toEqual([CREATOR]);
	});

	test("ids from the same creator differ by salt but derive the same genesis admin", () => {
		const first = createObject({ peerId: CREATOR });
		const second = createObject({ peerId: CREATOR });

		// The salt keeps independently created objects distinct...
		expect(second.id).not.toBe(first.id);

		// ...but the creator commitment in each id yields identical genesis authority.
		for (const id of [first.id, second.id]) {
			const joiner = new DRPObject({ peerId: JOINER, id });
			expect(joiner.acl.query_isAdmin(CREATOR)).toBe(true);
			expect(joiner.acl.query_isFinalitySigner(CREATOR)).toBe(true);
			expect([...joiner.acl.query_getFinalitySigners().keys()]).toEqual([CREATOR]);
		}
	});

	test("the derived genesis admin is the actual creator, not any fixed peer", () => {
		const createdByOther = createObject({ peerId: OTHER });
		const joiner = new DRPObject({ peerId: JOINER, id: createdByOther.id });

		expect(joiner.acl.query_isAdmin(OTHER)).toBe(true);
		expect(joiner.acl.query_isFinalitySigner(OTHER)).toBe(true);
		expect(joiner.acl.query_isAdmin(CREATOR)).toBe(false);
		expect(joiner.acl.query_isFinalitySigner(CREATOR)).toBe(false);
	});
});
