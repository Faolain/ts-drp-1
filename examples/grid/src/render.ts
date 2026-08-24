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
	renderFabric(snapshot);
	renderAoiProjection(snapshot);
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

function renderAoiProjection(snapshot: ZoneSnapshot): void {
	const container = document.getElementById("aoiProjectionWorkbench");
	if (!(container instanceof HTMLElement)) return;
	const heading = document.createElement("h2");
	heading.textContent = "Loss-tolerant AOI projection";
	const rows = Object.entries(snapshot.aoiProjection).map(([peerId, projection]) => {
		const row = document.createElement("p");
		row.dataset.aoiProjectionPeer = peerId;
		row.textContent = `${peerId}: generation ${String(projection.generation ?? "none")}, base ${String(
			projection.baseKeyframeId ?? "none"
		)} @ ${String(projection.baseKeyframeSequence ?? "none")}, sequence ${String(
			projection.lastSequence ?? "none"
		)}, ${projection.waitingForKeyframe ? "waiting for keyframe" : "current"}`;
		return row;
	});
	const empty = document.createElement("p");
	empty.textContent = "Waiting for AOI projection data.";
	container.replaceChildren(heading, ...(rows.length === 0 ? [empty] : rows));
}

function renderFabric(snapshot: ZoneSnapshot): void {
	const container = document.getElementById("fabricWorkbench");
	if (!(container instanceof HTMLElement)) return;
	const heading = document.createElement("h2");
	heading.textContent = "Fabric loss and head-of-line evidence";
	const description = document.createElement("p");
	description.textContent = "Age of information from receiver-observed raw and reliable WebRTC samples.";
	const rows = snapshot.fabricTrials.map((trial) => {
		const row = document.createElement("section");
		row.setAttribute("data-e3-03-trial", trial.trialId);
		const title = document.createElement("h3");
		title.textContent = trial.trialId;
		row.append(
			title,
			fabricMetric("raw-aoi-p50", `Raw p50: ${String(trial.rawAoIP50Ms)} ms`),
			fabricMetric("raw-aoi-p95", `Raw p95: ${String(trial.rawAoIP95Ms)} ms`),
			fabricMetric("reliable-aoi-p50", `Reliable p50: ${String(trial.reliableAoIP50Ms)} ms`),
			fabricMetric("reliable-aoi-p95", `Reliable p95: ${String(trial.reliableAoIP95Ms)} ms`),
			fabricMetric("max-gap", `Max gap: ${String(trial.maxGap)}`),
			fabricMetric("raw-delivered", `Raw delivered: ${String(trial.rawDelivered)}`),
			fabricMetric("raw-dropped", `Raw dropped: ${String(trial.sampleCount - trial.rawDelivered)}`),
			fabricMetric("reliable-delivered", `Reliable delivered: ${String(trial.reliableDelivered)}`),
			fabricMetric("reliable-dropped", `Reliable dropped: ${String(trial.sampleCount - trial.reliableDelivered)}`),
			fabricMetric("fallback-count", `Fallback: ${String(trial.fallbackCount)}`),
			fabricMetric("durable-delta", `Durable delta: ${String(trial.durableDelta)}`)
		);
		return row;
	});
	container.replaceChildren(heading, description, ...rows);
}

function fabricMetric(name: string, text: string): HTMLElement {
	const separator = text.indexOf(":");
	const row = document.createElement("p");
	const label = document.createElement("span");
	label.textContent = text.slice(0, separator + 1) + " ";
	const value = document.createElement("span");
	value.dataset.metric = name;
	value.textContent = text.slice(separator + 2);
	row.append(label, value);
	return row;
}

function setText(id: string, value: string): void {
	const element = document.getElementById(id);
	if (element !== null) element.textContent = value;
}
