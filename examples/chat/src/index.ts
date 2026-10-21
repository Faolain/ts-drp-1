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
	createV3RoomSession,
	type V3RoomCreatorInviteMaterial,
	type V3RoomHeadAuthority,
	type V3RoomSession,
} from "@ts-drp/example-v3-room";
import { DRPNode } from "@ts-drp/node";
import { authenticateV3RoomCreatorInvite } from "@ts-drp/node/v3-room";
import { DRP_DISCOVERY_TOPIC } from "@ts-drp/types";

import { openShippingChatCatalogs, type ShippingChatCatalog } from "./chat-catalogs";
import { setupCopyButton } from "./util/clipboard";
import { createPeerNameElement, formatPeerItem, shortenId, styleMessageElement } from "./util/peerIdentity";
import { initializeToastContainer, showToast, ToastType } from "./util/toast";
import {
	captureShippingChatOperation,
	createShippingChatWindowGenesisStateBytes,
	createShippingV3ChatApplication,
	type ShippingChatMessageOperation,
	type ShippingChatProjection,
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
	}
}

const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
function bytes(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})+$/u.test(value)) throw new TypeError("Chat bytes are invalid");
	return Uint8Array.from(value.match(/../gu) as string[], (byte) => Number.parseInt(byte, 16));
}
// New rooms sign the rolling-window format; rooms whose genesis signed the lifetime format keep it.
const catalogs = openShippingChatCatalogs();

let node: DRPNode | undefined;
let room: V3RoomSession<ShippingChatProjection> | undefined;
let projection: ShippingChatProjection | undefined;
// This device's history of the open room (outside room storage; display only).
let archive: ShippingChatLocalArchive | undefined;
let openTask: Promise<void> | undefined;
let issueTask: Promise<void> | undefined;
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
function isWriter(acl: unknown, author: string): boolean {
	if (acl === null || typeof acl !== "object") return false;
	if (Reflect.get(acl, "permissionless") === true) return true;
	const members: unknown = Reflect.get(acl, "members");
	return (
		Array.isArray(members) &&
		members.some(
			(member: unknown) =>
				member !== null &&
				typeof member === "object" &&
				Reflect.get(member, "author") === author &&
				Array.isArray(Reflect.get(member, "groups")) &&
				Reflect.get(member, "groups").includes("writer")
		)
	);
}
function currentWriter(): boolean {
	return (
		!observer &&
		room !== undefined &&
		node !== undefined &&
		isWriter(Reflect.get(room.previewLatchedAcl(), "current"), node.keychain.localAuthorId)
	);
}

function render(): void {
	if (node !== undefined) {
		renderPeerList("peers", node.networkNode.getAllPeers());
		renderPeerList("discoveryPeers", node.networkNode.getGroupPeers(DRP_DISCOVERY_TOPIC));
		renderPeerList("objectPeers", room?.connectedPeers() ?? []);
		(document.getElementById("peerId") as HTMLElement).replaceChildren(formatPeerItem(node.networkNode.peerId));
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
	sendButton.disabled = closing || issueTask !== undefined || !currentWriter();
	messageInput.disabled = closing || !currentWriter();
	createButton.disabled = closing || openTask !== undefined || room !== undefined;
	joinButton.disabled = createButton.disabled;
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
		// The room's format: new rooms sign the window catalog; a joined room is whichever catalog its
		// signed genesis names.
		let format: ShippingChatCatalog;
		if (operation === "create") {
			format = catalogs.window;
			objectId = selectedNode.networkNode.peerId + ":" + hex(crypto.getRandomValues(new Uint8Array(16)));
			exactCanonicalLatchedAclBytes = encodeCanonical({
				epoch: 0,
				kind: "drp-v3-latched-acl",
				members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }],
				objectId,
				permissionless: false,
				version: 3,
			});
			const signers = [{ publicKey: author, signerId: "creator" }];
			invite = await createV3RoomCreatorInviteMaterial({
				objectId,
				blueprintDigest: format.blueprintDigest,
				exactCanonicalApplicationStateBytes: createShippingChatWindowGenesisStateBytes({
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
					profileId: "creator-trusted-settlement-v1",
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
			const windowIdentity = authenticate(catalogs.window);
			const identity =
				windowIdentity ??
				authenticateV3RoomCreatorInvite({
					creatorInvite,
					application: {
						catalog: catalogs.lifetime.catalog,
						canonicalBlueprintPackageBytes: catalogs.lifetime.catalog.resolve(catalogs.lifetime.blueprintDigest)
							.canonicalBlueprintPackageBytes,
					},
				});
			format = windowIdentity === undefined ? catalogs.lifetime : catalogs.window;
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
		const deviceArchive = openedArchive;
		const factory = window.__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__;
		if (typeof factory !== "function")
			throw new TypeError("Chat room-head authority is unavailable: the application host must configure its factory");
		const approveSettlementSourceSelection = window.__TS_DRP_CHAT_SETTLEMENT_SOURCE_APPROVAL__;
		if (approveSettlementSourceSelection !== undefined && typeof approveSettlementSourceSelection !== "function")
			throw new TypeError("Chat settlement approval policy is invalid");
		const authority = await factory(Object.freeze({ author, creatorInvite: invite, objectId, operation }));
		// Signed genesis membership selects acquisition, not portable Writer
		// authority. Recovery and each ordinary operation recheck the native ACL.
		const enrolledWriter = isWriter(decodeCanonical(exactCanonicalLatchedAclBytes), author);
		const databaseName =
			"ts-drp-v3-chat--" + hex(hashDomain("ts-drp/chat-database/v1", new TextEncoder().encode(objectId)));
		opened = await createV3RoomSession<ShippingChatProjection>({
			application,
			author,
			creatorInvite: invite,
			objectId,
			databaseName,
			issuanceDatabaseName: databaseName,
			migrationDatabaseNamespace: author + ":" + objectId,
			initialLogicalTime: 3,
			...(!enrolledWriter ? { receiveOnly: true as const } : {}),
			...(operation === "create"
				? { creatorFinalitySigner: await selectedNode.keychain.acquireLocalAuthorFinalitySigner() }
				: {}),
			roomHeadAuthority: authority,
			publicKeyBytes: bytes(author),
			createOperationAdmissionPolicy: application.createOperationAdmissionPolicy,
			// The host explicitly decides only after the shared owner authenticates
			// the exact proposal. No policy means protected work awaits approval.
			...(approveSettlementSourceSelection === undefined ? {} : { approveSettlementSourceSelection }),
			signRegisteredVertexDigest: (digest) => selectedNode.keychain.signWithLocalAuthor(digest),
			openTransport: (id) => selectedNode.openRoomNetwork(id),
			onAcceptedVertex: () => undefined,
			onProjection: (value) => {
				projection = value;
				// O(1): the archive writes in a later task, off this callback.
				deviceArchive?.observe(value);
				render();
			},
		});
		if (closing) throw new TypeError("Chat closed during open");
		room = opened;
		archive = deviceArchive;
		observer = !enrolledWriter;
		projection = opened.projection();
		deviceArchive?.observe(projection);
		status(
			observer
				? "Connected as an observer; this chat is read-only."
				: "Connected as an enrolled Writer. Creator-trusted chat; not Byzantine-fault-tolerant.",
			"ready"
		);
		render();
	} catch (error) {
		await opened?.close();
		await openedArchive?.close();
		archive = undefined;
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
	const selected = room;
	const author = node?.keychain.localAuthorId;
	if (selected === undefined || author === undefined || closing || !currentWriter()) return;
	const text = messageInput.value;
	if (text.length === 0) {
		showToast("Please enter a message", ToastType.ERROR, 5000);
		return;
	}
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
		await selected.issue({ ...command.operation });
		if (room !== selected) return;
		if (messageInput.value === command.operation.text) messageInput.value = "";
		if (pendingSend === command) pendingSend = undefined;
		status("Message accepted locally; remote delivery follows the room transport.", "ready");
	} catch (error) {
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
					await room?.close();
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
			roomInput.addEventListener("keydown", (event) => {
				if (event.key === "Enter") startOpen("join");
			});
			messageInput.addEventListener("keydown", (event) => {
				if (event.key === "Enter") startIssue();
			});
			status("Create a chat or paste a signed invite to join.", "ready");
			render();
			renderInterval = setInterval(render, 3000);
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
