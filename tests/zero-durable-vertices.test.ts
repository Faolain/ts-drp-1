import { createPermissionlessACL, DRPObject } from "@ts-drp/object";
import { type DRPNetworkNode, Message, MessageType } from "@ts-drp/types";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
	ControlledEphemeralBus,
	type ControlledTransportPort,
} from "./fixtures/track-e1-ephemeral/controlled-transport.js";
import { Grid } from "../examples/grid/src/objects/grid.js";

type DeliveryClass = "reliable-unordered" | "unreliable-sequenced" | "unreliable-unordered";

interface PublishInput {
	readonly class: DeliveryClass;
	readonly key: string | null;
	readonly payload: Uint8Array;
}

interface DeliveredFrame extends PublishInput {
	readonly sender: string;
	readonly sequence: number;
}

type DecodedFrame = Omit<DeliveredFrame, "sender">;

interface EphemeralStats {
	readonly delivered: number;
	readonly dropped: number;
	readonly malformed: number;
	readonly overLimit: number;
	readonly published: number;
	readonly received: number;
	readonly remoteSequencedKeys: number;
	readonly sequencedSenders: number;
	readonly sequencedKeys: number;
	readonly localSequencedKeys: number;
	readonly stale: number;
	readonly subscriberFailures: number;
	readonly unauthorized: number;
}

interface EphemeralChannel {
	authorizedPeers(): readonly string[];
	close(): void;
	publish(input: PublishInput): Promise<boolean>;
	stats(): EphemeralStats;
	subscribe(listener: (frame: DeliveredFrame) => void): () => void;
}

interface EphemeralModule {
	createEphemeralChannel(
		port: ControlledTransportPort,
		options: {
			readonly maxMessageBytes: number;
			readonly maxSequencedKeys: number;
			readonly maxSequencedSenders: number;
		}
	): EphemeralChannel;
	decodeEphemeralFrame(bytes: Uint8Array): DecodedFrame;
	encodeEphemeralFrame(frame: DecodedFrame): Uint8Array;
}

interface EphemeralNode {
	openEphemeral(
		objectId: string,
		options: {
			readonly maxMessageBytes: number;
			readonly maxSequencedKeys: number;
			readonly maxSequencedSenders: number;
		}
	): EphemeralChannel;
	put(id: string, object: DRPObject<Grid>): void;
}

interface EphemeralNodeModule {
	DRPNode: new (config: unknown, dependencies: unknown) => EphemeralNode;
}

interface V3EphemeralAuthorizationProvider {
	authorForPeer(peerId: string): string | undefined;
	isCurrentWriter(author: string): boolean;
}

interface V3EphemeralAdapter {
	openAuthorized(
		objectId: string,
		provider: V3EphemeralAuthorizationProvider,
		channelOptions: ReturnType<typeof options>
	): EphemeralChannel;
	route(message: Message): boolean;
}

interface NodeEphemeralModule {
	NodeEphemeralAdapter: new (
		networkNode: DRPNetworkNode,
		getObject: (objectId: string) => undefined
	) => V3EphemeralAdapter;
}

interface Deferred<Value> {
	readonly promise: Promise<Value>;
	reject(reason?: unknown): void;
	resolve(value: Value): void;
}

interface SessionChannel extends EphemeralChannel {
	readonly closeCount: number;
	completeNext(accepted: boolean): Promise<void>;
	readonly publications: readonly { readonly x: number; readonly y: number }[];
	setAuthorizedPeers(peers: readonly string[]): void;
	transmit(sender: string, x: number, y: number): void;
}

interface SessionObject {
	readonly drp: Grid;
	readonly id: string;
	subscribe(listener: () => void): () => void;
}

interface SessionNode {
	readonly networkNode: { readonly peerId: string };
	openEphemeral(objectId: string, channelOptions: ReturnType<typeof options>): SessionChannel;
	unsubscribeObject(objectId: string): void;
}

interface GridSessionManager {
	readonly drpObject: SessionObject | undefined;
	readonly ephemeralChannel: SessionChannel | undefined;
	readonly gridDRP: Grid | undefined;
	node: SessionNode | undefined;
	readonly transientPositions: Map<string, { x: number; y: number }>;
	dispose(): void;
	move(dx: number, dy: number): void;
	reconcileEphemeralSession(): boolean;
	requestSession(requestId: string, acquire: () => Promise<SessionObject>): Promise<boolean>;
	setRenderNotifier(listener: () => void): void;
}

interface GridStateModule {
	GridStateManager: new () => GridSessionManager;
}

const ephemeralSourcePath = "packages/ephemeral/src/index.ts";
const ephemeralManifestPath = "packages/ephemeral/package.json";
const nodeSourcePath = "packages/node/src/index.ts";

const sourceExists = existsSync(ephemeralSourcePath);
const manifestExists = existsSync(ephemeralManifestPath);
const channelAvailable = sourceExists && manifestExists;
let ephemeralModule: EphemeralModule | undefined;

async function loadEphemeralModule(): Promise<EphemeralModule> {
	if (ephemeralModule !== undefined) return ephemeralModule;
	if (!sourceExists) throw new Error("Track E1 shared ephemeral channel is absent");
	const loaded: unknown = await import(pathToFileURL(ephemeralSourcePath).href);
	if (typeof loaded !== "object" || loaded === null) throw new TypeError("ephemeral module must be an object");
	const candidate = loaded as Partial<EphemeralModule>;
	if (
		typeof candidate.createEphemeralChannel !== "function" ||
		typeof candidate.encodeEphemeralFrame !== "function" ||
		typeof candidate.decodeEphemeralFrame !== "function"
	) {
		throw new TypeError("ephemeral module surface differs");
	}
	ephemeralModule = candidate as EphemeralModule;
	return ephemeralModule;
}

async function loadNodeModule(): Promise<EphemeralNodeModule> {
	const loaded: unknown = await import(pathToFileURL(nodeSourcePath).href);
	if (typeof loaded !== "object" || loaded === null || !("DRPNode" in loaded)) {
		throw new TypeError("node module surface differs");
	}
	return loaded as EphemeralNodeModule;
}

async function loadNodeEphemeralModule(): Promise<NodeEphemeralModule> {
	const loaded: unknown = await import(pathToFileURL("packages/node/src/ephemeral.ts").href);
	if (typeof loaded !== "object" || loaded === null || !("NodeEphemeralAdapter" in loaded)) {
		throw new TypeError("node ephemeral adapter surface differs");
	}
	return loaded as NodeEphemeralModule;
}

async function loadGridStateModule(): Promise<GridStateModule> {
	const loaded: unknown = await import(pathToFileURL("examples/grid/src/state.ts").href);
	if (typeof loaded !== "object" || loaded === null || !("GridStateManager" in loaded)) {
		throw new TypeError("grid session lifecycle owner is absent");
	}
	return loaded as GridStateModule;
}

function nodeNetwork(): object {
	return {
		broadcastMessage: (): Promise<void> => Promise.resolve(),
		getAllPeers: (): readonly string[] => [],
		getGroupPeers: (): readonly string[] => [],
		gossipTopicFor: (): undefined => undefined,
		peerId: "alice",
		publishMessage: (): Promise<true> => Promise.resolve(true),
		subscribe: (): void => undefined,
		unsubscribe: (): void => undefined,
	};
}

function options(
	overrides: Partial<{ maxMessageBytes: number; maxSequencedKeys: number; maxSequencedSenders: number }> = {}
): {
	readonly maxMessageBytes: number;
	readonly maxSequencedKeys: number;
	readonly maxSequencedSenders: number;
} {
	return { maxMessageBytes: 65_536, maxSequencedKeys: 1, maxSequencedSenders: 4_095, ...overrides };
}

function deferred<Value>(): Deferred<Value> {
	let rejectPromise: (reason?: unknown) => void = () => undefined;
	let resolvePromise: (value: Value) => void = () => undefined;
	const promise = new Promise<Value>((resolve, reject) => {
		rejectPromise = reject;
		resolvePromise = resolve;
	});
	return { promise, reject: rejectPromise, resolve: resolvePromise };
}

let legacyBoundaryFallbackCount = 0;

function createBoundaryChannel(
	module: EphemeralModule,
	port: ControlledTransportPort,
	channelOptions: ReturnType<typeof options>
): EphemeralChannel {
	try {
		return module.createEphemeralChannel(port, channelOptions);
	} catch (error) {
		if (!(error instanceof TypeError) || !error.message.includes("ephemeral options differ")) throw error;
		legacyBoundaryFallbackCount++;
		const createLegacyChannel = module.createEphemeralChannel as unknown as (
			legacyPort: ControlledTransportPort,
			legacyOptions: { readonly maxMessageBytes: number; readonly maxSequencedKeys: number }
		) => EphemeralChannel;
		return createLegacyChannel(port, {
			maxMessageBytes: channelOptions.maxMessageBytes,
			maxSequencedKeys: channelOptions.maxSequencedKeys,
		});
	}
}

function createSessionChannel({
	settlePendingOnClose = true,
}: { readonly settlePendingOnClose?: boolean } = {}): SessionChannel {
	let authorizedPeers: readonly string[] = [];
	let closed = false;
	let closeCount = 0;
	const listeners = new Set<(frame: DeliveredFrame) => void>();
	const pending: Deferred<boolean>[] = [];
	const publications: { readonly x: number; readonly y: number }[] = [];
	return {
		authorizedPeers: () => [...authorizedPeers],
		close: (): void => {
			closeCount += 1;
			if (closed) return;
			closed = true;
			if (settlePendingOnClose) {
				for (const result of pending.splice(0)) result.resolve(false);
			}
			listeners.clear();
		},
		get closeCount(): number {
			return closeCount;
		},
		completeNext: async (accepted): Promise<void> => {
			const result = pending.shift();
			if (result === undefined) throw new Error("no pending controlled publication");
			result.resolve(accepted);
			await Promise.resolve();
			await Promise.resolve();
		},
		publish: ({ payload }): Promise<boolean> => {
			if (closed) return Promise.resolve(false);
			const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
			if (typeof parsed !== "object" || parsed === null) throw new TypeError("movement payload differs");
			publications.push({ x: Reflect.get(parsed, "x") as number, y: Reflect.get(parsed, "y") as number });
			const result = deferred<boolean>();
			pending.push(result);
			return result.promise;
		},
		publications,
		setAuthorizedPeers: (peers): void => {
			authorizedPeers = [...peers];
		},
		stats: () => ({
			delivered: 0,
			dropped: 0,
			localSequencedKeys: 0,
			malformed: 0,
			overLimit: 0,
			published: 0,
			received: 0,
			remoteSequencedKeys: 0,
			sequencedKeys: 0,
			sequencedSenders: 0,
			stale: 0,
			subscriberFailures: 0,
			unauthorized: 0,
		}),
		subscribe: (listener): (() => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		transmit: (sender, x, y): void => {
			for (const listener of listeners) {
				listener({
					class: "unreliable-sequenced",
					key: sender,
					payload: bytes(JSON.stringify({ x, y })),
					sender,
					sequence: 1,
				});
			}
		},
	};
}

function createSessionObject(
	id: string,
	localX = 0,
	localY = 0
): {
	readonly callbacks: Set<() => void>;
	readonly dispose: ReturnType<typeof vi.fn>;
	readonly object: SessionObject;
} {
	const callbacks = new Set<() => void>();
	const dispose = vi.fn();
	const drp = {
		query_userPosition: () => ({ x: localX, y: localY }),
		query_users: () => ["local:red"],
	} as unknown as Grid;
	return {
		callbacks,
		dispose,
		object: {
			drp,
			id,
			subscribe: (listener) => {
				callbacks.add(listener);
				return () => {
					callbacks.delete(listener);
					dispose();
				};
			},
		},
	};
}

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

describe("Track E1 controlled transport", () => {
	it("provides transport facts without owning frame semantics", async () => {
		const bus = new ControlledEphemeralBus();
		const alice = bus.createPort("alice");
		const bob = bus.createPort("bob");
		const observed: { readonly bytes: Uint8Array; readonly sender: string }[] = [];
		bob.onMessage((ingress) => observed.push(ingress));
		bus.authorize("bob", "alice");

		const callerBytes = bytes("detached");
		expect(await alice.send(callerBytes)).toBe(true);
		callerBytes.fill(0);
		expect(new TextDecoder().decode(observed[0]?.bytes)).toBe("detached");
		bus.hold("alice");
		const held = alice.send(bytes("held"));
		expect(bus.pending("alice")).toBe(1);
		expect(observed).toHaveLength(1);
		bus.release("alice");
		expect(await held).toBe(true);
		expect(new TextDecoder().decode(observed[1]?.bytes)).toBe("held");
		expect(bob.isAuthorized("alice")).toBe(true);
		bus.authorize("bob", "alice", false);
		expect(bob.isAuthorized("alice")).toBe(false);
	});
});

describe("Track E1 post-closure correction", () => {
	it("isolates local and admitted sender registries while bounding each owner", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		for (const peerId of ["alice", "bob", "carol", "dave"]) bus.createPort(peerId);
		const bob = createBoundaryChannel(
			module,
			bus.createPort("receiver"),
			options({ maxSequencedKeys: 1, maxSequencedSenders: 2 })
		);
		for (const sender of ["alice", "carol", "dave"]) bus.authorize("receiver", sender);
		const delivered: DeliveredFrame[] = [];
		bob.subscribe((frame) => delivered.push(frame));
		const inject = (sender: string, key: string, sequence: number): void => {
			bus.inject(
				"receiver",
				sender,
				module.encodeEphemeralFrame({
					class: "unreliable-sequenced",
					key,
					payload: bytes(`${sender}:${key}`),
					sequence,
				})
			);
		};

		inject("alice", "first", 1);
		inject("alice", "overflow", 1);
		inject("carol", "first", 1);
		inject("dave", "first", 1);
		expect(await bob.publish({ class: "unreliable-sequenced", key: "local", payload: bytes("local") })).toBe(true);

		expect(delivered.map(({ sender }) => sender)).toEqual(["alice", "carol"]);
		expect(bob.stats()).toMatchObject({
			localSequencedKeys: 1,
			overLimit: 2,
			remoteSequencedKeys: 2,
			sequencedKeys: 3,
			sequencedSenders: 2,
		});
	});

	it("exposes detached current peers and releases the complete registry and transport on close", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		bus.createPort("alice");
		const bob = createBoundaryChannel(module, bus.createPort("bob"), options());
		bus.authorize("bob", "alice");
		const first = bob.authorizedPeers();
		expect(first).toEqual(["alice"]);
		(first as string[]).push("forged");
		expect(bob.authorizedPeers()).toEqual(["alice"]);
		bus.disconnect("alice");
		expect(bob.authorizedPeers()).toEqual([]);
		bus.connect("alice");
		expect(bob.authorizedPeers()).toEqual(["alice"]);
		expect(
			await bob.publish({ class: "unreliable-sequenced", key: "local", payload: bytes("local-before-close") })
		).toBe(true);
		bus.inject(
			"bob",
			"alice",
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: "remote",
				payload: bytes("remote-before-close"),
				sequence: 1,
			})
		);
		expect(bob.stats()).toMatchObject({
			localSequencedKeys: 1,
			remoteSequencedKeys: 1,
			sequencedKeys: 2,
			sequencedSenders: 1,
		});

		bob.close();
		expect(bus.closeCount("bob")).toBe(1);
		expect(bob.stats()).toMatchObject({
			localSequencedKeys: 0,
			remoteSequencedKeys: 0,
			sequencedKeys: 0,
			sequencedSenders: 0,
		});
	});

	it("authorizes v3 E1 only through enrolled peer-to-author mappings and the current writer projection", async () => {
		const { NodeEphemeralAdapter } = await loadNodeEphemeralModule();
		const groups = ["peer-writer", "peer-reader", "peer-unknown"];
		const subscribed: string[] = [];
		const network = {
			...nodeNetwork(),
			getGroupPeers: (): readonly string[] => [...groups],
			peerId: "peer-local",
			subscribe: (topic: string): void => {
				subscribed.push(topic);
			},
		} as unknown as DRPNetworkNode;
		const adapter = new NodeEphemeralAdapter(network, () => undefined);
		const roster = new Map([
			["peer-writer", "author-writer"],
			["peer-reader", "author-reader"],
		]);
		const channel = adapter.openAuthorized(
			"zone",
			{
				authorForPeer: (peerId) => roster.get(peerId),
				isCurrentWriter: (author) => author === "author-writer",
			},
			options()
		);
		expect(subscribed).toHaveLength(1);
		expect(channel.authorizedPeers()).toEqual(["peer-writer"]);
		roster.set("peer-writer", "author-no-longer-writer");
		expect(channel.authorizedPeers()).toEqual([]);
		roster.set("peer-writer", "author-writer");
		groups.splice(0, groups.length, "peer-reader", "peer-unknown");
		expect(channel.authorizedPeers()).toEqual([]);
		channel.close();
	});

	it("fails v3 E1 closed for wrong-topic, malformed, unauthorized, and post-deactivation ingress", async () => {
		const module = await loadEphemeralModule();
		const { NodeEphemeralAdapter } = await loadNodeEphemeralModule();
		let topic = "";
		const network = {
			...nodeNetwork(),
			getGroupPeers: (): readonly string[] => ["peer-writer", "peer-reader"],
			gossipTopicFor: (message: Message): string | undefined => message.objectId,
			peerId: "peer-local",
			subscribe: (selected: string): void => {
				topic = selected;
			},
		} as unknown as DRPNetworkNode;
		const adapter = new NodeEphemeralAdapter(network, () => undefined);
		const roster = new Map([
			["peer-writer", "author-writer"],
			["peer-reader", "author-reader"],
		]);
		const channel = adapter.openAuthorized(
			"zone",
			{
				authorForPeer: (peerId) => roster.get(peerId),
				isCurrentWriter: (author) => author === "author-writer",
			},
			options()
		);
		expect(topic).not.toBe("");
		const message = (objectId: string, sender: string, data: Uint8Array): Message =>
			Message.create({ data, objectId, sender, type: MessageType.MESSAGE_TYPE_CUSTOM });
		const frame = (key: string): Uint8Array =>
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key,
				payload: bytes(key),
				sequence: 1,
			});
		const delivered: string[] = [];
		channel.subscribe(({ payload }) => delivered.push(new TextDecoder().decode(payload)));
		expect(adapter.route(message(topic, "peer-writer", frame("authorized-writer")))).toBe(true);
		expect(adapter.route(message("wrong-topic", "peer-writer", Uint8Array.of(1)))).toBe(false);
		expect(adapter.route(message(topic, "peer-writer", Uint8Array.of(0xff)))).toBe(true);
		expect(adapter.route(message(topic, "peer-unknown", frame("unknown")))).toBe(true);
		expect(adapter.route(message(topic, "peer-reader", frame("enrolled-non-writer")))).toBe(true);
		roster.set("peer-writer", "author-reader");
		expect(adapter.route(message(topic, "peer-writer", frame("peer-author-mismatch")))).toBe(true);
		expect(delivered).toEqual(["authorized-writer"]);
		expect(channel.stats()).toMatchObject({ delivered: 1, malformed: 1, unauthorized: 3 });
		channel.close();
		expect(adapter.route(message(topic, "peer-writer", Uint8Array.of(1)))).toBe(false);
	});

	it("preserves legacy object-bound fixture acquisition and cleanup outside the grid product bundle", async () => {
		const { GridStateManager } = await loadGridStateModule();
		const manager = new GridStateManager();
		const renders = vi.fn();
		const unsubscribed: string[] = [];
		const opened: { readonly id: string; readonly channelOptions: ReturnType<typeof options> }[] = [];
		const channels = new Map<string, SessionChannel>();
		manager.node = {
			networkNode: { peerId: "local" },
			openEphemeral: (id, channelOptions): SessionChannel => {
				opened.push({ channelOptions, id });
				const channel = createSessionChannel({ settlePendingOnClose: id !== "latest" });
				channels.set(id, channel);
				return channel;
			},
			unsubscribeObject: (id): void => {
				unsubscribed.push(id);
				channels.get(id)?.close();
			},
		};
		manager.setRenderNotifier(renders);

		const slow = deferred<SessionObject>();
		const middle = deferred<SessionObject>();
		const latest = deferred<SessionObject>();
		const slowObject = createSessionObject("slow");
		const latestObject = createSessionObject("latest");
		const slowRequest = manager.requestSession("slow", () => slow.promise);
		const middleAcquire = vi.fn(() => middle.promise);
		const middleRequest = manager.requestSession("middle", middleAcquire);
		const latestRequest = manager.requestSession("latest", () => latest.promise);
		slow.resolve(slowObject.object);
		await expect(slowRequest).resolves.toBe(false);
		expect(unsubscribed).toEqual(["slow"]);
		expect(middleAcquire).not.toHaveBeenCalled();
		latest.resolve(latestObject.object);
		await expect(middleRequest).resolves.toBe(false);
		await expect(latestRequest).resolves.toBe(true);
		expect(manager.drpObject?.id).toBe("latest");
		expect(opened).toEqual([{ channelOptions: options(), id: "latest" }]);
		const duplicateAcquire = vi.fn(() => Promise.resolve(createSessionObject("duplicate-latest").object));
		await expect(manager.requestSession("latest", duplicateAcquire)).resolves.toBe(true);
		expect(duplicateAcquire).not.toHaveBeenCalled();
		expect(unsubscribed).toEqual(["slow"]);

		const latestChannel = channels.get("latest");
		if (latestChannel === undefined) throw new Error("latest session channel was not installed");
		const staleCallback = [...latestObject.callbacks][0];
		if (staleCallback === undefined) throw new Error("latest object callback was not installed");
		latestChannel.transmit("old-remote", 4, 5);
		expect(manager.transientPositions.get("old-remote")).toEqual({ x: 4, y: 5 });
		manager.move(1, 0);
		expect(latestChannel.publications).toHaveLength(1);

		const replacement = createSessionObject("replacement");
		await expect(manager.requestSession("replacement", () => Promise.resolve(replacement.object))).resolves.toBe(true);
		expect(unsubscribed).toEqual(["slow", "latest"]);
		expect(latestObject.dispose).toHaveBeenCalledTimes(1);
		expect(latestChannel.closeCount).toBe(1);
		expect(manager.transientPositions.has("old-remote")).toBe(false);
		const rendersBeforeStaleWork = renders.mock.calls.length;
		staleCallback();
		await latestChannel.completeNext(true);
		expect(renders).toHaveBeenCalledTimes(rendersBeforeStaleWork);
		expect(manager.transientPositions.has("local")).toBe(false);

		const failure = deferred<SessionObject>();
		const recovered = createSessionObject("recovered");
		const failedRequest = manager.requestSession("failure", () => failure.promise);
		const recoveredRequest = manager.requestSession("recovered", () => Promise.resolve(recovered.object));
		failure.reject(new Error("controlled acquisition failure"));
		await expect(failedRequest).resolves.toBe(false);
		await expect(recoveredRequest).resolves.toBe(true);
		expect(manager.drpObject?.id).toBe("recovered");
		expect(opened.map(({ channelOptions, id }) => ({ channelOptions, id }))).toEqual([
			{ channelOptions: options(), id: "latest" },
			{ channelOptions: options(), id: "replacement" },
			{ channelOptions: options(), id: "recovered" },
		]);
		const recoveredChannel = channels.get("recovered");
		if (recoveredChannel === undefined) throw new Error("recovered session channel was not installed");
		manager.dispose();
		expect(unsubscribed.at(-1)).toBe("recovered");
		expect(recovered.dispose).toHaveBeenCalledTimes(1);
		expect(recoveredChannel.closeCount).toBe(1);
	});

	it.each([
		{ outcomes: [true, true] as const, positions: [11, 13], renders: 2, retained: 13 },
		{ outcomes: [true, false] as const, positions: [11, 13], renders: 1, retained: 11 },
		{ outcomes: [false, true] as const, positions: [11, 12], renders: 1, retained: 12 },
		{ outcomes: [false, false] as const, positions: [11, 12], renders: 0, retained: undefined },
	])(
		"preserves legacy fixture movement serialization: $outcomes",
		async ({ outcomes, positions, renders, retained }) => {
			const { GridStateManager } = await loadGridStateModule();
			const manager = new GridStateManager();
			const renderNotifier = vi.fn();
			const channel = createSessionChannel();
			manager.node = {
				networkNode: { peerId: "local" },
				openEphemeral: (): SessionChannel => channel,
				unsubscribeObject: (): void => undefined,
			};
			manager.setRenderNotifier(renderNotifier);
			await manager.requestSession("movement", () => Promise.resolve(createSessionObject("movement", 10, 0).object));

			manager.move(1, 0);
			manager.move(1, 0);
			manager.move(1, 0);
			expect(channel.publications.map(({ x }) => x)).toEqual([positions[0]]);
			await channel.completeNext(outcomes[0]);
			await vi.waitFor(() => expect(channel.publications).toHaveLength(2));
			expect(channel.publications.map(({ x }) => x)).toEqual(positions);
			await channel.completeNext(outcomes[1]);
			expect(channel.publications).toHaveLength(2);
			expect(renderNotifier).toHaveBeenCalledTimes(renders);
			expect(manager.transientPositions.get("local")?.x).toBe(retained);
			manager.dispose();
		}
	);

	it("preserves legacy fixture overlay reconciliation outside the product bundle", async () => {
		const { GridStateManager } = await loadGridStateModule();
		const manager = new GridStateManager();
		const renderNotifier = vi.fn();
		const channel = createSessionChannel();
		manager.node = {
			networkNode: { peerId: "local" },
			openEphemeral: (): SessionChannel => channel,
			unsubscribeObject: (): void => undefined,
		};
		manager.setRenderNotifier(renderNotifier);
		await manager.requestSession("room", () => Promise.resolve(createSessionObject("room").object));
		manager.move(1, 0);
		await channel.completeNext(true);
		expect(manager.transientPositions.get("local")).toEqual({ x: 1, y: 0 });
		channel.setAuthorizedPeers(["remote"]);
		channel.transmit("remote", 4, 5);
		expect(manager.transientPositions.get("remote")).toEqual({ x: 4, y: 5 });
		expect(manager.reconcileEphemeralSession()).toBe(false);
		expect(manager.transientPositions.get("remote")).toEqual({ x: 4, y: 5 });
		channel.setAuthorizedPeers([]);
		expect(manager.reconcileEphemeralSession()).toBe(true);
		expect(manager.transientPositions.has("remote")).toBe(false);
		expect(manager.transientPositions.get("local")).toEqual({ x: 1, y: 0 });
		expect(manager.reconcileEphemeralSession()).toBe(false);
		manager.dispose();
	});
});

describe.skipIf(!channelAvailable)("Track E1 shared ephemeral channel", () => {
	it("publishes 57,600 movement samples without growing durable state", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const channel = createBoundaryChannel(module, bus.createPort("alice"), options());
		const world = new DRPObject({
			acl: createPermissionlessACL("alice"),
			drp: new Grid(),
			peerId: "alice",
		});
		world.drp?.addUser("alice", "red");
		const afterAdmission = world.vertices.length;

		for (let sample = 0; sample < 57_600; sample += 1) {
			await channel.publish({
				class: "unreliable-sequenced",
				key: "alice",
				payload: bytes(String(sample)),
			});
		}

		expect(channel.stats().published).toBe(57_600);
		expect(world.vertices).toHaveLength(afterAdmission);

		const durableControl = new DRPObject({
			acl: createPermissionlessACL("control"),
			drp: new Grid(),
			peerId: "control",
		});
		const beforeControlAdmission = durableControl.vertices.length;
		durableControl.drp?.addUser("control", "blue");
		expect(durableControl.vertices).toHaveLength(beforeControlAdmission + 1);
		channel.close();
	});

	it("delivers all three classes and isolates sequenced watermarks by sender and key", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		const carol = createBoundaryChannel(module, bus.createPort("carol"), options());
		const bob = createBoundaryChannel(
			module,
			bus.createPort("bob"),
			options({ maxSequencedKeys: 6, maxSequencedSenders: 2 })
		);
		bus.authorize("bob", "alice");
		bus.authorize("bob", "carol");
		const delivered: DeliveredFrame[] = [];
		bob.subscribe((frame) => delivered.push(frame));

		expect(await alice.publish({ class: "unreliable-unordered", key: null, payload: bytes("unordered") })).toBe(true);
		expect(await alice.publish({ class: "reliable-unordered", key: null, payload: bytes("reliable") })).toBe(true);
		expect(await alice.publish({ class: "unreliable-sequenced", key: "avatar", payload: bytes("alice-1") })).toBe(true);
		expect(await carol.publish({ class: "unreliable-sequenced", key: "avatar", payload: bytes("carol-1") })).toBe(true);
		bus.inject(
			"bob",
			"alice",
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: "primary",
				payload: bytes("alice-primary-10"),
				sequence: 10,
			})
		);
		bus.inject(
			"bob",
			"alice",
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: "secondary",
				payload: bytes("alice-secondary-1"),
				sequence: 1,
			})
		);

		expect(delivered.map((frame) => new TextDecoder().decode(frame.payload))).toEqual([
			"unordered",
			"reliable",
			"alice-1",
			"carol-1",
			"alice-primary-10",
			"alice-secondary-1",
		]);
		expect(delivered.at(-2)?.sequence).toBe(10);
		expect(delivered.at(-1)?.sequence).toBe(1);
		expect(bob.stats()).toMatchObject({ delivered: 6, received: 6 });
	});

	it("rejects replay after disconnect while accepting a later monotonic publication", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		const bob = createBoundaryChannel(module, bus.createPort("bob"), options());
		bus.authorize("bob", "alice");
		const delivered: DeliveredFrame[] = [];
		let replayedDuringCallback = false;
		bob.subscribe((frame) => {
			if (!replayedDuringCallback) {
				replayedDuringCallback = true;
				bus.inject(
					"bob",
					"alice",
					module.encodeEphemeralFrame({
						class: frame.class,
						key: frame.key,
						payload: frame.payload,
						sequence: frame.sequence,
					})
				);
			}
		});
		bob.subscribe((frame) => delivered.push(frame));
		await alice.publish({ class: "unreliable-sequenced", key: "avatar", payload: bytes("first") });
		const replay = bus.sent().at(-1)?.bytes;
		if (replay === undefined) throw new Error("missing controlled replay frame");

		bus.disconnect("alice");
		bus.connect("alice");
		bus.inject("bob", "alice", replay);
		await alice.publish({ class: "unreliable-sequenced", key: "avatar", payload: bytes("second") });

		expect(delivered.map((frame) => new TextDecoder().decode(frame.payload))).toEqual(["first", "second"]);
		expect(bob.stats()).toMatchObject({ delivered: 2, received: 4, stale: 2 });
	});

	it("bounds unreliable queues, drops newest unordered work and coalesces sequenced work by key", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		const bob = createBoundaryChannel(module, bus.createPort("bob"), options());
		bus.authorize("bob", "alice");
		const delivered: DeliveredFrame[] = [];
		bob.subscribe((frame) => delivered.push(frame));

		bus.hold("alice");
		const unordered = Array.from({ length: 10_000 }, (_, index) =>
			alice.publish({ class: "unreliable-unordered", key: null, payload: bytes(`u:${index}`) })
		);
		await Promise.resolve();
		expect(bus.pending("alice")).toBeGreaterThan(0);
		bus.release("alice");
		const unorderedResults = await Promise.all(unordered);
		const unorderedAccepted = unorderedResults.filter(Boolean).length;
		expect(unorderedAccepted).toBeGreaterThan(0);
		expect(unorderedAccepted).toBeLessThan(unordered.length);
		expect(unorderedResults[0]).toBe(true);
		expect(unorderedResults.at(-1)).toBe(false);

		bus.hold("alice");
		const sequenced = Array.from({ length: 10_000 }, (_, index) =>
			alice.publish({ class: "unreliable-sequenced", key: "avatar", payload: bytes(`s:${index}`) })
		);
		await Promise.resolve();
		expect(bus.pending("alice")).toBeGreaterThan(0);
		bus.release("alice");
		const sequencedResults = await Promise.all(sequenced);
		const sequencedAccepted = sequencedResults.filter(Boolean).length;
		expect(sequencedAccepted).toBeGreaterThan(0);
		expect(sequencedAccepted).toBeLessThan(sequenced.length);
		expect(sequencedResults.at(-1)).toBe(true);
		const latest = delivered.at(-1);
		if (latest === undefined) throw new Error("missing latest sequenced delivery");
		expect(new TextDecoder().decode(latest.payload)).toBe("s:9999");
		expect(alice.stats().dropped).toBeGreaterThan(0);
		expect(alice.stats().published).toBe(unorderedAccepted + sequencedAccepted);
	});

	it("copies publication bytes and isolates throwing subscribers", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		const bob = createBoundaryChannel(module, bus.createPort("bob"), options());
		bus.authorize("bob", "alice");
		const payload = bytes("copied");
		const delivered: string[] = [];
		bob.subscribe((frame) => {
			frame.payload.fill(0);
			throw new Error("subscriber failure");
		});
		bob.subscribe((frame) => delivered.push(new TextDecoder().decode(frame.payload)));

		const publication = alice.publish({ class: "unreliable-unordered", key: null, payload });
		payload.fill(0);
		expect(await publication).toBe(true);
		expect(delivered).toEqual(["copied"]);
		expect(bob.stats().subscriberFailures).toBe(1);
	});

	it("fails closed for malformed, unauthorized, stale and over-limit ingress", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		const bob = createBoundaryChannel(module, bus.createPort("bob"), options({ maxMessageBytes: 128 }));
		const delivered: DeliveredFrame[] = [];
		bob.subscribe((frame) => delivered.push(frame));

		bus.authorize("bob", "alice");
		bus.inject("bob", "alice", Uint8Array.of(0xff, 0x00));
		bus.authorize("bob", "alice", false);
		await alice.publish({ class: "unreliable-unordered", key: null, payload: bytes("unauthorized") });
		bus.authorize("bob", "alice");
		bus.inject(
			"bob",
			"alice",
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: "avatar",
				payload: new Uint8Array(256),
				sequence: 1,
			})
		);

		expect(delivered).toEqual([]);
		expect(bob.stats()).toMatchObject({
			delivered: 0,
			malformed: 1,
			overLimit: 1,
			received: 3,
			unauthorized: 1,
		});
	});

	it("enforces closed options and sender-plus-key limits", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const port = bus.createPort("alice");
		expect(() => module.createEphemeralChannel(port, options({ maxMessageBytes: 0 }))).toThrow();
		expect(() => module.createEphemeralChannel(port, options({ maxMessageBytes: 65_537 }))).toThrow();
		expect(() => module.createEphemeralChannel(port, options({ maxSequencedKeys: 0 }))).toThrow();
		expect(() => module.createEphemeralChannel(port, options({ maxSequencedKeys: 4_097 }))).toThrow();
		expect(() => module.createEphemeralChannel(port, options({ maxSequencedSenders: 0 }))).toThrow();
		const maxSenderBoundary = module.createEphemeralChannel(
			bus.createPort("max-sender-boundary"),
			options({ maxSequencedKeys: 1, maxSequencedSenders: 4_095 })
		);
		maxSenderBoundary.close();
		expect(() => module.createEphemeralChannel(port, options({ maxSequencedSenders: 4_096 }))).toThrow();
		expect(() =>
			module.createEphemeralChannel(port, options({ maxSequencedKeys: 2, maxSequencedSenders: 2_048 }))
		).toThrow();
		expect(() => module.createEphemeralChannel(bus.createPort("tiny-envelope", 1), options())).toThrow();
		expect(() =>
			module.createEphemeralChannel(port, {
				maxMessageBytes: 65_536,
				maxSequencedKeys: 1,
			} as ReturnType<typeof options>)
		).toThrow();
		expect(() =>
			module.createEphemeralChannel(bus.createPort("extra-options"), {
				...options(),
				unexpected: true,
			} as ReturnType<typeof options>)
		).toThrow();
		const channel = module.createEphemeralChannel(port, options({ maxSequencedKeys: 1 }));
		expect(await channel.publish({ class: "unreliable-sequenced", key: "x".repeat(129), payload: bytes("x") })).toBe(
			false
		);
		const retainedKey = "y".repeat(128);
		expect(await channel.publish({ class: "unreliable-sequenced", key: retainedKey, payload: bytes("x") })).toBe(true);
		expect(await channel.publish({ class: "unreliable-sequenced", key: "second", payload: bytes("x") })).toBe(false);
		expect(await channel.publish({ class: "unreliable-sequenced", key: retainedKey, payload: bytes("again") })).toBe(
			true
		);
		const snapshot = channel.stats();
		expect(snapshot).toMatchObject({ overLimit: 2, sequencedKeys: 1 });
		try {
			(snapshot as { sequencedKeys: number }).sequencedKeys = 99;
		} catch {
			// A frozen snapshot and a detached mutable snapshot are both externally immutable channel state.
		}
		expect(channel.stats().sequencedKeys).toBe(1);
		channel.close();
		expect(channel.stats().sequencedKeys).toBe(0);
		expect(await channel.publish({ class: "unreliable-unordered", key: null, payload: bytes("closed") })).toBe(false);
		expect(legacyBoundaryFallbackCount).toBe(0);
	});

	it("reuses identical node channel options and rejects conflicting reopen", async () => {
		const { DRPNode } = await loadNodeModule();
		const subscribedTopics: string[] = [];
		const getGroupPeers = vi.fn((topic: string): readonly string[] =>
			topic === "world" ? ["durable-only"] : ["writer", "reader"]
		);
		const network = {
			...nodeNetwork(),
			getGroupPeers,
			subscribe: (topic: string): void => {
				subscribedTopics.push(topic);
			},
		};
		const node = new DRPNode({ log_config: { level: "silent" } }, { networkNode: network, reconnect: false });
		const world = new DRPObject({
			acl: createPermissionlessACL("alice"),
			drp: new Grid(),
			id: "world",
			peerId: "alice",
		});
		vi.spyOn(world.acl, "query_isWriter").mockImplementation((peerId) => peerId === "writer");
		node.put("world", world);
		const first = node.openEphemeral("world", options());
		expect(first.authorizedPeers()).toEqual(["writer"]);
		expect(subscribedTopics).toHaveLength(1);
		expect(subscribedTopics[0]).not.toBe("world");
		expect(getGroupPeers).toHaveBeenCalledWith(subscribedTopics[0]);
		expect(getGroupPeers).not.toHaveBeenCalledWith("world");
		expect(node.openEphemeral("world", options())).toBe(first);
		expect(() => node.openEphemeral("world", options({ maxMessageBytes: 1_024 }))).toThrow();
		expect(() => node.openEphemeral("world", options({ maxSequencedSenders: 4_094 }))).toThrow();
		first.close();
	});

	it("retries reliable local failures but does not retry unreliable publications", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		bus.failNext("alice", 1);
		expect(await alice.publish({ class: "unreliable-unordered", key: null, payload: bytes("drop") })).toBe(false);
		bus.failNext("alice", 2);
		expect(await alice.publish({ class: "reliable-unordered", key: null, payload: bytes("retry") })).toBe(true);
		bus.failNext("alice", 1_000);
		expect(await alice.publish({ class: "reliable-unordered", key: null, payload: bytes("bounded") })).toBe(false);
		expect(alice.stats()).toMatchObject({ dropped: 1, published: 1 });
	});

	it("keeps frame decoding closed and detached", async () => {
		const module = await loadEphemeralModule();
		const encoded = module.encodeEphemeralFrame({
			class: "unreliable-sequenced",
			key: "avatar",
			payload: bytes("frame"),
			sequence: 7,
		});
		const decoded = module.decodeEphemeralFrame(encoded);
		expect(decoded).toMatchObject({
			class: "unreliable-sequenced",
			key: "avatar",
			sequence: 7,
		});
		expect(new TextDecoder().decode(decoded.payload)).toBe("frame");
		expect(() =>
			module.encodeEphemeralFrame({
				class: "unknown" as DeliveryClass,
				key: null,
				payload: bytes("frame"),
				sequence: 0,
			})
		).toThrow();
		expect(() =>
			module.encodeEphemeralFrame({
				class: "unreliable-unordered",
				key: null,
				payload: bytes("frame"),
				sequence: 0,
				unexpected: true,
			} as DecodedFrame)
		).toThrow();
		expect(() =>
			module.encodeEphemeralFrame({
				class: "unreliable-unordered",
				key: "extra",
				payload: bytes("frame"),
				sequence: 0,
			})
		).toThrow();
		expect(() =>
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: null,
				payload: bytes("frame"),
				sequence: 1,
			})
		).toThrow();
		expect(() =>
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: "avatar",
				payload: bytes("frame"),
				sequence: Number.MAX_SAFE_INTEGER + 1,
			})
		).toThrow();
		expect(() => module.decodeEphemeralFrame(encoded.subarray(0, encoded.length - 1))).toThrow();
		expect(() => module.decodeEphemeralFrame(Uint8Array.of(...encoded, 0))).toThrow();
		expect(() => module.decodeEphemeralFrame(Uint8Array.of(0xff, 0xfe, 0xfd))).toThrow();
	});
});
