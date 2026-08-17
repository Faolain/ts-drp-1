import { DRPNode } from "@ts-drp/node";
import { createPermissionlessACL, creatorFromObjectID } from "@ts-drp/object";
import { enableTracing, OpentelemetryMetrics } from "@ts-drp/tracer";
import { type DRPNodeConfig, type IMetrics } from "@ts-drp/types";

import { env } from "./env";
import { createModularGridNetwork, type ModularGridNetworkSession } from "./modular-network";
import { isModularNetworkEnv, getNetworkConfigFromEnv as selectNetworkConfigFromEnv } from "./network-config";
import { Grid } from "./objects/grid";
import { enableUIControls, render, renderInfo } from "./render";
import { gridState } from "./state";
import { getColorForPeerId } from "./util/color";

/**
 * Get the network config from the environment variables
 * @returns The network config
 */
export function getNetworkConfigFromEnv(): DRPNodeConfig {
	return selectNetworkConfigFromEnv(env, window.location.origin);
}

function addUser(): void {
	const node = gridState.getNode();
	const gridDRP = gridState.getGridDRP();
	gridDRP.addUser(node.networkNode.peerId, getColorForPeerId(node.networkNode.peerId));
	render();
}

function moveUser(direction: string): void {
	const node = gridState.getNode();
	const gridDRP = gridState.getGridDRP();
	const peerId = node.networkNode.peerId;
	const user = gridDRP.query_users().find((candidate) => candidate.startsWith(`${peerId}:`));
	const durable = user === undefined ? undefined : gridDRP.query_userPosition(user);
	const current = gridState.transientPositions.get(peerId) ?? durable;
	if (current === undefined || gridState.ephemeralChannel === undefined) return;
	const next = { ...current };
	if (direction === "U") next.y += 1;
	if (direction === "D") next.y -= 1;
	if (direction === "L") next.x -= 1;
	if (direction === "R") next.x += 1;
	gridState.transientPositions.set(peerId, next);
	void gridState.ephemeralChannel.publish({
		class: "unreliable-sequenced",
		key: peerId,
		payload: new TextEncoder().encode(JSON.stringify(next)),
	});
	render();
}

function activateEphemeralMovement(): void {
	const node = gridState.getNode();
	const objectId = gridState.getObjectId();
	if (objectId === undefined) return;
	gridState.ephemeralChannel?.close();
	gridState.transientPositions.clear();
	const channel = node.openEphemeral(objectId, { maxMessageBytes: 65_536, maxSequencedKeys: 4_096 });
	gridState.ephemeralChannel = channel;
	channel.subscribe(({ key, payload, sender }) => {
		if (key === null || key !== sender) return;
		try {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Object.keys(parsed).sort().join(",") !== "x,y" ||
				!Number.isSafeInteger(Reflect.get(parsed, "x")) ||
				!Number.isSafeInteger(Reflect.get(parsed, "y"))
			)
				return;
			gridState.transientPositions.set(key, {
				x: Reflect.get(parsed, "x") as number,
				y: Reflect.get(parsed, "y") as number,
			});
			render();
		} catch {
			// The shared channel authenticates and bounds bytes; the app schema remains closed here.
		}
	});
}

function createConnectHandlers(): void {
	const node = gridState.getNode();
	if (gridState.drpObject) {
		gridState.objectPeers = node.networkNode.getGroupPeers(gridState.drpObject.id);
	}

	const objectId = gridState.getObjectId();
	if (!objectId) return;
	node.networkNode.subscribeToGroupPeerChanges(({ peerId, subscribed, topic }) => {
		if (topic !== objectId || subscribed) return;
		gridState.transientPositions.delete(peerId);
		render();
	});

	node.messageQueueManager.subscribe(objectId, () => {
		if (!gridState.drpObject?.id) return;
		gridState.objectPeers = node.networkNode.getGroupPeers(gridState.drpObject?.id);
		render();
	});

	node.subscribe(objectId, () => {
		if (gridState.ephemeralChannel === undefined && gridState.getGridDRP().query_users().length > 1) {
			activateEphemeralMovement();
		}
		render();
	});
}

function run(metrics?: IMetrics): void {
	enableUIControls();
	renderInfo();

	const button_create = <HTMLButtonElement>document.getElementById("createGrid");
	const create = async (): Promise<void> => {
		const node = gridState.getNode();

		gridState.drpObject = await node.createObject({
			acl: createPermissionlessACL(node.networkNode.peerId),
			drp: new Grid(),
			metrics,
		});
		gridState.gridDRP = gridState.drpObject.drp;
		createConnectHandlers();

		// The object creator can sign for finality
		if (gridState.node?.keychain.blsPublicKey) {
			gridState.drpObject.acl.setKey(gridState.node?.keychain.blsPublicKey);
		}
		addUser();
		activateEphemeralMovement();
		render();
	};

	button_create.addEventListener("click", () => void create());

	const button_connect = <HTMLButtonElement>document.getElementById("joinGrid");
	const grid_input = <HTMLInputElement>document.getElementById("gridInput");
	grid_input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			button_connect.click();
		}
	});

	const connect = async (): Promise<void> => {
		const drpId = grid_input.value;
		const node = gridState.getNode();

		try {
			const creatorPeerId = creatorFromObjectID(drpId);
			if (creatorPeerId === undefined) throw new Error("Grid id is not creator-bound");
			gridState.drpObject = await node.connectObject({
				acl: createPermissionlessACL(creatorPeerId),
				id: drpId,
				drp: new Grid(),
				metrics,
			});
			gridState.gridDRP = gridState.drpObject.drp;
			createConnectHandlers();
			addUser();
			if (gridState.getGridDRP().query_users().length > 1) activateEphemeralMovement();
			render();
			console.log("Succeeded in connecting with DRP", drpId);
		} catch (e) {
			console.error("Error while connecting with DRP", drpId, e);
		}
	};

	button_connect.addEventListener("click", () => void connect());

	document.addEventListener("keydown", (event) => {
		// Skip if user is typing in input elements
		if (
			event.target instanceof HTMLInputElement ||
			event.target instanceof HTMLTextAreaElement ||
			event.target instanceof HTMLSelectElement
		) {
			return;
		}

		// Skip if Grid is not initialized
		if (!gridState.isGridInitialized()) {
			return;
		}

		if (event.key === "w") moveUser("U");
		if (event.key === "a") moveUser("L");
		if (event.key === "s") moveUser("D");
		if (event.key === "d") moveUser("R");
	});

	const copyButton = <HTMLButtonElement>document.getElementById("copyGridId");
	copyButton.addEventListener("click", () => {
		const gridIdText = (<HTMLSpanElement>document.getElementById("gridId")).innerText;
		navigator.clipboard
			.writeText(gridIdText)
			.then(() => {
				console.log("Grid DRP ID copied to clipboard");
			})
			.catch((err) => {
				console.error("Failed to copy: ", err);
			});
	});
}

async function main(): Promise<void> {
	let metrics: IMetrics | undefined = undefined;
	if (env.enableTracing) {
		enableTracing();
		metrics = new OpentelemetryMetrics("grid-service-2");
	}

	let hasRun = false;

	const networkConfig = getNetworkConfigFromEnv();
	const modularSession = isModularNetworkEnv(env) ? createModularGridNetwork(networkConfig, env) : undefined;
	const node = modularSession?.node ?? new DRPNode(networkConfig);
	gridState.node = node;
	await node.start();
	// Expose the modular session for observation as soon as the node starts — do NOT gate it on
	// dialability, which for a browser peer depends on later relay reservation.
	if (modularSession !== undefined) exposeModularSession(modularSession);
	await node.networkNode.isDialable(() => {
		console.log("Started node", import.meta.env);
		if (hasRun) return;
		hasRun = true;
		run(metrics);
	});

	if (!hasRun) setInterval(renderInfo, import.meta.env.VITE_RENDER_INFO_INTERVAL);
}

function exposeModularSession(session: ModularGridNetworkSession): void {
	const target = window as typeof window & { __TS_DRP_GRID_SESSION__?: ModularGridNetworkSession };
	target.__TS_DRP_GRID_SESSION__ = session;
	window.addEventListener("beforeunload", () => void session.stop(), { once: true });
	window.dispatchEvent(new CustomEvent("ts-drp:grid-ready", { detail: session.snapshot() }));
}

void main();
