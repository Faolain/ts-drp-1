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

let applicationInterval: ReturnType<typeof setInterval> | undefined;
let createRequestSequence = 0;

/**
 * Get the network config from the environment variables.
 * @returns The network config.
 */
export function getNetworkConfigFromEnv(): DRPNodeConfig {
	return selectNetworkConfigFromEnv(env, window.location.origin);
}

function addUser(): void {
	const node = gridState.getNode();
	gridState.getGridDRP().addUser(node.networkNode.peerId, getColorForPeerId(node.networkNode.peerId));
}

function moveUser(direction: string): void {
	if (direction === "U") gridState.move(0, 1);
	if (direction === "D") gridState.move(0, -1);
	if (direction === "L") gridState.move(-1, 0);
	if (direction === "R") gridState.move(1, 0);
}

function startApplicationInterval(): void {
	if (applicationInterval !== undefined) clearInterval(applicationInterval);
	applicationInterval = setInterval(() => {
		renderInfo();
		if (gridState.reconcileEphemeralSession()) render();
	}, env.renderInfoInterval);
}

function stopApplication(): void {
	if (applicationInterval !== undefined) clearInterval(applicationInterval);
	applicationInterval = undefined;
	gridState.dispose();
}

function run(metrics?: IMetrics): void {
	enableUIControls();
	gridState.setRenderNotifier(render);
	renderInfo();

	const buttonCreate = <HTMLButtonElement>document.getElementById("createGrid");
	buttonCreate.addEventListener("click", () => {
		const requestId = `create:${++createRequestSequence}`;
		void gridState
			.requestSession(requestId, () =>
				gridState.getNode().createObject({
					acl: createPermissionlessACL(gridState.getNode().networkNode.peerId),
					drp: new Grid(),
					metrics,
				})
			)
			.then((installed) => {
				if (!installed || gridState.drpObject === undefined) return;
				if (gridState.node?.keychain.blsPublicKey) {
					gridState.drpObject.acl.setKey(gridState.node.keychain.blsPublicKey);
				}
				addUser();
				render();
			});
	});

	const buttonConnect = <HTMLButtonElement>document.getElementById("joinGrid");
	const gridInput = <HTMLInputElement>document.getElementById("gridInput");
	gridInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") buttonConnect.click();
	});
	buttonConnect.addEventListener("click", () => {
		const drpId = gridInput.value;
		const creatorPeerId = creatorFromObjectID(drpId);
		if (creatorPeerId === undefined) {
			console.error("Grid id is not creator-bound", drpId);
			return;
		}
		void gridState
			.requestSession(drpId, () =>
				gridState.getNode().connectObject({
					acl: createPermissionlessACL(creatorPeerId),
					drp: new Grid(),
					id: drpId,
					metrics,
				})
			)
			.then((installed) => {
				if (!installed || gridState.drpObject === undefined) return;
				addUser();
				render();
				console.log("Succeeded in connecting with DRP", drpId);
			});
	});

	document.addEventListener("keydown", (event) => {
		if (
			event.target instanceof HTMLInputElement ||
			event.target instanceof HTMLTextAreaElement ||
			event.target instanceof HTMLSelectElement ||
			!gridState.isGridInitialized()
		) {
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
		navigator.clipboard.writeText(gridIdText).catch((error: unknown) => {
			console.error("Failed to copy grid id", error);
		});
	});
}

async function main(): Promise<void> {
	let metrics: IMetrics | undefined;
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
	startApplicationInterval();
	// Browser dialability may arrive only after relay reservation. Keep the modular
	// observation boundary and application telemetry available while that settles.
	if (modularSession !== undefined) exposeModularSession(modularSession);
	window.addEventListener(
		"beforeunload",
		() => {
			stopApplication();
			void modularSession?.stop();
		},
		{ once: true }
	);
	await node.networkNode.isDialable(() => {
		console.log("Started node", import.meta.env);
		if (hasRun) return;
		hasRun = true;
		run(metrics);
	});
}

function exposeModularSession(session: ModularGridNetworkSession): void {
	const target = window as typeof window & { __TS_DRP_GRID_SESSION__?: ModularGridNetworkSession };
	target.__TS_DRP_GRID_SESSION__ = session;
	window.dispatchEvent(new CustomEvent("ts-drp:grid-ready", { detail: session.snapshot() }));
}

void main();
