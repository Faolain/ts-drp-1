import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import blueprintContract from "./fixtures/phase-0i-v3/blueprint-admission-package.json" with { type: "json" };
import equivocationContract from "./fixtures/phase-0o-v3/equivocation-contract.json" with { type: "json" };

const trustCustody = vi.hoisted(() => ({
	entries: [] as { readonly material: Readonly<Record<string, unknown>>; readonly trust: object }[],
}));

vi.mock("../packages/protocol-v3/src/internal/seal-authority-custody.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	const original = actual.resolveCreatorAnchorTrustMaterial as (trust: object) => unknown;
	return {
		...actual,
		resolveCreatorAnchorTrustMaterial(trust: object): unknown {
			return trustCustody.entries.find((entry) => entry.trust === trust)?.material ?? original(trust);
		},
	};
});

interface Result {
	readonly ok: boolean;
	readonly reason?: string;
}

interface SettlementSurface {
	readonly CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL: string;
	readonly CREATOR_AUTHOR_SETTLEMENT_KIND: string;
	readonly CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES: number;
	completeCreatorAuthorSettlement(input: unknown): Result & { readonly exactCanonicalRecordBytes?: Uint8Array };
	frontierCount(capability: object): number;
	frontierFor(capability: object, author: string): readonly [string, number, number | null] | undefined;
	openCreatorAuthorSettlement(input: unknown): Result & { readonly capability?: object };
	prepareCreatorAuthorSettlement(input: unknown): Result & {
		readonly digest?: string;
		readonly preparation?: object;
	};
	resolveCreatorAuthorSettlement(capability: object): Readonly<Record<string, unknown>> | undefined;
}

interface FenceSurface {
	readonly AUTHOR_FENCE_ACTION: string;
	openAuthorFenceOperation(input: unknown): Result & {
		readonly operation?: Readonly<{ action: string; fenceSequence: number; version: number }>;
	};
}

interface AdvanceSurface {
	inspectCreatorAuthorSettlementAdvance(input: unknown): Result;
}

interface ProtocolSurface {
	materializeCurrentEquivocationProof(input: unknown): unknown;
	prepareBlueprintAdmission(
		input: Readonly<{
			canonicalBlueprintPackageBytes: Uint8Array;
			expectedBlueprintDigest: string;
		}>
	): unknown;
	settlementProfileFor?(profileId: string): "none" | "v1";
	verifyReceivedVertex?(input: unknown): Readonly<{ readonly accepted: boolean }>;
}

interface LatchedAclSurface {
	openCanonicalLatchedAclSnapshot(input: unknown): Result & { readonly snapshot?: Readonly<Record<string, unknown>> };
}

const ROOT = resolve(import.meta.dirname, "..");
const SETTLEMENT_PATH = resolve(ROOT, "packages/protocol-v3/src/creator-author-issuance-frontiers.ts");
const ADVANCE_PATH = resolve(ROOT, "packages/node/src/internal/creator-transition-advance.ts");
const PROTOCOL_PATH = resolve(ROOT, "packages/protocol-v3/src/index.ts");
const ACL_PATH = resolve(ROOT, "packages/protocol-v3/src/latched-acl.ts");

async function optionalModule(path: string): Promise<Record<string, unknown>> {
	if (!existsSync(path)) return {};
	return import(`${pathToFileURL(path).href}?d110c0c1f5b0a=${Date.now()}`) as Promise<Record<string, unknown>>;
}

const settlementLoad = optionalModule(SETTLEMENT_PATH);
const advanceLoad = optionalModule(ADVANCE_PATH);
const protocolLoad = optionalModule(PROTOCOL_PATH);
const aclLoad = optionalModule(ACL_PATH);

function unavailable(reason: string): Result {
	return Object.freeze({ ok: false, reason });
}

async function settlementSurface(): Promise<SettlementSurface> {
	const loaded = await settlementLoad;
	const prepare = loaded.prepareCreatorAuthorSettlement ?? loaded.prepareCreatorAuthorIssuanceFrontiers;
	const complete = loaded.completeCreatorAuthorSettlement ?? loaded.completeCreatorAuthorIssuanceFrontiers;
	const open = loaded.openCreatorAuthorSettlement ?? loaded.openCreatorAuthorIssuanceFrontiers;
	const resolveIdentity = loaded.resolveCreatorAuthorSettlement ?? loaded.resolveCreatorAuthorIssuanceFrontiers;
	return {
		CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL:
			typeof loaded.CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL === "string"
				? loaded.CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL
				: (loaded.CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL as string),
		CREATOR_AUTHOR_SETTLEMENT_KIND:
			typeof loaded.CREATOR_AUTHOR_SETTLEMENT_KIND === "string"
				? loaded.CREATOR_AUTHOR_SETTLEMENT_KIND
				: (loaded.CREATOR_AUTHOR_ISSUANCE_FRONTIERS_KIND as string),
		CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES:
			typeof loaded.CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES === "number"
				? loaded.CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES
				: (loaded.CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES as number),
		completeCreatorAuthorSettlement:
			typeof complete === "function"
				? (complete as SettlementSurface["completeCreatorAuthorSettlement"])
				: (_input: unknown): Result => unavailable("D110C_0C1F5B0A_SETTLEMENT_CODEC_REQUIRED"),
		frontierCount:
			typeof loaded.frontierCount === "function"
				? (loaded.frontierCount as SettlementSurface["frontierCount"])
				: (_capability: object): number => -1,
		frontierFor:
			typeof loaded.frontierFor === "function"
				? (loaded.frontierFor as SettlementSurface["frontierFor"])
				: (_capability: object, _author: string): undefined => undefined,
		openCreatorAuthorSettlement:
			typeof open === "function"
				? (open as SettlementSurface["openCreatorAuthorSettlement"])
				: (_input: unknown): Result => unavailable("D110C_0C1F5B0A_SETTLEMENT_CODEC_REQUIRED"),
		prepareCreatorAuthorSettlement:
			typeof prepare === "function"
				? (prepare as SettlementSurface["prepareCreatorAuthorSettlement"])
				: (_input: unknown): Result => unavailable("D110C_0C1F5B0A_SETTLEMENT_CODEC_REQUIRED"),
		resolveCreatorAuthorSettlement:
			typeof resolveIdentity === "function"
				? (resolveIdentity as SettlementSurface["resolveCreatorAuthorSettlement"])
				: (_capability: object): undefined => undefined,
	};
}

async function fenceSurface(): Promise<FenceSurface> {
	const loaded = await protocolLoad;
	const verifyReceivedVertex = loaded.verifyReceivedVertex as ProtocolSurface["verifyReceivedVertex"];
	return {
		AUTHOR_FENCE_ACTION:
			typeof loaded.AUTHOR_FENCE_ACTION === "string" ? loaded.AUTHOR_FENCE_ACTION : "$drp.author-fence.v1",
		openAuthorFenceOperation:
			typeof loaded.openAuthorFenceOperation === "function"
				? (loaded.openAuthorFenceOperation as FenceSurface["openAuthorFenceOperation"])
				: (input: unknown): ReturnType<FenceSurface["openAuthorFenceOperation"]> => {
						if (input === null || typeof input !== "object" || verifyReceivedVertex === undefined) {
							return unavailable("D110C_0C1F5B0A_AUTHOR_FENCE_CODEC_REQUIRED");
						}
						const selected = input as {
							readonly authorSequence: number;
							readonly operation: Record<string, unknown>;
						};
						const seed = fromHex(equivocationContract.privateKeySeedHex);
						const publicKey = ed25519.getPublicKey(seed);
						const author = equivocationContract.author;
						const preimage = {
							anchor: equivocationContract.anchor,
							author,
							authorSequence: selected.authorSequence,
							dependencies: [...equivocationContract.dependencies],
							epoch: equivocationContract.epoch,
							kind: "drp-vertex",
							logicalTime: equivocationContract.logicalTime,
							objectId: equivocationContract.objectId,
							operation: selected.operation,
							protocolMajor: 3,
						};
						const bytes = encodeCanonical(preimage);
						const digest = hashDomain("ts-drp/vertex/v3", bytes);
						const verified = verifyReceivedVertex({
							domain: "ts-drp/vertex/v3",
							expectedAnchor: preimage.anchor,
							receivedCanonicalPreimageBytes: bytes,
							resolveAuthorPublicKey: (
								candidate: string
							): Readonly<{ bytes: Uint8Array; format: "raw" }> | undefined =>
								candidate === author ? { bytes: publicKey, format: "raw" } : undefined,
							signature: ed25519.sign(digest, seed),
							suiteId: "ed25519-sha256-v3",
						});
						return verified.accepted
							? {
									ok: true,
									operation: selected.operation as ReturnType<FenceSurface["openAuthorFenceOperation"]>["operation"],
								}
							: unavailable("D110C_0C1F5B0A_AUTHOR_FENCE_INVALID");
					},
	};
}

async function advanceSurface(): Promise<AdvanceSurface> {
	const loaded = await advanceLoad;
	const existing = loaded.inspectCreatorTransitionAdvance;
	return {
		inspectCreatorAuthorSettlementAdvance:
			typeof loaded.inspectCreatorAuthorSettlementAdvance === "function"
				? (loaded.inspectCreatorAuthorSettlementAdvance as AdvanceSurface["inspectCreatorAuthorSettlementAdvance"])
				: typeof existing === "function"
					? (existing as AdvanceSurface["inspectCreatorAuthorSettlementAdvance"])
					: (_input: unknown): Result => unavailable("D110C_0C1F5B0A_SETTLEMENT_ADVANCE_REQUIRED"),
	};
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function fromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
}

const OBJECT_ID = `creator:${"f".repeat(32)}`;
const GENESIS = "0".repeat(64);
const CURRENT_ANCHOR = "1".repeat(64);
const SUCCESSOR_ANCHOR = "2".repeat(64);
const CURRENT_ACL_DIGEST = "3".repeat(64);
const SUCCESSOR_ACL_DIGEST = "4".repeat(64);
const CURRENT_SEED = new Uint8Array(32).fill(0x11);
const SUCCESSOR_SEED = new Uint8Array(32).fill(0x22);
const CURRENT_TRUST = Object.freeze({
	currentAnchorDigest: CURRENT_ANCHOR,
	currentEpoch: 7,
	genesisAnchorDigest: GENESIS,
	objectId: OBJECT_ID,
	profileId: "creator-trusted-settlement-v1",
});
const SUCCESSOR_TRUST = Object.freeze({
	currentAnchorDigest: SUCCESSOR_ANCHOR,
	currentEpoch: 8,
	genesisAnchorDigest: GENESIS,
	objectId: OBJECT_ID,
	profileId: "creator-trusted-settlement-v1",
});

trustCustody.entries.push(
	{
		trust: CURRENT_TRUST,
		material: Object.freeze({
			currentAnchorDigest: CURRENT_ANCHOR,
			currentEpoch: 7,
			exactCanonicalCurrentAnchorPreimageBytes: encodeCanonical({ aclDigest: CURRENT_ACL_DIGEST }),
			genesisAnchorDigest: GENESIS,
			objectId: OBJECT_ID,
			publicKey: ed25519.getPublicKey(CURRENT_SEED),
			quorum: 1,
		}),
	},
	{
		trust: SUCCESSOR_TRUST,
		material: Object.freeze({
			currentAnchorDigest: SUCCESSOR_ANCHOR,
			currentEpoch: 8,
			exactCanonicalCurrentAnchorPreimageBytes: encodeCanonical({ aclDigest: SUCCESSOR_ACL_DIGEST }),
			genesisAnchorDigest: GENESIS,
			objectId: OBJECT_ID,
			publicKey: ed25519.getPublicKey(SUCCESSOR_SEED),
			quorum: 1,
		}),
	}
);

const AUTHORS = Object.freeze(["a".repeat(64), "b".repeat(64), "c".repeat(64)]);

function settlementPrepareInput(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
	return Object.freeze({
		commitQcRef: Object.freeze({ byteLength: 1234, digest: "5".repeat(64) }),
		currentAclDigest: CURRENT_ACL_DIGEST,
		currentTrust: CURRENT_TRUST,
		cutValueDigest: "6".repeat(64),
		frontiers: Object.freeze([Object.freeze([AUTHORS[0], 0, 10]), Object.freeze([AUTHORS[1], 2, null])]),
		historyRoot: "7".repeat(64),
		historySize: 17,
		priorCheckpointDigest: "8".repeat(64),
		priorCheckpointKind: "settled-v1",
		snapshotManifestDigest: "9".repeat(64),
		successorAclDigest: SUCCESSOR_ACL_DIGEST,
		successorTrust: SUCCESSOR_TRUST,
		...overrides,
	});
}

function settlementOpenInput(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	return Object.freeze({
		exactCanonicalRecordBytes: bytes,
		expectedCommitQcRef: Object.freeze({ byteLength: 1234, digest: "5".repeat(64) }),
		expectedCurrentAclDigest: CURRENT_ACL_DIGEST,
		expectedCutValueDigest: "6".repeat(64),
		expectedSnapshotManifestDigest: "9".repeat(64),
		expectedSuccessorAclDigest: SUCCESSOR_ACL_DIGEST,
		floorTrust: SUCCESSOR_TRUST,
	});
}

async function completeSettlement(
	input: Readonly<Record<string, unknown>> = settlementPrepareInput(),
	seed: Uint8Array = SUCCESSOR_SEED,
	expectCompletionSuccess = true
): Promise<
	Readonly<{
		readonly bytes?: Uint8Array;
		readonly completed?: Result & { readonly exactCanonicalRecordBytes?: Uint8Array };
		readonly prepared: Result;
	}>
> {
	const surface = await settlementSurface();
	const prepared = surface.prepareCreatorAuthorSettlement(input);
	expect(prepared, prepared.reason).toMatchObject({ ok: true });
	if (!prepared.ok || prepared.digest === undefined || prepared.preparation === undefined) return { prepared };
	const completed = surface.completeCreatorAuthorSettlement({
		detachedSignature: ed25519.sign(fromHex(prepared.digest), seed),
		preparation: prepared.preparation,
	});
	if (expectCompletionSuccess) expect(completed, completed.reason).toMatchObject({ ok: true });
	return { bytes: completed.exactCanonicalRecordBytes, completed, prepared };
}

function aclMember(author: string, version: 1 | 2 | 3, full: boolean): Readonly<Record<string, unknown>> {
	return Object.freeze({
		author,
		finalityKey: full ? author : null,
		groups: Object.freeze(
			full ? (version === 1 ? ["admin", "finality", "writer"] : ["admin", "finality", "referee", "writer"]) : ["writer"]
		),
	});
}

function aclSnapshot(version: 1 | 2 | 3, count: number, full = false): Readonly<Record<string, unknown>> {
	const members = Array.from({ length: count }, (_, index) =>
		aclMember(index.toString(16).padStart(64, "0"), version, full)
	);
	if (!members.some((member) => (member.groups as readonly string[]).includes("admin"))) {
		members[0] = aclMember("0".repeat(64), version, true);
	}
	return Object.freeze({
		epoch: 8,
		kind: "drp-v3-latched-acl",
		members: Object.freeze(members),
		objectId: OBJECT_ID,
		permissionless: false,
		version,
	});
}

function openAclInput(
	snapshot: Readonly<Record<string, unknown>>,
	expectedProfileId?: string
): Readonly<Record<string, unknown>> {
	const bytes = encodeCanonical(snapshot);
	return Object.freeze({
		exactCanonicalLatchedAclBytes: bytes,
		expectedAclDigest: hex(hashDomain("ts-drp/latched-acl/v3", bytes)),
		expectedEpoch: 8,
		expectedObjectId: OBJECT_ID,
		...(expectedProfileId === undefined ? {} : { expectedProfileId }),
	});
}

function maximumSettlementRecord(): Readonly<Record<string, unknown>> {
	const maximum = Number.MAX_SAFE_INTEGER;
	return Object.freeze({
		closedAnchorDigest: "1".repeat(64),
		closedEpoch: maximum - 1,
		commitQcRef: Object.freeze({ byteLength: maximum, digest: "2".repeat(64) }),
		currentAclDigest: "3".repeat(64),
		cutValueDigest: "4".repeat(64),
		detachedAuthoritySignature: new Uint8Array(64).fill(0xff),
		frontiers: Object.freeze(
			Array.from({ length: 256 }, (_, index) => Object.freeze([index.toString(16).padStart(64, "0"), maximum, maximum]))
		),
		genesisAnchorDigest: "5".repeat(64),
		historyRoot: "6".repeat(64),
		historySize: maximum,
		kind: "drp-creator-author-settlement-state",
		objectId: "o".repeat(256),
		priorCheckpointDigest: "7".repeat(64),
		priorCheckpointKind: "settled-v1",
		protocolMajor: 3,
		snapshotManifestDigest: "8".repeat(64),
		successorAclDigest: "9".repeat(64),
		successorAnchorDigest: "a".repeat(64),
		successorEpoch: maximum,
		version: 1,
	});
}

describe("D.110c-0c1f5b0a settlement protocol codecs RED", () => {
	it("pins the author-fence codec grammar at the outer author sequence with no artificial fence cap", async () => {
		const fence = await fenceSurface();
		const accepted = fence.openAuthorFenceOperation({
			authorSequence: equivocationContract.baseSequence,
			operation: {
				action: "$drp.author-fence.v1",
				fenceSequence: equivocationContract.baseSequence,
				version: 1,
			},
		});
		const rejected = (
			[
				[3, { action: "$drp.author-fence.v1", fenceSequence: 4, version: 1 }],
				[3, { action: "$drp.author-fence.v1", fenceSequence: -1, version: 1 }],
				[3, { action: "$drp.author-fence.v1", fenceSequence: 3, extra: true, version: 1 }],
				[3, { action: "$drp.author-fence.v1", fenceSequence: 3, version: 2 }],
			] as const
		).map(([authorSequence, operation]) => fence.openAuthorFenceOperation({ authorSequence, operation }));
		const maximum = fence.openAuthorFenceOperation({
			authorSequence: Number.MAX_SAFE_INTEGER,
			operation: { action: "$drp.author-fence.v1", fenceSequence: Number.MAX_SAFE_INTEGER, version: 1 },
		});
		expect({
			action: fence.AUTHOR_FENCE_ACTION,
			accepted,
			maximumAccepted: maximum.ok,
			rejected: rejected.map(({ ok }) => !ok),
		}).toEqual({
			action: "$drp.author-fence.v1",
			accepted: {
				ok: true,
				operation: {
					action: "$drp.author-fence.v1",
					fenceSequence: equivocationContract.baseSequence,
					version: 1,
				},
			},
			maximumAccepted: true,
			rejected: [true, true, true, true],
		});
	});

	it("rejects blueprints that attempt to register the globally reserved author-fence action", async () => {
		const protocol = (await protocolLoad) as unknown as ProtocolSurface;
		const reservedPackage = structuredClone(blueprintContract.package) as Record<string, unknown>;
		const manifest = reservedPackage.manifest as Record<string, unknown>;
		const operations = manifest.operations as unknown[];
		manifest.operations = [
			{
				argumentSchema: {
					fields: [
						{ name: "fenceSequence", required: true, type: "safe-integer" },
						{ name: "version", required: true, type: "safe-integer" },
					],
					kind: "closed-record",
				},
				name: "$drp.author-fence.v1",
			},
			...operations,
		];
		const bytes = encodeCanonical(reservedPackage);
		expect(() =>
			protocol.prepareBlueprintAdmission({
				canonicalBlueprintPackageBytes: bytes,
				expectedBlueprintDigest: hex(hashDomain(blueprintContract.blueprintDigestDomain, bytes)),
			})
		).toThrow(/reserved|author-fence/iu);
	});

	it("round-trips the exact triple checkpoint and exposes only detached per-author accessors", async () => {
		const completed = await completeSettlement();
		if (completed.bytes === undefined) return;
		const surface = await settlementSurface();
		const record = decodeCanonical(completed.bytes) as Readonly<Record<string, unknown>>;
		expect(record.detachedAuthoritySignature).toBeInstanceOf(Uint8Array);
		expect(record).not.toHaveProperty("detachedCreatorSignature");
		const opened = surface.openCreatorAuthorSettlement(settlementOpenInput(completed.bytes));
		expect(opened).toMatchObject({ ok: true });
		if (!opened.ok || opened.capability === undefined) return;
		const identity = surface.resolveCreatorAuthorSettlement(opened.capability);
		expect(identity).toMatchObject({
			closedAnchorDigest: CURRENT_ANCHOR,
			closedEpoch: 7,
			currentAclDigest: CURRENT_ACL_DIGEST,
			frontiers: [
				[AUTHORS[0], 0, 10],
				[AUTHORS[1], 2, null],
			],
			objectId: OBJECT_ID,
			successorAclDigest: SUCCESSOR_ACL_DIGEST,
			successorAnchorDigest: SUCCESSOR_ANCHOR,
			successorEpoch: 8,
		});
		expect(identity).not.toHaveProperty("kind");
		expect(surface.frontierCount(opened.capability)).toBe(2);
		expect(surface.frontierFor(opened.capability, AUTHORS[1] as string)).toEqual([AUTHORS[1], 2, null]);
		expect(surface.frontierFor(opened.capability, AUTHORS[2] as string)).toBeUndefined();
		expect(surface.frontierCount(Object.freeze({}))).toBe(0);
		expect(surface.frontierFor(Object.freeze({}), AUTHORS[0] as string)).toBeUndefined();
	});

	it("signs with successor authority and cold-opens with floor trust only, without predecessor bytes", async () => {
		const raw = await settlementLoad;
		if (typeof raw.prepareCreatorAuthorSettlement !== "function") {
			const legacyPrepare = raw.prepareCreatorAuthorIssuanceFrontiers as (input: unknown) => Result;
			expect(
				legacyPrepare({
					commitQcRef: { byteLength: 1234, digest: "5".repeat(64) },
					currentAclDigest: CURRENT_ACL_DIGEST,
					currentTrust: CURRENT_TRUST,
					cutValueDigest: "6".repeat(64),
					frontiers: [[AUTHORS[0], 10]],
					priorAggregateCandidateDigest: raw.CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
					snapshotManifestDigest: "9".repeat(64),
					successorAclDigest: SUCCESSOR_ACL_DIGEST,
					successorTrust: SUCCESSOR_TRUST,
				})
			).toMatchObject({ ok: true });
		}
		const completed = await completeSettlement(
			settlementPrepareInput({ priorCheckpointDigest: "d".repeat(64), priorCheckpointKind: "settled-v1" })
		);
		if (completed.bytes === undefined) return;
		const surface = await settlementSurface();
		const openInput = settlementOpenInput(completed.bytes);
		expect(openInput).not.toHaveProperty("currentTrust");
		expect(openInput).not.toHaveProperty("predecessor");
		expect(surface.openCreatorAuthorSettlement(openInput)).toMatchObject({ ok: true });

		const signedByCurrent = await completeSettlement(settlementPrepareInput(), CURRENT_SEED, false);
		expect(signedByCurrent.completed).toMatchObject({ ok: false, reason: "SIGNATURE_INVALID" });
		expect(signedByCurrent.bytes).toBeUndefined();
	});

	it("keeps predecessor checks shape-only in the opener and rejects malformed predecessor fields", async () => {
		const unknown = await completeSettlement(
			settlementPrepareInput({ priorCheckpointDigest: "e".repeat(64), priorCheckpointKind: "settled-v1" })
		);
		if (unknown.bytes === undefined) return;
		const surface = await settlementSurface();
		expect(surface.openCreatorAuthorSettlement(settlementOpenInput(unknown.bytes))).toMatchObject({ ok: true });
		for (const mutation of [
			{ priorCheckpointDigest: "short" },
			{ priorCheckpointKind: "issuance-frontiers-v1" },
			{ priorCheckpointKind: "genesis", priorCheckpointDigest: "not-a-digest" },
		]) {
			expect(surface.prepareCreatorAuthorSettlement(settlementPrepareInput(mutation))).toMatchObject({ ok: false });
		}
	});

	it("puts ACL membership, genesis admission, adjacency, and monotonicity in the bounded advance predicate", async () => {
		const surface = await advanceSurface();
		const currentAuthors = Object.freeze(["0".repeat(64), "1".repeat(64)] as const);
		const successorAuthors = Object.freeze([...currentAuthors, "2".repeat(64)] as const);
		const membersFor = (authors: readonly string[]): readonly Readonly<Record<string, unknown>>[] =>
			Object.freeze(authors.map((author, index) => aclMember(author, 3, index === 0)));
		const currentAcl = Object.freeze({
			...aclSnapshot(3, currentAuthors.length),
			epoch: 0,
			members: membersFor(currentAuthors),
		});
		const successorAcl = Object.freeze({
			...aclSnapshot(3, successorAuthors.length),
			epoch: 1,
			members: membersFor(successorAuthors),
		});
		const proposed = Object.freeze({
			closedEpoch: 0,
			frontiers: Object.freeze([
				Object.freeze([successorAuthors[0], 0, 0]),
				Object.freeze([successorAuthors[1], 0, null]),
				Object.freeze([successorAuthors[2], 1, null]),
			]),
			priorCheckpointDigest: "f".repeat(64),
			priorCheckpointKind: "genesis",
			successorEpoch: 1,
		});
		const genesisInput = Object.freeze({ currentAcl, predecessor: null, proposed, successorAcl });
		const genesisAdvance = surface.inspectCreatorAuthorSettlementAdvance(genesisInput);
		expect(genesisAdvance, genesisAdvance.reason).toMatchObject({ ok: true });
		for (const frontiers of [
			[
				["0".repeat(64), 1, 0],
				["1".repeat(64), 0, null],
				["2".repeat(64), 1, null],
			],
			[
				["0".repeat(64), 0, 0],
				["1".repeat(64), 0, null],
				["2".repeat(64), 0, null],
			],
			[
				["0".repeat(64), 0, 0],
				["1".repeat(64), 0, null],
			],
			[
				["0".repeat(64), 0, 0],
				["1".repeat(64), 0, null],
				["2".repeat(64), 1, null],
				["3".repeat(64), 1, null],
			],
		]) {
			expect(
				surface.inspectCreatorAuthorSettlementAdvance({
					...genesisInput,
					proposed: { ...proposed, frontiers },
				})
			).toMatchObject({ ok: false });
		}

		const predecessor = Object.freeze({
			candidateDigest: "a".repeat(64),
			closedEpoch: 0,
			frontiers: Object.freeze([
				Object.freeze(["0".repeat(64), 0, 5]),
				Object.freeze(["1".repeat(64), 0, null]),
				Object.freeze(["2".repeat(64), 1, null]),
			]),
			successorEpoch: 1,
		});
		const retained = Object.freeze({
			closedEpoch: 1,
			frontiers: Object.freeze([Object.freeze(["0".repeat(64), 0, 6]), Object.freeze(["2".repeat(64), 1, 2])]),
			priorCheckpointDigest: predecessor.candidateDigest,
			priorCheckpointKind: "settled-v1",
			successorEpoch: 2,
		});
		const retainedInput = Object.freeze({
			currentAcl: successorAcl,
			predecessor,
			proposed: retained,
			successorAcl: Object.freeze({
				...successorAcl,
				epoch: 2,
				members: Object.freeze([successorAcl.members[0], successorAcl.members[2]]),
			}),
		});
		expect(surface.inspectCreatorAuthorSettlementAdvance(retainedInput)).toMatchObject({ ok: true });
		for (const mutation of [
			{
				frontiers: [
					["0".repeat(64), 1, 6],
					["2".repeat(64), 1, 2],
				],
			},
			{
				frontiers: [
					["0".repeat(64), 0, 4],
					["2".repeat(64), 1, 2],
				],
			},
			{ priorCheckpointDigest: "b".repeat(64) },
			{ closedEpoch: 2, successorEpoch: 3 },
		]) {
			expect(
				surface.inspectCreatorAuthorSettlementAdvance({
					...retainedInput,
					proposed: { ...retained, ...mutation },
				})
			).toMatchObject({ ok: false });
		}
	});

	it("pins the 256-line maximum below 32768 bytes and rejects 257 lines and 32769 input bytes", async () => {
		const surface = await settlementSurface();
		const maximumBytes = encodeCanonical(maximumSettlementRecord());
		expect(maximumBytes.byteLength).toBe(23_450);
		expect(maximumBytes.byteLength).toBeLessThan(32_768);
		const accepted256 = surface.prepareCreatorAuthorSettlement(
			settlementPrepareInput({
				frontiers: Array.from({ length: 256 }, (_, index) => [
					index.toString(16).padStart(64, "0"),
					Number.MAX_SAFE_INTEGER,
					Number.MAX_SAFE_INTEGER,
				]),
			})
		);
		const rejected257 = surface.prepareCreatorAuthorSettlement(
			settlementPrepareInput({
				frontiers: Array.from({ length: 257 }, (_, index) => [index.toString(16).padStart(64, "0"), 0, null]),
			})
		);
		const rejected32769 = surface.openCreatorAuthorSettlement({
			...settlementOpenInput(new Uint8Array(32_769)),
			exactCanonicalRecordBytes: new Uint8Array(32_769),
		});
		expect({
			accepted256: accepted256.ok,
			kind: surface.CREATOR_AUTHOR_SETTLEMENT_KIND,
			maximumRecordBytes: surface.CREATOR_AUTHOR_SETTLEMENT_MAX_RECORD_BYTES,
			rejected257: !rejected257.ok,
			rejected32769: !rejected32769.ok,
		}).toEqual({
			accepted256: true,
			kind: "drp-creator-author-settlement-state",
			maximumRecordBytes: 32_768,
			rejected257: true,
			rejected32769: true,
		});
	});

	it("admits ACL version 3 only for settlement profile at cap 256 and retains versions 1/2 cap 64", async () => {
		const acl = (await aclLoad) as unknown as LatchedAclSurface;
		const writerInput = openAclInput(aclSnapshot(3, 256), "creator-trusted-settlement-v1");
		const fullInput = openAclInput(aclSnapshot(3, 256, true), "creator-trusted-settlement-v1");
		expect((writerInput.exactCanonicalLatchedAclBytes as Uint8Array).byteLength).toBeLessThan(65_536);
		expect((fullInput.exactCanonicalLatchedAclBytes as Uint8Array).byteLength).toBeLessThan(65_536);
		const oversized = new Uint8Array(65_537);
		const results = {
			full256: acl.openCanonicalLatchedAclSnapshot(fullInput).ok,
			legacyV1Rejects65: !acl.openCanonicalLatchedAclSnapshot(openAclInput(aclSnapshot(1, 65))).ok,
			legacyV2Rejects65: !acl.openCanonicalLatchedAclSnapshot(openAclInput(aclSnapshot(2, 65))).ok,
			oldDecoderRejectsV3: !acl.openCanonicalLatchedAclSnapshot(openAclInput(aclSnapshot(3, 64))).ok,
			rejects257: !acl.openCanonicalLatchedAclSnapshot(
				openAclInput(aclSnapshot(3, 257), "creator-trusted-settlement-v1")
			).ok,
			rejects65537: !acl.openCanonicalLatchedAclSnapshot({
				exactCanonicalLatchedAclBytes: oversized,
				expectedAclDigest: hex(hashDomain("ts-drp/latched-acl/v3", oversized)),
				expectedEpoch: 8,
				expectedObjectId: OBJECT_ID,
				expectedProfileId: "creator-trusted-settlement-v1",
			}).ok,
			wrongProfileRejectsV3: !acl.openCanonicalLatchedAclSnapshot(
				openAclInput(aclSnapshot(3, 64), "creator-trusted-v1")
			).ok,
			writer256: acl.openCanonicalLatchedAclSnapshot(writerInput).ok,
		};
		expect(results).toEqual({
			full256: true,
			legacyV1Rejects65: true,
			legacyV2Rejects65: true,
			oldDecoderRejectsV3: true,
			rejects257: true,
			rejects65537: true,
			wrongProfileRejectsV3: true,
			writer256: true,
		});
	});

	it("centralizes the settlement profile predicate and routes all seven consumers through it", async () => {
		const protocol = (await protocolLoad) as unknown as ProtocolSurface;
		const consumers = [
			"packages/protocol-v3/src/creator-author-issuance-frontiers.ts",
			"packages/protocol-v2/src/registry.ts",
			"packages/control-plane/src/creator-trust-checkpoint-advance.ts",
			"packages/node/src/internal/creator-transition-advance.ts",
			"packages/node/src/creator-close.ts",
			"packages/node/src/v3-live.ts",
			"examples/v3-room/src/index.ts",
		] as const;
		const missing = consumers.filter((path) => {
			const absolute = resolve(ROOT, path);
			return !existsSync(absolute) || !readFileSync(absolute, "utf8").includes("settlementProfileFor(");
		});
		const predicate = protocol.settlementProfileFor ?? (() => "none" as const);
		expect({
			delegated: predicate("delegated-trusted-v1"),
			legacy: predicate("creator-trusted-v1"),
			missingConsumers: missing,
			settlement: predicate("creator-trusted-settlement-v1"),
		}).toEqual({ delegated: "none", legacy: "none", missingConsumers: [], settlement: "v1" });
	});

	it("rejects cross-anchor same-slot witnesses instead of materializing equivocation evidence", async () => {
		const protocol = (await protocolLoad) as unknown as ProtocolSurface;
		const seed = fromHex(equivocationContract.privateKeySeedHex);
		const publicKey = ed25519.getPublicKey(seed);
		const author = equivocationContract.author;
		const preimage = (operation: string, anchor: string): Readonly<Record<string, unknown>> => ({
			anchor,
			author,
			authorSequence: equivocationContract.baseSequence,
			dependencies: [...equivocationContract.dependencies],
			epoch: equivocationContract.epoch,
			kind: "drp-vertex",
			logicalTime: equivocationContract.logicalTime,
			objectId: equivocationContract.objectId,
			operation: { action: operation },
			protocolMajor: 3,
		});
		const witness = (operation: string, expectedAnchor: string): Readonly<Record<string, unknown>> => {
			const receivedCanonicalPreimageBytes = encodeCanonical(preimage(operation, expectedAnchor));
			const digest = hashDomain("ts-drp/vertex/v3", receivedCanonicalPreimageBytes);
			return {
				digest,
				witness: {
					domain: "ts-drp/vertex/v3",
					expectedAnchor,
					receivedCanonicalPreimageBytes,
					signature: ed25519.sign(digest, seed),
					suiteId: "ed25519-sha256-v3",
				},
			};
		};
		const materialized = protocol.materializeCurrentEquivocationProof({
			resolveAuthorPublicKey: (candidate: string) =>
				candidate === author ? { bytes: publicKey, format: "raw" as const } : undefined,
			scope: {
				author,
				authorSequence: equivocationContract.baseSequence,
				objectId: equivocationContract.objectId,
			},
			vertices: [witness("left", equivocationContract.anchor), witness("right", "b".repeat(64))],
		});
		expect(materialized).toBeUndefined();
	});
});
