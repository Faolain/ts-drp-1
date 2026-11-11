import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	acquireBrowserIdentity,
	createModularBrowserNetwork,
	getNetworkConfigFromEnv,
	isModularNetworkEnv,
	type ModularBrowserNetworkSession,
	readBrowserNetworkEnv,
} from "@ts-drp/example-browser-network";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomRolloverPolicy,
	openV3RoomSuccessorDelivery,
	createV3RoomSession,
	type V3RoomCreatorInviteMaterial,
	type V3RoomHeadAuthority,
	V3RoomNotReachingHost,
	V3RoomReadOnly,
	type V3RoomRolloverHooks,
	type V3RoomRolloverPolicy,
	type V3RoomSuccessorDelivery,
	V3RoomSuccessorUnavailable,
	type V3RoomSession,
	prepareV3RoomPlayerDatabase,
} from "@ts-drp/example-v3-room";
import { DRPNode } from "@ts-drp/node";
import { authenticateV3RoomCreatorInvite } from "@ts-drp/node/v3-room";
import { DRP_DISCOVERY_TOPIC } from "@ts-drp/types";

import { openShippingChatCatalogs, type ShippingChatCatalog } from "./chat-catalogs";
import { CHAT_GENESIS_PROFILE } from "./profile";
import { shippingChatRefusalClearedByRollover, shippingChatRolloverBudget } from "./rollover";
import { setupCopyButton } from "./util/clipboard";
import { createPeerNameElement, formatPeerItem, shortenId, styleMessageElement } from "./util/peerIdentity";
import { initializeToastContainer, showToast, ToastType } from "./util/toast";
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
	type ShippingChatLocalArchive,
} from "./v3-chat-archive";

type ChatHeadFactory = (
	context: Readonly<{
		author: string;
		creatorInvite: string | V3RoomCreatorInviteMaterial;
		objectId: string;
		operation: "create" | "join";
	}>
) => V3RoomHeadAuthority | Promise<V3RoomHeadAuthority>;
type ChatSettlementApproval = NonNullable<
	Parameters<typeof createV3RoomSession<ShippingChatProjection>>[0]["approveSettlementSourceSelection"]
>;
declare global {
	interface Window {
		__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__?: ChatHeadFactory;
		__TS_DRP_CHAT_SETTLEMENT_SOURCE_APPROVAL__?: ChatSettlementApproval;
		__TS_DRP_CHAT_SESSION__?: ModularBrowserNetworkSession;
		/**
		 * Test override of the creator's successor announcement. By default the page's successor
		 * delivery (examples/v3-room) announces each adopted offer to the room's members over the
		 * page's own node and answers their requests (a joiner must follow a checkpoint before it can
		 * send); with this hook, the hook receives the offers instead and the page announces nothing.
		 */
		__TS_DRP_CHAT_SUCCESSOR_PUBLISHER__?: NonNullable<V3RoomRolloverHooks["publishSuccessor"]>;
	}
}

const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
function bytes(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})+$/u.test(value)) throw new TypeError("Chat bytes are invalid");
	return Uint8Array.from(value.match(/../gu) as string[], (byte) => Number.parseInt(byte, 16));
}
// New rooms sign the membership-aware shares format (v5); rooms whose genesis signed the window
// (v4) or lifetime (v3) format keep it.
const catalogs = openShippingChatCatalogs();

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

let node: DRPNode | undefined;
let room: V3RoomSession<ShippingChatProjection> | undefined;
// Each open session's rollover policy (examples/chat/src/rollover.ts): the creator's seals at its
// budget; a Writer's only offers a refused message again after the next checkpoint.
const rollovers = new WeakMap<V3RoomSession<ShippingChatProjection>, V3RoomRolloverPolicy>();
// Each open session's successor delivery: the creator announces offers, members install them.
const deliveries = new WeakMap<V3RoomSession<ShippingChatProjection>, V3RoomSuccessorDelivery>();
/**
 * Closes a session and ends its rollover policy and successor delivery.
 * @param session - The session to close.
 */
async function closeSession(session: V3RoomSession<ShippingChatProjection> | undefined): Promise<void> {
	if (session === undefined) return;
	rollovers.get(session)?.close();
	deliveries.get(session)?.close();
	await session.close();
}
let projection: ShippingChatProjection | undefined;
// This device's history of the open room (outside room storage; display only).
let archive: ShippingChatLocalArchive | undefined;
let openContext: ChatOpenContext | undefined;
// The room-head authority the open room's replica was opened with (its account floor).
let roomAuthority: V3RoomHeadAuthority | undefined;
let openTask: Promise<void> | undefined;
let issueTask: Promise<void> | undefined;
let memberTask: Promise<void> | undefined;
let shareTask: Promise<void> | undefined;
// The share update this page last issued (`epoch:aclDigest`), and when a failed one may retry.
let shareIssued: string | undefined;
let shareRetryAt = 0;
let closing = false;
let observer = true;
let renderInterval: ReturnType<typeof setInterval> | undefined;
let renderedRoomId: string | undefined;
let pendingSend: Readonly<{ author: string; operation: ShippingChatMessageOperation }> | undefined;
const createButton = document.getElementById("createRoom") as HTMLButtonElement;
const joinButton = document.getElementById("joinRoom") as HTMLButtonElement;
const sendButton = document.getElementById("sendMessage") as HTMLButtonElement;
const roomInput = document.getElementById("roomInput") as HTMLInputElement;
const messageInput = document.getElementById("messageInput") as HTMLInputElement;
const membershipPanel = document.getElementById("membershipPanel") as HTMLElement;
const memberInput = document.getElementById("memberInput") as HTMLInputElement;
const grantButton = document.getElementById("grantWriter") as HTMLButtonElement;
const revokeButton = document.getElementById("revokeWriter") as HTMLButtonElement;

function status(message: string, state: "joining" | "ready" | "error"): void {
	const element = document.getElementById("chatStatus") as HTMLElement;
	element.textContent = message;
	element.dataset.state = state;
}

function setupCollapsibleSections(): void {
	const toggle = document.getElementById("infoToggle");
	const container = document.querySelector(".info-container");
	if (toggle === null || container === null) return;
	const updateLabel = (): void => {
		const label = toggle.querySelector(".toggle-text");
		if (label !== null)
			label.textContent = container.classList.contains("expanded") ? "Hide Connection Info" : "Show Connection Info";
	};
	toggle.addEventListener("click", () => {
		container.classList.toggle("expanded");
		updateLabel();
	});
	const resize = (): void => {
		container.classList.toggle("expanded", window.innerWidth > 767);
		updateLabel();
	};
	resize();
	window.addEventListener("resize", resize);
}

function renderPeerList(id: string, peers: readonly string[]): void {
	(document.getElementById(id) as HTMLElement).replaceChildren(...peers.map((peer) => formatPeerItem(peer)));
}
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
/**
 * The open room's current latched ACL.
 * @returns The ACL, or undefined while no room is open.
 */
function currentAcl(): unknown {
	if (room === undefined) return undefined;
	try {
		return Reflect.get(room.previewLatchedAcl(), "current");
	} catch {
		return undefined;
	}
}
/**
 * Whether this device may send now, and if not, why. In a shares (v5) room a Writer sends from the
 * checkpoint its share row names; a joiner's page opened receive-only reopens as a Writer on Send.
 * Rooms of the window and lifetime formats keep their rule: genesis Writers only.
 * @returns `undefined` when sending is open, else the reason shown beside the message box.
 */
function sendBlocked(): string | undefined {
	const author = node?.keychain.localAuthorId;
	if (room === undefined || author === undefined || openContext === undefined) return "";
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
}
function canSend(): boolean {
	return sendBlocked() === undefined;
}
function isAdmin(): boolean {
	const author = node?.keychain.localAuthorId;
	return !observer && author !== undefined && inGroup(currentAcl(), author, "admin");
}

function render(): void {
	if (node !== undefined) {
		renderPeerList("peers", node.networkNode.getAllPeers());
		renderPeerList("discoveryPeers", node.networkNode.getGroupPeers(DRP_DISCOVERY_TOPIC));
		renderPeerList("objectPeers", room?.connectedPeers() ?? []);
		(document.getElementById("peerId") as HTMLElement).replaceChildren(formatPeerItem(node.networkNode.peerId));
		// The ID an admin needs to make this device's author a Writer.
		const authorId = document.getElementById("authorId") as HTMLElement;
		if (authorId.dataset.author !== node.keychain.localAuthorId) {
			authorId.dataset.author = node.keychain.localAuthorId;
			authorId.textContent = node.keychain.localAuthorId;
		}
	}
	if (room?.objectId !== renderedRoomId) {
		const roomId = document.getElementById("chatId") as HTMLElement;
		roomId.textContent = room === undefined ? "" : shortenId(room.objectId);
		roomId.dataset.fullId = room?.objectId ?? "";
		roomId.dataset.invite = room?.invite ?? "";
		(document.getElementById("chatInvite") as HTMLTextAreaElement).value = room?.invite ?? "";
		(document.getElementById("chatInviteRow") as HTMLElement).hidden = room === undefined;
		renderedRoomId = room?.objectId;
	}
	const chat = document.getElementById("chat") as HTMLElement;
	chat.replaceChildren();
	// The shared window plus the messages only this device still keeps (each once).
	const messages = projection === undefined ? [] : shippingChatHistory(projection.messages, archive?.records() ?? []);
	if (messages.length === 0) {
		const empty = document.createElement("div");
		empty.className = "no-messages";
		empty.textContent = room === undefined ? "Create or join a chat room to begin." : "No messages yet";
		chat.appendChild(empty);
	} else {
		for (const message of messages) {
			const row = document.createElement("div");
			row.className =
				"message" +
				(message.author === node?.keychain.localAuthorId ? " self" : "") +
				(message.inWindow ? "" : " archived");
			// Older messages kept on this device only: no longer in the room's shared window.
			if (!message.inWindow) row.title = "Kept on this device; no longer in the room's shared history.";
			row.dataset.author = message.author;
			row.dataset.clientOperationId = message.clientOperationId;
			row.dataset.displayTimeMs = String(message.displayTimeMs);
			const timestamp = document.createElement("div");
			timestamp.className = "message-timestamp";
			const date = new Date(message.displayTimeMs);
			timestamp.textContent = date.toLocaleDateString() + " " + date.toLocaleTimeString();
			const sender = document.createElement("div");
			sender.className = "message-sender";
			sender.appendChild(createPeerNameElement(message.author));
			const content = document.createElement("div");
			content.className = "message-content";
			content.textContent = message.text;
			row.append(timestamp, sender, content);
			styleMessageElement(row, message.author);
			chat.appendChild(row);
		}
		chat.scrollTop = chat.scrollHeight;
	}
	const blocked = sendBlocked();
	sendButton.disabled = closing || issueTask !== undefined || blocked !== undefined;
	messageInput.disabled = closing || blocked !== undefined;
	(document.getElementById("sendHint") as HTMLElement).textContent = blocked ?? "";
	const admin = room !== undefined && isAdmin();
	membershipPanel.hidden = !admin;
	grantButton.disabled = revokeButton.disabled = closing || memberTask !== undefined || !admin;
	// A joiner's reopen as a Writer runs inside its Send, with no room open for a moment.
	createButton.disabled = closing || openTask !== undefined || issueTask !== undefined || room !== undefined;
	joinButton.disabled = createButton.disabled;
}

/**
 * An admin's page keeps the room's share rows matching its current ACL: once per checkpoint whose
 * rows differ from the share formula, it issues the share update. Every admin computes the same
 * rows, so duplicates change nothing; an update that misses its checkpoint expires, and the next
 * checkpoint's projection asks again.
 */
function updateShares(): void {
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
}

// Per-device mark that this room's replica was reopened as a Writer (a receive-only open of it
// would fail: it holds this device's own signed work). Display convenience only; a lost mark
// is recovered by trying the other acquisition.
function writerReplicaKey(context: ChatOpenContext): string {
	return "ts-drp:chat:v3:writer-replica:" + context.objectId + ":" + context.author;
}
function readWriterReplica(context: ChatOpenContext): boolean {
	try {
		return localStorage.getItem(writerReplicaKey(context)) === "1";
	} catch {
		return false;
	}
}
function markWriterReplica(context: ChatOpenContext, writer: boolean): void {
	try {
		if (writer) localStorage.setItem(writerReplicaKey(context), "1");
		else localStorage.removeItem(writerReplicaKey(context));
	} catch {
		// Storage refused: the next open tries the other acquisition.
	}
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
 * Opens the room's session over this device's databases.
 * @param context - The room, invite, format and device archive.
 * @param operation - Create (the creator's first open) or join.
 * @param receiveOnly - Open as an observer.
 * @param reopen - The open room's authority, for a reopen of the same replica (else the host's
 * factory acquires one).
 * @returns The open session.
 */
async function openSession(
	context: ChatOpenContext,
	operation: "create" | "join",
	receiveOnly: boolean,
	reopen?: V3RoomHeadAuthority
): Promise<V3RoomSession<ShippingChatProjection>> {
	const selectedNode = node;
	if (selectedNode === undefined) throw new TypeError("Chat node is unavailable");
	const factory = window.__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__;
	if (typeof factory !== "function")
		throw new TypeError("Chat room-head authority is unavailable: the application host must configure its factory");
	const approveSettlementSourceSelection = window.__TS_DRP_CHAT_SETTLEMENT_SOURCE_APPROVAL__;
	if (approveSettlementSourceSelection !== undefined && typeof approveSettlementSourceSelection !== "function")
		throw new TypeError("Chat settlement approval policy is invalid");
	const { author, objectId, invite, application, databaseName, archive: deviceArchive } = context;
	const authority =
		reopen === undefined
			? await factory(Object.freeze({ author, creatorInvite: invite, objectId, operation }))
			: reopenedAuthority(reopen);
	roomAuthority = reopen ?? authority;
	const publishSuccessor = window.__TS_DRP_CHAT_SUCCESSOR_PUBLISHER__;
	if (publishSuccessor !== undefined && typeof publishSuccessor !== "function")
		throw new TypeError("Chat successor publisher is invalid");
	const successors = openV3RoomSuccessorDelivery(
		selectedNode,
		objectId,
		operation === "create" ? "creator" : "member",
		{
			onError: (error) => console.warn("Chat successor delivery failed; it is retried", error),
			onRefused: (error) => console.warn("Chat successor offer was refused", error),
		}
	);
	// Only the creator's first open holds the finality signer, so only it seals. An observer issues
	// nothing and needs no policy; its delivery still installs each successor.
	const policy = receiveOnly
		? undefined
		: createV3RoomRolloverPolicy({
				role: operation === "create" ? "creator" : "member",
				budget: shippingChatRolloverBudget({ objectId, shares: context.shares }),
				hooks: {
					publishSuccessor: publishSuccessor ?? ((offer, epoch): Promise<void> => successors.publish(offer, epoch)),
					requestSuccessor: () => successors.request(),
					creatorReachable: () => successors.creatorReachable(),
					clearedByRollover: shippingChatRefusalClearedByRollover,
					onError: (error) => console.warn("Chat rollover failed; it is retried", error),
				},
			});
	let session: V3RoomSession<ShippingChatProjection>;
	try {
		session = await createV3RoomSession<ShippingChatProjection>({
			application,
			author,
			creatorInvite: invite,
			objectId,
			databaseName,
			issuanceDatabaseName: databaseName,
			migrationDatabaseNamespace: author + ":" + objectId,
			initialLogicalTime: 3,
			...(receiveOnly ? { receiveOnly: true as const } : {}),
			...(operation === "create"
				? {
						creatorFinalitySigner: await selectedNode.keychain.acquireLocalAuthorFinalitySigner(),
						// Creator restore currency: a creator reopened from storage asks the members first.
						creatorMemberView: successors.creatorMemberView,
					}
				: {}),
			roomHeadAuthority: authority,
			publicKeyBytes: bytes(author),
			createOperationAdmissionPolicy: application.createOperationAdmissionPolicy,
			// The host explicitly decides only after the shared owner authenticates
			// the exact proposal. No policy means protected work awaits approval.
			...(approveSettlementSourceSelection === undefined ? {} : { approveSettlementSourceSelection }),
			signRegisteredVertexDigest: (digest) => selectedNode.keychain.signWithLocalAuthor(digest),
			openTransport: (id) => selectedNode.openRoomNetwork(id),
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
}

/**
 * A joiner's page follows a shares room receive-only. Once its author is a Writer whose share is in
 * force, Send reopens the same databases as a Writer and the message is issued at once: the
 * library opens a Writer's replica only over a checkpoint it followed, so the page does not
 * reopen it any earlier. If the reopen fails (for example on a device that did not follow the
 * previous checkpoint), the page goes back to following the room and keeps the text.
 * @returns Whether the room is now open as a Writer.
 */
async function promoteToWriter(): Promise<boolean> {
	const context = openContext;
	const current = room;
	const authority = roomAuthority;
	if (context === undefined || current === undefined || authority === undefined) return false;
	if (!observer) return true;
	status("Opening this device as a Writer…", "joining");
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
		status("Connected as a Writer. Creator-trusted chat; not Byzantine-fault-tolerant.", "ready");
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
		status(
			"This device can send after it has followed the room through a whole checkpoint. Your text is kept.",
			"error"
		);
	} catch (error) {
		openContext = undefined;
		projection = undefined;
		await context.archive?.close();
		archive = undefined;
		status("Chat closed while reopening. Join again with the signed invite.", "error");
		console.error("Chat reopen failed", error);
	}
	return false;
}

async function openChat(operation: "create" | "join"): Promise<void> {
	const selectedNode = node;
	if (selectedNode === undefined || closing || room !== undefined) return;
	status(operation === "create" ? "Creating chat…" : "Joining chat…", "joining");
	let opened: V3RoomSession<ShippingChatProjection> | undefined;
	let openedArchive: ShippingChatLocalArchive | undefined;
	try {
		const author = selectedNode.keychain.localAuthorId;
		let objectId: string;
		let invite: string | V3RoomCreatorInviteMaterial;
		let exactCanonicalLatchedAclBytes: Uint8Array;
		// The room's format: new rooms sign the shares catalog; a joined room is whichever catalog its
		// signed genesis names.
		let format: ShippingChatCatalog;
		if (operation === "create") {
			format = catalogs.shares;
			objectId = selectedNode.networkNode.peerId + ":" + hex(crypto.getRandomValues(new Uint8Array(16)));
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
				signGenesisAnchorDigest: (digest) => selectedNode.keychain.signWithLocalAuthor(digest),
			});
		} else {
			const creatorInvite = roomInput.value.trim();
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
		let receiveOnly = !enrolledWriter && !(context.shares && readWriterReplica(context));
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
		status(
			observer
				? "Connected as an observer; this chat is read-only."
				: enrolledWriter
					? "Connected as an enrolled Writer. Creator-trusted chat; not Byzantine-fault-tolerant."
					: "Connected as a Writer. Creator-trusted chat; not Byzantine-fault-tolerant.",
			"ready"
		);
		render();
		updateShares();
	} catch (error) {
		await closeSession(opened);
		await openedArchive?.close();
		archive = undefined;
		openContext = undefined;
		projection = undefined;
		status(
			error instanceof Error ? error.message : "Could not open chat. Check the signed invite and configured host.",
			"error"
		);
		showToast("Could not open chat. Check the signed invite and host configuration.", ToastType.ERROR, 5000);
		console.error("Chat open failed", error);
	}
}

function startOpen(operation: "create" | "join"): void {
	if (closing || openTask !== undefined || room !== undefined) return;
	const task = openChat(operation);
	openTask = task;
	render();
	void task
		.finally(() => {
			if (openTask === task) openTask = undefined;
			render();
		})
		.catch((error: unknown) => console.error("Chat open cleanup failed", error));
}

async function issueMessage(): Promise<void> {
	const author = node?.keychain.localAuthorId;
	if (room === undefined || author === undefined || closing || !canSend()) return;
	const text = messageInput.value;
	if (text.length === 0) {
		showToast("Please enter a message", ToastType.ERROR, 5000);
		return;
	}
	// A joiner's first Send in a shares room: reopen as a Writer, then issue at once.
	if (observer && !(await promoteToWriter())) return;
	const selected = room;
	if (selected === undefined || closing) return;
	try {
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
		// A message refused at the checkpoint's allowance is offered again after the next rollover.
		await (rollovers.get(selected) ?? selected).issue({ ...command.operation });
		if (room !== selected) return;
		if (messageInput.value === command.operation.text) messageInput.value = "";
		if (pendingSend === command) pendingSend = undefined;
		status("Message accepted locally; remote delivery follows the room transport.", "ready");
	} catch (error) {
		if (error instanceof V3RoomNotReachingHost || error instanceof V3RoomReadOnly) {
			// Not accepted, so nothing is lost: the room's policy keeps the message and sends it once this
			// member's messages reach the host again.
			if (pendingSend?.operation.text === messageInput.value) messageInput.value = "";
			pendingSend = undefined;
			status(
				error instanceof V3RoomReadOnly
					? `Can't send: the room's host is unreachable. Your message "${String(error.operation.text ?? "")}" is kept and is sent once the host is back.`
					: `Can't send: your messages are not reaching the host. Your message "${String(error.operation.text ?? "")}" is kept and is sent once they do.`,
				"error"
			);
			return;
		}
		if (error instanceof V3RoomSuccessorUnavailable) {
			// The room's policy keeps the message and sends it once the next checkpoint arrives.
			if (pendingSend?.operation.text === messageInput.value) messageInput.value = "";
			pendingSend = undefined;
			status(
				`No new checkpoint has arrived from the creator yet. Your message "${String(error.operation.text ?? "")}" is kept and is sent once it arrives.`,
				"error"
			);
			return;
		}
		// Complete author/identity/time payload and text survive a refused retry.
		status(error instanceof Error ? error.message : "Message refused. Retained text can be retried.", "error");
		showToast("Message refused. Your text is retained for retry.", ToastType.ERROR, 5000);
	}
}
function startIssue(): void {
	if (closing || issueTask !== undefined) return;
	const task = issueMessage();
	issueTask = task;
	render();
	void task
		.finally(() => {
			if (issueTask === task) issueTask = undefined;
			render();
		})
		.catch((error: unknown) => console.error("Chat issue cleanup failed", error));
}

/**
 * The admin's grant or revoke of `writer` for one author, through the library's ACL operation. It
 * latches at the next checkpoint; in a shares room the admin's page then gives a new Writer a share
 * (from the checkpoint after), and a departed member's messages stay until the window needs room.
 * @param kind - Grant or revoke.
 */
async function changeWriter(kind: "grant" | "revoke"): Promise<void> {
	const selected = room;
	const author = node?.keychain.localAuthorId;
	if (selected === undefined || author === undefined || closing || !isAdmin()) return;
	const target = memberInput.value.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/u.test(target)) {
		status("Enter the member's author ID: 64 hexadecimal characters.", "error");
		return;
	}
	if (target === author) {
		status("This page does not change your own membership.", "error");
		return;
	}
	try {
		await selected.issue({ action: "acl", kind, group: "writer", target });
		if (memberInput.value.trim().toLowerCase() === target) memberInput.value = "";
		status(
			kind === "grant"
				? "Writer granted from the next checkpoint; the member can send once its share is in force."
				: "Writer revoked from the next checkpoint; the member's messages stay until the window needs the space.",
			"ready"
		);
	} catch (error) {
		status(error instanceof Error ? error.message : "Membership change refused.", "error");
		showToast("Membership change refused.", ToastType.ERROR, 5000);
	}
}
function startMemberChange(kind: "grant" | "revoke"): void {
	if (closing || memberTask !== undefined) return;
	const task = changeWriter(kind);
	memberTask = task;
	render();
	void task
		.finally(() => {
			if (memberTask === task) memberTask = undefined;
			render();
		})
		.catch((error: unknown) => console.error("Chat membership change cleanup failed", error));
}

async function main(): Promise<void> {
	initializeToastContainer();
	setupCollapsibleSections();
	const identity = await acquireBrowserIdentity({
		lockPrefix: "ts-drp:chat:v3:identity-slot",
		seedKey: "ts-drp:chat:v3:identity-seed",
	});
	let modular: ModularBrowserNetworkSession | undefined;
	let disposeCopy: (() => void) | undefined;
	try {
		const environment = readBrowserNetworkEnv(import.meta.env);
		const selected = getNetworkConfigFromEnv(environment, window.location.origin);
		const config = { ...selected, keychain_config: { ...selected.keychain_config, private_key_seed: identity.seed } };
		modular = isModularNetworkEnv(environment) ? createModularBrowserNetwork(config, environment) : undefined;
		node = modular?.node ?? new DRPNode(config);
		await node.start();
		if (modular !== undefined) {
			window.__TS_DRP_CHAT_SESSION__ = modular;
			window.dispatchEvent(new CustomEvent("ts-drp:chat-ready", { detail: modular.snapshot() }));
		}
		window.addEventListener(
			"beforeunload",
			() => {
				closing = true;
				if (renderInterval !== undefined) clearInterval(renderInterval);
				disposeCopy?.();
				void (async (): Promise<void> => {
					await openTask;
					await issueTask;
					await memberTask;
					await shareTask;
					await closeSession(room);
					await archive?.close();
					await (modular?.stop() ?? node?.stop());
					identity.release();
				})().catch((error: unknown) =>
					console.error("Chat shutdown failed; custody retained until document termination", error)
				);
			},
			{ once: true }
		);
		let bound = false;
		await node.networkNode.isDialable(() => {
			if (bound) return;
			bound = true;
			disposeCopy = setupCopyButton();
			createButton.addEventListener("click", () => startOpen("create"));
			joinButton.addEventListener("click", () => startOpen("join"));
			sendButton.addEventListener("click", startIssue);
			grantButton.addEventListener("click", () => startMemberChange("grant"));
			revokeButton.addEventListener("click", () => startMemberChange("revoke"));
			roomInput.addEventListener("keydown", (event) => {
				if (event.key === "Enter") startOpen("join");
			});
			messageInput.addEventListener("keydown", (event) => {
				if (event.key === "Enter") startIssue();
			});
			status("Create a chat or paste a signed invite to join.", "ready");
			render();
			renderInterval = setInterval(() => {
				render();
				updateShares();
			}, 3000);
		});
	} catch (error) {
		await node?.stop();
		identity.release();
		throw error;
	}
}
void main().catch((error: unknown) => {
	status("Chat could not start. Check the configured catalog, identity and network.", "error");
	console.error("Chat startup failed", error);
});
