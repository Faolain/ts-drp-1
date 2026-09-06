import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { REPOSITORY_ROOT } from "./fixtures/phase-6a-v3/creator-successor-activation-contract.js";
import {
	D108D2_AUTHORITY_KEYS,
	D108D2_BROWSER_BEHAVIORS,
	D108D2_FORBIDDEN_PRODUCT_RETURNS,
	d108d2HasClosedProductReturns,
	d108d2SourceGovernance,
	D108E2B_BROWSER_BEHAVIORS,
	D108E2B_GREEN_PATHS,
	D108E2B_RED_PATHS,
	D108E2C_PRODUCT_BROWSER_BEHAVIORS,
	D108E3_BROWSER_BEHAVIORS,
	D108E3_GREEN_PATHS,
	D108E3_RED_PATHS,
	D108E5_BROWSER_BEHAVIORS,
	d108e5SourceOwnership,
	isD108d2Authority,
} from "./fixtures/phase-6a-v3/creator-successor-product-contract.js";
import { createV3ChatApplication } from "../examples/v3-chat/src/index.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type V3RoomCreatorInviteMaterial,
} from "../examples/v3-room/src/index.js";

function replaceExactlyOnce(source: string, before: string, after: string): string {
	const index = source.indexOf(before);
	if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
		throw new TypeError("D.108e5 source mutant seam is not unique");
	}
	return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

describe("D.108d2 public return AST oracle", () => {
	it("accepts private computations and primitive comparisons without confusing operand names with returned authority", () => {
		for (const source of [
			"function unused() { return capability; } export function room() { return { ready: true }; }",
			"function readSettlementEffect(progress) { return progress.intentCount === 2 && progress.intentDigest !== undefined; } export function room() { return { ready: readSettlementEffect(progress) }; }",
			"export function room() { return { ready: capability === undefined, intentCount: 2, intentDigest: 'public-digest' }; }",
			"export function room() { const privateHelper = () => ({ capability }); return Object.freeze({ ready: true }); }",
			"// return capability\nexport function room() { return 'return signingAuthority'; }",
		])
			expect.soft(d108d2HasClosedProductReturns(source), source).toBe(true);
	});
	it("rejects exact sensitive properties and values on exported returned shapes", () => {
		expect(D108D2_FORBIDDEN_PRODUCT_RETURNS).toEqual([
			"intent",
			"capability",
			"activationResult",
			"exactCanonicalTrust",
			"snapshotReceipt",
			"signingAuthority",
			"displacedSource",
		]);
		for (const name of D108D2_FORBIDDEN_PRODUCT_RETURNS) {
			for (const expression of [name, `{ ${name}: safe }`, `{ safe: ${name} }`]) {
				expect
					.soft(d108d2HasClosedProductReturns(`export function room() { return ${expression}; }`), expression)
					.toBe(false);
			}
		}
	});
	it("tracks the returned operands of assignment, comma and logical assignment expressions", () => {
		for (const expression of [
			"safe = capability",
			"(safe, capability)",
			"safe &&= capability",
			"safe ||= capability",
			"safe ??= capability",
			"capability &&= safe",
			"capability ||= safe",
			"capability ??= safe",
			"safe = (other, { capability })",
		])
			expect
				.soft(d108d2HasClosedProductReturns(`export function room() { return (${expression}); }`), expression)
				.toBe(false);
		for (const expression of ["capability = true", "(capability, true)", "safe += capability", "capability === safe"])
			expect
				.soft(d108d2HasClosedProductReturns(`export function room() { return (${expression}); }`), expression)
				.toBe(true);
	});
	it("follows local returned aliases, helpers, methods, export aliases and global product surfaces", () => {
		for (const source of [
			"const result = { capability }; export function room() { return result; }",
			"const result = { intent }; export const room = () => Object.freeze({ ...result });",
			"function privateOwner() { return { activationResult }; } export function room() { return privateOwner(); }",
			"export function room() { return Promise.resolve({ ['capability']: owner.capability }); }",
			"export function room() { return { read() { return snapshotReceipt; } }; }",
			"const room = () => ({ exactCanonicalTrust }); export { room };",
			"const api = { read() { return displacedSource; } }; Object.defineProperty(globalThis, 'room', { value: api });",
			"Object.assign(window, { room() { return capability; } });",
		])
			expect.soft(d108d2HasClosedProductReturns(source), source).toBe(false);
		expect(d108d2HasClosedProductReturns("export function malformed( {")).toBe(false);
	});
});

describe("D.108e2b creator successor room lifetime RED", () => {
	it("freezes exactly five RED owners, one GREEN owner and seven browser behaviors", () => {
		expect(D108E2B_RED_PATHS).toHaveLength(5);
		expect(new Set(D108E2B_RED_PATHS).size).toBe(5);
		expect(D108E2B_GREEN_PATHS).toEqual(["examples/v3-room/src/index.ts"]);
		expect(D108E2B_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(D108D2_BROWSER_BEHAVIORS).toHaveLength(3);
		expect(D108E2B_BROWSER_BEHAVIORS).toHaveLength(4);
		const browser = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts"),
			"utf8"
		);
		const entry = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts"),
			"utf8"
		);
		expect(browser).not.toContain("PRODUCT_READY");
		expect(browser).not.toContain("test.skip(");
		expect(
			[
				'"@ts-drp/node/creator-adoption"',
				'"@ts-drp/node/creator-adoption-activate"',
				'"@ts-drp/node/creator-adoption-commit"',
			].every((alias) => browser.includes(alias))
		).toBe(true);
		expect(entry).toContain("openExistingDatabase(`${databaseName}--ahe`)");
		expect(entry).toContain("dumpDatabase(`${databaseName}--ahe`)");
	});

	it("pins the exact seven-key successor authority and rejects pre-successor or widened values", () => {
		const authority = Object.freeze({
			aclDigest: "a".repeat(64),
			anchorDigest: "b".repeat(64),
			epoch: 1,
			genesisAnchorDigest: "c".repeat(64),
			lifecycle: "active",
			objectId: "d108d2-object",
			profileId: "creator-trusted-v1",
		});
		expect(D108D2_AUTHORITY_KEYS).toEqual([
			"aclDigest",
			"anchorDigest",
			"epoch",
			"genesisAnchorDigest",
			"lifecycle",
			"objectId",
			"profileId",
		]);
		expect(isD108d2Authority(authority)).toBe(true);
		expect(isD108d2Authority({ ...authority, epoch: 0 })).toBe(false);
		expect(isD108d2Authority({ ...authority, capability: {} })).toBe(false);
		expect(isD108d2Authority(null)).toBe(false);
	});

	it("keeps node-root and chat authority closed while assigning the room as sole node consumer", () => {
		expect(d108d2SourceGovernance()).toEqual({
			chatHasNoDirectNodeAdoptionConsumer: true,
			chatOwnsOnlyReviewedRoomHeadCapability: true,
			chatInputAllowsOnlyDeclarationWhenProductExists: true,
			noForbiddenProductReturn: true,
			noNodeRootWidening: true,
			roomInputAllowsOnlyDeclarationWhenProductExists: true,
			roomIsSoleConsumerWhenProductExists: true,
		});
	});

	it("runs all product behaviors without a source-pattern readiness gate", () => {
		expect(D108D2_BROWSER_BEHAVIORS).toHaveLength(3);
		expect(D108E2B_BROWSER_BEHAVIORS).toHaveLength(4);
	});

	it("rejects only unsupported cold successor compositions before reading room authorities", async () => {
		const exercise = async (
			extra: Readonly<Record<string, unknown>>,
			includeDeclaration: boolean
		): Promise<Readonly<Record<string, unknown>>> => {
			const reads = { application: 0, signer: 0, store: 0, transport: 0 };
			const input = {
				...extra,
				get application(): never {
					reads.application += 1;
					throw new TypeError("D.108e2b application authority was read");
				},
				get databaseName(): never {
					reads.store += 1;
					throw new TypeError("D.108e2b store authority was read");
				},
				get openTransport(): never {
					reads.transport += 1;
					throw new TypeError("D.108e2b transport authority was read");
				},
				get signRegisteredVertexDigest(): never {
					reads.signer += 1;
					throw new TypeError("D.108e2b signer authority was read");
				},
				...(includeDeclaration ? { successorSnapshotDeclaration: Object.freeze({}) } : {}),
			};
			let detail = "fulfilled";
			try {
				await createV3RoomSession(input as never);
			} catch (error) {
				detail = error instanceof Error ? error.message : String(error);
			}
			return Object.freeze({ detail, reads: Object.freeze({ ...reads }) });
		};

		const unsupported = [];
		for (const [key, value] of [
			["createOperationAdmissionPolicy", (): Readonly<Record<string, never>> => Object.freeze({})],
			["creatorFinalitySigner", Object.freeze({ sign: () => Promise.resolve(new Uint8Array(64)) })],
			["rebaseSourceInvite", "d108e2b-source-invite"],
		] as const) {
			unsupported.push(Object.freeze({ ...(await exercise({ [key]: value }, true)), key }));
		}
		expect(unsupported).toEqual(
			["createOperationAdmissionPolicy", "creatorFinalitySigner", "rebaseSourceInvite"].map((key) => ({
				detail: "v3 room successor authority composition is unsupported",
				key,
				reads: { application: 0, signer: 0, store: 0, transport: 0 },
			}))
		);

		const supported = await Promise.all([
			exercise({ createOperationAdmissionPolicy: (): Readonly<Record<string, never>> => Object.freeze({}) }, false),
			exercise({ creatorFinalitySigner: Object.freeze({}) }, false),
			exercise({ rebaseSourceInvite: "d108e2b-source-invite" }, false),
			exercise({}, true),
		]);
		expect(supported).toEqual(
			Array.from({ length: 4 }, () => ({
				detail: "D.108e2b application authority was read",
				reads: { application: 1, signer: 0, store: 0, transport: 0 },
			}))
		);
	});
});

describe("D.108e3 room lifetime transition RED", () => {
	it("freezes four test owners, one room GREEN owner and twelve causal browser behaviors", () => {
		expect(D108E3_RED_PATHS).toEqual([
			"tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts",
			"tests/phase-6a-creator-successor-product-red.test.ts",
			"packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts",
			"packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts",
		]);
		expect(new Set(D108E3_RED_PATHS).size).toBe(4);
		expect(D108E3_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(D108E3_GREEN_PATHS).toEqual(["examples/v3-room/src/index.ts"]);
		expect(D108E3_BROWSER_BEHAVIORS).toEqual([
			"cleanup failure preserves the predecessor failure in an ordered aggregate",
			"activation failure remains primary while close joins adoption",
			"drain failure still shuts down and releases browser ownership",
			"drain and shutdown failure preserve ordered primary and cleanup errors",
			"rehearsal blocks later adoption until its migration record releases",
			"activation blocks later adoption until terminal transition releases",
			"adoption blocks later rehearsal until verification releases",
			"adoption blocks later activation until verification releases",
			"overlapping rehearsal retains the existing fast-fail fence",
			"independent room sessions do not share one lifetime queue",
			"a failed adoption releases the lifetime queue for retry",
			"accepted-vertex failure cannot deadlock queued adoption and shutdown",
		]);
		expect(D108E2C_PRODUCT_BROWSER_BEHAVIORS).toHaveLength(2);
		expect(D108E5_BROWSER_BEHAVIORS).toEqual([
			"redirect-pending adoption stays ahead of rehearsal",
			"redirect-pending adoption stays ahead of activation",
			"activation bytes are bounded before call-time copy",
			"migration invites are bounded before call-time encoding",
		]);
		expect(D108E3_RED_PATHS.some((path) => /examples\/v3-chat|packages\/node|playwright.*config/u.test(path))).toBe(
			false
		);
	});
});

describe("D.108e5 bounded redirected lifetime RED", () => {
	it("bounds migration activation bytes before constructing the call-time owner", () => {
		expect(d108e5SourceOwnership().activationBoundPrecedesCopy).toBe(true);
		const room = readFileSync(resolve(REPOSITORY_ROOT, "examples/v3-room/src/index.ts"), "utf8");
		const liveOwner = [
			'\t\t\tif (byteLength > 49_152) throw new TypeError("v3 room migration activation record is unbounded");',
			"\t\t\tconst copiedRecordBytes = new INTRINSIC_UINT8_ARRAY(byteLength);",
			"\t\t\tReflect.apply(INTRINSIC_UINT8_ARRAY_SET, copiedRecordBytes, [",
			"\t\t\t\tnew INTRINSIC_UINT8_ARRAY(backing, byteOffset, byteLength),",
			"\t\t\t]);",
			"\t\t\tcapturedRecordBytes = copiedRecordBytes;",
		].join("\n");
		const deadNestedOwner = replaceExactlyOnce(
			room,
			liveOwner,
			[
				"\t\t\tconst ignoredActivationOwner = (): void => {",
				liveOwner,
				"\t\t\t};",
				"\t\t\tvoid ignoredActivationOwner;",
			].join("\n")
		);
		expect(d108e5SourceOwnership(deadNestedOwner).activationBoundPrecedesCopy).toBe(false);
	});

	it("bounds every migration invite encode before copying caller-controlled bodies", () => {
		expect(d108e5SourceOwnership().migrationInviteBoundOwnsEveryEncode).toBe(true);
		const room = readFileSync(resolve(REPOSITORY_ROOT, "examples/v3-room/src/index.ts"), "utf8");
		const deadSnapshotOwner = replaceExactlyOnce(
			room,
			"\t\treturn boundedMigrationCreatorInvite(value);",
			[
				"\t\tconst ignoredBoundedInvite = (): unknown => boundedMigrationCreatorInvite(value);",
				"\t\tvoid ignoredBoundedInvite;",
				"\t\treturn value;",
			].join("\n")
		);
		expect(d108e5SourceOwnership(deadSnapshotOwner).migrationInviteBoundOwnsEveryEncode).toBe(false);

		const deadRehearsalOwner = replaceExactlyOnce(
			room,
			"\t\tconst targetMaterial = decodeCreatorInvite(boundedMigrationCreatorInvite(targetInviteValue));",
			[
				"\t\tconst ignoredBoundedInvite = (): unknown =>",
				"\t\t\tdecodeCreatorInvite(boundedMigrationCreatorInvite(targetInviteValue));",
				"\t\tvoid ignoredBoundedInvite;",
				"\t\tconst targetMaterial = decodeCreatorInvite(targetInviteValue);",
			].join("\n")
		);
		expect(d108e5SourceOwnership(deadRehearsalOwner).migrationInviteBoundOwnsEveryEncode).toBe(false);

		const alternateActivationOwner = replaceExactlyOnce(
			room,
			"\t\tconst targetCreatorInvite = decodeCreatorInvite(boundedMigrationCreatorInvite(targetInviteValue));",
			[
				"\t\tconst targetCreatorInvite = true",
				"\t\t\t? decodeCreatorInvite(boundedMigrationCreatorInvite(targetInviteValue))",
				"\t\t\t: decodeCreatorInvite(targetInviteValue);",
			].join("\n")
		);
		expect(d108e5SourceOwnership(alternateActivationOwner).migrationInviteBoundOwnsEveryEncode).toBe(false);

		const deadMetadataOwners = replaceExactlyOnce(
			replaceExactlyOnce(
				room,
				"\t\tconst fields = exactRecord(value, CREATOR_INVITE_MATERIAL_KEYS);",
				[
					"\t\tconst ignoredExactRecord = (): unknown => exactRecord(value, CREATOR_INVITE_MATERIAL_KEYS);",
					"\t\tvoid ignoredExactRecord;",
					"\t\tconst fields = value as Readonly<Record<string, unknown>>;",
				].join("\n")
			),
			"\t\t\t\tbyteLength = Reflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER, fieldValue, []);",
			[
				"\t\t\t\tconst ignoredByteLength = (): unknown =>",
				"\t\t\t\t\tReflect.apply(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH_GETTER, fieldValue, []);",
				"\t\t\t\tvoid ignoredByteLength;",
				"\t\t\t\tbyteLength = 1;",
			].join("\n")
		);
		expect(d108e5SourceOwnership(deadMetadataOwners).migrationInviteBoundOwnsEveryEncode).toBe(false);
	});
});

async function roomAuthorityReadOrderFixtures(): Promise<
	readonly Readonly<{
		profileId: "creator-trusted-v1" | "creator-trusted-settlement-v1";
		invite: V3RoomCreatorInviteMaterial;
	}>[]
> {
	const seed = new Uint8Array(32).fill(153);
	const publicKey = ed25519.getPublicKey(seed);
	const author = Buffer.from(publicKey).toString("hex");
	const objectId = "creator:0000000000000000000000000000d108";
	const blueprintDigest = createV3ChatApplication("alice").catalog.blueprintDigests[0];
	if (blueprintDigest === undefined) throw new TypeError("F5B_ROOM_GUARD_FIXTURE_BLUEPRINT");
	const signers = Object.freeze([Object.freeze({ publicKey: author, signerId: "creator" })]);
	const fixtures = [];
	for (const profileId of ["creator-trusted-v1", "creator-trusted-settlement-v1"] as const) {
		const invite = await createV3RoomCreatorInviteMaterial({
			blueprintDigest,
			exactCanonicalApplicationStateBytes: encodeCanonical([]),
			exactCanonicalLatchedAclBytes: encodeCanonical({
				epoch: 0,
				kind: "drp-v3-latched-acl",
				members: Object.freeze([
					Object.freeze({
						author,
						finalityKey: author,
						groups: Object.freeze(["admin", "finality", "writer"]),
					}),
				]),
				objectId,
				permissionless: false,
				version: profileId === "creator-trusted-v1" ? 1 : 3,
			}),
			exactCanonicalParametersCarrierBytes: encodeCanonical({
				maxDependencies: 16,
				maxEpochBytes: 8_388_608,
				maxEpochVertices: 8192,
				maxPendingBytes: 16_777_216,
				maxPendingEntries: 4096,
				maxSnapshotBytes: 268_435_456,
				snapshotChunkBytes: 131_072,
			}),
			exactCanonicalProfileBytes: encodeCanonical({
				cryptoSuiteId: "ed25519-sha256-v3",
				profileId,
				quorum: 1,
				signers,
			}),
			exactCanonicalSignerSetBytes: encodeCanonical(signers),
			objectId,
			signGenesisAnchorDigest: (digest) => Promise.resolve(ed25519.sign(digest, seed)),
		});
		const anchorDigest = hashDomain("ts-drp/epoch-anchor/v3", invite.exactCanonicalGenesisAnchorPreimageBytes);
		const anchor = decodeCanonical(invite.exactCanonicalGenesisAnchorPreimageBytes) as Record<string, unknown>;
		if (
			Buffer.from(anchorDigest).toString("hex") !== invite.pinnedGenesisAnchorDigest ||
			!ed25519.verify(invite.detachedGenesisSignature, anchorDigest, publicKey) ||
			anchor.objectId !== objectId ||
			anchor.epoch !== 0
		) {
			throw new TypeError("F5B_ROOM_GUARD_FIXTURE_GENESIS");
		}
		for (const [key, domain, bytes] of [
			["aclDigest", "ts-drp/latched-acl/v3", invite.exactCanonicalLatchedAclBytes],
			["parametersDigest", "ts-drp/parameters/v3", invite.exactCanonicalParametersCarrierBytes],
			["profileDigest", "ts-drp/profile/v3", invite.exactCanonicalProfileBytes],
			["signerSetDigest", "ts-drp/signer-set/v3", invite.exactCanonicalSignerSetBytes],
		] as const) {
			if (
				!Buffer.from(encodeCanonical(decodeCanonical(bytes))).equals(Buffer.from(bytes)) ||
				anchor[key] !== Buffer.from(hashDomain(domain, bytes)).toString("hex")
			) {
				throw new TypeError("F5B_ROOM_GUARD_FIXTURE_CARRIER");
			}
		}
		fixtures.push(Object.freeze({ profileId, invite }));
	}
	return Object.freeze(fixtures);
}

it("classifies complete legacy and settlement successor compositions before reading room authorities", async () => {
	const fixtures = await roomAuthorityReadOrderFixtures();
	const observations = [];
	const expected = [];
	for (const { profileId, invite } of fixtures) {
		for (const composition of ["factory", "rebase", "signer", "declaration-only"] as const) {
			const reads = { application: 0, signer: 0, store: 0, transport: 0 };
			// The declaration is deliberately never consumed at this ordering boundary.
			// Reaching application proves classification only, not signer trust or activation.
			const input = {
				creatorInvite: invite,
				successorSnapshotDeclaration: Object.freeze({}),
				...(composition === "factory"
					? { createOperationAdmissionPolicy: (): Readonly<Record<string, never>> => Object.freeze({}) }
					: {}),
				...(composition === "rebase" ? { rebaseSourceInvite: invite } : {}),
				...(composition === "signer"
					? { creatorFinalitySigner: Object.freeze({ sign: () => Promise.resolve(new Uint8Array(64)) }) }
					: {}),
				get application(): never {
					reads.application += 1;
					throw new TypeError("D.108e2b application authority was read");
				},
				get databaseName(): never {
					reads.store += 1;
					throw new TypeError("D.108e2b store authority was read");
				},
				get openTransport(): never {
					reads.transport += 1;
					throw new TypeError("D.108e2b transport authority was read");
				},
				get signRegisteredVertexDigest(): never {
					reads.signer += 1;
					throw new TypeError("D.108e2b signer authority was read");
				},
			};
			let detail = "fulfilled";
			try {
				await createV3RoomSession(input as never);
			} catch (error) {
				detail = error instanceof Error ? error.message : String(error);
			}
			observations.push(Object.freeze({ profileId, composition, detail, reads: Object.freeze({ ...reads }) }));
			const permitted =
				composition === "declaration-only" ||
				(composition === "signer" && profileId === "creator-trusted-settlement-v1");
			expected.push({
				profileId,
				composition,
				detail: permitted
					? "D.108e2b application authority was read"
					: "v3 room successor authority composition is unsupported",
				reads: { application: permitted ? 1 : 0, signer: 0, store: 0, transport: 0 },
			});
		}
	}
	console.log(JSON.stringify({ kind: "F5B_ROOM_GUARD_OBSERVATIONS", observations }));
	expect(observations, "F5B_ROOM_GUARD_PROFILE_AUTHORITY_READ_ORDER").toEqual(expected);
});
