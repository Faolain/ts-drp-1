import { type DRPNode } from "@ts-drp/node";
import { type IDRPObject } from "@ts-drp/types";

import { type Grid } from "./objects/grid";

interface Position {
	readonly x: number;
	readonly y: number;
}

interface SessionRequest {
	acquire(): Promise<IDRPObject<Grid>>;
	readonly generation: number;
	readonly requestId: string;
	resolve(installed: boolean): void;
}

interface PendingMovement {
	dx: number;
	dy: number;
}

interface GridState {
	readonly drpObject: IDRPObject<Grid> | undefined;
	readonly ephemeralChannel: ReturnType<DRPNode["openEphemeral"]> | undefined;
	readonly gridDRP: Grid | undefined;
	node: DRPNode | undefined;
	peers: string[];
	discoveryPeers: string[];
	objectPeers: string[];
	readonly transientPositions: Map<string, Position>;

	dispose(): void;
	isNodeInitialized(): boolean;
	isGridInitialized(): boolean;
	getNode(): DRPNode;
	getGridDRP(): Grid;
	getObjectId(): string | undefined;
	move(dx: number, dy: number): void;
	reconcileEphemeralSession(): boolean;
	requestSession(requestId: string, acquire: () => Promise<IDRPObject<Grid>>): Promise<boolean>;
	setRenderNotifier(listener: () => void): void;
}

/** Owns the grid's one active durable object and its transient session. */
export class GridStateManager implements GridState {
	#channel: ReturnType<DRPNode["openEphemeral"]> | undefined;
	#channelDisposer: (() => void) | undefined;
	#gridDRP: Grid | undefined;
	#inFlight: SessionRequest | undefined;
	#movementGeneration: number | undefined;
	#object: IDRPObject<Grid> | undefined;
	#objectDisposer: (() => void) | undefined;
	#pending: SessionRequest | undefined;
	#pendingMovement: PendingMovement | undefined;
	#requestGeneration = 0;
	#render = (): void => undefined;
	#sessionGeneration = 0;
	node: DRPNode | undefined = undefined;
	peers: string[] = [];
	discoveryPeers: string[] = [];
	objectPeers: string[] = [];
	readonly transientPositions = new Map<string, Position>();

	/** @returns The active durable object. */
	get drpObject(): IDRPObject<Grid> | undefined {
		return this.#object;
	}

	/** @returns The active transient channel. */
	get ephemeralChannel(): ReturnType<DRPNode["openEphemeral"]> | undefined {
		return this.#channel;
	}

	/** @returns The active grid program. */
	get gridDRP(): Grid | undefined {
		return this.#gridDRP;
	}

	/** Release the current session and invalidate pending work. */
	dispose(): void {
		this.#requestGeneration += 1;
		this.#pending?.resolve(false);
		this.#pending = undefined;
		this.#teardownActiveSession();
	}

	/** @returns Whether the application node is installed. */
	isNodeInitialized(): boolean {
		if (!this.node) {
			console.warn("Node not initialized");
			return false;
		}
		return true;
	}

	/** @returns Whether a grid session is installed. */
	isGridInitialized(): boolean {
		if (!this.#gridDRP) {
			console.warn("Grid not initialized");
			return false;
		}
		return true;
	}

	/** @returns The installed application node. */
	getNode(): DRPNode {
		if (!this.node) throw new Error("Node not initialized");
		return this.node;
	}

	/** @returns The installed grid program. */
	getGridDRP(): Grid {
		if (!this.#gridDRP) throw new Error("Grid not initialized");
		return this.#gridDRP;
	}

	/** @returns The active durable object id. */
	getObjectId(): string | undefined {
		return this.#object?.id;
	}

	/**
	 * Queue one bounded movement displacement.
	 * @param dx Horizontal displacement.
	 * @param dy Vertical displacement.
	 */
	move(dx: number, dy: number): void {
		if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dy) || (dx === 0 && dy === 0)) return;
		if (this.#object === undefined || this.#channel === undefined || this.node === undefined) return;
		if (this.#movementGeneration === this.#sessionGeneration) {
			const pending = this.#pendingMovement ?? { dx: 0, dy: 0 };
			pending.dx += dx;
			pending.dy += dy;
			this.#pendingMovement = pending;
			return;
		}
		this.#publishMovement({ dx, dy });
	}

	/** @returns Whether a disconnected remote overlay was removed. */
	reconcileEphemeralSession(): boolean {
		const channel = this.#channel;
		const localPeerId = this.node?.networkNode.peerId;
		if (channel === undefined || localPeerId === undefined) return false;
		const currentPeers = new Set(channel.authorizedPeers());
		let changed = false;
		for (const peerId of this.transientPositions.keys()) {
			if (peerId === localPeerId || currentPeers.has(peerId)) continue;
			this.transientPositions.delete(peerId);
			changed = true;
		}
		return changed;
	}

	/**
	 * Acquire and install the latest requested object session.
	 * @param requestId Requested session identity.
	 * @param acquire Bounded durable-object acquisition.
	 * @returns Whether this request owns the active session.
	 */
	requestSession(requestId: string, acquire: () => Promise<IDRPObject<Grid>>): Promise<boolean> {
		if (this.#object?.id === requestId) {
			if (this.#inFlight === undefined && this.#pending === undefined) return Promise.resolve(true);
			this.#requestGeneration += 1;
			this.#pending?.resolve(false);
			this.#pending = undefined;
			return Promise.resolve(true);
		}
		const generation = this.#requestGeneration + 1;
		this.#requestGeneration = generation;
		return new Promise<boolean>((resolve) => {
			const request: SessionRequest = { acquire, generation, requestId, resolve };
			if (this.#inFlight !== undefined) {
				this.#pending?.resolve(false);
				this.#pending = request;
				return;
			}
			this.#startRequest(request);
		});
	}

	/**
	 * Install the presentation notifier without importing the renderer.
	 * @param listener Current render callback.
	 */
	setRenderNotifier(listener: () => void): void {
		this.#render = listener;
	}

	#startRequest(request: SessionRequest): void {
		this.#inFlight = request;
		void this.#runRequest(request).finally(() => {
			if (this.#inFlight === request) this.#inFlight = undefined;
			const pending = this.#pending;
			this.#pending = undefined;
			if (pending !== undefined) this.#startRequest(pending);
		});
	}

	async #runRequest(request: SessionRequest): Promise<void> {
		let object: IDRPObject<Grid>;
		try {
			object = await request.acquire();
		} catch (error) {
			console.error("Error while acquiring grid session", request.requestId, error);
			request.resolve(false);
			return;
		}
		if (request.generation !== this.#requestGeneration) {
			this.node?.unsubscribeObject(object.id, true);
			request.resolve(false);
			return;
		}
		try {
			this.#installSession(object);
			request.resolve(true);
		} catch (error) {
			console.error("Error while installing grid session", object.id, error);
			request.resolve(false);
		}
	}

	#installSession(object: IDRPObject<Grid>): void {
		const node = this.getNode();
		this.#teardownActiveSession();
		const generation = this.#sessionGeneration + 1;
		this.#sessionGeneration = generation;
		this.#object = object;
		this.#gridDRP = object.drp;
		try {
			const channel = node.openEphemeral(object.id, {
				maxMessageBytes: 65_536,
				maxSequencedKeys: 1,
				maxSequencedSenders: 4_095,
			});
			this.#channel = channel;
			this.#channelDisposer = channel.subscribe((frame) => {
				if (generation !== this.#sessionGeneration || frame.key === null || frame.key !== frame.sender) return;
				const position = decodePosition(frame.payload);
				if (position === undefined) return;
				this.transientPositions.set(frame.sender, position);
				this.#render();
			});
			this.#objectDisposer = object.subscribe(() => {
				if (generation === this.#sessionGeneration) this.#render();
			});
		} catch (error) {
			this.#teardownActiveSession();
			throw error;
		}
	}

	#teardownActiveSession(): void {
		this.#sessionGeneration += 1;
		const objectId = this.#object?.id;
		this.#objectDisposer?.();
		this.#objectDisposer = undefined;
		this.#channelDisposer?.();
		this.#channelDisposer = undefined;
		if (objectId !== undefined) this.node?.unsubscribeObject(objectId, true);
		this.#channel = undefined;
		this.#gridDRP = undefined;
		this.#object = undefined;
		this.#movementGeneration = undefined;
		this.#pendingMovement = undefined;
		this.transientPositions.clear();
	}

	#publishMovement(displacement: PendingMovement): void {
		const channel = this.#channel;
		const node = this.node;
		if (channel === undefined || node === undefined) return;
		const generation = this.#sessionGeneration;
		const peerId = node.networkNode.peerId;
		const base = this.transientPositions.get(peerId) ?? this.#durableLocalPosition(peerId);
		if (base === undefined) return;
		const next = { x: base.x + displacement.dx, y: base.y + displacement.dy };
		this.#movementGeneration = generation;
		void channel
			.publish({
				class: "unreliable-sequenced",
				key: peerId,
				payload: new TextEncoder().encode(JSON.stringify(next)),
			})
			.catch(() => false)
			.then((accepted) => {
				if (generation !== this.#sessionGeneration || channel !== this.#channel) return;
				if (accepted) {
					this.transientPositions.set(peerId, next);
					this.#render();
				}
				if (this.#movementGeneration !== generation) return;
				this.#movementGeneration = undefined;
				const pending = this.#pendingMovement;
				this.#pendingMovement = undefined;
				if (pending !== undefined && (pending.dx !== 0 || pending.dy !== 0)) this.#publishMovement(pending);
			});
	}

	#durableLocalPosition(peerId: string): Position | undefined {
		const grid = this.#gridDRP;
		if (grid === undefined) return undefined;
		const user = grid.query_users().find((candidate) => candidate.startsWith(`${peerId}:`));
		const position = user === undefined ? undefined : grid.query_userPosition(user);
		return position === undefined ? undefined : { ...position };
	}
}

function decodePosition(payload: Uint8Array): Position | undefined {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(payload));
		if (
			typeof value !== "object" ||
			value === null ||
			Object.keys(value).sort().join(",") !== "x,y" ||
			!Number.isSafeInteger(Reflect.get(value, "x")) ||
			!Number.isSafeInteger(Reflect.get(value, "y"))
		) {
			return undefined;
		}
		return { x: Reflect.get(value, "x") as number, y: Reflect.get(value, "y") as number };
	} catch {
		return undefined;
	}
}

export const gridState = new GridStateManager();
