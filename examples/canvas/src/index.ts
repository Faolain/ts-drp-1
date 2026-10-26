import { createV3CanvasDescriptor, toCanvasWireOperation } from "@ts-drp/blueprints/v3-canvas";
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
	createV3RoomSession,
	type V3RoomCreatorInviteMaterial,
	type V3RoomHeadAuthority,
	type V3RoomRolloverHooks,
	type V3RoomRolloverPolicy,
	type V3RoomSession,
} from "@ts-drp/example-v3-room";
import { DRPNode } from "@ts-drp/node";
import { type CanvasProjection, createV3CanvasApplication } from "@ts-drp/node/applications/canvas";
import { DRP_DISCOVERY_TOPIC } from "@ts-drp/types";

import { CANVAS_GENESIS_PROFILE } from "./profile";
import { CANVAS_ROLLOVER_BUDGET } from "./rollover";

type CanvasHeadFactory = (
	context: Readonly<{
		author: string;
		creatorInvite: string | V3RoomCreatorInviteMaterial;
		objectId: string;
		operation: "create" | "join";
	}>
) => V3RoomHeadAuthority | Promise<V3RoomHeadAuthority>;

type CanvasSettlementApproval = NonNullable<
	Parameters<typeof createV3RoomSession<CanvasProjection>>[0]["approveSettlementSourceSelection"]
>;

declare global {
	interface Window {
		__TS_DRP_CANVAS_ROOM_HEAD_AUTHORITY_FOR_OPEN__?: CanvasHeadFactory;
		__TS_DRP_CANVAS_SETTLEMENT_SOURCE_APPROVAL__?: CanvasSettlementApproval;
		__TS_DRP_CANVAS_SESSION__?: ModularBrowserNetworkSession;
		/**
		 * The application host's delivery of each adopted successor offer to the canvas's observers,
		 * who install it to keep following the canvas. Without it the creator still rolls over.
		 */
		__TS_DRP_CANVAS_SUCCESSOR_PUBLISHER__?: NonNullable<V3RoomRolloverHooks["publishSuccessor"]>;
	}
}

const CANVAS_SIDE = 10;
const descriptor = createV3CanvasDescriptor(CANVAS_SIDE, CANVAS_SIDE);
const application = createV3CanvasApplication(CANVAS_SIDE, CANVAS_SIDE);
let room: V3RoomSession<CanvasProjection> | undefined;
// The creator's rollover policy (examples/canvas/src/rollover.ts); observers never seal.
let rollover: V3RoomRolloverPolicy | undefined;
let projection: CanvasProjection | undefined;
let node: DRPNode | undefined;
let renderedCanvasId: string | undefined;
let observer = false;
let opening = false;
let openTask: Promise<void> | undefined;
let closing = false;
let renderInterval: ReturnType<typeof setInterval> | undefined;
const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytes = (value: string): Uint8Array =>
	Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));

function connectionStatus(message: string, state: "error" | "joining" | "ready"): void {
	const status = document.getElementById("canvasConnectionStatus") as HTMLParagraphElement;
	status.dataset.state = state;
	status.textContent = message;
}

function render(): void {
	if (node !== undefined) {
		(document.getElementById("peers") as HTMLElement).textContent = `[${node.networkNode.getAllPeers().join(", ")}]`;
		(document.getElementById("discovery_peers") as HTMLElement).textContent =
			`[${node.networkNode.getGroupPeers(DRP_DISCOVERY_TOPIC).join(", ")}]`;
		(document.getElementById("object_peers") as HTMLElement).textContent =
			`[${room?.connectedPeers().join(", ") ?? ""}]`;
	}
	const canvasId = room?.objectId;
	const hasCanvas = canvasId !== undefined;
	(document.getElementById("canvasIdentity") as HTMLElement).hidden = !hasCanvas;
	(document.getElementById("canvasEmptyState") as HTMLElement).hidden = hasCanvas;
	(document.getElementById("canvasStage") as HTMLElement).hidden = !hasCanvas;
	const copyButton = document.getElementById("copyCanvasId") as HTMLButtonElement;
	copyButton.disabled = !hasCanvas;
	if (canvasId !== renderedCanvasId) {
		(document.getElementById("canvasId") as HTMLElement).textContent = canvasId ?? "";
		(document.getElementById("canvasInvite") as HTMLTextAreaElement).value = room?.invite ?? "";
		copyButton.setAttribute("aria-label", `Copy canvas invite: ${canvasId ?? ""}`);
		const status = document.getElementById("copyCanvasStatus") as HTMLElement;
		status.textContent = "";
		status.removeAttribute("data-state");
		renderedCanvasId = canvasId;
	}
	if (!hasCanvas || projection === undefined) return;
	for (let x = 0; x < CANVAS_SIDE; x++) {
		for (let y = 0; y < CANVAS_SIDE; y++) {
			const pixel = document.getElementById(`${x}-${y}`);
			if (pixel === null) continue;
			const [red, green, blue] = descriptor.kernel.queryColor(projection.state, x, y);
			pixel.style.backgroundColor = `rgb(${red}, ${green}, ${blue})`;
		}
	}
}

async function copyCanvasInvite(): Promise<void> {
	const selected = room;
	if (selected === undefined) return;
	const status = document.getElementById("copyCanvasStatus") as HTMLElement;
	try {
		if (navigator.clipboard === undefined) throw new Error("Clipboard API unavailable");
		await navigator.clipboard.writeText(selected.invite);
		if (room !== selected) return;
		status.dataset.state = "success";
		status.textContent = "Canvas invite copied.";
	} catch (error) {
		console.error("Failed to copy canvas invite", error);
		if (room !== selected) return;
		status.dataset.state = "error";
		status.textContent = "Could not copy the canvas invite. The invite remains visible for manual copying.";
	}
}

/**
 * Routing only. The room owner authenticates the exact invite before activation.
 * @param invite Bounded untrusted room invitation.
 * @returns Routing identity, not authenticated authority.
 */
function objectIdFromInvite(invite: string): string {
	if (invite.length === 0 || invite.length > 131_072 || invite.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(invite))
		throw new TypeError("canvas invite is invalid");
	const material = decodeCanonical(bytes(invite), { maxBytes: 65_536, maxDepth: 4, maxItems: 128 });
	if (material === null || typeof material !== "object") throw new TypeError("canvas invite is invalid");
	const preimage = Reflect.get(material, "exactCanonicalGenesisAnchorPreimageBytes");
	if (!(preimage instanceof Uint8Array)) throw new TypeError("canvas invite is invalid");
	const anchor = decodeCanonical(preimage);
	const objectId = anchor === null || typeof anchor !== "object" ? undefined : Reflect.get(anchor, "objectId");
	if (typeof objectId !== "string" || objectId.length === 0) throw new TypeError("canvas invite object is invalid");
	return objectId;
}

async function creatorInvite(selectedNode: DRPNode, objectId: string): Promise<V3RoomCreatorInviteMaterial> {
	const author = selectedNode.keychain.localAuthorId;
	const signers = [{ publicKey: author, signerId: "creator" }];
	return createV3RoomCreatorInviteMaterial({
		objectId,
		blueprintDigest: application.catalog.blueprintDigests[0] as string,
		exactCanonicalApplicationStateBytes: descriptor.canonicalStateBytes(descriptor.initialState),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }],
			objectId,
			permissionless: false,
			version: CANVAS_GENESIS_PROFILE.latchedAclVersion,
		}),
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
			profileId: CANVAS_GENESIS_PROFILE.profileId,
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		signGenesisAnchorDigest: (digest) => selectedNode.keychain.signWithLocalAuthor(digest),
	});
}

async function openCanvas(operation: "create" | "join"): Promise<void> {
	if (opening || closing || room !== undefined) return;
	const selectedNode = node;
	if (selectedNode === undefined) return;
	opening = true;
	const create = document.getElementById("create") as HTMLButtonElement;
	const connect = document.getElementById("connect") as HTMLButtonElement;
	create.disabled = true;
	connect.disabled = true;
	connectionStatus(operation === "create" ? "Creating canvas…" : "Joining canvas…", "joining");
	let opened: V3RoomSession<CanvasProjection> | undefined;
	try {
		const inviteInput = (document.getElementById("canvasIdInput") as HTMLInputElement).value.trim();
		const objectId =
			operation === "create"
				? `${selectedNode.networkNode.peerId}:${hex(crypto.getRandomValues(new Uint8Array(16)))}`
				: objectIdFromInvite(inviteInput);
		const invite = operation === "create" ? await creatorInvite(selectedNode, objectId) : inviteInput;
		const factory = window.__TS_DRP_CANVAS_ROOM_HEAD_AUTHORITY_FOR_OPEN__;
		if (typeof factory !== "function")
			throw new TypeError("canvas room-head authority is unavailable: the application host must configure its factory");
		const approveSettlementSourceSelection = window.__TS_DRP_CANVAS_SETTLEMENT_SOURCE_APPROVAL__;
		if (approveSettlementSourceSelection !== undefined && typeof approveSettlementSourceSelection !== "function")
			throw new TypeError("canvas settlement approval policy is invalid");
		const author = selectedNode.keychain.localAuthorId;
		const authority = await factory(Object.freeze({ author, creatorInvite: invite, objectId, operation }));
		const databaseName = `ts-drp-v3-canvas--${hex(hashDomain("ts-drp/canvas-database/v1", new TextEncoder().encode(objectId)))}`;
		const publishSuccessor = window.__TS_DRP_CANVAS_SUCCESSOR_PUBLISHER__;
		if (publishSuccessor !== undefined && typeof publishSuccessor !== "function")
			throw new TypeError("canvas successor publisher is invalid");
		// Only the creator seals: it rolls the canvas over at its budget or after an idle period.
		const policy =
			operation === "create"
				? createV3RoomRolloverPolicy({
						role: "creator",
						budget: CANVAS_ROLLOVER_BUDGET,
						hooks: {
							...(publishSuccessor === undefined ? {} : { publishSuccessor }),
							onError: (error) => console.warn("Canvas rollover failed; it is retried", error),
						},
					})
				: undefined;
		opened = await createV3RoomSession<CanvasProjection>({
			application,
			author,
			creatorInvite: invite,
			databaseName,
			issuanceDatabaseName: databaseName,
			migrationDatabaseNamespace: `${author}:${objectId}`,
			objectId,
			initialLogicalTime: 3,
			...(operation === "join"
				? { receiveOnly: true as const }
				: {
						creatorFinalitySigner: await selectedNode.keychain.acquireLocalAuthorFinalitySigner(),
					}),
			roomHeadAuthority: authority,
			...(approveSettlementSourceSelection === undefined ? {} : { approveSettlementSourceSelection }),
			publicKeyBytes: bytes(author),
			signRegisteredVertexDigest: (digest) => selectedNode.keychain.signWithLocalAuthor(digest),
			openTransport: (id) => selectedNode.openRoomNetwork(id),
			onAcceptedVertex: (vertex) => policy?.observe(vertex),
			onProjection: (value) => {
				projection = value;
				render();
			},
		});
		if (closing) throw new TypeError("canvas closed during open");
		policy?.bind(opened);
		rollover = policy;
		room = opened;
		observer = operation === "join";
		projection = opened.projection();
		connectionStatus(
			observer
				? "Connected as an observer; this canvas is read-only."
				: "Creator-trusted canvas; not Byzantine-fault-tolerant.",
			"ready"
		);
		render();
	} catch (error) {
		rollover?.close();
		rollover = undefined;
		await opened?.close();
		projection = undefined;
		connectionStatus(
			`Could not ${operation === "create" ? "create" : "join"} that canvas. Check the invite and host configuration and try again.`,
			"error"
		);
		console.error("Canvas open failed", error);
	} finally {
		opening = false;
		create.disabled = room !== undefined || closing;
		connect.disabled = room !== undefined || closing;
	}
}

async function paintPixel(pixel: HTMLDivElement): Promise<void> {
	const selected = room;
	if (selected === undefined || closing) return;
	if (observer) {
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
	// One immutable intent per independent click. Any retry retains this command: a paint refused
	// at the epoch's capacity is offered again after the creator's rollover.
	const command = toCanvasWireOperation({ action: "paint", offset: [x, y], rgb }, crypto.randomUUID());
	try {
		await (rollover ?? selected).issue(command);
	} catch (error) {
		console.error("Canvas paint failed", error);
		connectionStatus("Paint was refused. Wait for admitted work to finish before retrying.", "error");
	}
}

function startOpenCanvas(operation: "create" | "join"): void {
	if (opening || closing || room !== undefined) return;
	const task = openCanvas(operation);
	openTask = task;
	void task
		.finally(() => {
			if (openTask === task) openTask = undefined;
		})
		.catch((error) => console.error("Canvas open cleanup failed", error));
}

function bindControls(): void {
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
	(document.getElementById("create") as HTMLButtonElement).addEventListener("click", () => startOpenCanvas("create"));
	(document.getElementById("connect") as HTMLButtonElement).addEventListener("click", () => startOpenCanvas("join"));
	(document.getElementById("create") as HTMLButtonElement).disabled = false;
	(document.getElementById("connect") as HTMLButtonElement).disabled = false;
	render();
}

async function main(): Promise<void> {
	const identity = await acquireBrowserIdentity({
		lockPrefix: "ts-drp:canvas:v3:identity-slot",
		seedKey: "ts-drp:canvas:v3:identity-seed",
	});
	let modular: ModularBrowserNetworkSession | undefined;
	try {
		const environment = readBrowserNetworkEnv(import.meta.env);
		const selected = getNetworkConfigFromEnv(environment, window.location.origin);
		const config = { ...selected, keychain_config: { ...selected.keychain_config, private_key_seed: identity.seed } };
		modular = isModularNetworkEnv(environment) ? createModularBrowserNetwork(config, environment) : undefined;
		node = modular?.node ?? new DRPNode(config);
		await node.start();
		if (modular !== undefined) {
			window.__TS_DRP_CANVAS_SESSION__ = modular;
			window.dispatchEvent(new CustomEvent("ts-drp:canvas-ready", { detail: modular.snapshot() }));
		}
		window.addEventListener(
			"beforeunload",
			() => {
				closing = true;
				if (renderInterval !== undefined) clearInterval(renderInterval);
				void (async (): Promise<void> => {
					try {
						await openTask;
						rollover?.close();
						await room?.close();
					} finally {
						try {
							await (modular?.stop() ?? node?.stop());
						} finally {
							identity.release();
						}
					}
				})().catch((error) => console.error("Canvas shutdown failed", error));
			},
			{ once: true }
		);
		let bound = false;
		await node.networkNode.isDialable(() => {
			if (bound) return;
			bound = true;
			bindControls();
			renderInterval = setInterval(render, 500);
		});
	} catch (error) {
		await node?.stop().catch(() => undefined);
		identity.release();
		connectionStatus("Canvas could not start. Check the configured identity and network.", "error");
		throw error;
	}
}

void main().catch((error) => console.error("Canvas startup failed", error));
