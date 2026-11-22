/**
 * The Canvas page's rendering and input, whichever runtime hosts the room (a room worker by default,
 * the main thread with `?mainThread`): the views it renders are canvas-room.ts's, and its controls
 * call the room through CanvasPageRoom.
 */
import { V3RoomBusy, V3RoomNotReachingHost, V3RoomReadOnly, V3RoomSuccessorUnavailable } from "@ts-drp/example-v3-room";

import {
	CANVAS_SIDE,
	type CanvasHeadFactory,
	type CanvasNetworkView,
	type CanvasSettlementApproval,
	type CanvasSuccessorPublisher,
	type CanvasView,
} from "./canvas-room";

/**
 * The page's network session diagnostics. On the main thread it is the modular session itself; with
 * the room in a worker, `snapshot()` is the worker's last published summary (peer id and relay
 * reservations) and `diagnostics()` reads the whole snapshot from the worker.
 */
export interface CanvasSessionGlobal {
	snapshot(): Readonly<{ peerId: string; relayReservations: readonly unknown[] }>;
}

declare global {
	interface Window {
		__TS_DRP_CANVAS_ROOM_HEAD_AUTHORITY_FOR_OPEN__?: CanvasHeadFactory;
		__TS_DRP_CANVAS_SETTLEMENT_SOURCE_APPROVAL__?: CanvasSettlementApproval;
		__TS_DRP_CANVAS_SESSION__?: CanvasSessionGlobal;
		/**
		 * Test override of the creator's successor announcement. By default the room's successor
		 * delivery (examples/v3-room) announces each adopted offer to the canvas's observers over the
		 * node and answers their requests; with this hook, the hook receives the offers instead and
		 * the room announces nothing.
		 */
		__TS_DRP_CANVAS_SUCCESSOR_PUBLISHER__?: CanvasSuccessorPublisher;
	}
}

/** The room as the page's controls reach it. */
export interface CanvasPageRoom {
	open(operation: "create" | "join", invite: string): Promise<CanvasView>;
	paint(x: number, y: number, rgb: readonly [number, number, number]): Promise<void>;
	/** Closes the room for good (page unload). */
	close(): Promise<void>;
}

export function connectionStatus(message: string, state: "error" | "joining" | "ready"): void {
	const status = document.getElementById("canvasConnectionStatus") as HTMLParagraphElement;
	status.dataset.state = state;
	status.textContent = message;
}

/** The page's state and its rendering of the room's views. */
export interface CanvasPage {
	/** Renders a canvas view (open, projection). */
	view(next: CanvasView): void;
	/** Renders the peer panel. */
	network(next: CanvasNetworkView): void;
	/** Binds the controls to the room and enables them (once the node is dialable). */
	bind(room: CanvasPageRoom): void;
	/** The page is unloading: no more opens or paints. */
	unload(): void;
}

export function createCanvasPage(): CanvasPage {
	let current: CanvasView = { canvasId: undefined, invite: "", observer: false, pixels: null };
	let renderedCanvasId: string | undefined;
	let room: CanvasPageRoom | undefined;
	let opening = false;
	let closing = false;

	const render = (): void => {
		const canvasId = current.canvasId;
		const hasCanvas = canvasId !== undefined;
		(document.getElementById("canvasIdentity") as HTMLElement).hidden = !hasCanvas;
		(document.getElementById("canvasEmptyState") as HTMLElement).hidden = hasCanvas;
		(document.getElementById("canvasStage") as HTMLElement).hidden = !hasCanvas;
		const copyButton = document.getElementById("copyCanvasId") as HTMLButtonElement;
		copyButton.disabled = !hasCanvas;
		if (canvasId !== renderedCanvasId) {
			(document.getElementById("canvasId") as HTMLElement).textContent = canvasId ?? "";
			(document.getElementById("canvasInvite") as HTMLTextAreaElement).value = current.invite;
			copyButton.setAttribute("aria-label", `Copy canvas invite: ${canvasId ?? ""}`);
			const status = document.getElementById("copyCanvasStatus") as HTMLElement;
			status.textContent = "";
			status.removeAttribute("data-state");
			renderedCanvasId = canvasId;
		}
		const pixels = current.pixels;
		if (!hasCanvas || pixels === null) return;
		for (let x = 0; x < CANVAS_SIDE; x++) {
			for (let y = 0; y < CANVAS_SIDE; y++) {
				const pixel = document.getElementById(`${x}-${y}`);
				if (pixel === null) continue;
				const at = (x * CANVAS_SIDE + y) * 3;
				pixel.style.backgroundColor = `rgb(${pixels[at]}, ${pixels[at + 1]}, ${pixels[at + 2]})`;
			}
		}
	};

	const copyCanvasInvite = async (): Promise<void> => {
		const selected = current.canvasId;
		if (selected === undefined) return;
		const status = document.getElementById("copyCanvasStatus") as HTMLElement;
		try {
			if (navigator.clipboard === undefined) throw new Error("Clipboard API unavailable");
			await navigator.clipboard.writeText(current.invite);
			if (current.canvasId !== selected) return;
			status.dataset.state = "success";
			status.textContent = "Canvas invite copied.";
		} catch (error) {
			console.error("Failed to copy canvas invite", error);
			if (current.canvasId !== selected) return;
			status.dataset.state = "error";
			status.textContent = "Could not copy the canvas invite. The invite remains visible for manual copying.";
		}
	};

	const openCanvas = async (operation: "create" | "join"): Promise<void> => {
		if (opening || closing || current.canvasId !== undefined || room === undefined) return;
		opening = true;
		const create = document.getElementById("create") as HTMLButtonElement;
		const connect = document.getElementById("connect") as HTMLButtonElement;
		create.disabled = true;
		connect.disabled = true;
		connectionStatus(operation === "create" ? "Creating canvas…" : "Joining canvas…", "joining");
		try {
			const invite = (document.getElementById("canvasIdInput") as HTMLInputElement).value.trim();
			current = await room.open(operation, invite);
			render();
			connectionStatus(
				current.observer
					? "Connected as an observer; this canvas is read-only."
					: "Creator-trusted canvas; not Byzantine-fault-tolerant.",
				"ready"
			);
		} catch (error) {
			connectionStatus(
				`Could not ${operation === "create" ? "create" : "join"} that canvas. Check the invite and host configuration and try again.`,
				"error"
			);
			console.error("Canvas open failed", error);
		} finally {
			opening = false;
			create.disabled = current.canvasId !== undefined || closing;
			connect.disabled = current.canvasId !== undefined || closing;
		}
	};

	const paintPixel = async (pixel: HTMLDivElement): Promise<void> => {
		if (room === undefined || current.canvasId === undefined || closing) return;
		if (current.observer) {
			connectionStatus("Connected as an observer; this canvas is read-only.", "ready");
			return;
		}
		const [x, y] = pixel.id.split("-").map((value) => Number.parseInt(value, 10));
		if (x === undefined || y === undefined) return;
		const rgb: [number, number, number] = [
			Math.floor(Math.random() * 256),
			Math.floor(Math.random() * 256),
			Math.floor(Math.random() * 256),
		];
		try {
			await room.paint(x, y, rgb);
		} catch (error) {
			// Refused before acceptance and kept by the room's policy: sent once the cause clears. The
			// typed refusals keep their classes across the room worker's boundary.
			if (error instanceof V3RoomNotReachingHost) {
				connectionStatus(
					"Can't paint: your paints are not reaching the host. This paint is kept and sent once they do.",
					"error"
				);
				return;
			}
			if (error instanceof V3RoomReadOnly) {
				connectionStatus(
					"Can't paint: the canvas host is unreachable. This paint is kept and sent once it is back.",
					"error"
				);
				return;
			}
			if (error instanceof V3RoomBusy) {
				connectionStatus("The canvas is busy catching up. This paint is kept and sent once it is done.", "error");
				return;
			}
			if (error instanceof V3RoomSuccessorUnavailable) {
				connectionStatus(
					"No new checkpoint has arrived from the host yet. This paint is kept and sent once it does.",
					"error"
				);
				return;
			}
			console.error("Canvas paint failed", error);
			connectionStatus("Paint was refused. Wait for admitted work to finish before retrying.", "error");
		}
	};

	return {
		view(next): void {
			current = next;
			render();
		},
		network(next): void {
			(document.getElementById("peers") as HTMLElement).textContent = `[${next.peers.join(", ")}]`;
			(document.getElementById("discovery_peers") as HTMLElement).textContent = `[${next.discoveryPeers.join(", ")}]`;
			(document.getElementById("object_peers") as HTMLElement).textContent = `[${next.objectPeers.join(", ")}]`;
		},
		bind(selected): void {
			if (room !== undefined) return;
			room = selected;
			const canvas = document.getElementById("canvas") as HTMLDivElement;
			canvas.style.setProperty("--canvas-side", String(CANVAS_SIDE));
			(document.getElementById("canvasDimensions") as HTMLElement).textContent =
				`${CANVAS_SIDE} × ${CANVAS_SIDE} live field`;
			canvas.innerHTML = "";
			for (let x = 0; x < CANVAS_SIDE; x++) {
				for (let y = 0; y < CANVAS_SIDE; y++) {
					const pixel = document.createElement("div");
					pixel.id = `${x}-${y}`;
					pixel.addEventListener("click", () => void paintPixel(pixel));
					canvas.appendChild(pixel);
				}
			}
			(document.getElementById("copyCanvasId") as HTMLButtonElement).addEventListener(
				"click",
				() => void copyCanvasInvite()
			);
			(document.getElementById("create") as HTMLButtonElement).addEventListener(
				"click",
				() => void openCanvas("create")
			);
			(document.getElementById("connect") as HTMLButtonElement).addEventListener(
				"click",
				() => void openCanvas("join")
			);
			(document.getElementById("create") as HTMLButtonElement).disabled = false;
			(document.getElementById("connect") as HTMLButtonElement).disabled = false;
			render();
		},
		unload(): void {
			closing = true;
		},
	};
}
