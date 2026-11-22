import { encodeCanonical } from "@ts-drp/canonical";
import { Keychain } from "@ts-drp/keychain";
import type { DRPNode } from "@ts-drp/node";
import { afterEach, expect, it, vi } from "vitest";

import { createV3ZoneApi, type V3ZoneApi, type V3ZoneSettlementSourceApproval } from "../examples/grid/src/v3-zone.js";
import type { createV3RoomSession, V3RoomHeadAuthority, V3RoomSession } from "../examples/v3-room/src/index.js";

type RoomInput = Parameters<typeof createV3RoomSession>[0];

const probe = vi.hoisted(() => ({ inputs: [] as RoomInput[], close: (): Promise<void> => Promise.resolve() }));

vi.mock("@ts-drp/example-v3-room", async (original) => ({
	...(await original<Record<string, unknown>>()),
	createV3RoomSession: (input: RoomInput): Promise<unknown> => {
		probe.inputs.push(input);
		return Promise.resolve({
			objectId: input.objectId,
			invite:
				typeof input.creatorInvite === "string"
					? input.creatorInvite
					: hex(
							encodeCanonical({
								...input.creatorInvite,
								kind: "ts-drp-example-v3-room-creator-invite",
								version: 1,
							})
						),
			close: (): Promise<void> => probe.close(),
			previewLatchedAcl: (): unknown => ({ current: { epoch: 0 } }),
			openEphemeral: (): unknown => ({
				close: (): undefined => undefined,
				subscribe: (): (() => undefined) => (): undefined => undefined,
				stats: (): object => ({}),
			}),
		});
	},
}));

const identities: Keychain[] = [];
const zones: V3ZoneApi[] = [];

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function identity(seed: string): Promise<Keychain> {
	const keychain = new Keychain({ private_key_seed: seed });
	await keychain.start();
	identities.push(keychain);
	return keychain;
}

function authority(): V3RoomHeadAuthority {
	const unavailable = (): ReturnType<V3RoomHeadAuthority["read"]> =>
		Promise.resolve({ ok: false, reason: "unavailable" });
	return {
		initialization: { kind: "create" },
		begin: unavailable,
		commit: unavailable,
		create: unavailable,
		migrate: unavailable,
		read: unavailable,
	};
}

function zone(keychain: Keychain, peerId: string, approval?: V3ZoneSettlementSourceApproval): V3ZoneApi {
	const node = {
		keychain,
		networkNode: { peerId },
		ephemeralUnreliableWebRtcSnapshot: (): undefined => undefined,
		openRoomNetwork: (): never => {
			throw new Error("owner-propagation mock must not open transport");
		},
	} as unknown as DRPNode;
	const result = createV3ZoneApi(node, () => undefined, authority, approval);
	zones.push(result);
	return result;
}

afterEach(async () => {
	probe.close = (): Promise<void> => Promise.resolve();
	await Promise.allSettled(zones.splice(0).map((selected) => selected.close()));
	await Promise.all(identities.splice(0).map((keychain) => keychain.stop()));
	probe.inputs.length = 0;
});

it("passes only the configured Grid creator settlement policy without implicitly approving", async () => {
	const creator = await identity("r9-grid-explicit-settlement-policy");
	const recipient = await identity("r9-grid-explicit-settlement-recipient");
	const approve = vi.fn<V3ZoneSettlementSourceApproval>().mockResolvedValue(false);
	const sender = zone(creator, "policy-creator", approve);
	const reader = zone(recipient, "policy-recipient");
	await sender.create(reader.snapshot().enrollment);
	expect(probe.inputs[0].approveSettlementSourceSelection).toBe(approve);
	expect(approve).not.toHaveBeenCalled();
	await reader.join(sender.snapshot().invite);
	expect(probe.inputs[1].approveSettlementSourceSelection).toBeUndefined();
	expect(() => zone(creator, "malformed-policy", false as unknown as V3ZoneSettlementSourceApproval)).toThrow();
	expect(probe.inputs).toHaveLength(2);
});

it("passes the exact configured creator signer on create and creator reopen, never on enrolled recipient join", async () => {
	const creator = await identity("r9-shipping-creator-custody");
	const recipient = await identity("r9-shipping-recipient-custody");
	const creatorAcquisition = vi.spyOn(creator, "acquireLocalAuthorFinalitySigner");
	const recipientAcquisition = vi.spyOn(recipient, "acquireLocalAuthorFinalitySigner");
	const sender = zone(creator, "configured-creator");
	const reader = zone(recipient, "independently-enrolled");
	await sender.create(reader.snapshot().enrollment);
	const signer = await creator.acquireLocalAuthorFinalitySigner();
	expect(probe.inputs[0].creatorFinalitySigner).toBe(signer);
	const invite = sender.snapshot().invite;
	await reader.join(invite);
	expect(probe.inputs[1]).not.toHaveProperty("creatorFinalitySigner");
	expect(recipientAcquisition).not.toHaveBeenCalled();
	await sender.close();
	await sender.join(invite);
	expect(probe.inputs[2].creatorFinalitySigner).toBe(signer);
	expect(creatorAcquisition).toHaveBeenCalledTimes(3);
});

it("projects the richer shared context into the exact Grid outcome policy contract", async () => {
	const creator = await identity("r9-grid-outcome-policy-context");
	const recipient = await identity("r9-grid-outcome-policy-recipient");
	const sender = zone(creator, "policy-context-creator");
	const reader = zone(recipient, "policy-context-recipient");
	await sender.create(reader.snapshot().enrollment);
	const createPolicy = probe.inputs[0].createOperationAdmissionPolicy;
	expect(createPolicy).toBeTypeOf("function");
	if (createPolicy === undefined) throw new Error("Grid outcome policy factory is missing");
	const context = {
		aclDigest: "a".repeat(64),
		anchorDigest: "b".repeat(64),
		epoch: 1,
		objectId: "configured-grid-policy-context",
		exactCanonicalLatchedAclBytes: encodeCanonical({ kind: "separate-shared-ACL-owner" }),
		authenticatedApplicationStateBytes: encodeCanonical({ outcomes: [] }),
	};
	expect(() => createPolicy(context)).not.toThrow();
	expect(() => createPolicy({ ...context, aclDigest: "invalid" })).toThrow(
		"outcome admission policy context is invalid"
	);
	expect(() =>
		createPolicy({
			...context,
			authenticatedApplicationStateBytes: encodeCanonical({ outcomes: "invalid" }),
		})
	).toThrow("outcome inherited state is invalid");
});

it("joins pending acquisition and refuses to open after a close request", async () => {
	const creator = await identity("r9-shipping-pending-custody");
	const recipient = await identity("r9-shipping-pending-recipient");
	const signer = await creator.acquireLocalAuthorFinalitySigner();
	let deliver!: (value: typeof signer) => void;
	let entered!: () => void;
	const pending = new Promise<typeof signer>((resolve) => {
		deliver = resolve;
	});
	const reached = new Promise<void>((resolve) => {
		entered = resolve;
	});
	vi.spyOn(creator, "acquireLocalAuthorFinalitySigner").mockImplementation(() => {
		entered();
		return pending;
	});
	const sender = zone(creator, "pending-creator");
	const reader = zone(recipient, "pending-recipient");
	const opening = sender.create(reader.snapshot().enrollment);
	const refused = expect(opening).rejects.toThrow("v3 zone closed during open");
	await reached;
	let joined = false;
	const closing = sender.close().then(() => {
		joined = true;
	});
	await Promise.resolve();
	expect(joined).toBe(false);
	deliver(signer);
	await refused;
	await closing;
	expect(probe.inputs).toHaveLength(0);
});

it("reports close failure only after all retained source work has joined", async () => {
	const creator = await identity("r9-shipping-close-custody");
	const recipient = await identity("r9-shipping-close-recipient");
	const sender = zone(creator, "close-creator");
	const reader = zone(recipient, "close-recipient");
	await sender.create(reader.snapshot().enrollment);
	let release!: () => void;
	let entered!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const reached = new Promise<void>((resolve) => {
		entered = resolve;
	});
	probe.close = (): Promise<void> => {
		entered();
		return pending;
	};
	const failure = new Error("target close refused");
	const target = {
		close: () => Promise.reject(failure),
		openEphemeral: (): unknown => ({
			close: (): undefined => undefined,
			subscribe: (): (() => undefined) => (): undefined => undefined,
			stats: (): object => ({}),
		}),
	} as unknown as V3RoomSession;
	const redirect = probe.inputs[0]?.onMigrationTarget;
	if (redirect === undefined) throw new Error("migration target callback is absent");
	redirect(target, `close-creator:${"e".repeat(32)}`);
	let finished = false;
	const closing = sender.close();
	const outcome = closing.catch((error) => {
		finished = true;
		return error;
	});
	await reached;
	await Promise.resolve();
	expect(finished).toBe(false);
	release();
	expect(await outcome).toBe(failure);
});
