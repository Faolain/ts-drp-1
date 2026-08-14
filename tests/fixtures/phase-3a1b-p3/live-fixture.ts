import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import { type AheDurableStore, parseStorageObjectId, type StorageObjectId } from "@ts-drp/storage";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TrustedBlueprintCatalog } from "../../../packages/blueprint-catalog/src/index.js";
import {
	prepareV3LiveGeneration as defaultPrepareV3LiveGeneration,
	type PreparedV3Live,
	type V3LiveDescriptor,
} from "../../../packages/node/src/v3-live.js";
import { createSqliteAheDurableStore as createBuiltSqliteAheDurableStore } from "../../../packages/storage-node/dist/src/index.js";
import {
	bytesHex,
	contract,
	hexBytes,
	independentHashDomain,
	makeCreatorMaterial,
} from "../phase-3a0-v3/controlled-anchor-trust.js";
import packageGolden from "../track-p2-b/forward-counter-package.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ARTIFACT = path.join(ROOT, "tests/fixtures/track-p2-c/primary.mjs");
const PARAMETERS = Object.freeze({
	maxEpochVertices: 8192,
	maxEpochBytes: 8_388_608,
	maxDependencies: 16,
	snapshotChunkBytes: 131_072,
	maxSnapshotBytes: 268_435_456,
	maxPendingEntries: 4096,
	maxPendingBytes: 16_777_216,
});

interface BlueprintFixture {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly exactArtifactBytes: Uint8Array;
}

export interface GenuinePreparedV3Fixture {
	readonly authorPublicKey: Uint8Array;
	readonly capability: PreparedV3Live;
	readonly descriptor: V3LiveDescriptor;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	readonly receivedSignature: Uint8Array;
	prepareAgain(): Promise<Readonly<{ capability: PreparedV3Live; descriptor: V3LiveDescriptor }>>;
	close(): Promise<void>;
}

export interface GenuinePreparedV3FixtureOptions {
	readonly prepareV3LiveGeneration?: typeof defaultPrepareV3LiveGeneration;
}

export type PrepareV3LiveGenerationForFixture = typeof defaultPrepareV3LiveGeneration;

const createSqliteAheDurableStore = createBuiltSqliteAheDurableStore as unknown as (input: {
	readonly filename: string;
}) => AheDurableStore;

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
	if (!result.ok) throw new TypeError("invalid deterministic Seam3 fixture");
	return result.value;
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function blueprintFixture(): BlueprintFixture {
	const exactArtifactBytes = new TextEncoder().encode(readFileSync(ARTIFACT, "utf8"));
	const artifactDigest = lowerHex(hashDomain(packageGolden.artifactDigestDomain, exactArtifactBytes));
	const packageRecord = Object.freeze({
		...packageGolden.package,
		implementation: Object.freeze({ ...packageGolden.package.implementation, artifactDigest }),
	});
	const canonicalBlueprintPackageBytes = encodeCanonical(packageRecord);
	return Object.freeze({
		artifactDigest,
		artifactId: packageRecord.implementation.artifactId,
		blueprintDigest: lowerHex(hashDomain(packageGolden.blueprintDigestDomain, canonicalBlueprintPackageBytes)),
		canonicalBlueprintPackageBytes,
		exactArtifactBytes,
	});
}

function catalog(): TrustedBlueprintCatalog {
	const fixture = blueprintFixture();
	return Object.freeze({
		blueprintDigests: Object.freeze([fixture.blueprintDigest]),
		catalogDigest: "9".repeat(64),
		resolve(requested: string) {
			if (requested !== fixture.blueprintDigest) throw new TypeError("not catalogued");
			return Object.freeze({
				artifactDigest: fixture.artifactDigest,
				artifactId: fixture.artifactId,
				blueprintDigest: fixture.blueprintDigest,
				canonicalBlueprintPackageBytes: new Uint8Array(fixture.canonicalBlueprintPackageBytes),
				exactArtifactBytes: new Uint8Array(fixture.exactArtifactBytes),
				runtimeProfile: "ecmascript-2024-sync-v1" as const,
				evidence: Object.freeze({
					catalogDigest: "9".repeat(64),
					lintEvidenceDigest: "a".repeat(64),
					conformanceReceiptDigest: "b".repeat(64),
					conformanceDigest: "c".repeat(64),
					conformanceTier: "nightly" as const,
					conformanceResult: "passed" as const,
					engines: Object.freeze([
						Object.freeze({ name: "node" as const, build: "node-test" }),
						Object.freeze({ name: "chromium" as const, build: "chromium-test" }),
						Object.freeze({ name: "firefox" as const, build: "firefox-test" }),
						Object.freeze({ name: "webkit" as const, build: "webkit-test" }),
					]),
				}),
			});
		},
	});
}

/**
 * Mint one genuine private A capability through the shipped trust/preparation path.
 * @param options - Optional same-module preparation owner used by isolated private-owner evidence.
 * @returns The genuine token, descriptor, and deterministic cleanup owner.
 */
export async function createGenuinePreparedV3Fixture(
	options: GenuinePreparedV3FixtureOptions = {}
): Promise<GenuinePreparedV3Fixture> {
	const directory = mkdtempSync(path.join(tmpdir(), "drp-seam3-token-"));
	const store = createSqliteAheDurableStore({ filename: path.join(directory, "store.sqlite") });
	const prepareV3LiveGeneration = options.prepareV3LiveGeneration ?? defaultPrepareV3LiveGeneration;
	try {
		const fixture = blueprintFixture();
		const base = makeCreatorMaterial({ objectId: `creator:${"a".repeat(32)}` });
		const anchor = Object.freeze({
			...base.anchor,
			blueprintDigest: fixture.blueprintDigest,
			parametersDigest: lowerHex(hashDomain("ts-drp/parameters/v3", encodeCanonical(PARAMETERS))),
		});
		const anchorBytes = encodeCanonical(anchor);
		const anchorDigest = bytesHex(independentHashDomain(contract.anchorDigestDomain, anchorBytes));
		const signature = ed25519.sign(hexBytes(anchorDigest), hexBytes(contract.privateKeySeedHex));
		const objectId: StorageObjectId = must(parseStorageObjectId(String(anchor.objectId)));
		const trust = createCurrentAnchorTrustStore({ objectId, pinnedGenesisAnchorDigest: anchorDigest, store });
		const installed = await trust.install({
			detachedGenesisSignature: signature,
			exactCanonicalGenesisAnchorPreimageBytes: anchorBytes,
			exactCanonicalProfileBytes: base.profileBytes,
			exactCanonicalSignerSetBytes: base.signerSetBytes,
			pinnedGenesisAnchorDigest: anchorDigest,
		});
		if (!installed.ok) throw new TypeError(`trust install failed: ${installed.reason}`);
		const input = Object.freeze({
			authenticationProfile: "creator-only",
			store,
			objectId,
			pinnedGenesisAnchorDigest: anchorDigest,
			exactCanonicalAnchorPreimageBytes: new Uint8Array(anchorBytes),
			detachedSignature: new Uint8Array(signature),
			exactCanonicalParametersCarrierBytes: encodeCanonical(PARAMETERS),
			catalog: catalog(),
		});
		const prepared = await prepareV3LiveGeneration(input);
		if (!prepared.ok) throw new TypeError(`live preparation failed: ${"kind" in prepared ? prepared.kind : "unknown"}`);
		const receivedCanonicalPreimageBytes = encodeCanonical({
			kind: "drp-vertex",
			protocolMajor: 3,
			objectId,
			epoch: 0,
			anchor: anchorDigest,
			author: contract.signerId,
			authorSequence: 0,
			logicalTime: 0,
			dependencies: [],
			operation: { action: "add", value: 1 },
		});
		const receivedDigest = hashDomain("ts-drp/vertex/v3", receivedCanonicalPreimageBytes);
		return Object.freeze({
			authorPublicKey: ed25519.getPublicKey(hexBytes(contract.privateKeySeedHex)),
			capability: prepared.capability,
			descriptor: prepared.descriptor,
			receivedCanonicalPreimageBytes,
			receivedSignature: ed25519.sign(receivedDigest, hexBytes(contract.privateKeySeedHex)),
			async prepareAgain() {
				const next = await prepareV3LiveGeneration(input);
				if (!next.ok) throw new TypeError(`live preparation retry failed: ${"kind" in next ? next.kind : "unknown"}`);
				return Object.freeze({ capability: next.capability, descriptor: next.descriptor });
			},
			async close(): Promise<void> {
				await store.close();
				rmSync(directory, { force: true, recursive: true });
			},
		});
	} catch (error) {
		await store.close();
		rmSync(directory, { force: true, recursive: true });
		throw error;
	}
}
