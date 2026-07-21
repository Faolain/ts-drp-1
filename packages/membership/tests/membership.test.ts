import {
	AllowlistVerifier,
	InviteVerifier,
	type MembershipVerifier,
	type ThresholdCertificateVerifier,
} from "@ts-drp/membership";
import { describe, expect, expectTypeOf, it } from "vitest";

const INVITE = "fixture-invite-token-32-characters";

describe("invite membership verification", () => {
	it("requires a bounded secret and accepts only the exact invite token", async () => {
		expect(() => new InviteVerifier({ inviteToken: "too-short" })).toThrow("at least 16");
		const verifier = new InviteVerifier({ inviteToken: INVITE });
		await expect(
			verifier.verify({
				credential: { kind: "invite", token: INVITE },
				peerId: "peer-a",
				signal: signal(),
			})
		).resolves.toEqual({ accepted: true, mode: "invite" });
		await expect(
			verifier.verify({
				credential: { kind: "invite", token: "wrong-token-long-enough" },
				peerId: "peer-a",
				signal: signal(),
			})
		).resolves.toEqual({ accepted: false, mode: "invite", reason: "invite-invalid" });
	});

	it("rejects a missing credential without echoing the configured secret", async () => {
		const result = await new InviteVerifier({ inviteToken: INVITE }).verify({
			peerId: "peer-a",
			signal: signal(),
		});
		expect(result).toEqual({ accepted: false, mode: "invite", reason: "invite-invalid" });
		expect(JSON.stringify(result)).not.toContain(INVITE);
	});
});

describe("allowlist membership verification", () => {
	it("accepts exact Peer IDs and rejects every other identity", async () => {
		const verifier = new AllowlistVerifier({ allowedPeerIds: ["peer-a"] });
		await expect(verifier.verify({ peerId: "peer-a", signal: signal() })).resolves.toEqual({
			accepted: true,
			mode: "allowlist",
		});
		await expect(verifier.verify({ peerId: "peer-b", signal: signal() })).resolves.toEqual({
			accepted: false,
			mode: "allowlist",
			reason: "peer-not-allowlisted",
		});
		await expect(verifier.verify({ peerId: "PEER-A", signal: signal() })).resolves.toMatchObject({
			accepted: false,
			reason: "peer-not-allowlisted",
		});
	});

	it("returns its local decision for an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort(new Error("stop-membership"));
		await expect(
			new AllowlistVerifier({ allowedPeerIds: ["peer-a"] }).verify({
				peerId: "peer-a",
				signal: controller.signal,
			})
		).resolves.toEqual({ accepted: true, mode: "allowlist" });
	});
});

describe("threshold certificate seam", () => {
	it("is a verifier interface only", () => {
		expectTypeOf<ThresholdCertificateVerifier>().toMatchTypeOf<MembershipVerifier<unknown>>();
	});
});

function signal(): AbortSignal {
	return new AbortController().signal;
}
