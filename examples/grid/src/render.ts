import type { DRPNode } from "@ts-drp/node";

import type { ZoneSnapshot } from "./v3-zone";

/** Enable the durable-zone controls once the real network node is dialable. */
export function enableUIControls(): void {
	const loadingMessage = document.getElementById("loadingMessage");
	if (loadingMessage !== null) loadingMessage.style.display = "none";
	for (const id of ["joinGrid", "createGrid", "gridInput", "zoneMemberEnrollment", "copyGridId"]) {
		const control = document.getElementById(id);
		if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) control.disabled = false;
	}
}

/**
 * Render current network diagnostics without owning application state.
 * @param node Active network node.
 */
export function renderNetwork(node: DRPNode): void {
	setText("peerId", node.networkNode.peerId);
	setText("peers", JSON.stringify(node.networkNode.getAllPeers().sort()));
	setText("discoveryPeers", JSON.stringify(node.networkNode.getSubscribedTopics().sort()));
}

/**
 * Render the deterministic durable projection and transient overlay.
 * @param snapshot Current zone projection.
 */
export function renderZone(snapshot: ZoneSnapshot): void {
	setText("gridIdText", snapshot.ready ? "You're in ZONE ID:" : "");
	setText("gridId", snapshot.zoneId);
	setText(
		"objectPeers",
		snapshot.ready ? `Members: ${JSON.stringify(snapshot.transportPeerAuthors.map(({ peerId }) => peerId))}` : ""
	);
	const copy = document.getElementById("copyGridId");
	if (copy instanceof HTMLButtonElement) copy.style.display = snapshot.ready ? "inline" : "none";
	const grid = document.getElementById("grid");
	if (!(grid instanceof HTMLDivElement)) return;
	grid.replaceChildren();
	for (const block of snapshot.blocks) {
		const element = document.createElement("div");
		element.dataset.blockId = block.id;
		element.textContent = `${block.kind} (${block.x}, ${block.y})`;
		element.style.position = "absolute";
		element.style.left = `calc(50% + ${block.x * 24}px)`;
		element.style.top = `calc(50% - ${block.y * 24}px)`;
		element.style.padding = "4px 6px";
		element.style.background = "#444";
		element.style.color = "white";
		grid.appendChild(element);
	}
	for (const [peerId, position] of Object.entries(snapshot.transientPositions)) {
		const element = document.createElement("div");
		element.dataset.glowingPeerId = peerId;
		element.title = peerId;
		element.style.position = "absolute";
		element.style.left = `calc(50% + ${position.x * 24}px)`;
		element.style.top = `calc(50% - ${position.y * 24}px)`;
		element.style.width = "18px";
		element.style.height = "18px";
		element.style.borderRadius = "50%";
		element.style.background = "#2d8cff";
		grid.appendChild(element);
	}
}

function setText(id: string, value: string): void {
	const element = document.getElementById(id);
	if (element !== null) element.textContent = value;
}
