import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical } from "@ts-drp/canonical";
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
	authenticateCurrentEpochAnchor,
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
const TERMINAL_HIGH_SURROGATE = "creator\ud800";
const VALID_PAIRED_SURROGATE = "creator😀";

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
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

function missingEndBoundMutant(value: string): boolean {
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

function replaceTerminalAsciiWithHighSurrogateBytes(bytes: Uint8Array): Uint8Array {
	const encoded = new TextEncoder().encode("creatorX");
	const needle = Uint8Array.of(0x05, encoded.byteLength, ...encoded);
	const replacement = Uint8Array.of(0x05, 10, ...encoded.subarray(0, -1), 0xed, 0xa0, 0x80);
	const matches: number[] = [];
	for (let offset = 0; offset <= bytes.byteLength - needle.byteLength; offset++) {
		if (needle.every((byte, index) => bytes[offset + index] === byte)) matches.push(offset);
	}
	if (matches.length !== 1) throw new Error(`EXPECTED_ONE_SIGNER_ID_MATCH:${matches.length}`);
	const offset = matches[0] as number;
	return new Uint8Array([...bytes.subarray(0, offset), ...replacement, ...bytes.subarray(offset + needle.byteLength)]);
}

function containsTerminalHighSurrogateBytes(bytes: Uint8Array): boolean {
	return bytes.some((byte, index) => byte === 0xed && bytes[index + 1] === 0xa0 && bytes[index + 2] === 0x80);
}

function makeTerminalHighSurrogateMaterial(): CreatorMaterial {
	const base = makeCreatorMaterial();
	const baseSigner = base.signerSet[0] as Readonly<{ publicKey: string; signerId: string }>;
	const encodedSigner = { ...baseSigner, signerId: "creatorX" };
	const encodedMaterial = makeCreatorMaterial({ profileSigners: [encodedSigner], signerSet: [encodedSigner] });
	const signerSetBytes = replaceTerminalAsciiWithHighSurrogateBytes(encodedMaterial.signerSetBytes);
	const profileBytes = replaceTerminalAsciiWithHighSurrogateBytes(encodedMaterial.profileBytes);
	const anchor = {
		...encodedMaterial.anchor,
		profileDigest: bytesHex(independentHashDomain(contract.profileDigestDomain, profileBytes)),
		signerSetDigest: bytesHex(independentHashDomain(contract.signerSetDigestDomain, signerSetBytes)),
	};
	const anchorBytes = encodeCanonical(anchor);
	const anchorDigest = bytesHex(independentHashDomain(contract.anchorDigestDomain, anchorBytes));
	const rawSigner = { ...baseSigner, signerId: TERMINAL_HIGH_SURROGATE };
	return {
		...encodedMaterial,
		anchor,
		anchorBytes,
		anchorDigest,
		profile: { ...encodedMaterial.profile, signers: [rawSigner] },
		profileBytes,
		signature: ed25519.sign(hexBytes(anchorDigest), hexBytes(contract.privateKeySeedHex)),
		signerSet: [rawSigner],
		signerSetBytes,
	};
}

function expectClosedFailure(result: unknown, reason: string): void {
	expect.soft(result).toEqual({ ok: false, reason });
	expect.soft(Object.isFrozen(result)).toBe(true);
	expect.soft(result).not.toHaveProperty("trust");
	expect.soft(result).not.toHaveProperty("exactCanonicalTrustStateRecordBytes");
	expect.soft(result).not.toHaveProperty("provenance");
}

describe("Phase 3a-0-A signer-control corrective causal evidence", () => {
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
		expect(isUnicodeScalarExcludingControls(TERMINAL_HIGH_SURROGATE)).toBe(false);
		expect(missingEndBoundMutant(TERMINAL_HIGH_SURROGATE)).toBe(true);
		for (const signerId of ["creator", "créateur", VALID_PAIRED_SURROGATE]) {
			expect(isUnicodeScalarExcludingControls(signerId)).toBe(true);
		}
	});

	it("rejects terminal high-surrogate carrier bytes through install and open without minting authority", () => {
		const material = makeTerminalHighSurrogateMaterial();
		expect(containsTerminalHighSurrogateBytes(material.signerSetBytes)).toBe(true);
		expect(containsTerminalHighSurrogateBytes(material.profileBytes)).toBe(true);
		expect(material.anchor.signerSetDigest).toBe(
			bytesHex(independentHashDomain(contract.signerSetDigestDomain, material.signerSetBytes))
		);
		expect(material.anchor.profileDigest).toBe(
			bytesHex(independentHashDomain(contract.profileDigestDomain, material.profileBytes))
		);
		expect(
			ed25519.verify(material.signature, hexBytes(material.anchorDigest), hexBytes(contract.publicKeyHex), {
				zip215: false,
			})
		).toBe(true);

		const install = installInput(material);
		const installSnapshots = Object.values(install)
			.filter((value): value is Uint8Array => value instanceof Uint8Array)
			.map((bytes) => new Uint8Array(bytes));
		expectClosedFailure(installCreatorAnchorTrustRoot(install), "signer-set-profile-mismatch");
		Object.values(install)
			.filter((value): value is Uint8Array => value instanceof Uint8Array)
			.forEach((bytes, index) => expect.soft(bytes).toEqual(installSnapshots[index]));

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
		expect(recordBytes).toEqual(recordSnapshot);
	});

	it("accepts a paired non-BMP signer identity through install, open and authenticate", () => {
		const base = makeCreatorMaterial();
		const baseSigner = base.signerSet[0] as Readonly<{ publicKey: string; signerId: string }>;
		const signer = { ...baseSigner, signerId: VALID_PAIRED_SURROGATE };
		const material = makeCreatorMaterial({ profileSigners: [signer], signerSet: [signer] });
		const installed = installCreatorAnchorTrustRoot(installInput(material));
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const opened = openCurrentAnchorTrust({
			exactCanonicalTrustStateRecordBytes: installed.exactCanonicalTrustStateRecordBytes,
			expectedObjectId: contract.objectId,
			pinnedGenesisAnchorDigest: material.anchorDigest,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(
			authenticateCurrentEpochAnchor({
				detachedSignature: material.signature,
				exactCanonicalAnchorPreimageBytes: material.anchorBytes,
				trust: opened.trust,
			})
		).toMatchObject({
			ok: true,
			provenance: { anchorDigest: material.anchorDigest, objectId: contract.objectId },
		});
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
