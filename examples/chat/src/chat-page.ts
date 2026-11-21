/**
 * The Chat page's rendering and input, whichever runtime hosts the room (a room worker by default,
 * the main thread with `?mainThread`): the views it renders are chat-room.ts's, and its controls call
 * the room through ChatPageRoom.
 */
import { V3RoomBusy, V3RoomNotReachingHost, V3RoomReadOnly, V3RoomSuccessorUnavailable } from "@ts-drp/example-v3-room";

import type {
	ChatHeadFactory,
	ChatNetworkView,
	ChatOpenRole,
	ChatSendOutcome,
	ChatSettlementApproval,
	ChatStatusState,
	ChatSuccessorPublisher,
	ChatView,
} from "./chat-room";
import { setupCopyButton } from "./util/clipboard";
import { createPeerNameElement, formatPeerItem, shortenId, styleMessageElement } from "./util/peerIdentity";
import { initializeToastContainer, showToast, ToastType } from "./util/toast";

/**
 * The page's network session diagnostics. On the main thread it is the modular session itself; with
 * the room in a worker, `snapshot()` is the worker's last published summary (peer id and relay
 * reservations) and `diagnostics()` reads the whole snapshot from the worker.
 */
export interface ChatSessionGlobal {
	snapshot(): Readonly<{ peerId: string; relayReservations: readonly unknown[] }>;
}

declare global {
	interface Window {
		__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__?: ChatHeadFactory;
		__TS_DRP_CHAT_SETTLEMENT_SOURCE_APPROVAL__?: ChatSettlementApproval;
		__TS_DRP_CHAT_SESSION__?: ChatSessionGlobal;
		/**
		 * Test override of the creator's successor announcement. By default the room's successor
		 * delivery (examples/v3-room) announces each adopted offer to the room's members over the
		 * node and answers their requests (a joiner must follow a checkpoint before it can send);
		 * with this hook, the hook receives the offers instead and the room announces nothing.
		 */
		__TS_DRP_CHAT_SUCCESSOR_PUBLISHER__?: ChatSuccessorPublisher;
	}
}

/** The room as the page's controls reach it. */
export interface ChatPageRoom {
	open(operation: "create" | "join", invite: string): Promise<Readonly<{ view: ChatView; role: ChatOpenRole }>>;
	send(text: string): Promise<ChatSendOutcome>;
	changeWriter(kind: "grant" | "revoke", target: string): Promise<boolean>;
}

/**
 *
 * @param message
 * @param state
 */
export function status(message: string, state: ChatStatusState): void {
	const element = document.getElementById("chatStatus") as HTMLElement;
	element.textContent = message;
	element.dataset.state = state;
}

/** The per-device Writer-replica mark, in the page's localStorage (chat-room.ts's ChatRoomHost). */
export const writerReplicaStorage = Object.freeze({
	read(key: string): boolean {
		try {
			return localStorage.getItem(key) === "1";
		} catch {
			return false;
		}
	},
	mark(key: string, writer: boolean): void {
		try {
			if (writer) localStorage.setItem(key, "1");
			else localStorage.removeItem(key);
		} catch {
			// Storage refused: the next open tries the other acquisition.
		}
	},
});

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

/** The page's state and its rendering of the room's views. */
export interface ChatPage {
	/** Renders a chat view (open, projection, reopen). */
	view(next: ChatView): void;
	/** Renders the peer panel. */
	network(next: ChatNetworkView): void;
	/** Binds the controls to the room and enables them (once the node is dialable). */
	bind(room: ChatPageRoom): void;
	/** The page is unloading: no more opens, sends or membership changes. */
	unload(): void;
}

/**
 *
 */
export function createChatPage(): ChatPage {
	initializeToastContainer();
	setupCollapsibleSections();
	const createButton = document.getElementById("createRoom") as HTMLButtonElement;
	const joinButton = document.getElementById("joinRoom") as HTMLButtonElement;
	const sendButton = document.getElementById("sendMessage") as HTMLButtonElement;
	const roomInput = document.getElementById("roomInput") as HTMLInputElement;
	const messageInput = document.getElementById("messageInput") as HTMLInputElement;
	const membershipPanel = document.getElementById("membershipPanel") as HTMLElement;
	const memberInput = document.getElementById("memberInput") as HTMLInputElement;
	const grantButton = document.getElementById("grantWriter") as HTMLButtonElement;
	const revokeButton = document.getElementById("revokeWriter") as HTMLButtonElement;

	let current: ChatView | undefined;
	let room: ChatPageRoom | undefined;
	let renderedRoomId: string | undefined;
	let openTask: Promise<void> | undefined;
	let issueTask: Promise<void> | undefined;
	let memberTask: Promise<void> | undefined;
	let closing = false;
	let disposeCopy: (() => void) | undefined;

	const render = (): void => {
		const roomId = current?.roomId;
		if (roomId !== renderedRoomId) {
			const element = document.getElementById("chatId") as HTMLElement;
			element.textContent = roomId === undefined ? "" : shortenId(roomId);
			element.dataset.fullId = roomId ?? "";
			element.dataset.invite = current?.invite ?? "";
			(document.getElementById("chatInvite") as HTMLTextAreaElement).value = current?.invite ?? "";
			(document.getElementById("chatInviteRow") as HTMLElement).hidden = roomId === undefined;
			renderedRoomId = roomId;
		}
		const chat = document.getElementById("chat") as HTMLElement;
		chat.replaceChildren();
		// The shared window plus the messages only this device still keeps (each once), each author's messages
		// in their signed display-time order, authors interleaved by admitted order (shippingChatDisplayOrder).
		const messages = current?.messages ?? [];
		if (messages.length === 0) {
			const empty = document.createElement("div");
			empty.className = "no-messages";
			empty.textContent = roomId === undefined ? "Create or join a chat room to begin." : "No messages yet";
			chat.appendChild(empty);
		} else {
			for (const message of messages) {
				const row = document.createElement("div");
				row.className =
					"message" + (message.author === current?.author ? " self" : "") + (message.inWindow ? "" : " archived");
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
		const blocked = current === undefined ? "" : current.sendBlocked;
		sendButton.disabled = closing || issueTask !== undefined || blocked !== undefined;
		messageInput.disabled = closing || blocked !== undefined;
		(document.getElementById("sendHint") as HTMLElement).textContent = blocked ?? "";
		const admin = current?.admin === true;
		membershipPanel.hidden = !admin;
		grantButton.disabled = revokeButton.disabled = closing || memberTask !== undefined || !admin;
		// A joiner's reopen as a Writer runs inside its Send, with no room open for a moment.
		createButton.disabled =
			closing || room === undefined || openTask !== undefined || issueTask !== undefined || roomId !== undefined;
		joinButton.disabled = createButton.disabled;
	};

	const openChat = async (selected: ChatPageRoom, operation: "create" | "join"): Promise<void> => {
		status(operation === "create" ? "Creating chat…" : "Joining chat…", "joining");
		try {
			const opened = await selected.open(operation, roomInput.value.trim());
			current = opened.view;
			status(
				opened.role === "observer"
					? "Connected as an observer; this chat is read-only."
					: opened.role === "enrolledWriter"
						? "Connected as an enrolled Writer. Creator-trusted chat; not Byzantine-fault-tolerant."
						: "Connected as a Writer. Creator-trusted chat; not Byzantine-fault-tolerant.",
				"ready"
			);
			render();
		} catch (error) {
			status(
				error instanceof Error ? error.message : "Could not open chat. Check the signed invite and configured host.",
				"error"
			);
			showToast("Could not open chat. Check the signed invite and host configuration.", ToastType.ERROR, 5000);
			console.error("Chat open failed", error);
		}
	};
	const startOpen = (operation: "create" | "join"): void => {
		const selected = room;
		if (selected === undefined || closing || openTask !== undefined || current?.roomId !== undefined) return;
		const task = openChat(selected, operation);
		openTask = task;
		render();
		void task
			.finally(() => {
				if (openTask === task) openTask = undefined;
				render();
			})
			.catch((error: unknown) => console.error("Chat open cleanup failed", error));
	};

	const issueMessage = async (selected: ChatPageRoom): Promise<void> => {
		if (current?.roomId === undefined || closing || current.sendBlocked !== undefined) return;
		const text = messageInput.value;
		if (text.length === 0) {
			showToast("Please enter a message", ToastType.ERROR, 5000);
			return;
		}
		try {
			const outcome = await selected.send(text);
			if (outcome !== "sent") return;
			if (messageInput.value === text) messageInput.value = "";
			status("Message accepted locally; remote delivery follows the room transport.", "ready");
		} catch (error) {
			// Typed room refusals keep their classes across the room worker's boundary.
			if (error instanceof V3RoomNotReachingHost || error instanceof V3RoomReadOnly) {
				// Not accepted, so nothing is lost: the room's policy keeps the message and sends it once this
				// member's messages reach the host again.
				if (messageInput.value === text) messageInput.value = "";
				status(
					error instanceof V3RoomReadOnly
						? `Can't send: the room's host is unreachable. Your message "${String(error.operation.text ?? "")}" is kept and is sent once the host is back.`
						: `Can't send: your messages are not reaching the host. Your message "${String(error.operation.text ?? "")}" is kept and is sent once they do.`,
					"error"
				);
				return;
			}
			if (error instanceof V3RoomBusy) {
				// The room's policy keeps the message and sends it once the room takes work again.
				if (messageInput.value === text) messageInput.value = "";
				status(
					`The room is busy catching up. Your message "${String(error.operation.text ?? "")}" is kept and is sent once it is done.`,
					"error"
				);
				return;
			}
			if (error instanceof V3RoomSuccessorUnavailable) {
				// The room's policy keeps the message and sends it once the next checkpoint arrives.
				if (messageInput.value === text) messageInput.value = "";
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
	};
	const startIssue = (): void => {
		const selected = room;
		if (selected === undefined || closing || issueTask !== undefined) return;
		const task = issueMessage(selected);
		issueTask = task;
		render();
		void task
			.finally(() => {
				if (issueTask === task) issueTask = undefined;
				render();
			})
			.catch((error: unknown) => console.error("Chat issue cleanup failed", error));
	};

	/**
	 * The admin's grant or revoke of `writer` for one author, through the library's ACL operation. It
	 * latches at the next checkpoint; in a shares room the admin's room then gives a new Writer a share
	 * (from the checkpoint after), and a departed member's messages stay until the window needs room.
	 * @param selected - The room.
	 * @param kind - Grant or revoke.
	 */
	const changeWriter = async (selected: ChatPageRoom, kind: "grant" | "revoke"): Promise<void> => {
		if (current?.roomId === undefined || closing || !current.admin) return;
		const target = memberInput.value.trim().toLowerCase();
		if (!/^[0-9a-f]{64}$/u.test(target)) {
			status("Enter the member's author ID: 64 hexadecimal characters.", "error");
			return;
		}
		if (target === current.author) {
			status("This page does not change your own membership.", "error");
			return;
		}
		try {
			if (!(await selected.changeWriter(kind, target))) return;
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
	};
	const startMemberChange = (kind: "grant" | "revoke"): void => {
		const selected = room;
		if (selected === undefined || closing || memberTask !== undefined) return;
		const task = changeWriter(selected, kind);
		memberTask = task;
		render();
		void task
			.finally(() => {
				if (memberTask === task) memberTask = undefined;
				render();
			})
			.catch((error: unknown) => console.error("Chat membership change cleanup failed", error));
	};

	return {
		view(next): void {
			current = next;
			render();
		},
		network(next): void {
			renderPeerList("peers", next.peers);
			renderPeerList("discoveryPeers", next.discoveryPeers);
			renderPeerList("objectPeers", next.objectPeers);
			(document.getElementById("peerId") as HTMLElement).replaceChildren(formatPeerItem(next.peerId));
			// The ID an admin needs to make this device's author a Writer.
			const authorId = document.getElementById("authorId") as HTMLElement;
			if (authorId.dataset.author !== next.author) {
				authorId.dataset.author = next.author;
				authorId.textContent = next.author;
			}
		},
		bind(selected): void {
			if (room !== undefined) return;
			room = selected;
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
		},
		unload(): void {
			closing = true;
			disposeCopy?.();
		},
	};
}
