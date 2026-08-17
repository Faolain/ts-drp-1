import { createPermissionlessACL, DRPObject } from "@ts-drp/object";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

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
	readonly sequencedKeys: number;
	readonly stale: number;
	readonly subscriberFailures: number;
	readonly unauthorized: number;
}

interface EphemeralChannel {
	close(): void;
	publish(input: PublishInput): Promise<boolean>;
	stats(): EphemeralStats;
	subscribe(listener: (frame: DeliveredFrame) => void): () => void;
}

interface EphemeralModule {
	createEphemeralChannel(
		port: ControlledTransportPort,
		options: { readonly maxMessageBytes: number; readonly maxSequencedKeys: number }
	): EphemeralChannel;
	decodeEphemeralFrame(bytes: Uint8Array): DecodedFrame;
	encodeEphemeralFrame(frame: DecodedFrame): Uint8Array;
}

interface EphemeralNode {
	openEphemeral(
		objectId: string,
		options: { readonly maxMessageBytes: number; readonly maxSequencedKeys: number }
	): EphemeralChannel;
	put(id: string, object: DRPObject<Grid>): void;
}

interface EphemeralNodeModule {
	DRPNode: new (config: unknown, dependencies: unknown) => EphemeralNode;
}

const ephemeralSourcePath = "packages/ephemeral/src/index.ts";
const ephemeralManifestPath = "packages/ephemeral/package.json";
const nodeSourcePath = "packages/node/src/index.ts";
const gridSourcePath = "examples/grid/src/index.ts";
const gridObjectPath = "examples/grid/src/objects/grid.ts";

const sourceExists = existsSync(ephemeralSourcePath);
const manifestExists = existsSync(ephemeralManifestPath);
const nodeSource = readFileSync(nodeSourcePath, "utf8");
const gridSource = readFileSync(gridSourcePath, "utf8");
const gridObjectSource = readFileSync(gridObjectPath, "utf8");
const productionReady =
	sourceExists &&
	manifestExists &&
	nodeSource.includes("openEphemeral(") &&
	gridSource.includes("openEphemeral(") &&
	!gridSource.includes('from "@ts-drp/ephemeral"') &&
	!gridSource.includes("gridDRP.moveUser(") &&
	!gridObjectSource.includes("moveUser(");

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

function options(overrides: Partial<{ maxMessageBytes: number; maxSequencedKeys: number }> = {}): {
	readonly maxMessageBytes: number;
	readonly maxSequencedKeys: number;
} {
	return { maxMessageBytes: 65_536, maxSequencedKeys: 4_096, ...overrides };
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

describe("Track E1 readiness", () => {
	it("installs one shared channel and composes it through node and grid", () => {
		expect({
			ephemeralManifest: manifestExists,
			ephemeralSource: sourceExists,
			gridCallsNodeApi: gridSource.includes("openEphemeral("),
			gridDurableMovementRemoved: !gridSource.includes("gridDRP.moveUser(") && !gridObjectSource.includes("moveUser("),
			gridUsesOnlyNodeApi: !gridSource.includes('from "@ts-drp/ephemeral"'),
			nodeApi: nodeSource.includes("openEphemeral("),
		}).toEqual({
			ephemeralManifest: true,
			ephemeralSource: true,
			gridCallsNodeApi: true,
			gridDurableMovementRemoved: true,
			gridUsesOnlyNodeApi: true,
			nodeApi: true,
		});
	});
});

describe.skipIf(!productionReady)("Track E1 shared ephemeral channel", () => {
	it("publishes 57,600 movement samples without growing durable state", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const channel = module.createEphemeralChannel(bus.createPort("alice"), options());
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
		const alice = module.createEphemeralChannel(bus.createPort("alice"), options());
		const carol = module.createEphemeralChannel(bus.createPort("carol"), options());
		const bob = module.createEphemeralChannel(bus.createPort("bob"), options());
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
		const alice = module.createEphemeralChannel(bus.createPort("alice"), options());
		const bob = module.createEphemeralChannel(bus.createPort("bob"), options());
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
		const alice = module.createEphemeralChannel(bus.createPort("alice"), options());
		const bob = module.createEphemeralChannel(bus.createPort("bob"), options());
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
		const alice = module.createEphemeralChannel(bus.createPort("alice"), options());
		const bob = module.createEphemeralChannel(bus.createPort("bob"), options());
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
		const alice = module.createEphemeralChannel(bus.createPort("alice"), options());
		const bob = module.createEphemeralChannel(bus.createPort("bob"), options({ maxMessageBytes: 128 }));
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
		expect(() => module.createEphemeralChannel(bus.createPort("tiny-envelope", 1), options())).toThrow();
		expect(() =>
			module.createEphemeralChannel(bus.createPort("extra-options"), {
				...options(),
				unexpected: true,
			} as { maxMessageBytes: number; maxSequencedKeys: number })
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
	});

	it("reuses identical node channel options and rejects conflicting reopen", async () => {
		const { DRPNode } = await loadNodeModule();
		const node = new DRPNode({ log_config: { level: "silent" } }, { networkNode: nodeNetwork(), reconnect: false });
		const world = new DRPObject({
			acl: createPermissionlessACL("alice"),
			drp: new Grid(),
			id: "world",
			peerId: "alice",
		});
		node.put("world", world);
		const first = node.openEphemeral("world", options());
		expect(node.openEphemeral("world", options())).toBe(first);
		expect(() => node.openEphemeral("world", options({ maxMessageBytes: 1_024 }))).toThrow();
		first.close();
	});

	it("retries reliable local failures but does not retry unreliable publications", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = module.createEphemeralChannel(bus.createPort("alice"), options());
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
