/**
 * The Canvas room, without the page: one node's canvas session (create or join), its rollover policy
 * and successor delivery, painting, and the views the page renders. The main-thread page
 * (canvas-main-thread.ts) and the room worker (canvas-worker-app.ts) run this same module; only where
 * it runs differs. It touches no DOM.
 */
import { createV3CanvasDescriptor, toCanvasWireOperation } from "@ts-drp/blueprints/v3-canvas";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomRolloverPolicy,
	createV3RoomSession,
	openV3RoomSuccessorDelivery,
	prepareV3RoomPlayerDatabase,
	type V3RoomCreatorInviteMaterial,
	type V3RoomHeadAuthority,
	type V3RoomRolloverHooks,
	type V3RoomRolloverPolicy,
	type V3RoomSession,
	type V3RoomSuccessorDelivery,
} from "@ts-drp/example-v3-room";
import type { DRPNode } from "@ts-drp/node";
import { type CanvasProjection, createV3CanvasApplication } from "@ts-drp/node/applications/canvas";
import { DRP_DISCOVERY_TOPIC } from "@ts-drp/types";

import { CANVAS_GENESIS_PROFILE } from "./profile";
import { CANVAS_ROLLOVER_BUDGET } from "./rollover";

export const CANVAS_SIDE = 10;

export type CanvasHeadFactory = (
	context: Readonly<{
		author: string;
		creatorInvite: string | V3RoomCreatorInviteMaterial;
		objectId: string;
		operation: "create" | "join";
	}>
) => V3RoomHeadAuthority | Promise<V3RoomHeadAuthority>;

export type CanvasSettlementApproval = NonNullable<
	Parameters<typeof createV3RoomSession<CanvasProjection>>[0]["approveSettlementSourceSelection"]
>;

export type CanvasSuccessorPublisher = NonNullable<V3RoomRolloverHooks["publishSuccessor"]>;

/** What the application host lends the room (window globals on the main thread, page hooks in a worker). */
export interface CanvasRoomHost {
	/** The room-head authority factory (required to open). */
	roomHeadAuthorityForOpen(): CanvasHeadFactory | undefined;
	approveSettlementSourceSelection(): CanvasSettlementApproval | undefined;
	/**
	 * Test override of the creator's successor announcement. By default the room's successor delivery
	 * announces each adopted offer to the canvas's observers over the node and answers their requests;
	 * with this hook, the hook receives the offers instead and the room announces nothing.
	 */
	publishSuccessor(): CanvasSuccessorPublisher | undefined;
}

/** The canvas as the page renders it. */
export interface CanvasView {
	readonly canvasId: string | undefined;
	readonly invite: string;
	readonly observer: boolean;
	/** CANVAS_SIDE x CANVAS_SIDE pixels, x-major (pixel "x-y" at (x * CANVAS_SIDE + y) * 3), rgb. */
	readonly pixels: readonly number[] | null;
}

/** The page's peer panel. */
export interface CanvasNetworkView {
	readonly peers: readonly string[];
	readonly discoveryPeers: readonly string[];
	readonly objectPeers: readonly string[];
}

export interface CanvasRoom {
	/** Creates a canvas or joins one by invite; rejects (after cleaning up) when it cannot. */
	open(operation: "create" | "join", invite: string): Promise<CanvasView>;
	/**
	 * Paints one pixel: one immutable intent per call. A paint refused at the epoch's capacity is
	 * offered again after the creator's rollover. Rejects with the room's typed refusals.
	 */
	paint(x: number, y: number, rgb: readonly [number, number, number]): Promise<void>;
	view(): CanvasView;
	network(): CanvasNetworkView;
	/** Closes the canvas (it joins admitted work); waits for an open in progress first. */
	close(): Promise<void>;
}

// The module's one canvas room and its node, as module bindings (a page or a worker hosts one canvas):
// measurement harnesses append a read-only accessor to this module as served
// (tests/track-x-shipped-app-long-room.pw.ts reads `room` and `node`).
let room: V3RoomSession<CanvasProjection> | undefined;
let node: DRPNode | undefined;

const descriptor = createV3CanvasDescriptor(CANVAS_SIDE, CANVAS_SIDE);
const application = createV3CanvasApplication(CANVAS_SIDE, CANVAS_SIDE);
const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytes = (value: string): Uint8Array =>
	Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));

/**
 * Routing only. The room owner authenticates the exact invite before activation.
 * @param invite Bounded untrusted room invitation.
 * @returns Routing identity, not authenticated authority.
 */
export function objectIdFromInvite(invite: string): string {
	if (invite.length === 0 || invite.length > 131_072 || invite.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(invite))
		throw new TypeError("canvas invite is invalid");
	const material = decodeCanonical(bytes(invite), { maxBytes: 65_536, maxDepth: 4, maxItems: 128 });
	if (material === null || typeof material !== "object") throw new TypeError("canvas invite is invalid");
	const preimage = Reflect.get(material, "exactCanonicalGenesisAnchorPreimageBytes");
	if (!(preimage instanceof Uint8Array)) throw new TypeError("canvas invite is invalid");
	const anchor = decodeCanonical(preimage);
	const objectId = anchor === null || typeof anchor !== "object" ? undefined : Reflect.get(anchor, "objectId");
	if (typeof objectId !== "string" || objectId.length === 0) throw new TypeError("canvas invite object is invalid");
	return objectId;
}

async function creatorInvite(selectedNode: DRPNode, objectId: string): Promise<V3RoomCreatorInviteMaterial> {
	const author = selectedNode.keychain.localAuthorId;
	const signers = [{ publicKey: author, signerId: "creator" }];
	return createV3RoomCreatorInviteMaterial({
		objectId,
		blueprintDigest: application.catalog.blueprintDigests[0] as string,
		exactCanonicalApplicationStateBytes: descriptor.canonicalStateBytes(descriptor.initialState),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }],
			objectId,
			permissionless: false,
			version: CANVAS_GENESIS_PROFILE.latchedAclVersion,
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
			profileId: CANVAS_GENESIS_PROFILE.profileId,
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		signGenesisAnchorDigest: (digest) => selectedNode.keychain.signWithLocalAuthor(digest),
	});
}

function pixelsOf(projection: CanvasProjection): number[] {
	const pixels: number[] = [];
	for (let x = 0; x < CANVAS_SIDE; x++)
		for (let y = 0; y < CANVAS_SIDE; y++) pixels.push(...descriptor.kernel.queryColor(projection.state, x, y));
	return pixels;
}

/**
 * The canvas room of a started node.
 * @param started - The started node.
 * @param host - What the application host lends the room.
 * @param onView - Called with the canvas view whenever it changes (open, projection, close).
 * @returns The room.
 */
export function createCanvasRoom(
	started: DRPNode,
	host: CanvasRoomHost,
	onView: (view: CanvasView) => void
): CanvasRoom {
	if (node !== undefined) throw new TypeError("this module already hosts a canvas room");
	node = started;
	// The creator's rollover policy (examples/canvas/src/rollover.ts); observers never seal.
	let rollover: V3RoomRolloverPolicy | undefined;
	// Every node's successor delivery: the creator announces offers, observers install them.
	let delivery: V3RoomSuccessorDelivery | undefined;
	let pixels: number[] | null = null;
	let observer = false;
	let opening: Promise<CanvasView> | undefined;
	let closing = false;

	const view = (): CanvasView => ({ canvasId: room?.objectId, invite: room?.invite ?? "", observer, pixels });

	const open = async (operation: "create" | "join", inviteInput: string): Promise<CanvasView> => {
		let opened: V3RoomSession<CanvasProjection> | undefined;
		try {
			const objectId =
				operation === "create"
					? `${started.networkNode.peerId}:${hex(crypto.getRandomValues(new Uint8Array(16)))}`
					: objectIdFromInvite(inviteInput.trim());
			const invite = operation === "create" ? await creatorInvite(started, objectId) : inviteInput.trim();
			const factory = host.roomHeadAuthorityForOpen();
			if (typeof factory !== "function")
				throw new TypeError(
					"canvas room-head authority is unavailable: the application host must configure its factory"
				);
			const approveSettlementSourceSelection = host.approveSettlementSourceSelection();
			if (approveSettlementSourceSelection !== undefined && typeof approveSettlementSourceSelection !== "function")
				throw new TypeError("canvas settlement approval policy is invalid");
			const author = started.keychain.localAuthorId;
			const authority = await factory(Object.freeze({ author, creatorInvite: invite, objectId, operation }));
			// Decision A: this player's own room database; the shared (objectId-only) one migrates once.
			const { databaseName } = await prepareV3RoomPlayerDatabase({ application: "canvas", objectId, author });
			const publishSuccessor = host.publishSuccessor();
			if (publishSuccessor !== undefined && typeof publishSuccessor !== "function")
				throw new TypeError("canvas successor publisher is invalid");
			const successors = openV3RoomSuccessorDelivery(started, objectId, operation === "create" ? "creator" : "member", {
				onError: (error) => console.warn("Canvas successor delivery failed; it is retried", error),
				onRefused: (error) => console.warn("Canvas successor offer was refused", error),
				// A successor the room adopted outside the policy (its own close retry) is published on a member's pull.
				onMemberBehind: () => void rollover?.publishCurrent(),
			});
			delivery = successors;
			// Only the creator seals: it rolls the canvas over at its budget or after an idle period.
			const policy =
				operation === "create"
					? createV3RoomRolloverPolicy({
							role: "creator",
							budget: CANVAS_ROLLOVER_BUDGET,
							// The room parameters' dependency bound (exactCanonicalParametersCarrierBytes above).
							writerCapacity: { maxDependencies: 16, profileId: CANVAS_GENESIS_PROFILE.profileId },
							hooks: {
								publishSuccessor:
									publishSuccessor ?? ((offer, epoch): Promise<void> => successors.publish(offer, epoch)),
								onError: (error) => console.warn("Canvas rollover failed; it is retried", error),
							},
						})
					: undefined;
			opened = await createV3RoomSession<CanvasProjection>({
				application,
				author,
				creatorInvite: invite,
				databaseName,
				issuanceDatabaseName: databaseName,
				migrationDatabaseNamespace: `${author}:${objectId}`,
				objectId,
				initialLogicalTime: 3,
				...(operation === "join"
					? { receiveOnly: true as const }
					: { creatorFinalitySigner: await started.keychain.acquireLocalAuthorFinalitySigner() }),
				roomHeadAuthority: authority,
				// Creator restore currency: a reopened creator asks the canvas's members before it signs.
				...(successors.role === "creator" ? { creatorMemberView: successors.creatorMemberView } : {}),
				...(approveSettlementSourceSelection === undefined ? {} : { approveSettlementSourceSelection }),
				publicKeyBytes: bytes(author),
				signRegisteredVertexDigest: (digest) => started.keychain.signWithLocalAuthor(digest),
				openTransport: (id) => started.openRoomNetwork(id),
				onAcceptedVertex: (vertex) => policy?.observe(vertex),
				onIngressCapacityRefusal: (reason) => policy?.refused(reason),
				onProjection: (value) => {
					pixels = pixelsOf(value);
					if (room !== undefined) onView(view());
				},
			});
			if (closing) throw new TypeError("canvas closed during open");
			policy?.bind(opened);
			successors.bind(opened);
			rollover = policy;
			room = opened;
			observer = operation === "join";
			pixels = pixelsOf(opened.projection());
			const current = view();
			onView(current);
			return current;
		} catch (error) {
			rollover?.close();
			rollover = undefined;
			delivery?.close();
			delivery = undefined;
			await opened?.close();
			pixels = null;
			throw error;
		}
	};

	return {
		open(operation, invite): Promise<CanvasView> {
			if (opening !== undefined || closing || room !== undefined)
				return Promise.reject(new TypeError("canvas is already open"));
			const task = open(operation, invite).finally(() => {
				opening = undefined;
			});
			opening = task;
			return task;
		},
		async paint(x, y, rgb): Promise<void> {
			const selected = room;
			if (selected === undefined || closing || observer) return;
			// One immutable intent per independent click. Any retry retains this command: a paint refused
			// at the epoch's capacity is offered again after the creator's rollover.
			const command = toCanvasWireOperation({ action: "paint", offset: [x, y], rgb: [...rgb] }, crypto.randomUUID());
			await (rollover ?? selected).issue(command);
		},
		view,
		network: (): CanvasNetworkView => ({
			peers: started.networkNode.getAllPeers(),
			discoveryPeers: started.networkNode.getGroupPeers(DRP_DISCOVERY_TOPIC),
			objectPeers: room?.connectedPeers() ?? [],
		}),
		async close(): Promise<void> {
			closing = true;
			await opening?.catch(() => undefined);
			rollover?.close();
			delivery?.close();
			await room?.close();
		},
	};
}
