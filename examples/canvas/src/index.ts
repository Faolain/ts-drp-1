import {
	createModularBrowserNetwork,
	getNetworkConfigFromEnv,
	isModularNetworkEnv,
	type ModularBrowserNetworkSession,
	readBrowserNetworkEnv,
} from "@ts-drp/example-browser-network";
import { DRPNode } from "@ts-drp/node";
import { DRP_DISCOVERY_TOPIC, type IDRPObject } from "@ts-drp/types";

import { Canvas } from "./objects/canvas";

const CANVAS_SIDE = 10;
const environment = readBrowserNetworkEnv(import.meta.env);
const networkConfig = getNetworkConfigFromEnv(environment, window.location.origin);
const modularSession = isModularNetworkEnv(environment)
	? createModularBrowserNetwork(networkConfig, environment)
	: undefined;
const node = modularSession?.node ?? new DRPNode(networkConfig);
let drpObject: IDRPObject<Canvas>;
let peers: string[] = [];
let discoveryPeers: string[] = [];
let objectPeers: string[] = [];
let renderedCanvasId: string | undefined;

const render = (): void => {
	const peers_element = <HTMLDivElement>document.getElementById("peers");
	peers_element.innerHTML = `[${peers.join(", ")}]`;

	const discovery_element = <HTMLDivElement>document.getElementById("discovery_peers");
	discovery_element.innerHTML = `[${discoveryPeers.join(", ")}]`;

	const object_element = <HTMLDivElement>document.getElementById("object_peers");
	object_element.innerHTML = `[${objectPeers.join(", ")}]`;
	renderCanvasLifecycle(drpObject?.id);

	if (!drpObject?.drp) return;
	const canvas = drpObject.drp.canvas;
	for (let x = 0; x < canvas.length; x++) {
		const row = canvas[x];
		if (row === undefined) continue;
		for (let y = 0; y < row.length; y++) {
			const pixel = document.getElementById(`${x}-${y}`);
			const canvasPixel = row[y];
			if (pixel === null || canvasPixel === undefined) continue;
			const [red, green, blue] = canvasPixel.color();
			pixel.style.backgroundColor = `rgb(${red}, ${green}, ${blue})`;
		}
	}
};

function renderCanvasLifecycle(canvasId: string | undefined): void {
	const identity = <HTMLDivElement>document.getElementById("canvasIdentity");
	const emptyState = <HTMLElement>document.getElementById("canvasEmptyState");
	const stage = <HTMLElement>document.getElementById("canvasStage");
	const idElement = <HTMLElement>document.getElementById("canvasId");
	const copyButton = <HTMLButtonElement>document.getElementById("copyCanvasId");
	const status = <HTMLParagraphElement>document.getElementById("copyCanvasStatus");
	const hasCanvasId = canvasId !== undefined && canvasId.length > 0;

	identity.hidden = !hasCanvasId;
	emptyState.hidden = hasCanvasId;
	stage.hidden = !hasCanvasId;
	copyButton.disabled = !hasCanvasId;
	if (canvasId === renderedCanvasId) return;
	idElement.textContent = canvasId ?? "";
	status.textContent = "";
	status.removeAttribute("data-state");
	renderedCanvasId = canvasId;
}

async function copyCanvasId(): Promise<void> {
	const canvasId = drpObject?.id;
	const status = <HTMLParagraphElement>document.getElementById("copyCanvasStatus");
	if (canvasId === undefined || canvasId.length === 0) return;

	try {
		if (navigator.clipboard === undefined) throw new Error("Clipboard API unavailable");
		await navigator.clipboard.writeText(canvasId);
		if (drpObject?.id !== canvasId) return;
		status.dataset.state = "success";
		status.textContent = "Canvas ID copied.";
	} catch (error) {
		console.error("Failed to copy canvas ID", error);
		if (drpObject?.id !== canvasId) return;
		status.dataset.state = "error";
		status.textContent = "Could not copy the canvas ID. The ID remains visible for manual copying.";
	}
}

const random_int = (max: number): number => Math.floor(Math.random() * max);

function paint_pixel(pixel: HTMLDivElement): void {
	const [x, y] = pixel.id.split("-").map((v) => Number.parseInt(v, 10));
	const painting: [number, number, number] = [random_int(256), random_int(256), random_int(256)];
	drpObject.drp?.paint([x, y], painting);
	const [r, g, b] = drpObject.drp?.query_pixel(x, y).color() ?? [0, 0, 0];
	pixel.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
}

function createConnectHandlers(): void {
	node.messageQueueManager.subscribe(drpObject.id, () => {
		if (drpObject) objectPeers = node.networkNode.getGroupPeers(drpObject.id);
		render();
	});

	node.subscribe(drpObject.id, () => {
		render();
	});
}

function run(): void {
	render();
	const copyButton = <HTMLButtonElement>document.getElementById("copyCanvasId");
	copyButton.addEventListener("click", () => void copyCanvasId());

	const canvas_element = <HTMLDivElement>document.getElementById("canvas");
	const dimensions = <HTMLSpanElement>document.getElementById("canvasDimensions");
	canvas_element.style.setProperty("--canvas-side", String(CANVAS_SIDE));
	dimensions.textContent = `${CANVAS_SIDE} × ${CANVAS_SIDE} live field`;
	canvas_element.innerHTML = "";
	for (let x = 0; x < CANVAS_SIDE; x++) {
		for (let y = 0; y < CANVAS_SIDE; y++) {
			const pixel = document.createElement("div");
			pixel.id = `${x}-${y}`;
			pixel.addEventListener("click", () => paint_pixel(pixel));
			canvas_element.appendChild(pixel);
		}
	}

	node.messageQueueManager.subscribe(DRP_DISCOVERY_TOPIC, () => {
		peers = node.networkNode.getAllPeers();
		discoveryPeers = node.networkNode.getGroupPeers(DRP_DISCOVERY_TOPIC);
		render();
	});

	const create_button = <HTMLButtonElement>document.getElementById("create");
	const create = async (): Promise<void> => {
		drpObject = await node.createObject({ drp: new Canvas(CANVAS_SIDE, CANVAS_SIDE) });

		createConnectHandlers();

		// The object creator can sign for finality
		if (node.keychain.blsPublicKey) {
			drpObject.acl.setKey(node.keychain.blsPublicKey);
		}
		render();
	};

	create_button.addEventListener("click", () => void create());

	const canvasIdInput = <HTMLInputElement>document.getElementById("canvasIdInput");
	const connectionStatus = <HTMLParagraphElement>document.getElementById("canvasConnectionStatus");
	const connect = async (): Promise<void> => {
		const drpId = canvasIdInput.value;
		connectionStatus.dataset.state = "joining";
		connectionStatus.textContent = "Joining canvas…";
		connect_button.disabled = true;
		try {
			drpObject = await node.connectObject({
				id: drpId,
				drp: new Canvas(CANVAS_SIDE, CANVAS_SIDE),
			});

			createConnectHandlers();
			render();
			connectionStatus.textContent = "";
			connectionStatus.removeAttribute("data-state");
		} catch (e) {
			console.error("Error while connecting with DRP", drpId, e);
			connectionStatus.dataset.state = "error";
			connectionStatus.textContent = "Could not join that canvas. Check the ID and try again.";
		} finally {
			connect_button.disabled = false;
		}
	};

	const connect_button = <HTMLButtonElement>document.getElementById("connect");
	connect_button.addEventListener("click", () => void connect());
	create_button.disabled = false;
	connect_button.disabled = false;
}

async function main(): Promise<void> {
	let hasRun = false;
	await node.start();
	if (modularSession !== undefined) exposeModularSession(modularSession);
	await node.networkNode.isDialable(() => {
		if (hasRun) return;
		hasRun = true;
		run();
	});
}

function exposeModularSession(session: ModularBrowserNetworkSession): void {
	const target = window as typeof window & {
		__TS_DRP_CANVAS_SESSION__?: ModularBrowserNetworkSession;
	};
	target.__TS_DRP_CANVAS_SESSION__ = session;
	window.addEventListener("beforeunload", () => void session.stop(), { once: true });
	window.dispatchEvent(new CustomEvent("ts-drp:canvas-ready", { detail: session.snapshot() }));
}

void main();
