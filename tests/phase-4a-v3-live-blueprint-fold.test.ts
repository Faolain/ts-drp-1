import { encodeCanonical } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import type { Message } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { fakeNetwork, recover } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { activateV3LivePlane, bindV3BlueprintLivePlane } from "../packages/node/src/v3-live.js";

describe("Phase 4a live blueprint fold", () => {
	it("binds signed genesis and converges two independent recovered peers", async () => {
		const initialStateBytes = encodeCanonical(0);
		const fixture = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			exactCanonicalInitialStateBytes: initialStateBytes,
		});
		try {
			const secondPrepared = await fixture.prepareAgain();
			const stalePrepared = await fixture.prepareAgain();
			const recovered = await Promise.all([
				recover(fixture, fixture.capability),
				recover(fixture, secondPrepared.capability),
				recover(fixture, stalePrepared.capability),
			]);
			const activations = recovered.map((entry, index) =>
				activateV3LivePlane({
					capability: entry.capability,
					messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
					networkNode: fakeNetwork(`peer:phase4a:${index}`),
					onAdmittedVertex: vi.fn(),
				})
			);
			expect(activations.every((entry) => entry.ok)).toBe(true);
			if (!activations[0]?.ok || !activations[1]?.ok) throw new TypeError("activation failed");
			expect(
				bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: encodeCanonical(9), plane: activations[0].handle })
			).toEqual({ detail: "v3 signed genesis state is invalid", kind: "malformed-input", ok: false });
			const bindings = activations.map((entry) =>
				bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: initialStateBytes, plane: entry.handle })
			);
			expect(bindings.every((entry) => entry.ok)).toBe(true);
			if (!bindings[0]?.ok || !bindings[1]?.ok || !bindings[2]?.ok) throw new TypeError("binding failed");

			if (!activations[2]?.ok) throw new TypeError("closed fold setup failed");
			const issuedPromise = activations[2].handle.issueLocal({
				operations: Object.freeze([
					Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "add", value: 2 }) }),
				]),
				signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
			});
			const closedStagePromise = bindings[2].handle.stageBlueprintEpoch();
			const [issued, closedStage] = await Promise.all([issuedPromise, closedStagePromise]);
			expect(issued.ok).toBe(true);
			if (!closedStage.ok) throw new TypeError("closed fold failed");
			expect(closedStage.outputs).toEqual([1, 3]);
			expect(closedStage.adopt().ok).toBe(true);
			expect(
				await activations[2].handle.issueLocal({
					operations: Object.freeze([
						Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 4 }) }),
					]),
					signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
				})
			).toEqual({
				detail: "v3 plane is not accepting local issues",
				kind: "not-active",
				ok: false,
			});

			const staged = await Promise.all(bindings.slice(0, 2).map((entry) => entry.handle.stageBlueprintEpoch()));
			if (!staged[0]?.ok || !staged[1]?.ok) {
				throw new TypeError(`fold failed: ${JSON.stringify(staged)}`);
			}
			expect(staged[0].order).toEqual(staged[1].order);
			expect(staged[0].outputs).toEqual([1]);
			expect(staged[0].staged.stateDigest).toBe(staged[1].staged.stateDigest);
			expect(staged[0].staged.exactCanonicalStateBytes).toEqual(staged[1].staged.exactCanonicalStateBytes);

			const adopted = staged.map((entry) => entry.adopt());
			expect(adopted.every((entry) => entry.ok)).toBe(true);
			if (!adopted[0]?.ok || !adopted[1]?.ok) throw new TypeError("adoption failed");
			expect(adopted[0].snapshot).toEqual(adopted[1].snapshot);
			expect(staged[0].adopt()).toEqual({
				detail: "v3 blueprint fold result was already used",
				kind: "already-adopted",
				ok: false,
			});
			expect(await bindings[0].handle.stageBlueprintEpoch()).toEqual({
				detail: "v3 blueprint epoch was already folded",
				kind: "already-folded",
				ok: false,
			});

			activations[1].handle.deactivate();
			expect(bindings[1].handle.blueprintSnapshot()).toBeUndefined();
		} finally {
			await fixture.close();
		}
	});

	it("rejects an authenticated latched member without application-writer authority", async () => {
		const initialStateBytes = encodeCanonical(0);
		const fixture = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			exactCanonicalInitialStateBytes: initialStateBytes,
			latchedAclGroups: ["admin", "finality"],
		});
		let activation: ReturnType<typeof activateV3LivePlane> | undefined;
		try {
			const recovered = await recover(fixture, fixture.capability);
			activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:phase4a:non-writer"),
				onAdmittedVertex: vi.fn(),
			});
			if (!activation.ok) throw new TypeError("activation failed");
			const binding = bindV3BlueprintLivePlane({
				exactCanonicalInitialStateBytes: initialStateBytes,
				plane: activation.handle,
			});
			if (!binding.ok) throw new TypeError("binding failed");
			expect(await binding.handle.stageBlueprintEpoch()).toEqual({
				detail: "v3 blueprint epoch fold was rejected",
				kind: "fold-rejected",
				ok: false,
			});
		} finally {
			if (activation?.ok) activation.handle.deactivate();
			await fixture.close();
		}
	});
});
