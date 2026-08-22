import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { EMPTY_MERKLE_ROOT } from "@ts-drp/compaction";
import { Keychain } from "@ts-drp/keychain";
import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
	createV3RoomCreatorInviteMaterial as exportedCreateV3RoomCreatorInviteMaterial,
	V3RoomCreatorInviteMaterial,
	V3RoomCreatorInviteMaterialInput,
} from "../examples/v3-room/src/index.js";

type GenesisAnchorSigner = (digest: Uint8Array) => Promise<Uint8Array>;

interface ExpectedCreatorInviteInput {
	readonly blueprintDigest: string;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly objectId: string;
	readonly signGenesisAnchorDigest: GenesisAnchorSigner;
	readonly stateDigest: string;
}

interface ExpectedCreatorInviteMaterial {
	readonly detachedGenesisSignature: Uint8Array;
	readonly exactCanonicalGenesisAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly pinnedGenesisAnchorDigest: string;
}

type CreateCreatorInviteMaterial = (input: V3RoomCreatorInviteMaterialInput) => Promise<V3RoomCreatorInviteMaterial>;

const builderProbe = vi.hoisted(() => ({
	inputs: [] as unknown[],
	materials: [] as unknown[],
	roomCreatorInvites: [] as unknown[],
}));

vi.mock("../packages/storage-browser/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
}));

vi.mock("../examples/v3-room/src/index.js", async (importOriginal) => {
	const current = await importOriginal<Record<string, unknown>>();
	return {
		...current,
		createV3RoomCreatorInviteMaterial: vi.fn(async (input: V3RoomCreatorInviteMaterialInput) => {
			builderProbe.inputs.push(input);
			const builder = Reflect.get(current, "createV3RoomCreatorInviteMaterial");
			if (typeof builder !== "function") throw new Error("PHASE_3_EXIT_A_GENESIS_BUILDER_ABSENT");
			const material = (await Reflect.apply(builder, undefined, [input])) as V3RoomCreatorInviteMaterial;
			builderProbe.materials.push(material);
			return material;
		}),
		createV3RoomSession: vi.fn((input: Readonly<{ readonly creatorInvite: unknown; readonly objectId: string }>) => {
			builderProbe.roomCreatorInvites.push(input.creatorInvite);
			return Promise.resolve(
				Object.freeze({
					close: () => Promise.resolve(),
					invite: "00",
					issue: () => Promise.resolve(),
					openEphemeral: () =>
						Object.freeze({
							close: () => undefined,
							publish: () => Promise.resolve(true),
							subscribe: (): (() => void) => () => undefined,
						}),
					previewLatchedAcl: () => Object.freeze({}),
					projection: () => Object.freeze({}),
					roomId: input.objectId,
					trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.",
				})
			);
		}),
	};
});

const actualRoom = await vi.importActual<Record<string, unknown>>("../examples/v3-room/src/index.js");
const candidate = Reflect.get(actualRoom, "createV3RoomCreatorInviteMaterial");
const createMaterial = candidate as CreateCreatorInviteMaterial;

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function emptyRootHex(): string {
	return createHash("sha256").update(new Uint8Array()).digest("hex");
}

function digest(domain: string, value: Uint8Array): string {
	return hex(hashDomain(domain, value));
}

function baseInput(
	onSign: (digestBytes: Uint8Array) => Promise<Uint8Array> = () => Promise.resolve(new Uint8Array(64).fill(0x5a))
): V3RoomCreatorInviteMaterialInput {
	return {
		blueprintDigest: "11".repeat(32),
		exactCanonicalLatchedAclBytes: encodeCanonical({ acl: "latched" }),
		exactCanonicalParametersCarrierBytes: encodeCanonical({ maxEpochBytes: 8_388_608 }),
		exactCanonicalProfileBytes: encodeCanonical({ profileId: "creator-trusted-v1" }),
		exactCanonicalSignerSetBytes: encodeCanonical([{ publicKey: "22".repeat(32), signerId: "creator" }]),
		objectId: `creator:${"33".repeat(16)}`,
		signGenesisAnchorDigest(digestBytes: Uint8Array): Promise<Uint8Array> {
			return onSign(digestBytes);
		},
		stateDigest: "44".repeat(32),
	};
}

function decodeAnchor(material: V3RoomCreatorInviteMaterial): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(material.exactCanonicalGenesisAnchorPreimageBytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("invalid test anchor");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

function enrollmentHex(): string {
	return hex(
		encodeCanonical({
			author: "66".repeat(32),
			kind: "ts-drp-v3-zone-enrollment",
			peerId: "peer:member",
			version: 1,
		})
	);
}

const EXPECTED_PARAMETERS = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

async function expectedChatAcl(objectId: string): Promise<Uint8Array> {
	const clients = [
		["alice", "d9336-v3-chat-alice"],
		["bob", "d9336-v3-chat-bob"],
		["carol", "d9339-v3-chat-carol"],
		["dave", "d9339-v3-chat-dave"],
		["erin", "d9339-v3-chat-erin"],
		["frank", "d9339-v3-chat-frank"],
		["grace", "d9339-v3-chat-grace"],
		["heidi", "d9339-v3-chat-heidi"],
	] as const;
	const authors = new Map<string, string>();
	for (const [clientId, seed] of clients) {
		const keychain = new Keychain({ private_key_seed: seed });
		await keychain.start();
		authors.set(clientId, keychain.localAuthorId);
	}
	return encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: clients
			.map(([clientId]) => {
				const author = authors.get(clientId);
				if (author === undefined) throw new TypeError("missing expected chat author");
				const groups =
					clientId === "alice"
						? ["admin", "finality", "writer"]
						: clientId === "bob"
							? ["admin", "writer"]
							: clientId === "dave"
								? ["finality"]
								: ["writer"];
				return Object.freeze({
					author,
					finalityKey: clientId === "alice" || clientId === "dave" ? author : null,
					groups: Object.freeze(groups),
				});
			})
			.sort((left, right) => (left.author < right.author ? -1 : left.author > right.author ? 1 : 0)),
		objectId,
		permissionless: false,
		version: 1,
	});
}

function expectProductInput(
	input: V3RoomCreatorInviteMaterialInput,
	expected: Readonly<{
		readonly acl: Uint8Array;
		readonly blueprintDigest: string;
		readonly objectId: string;
		readonly signerAuthor: string;
	}>
): void {
	expect(input.objectId).toBe(expected.objectId);
	expect(input.blueprintDigest).toBe(expected.blueprintDigest);
	expect(input.stateDigest).toBe("7".repeat(64));
	expect(input.exactCanonicalLatchedAclBytes).toEqual(expected.acl);
	expect(input.exactCanonicalParametersCarrierBytes).toEqual(encodeCanonical(EXPECTED_PARAMETERS));
	const signerSet = encodeCanonical([{ publicKey: expected.signerAuthor, signerId: "creator" }]);
	expect(input.exactCanonicalSignerSetBytes).toEqual(signerSet);
	expect(input.exactCanonicalProfileBytes).toEqual(
		encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: "creator-trusted-v1",
			quorum: 1,
			signers: [{ publicKey: expected.signerAuthor, signerId: "creator" }],
		})
	);
	expect(input.signGenesisAnchorDigest).toBeTypeOf("function");
}

async function expectProductSigner(input: V3RoomCreatorInviteMaterialInput, signer: Keychain): Promise<void> {
	const digestBytes = hashDomain("ts-drp/phase-3-exit-a/product-signer-probe/v1", encodeCanonical(input.objectId));
	const signature = await input.signGenesisAnchorDigest(new Uint8Array(digestBytes));
	expect(signature).toEqual(await signer.signWithLocalAuthor(new Uint8Array(digestBytes)));
}

describe("D.93.56 Phase 3 exit-a shared genesis-root builder RED", () => {
	it("fails RED only because the shared room builder is absent", () => {
		expectTypeOf<V3RoomCreatorInviteMaterialInput>().toEqualTypeOf<ExpectedCreatorInviteInput>();
		expectTypeOf<V3RoomCreatorInviteMaterial>().toEqualTypeOf<ExpectedCreatorInviteMaterial>();
		expectTypeOf<typeof exportedCreateV3RoomCreatorInviteMaterial>().toEqualTypeOf<CreateCreatorInviteMaterial>();
		expect(candidate, "PHASE_3_EXIT_A_GENESIS_BUILDER_ABSENT").toBeTypeOf("function");
	});
});

describe.skipIf(typeof candidate !== "function")("D.93.56 shared genesis-root builder GREEN contract", () => {
	it("uses a fresh RFC 9162 empty root and exact signing input despite exported-root mutation", async () => {
		const originalEmptyRoot = new Uint8Array(EMPTY_MERKLE_ROOT);
		const signedInputs: Uint8Array[] = [];
		try {
			EMPTY_MERKLE_ROOT.fill(0xff);
			expect(EMPTY_MERKLE_ROOT).toEqual(new Uint8Array(32).fill(0xff));
			const input = baseInput((value) => {
				signedInputs.push(new Uint8Array(value));
				value.fill(0xee);
				return Promise.resolve(new Uint8Array(64).fill(0x5a));
			});
			const material = await createMaterial(input);
			const anchor = decodeAnchor(material);
			const expectedRoot = emptyRootHex();
			const expectedDigest = hashDomain("ts-drp/epoch-anchor/v3", material.exactCanonicalGenesisAnchorPreimageBytes);
			expect(anchor).toEqual({
				aclDigest: digest("ts-drp/latched-acl/v3", input.exactCanonicalLatchedAclBytes),
				archiveIndexRoot: expectedRoot,
				blueprintDigest: input.blueprintDigest,
				cryptoSuiteId: "ed25519-sha256-v3",
				cutDigest: "0".repeat(64),
				epoch: 0,
				historyRoot: expectedRoot,
				historySize: 0,
				kind: "drp-epoch-anchor",
				objectId: input.objectId,
				parametersDigest: digest("ts-drp/parameters/v3", input.exactCanonicalParametersCarrierBytes),
				previousAnchor: "0".repeat(64),
				profileDigest: digest("ts-drp/profile/v3", input.exactCanonicalProfileBytes),
				protocolMajor: 3,
				signerSetDigest: digest("ts-drp/signer-set/v3", input.exactCanonicalSignerSetBytes),
				stateDigest: input.stateDigest,
			});
			expect(signedInputs).toEqual([expectedDigest]);
			expect(material.pinnedGenesisAnchorDigest).toBe(hex(expectedDigest));
			expect(material.detachedGenesisSignature).toEqual(new Uint8Array(64).fill(0x5a));
		} finally {
			EMPTY_MERKLE_ROOT.set(originalEmptyRoot);
		}
	});

	it("captures caller-owned bytes before the signing await and returns detached evidence", async () => {
		let release!: (signature: Uint8Array) => void;
		const input = baseInput(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		const expected = {
			acl: new Uint8Array(input.exactCanonicalLatchedAclBytes),
			parameters: new Uint8Array(input.exactCanonicalParametersCarrierBytes),
			profile: new Uint8Array(input.exactCanonicalProfileBytes),
			signerSet: new Uint8Array(input.exactCanonicalSignerSetBytes),
		};
		const pending = createMaterial(input);
		input.exactCanonicalLatchedAclBytes.fill(0xff);
		input.exactCanonicalParametersCarrierBytes.fill(0xff);
		input.exactCanonicalProfileBytes.fill(0xff);
		input.exactCanonicalSignerSetBytes.fill(0xff);
		(input as { signGenesisAnchorDigest: GenesisAnchorSigner }).signGenesisAnchorDigest = (): Promise<Uint8Array> =>
			Promise.reject(new Error("late-selected signer callback"));
		const signature = new Uint8Array(64).fill(0x6b);
		release(signature);
		const material = await pending;
		signature.fill(0xee);
		expect(material.exactCanonicalLatchedAclBytes).toEqual(expected.acl);
		expect(material.exactCanonicalParametersCarrierBytes).toEqual(expected.parameters);
		expect(material.exactCanonicalProfileBytes).toEqual(expected.profile);
		expect(material.exactCanonicalSignerSetBytes).toEqual(expected.signerSet);
		expect(material.detachedGenesisSignature).toEqual(new Uint8Array(64).fill(0x6b));
		for (const [returned, supplied] of [
			[material.exactCanonicalLatchedAclBytes, input.exactCanonicalLatchedAclBytes],
			[material.exactCanonicalParametersCarrierBytes, input.exactCanonicalParametersCarrierBytes],
			[material.exactCanonicalProfileBytes, input.exactCanonicalProfileBytes],
			[material.exactCanonicalSignerSetBytes, input.exactCanonicalSignerSetBytes],
		] as const) {
			expect(returned).not.toBe(supplied);
		}
		expect(material.detachedGenesisSignature).not.toBe(signature);
		material.exactCanonicalLatchedAclBytes.fill(0xee);
		const repeated = await createMaterial(baseInput());
		expect(repeated.exactCanonicalLatchedAclBytes).toEqual(baseInput().exactCanonicalLatchedAclBytes);
	});

	it("fails closed for extra/accessor input fields and malformed signatures", async () => {
		await expect(
			createMaterial({ ...baseInput(), extra: true } as unknown as V3RoomCreatorInviteMaterialInput)
		).rejects.toBeInstanceOf(TypeError);
		const accessor = Object.defineProperty({ ...baseInput() }, "objectId", {
			enumerable: true,
			get: () => `creator:${"33".repeat(16)}`,
		}) as V3RoomCreatorInviteMaterialInput;
		await expect(createMaterial(accessor)).rejects.toBeInstanceOf(TypeError);
		await expect(createMaterial(baseInput(() => Promise.resolve(new Uint8Array(63))))).rejects.toBeInstanceOf(
			TypeError
		);
		for (const invalid of [
			{ ...baseInput(), blueprintDigest: "11".repeat(31) },
			{ ...baseInput(), blueprintDigest: "g".repeat(64) },
			{ ...baseInput(), objectId: "not-an-object-id" },
			{ ...baseInput(), stateDigest: "77".repeat(31) },
			{ ...baseInput(), stateDigest: "z".repeat(64) },
		]) {
			await expect(createMaterial(invalid)).rejects.toBeInstanceOf(TypeError);
		}
	});

	it("routes both real product creator paths through the shared builder", async () => {
		builderProbe.inputs.length = 0;
		builderProbe.materials.length = 0;
		builderProbe.roomCreatorInvites.length = 0;
		const chatModule = await import("../examples/v3-chat/src/index.js");
		const chatApi = Reflect.get(globalThis, "d9336V3Chat") as Readonly<{
			close(): Promise<void>;
			create(input: Readonly<Record<string, unknown>>): Promise<string>;
		}>;
		await chatApi.create({ channelName: "phase-3-exit-a", clientId: "alice", databaseName: "phase-3-exit-a" });
		await chatApi.close();

		const zone = await import("../examples/grid/src/v3-zone.js");
		const zoneCreator = new Keychain({ private_key_seed: "phase-3-exit-a-zone-creator" });
		await zoneCreator.start();
		const zoneCreatorAuthor = zoneCreator.localAuthorId;
		const zoneApi = Reflect.apply(
			Reflect.get(zone, "createV3ZoneApi") as (...arguments_: unknown[]) => unknown,
			undefined,
			[
				Object.freeze({
					keychain: Object.freeze({
						localAuthorId: zoneCreatorAuthor,
						signWithLocalAuthor: (digestBytes: Uint8Array) => zoneCreator.signWithLocalAuthor(digestBytes),
					}),
					networkNode: Object.freeze({ peerId: "peer-creator" }),
					openRoomNetwork: () => {
						throw new Error("mocked room must not open a transport");
					},
				}),
				(): void => undefined,
			]
		) as Readonly<{ close(): Promise<void>; create(enrollment: string): Promise<void> }>;
		await zoneApi.create(enrollmentHex());
		await zoneApi.close();

		expect(builderProbe.inputs).toHaveLength(2);
		const chatInput = builderProbe.inputs[0] as V3RoomCreatorInviteMaterialInput;
		const zoneInput = builderProbe.inputs[1] as V3RoomCreatorInviteMaterialInput;
		const chatObjectId = `creator:${"d".repeat(32)}`;
		const alice = new Keychain({ private_key_seed: "d9336-v3-chat-alice" });
		await alice.start();
		const chatApplication = chatModule.createV3ChatApplication("alice");
		const chatBlueprintDigest = String(chatApplication.catalog.blueprintDigests[0] ?? "");
		expectProductInput(chatInput, {
			acl: await expectedChatAcl(chatObjectId),
			blueprintDigest: chatBlueprintDigest,
			objectId: chatObjectId,
			signerAuthor: alice.localAuthorId,
		});
		await expectProductSigner(chatInput, alice);
		expect(zoneInput.objectId).toMatch(/^peer-creator:[0-9a-f]{32}$/u);
		const zoneMembers = Object.freeze([
			Object.freeze({ author: zoneCreatorAuthor, order: 0, peerId: "peer-creator" }),
			Object.freeze({ author: "66".repeat(32), order: 1, peerId: "peer:member" }),
		]);
		const zoneApplication = zone.createV3ZoneApplication(zoneMembers, "peer-creator", zoneCreatorAuthor);
		const zoneBlueprintDigest = String(zoneApplication.catalog.blueprintDigests[0] ?? "");
		expectProductInput(zoneInput, {
			acl: encodeCanonical({
				epoch: 0,
				kind: "drp-v3-latched-acl",
				members: [
					{
						author: zoneCreatorAuthor,
						finalityKey: zoneCreatorAuthor,
						groups: ["admin", "finality", "writer"],
					},
					{ author: "66".repeat(32), finalityKey: null, groups: ["writer"] },
				].sort((left, right) => (left.author < right.author ? -1 : left.author > right.author ? 1 : 0)),
				objectId: zoneInput.objectId,
				permissionless: false,
				version: 1,
			}),
			blueprintDigest: zoneBlueprintDigest,
			objectId: zoneInput.objectId,
			signerAuthor: zoneCreatorAuthor,
		});
		await expectProductSigner(zoneInput, zoneCreator);
		expect(builderProbe.materials).toHaveLength(2);
		expect(builderProbe.roomCreatorInvites).toHaveLength(2);
		for (const [index, material] of builderProbe.materials.entries()) {
			expect(builderProbe.roomCreatorInvites[index]).toBe(material);
			const anchor = decodeAnchor(material as V3RoomCreatorInviteMaterial);
			expect(anchor.historyRoot).toBe(emptyRootHex());
			expect(anchor.archiveIndexRoot).toBe(emptyRootHex());
			expect(anchor.historySize).toBe(0);
		}
	});
});
