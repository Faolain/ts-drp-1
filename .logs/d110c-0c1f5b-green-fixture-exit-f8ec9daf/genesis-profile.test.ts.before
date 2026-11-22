import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
	makeCreatorMaterial,
	makeTrustStateRecord as makeCreatorTrustStateRecord,
} from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import {
	contract,
	installInput,
	makeCertifiedGenesis,
	makeExpectedTrustStateRecord,
	maximumObjectId,
	mutateCanonical,
} from "./fixtures/phase-3b-v3/certified-genesis-contract.js";

interface Failure {
	readonly ok: false;
	readonly reason: string;
}

interface CertifiedTrust {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: 0;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly profileId: "attested-bft-v1" | "delegated-trusted-v1";
	readonly quorum: number;
	readonly signerCount: number;
}

interface CertifiedInstallSuccess {
	readonly exactCanonicalTrustStateRecordBytes: Uint8Array;
	readonly ok: true;
	readonly trust: CertifiedTrust;
}

interface CertifiedOpenSuccess {
	readonly ok: true;
	readonly trust: CertifiedTrust;
}

interface ProtocolV3Surface {
	installCertifiedAnchorTrustRoot?(input: unknown): CertifiedInstallSuccess | Failure;
	installCreatorAnchorTrustRoot?(
		input: unknown
	): { readonly exactCanonicalTrustStateRecordBytes: Uint8Array; readonly ok: true } | Failure;
	openCertifiedAnchorTrust?(input: unknown): CertifiedOpenSuccess | Failure;
	openCurrentAnchorTrust?(input: unknown): { readonly ok: true } | Failure;
	readonly [name: string]: unknown;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const PUBLIC_ENTRY = resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/public.ts");
const surface = (await import(pathToFileURL(PUBLIC_ENTRY).href)) as ProtocolV3Surface;
const HAS_CERTIFIED_APIS =
	typeof surface.installCertifiedAnchorTrustRoot === "function" &&
	typeof surface.openCertifiedAnchorTrust === "function";
const EXPECTED_RUNTIME_EXPORTS = [
	"ANCHOR_TRUST_STATE_MAX_RECORD_BYTES",
	"admitReceivedVertex",
	"authenticateCurrentEpochAnchor",
	"createAdmissionBoundTransactionalVertexIssuer",
	"extractAdmittedReceivedVertex",
	"installCertifiedAnchorTrustRoot",
	"installCreatorAnchorTrustRoot",
	"isAnchorTrustStateRecordBytes",
	"openCertifiedAnchorTrust",
	"openCurrentAnchorTrust",
	"prepareBlueprintAdmission",
	"prepareBlueprintRuntime",
] as const;

function expectFailure(result: Failure | { readonly ok: true }, reason: string): void {
	expect(result).toEqual({ ok: false, reason });
	expect(Object.isFrozen(result)).toBe(true);
}

function openInput(bytes: Uint8Array, material = makeCertifiedGenesis()): Readonly<Record<string, unknown>> {
	return Object.freeze({
		exactCanonicalTrustStateRecordBytes: new Uint8Array(bytes),
		expectedObjectId: material.anchor.objectId,
		pinnedGenesisAnchorDigest: material.anchorDigest,
	});
}

function requireCertifiedApis(): Readonly<{
	install: NonNullable<ProtocolV3Surface["installCertifiedAnchorTrustRoot"]>;
	open: NonNullable<ProtocolV3Surface["openCertifiedAnchorTrust"]>;
}> {
	if (!HAS_CERTIFIED_APIS) throw new Error("PHASE_3B_CERTIFIED_GENESIS_APIS_ABSENT");
	return Object.freeze({
		install: surface.installCertifiedAnchorTrustRoot as NonNullable<
			ProtocolV3Surface["installCertifiedAnchorTrustRoot"]
		>,
		open: surface.openCertifiedAnchorTrust as NonNullable<ProtocolV3Surface["openCertifiedAnchorTrust"]>,
	});
}

describe("Phase 3b certified genesis", () => {
	it("[control] independently authors canonical all-signer genesis acceptance", () => {
		for (const material of [
			makeCertifiedGenesis(),
			makeCertifiedGenesis({ profileId: "attested-bft-v1", quorum: 3 }),
		]) {
			const certificate = decodeCanonical(material.certificateBytes) as {
				readonly signatures: readonly {
					readonly publicKey: string;
					readonly signature: Uint8Array;
					readonly signerId: string;
				}[];
			};
			expect(certificate.signatures.map(({ signerId }) => signerId)).toEqual(
				[...certificate.signatures.map(({ signerId }) => signerId)].sort((left, right) =>
					Buffer.from(left).compare(Buffer.from(right))
				)
			);
			for (const row of certificate.signatures) {
				expect(
					ed25519.verify(row.signature, Uint8Array.from(Buffer.from(material.anchorDigest, "hex")), row.publicKey, {
						zip215: false,
					})
				).toBe(true);
			}
			expect(encodeCanonical(decodeCanonical(material.anchorBytes))).toEqual(material.anchorBytes);
			expect(encodeCanonical(decodeCanonical(material.profileBytes))).toEqual(material.profileBytes);
			expect(encodeCanonical(decodeCanonical(material.signerSetBytes))).toEqual(material.signerSetBytes);
			expect(encodeCanonical(decodeCanonical(material.certificateBytes))).toEqual(material.certificateBytes);
		}
	});

	it("[control] proves the exact bounded maximum record is 8190 bytes", () => {
		const signerIds = Array.from({ length: 8 }, (_, index) => String.fromCharCode(65 + index).repeat(64));
		const material = makeCertifiedGenesis({
			objectId: maximumObjectId(),
			profileId: "delegated-trusted-v1",
			quorum: 2,
			signerIds,
		});
		expect(new TextEncoder().encode(material.anchor.objectId as string)).toHaveLength(1024);
		expect(signerIds.every((signerId) => new TextEncoder().encode(signerId).byteLength === 64)).toBe(true);
		expect(makeExpectedTrustStateRecord(material)).toHaveLength(8190);
		expect(makeExpectedTrustStateRecord(material).byteLength).toBeLessThanOrEqual(contract.maximumRecordBytes);
	});

	it("[RED readiness] requires exactly the two reserved certified APIs", () => {
		expect(Object.keys(surface).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS);
		expect(typeof surface.installCertifiedAnchorTrustRoot).toBe("function");
		expect(typeof surface.openCertifiedAnchorTrust).toBe("function");
	});

	describe.skipIf(!HAS_CERTIFIED_APIS)("GREEN-only certified capability behavior", () => {
		it("installs and reopens delegated 2-of-3 and attested 3-of-4 material", () => {
			const { install, open } = requireCertifiedApis();
			for (const material of [
				makeCertifiedGenesis(),
				makeCertifiedGenesis({ profileId: "attested-bft-v1", quorum: 3 }),
			]) {
				const installed = install(installInput(material));
				expect(installed.ok).toBe(true);
				if (!installed.ok) continue;
				expect(installed.trust).toEqual({
					currentAnchorDigest: material.anchorDigest,
					currentEpoch: 0,
					genesisAnchorDigest: material.anchorDigest,
					objectId: material.anchor.objectId,
					profileId: material.profile.profileId,
					quorum: material.profile.quorum,
					signerCount: material.signers.length,
				});
				expect(Object.isFrozen(installed.trust)).toBe(true);
				const opened = open(openInput(installed.exactCanonicalTrustStateRecordBytes, material));
				expect(opened).toEqual({ ok: true, trust: installed.trust });
				expect(Object.isFrozen(opened)).toBe(true);
			}
		});

		it("rejects invalid quorum, signer cardinality and UTF-8 bounds", () => {
			const { install } = requireCertifiedApis();
			const cases = [
				[makeCertifiedGenesis({ quorum: 1 }), "invalid-quorum"],
				[makeCertifiedGenesis({ profileId: "attested-bft-v1", quorum: 2 }), "invalid-quorum"],
				[
					makeCertifiedGenesis({ profileId: "attested-bft-v1", quorum: 3, signerIds: ["a", "b", "c"] }),
					"invalid-quorum",
				],
				[
					makeCertifiedGenesis({ signerIds: Array.from({ length: 9 }, (_, index) => `signer-${index}`) }),
					"too-many-signers",
				],
				[makeCertifiedGenesis({ signerIds: ["a".repeat(65), "b", "c"] }), "signer-id-too-long"],
				[makeCertifiedGenesis({ objectId: `${"é".repeat(513)}:${"a".repeat(32)}` }), "object-id-too-long"],
			] as const;
			for (const [material, reason] of cases) expectFailure(install(installInput(material)), reason);
		});

		it("rejects every anchor, carrier, certificate and signer cross-binding", () => {
			const { install } = requireCertifiedApis();
			const material = makeCertifiedGenesis();
			const certificate = decodeCanonical(material.certificateBytes) as Record<string, unknown>;
			const signatures = certificate.signatures as readonly Readonly<Record<string, unknown>>[];
			const wrongKeyCertificate = encodeCanonical({
				...certificate,
				signatures: [{ ...signatures[0], publicKey: "0".repeat(64) }, ...signatures.slice(1)],
			});
			const invalidSignatureCertificate = encodeCanonical({
				...certificate,
				signatures: [{ ...signatures[0], signature: new Uint8Array(64) }, ...signatures.slice(1)],
			});
			const inputs: readonly [Readonly<Record<string, unknown>>, string][] = [
				[{ ...installInput(material), pinnedGenesisAnchorDigest: "f".repeat(64) }, "genesis-pin-mismatch"],
				[
					{
						...installInput(material),
						exactCanonicalProfileBytes: mutateCanonical(material.profileBytes, { quorum: 3 }),
					},
					"profile-digest-mismatch",
				],
				[
					{
						...installInput(material),
						exactCanonicalSignerSetBytes: encodeCanonical(material.signerSet.slice(1)),
					},
					"signer-set-digest-mismatch",
				],
				[
					{
						...installInput(material),
						exactCanonicalCertifiedGenesisCertificateBytes: mutateCanonical(material.certificateBytes, {
							genesisAnchorDigest: "e".repeat(64),
						}),
					},
					"certificate-binding-mismatch",
				],
				[
					{ ...installInput(material), exactCanonicalCertifiedGenesisCertificateBytes: wrongKeyCertificate },
					"certificate-signer-mismatch",
				],
				[
					{ ...installInput(material), exactCanonicalCertifiedGenesisCertificateBytes: invalidSignatureCertificate },
					"invalid-signature",
				],
			];
			for (const [input, reason] of inputs) expectFailure(install(input), reason);
		});

		it("rejects missing, duplicate, reordered and mismatched certificate signers", () => {
			const { install } = requireCertifiedApis();
			const material = makeCertifiedGenesis();
			const certificate = decodeCanonical(material.certificateBytes) as Record<string, unknown>;
			const rows = certificate.signatures as readonly Readonly<Record<string, unknown>>[];
			for (const signatures of [rows.slice(1), [...rows, rows[0]], [...rows].reverse()]) {
				expectFailure(
					install({
						...installInput(material),
						exactCanonicalCertifiedGenesisCertificateBytes: encodeCanonical({ ...certificate, signatures }),
					}),
					"certificate-signer-mismatch"
				);
			}
		});

		it("installs and reopens the 8190-byte maximum and rejects open bounds and stored-scalar drift", () => {
			const { install, open } = requireCertifiedApis();
			const material = makeCertifiedGenesis({
				objectId: maximumObjectId(),
				quorum: 2,
				signerIds: Array.from({ length: 8 }, (_, index) => String.fromCharCode(65 + index).repeat(64)),
			});
			const installed = install(installInput(material));
			expect(installed.ok).toBe(true);
			if (!installed.ok) return;
			expect(installed.exactCanonicalTrustStateRecordBytes).toHaveLength(8190);
			expect(open(openInput(installed.exactCanonicalTrustStateRecordBytes, material)).ok).toBe(true);
			expectFailure(open(openInput(new Uint8Array(8193), material)), "trust-state-too-large");
			expectFailure(
				open(openInput(mutateCanonical(installed.exactCanonicalTrustStateRecordBytes, { signerCount: 7 }), material)),
				"trust-state-inconsistent"
			);
		});

		it("keeps creator and certified records terminal and exports no live certified authority", () => {
			const { install, open } = requireCertifiedApis();
			const material = makeCertifiedGenesis();
			const installed = install(installInput(material));
			expect(installed.ok).toBe(true);
			if (!installed.ok) return;
			if (
				typeof surface.openCurrentAnchorTrust !== "function" ||
				typeof surface.installCreatorAnchorTrustRoot !== "function"
			) {
				throw new Error("creator trust APIs missing");
			}
			expect(
				(surface.openCurrentAnchorTrust(openInput(installed.exactCanonicalTrustStateRecordBytes, material)) as Failure)
					.ok
			).toBe(false);
			const creator = makeCreatorMaterial();
			expect(
				(
					open({
						exactCanonicalTrustStateRecordBytes: makeCreatorTrustStateRecord(creator),
						expectedObjectId: creator.anchor.objectId,
						pinnedGenesisAnchorDigest: creator.anchorDigest,
					}) as Failure
				).ok
			).toBe(false);
			for (const forbidden of [
				"authenticateCertifiedCurrentEpochAnchor",
				"closeCertifiedEpoch",
				"prepareCertifiedAnchorTrustAdvance",
				"subscribeCertifiedAnchor",
			])
				expect(surface).not.toHaveProperty(forbidden);
		});
	});
});
