/**
 * The Chat room, without the page: one node's chat session (create or join, a joiner's reopen as a
 * Writer), its rollover policy and successor delivery, the device archive, sending, the admin's
 * membership changes and share updates, and the views the page renders. The main-thread page
 * (chat-main-thread.ts) and the room worker (chat-worker-app.ts) run this same module; only where it
 * runs differs. It touches no DOM.
 */
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomRolloverPolicy,
	createV3RoomSession,
	openV3RoomSuccessorDelivery,
	prepareV3RoomPlayerDatabase,
	V3RoomBusy,
	type V3RoomCreatorInviteMaterial,
	type V3RoomHeadAuthority,
	V3RoomNotReachingHost,
	V3RoomReadOnly,
	type V3RoomRolloverHooks,
	type V3RoomRolloverPolicy,
	type V3RoomSession,
	type V3RoomSuccessorDelivery,
	V3RoomSuccessorUnavailable,
} from "@ts-drp/example-v3-room";
import type { DRPNode } from "@ts-drp/node";
import { authenticateV3RoomCreatorInvite } from "@ts-drp/node/v3-room";
import { DRP_DISCOVERY_TOPIC } from "@ts-drp/types";

import { openShippingChatCatalogs, type ShippingChatCatalog } from "./chat-catalogs";
import { CHAT_GENESIS_PROFILE } from "./profile";
import { shippingChatRefusalClearedByRollover, shippingChatRolloverBudget } from "./rollover";
import {
	captureShippingChatOperation,
	createShippingChatSharesGenesisStateBytes,
	createShippingV3ChatApplication,
	type ShippingChatApplication,
	type ShippingChatMessageOperation,
	type ShippingChatProjection,
	type ShippingChatShares,
	shippingChatShareUpdate,
} from "./v3-chat-application";
import {
	openBrowserShippingChatArchiveStore,
	openShippingChatLocalArchive,
	shippingChatArchiveDatabaseName,
	shippingChatHistory,
	type ShippingChatHistoryMessage,
	type ShippingChatLocalArchive,
} from "./v3-chat-archive";

export type ChatHeadFactory = (
	context: Readonly<{
		author: string;
		creatorInvite: string | V3RoomCreatorInviteMaterial;
		objectId: string;
		operation: "create" | "join";
	}>
) => V3RoomHeadAuthority | Promise<V3RoomHeadAuthority>;
export type ChatSettlementApproval = NonNullable<
	Parameters<typeof createV3RoomSession<ShippingChatProjection>>[0]["approveSettlementSourceSelection"]
>;
export type ChatSuccessorPublisher = NonNullable<V3RoomRolloverHooks["publishSuccessor"]>;

/** What the application host lends the room (window globals and localStorage on the main thread, page hooks in a worker). */
export interface ChatRoomHost {
	/** The room-head authority factory (required to open). */
	roomHeadAuthorityForOpen(): ChatHeadFactory | undefined;
	approveSettlementSourceSelection(): ChatSettlementApproval | undefined;
	/**
	 * Test override of the creator's successor announcement. By default the room's successor delivery
	 * (examples/v3-room) announces each adopted offer to the room's members over the node and answers
	 * their requests (a joiner must follow a checkpoint before it can send); with this hook, the hook
	 * receives the offers instead and the room announces nothing.
	 */
	publishSuccessor(): ChatSuccessorPublisher | undefined;
	/**
	 * The per-device mark that this room's replica was reopened as a Writer (the page's localStorage).
	 * Display convenience only; a lost mark is recovered by trying the other acquisition.
	 */
	readWriterReplica(key: string): boolean | Promise<boolean>;
	markWriterReplica(key: string, writer: boolean): void | Promise<void>;
}

/** The chat as the page renders it. */
export interface ChatView {
	readonly roomId: string | undefined;
	readonly invite: string;
	/** This device's author ID. */
	readonly author: string;
	readonly observer: boolean;
	/** The shared window plus the messages only this device still keeps, in display order. */
	readonly messages: readonly ShippingChatHistoryMessage[];
	/** `undefined` when sending is open, else the reason shown beside the message box. */
	readonly sendBlocked: string | undefined;
	readonly admin: boolean;
}

/** The page's peer panel. */
export interface ChatNetworkView {
	readonly peerId: string;
	/** This device's author ID (what an admin needs to make it a Writer). */
	readonly author: string;
	readonly peers: readonly string[];
	readonly discoveryPeers: readonly string[];
	readonly objectPeers: readonly string[];
}

export type ChatStatusState = "joining" | "ready" | "error";

/** How the room opened. */
export type ChatOpenRole = "observer" | "enrolledWriter" | "writer";

/**
 * A send's outcome: `sent` (accepted locally), `superseded` (accepted, but the room the page
 * offered it to has since been replaced), or `skipped` (not offered: sending is closed, or a joiner's
 * reopen as a Writer did not succeed; the room reported why through its status).
 */
export type ChatSendOutcome = "sent" | "superseded" | "skipped";

export interface ChatRoom {
	/** Creates a chat or joins one by signed invite; rejects (after cleaning up) when it cannot. */
	open(operation: "create" | "join", invite: string): Promise<Readonly<{ view: ChatView; role: ChatOpenRole }>>;
	/**
	 * Sends a message. A joiner's first Send in a shares room reopens it as a Writer first. Offering the
	 * same text again after a refusal reuses the same operation (its identity and display time).
	 * Rejects with the room's typed refusals; a refusal the room's policy keeps (V3RoomNotReachingHost,
	 * V3RoomReadOnly, V3RoomBusy, V3RoomSuccessorUnavailable) is sent once its cause clears.
	 */
	send(text: string): Promise<ChatSendOutcome>;
	/** The admin's grant or revoke of `writer` for one author; false when this device is not an admin. */
	changeWriter(kind: "grant" | "revoke", target: string): Promise<boolean>;
	view(): ChatView;
	network(): ChatNetworkView;
	/** Re-renders (the archive writes in later tasks) and lets an admin issue a due share update. */
	refresh(): void;
	/** Closes the chat (it joins admitted work); waits for the operations in progress first. */
	close(): Promise<void>;
}

export interface ChatRoomListeners {
	/** The chat view, whenever it may have changed (open, projection, reopen, close, refresh). */
	view(view: ChatView): void;
	/** A status the room reports outside a call's result (a joiner's reopen, a declined given-back message). */
	status(message: string, state: ChatStatusState): void;
}

// What reopening the open room needs: the same databases, invite and format.
interface ChatOpenContext {
	readonly author: string;
	readonly objectId: string;
	readonly invite: string | V3RoomCreatorInviteMaterial;
	readonly application: ShippingChatApplication;
	readonly shares: boolean;
	readonly databaseName: string;
	readonly archive: ShippingChatLocalArchive | undefined;
}

// The module's one chat room and its node, as module bindings (a page or a worker hosts one chat):
// measurement harnesses append a read-only accessor to this module as served
// (tests/track-x-shipped-app-long-room.pw.ts and tests/track-w2-shipped-chat-membership.pw.ts read
// `room`; TRACK_X_NET_PROBE reads `node`).
let room: V3RoomSession<ShippingChatProjection> | undefined;
let node: DRPNode | undefined;

const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
function bytes(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})+$/u.test(value)) throw new TypeError("Chat bytes are invalid");
	return Uint8Array.from(value.match(/../gu) as string[], (byte) => Number.parseInt(byte, 16));
}
// New rooms sign the membership-aware shares format (v5); rooms whose genesis signed the window
// (v4) or lifetime (v3) format keep it.
const catalogs = openShippingChatCatalogs();

function inGroup(acl: unknown, author: string, group: "admin" | "writer"): boolean {
	if (acl === null || typeof acl !== "object") return false;
	if (group === "writer" && Reflect.get(acl, "permissionless") === true) return true;
	const members: unknown = Reflect.get(acl, "members");
	return (
		Array.isArray(members) &&
		members.some(
			(member: unknown) =>
				member !== null &&
				typeof member === "object" &&
				Reflect.get(member, "author") === author &&
				Array.isArray(Reflect.get(member, "groups")) &&
				Reflect.get(member, "groups").includes(group)
		)
	);
}
function isWriter(acl: unknown, author: string): boolean {
	return inGroup(acl, author, "writer");
}

// Per-device mark that this room's replica was reopened as a Writer (a receive-only open of it
// would fail: it holds this device's own signed work).
function writerReplicaKey(context: ChatOpenContext): string {
	return "ts-drp:chat:v3:writer-replica:" + context.objectId + ":" + context.author;
}

/**
 * The same room-head authority, as a reopen: the open room's account floor already holds this
 * room's head, so a second session over the same replica reads it instead of creating it.
 * @param authority - The authority the open room was opened with.
 * @returns A view of it whose initialization is `reopen`.
 */
function reopenedAuthority(authority: V3RoomHeadAuthority): V3RoomHeadAuthority {
	const reopen = Object.freeze({ kind: "reopen" as const });
	return new Proxy(authority, {
		get(target, key): unknown {
			if (key === "initialization") return reopen;
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? (value as (...input: unknown[]) => unknown).bind(target) : value;
		},
	});
}

/**
 * The chat room of a started node.
 * @param started - The started node.
 * @param host - What the application host lends the room.
 * @param listeners - The page's view and status listeners.
 * @returns The room.
 */
export function createChatRoom(started: DRPNode, host: ChatRoomHost, listeners: ChatRoomListeners): ChatRoom {
	if (node !== undefined) throw new TypeError("this module already hosts a chat room");
	node = started;
	const author = started.keychain.localAuthorId;
	// Each open session's rollover policy (examples/chat/src/rollover.ts): the creator's seals at its
	// budget; a Writer's only offers a refused message again after the next checkpoint.
	const rollovers = new WeakMap<V3RoomSession<ShippingChatProjection>, V3RoomRolloverPolicy>();
	// Each open session's successor delivery: the creator announces offers, members install them.
	const deliveries = new WeakMap<V3RoomSession<ShippingChatProjection>, V3RoomSuccessorDelivery>();
	let projection: ShippingChatProjection | undefined;
	// This device's history of the open room (outside room storage; display only).
	let archive: ShippingChatLocalArchive | undefined;
	let openContext: ChatOpenContext | undefined;
	// The room-head authority the open room's replica was opened with (its account floor).
	let roomAuthority: V3RoomHeadAuthority | undefined;
	let shareTask: Promise<void> | undefined;
	// The share update this room last issued (`epoch:aclDigest`), and when a failed one may retry.
	let shareIssued: string | undefined;
	let shareRetryAt = 0;
	let closing = false;
	let observer = true;
	let pendingSend: Readonly<{ author: string; operation: ShippingChatMessageOperation }> | undefined;
	// The operations in progress (close waits for them).
	const operations = new Set<Promise<unknown>>();
	const track = <T>(task: Promise<T>): Promise<T> => {
		operations.add(task);
		void task
			.finally(() => operations.delete(task))
			.catch(() => {
				// The caller observes the operation's own rejection.
			});
		return task;
	};

	/**
	 * Closes a session and ends its rollover policy and successor delivery.
	 * @param session - The session to close.
	 */
	const closeSession = async (session: V3RoomSession<ShippingChatProjection> | undefined): Promise<void> => {
		if (session === undefined) return;
		rollovers.get(session)?.close();
		deliveries.get(session)?.close();
		await session.close();
	};

	/**
	 * The open room's current latched ACL.
	 * @returns The ACL, or undefined while no room is open.
	 */
	const currentAcl = (): unknown => {
		if (room === undefined) return undefined;
		try {
			return Reflect.get(room.previewLatchedAcl(), "current");
		} catch {
			return undefined;
		}
	};
	/**
	 * Whether this device may send now, and if not, why. In a shares (v5) room a Writer sends from the
	 * checkpoint its share row names; a joiner's page opened receive-only reopens as a Writer on Send.
	 * Rooms of the window and lifetime formats keep their rule: genesis Writers only.
	 * @returns `undefined` when sending is open, else the reason shown beside the message box.
	 */
	const sendBlocked = (): string | undefined => {
		if (room === undefined || openContext === undefined) return "";
		if (!isWriter(currentAcl(), author))
			return "Read-only. To send, ask the room's admin to make your author ID a Writer.";
		if (!openContext.shares)
			return observer ? "Read-only: this room's format admits its genesis Writers only." : undefined;
		const row = (projection?.capacity as ShippingChatShares | undefined)?.allocations.find(
			(value) => value[0] === author
		);
		if (row === undefined) return "You are a Writer; waiting for the admin's page to give you a share of the window.";
		const epoch = projection?.epoch ?? 0;
		if (row[2] > epoch) return `You are a Writer; you can send from checkpoint ${row[2]} (now ${epoch}).`;
		return undefined;
	};
	const isAdmin = (): boolean => !observer && inGroup(currentAcl(), author, "admin");

	const view = (): ChatView => ({
		roomId: room?.objectId,
		invite: room?.invite ?? "",
		author,
		observer,
		// The window and shares formats keep admitted order (they carry the projection epoch); the lifetime
		// format sorts its messages by identity.
		messages:
			projection === undefined
				? []
				: shippingChatHistory(
						projection.messages,
						archive?.records() ?? [],
						projection.epoch === undefined ? "identity" : "admitted"
					),
		sendBlocked: sendBlocked(),
		admin: room !== undefined && isAdmin(),
	});
	const render = (): void => listeners.view(view());

	/**
	 * An admin's room keeps the room's share rows matching its current ACL: once per checkpoint whose
	 * rows differ from the share formula, it issues the share update. Every admin computes the same
	 * rows, so duplicates change nothing; an update that misses its checkpoint expires, and the next
	 * checkpoint's projection asks again.
	 */
	const updateShares = (): void => {
		const selected = room;
		const current = projection;
		if (selected === undefined || current === undefined || closing || shareTask !== undefined) return;
		if (openContext?.shares !== true || !isAdmin()) return;
		const acl = currentAcl();
		if (acl === undefined) return;
		let update: ReturnType<typeof shippingChatShareUpdate>;
		try {
			update = shippingChatShareUpdate({
				capacity: current.capacity as ShippingChatShares,
				exactCanonicalLatchedAclBytes: encodeCanonical(acl),
			});
		} catch (error) {
			console.warn("Chat share update is unavailable", error);
			return;
		}
		if (update === undefined) return;
		const key = `${update.epoch}:${update.aclDigest}`;
		if (shareIssued === key || Date.now() < shareRetryAt) return;
		const operation = update;
		const task = (async (): Promise<void> => {
			try {
				await selected.issue({ ...operation });
				shareIssued = key;
			} catch (error) {
				shareRetryAt = Date.now() + 3000;
				console.warn("Chat share update was refused; it is retried", error);
			}
		})();
		shareTask = task;
		void task.finally(() => {
			if (shareTask === task) shareTask = undefined;
		});
	};

	const readWriterReplica = async (context: ChatOpenContext): Promise<boolean> => {
		try {
			return (await host.readWriterReplica(writerReplicaKey(context))) === true;
		} catch {
			return false;
		}
	};
	const markWriterReplica = (context: ChatOpenContext, writer: boolean): void => {
		try {
			void Promise.resolve(host.markWriterReplica(writerReplicaKey(context), writer)).catch(() => {
				// Storage refused: the next open tries the other acquisition.
			});
		} catch {
			// Storage refused: the next open tries the other acquisition.
		}
	};

	/**
	 * Opens the room's session over this device's databases.
	 * @param context - The room, invite, format and device archive.
	 * @param operation - Create (the creator's first open) or join.
	 * @param receiveOnly - Open as an observer.
	 * @param reopen - The open room's authority, for a reopen of the same replica (else the host's
	 * factory acquires one).
	 * @returns The open session.
	 */
	const openSession = async (
		context: ChatOpenContext,
		operation: "create" | "join",
		receiveOnly: boolean,
		reopen?: V3RoomHeadAuthority
	): Promise<V3RoomSession<ShippingChatProjection>> => {
		const factory = host.roomHeadAuthorityForOpen();
		if (typeof factory !== "function")
			throw new TypeError("Chat room-head authority is unavailable: the application host must configure its factory");
		const approveSettlementSourceSelection = host.approveSettlementSourceSelection();
		if (approveSettlementSourceSelection !== undefined && typeof approveSettlementSourceSelection !== "function")
			throw new TypeError("Chat settlement approval policy is invalid");
		const { objectId, invite, application, databaseName, archive: deviceArchive } = context;
		const authority =
			reopen === undefined
				? await factory(Object.freeze({ author: context.author, creatorInvite: invite, objectId, operation }))
				: reopenedAuthority(reopen);
		roomAuthority = reopen ?? authority;
		const publishSuccessor = host.publishSuccessor();
		if (publishSuccessor !== undefined && typeof publishSuccessor !== "function")
			throw new TypeError("Chat successor publisher is invalid");
		const successors = openV3RoomSuccessorDelivery(started, objectId, operation === "create" ? "creator" : "member", {
			onError: (error) => console.warn("Chat successor delivery failed; it is retried", error),
			onRefused: (error) => console.warn("Chat successor offer was refused", error),
			// A successor the room adopted outside the policy (its own close retry) is published on a member's pull.
			onMemberBehind: () => void policy?.publishCurrent(),
		});
		// Only the creator's first open holds the finality signer, so only it seals. An observer issues
		// nothing and needs no policy; its delivery still installs each successor.
		const policy = receiveOnly
			? undefined
			: createV3RoomRolloverPolicy({
					role: operation === "create" ? "creator" : "member",
					budget: shippingChatRolloverBudget({ objectId, shares: context.shares }),
					// The room parameters' dependency bound (exactCanonicalParametersCarrierBytes below).
					writerCapacity: { maxDependencies: 16, profileId: CHAT_GENESIS_PROFILE.profileId },
					hooks: {
						publishSuccessor: publishSuccessor ?? ((offer, epoch): Promise<void> => successors.publish(offer, epoch)),
						requestSuccessor: () => successors.request(),
						creatorReachable: () => successors.creatorReachable(),
						clearedByRollover: shippingChatRefusalClearedByRollover,
						// A given-back message the room refused again for good (its state limit or admission policy).
						onDeclined: (declined) =>
							listeners.status(
								`Your message "${String(declined.operation.text ?? "")}" was not delivered and can't be sent: ${declined.message}.`,
								"error"
							),
						onError: (error) => console.warn("Chat rollover failed; it is retried", error),
					},
				});
		let session: V3RoomSession<ShippingChatProjection>;
		try {
			session = await createV3RoomSession<ShippingChatProjection>({
				application,
				author: context.author,
				creatorInvite: invite,
				objectId,
				databaseName,
				issuanceDatabaseName: databaseName,
				migrationDatabaseNamespace: context.author + ":" + objectId,
				initialLogicalTime: 3,
				...(receiveOnly ? { receiveOnly: true as const } : {}),
				...(operation === "create"
					? {
							creatorFinalitySigner: await started.keychain.acquireLocalAuthorFinalitySigner(),
							// Creator restore currency: a creator reopened from storage asks the members first.
							creatorMemberView: successors.creatorMemberView,
						}
					: {}),
				roomHeadAuthority: authority,
				publicKeyBytes: bytes(context.author),
				createOperationAdmissionPolicy: application.createOperationAdmissionPolicy,
				// The host explicitly decides only after the shared owner authenticates
				// the exact proposal. No policy means protected work awaits approval.
				...(approveSettlementSourceSelection === undefined ? {} : { approveSettlementSourceSelection }),
				signRegisteredVertexDigest: (digest) => started.keychain.signWithLocalAuthor(digest),
				openTransport: (id) => started.openRoomNetwork(id),
				onAcceptedVertex: (vertex) => policy?.observe(vertex),
				onIngressCapacityRefusal: (reason) => policy?.refused(reason),
				onProjection: (value) => {
					projection = value;
					// O(1): the archive writes in a later task, off this callback.
					deviceArchive?.observe(value);
					render();
					updateShares();
				},
			});
		} catch (error) {
			policy?.close();
			successors.close();
			throw error;
		}
		if (policy !== undefined) {
			policy.bind(session);
			rollovers.set(session, policy);
		}
		successors.bind(session);
		deliveries.set(session, successors);
		return session;
	};

	/**
	 * A joiner follows a shares room receive-only. Once its author is a Writer whose share is in force,
	 * Send reopens the same databases as a Writer and the message is issued at once: the library opens
	 * a Writer's replica only over a checkpoint it followed, so the room does not reopen it any earlier.
	 * If the reopen fails (for example on a device that did not follow the previous checkpoint), the
	 * room goes back to following the room and the page keeps the text.
	 * @returns Whether the room is now open as a Writer.
	 */
	const promoteToWriter = async (): Promise<boolean> => {
		const context = openContext;
		const current = room;
		const authority = roomAuthority;
		if (context === undefined || current === undefined || authority === undefined) return false;
		if (!observer) return true;
		listeners.status("Opening this device as a Writer…", "joining");
		room = undefined;
		render();
		await closeSession(current);
		try {
			const opened = await openSession(context, "join", false, authority);
			if (closing) {
				await closeSession(opened);
				return false;
			}
			room = opened;
			observer = false;
			markWriterReplica(context, true);
			projection = opened.projection();
			context.archive?.observe(projection);
			listeners.status("Connected as a Writer. Creator-trusted chat; not Byzantine-fault-tolerant.", "ready");
			render();
			return true;
		} catch (error) {
			console.warn("Chat could not open this device as a Writer", error);
		}
		try {
			const reopened = await openSession(context, "join", true, authority);
			if (closing) {
				await closeSession(reopened);
				return false;
			}
			room = reopened;
			observer = true;
			projection = reopened.projection();
			listeners.status(
				"This device can send after it has followed the room through a whole checkpoint. Your text is kept.",
				"error"
			);
		} catch (error) {
			openContext = undefined;
			projection = undefined;
			await context.archive?.close();
			archive = undefined;
			listeners.status("Chat closed while reopening. Join again with the signed invite.", "error");
			console.error("Chat reopen failed", error);
		}
		render();
		return false;
	};

	const open = async (
		operation: "create" | "join",
		creatorInvite: string
	): Promise<Readonly<{ view: ChatView; role: ChatOpenRole }>> => {
		if (closing || room !== undefined) throw new TypeError("Chat is already open");
		let opened: V3RoomSession<ShippingChatProjection> | undefined;
		let openedArchive: ShippingChatLocalArchive | undefined;
		try {
			let objectId: string;
			let invite: string | V3RoomCreatorInviteMaterial;
			let exactCanonicalLatchedAclBytes: Uint8Array;
			// The room's format: new rooms sign the shares catalog; a joined room is whichever catalog its
			// signed genesis names.
			let format: ShippingChatCatalog;
			if (operation === "create") {
				format = catalogs.shares;
				objectId = started.networkNode.peerId + ":" + hex(crypto.getRandomValues(new Uint8Array(16)));
				exactCanonicalLatchedAclBytes = encodeCanonical({
					epoch: 0,
					kind: "drp-v3-latched-acl",
					members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }],
					objectId,
					permissionless: false,
					version: CHAT_GENESIS_PROFILE.latchedAclVersion,
				});
				const signers = [{ publicKey: author, signerId: "creator" }];
				invite = await createV3RoomCreatorInviteMaterial({
					objectId,
					blueprintDigest: format.blueprintDigest,
					exactCanonicalApplicationStateBytes: createShippingChatSharesGenesisStateBytes({
						exactCanonicalLatchedAclBytes,
					}),
					exactCanonicalLatchedAclBytes,
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
						profileId: CHAT_GENESIS_PROFILE.profileId,
						quorum: 1,
						signers,
					}),
					exactCanonicalSignerSetBytes: encodeCanonical(signers),
					signGenesisAnchorDigest: (digest) => started.keychain.signWithLocalAuthor(digest),
				});
			} else {
				invite = creatorInvite;
				const authenticate = (
					candidate: ShippingChatCatalog
				): ReturnType<typeof authenticateV3RoomCreatorInvite> | undefined => {
					try {
						return authenticateV3RoomCreatorInvite({
							creatorInvite,
							application: {
								catalog: candidate.catalog,
								canonicalBlueprintPackageBytes: candidate.catalog.resolve(candidate.blueprintDigest)
									.canonicalBlueprintPackageBytes,
							},
						});
					} catch {
						return undefined;
					}
				};
				const sharesIdentity = authenticate(catalogs.shares);
				const windowIdentity = sharesIdentity === undefined ? authenticate(catalogs.window) : undefined;
				const identity =
					sharesIdentity ??
					windowIdentity ??
					authenticateV3RoomCreatorInvite({
						creatorInvite,
						application: {
							catalog: catalogs.lifetime.catalog,
							canonicalBlueprintPackageBytes: catalogs.lifetime.catalog.resolve(catalogs.lifetime.blueprintDigest)
								.canonicalBlueprintPackageBytes,
						},
					});
				format =
					sharesIdentity !== undefined
						? catalogs.shares
						: windowIdentity !== undefined
							? catalogs.window
							: catalogs.lifetime;
				objectId = identity.objectId;
				const material = decodeCanonical(bytes(invite)) as Record<string, unknown>;
				if (!(material.exactCanonicalLatchedAclBytes instanceof Uint8Array))
					throw new TypeError("Chat invite ACL is missing");
				exactCanonicalLatchedAclBytes = material.exactCanonicalLatchedAclBytes;
			}
			const application = await createShippingV3ChatApplication({
				catalog: format.catalog,
				blueprintDigest: format.blueprintDigest,
				exactCanonicalGenesisLatchedAclBytes: exactCanonicalLatchedAclBytes,
			});
			// The device archive opens first, in its own database, so it sees the first projection.
			// Chat works without it (a browser that refuses the database just shows the window).
			try {
				openedArchive = await openShippingChatLocalArchive({
					store: await openBrowserShippingChatArchiveStore(shippingChatArchiveDatabaseName(objectId, author)),
				});
			} catch (error) {
				console.warn("Chat device archive is unavailable; showing the room's shared window only", error);
			}
			// Decision A: this player's own room database; the shared (objectId-only) one migrates once.
			const { databaseName } = await prepareV3RoomPlayerDatabase({ application: "chat", objectId, author });
			const context: ChatOpenContext = Object.freeze({
				author,
				objectId,
				invite,
				application,
				shares: format === catalogs.shares,
				databaseName,
				archive: openedArchive,
			});
			// Signed genesis membership selects acquisition, not portable Writer
			// authority. Recovery and each ordinary operation recheck the native ACL.
			// A joiner outside the genesis ACL opens receive-only, unless this device
			// already reopened it as a Writer (shares rooms, after a grant).
			const enrolledWriter = isWriter(decodeCanonical(exactCanonicalLatchedAclBytes), author);
			let receiveOnly = !enrolledWriter && !(context.shares && (await readWriterReplica(context)));
			try {
				opened = await openSession(context, operation, receiveOnly);
			} catch (error) {
				if (enrolledWriter || !context.shares) throw error;
				// The other acquisition: a promoted replica whose mark was lost, or a stale mark.
				console.warn("Chat open failed; trying the other acquisition", error);
				try {
					opened = await openSession(context, operation, !receiveOnly);
				} catch {
					throw error;
				}
				receiveOnly = !receiveOnly;
				markWriterReplica(context, !receiveOnly);
			}
			if (closing) throw new TypeError("Chat closed during open");
			room = opened;
			archive = openedArchive;
			openContext = context;
			observer = receiveOnly;
			projection = opened.projection();
			openedArchive?.observe(projection);
			const current = view();
			listeners.view(current);
			updateShares();
			return { view: current, role: observer ? "observer" : enrolledWriter ? "enrolledWriter" : "writer" };
		} catch (error) {
			await closeSession(opened);
			await openedArchive?.close();
			archive = undefined;
			openContext = undefined;
			projection = undefined;
			throw error;
		}
	};

	const send = async (text: string): Promise<ChatSendOutcome> => {
		if (room === undefined || closing || sendBlocked() !== undefined) return "skipped";
		// A joiner's first Send in a shares room: reopen as a Writer, then issue at once.
		if (observer && !(await promoteToWriter())) return "skipped";
		const selected = room;
		if (selected === undefined || closing) return "skipped";
		if (pendingSend === undefined || pendingSend.author !== author || pendingSend.operation.text !== text) {
			pendingSend = Object.freeze({
				author,
				operation: captureShippingChatOperation(
					{ action: "message", clientOperationId: crypto.randomUUID(), displayTimeMs: Date.now(), text },
					author
				),
			});
		}
		const command = pendingSend;
		try {
			// A message refused at the checkpoint's allowance is offered again after the next rollover.
			await (rollovers.get(selected) ?? selected).issue({ ...command.operation });
		} catch (error) {
			// Not accepted, and kept by the room's policy (sent once the cause clears): nothing is lost and
			// the same text is a new message. Any other refusal keeps the operation for a retry.
			if (
				error instanceof V3RoomNotReachingHost ||
				error instanceof V3RoomReadOnly ||
				error instanceof V3RoomBusy ||
				error instanceof V3RoomSuccessorUnavailable
			)
				pendingSend = undefined;
			throw error;
		}
		if (room !== selected) return "superseded";
		if (pendingSend === command) pendingSend = undefined;
		return "sent";
	};

	return {
		open: (operation, invite) => track(open(operation, invite)),
		send: (text) => track(send(text)),
		changeWriter: (kind, target) =>
			track(
				(async (): Promise<boolean> => {
					const selected = room;
					if (selected === undefined || closing || !isAdmin()) return false;
					await selected.issue({ action: "acl", kind, group: "writer", target });
					return true;
				})()
			),
		view,
		network: (): ChatNetworkView => ({
			peerId: started.networkNode.peerId,
			author,
			peers: started.networkNode.getAllPeers(),
			discoveryPeers: started.networkNode.getGroupPeers(DRP_DISCOVERY_TOPIC),
			objectPeers: room?.connectedPeers() ?? [],
		}),
		refresh(): void {
			render();
			updateShares();
		},
		async close(): Promise<void> {
			closing = true;
			await Promise.allSettled([...operations]);
			await shareTask;
			await closeSession(room);
			await archive?.close();
		},
	};
}
