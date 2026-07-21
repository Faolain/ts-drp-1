import { AllowlistVerifier, InviteVerifier } from "@ts-drp/membership";
import { type ControlPlaneMembershipConfig, type DRPNetworkNodeConfig } from "@ts-drp/types";
import { describe, expect, test } from "vitest";

import { DRPNetworkNode } from "../src/node.js";

function createNode(membership?: ControlPlaneMembershipConfig): DRPNetworkNode {
	const config: DRPNetworkNodeConfig = {
		bootstrap_peers: [],
		listen_addresses: [],
		log_config: { level: "silent" },
		...(membership === undefined ? {} : { control_plane: { membership } }),
	};
	return new DRPNetworkNode(config);
}

describe("Phase 2 membership construction seam", () => {
	test("constructs and exposes an actual invite verifier", async () => {
		const node = createNode({
			invite: { inviteToken: "0123456789abcdef" },
			mode: "invite",
		});

		expect(node.membershipVerifier).toBeInstanceOf(InviteVerifier);
		await expect(
			node.membershipVerifier?.verify({
				credential: { kind: "invite", token: "0123456789abcdef" },
				peerId: "untrusted-transport-identity",
				signal: new AbortController().signal,
			})
		).resolves.toEqual({ accepted: true, mode: "invite" });
	});

	test("constructs and exposes an actual allowlist verifier", async () => {
		const node = createNode({
			allowlist: { allowedPeerIds: ["allowed-peer"] },
			mode: "allowlist",
		});

		expect(node.membershipVerifier).toBeInstanceOf(AllowlistVerifier);
		await expect(
			node.membershipVerifier?.verify({
				peerId: "allowed-peer",
				signal: new AbortController().signal,
			})
		).resolves.toEqual({ accepted: true, mode: "allowlist" });
	});

	test("exposes no verifier when membership is absent", () => {
		expect(createNode().membershipVerifier).toBeUndefined();
	});

	test("rejects an unknown membership mode and names the valid modes", () => {
		expect(() => Reflect.construct(DRPNetworkNode, [{ control_plane: { membership: { mode: "threshold" } } }])).toThrow(
			/membership\.mode.*invite.*allowlist/i
		);
	});

	test("rejects invite mode without invite.inviteToken", () => {
		expect(() => Reflect.construct(DRPNetworkNode, [{ control_plane: { membership: { mode: "invite" } } }])).toThrow(
			/invite\.inviteToken/i
		);
	});

	test("rejects allowlist mode without non-empty allowlist.allowedPeerIds", () => {
		expect(() =>
			Reflect.construct(DRPNetworkNode, [{ control_plane: { membership: { allowlist: {}, mode: "allowlist" } } }])
		).toThrow(/non-empty allowlist\.allowedPeerIds/i);
	});
});
