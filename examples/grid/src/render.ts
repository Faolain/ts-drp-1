import type { DRPNode } from "@ts-drp/node";

import type { ZoneSnapshot, ZoneTransientSnapshot } from "./v3-zone";

type GridElements = {
	readonly blocks: Map<string, { element: HTMLDivElement; kind: string; x: number; y: number }>;
	readonly positions: Map<string, HTMLDivElement>;
};
// DOM identity belongs to the actual grid element. Replacing a document/grid
// cannot retain another room's nodes, and no protocol data or authority lives here.
const grids = new WeakMap<HTMLDivElement, GridElements>();
function gridElements(grid: HTMLDivElement): GridElements {
	let state = grids.get(grid);
	if (state === undefined) {
		grid.replaceChildren();
		state = { blocks: new Map(), positions: new Map() };
		grids.set(grid, state);
	}
	return state;
}

/** One UI owner: full projections render in order; only transient visual frames
 * may collapse to their latest positions. A full projection/reset cancels the
 * old pending frame, including close/reopen of the same room identifier. */
export function createZonePresentation(
	requestFrame: (callback: FrameRequestCallback) => number = (callback) => requestAnimationFrame(callback),
	cancelFrame: (handle: number) => void = (handle) => cancelAnimationFrame(handle)
): Readonly<{ projection(snapshot: ZoneSnapshot): void; transient(snapshot: ZoneTransientSnapshot): void; close(): void }> {
	let pending: ZoneTransientSnapshot | undefined;
	let frame: number | undefined;
	let revision = 0;
	let current: Readonly<{ ready: boolean; zoneId: string }> | undefined;
	let closed = false;
	const cancel = (): void => {
		revision++;
		if (frame !== undefined) cancelFrame(frame);
		frame = undefined;
		pending = undefined;
	};
	return Object.freeze({
		projection(snapshot: ZoneSnapshot): void {
			if (closed) return;
			cancel();
			current = { ready: snapshot.ready, zoneId: snapshot.zoneId };
			renderZone(snapshot);
		},
		transient(snapshot: ZoneTransientSnapshot): void {
			if (closed || !current?.ready || !snapshot.ready || current.zoneId !== snapshot.zoneId) return;
			pending = snapshot;
			if (frame !== undefined) return;
			const selected = revision;
			frame = requestFrame((): void => {
				// Cancellation need not suppress an already dispatched callback.
				if (closed || revision !== selected) return;
				frame = undefined;
				const latest = pending;
				pending = undefined;
				if (latest !== undefined) renderTransientZone(latest);
			});
		},
		close(): void { closed = true; current = undefined; cancel(); },
	});
}

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
	renderAoiBandwidth(snapshot);
	renderAoiProjection(snapshot);
	renderTradeIntent(snapshot);
	const grid = document.getElementById("grid");
	if (!(grid instanceof HTMLDivElement)) return;
	const state = gridElements(grid);
	const present = new Set<string>();
	for (const block of snapshot.blocks) {
		present.add(block.id);
		let retained = state.blocks.get(block.id);
		if (retained === undefined) {
			const element = document.createElement("div");
			element.dataset.blockId = block.id;
			element.style.position = "absolute";
			element.style.padding = "4px 6px";
			element.style.background = "#444";
			element.style.color = "white";
			retained = { element, kind: block.kind, x: block.x, y: block.y };
			state.blocks.set(block.id, retained);
		}
		if (retained.element.textContent === "" || retained.kind !== block.kind || retained.x !== block.x || retained.y !== block.y) {
			retained.element.textContent = `${block.kind} (${block.x}, ${block.y})`;
			retained.element.style.left = `calc(50% + ${block.x * 24}px)`;
			retained.element.style.top = `calc(50% - ${block.y * 24}px)`;
			retained.kind = block.kind; retained.x = block.x; retained.y = block.y;
		}
		grid.appendChild(retained.element);
	}
	for (const [id, retained] of state.blocks) if (!present.has(id)) { retained.element.remove(); state.blocks.delete(id); }
	renderTransientZone(snapshot);
	// Full projections preserve the original block-before-overlay draw order.
	for (const element of state.positions.values()) grid.appendChild(element);
}

/** Update only the already-authorized visual overlay; no durable diagnostics,
 * block reconstruction, trade verification or protocol operation occurs here. */
export function renderTransientZone(snapshot: ZoneTransientSnapshot): void {
	const grid = document.getElementById("grid");
	if (!(grid instanceof HTMLDivElement)) return;
	const state = gridElements(grid), present = new Set<string>();
	for (const [peerId, position] of Object.entries(snapshot.transientPositions)) {
		present.add(peerId);
		let element = state.positions.get(peerId);
		if (element === undefined) {
			element = document.createElement("div");
			element.dataset.glowingPeerId = peerId;
			element.title = peerId;
			element.style.position = "absolute";
			element.style.width = "18px";
			element.style.height = "18px";
			element.style.borderRadius = "50%";
			element.style.background = "#2d8cff";
			state.positions.set(peerId, element);
			grid.appendChild(element);
		}
		element.style.left = `calc(50% + ${position.x * 24}px)`;
		element.style.top = `calc(50% - ${position.y * 24}px)`;
	}
	for (const [peerId, element] of state.positions) if (!present.has(peerId)) { element.remove(); state.positions.delete(peerId); }
}

function renderTradeIntent(snapshot: ZoneSnapshot): void {
	const container = document.getElementById("tradeIntentWorkbench");
	if (!(container instanceof HTMLElement)) return;
	const heading = document.createElement("h2");
	heading.textContent = "Co-signed trade intent";
	const intent = snapshot.tradeIntent;
	const status = document.createElement("p");
	status.dataset.tradeIntentStatus = intent.status;
	status.textContent =
		intent.status === "absent"
			? "No trade intent prepared."
			: `${intent.status}: ${String(intent.approvalCount)} / 2 approvals for ${intent.clientOperationId}`;
	const context = document.createElement("p");
	context.textContent =
		intent.status === "absent"
			? "Trade intent context is unavailable."
			: `Intent ${intent.intentDigest}; object ${intent.objectId}; epoch ${String(intent.epoch)}; counterparties ${intent.counterparties.join(
					", "
				)}`;
	container.replaceChildren(heading, status, context);
}

function renderAoiBandwidth(snapshot: ZoneSnapshot): void {
	const container = document.getElementById("aoiBandwidthWorkbench");
	if (!(container instanceof HTMLElement)) return;
	const heading = document.createElement("h2");
	heading.textContent = "AOI bandwidth workbench";
	const description = document.createElement("p");
	description.textContent =
		"AOI projection payload throughput is a product diagnostic; browser candidate-pair bytes remain the acceptance authority.";
	const rows = Object.entries(snapshot.aoiBandwidth).map(([peerId, diagnostic]) => {
		const row = document.createElement("p");
		row.dataset.aoiBandwidthPeer = peerId;
		row.textContent = `${peerId}: ${String(diagnostic.selectedEntityCount)} / ${String(
			diagnostic.inputEntityCount
		)} visible, ${(diagnostic.projectionBitsPerSecond / 1_000).toFixed(2)} kbps projection payload, ${String(
			diagnostic.publicationCount
		)} publications, ${String(diagnostic.projectionPayloadBytesSent)} bytes, durable delta ${String(
			diagnostic.durableDelta
		)}, over-limit ${String(snapshot.rawTransport.overLimit)}`;
		return row;
	});
	const empty = document.createElement("p");
	empty.textContent = "Waiting for outbound AOI projection data.";
	container.replaceChildren(heading, description, ...(rows.length === 0 ? [empty] : rows));
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
