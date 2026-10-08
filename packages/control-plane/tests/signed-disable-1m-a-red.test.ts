import * as controlPlane from "@ts-drp/control-plane";
import { describe, expect, it } from "vitest";

import {
	alternateAuthorityDisable,
	committedState,
	createController,
	DISABLE_DOMAIN_V1,
	DISABLE_SCOPE,
	type DisableApplyResult,
	type DisableLatchState,
	emptyLatchState,
	EphemeralDisableLatchStatePort,
	hex,
	OPERATOR_AUTHORITY,
	OPERATOR_AUTHORITY_SET_VERSION,
	OPERATOR_PUBLIC_KEY,
	signedDisable,
	type SignedDisableControllerConstructor,
	type SignedDisableEnvelope,
} from "./signed-disable-1m-a-fixtures.js";

const Controller = (
	controlPlane as unknown as { readonly SignedDisableController?: SignedDisableControllerConstructor }
).SignedDisableController;
const exportedDomain = (controlPlane as unknown as { readonly DISABLE_ENVELOPE_DOMAIN_V1?: unknown })
	.DISABLE_ENVELOPE_DOMAIN_V1;

describe("Phase 1m-a signed-disable public owner RED", () => {
	it("requires the genuine control-plane owner and the one pinned v1 signature domain", () => {
		expect(Controller, "@ts-drp/control-plane must export SignedDisableController").toBeTypeOf("function");
		expect(exportedDomain, "@ts-drp/control-plane must export the exact v1 domain").toBe(DISABLE_DOMAIN_V1);
	});
});

describe("Phase 1m-a independent canonical fixture", () => {
	it("pins the complete v1 disable-only preimage bytes", () => {
		expect(hex(signedDisable(1).canonicalBytes)).toBe(
			"0808050573636f70650515636f6d70616374696f6e2f686973746f72792d7631050573756974650511656432353531392d7368613235362d76310507636f756e7465720302050776657273696f6e03020509617574686f7269747905106f70657261746f722d7072696d6172790509636f6d6d616e644964061000000000000000000000000000000001050a6361706162696c697479050764697361626c650513617574686f7269747953657456657273696f6e0306"
		);
	});
});

describe("Phase 1m-a signed-disable behavioral contract", () => {
	it("keeps a valid disable ineffective until the one atomic tuple commit resolves", async () => {
		const prior = emptyLatchState();
		const port = new EphemeralDisableLatchStatePort(prior);
		port.mode = "deferred";
		const controller = createController(requiredController(), port);
		await expect(controller.restore()).resolves.toEqual({ highestCounter: 0, status: "enabled" });
		const envelope = signedDisable(1);

		const pending = controller.apply(envelope);
		await waitForCommit(port);
		expect(controller.consumerState()).toEqual({ highestCounter: 0, status: "enabled" });
		expect(port.stored()).toEqual(prior);
		expect(port.commits).toEqual([{ expected: prior, next: committedState(prior, envelope, 1) }]);

		port.resolveDeferredCommit();
		await expect(pending).resolves.toEqual({ applied: true, counter: 1 });
		expect(port.stored()).toEqual(committedState(prior, envelope, 1));
		expect(controller.consumerState()).toEqual({ highestCounter: 1, status: "disabled" });
	});

	it.each([
		["wrong authority", alternateAuthorityDisable(1), "wrong-authority"],
		[
			"wrong authority-set version",
			signedDisable(1, { authoritySetVersion: OPERATOR_AUTHORITY_SET_VERSION + 1 }),
			"wrong-authority-set",
		],
		["wrong scope", signedDisable(1, { scope: `${DISABLE_SCOPE}/other` }), "wrong-scope"],
		["wrong capability", signedDisable(1, { capability: "enable" }), "wrong-capability"],
		["unsupported signed suite", signedDisable(1, { suite: "ed25519-seal-v1" }), "wrong-suite"],
		["unknown envelope version", signedDisable(1, { version: 2 }), "unsupported-version"],
		[
			"wrong signature domain",
			signedDisable(1, {}, { domain: "ts-drp/control-plane/recovery/v1" }),
			"invalid-signature",
		],
		["forgery", forge(signedDisable(1)), "invalid-signature"],
	] as const)("rejects %s without a state transaction", async (_label, envelope, reason) => {
		const prior = emptyLatchState();
		const port = new EphemeralDisableLatchStatePort(prior);
		const controller = createController(requiredController(), port);
		await controller.restore();

		await expect(controller.apply(envelope)).resolves.toEqual({ applied: false, reason });
		expect(port.commits).toEqual([]);
		expect(port.stored()).toEqual(prior);
		expect(controller.consumerState()).toEqual({ highestCounter: 0, status: "enabled" });
	});

	it("distinguishes replay, stale counter and same-counter equivocation while preserving exact state", async () => {
		const accepted = signedDisable(5);
		const committed = committedState(emptyLatchState(), accepted, 5);
		const cases: readonly [string, SignedDisableEnvelope, DisableApplyResult["reason"]][] = [
			["replay", accepted, "replay"],
			["stale", signedDisable(4), "stale-counter"],
			[
				"equivocation",
				signedDisable(5, { commandId: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]) }),
				"equivocation",
			],
		];

		for (const [label, envelope, reason] of cases) {
			const port = new EphemeralDisableLatchStatePort(committed);
			const controller = createController(requiredController(), port);
			await expect(controller.restore(), label).resolves.toEqual({ highestCounter: 5, status: "disabled" });
			await expect(controller.apply(envelope), label).resolves.toEqual({ applied: false, reason });
			expect(port.commits, label).toEqual([]);
			expect(port.stored(), label).toEqual(committed);
			expect(controller.consumerState(), label).toEqual({ highestCounter: 5, status: "disabled" });
		}
	});

	it.each(["reject", "throw", "ambiguous"] as const)(
		"keeps stored and observable state exact when commit outcome is %s",
		async (mode) => {
			const prior = emptyLatchState();
			const port = new EphemeralDisableLatchStatePort(prior);
			port.mode = mode;
			const controller = createController(requiredController(), port);
			await controller.restore();

			await expect(controller.apply(signedDisable(1))).resolves.toEqual({
				applied: false,
				reason: "state-commit-failed",
			});
			expect(port.stored()).toEqual(prior);
			expect(controller.consumerState()).toEqual({ highestCounter: 0, status: "enabled" });
		}
	);

	it("retains only the latest fixed-shape replay tuple across a bounded command sequence", async () => {
		const port = new EphemeralDisableLatchStatePort();
		const controller = createController(requiredController(), port);
		await controller.restore();

		for (let counter = 1; counter <= 32; counter += 1) {
			await expect(controller.apply(signedDisable(counter))).resolves.toEqual({ applied: true, counter });
		}

		const stored = port.stored() as DisableLatchState;
		expect(Object.keys(stored).sort()).toEqual([
			"authoritySetVersion",
			"envelopeBytes",
			"envelopeDigest",
			"envelopeVersion",
			"highestCounter",
			"latch",
			"scope",
			"stateVersion",
		]);
		expect(stored).toEqual(committedState(emptyLatchState(), signedDisable(32), 32));
		expect(stored.envelopeDigest).toHaveLength(32);
		expect(stored.envelopeBytes).toHaveLength(signedDisable(32).canonicalBytes.byteLength);
		expect(controller.consumerState()).toEqual({ highestCounter: 32, status: "disabled" });
	});

	it.each([
		["unreadable", Uint8Array.from([0xff, 0x00])],
		["unknown state version", { ...emptyLatchState(), stateVersion: 2 }],
		["unknown envelope version", { ...emptyLatchState(), envelopeVersion: 2 }],
		["malformed counter", { ...emptyLatchState(), highestCounter: -1 }],
	] as const)("blocks the consumer for %s restored state", async (_label, restored) => {
		const port = new EphemeralDisableLatchStatePort(restored);
		const controller = createController(requiredController(), port);

		await expect(controller.restore()).resolves.toEqual({ highestCounter: null, status: "blocked" });
		expect(controller.consumerState()).toEqual({ highestCounter: null, status: "blocked" });
		await expect(controller.apply(signedDisable(1))).resolves.toEqual({
			applied: false,
			reason: "state-unavailable",
		});
		expect(port.commits).toEqual([]);
		expect(port.stored()).toEqual(restored);
	});

	it("blocks the consumer when restored state cannot be read", async () => {
		const port = new EphemeralDisableLatchStatePort();
		port.loadMode = "throw";
		const controller = createController(requiredController(), port);

		await expect(controller.restore()).resolves.toEqual({ highestCounter: null, status: "blocked" });
		expect(controller.consumerState()).toEqual({ highestCounter: null, status: "blocked" });
		await expect(controller.apply(signedDisable(1))).resolves.toEqual({
			applied: false,
			reason: "state-unavailable",
		});
		expect(port.commits).toEqual([]);
	});

	it("detaches pinned authority and public envelope bytes before a deferred commit", async () => {
		const prior = emptyLatchState();
		const port = new EphemeralDisableLatchStatePort(prior);
		port.mode = "deferred";
		const publicKey = new Uint8Array(OPERATOR_PUBLIC_KEY);
		const controller = createController(requiredController(), port, publicKey);
		publicKey.fill(0);
		await controller.restore();
		const envelope = signedDisable(1);
		const originalEnvelope: SignedDisableEnvelope = {
			canonicalBytes: new Uint8Array(envelope.canonicalBytes),
			signature: new Uint8Array(envelope.signature),
		};

		const pending = controller.apply(envelope);
		await waitForCommit(port);
		envelope.canonicalBytes.fill(0);
		envelope.signature.fill(0);
		expect(port.commits).toEqual([{ expected: prior, next: committedState(prior, originalEnvelope, 1) }]);
		expect(port.stored()).toEqual(prior);

		port.resolveDeferredCommit();
		await expect(pending).resolves.toEqual({ applied: true, counter: 1 });
		expect(port.stored()).toEqual(committedState(prior, originalEnvelope, 1));
		expect(controller.consumerState()).toEqual({ highestCounter: 1, status: "disabled" });
	});

	it("requires an injected state port instead of silently constructing a default", () => {
		const Constructor = requiredController();
		expect(
			() =>
				new Constructor({
					authority: {
						authorityId: OPERATOR_AUTHORITY,
						authoritySetVersion: OPERATOR_AUTHORITY_SET_VERSION,
						publicKey: { bytes: new Uint8Array(32), format: "raw" },
					},
					scope: DISABLE_SCOPE,
					statePort: undefined as never,
				})
		).toThrow();
	});
});

function requiredController(): SignedDisableControllerConstructor {
	if (Controller === undefined) throw new Error("SignedDisableController is not exported");
	return Controller;
}

function forge(envelope: SignedDisableEnvelope): SignedDisableEnvelope {
	const signature = new Uint8Array(envelope.signature);
	signature[0] = (signature[0] ?? 0) ^ 0x80;
	return { canonicalBytes: envelope.canonicalBytes, signature };
}

async function waitForCommit(port: EphemeralDisableLatchStatePort): Promise<void> {
	for (let attempts = 0; attempts < 8 && port.commits.length === 0; attempts += 1) await Promise.resolve();
	expect(port.commits).toHaveLength(1);
}
