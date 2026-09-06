import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contract, hexBytes } from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import { bytesForRef, openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import { openCreatorSuccessorTrust } from "../packages/protocol-v3/src/creator-close.js";
import { openSealAuthority } from "../packages/protocol-v3/src/seal.js";

let fixture: Awaited<ReturnType<typeof openGenuineCreatorAdoptionFixture>>;

beforeAll(async () => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
	fixture = await openGenuineCreatorAdoptionFixture();
});

afterAll(async () => fixture?.close());

describe("D.110c-0a epoch-relative seal-authority causal RED", () => {
	it("opens the genuine adopted epoch-one creator trust under the same authorized finality key", () => {
		const { closeResult, currentTrust, proposed } = fixture.evidence;
		const publicKey = ed25519.getPublicKey(hexBytes(contract.privateKeySeedHex));
		const predecessor = openSealAuthority({ signerPublicKey: publicKey, trust: currentTrust });
		expect(predecessor, "D110C_0A_EPOCH_ZERO_CONTROL").toMatchObject({ ok: true });

		const successor = openCreatorSuccessorTrust({
			currentTrust,
			exactCanonicalCommitQcBytes: bytesForRef(proposed, closeResult.commitQcRef),
			exactCanonicalCutValueBytes: bytesForRef(proposed, closeResult.cutValueRef),
			exactCanonicalTrustStateRecordBytes: bytesForRef(proposed, closeResult.successorTrustRef),
		});
		expect(successor, "D110C_0A_GENUINE_SUCCESSOR_TRUST").toMatchObject({ ok: true });
		if (!successor.ok) return;

		const source = readFileSync(resolve(import.meta.dirname, "../packages/protocol-v3/src/seal.ts"), "utf8");
		expect(source, "D110C_0A_LITERAL_GUARD_SOURCE").not.toContain(
			"material === undefined || material.currentEpoch !== 0"
		);
		expect(
			openSealAuthority({ signerPublicKey: publicKey, trust: successor.trust }),
			"D110C_0A_EPOCH_ONE_AUTHORITY_REFUSED"
		).toMatchObject({ ok: true });
	});
});
