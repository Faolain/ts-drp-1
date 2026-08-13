import { ed25519 } from "@noble/curves/ed25519.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	bytesHex,
	contract,
	type CreatorMaterial,
	hexBytes,
	independentHashDomain,
	makeCreatorMaterial,
	makeTrustStateRecord,
} from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import {
	installCreatorAnchorTrustRoot,
	type InstallCreatorAnchorTrustRootInput,
	openCurrentAnchorTrust,
} from "../packages/protocol-v3/src/public.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const REGISTRY_PATH = resolve(REPOSITORY_ROOT, "packages/protocol-v3/registry/registry-v1.json");
const CONTROL_SIGNER_IDS = [
	["C0", "creator\u0000suffix"],
	["DEL", "creator\u007fsuffix"],
	["C1", "creator\u0085suffix"],
] as const;

function installInput(material: CreatorMaterial): InstallCreatorAnchorTrustRootInput {
	return {
		detachedGenesisSignature: new Uint8Array(material.signature),
		exactCanonicalGenesisAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
		exactCanonicalProfileBytes: new Uint8Array(material.profileBytes),
		exactCanonicalSignerSetBytes: new Uint8Array(material.signerSetBytes),
		pinnedGenesisAnchorDigest: material.anchorDigest,
	};
}

function isUnicodeScalarExcludingControls(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return false;
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

function expectClosedFailure(result: unknown, reason: string): void {
	expect.soft(result).toEqual({ ok: false, reason });
	expect.soft(Object.isFrozen(result)).toBe(true);
	expect.soft(result).not.toHaveProperty("trust");
	expect.soft(result).not.toHaveProperty("exactCanonicalTrustStateRecordBytes");
	expect.soft(result).not.toHaveProperty("provenance");
}

describe("Phase 3a-0-A signer-control corrective RED", () => {
	it("[registry-control] causally freezes unicode-scalar-excluding-controls for signer identities", () => {
		const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as {
			kinds: {
				signerSet: {
					fields: readonly {
						constraints: Readonly<Record<string, unknown>>;
						name: string;
					}[];
				};
			};
		};
		const signerConstraints = registry.kinds.signerSet.fields.find(({ name }) => name === "signers")?.constraints;
		expect(signerConstraints).toEqual({
			maxSignerIdUtf16Units: 512,
			signerIdCharset: "unicode-scalar-excluding-controls",
			uniqueBy: "signerId",
		});
		for (const [, signerId] of CONTROL_SIGNER_IDS) expect(isUnicodeScalarExcludingControls(signerId)).toBe(false);
		for (const signerId of ["creator", "créateur", "creator😀"]) {
			expect(isUnicodeScalarExcludingControls(signerId)).toBe(true);
		}
	});

	it.each(CONTROL_SIGNER_IDS)(
		"[%s] rejects self-consistent signed control-bearing carriers before capability minting",
		(_controlClass, signerId) => {
			const base = makeCreatorMaterial();
			const baseSigner = base.signerSet[0] as Readonly<{ publicKey: string; signerId: string }>;
			const signer = { ...baseSigner, signerId };
			const material = makeCreatorMaterial({ profileSigners: [signer], signerSet: [signer] });
			const signerPublicKey = hexBytes(String(signer.publicKey));
			expect(material.profile).toMatchObject({ quorum: 1, signers: material.signerSet });
			expect(material.anchor.signerSetDigest).toBe(
				bytesHex(independentHashDomain(contract.signerSetDigestDomain, material.signerSetBytes))
			);
			expect(material.anchor.profileDigest).toBe(
				bytesHex(independentHashDomain(contract.profileDigestDomain, material.profileBytes))
			);
			expect(
				ed25519.verify(material.signature, hexBytes(material.anchorDigest), signerPublicKey, { zip215: false })
			).toBe(true);

			const input = installInput(material);
			const inputSnapshots = Object.values(input)
				.filter((value): value is Uint8Array => value instanceof Uint8Array)
				.map((bytes) => new Uint8Array(bytes));
			const installResult = installCreatorAnchorTrustRoot(input);
			expectClosedFailure(installResult, "signer-set-profile-mismatch");
			Object.values(input)
				.filter((value): value is Uint8Array => value instanceof Uint8Array)
				.forEach((bytes, index) => expect.soft(bytes).toEqual(inputSnapshots[index]));
			expectClosedFailure(
				installCreatorAnchorTrustRoot({ ...installInput(material), pinnedGenesisAnchorDigest: "f".repeat(64) }),
				"genesis-pin-mismatch"
			);
			expectClosedFailure(
				installCreatorAnchorTrustRoot({ ...installInput(material), detachedGenesisSignature: new Uint8Array(64) }),
				"signer-set-profile-mismatch"
			);

			const recordBytes = makeTrustStateRecord(material);
			const recordSnapshot = new Uint8Array(recordBytes);
			expectClosedFailure(
				openCurrentAnchorTrust({
					exactCanonicalTrustStateRecordBytes: recordBytes,
					expectedObjectId: contract.objectId,
					pinnedGenesisAnchorDigest: material.anchorDigest,
				}),
				"trust-state-inconsistent"
			);
			expect.soft(recordBytes).toEqual(recordSnapshot);
			expectClosedFailure(
				openCurrentAnchorTrust({
					exactCanonicalTrustStateRecordBytes: recordBytes,
					expectedObjectId: contract.objectId,
					pinnedGenesisAnchorDigest: "f".repeat(64),
				}),
				"genesis-pin-mismatch"
			);
		}
	);
});
