import { TypedEventEmitter } from "@libp2p/interface";
import { createDRPDiscovery } from "@ts-drp/interval-discovery";
import { createDRPReconnectBootstrap } from "@ts-drp/interval-reconnect";
import { Keychain } from "@ts-drp/keychain";
import { Logger } from "@ts-drp/logger";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { DRPNetworkNode, type GroupPeerChange } from "@ts-drp/network";
import { createPermissionlessACL, DRPObject, HashGraph } from "@ts-drp/object";
import {
	DRPDiscoveryResponse,
	type DRPNodeConfig,
	type DRPObjectSubscribeCallback,
	type FetchStateResponseEvent,
	type IDRP,
	type IDRPNode,
	type IDRPObject,
	type IntervalRunnerMap,
	Message,
	MessageType,
	type NodeConnectObjectOptions,
	type NodeCreateObjectOptions,
	NodeEventName,
	type NodeEvents,
} from "@ts-drp/types";
import { NodeConnectObjectOptionsSchema, NodeCreateObjectOptionsSchema } from "@ts-drp/validation";
import { DRPValidationError } from "@ts-drp/validation/errors";
import { AbortError, raceEvent } from "race-event";

import { clearSyncRecoveryEpisodes, drpObjectChangesHandler, handleMessage } from "./handlers.js";
import { createDRPIntervalSync } from "./interval-sync.js";
import { log } from "./logger.js";
import * as operations from "./operations.js";
import { DRPObjectStore } from "./store/index.js";

const DISCOVERY_MESSAGE_TYPES = [
	MessageType.MESSAGE_TYPE_DRP_DISCOVERY,
	MessageType.MESSAGE_TYPE_DRP_DISCOVERY_RESPONSE,
];

const DISCOVERY_QUEUE_ID = "discovery";
const objectIntervalKey = (type: "discovery" | "sync", id: string): string => `interval:${type}::${id}`;

/**
 * A DRP node.
 */
export class DRPNode extends TypedEventEmitter<NodeEvents> implements IDRPNode {
	config: DRPNodeConfig;
	networkNode: DRPNetworkNode;
	keychain: Keychain;
	messageQueueManager: MessageQueueManager<Message>;

	#objectStore: DRPObjectStore;
	private _intervals: Map<string, IntervalRunnerMap[keyof IntervalRunnerMap]> = new Map();
	private _subscribedNetworkNode?: DRPNetworkNode;
	private _connectFetchControllers = new Map<string, AbortController>();
	private _initialSyncPeers = new Map<string, Set<string>>();

	/**
	 * Create a new DRP node.
	 * @param config - The configuration for the node.
	 */
	constructor(config?: DRPNodeConfig) {
		super();
		const newLogger = new Logger("drp::node", config?.log_config);
		log.trace = newLogger.trace;
		log.debug = newLogger.debug;
		log.info = newLogger.info;
		log.warn = newLogger.warn;
		log.error = newLogger.error;
		this.networkNode = new DRPNetworkNode(config?.network_config);
		this.#objectStore = new DRPObjectStore();
		this.keychain = new Keychain(config?.keychain_config);
		this.config = {
			...config,
			interval_discovery_options: {
				...config?.interval_discovery_options,
			},
			interval_sync_options: {
				...config?.interval_sync_options,
			},
		};
		this.messageQueueManager = new MessageQueueManager<Message>({
			logConfig: this.config.log_config,
		});
	}

	/**
	 * Start the node.
	 */
	async start(): Promise<void> {
		await this.keychain.start();
		await this.networkNode.start(this.keychain.secp256k1PrivateKey);
		this.messageQueueManager.startAll();
		const reconnectInterval = createDRPReconnectBootstrap({
			...this.config.interval_reconnect_options,
			id: this.networkNode.peerId.toString(),
			networkNode: this.networkNode,
			logConfig: this.config.log_config,
		});
		this._intervals.set("interval::reconnect", reconnectInterval);
		if (this._subscribedNetworkNode !== this.networkNode) {
			this.networkNode.subscribeToMessageQueue(this.dispatchMessage.bind(this));
			this.networkNode.subscribeToGroupPeerChanges(this.handleGroupPeerChange.bind(this));
			this._subscribedNetworkNode = this.networkNode;
		}
		if (!this.messageQueueManager.hasQueue(DISCOVERY_QUEUE_ID)) {
			this.messageQueueManager.subscribe(DISCOVERY_QUEUE_ID, (msg) => handleMessage(this, msg));
		}
		reconnectInterval.start();
		this.restoreSubscriptions();
	}

	/**
	 * Stop the node.
	 */
	async stop(): Promise<void> {
		this._connectFetchControllers.forEach((controller) => controller.abort());
		this._connectFetchControllers.clear();
		this._initialSyncPeers.clear();
		this._intervals.forEach((interval) => interval.stop());
		this._intervals.clear();
		await this.networkNode.stop();
		void this.messageQueueManager.closeAll();
	}

	/**
	 * Restart the node.
	 */
	async restart(): Promise<void> {
		await this.stop();

		this.networkNode = new DRPNetworkNode(this.config?.network_config);

		await this.start();
		log.info("::restart: Node restarted");
	}

	/**
	 * Dispatch a message.
	 * @param msg - The message to dispatch.
	 */
	async dispatchMessage(msg: Message): Promise<void> {
		if (DISCOVERY_MESSAGE_TYPES.includes(msg.type)) {
			await this.messageQueueManager.enqueue(DISCOVERY_QUEUE_ID, msg);
			return;
		}

		await this.messageQueueManager.enqueue(msg.objectId, msg);
	}

	/**
	 * Add a custom group.
	 * @param group - The group to add.
	 */
	addCustomGroup(group: string): void {
		this.networkNode.subscribe(group);
	}

	/**
	 * Send a message to a group.
	 * @param group - The group to send the message to.
	 * @param data - The data to send.
	 */
	async sendGroupMessage(group: string, data: Uint8Array): Promise<void> {
		const message = Message.create({
			sender: this.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_CUSTOM,
			data,
		});
		await this.networkNode.broadcastMessage(group, message);
	}

	/**
	 * Send a message to a peer.
	 * @param peerId - The peer to send the message to.
	 * @param data - The data to send.
	 */
	async sendCustomMessage(peerId: string, data: Uint8Array): Promise<void> {
		const message = Message.create({
			sender: this.networkNode.peerId,
			type: MessageType.MESSAGE_TYPE_CUSTOM,
			data,
		});
		await this.networkNode.sendMessage(peerId, message);
	}

	/**
	 * Get an object by id
	 * @param id The id of the object
	 * @returns The object, or undefined if it does not exist
	 */
	get<T extends IDRP>(id: string): IDRPObject<T> | undefined {
		return this.#objectStore.get(id);
	}

	/**
	 * Put an object into the store.
	 * @param id The id of the object
	 * @param object The object
	 */
	put<T extends IDRP>(id: string, object: IDRPObject<T>): void {
		this.#objectStore.put(id, object);
	}

	/**
	 * Subscribe to an object.
	 * @param id The id of the object
	 * @param callback The callback to call when the object changes
	 */
	subscribe<T extends IDRP>(id: string, callback: DRPObjectSubscribeCallback<T>): void {
		this.#objectStore.subscribe(id, callback);
	}

	/**
	 * Create an object.
	 * @param options - The options for the object.
	 * @returns The created object.
	 */
	async createObject<T extends IDRP>(options: NodeCreateObjectOptions<T>): Promise<DRPObject<T>> {
		if (this.networkNode.peerId === "") {
			throw new Error("Node not started");
		}
		const validation = NodeCreateObjectOptionsSchema.safeParse(options);
		if (!validation.success) {
			throw new DRPValidationError(validation.error);
		}

		const object = new DRPObject<T>({
			peerId: this.networkNode.peerId,
			acl: options.acl ?? createPermissionlessACL(this.networkNode.peerId),
			drp: options.drp,
			id: options.id,
			metrics: options.metrics,
			config: {
				log_config: options.log_config,
			},
		});

		// put the object in the object store
		this.#objectStore.put(object.id, object);

		// subscribe to the object
		this.subscribeObject(object);

		// sync the object
		if (options.sync?.enabled) {
			await operations.syncObject(this, object.id, options.sync.peerId);
		}
		this._createObjectIntervals(object.id);
		return object;
	}

	/**
	 * Connect to an existing object
	 * @param options - The options for the object.
	 * @returns The connected object.
	 */
	async connectObject<T extends IDRP>(options: NodeConnectObjectOptions<T>): Promise<IDRPObject<T>> {
		if (this.networkNode.peerId === "") {
			throw new Error("Node not started");
		}
		const validation = NodeConnectObjectOptionsSchema.safeParse(options);
		if (!validation.success) {
			throw new DRPValidationError(validation.error);
		}
		const object = new DRPObject<T>({
			peerId: this.networkNode.peerId,
			id: options.id,
			drp: options.drp,
			metrics: options.metrics,
			config: { log_config: options.log_config },
		});

		// put the object in the object store
		this.#objectStore.put(object.id, object);

		this.subscribeObject(object);

		// Genesis authority was already derived locally from the creator-bound id.
		// Anti-entropy must remain active even when the initial fetch sees no peer,
		// so a later SYNC can deliver the object's history.
		this._createObjectIntervals(options.id);
		const previousFetch = this._connectFetchControllers.get(object.id);
		previousFetch?.abort();
		const fetchController = new AbortController();
		this._connectFetchControllers.set(object.id, fetchController);
		let fetchTimedOut = false;
		const fetchTimeout = setTimeout(() => {
			fetchTimedOut = true;
			fetchController.abort();
		}, 5000);
		const fetchResponse = raceEvent(this, NodeEventName.DRP_FETCH_STATE_RESPONSE, fetchController.signal, {
			filter: (event: CustomEvent<FetchStateResponseEvent>) =>
				event.detail.id === object.id && event.detail.fetchStateResponse.vertexHash === HashGraph.rootHash,
		});
		let fetchInFlight = false;
		const requestState = async (): Promise<void> => {
			if (fetchController.signal.aborted || fetchInFlight) return;
			fetchInFlight = true;
			try {
				await operations.fetchState(this, options.id, options.sync?.peerId);
			} catch (error) {
				log.error("::connectObject: Fetch state failed", error);
			} finally {
				fetchInFlight = false;
			}
		};
		const fetchRetry = setInterval(() => void requestState(), 1000);
		let fetchSucceeded = false;
		try {
			void requestState();
			await fetchResponse;
			fetchSucceeded = true;
		} catch (error) {
			if (error instanceof AbortError) {
				if (fetchTimedOut) log.error("::connectObject: Fetch state timed out");
			} else {
				throw error;
			}
		} finally {
			clearInterval(fetchRetry);
			clearTimeout(fetchTimeout);
			if (this._connectFetchControllers.get(object.id) === fetchController) {
				this._connectFetchControllers.delete(object.id);
			}
		}
		if (fetchController.signal.aborted && !fetchTimedOut) return object;
		if (!fetchSucceeded) return object;
		// TODO: since when the interval can run this twice do we really want it to be
		// run while the other one might still be running?
		const intervalFn = (interval: NodeJS.Timeout) => async (): Promise<void> => {
			if (object.acl) {
				await operations.syncObject(this, object.id, options.sync?.peerId);
				log.info("::connectObject: Synced object", object.id);
				log.info("::connectObject: Subscribed to object", object.id);
				clearInterval(interval);
			}
		};
		const retry = setInterval(() => void intervalFn(retry)(), 1000);

		return object;
	}

	/**
	 * Subscribe to an object.
	 * @param object - The object to subscribe to.
	 */
	subscribeObject<T extends IDRP>(object: IDRPObject<T>): void {
		// Reserve queue capacity before installing callbacks or gossip subscriptions.
		this.messageQueueManager.subscribe(object.id, (msg) => handleMessage(this, msg));
		try {
			object.subscribe((obj, originFn, vertices) => drpObjectChangesHandler(this, obj, originFn, vertices));
			this.networkNode.subscribe(object.id);
		} catch (error) {
			this.messageQueueManager.close(object.id);
			throw error;
		}
	}

	/**
	 * Unsubscribe from an object.
	 * @param id - The object ID.
	 * @param purge - Whether to purge the object.
	 */
	unsubscribeObject(id: string, purge?: boolean): void {
		this._connectFetchControllers.get(id)?.abort();
		this._connectFetchControllers.delete(id);
		this._stopObjectIntervals(id);
		clearSyncRecoveryEpisodes(this, id);
		this._initialSyncPeers.delete(id);
		this.networkNode.unsubscribe(id);
		if (purge) this.#objectStore.remove(id);
		this.networkNode.removeTopicScoreParams(id);
		this.messageQueueManager.close(id);
	}

	/**
	 * Sync an object.
	 * @param id - The object ID.
	 * @param peerId - The peer ID to sync with.
	 */
	async syncObject(id: string, peerId?: string): Promise<void> {
		await operations.syncObject(this, id, peerId);
	}

	/**
	 * Probe each newly appeared peer once while a joined object has no history
	 * yet. Genesis authority is derived locally from the creator-bound object
	 * id, so "unsynced" means the hashgraph still holds nothing beyond the root
	 * vertex. Periodic anti-entropy remains responsible for retries.
	 * @param change - Remote gossipsub topic membership change
	 */
	private handleGroupPeerChange(change: GroupPeerChange): void {
		const peers = this._initialSyncPeers.get(change.topic);
		if (!change.subscribed) {
			peers?.delete(change.peerId);
			return;
		}

		const object = this.get(change.topic);
		if (!object || object.vertices.some((vertex) => vertex.hash !== HashGraph.rootHash)) return;
		if (!this.networkNode.getSubscribedTopics().includes(change.topic)) return;
		if (!this.networkNode.getGroupPeers(change.topic).includes(change.peerId)) return;

		const initialSyncPeers = peers ?? new Set<string>();
		if (initialSyncPeers.has(change.peerId)) return;
		initialSyncPeers.add(change.peerId);
		this._initialSyncPeers.set(change.topic, initialSyncPeers);
		void this.syncObject(change.topic, change.peerId).catch((error) => {
			log.error("::initialSync: Probe failed", error);
		});
	}

	/** Restore queue and gossip subscriptions plus intervals for stored objects. */
	private restoreSubscriptions(): void {
		for (const object of this.#objectStore.values()) {
			if (!this.messageQueueManager.hasQueue(object.id)) {
				this.messageQueueManager.subscribe(object.id, (msg) => handleMessage(this, msg));
			}
			this.networkNode.subscribe(object.id);
			this._createObjectIntervals(object.id);
		}
	}

	private _createIntervalDiscovery(id: string): void {
		const key = objectIntervalKey("discovery", id);
		const existingInterval = this._intervals.get(key);
		existingInterval?.stop(); // Stop only if it exists

		const interval =
			existingInterval ??
			createDRPDiscovery({
				...this.config.interval_discovery_options,
				id,
				networkNode: this.networkNode,
				logConfig: this.config.log_config,
			});

		this._intervals.set(key, interval);
		interval.start();
	}

	private _createIntervalSync(id: string): void {
		const key = objectIntervalKey("sync", id);
		const existingInterval = this._intervals.get(key);
		existingInterval?.stop();

		const interval =
			existingInterval ??
			createDRPIntervalSync({
				...this.config.interval_sync_options,
				id,
				node: this,
				logConfig: this.config.log_config,
			});

		this._intervals.set(key, interval);
		interval.start();
	}

	private _createObjectIntervals(id: string): void {
		this._createIntervalDiscovery(id);
		this._createIntervalSync(id);
	}

	private _stopObjectIntervals(id: string): void {
		for (const type of ["discovery", "sync"] as const) {
			const key = objectIntervalKey(type, id);
			this._intervals.get(key)?.stop();
			this._intervals.delete(key);
		}
	}

	/**
	 * Handle a discovery response.
	 * @param sender - The sender of the message.
	 * @param message - The message to handle.
	 */
	async handleDiscoveryResponse(sender: string, message: Message): Promise<void> {
		const response = DRPDiscoveryResponse.decode(message.data);
		const objectId = message.objectId;
		const interval = this._intervals.get(objectIntervalKey("discovery", objectId));
		if (!interval) {
			log.error("::handleDiscoveryResponse: Object not found");
			return;
		}
		if (interval.type !== "interval:discovery") {
			log.error("::handleDiscoveryResponse: Invalid interval type");
			return;
		}
		await interval.handleDiscoveryResponse(sender, response.subscribers);
	}
}

export {
	createDRPIntervalSync,
	DRPIntervalSync,
	type DRPIntervalSyncOptions,
	INITIAL_SYNC_RETRY_INTERVAL_MS,
} from "./interval-sync.js";
