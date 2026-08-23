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
const LATCHED_ACL_ARTIFACT_SOURCE = `function aclReducer(input){return {output:null,state:input.state}}function addReducer(input){const value=input.operation.value??1;const state=input.state+value;return {output:state,state}}function readReducer(input){return {output:input.state,state:input.state}}function setReducer(input){const state=input.operation.value??0;return {output:state,state}}export const blueprint={exportSchemaVersion:1,artifactId:"counter.v1",runtimeProfile:"ecmascript-2024-sync-v1",reducers:{acl:aclReducer,add:addReducer,"read-value":readReducer,set:setReducer}};`;
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
	readonly anchorDigest: string;
	readonly anchorPublicKey: Uint8Array;
	readonly author: string;
	readonly authors: readonly string[];
	readonly authorPublicKey: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalAuthorAuthorizationBytes: Uint8Array;
	readonly exactCanonicalLatchedAclBytes: Uint8Array | undefined;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly detachedAnchorSignature: Uint8Array;
	readonly capability: PreparedV3Live;
	readonly descriptor: V3LiveDescriptor;
	readonly recoveryCanonicalPreimageBytes: Uint8Array;
	readonly recoverySignature: Uint8Array;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	readonly receivedSignature: Uint8Array;
	readonly objectId: string;
	readonly parameters: typeof PARAMETERS;
	signRegisteredVertexDigest(digest: Uint8Array): Promise<Uint8Array>;
	createRegisteredVertex(
		input: Readonly<{
			readonly anchor?: string;
			readonly authorSequence: number;
			readonly dependencies: readonly string[];
			readonly epoch?: number;
			readonly logicalTime: number;
			readonly objectId?: string;
			readonly operation: Readonly<Record<string, unknown>>;
			readonly privateKeySeedHex: string;
			readonly protocolMajor?: number;
		}>
	): Readonly<{
		readonly author: string;
		readonly canonicalPreimageBytes: Uint8Array;
		readonly digest: Uint8Array;
		readonly signature: Uint8Array;
	}>;
	createRecoveryVertex(
		authorSequence: number,
		dependencies: readonly string[]
	): Readonly<{
		readonly canonicalPreimageBytes: Uint8Array;
		readonly digest: Uint8Array;
		readonly signature: Uint8Array;
	}>;
	prepareAgain(): Promise<Readonly<{ capability: PreparedV3Live; descriptor: V3LiveDescriptor }>>;
	close(): Promise<void>;
}

export interface GenuinePreparedV3FixtureOptions {
	readonly anchorPrivateKeySeedHex?: string;
	readonly authorizationMode?: "latched-acl" | "legacy-author-list";
	readonly authorizedPrivateKeySeedHexes?: readonly string[];
	readonly historyRoot?: string;
	readonly historySize?: number;
	readonly objectId?: string;
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

function blueprintFixture(authorizationMode: "latched-acl" | "legacy-author-list"): BlueprintFixture {
	const exactArtifactBytes = new TextEncoder().encode(
		authorizationMode === "latched-acl" ? LATCHED_ACL_ARTIFACT_SOURCE : readFileSync(ARTIFACT, "utf8")
	);
	const artifactDigest = lowerHex(hashDomain(packageGolden.artifactDigestDomain, exactArtifactBytes));
	const packageRecord = Object.freeze({
		...packageGolden.package,
		implementation: Object.freeze({ ...packageGolden.package.implementation, artifactDigest }),
		manifest:
			authorizationMode === "latched-acl"
				? Object.freeze({
						...packageGolden.package.manifest,
						operations: Object.freeze([
							Object.freeze({
								argumentSchema: Object.freeze({
									fields: Object.freeze([
										Object.freeze({ name: "group", required: true, type: "string" }),
										Object.freeze({ name: "kind", required: true, type: "string" }),
										Object.freeze({ name: "target", required: true, type: "string" }),
									]),
									kind: "closed-record",
								}),
								name: "acl",
							}),
							...packageGolden.package.manifest.operations,
						]),
					})
				: packageGolden.package.manifest,
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

function catalog(fixture: BlueprintFixture): TrustedBlueprintCatalog {
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
		const authorizationMode = options.authorizationMode ?? "legacy-author-list";
		const fixture = blueprintFixture(authorizationMode);
		const anchorPrivateKeySeedHex = options.anchorPrivateKeySeedHex ?? contract.privateKeySeedHex;
		const objectIdValue = options.objectId ?? `creator:${"a".repeat(32)}`;
		const base = makeCreatorMaterial({ objectId: objectIdValue, privateKeySeedHex: anchorPrivateKeySeedHex });
		const authorizedPrivateKeySeedHexes = options.authorizedPrivateKeySeedHexes ?? [contract.privateKeySeedHex];
		if (authorizedPrivateKeySeedHexes.length === 0) throw new TypeError("deterministic Seam3 author roster is invalid");
		const issuingAuthor = bytesHex(ed25519.getPublicKey(hexBytes(authorizedPrivateKeySeedHexes[0] as string)));
		const authors = Object.freeze(
			authorizedPrivateKeySeedHexes
				.map((seed) => bytesHex(ed25519.getPublicKey(hexBytes(seed))))
				.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
		);
		if (authors.length === 0 || new Set(authors).size !== authors.length) {
			throw new TypeError("deterministic Seam3 author roster is invalid");
		}
		const author = issuingAuthor;
		const exactCanonicalAuthorAuthorizationBytes = encodeCanonical({
			authors,
			epoch: 0,
			kind: "drp-author-authorization",
			objectId: base.anchor.objectId,
			profileId: "creator-author-authorization-v1",
			protocolMajor: 3,
			version: 1,
		});
		const exactCanonicalLatchedAclBytes =
			authorizationMode === "latched-acl"
				? encodeCanonical({
						epoch: 0,
						kind: "drp-v3-latched-acl",
						members: authors.map((selectedAuthor) => ({
							author: selectedAuthor,
							finalityKey: selectedAuthor,
							groups: ["admin", "finality", "writer"],
						})),
						objectId: base.anchor.objectId,
						permissionless: false,
						version: 1,
					})
				: undefined;
		const anchor = Object.freeze({
			...base.anchor,
			aclDigest:
				exactCanonicalLatchedAclBytes === undefined
					? lowerHex(hashDomain("ts-drp/author-authorization/v3", exactCanonicalAuthorAuthorizationBytes))
					: lowerHex(hashDomain("ts-drp/latched-acl/v3", exactCanonicalLatchedAclBytes)),
			blueprintDigest: fixture.blueprintDigest,
			historyRoot: options.historyRoot ?? base.anchor.historyRoot,
			historySize: options.historySize ?? base.anchor.historySize,
			parametersDigest: lowerHex(hashDomain("ts-drp/parameters/v3", encodeCanonical(PARAMETERS))),
		});
		const anchorBytes = encodeCanonical(anchor);
		const anchorDigest = bytesHex(independentHashDomain(contract.anchorDigestDomain, anchorBytes));
		const signature = ed25519.sign(hexBytes(anchorDigest), hexBytes(anchorPrivateKeySeedHex));
		const objectId: StorageObjectId = must(parseStorageObjectId(objectIdValue));
		const trust = createCurrentAnchorTrustStore({ objectId, pinnedGenesisAnchorDigest: anchorDigest, store });
		const installed = await trust.install({
			detachedGenesisSignature: signature,
			exactCanonicalGenesisAnchorPreimageBytes: anchorBytes,
			exactCanonicalProfileBytes: base.profileBytes,
			exactCanonicalSignerSetBytes: base.signerSetBytes,
			pinnedGenesisAnchorDigest: anchorDigest,
		});
		if (!installed.ok) throw new TypeError(`trust install failed: ${installed.reason}`);
		const exactCanonicalParametersCarrierBytes = encodeCanonical(PARAMETERS);
		const input = Object.freeze({
			authenticationProfile: "creator-only",
			store,
			objectId,
			pinnedGenesisAnchorDigest: anchorDigest,
			exactCanonicalAnchorPreimageBytes: new Uint8Array(anchorBytes),
			detachedSignature: new Uint8Array(signature),
			exactCanonicalParametersCarrierBytes: new Uint8Array(exactCanonicalParametersCarrierBytes),
			catalog: catalog(fixture),
		});
		const prepared = await prepareV3LiveGeneration(input);
		if (!prepared.ok) throw new TypeError(`live preparation failed: ${"kind" in prepared ? prepared.kind : "unknown"}`);
		const receivedDependencyDigest = prepared.descriptor.anchorDigest;
		const vertexInput = {
			kind: "drp-vertex",
			protocolMajor: 3,
			objectId,
			epoch: 0,
			anchor: anchorDigest,
			authorSequence: 0,
			logicalTime: 1,
			dependencies: [receivedDependencyDigest],
			operation: { action: "add", value: 1 },
		};
		const receivedCanonicalPreimageBytes = encodeCanonical({ ...vertexInput, author });
		const receivedDigest = hashDomain("ts-drp/vertex/v3", receivedCanonicalPreimageBytes);
		const recoveryCanonicalPreimageBytes = encodeCanonical({ ...vertexInput, author });
		const recoveryDigest = hashDomain("ts-drp/vertex/v3", recoveryCanonicalPreimageBytes);
		const result: GenuinePreparedV3Fixture = {
			anchorDigest,
			anchorPublicKey: ed25519.getPublicKey(hexBytes(anchorPrivateKeySeedHex)),
			author,
			authors,
			authorPublicKey: ed25519.getPublicKey(hexBytes(authorizedPrivateKeySeedHexes[0] as string)),
			capability: prepared.capability,
			exactCanonicalAnchorPreimageBytes: new Uint8Array(anchorBytes),
			exactCanonicalAuthorAuthorizationBytes: new Uint8Array(exactCanonicalAuthorAuthorizationBytes),
			exactCanonicalLatchedAclBytes:
				exactCanonicalLatchedAclBytes === undefined ? undefined : new Uint8Array(exactCanonicalLatchedAclBytes),
			exactCanonicalParametersCarrierBytes: new Uint8Array(exactCanonicalParametersCarrierBytes),
			detachedAnchorSignature: new Uint8Array(signature),
			descriptor: prepared.descriptor,
			objectId: String(objectId),
			parameters: PARAMETERS,
			recoveryCanonicalPreimageBytes,
			recoverySignature: ed25519.sign(recoveryDigest, hexBytes(authorizedPrivateKeySeedHexes[0] as string)),
			receivedCanonicalPreimageBytes,
			receivedSignature: ed25519.sign(receivedDigest, hexBytes(authorizedPrivateKeySeedHexes[0] as string)),
			createRegisteredVertex(vertex) {
				const selectedAuthor = bytesHex(ed25519.getPublicKey(hexBytes(vertex.privateKeySeedHex)));
				const canonicalPreimageBytes = encodeCanonical({
					anchor: vertex.anchor ?? anchorDigest,
					author: selectedAuthor,
					authorSequence: vertex.authorSequence,
					dependencies: [...vertex.dependencies],
					epoch: vertex.epoch ?? 0,
					kind: "drp-vertex",
					logicalTime: vertex.logicalTime,
					objectId: vertex.objectId ?? objectId,
					operation: vertex.operation,
					protocolMajor: vertex.protocolMajor ?? 3,
				});
				const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
				return Object.freeze({
					author: selectedAuthor,
					canonicalPreimageBytes,
					digest,
					signature: ed25519.sign(digest, hexBytes(vertex.privateKeySeedHex)),
				});
			},
			createRecoveryVertex(authorSequence, dependencies) {
				const canonicalPreimageBytes = encodeCanonical({
					...vertexInput,
					author,
					authorSequence,
					dependencies: [...dependencies],
					logicalTime: authorSequence + 1,
				});
				const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
				return Object.freeze({
					canonicalPreimageBytes,
					digest,
					signature: ed25519.sign(digest, hexBytes(authorizedPrivateKeySeedHexes[0] as string)),
				});
			},
			signRegisteredVertexDigest(digest) {
				return Promise.resolve(
					ed25519.sign(new Uint8Array(digest), hexBytes(authorizedPrivateKeySeedHexes[0] as string))
				);
			},
			async prepareAgain() {
				const next = await prepareV3LiveGeneration(input);
				if (!next.ok) throw new TypeError(`live preparation retry failed: ${"kind" in next ? next.kind : "unknown"}`);
				return Object.freeze({ capability: next.capability, descriptor: next.descriptor });
			},
			async close(): Promise<void> {
				await store.close();
				rmSync(directory, { force: true, recursive: true });
			},
		};
		return Object.freeze(result);
	} catch (error) {
		await store.close();
		rmSync(directory, { force: true, recursive: true });
		throw error;
	}
}
