/* eslint-disable @typescript-eslint/no-non-null-assertion -- causal fixtures positively narrow committed state */
import {
	ActionType,
	DRPState,
	DRPStateEntry,
	DRPStateOtherTheWire,
	DrpType,
	type Hash,
	type IDRP,
	Operation,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { serializeDRPState } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { type PublicationObserverEvent, type PublicationRecord } from "../src/publication/publisher.js";
import { detachReplicaLocalContext, detachStatePayload } from "../src/state-payload.js";
import { DRPObjectStateManager, stateFromDRP } from "../src/state.js";

const ADMINS = ["local", "remote"];
const AMBIENT_KEY = "phase1diiAmbientSetter";

interface Meter {
	reads: number;
	readSites?: string[];
}

let activeCopySite: string | undefined;

interface ApplicationSetterEvent {
	receiver: unknown;
	value: string;
}

const applicationSetterEvents: ApplicationSetterEvent[] = [];

interface ApplicationObjectValue {
	left: { marker: string };
	right: { marker: string };
	aliases: Array<{ marker: string }>;
}

interface ApplicationObjectSetterEvent {
	receiver: unknown;
	value: ApplicationObjectValue;
}

const applicationObjectSetterEvents: ApplicationObjectSetterEvent[] = [];

function ownData(target: object, key: PropertyKey, value: unknown): void {
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function meteredBallast(meter: Meter, marker = "stable"): { payload: string } {
	return new Proxy(
		{ payload: `${marker}:${"x".repeat(16 * 1024)}` },
		{
			get(target, key, receiver): unknown {
				if (key === "payload") {
					meter.reads++;
					meter.readSites?.push(activeCopySite ?? "unattributed");
				}
				return Reflect.get(target, key, receiver);
			},
		}
	);
}

class ReconstructionFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	ballast: { payload: string };
	revision = "root";
	ordered = "constructor";
	_applicationValue = "before";

	constructor(ballast: { payload: string } = { payload: "stable" }) {
		this.ballast = ballast;
	}

	get applicationValue(): string {
		return this._applicationValue;
	}

	set applicationValue(value: string) {
		applicationSetterEvents.push({ receiver: this, value });
		this._applicationValue = value;
	}

	touch(revision: string): void {
		this.revision = revision;
	}

	installReservedPrototype(value: unknown): void {
		ownData(this, "__proto__", value);
	}

	installAmbient(value: unknown): void {
		ownData(this, AMBIENT_KEY, value);
	}

	installApplicationValue(value: string): void {
		ownData(this, "applicationValue", value);
	}
}

class ApplicationObjectReconstructionFixture extends ReconstructionFixture {
	_applicationObject: ApplicationObjectValue;

	constructor() {
		super();
		const shared = { marker: "root" };
		this._applicationObject = { left: shared, right: shared, aliases: [shared] };
	}

	get applicationObject(): ApplicationObjectValue {
		return this._applicationObject;
	}

	set applicationObject(value: ApplicationObjectValue) {
		applicationObjectSetterEvents.push({ receiver: this, value });
		this._applicationObject = value;
	}

	installApplicationObject(marker: string): void {
		const shared = { marker };
		ownData(this, "applicationObject", { left: shared, right: shared, aliases: [shared] });
	}
}

class ConflictReconstructionFixture extends ReconstructionFixture {
	resolveConflicts(_vertices: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

interface CopyEvent {
	publicationId: string;
	side: "acl" | "drp";
	key: string;
	image: "pre" | "post";
}

class PublicationProbe {
	readonly copies: CopyEvent[] = [];
	readonly publications: PublicationRecord[] = [];

	observe(event: PublicationObserverEvent): unknown {
		if (event.type === "copy") {
			this.copies.push({ ...event.metadata });
			const previousCopySite = activeCopySite;
			const { publicationId, side, key, image } = event.metadata;
			activeCopySite = `${publicationId}:${side}:${key}:${image}`;
			try {
				return detachStatePayload(event.value);
			} finally {
				activeCopySite = previousCopySite;
			}
		}
		this.publications.push({
			...event.record,
			baselineHashes: [...event.record.baselineHashes],
			frontier: [...event.record.frontier],
			changed: { acl: [...event.record.changed.acl], drp: [...event.record.changed.drp] },
			work: event.record.work ? { acl: { ...event.record.work.acl }, drp: { ...event.record.work.drp } } : undefined,
		});
	}
}

interface Harness<T extends ReconstructionFixture = ReconstructionFixture> {
	acl: ReturnType<typeof createACL>;
	applier: DRPVertexApplier<T>;
	drp: T;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<T>;
}

function harness<T extends ReconstructionFixture>(drp: T, suffixSize?: number): Harness<T> {
	if (suffixSize !== undefined) process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = String(suffixSize);
	const acl = createACL({ admins: ADMINS });
	const hashGraph = new HashGraph(
		"local",
		acl.resolveConflicts?.bind(acl),
		(drp as IDRP).resolveConflicts?.bind(drp),
		drp.semanticsType
	);
	const states = new DRPObjectStateManager(acl, drp);
	const probe = new PublicationProbe();
	const options = {
		drp,
		acl,
		hashGraph,
		states,
		finalityStore: new FinalityStore(),
		notify: (): void => {},
		publicationObserver: probe.observe.bind(probe),
	};
	const Applier = DRPVertexApplier as unknown as new (candidate: typeof options) => DRPVertexApplier<T>;
	return { acl, applier: new Applier(options), drp, hashGraph, probe, states };
}

function remoteVertex(opType: string, value: unknown[], dependencies: Hash[], timestamp: number): Vertex {
	const operation = Operation.create({ drpType: DrpType.DRP, opType, value });
	return {
		hash: computeHash("remote", operation, dependencies, timestamp),
		peerId: "remote",
		dependencies,
		operation,
		timestamp,
		signature: new Uint8Array(),
	};
}

function snapshot(entries: Array<readonly [unknown, unknown]>): DRPState {
	return DRPState.create({
		state: entries.map(([key, value]) => DRPStateEntry.create({ key: key as string, value })),
	});
}

function snapshotBytes(state: DRPState): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(state)).finish();
}

function storedValue<T>(states: DRPObjectStateManager<ReconstructionFixture>, hash: Hash, key: string): T {
	const value = states.getDRPState(hash)?.state.find((entry) => entry.key === key)?.value;
	return value as T;
}

function publicationFor(probe: PublicationProbe, hash: Hash): PublicationRecord {
	const record = probe.publications.find(
		(candidate) => candidate.kind === "vertex" && candidate.targetHash === hash && candidate.outcome === "published"
	);
	expect(record, `positive control: ${hash} must publish`).toBeDefined();
	return record!;
}

function expectIncrementalScalarPublication(probe: PublicationProbe, hash: Hash): void {
	const record = publicationFor(probe, hash);
	expect.soft(record).toMatchObject({
		mode: "incremental",
		changed: { acl: [], drp: ["revision"] },
		work: {
			acl: { egressWidenings: 0, comparedKeys: 0, comparisonPasses: 0 },
			drp: { egressWidenings: 0, comparedKeys: 0, comparisonPasses: 0 },
		},
	});
	expect
		.soft(
			probe.copies
				.filter(({ publicationId }) => publicationId === record.publicationId)
				.map(({ side, key, image }) => `${side}:${key}:${image}`)
		)
		.toEqual(["drp:revision:post"]);
}

describe("Phase 1d(ii) reconstruction own-data and prototype safety RED", () => {
	it("keeps ordinary duplicate order, own data, wire input, and alias isolation as a passing control", () => {
		const manager = new DRPObjectStateManager(createACL({ admins: ADMINS }), new ReconstructionFixture());
		const raw = snapshot([
			["ordered", "first"],
			["nested", { value: 1 }],
			["ordered", "last"],
		]);
		const beforeWire = snapshotBytes(raw);
		const [reconstructed] = manager.fromStates(raw, manager.getACLState(HashGraph.rootHash)!);
		const result = reconstructed! as ReconstructionFixture & { nested: { value: number } };

		expect(result.ordered).toBe("last");
		expect(Reflect.getOwnPropertyDescriptor(result, "ordered")).toMatchObject({
			enumerable: true,
			value: "last",
			writable: true,
		});
		expect(Reflect.getPrototypeOf(result)).toBe(ReconstructionFixture.prototype);
		result.nested.value = 2;
		expect((raw.state[1].value as { value: number }).value).toBe(1);
		expect(snapshotBytes(raw)).toEqual(beforeWire);
	});

	it("materializes ordered duplicate and __proto__ entries as detached own data without changing any prototype", () => {
		const sibling = new ReconstructionFixture();
		const manager = new DRPObjectStateManager(createACL({ admins: ADMINS }), sibling);
		const attackerPrototype = { inheritedAttack: "top" };
		const nestedAttackerPrototype = { inheritedAttack: "nested" };
		const nested = { retained: { value: 1 } };
		ownData(nested, "__proto__", nestedAttackerPrototype);
		const raw = snapshot([
			["ordered", "first"],
			["__proto__", attackerPrototype],
			["ordered", "last"],
			["nested", nested],
		]);
		const beforeWire = snapshotBytes(raw);
		const objectPrototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
		const fixturePrototypeBefore = Object.getOwnPropertyDescriptors(ReconstructionFixture.prototype);
		const [reconstructed] = manager.fromStates(raw, manager.getACLState(HashGraph.rootHash)!);
		const result = reconstructed! as ReconstructionFixture & {
			__proto__: { inheritedAttack: string };
			nested: typeof nested;
		};

		expect.soft(Reflect.getPrototypeOf(result)).toBe(ReconstructionFixture.prototype);
		expect.soft(Reflect.getPrototypeOf(result.nested)).toBe(Object.prototype);
		expect.soft(Reflect.getOwnPropertyDescriptor(result, "__proto__")).toMatchObject({
			configurable: true,
			enumerable: true,
			value: expect.objectContaining({ inheritedAttack: "top" }),
			writable: true,
		});
		expect.soft(Reflect.getOwnPropertyDescriptor(result.nested, "__proto__")).toMatchObject({
			configurable: true,
			enumerable: true,
			value: expect.objectContaining({ inheritedAttack: "nested" }),
			writable: true,
		});
		expect.soft(result.ordered, "duplicate keys retain ordered last-write-wins semantics").toBe("last");
		expect.soft(snapshotBytes(raw), "reconstruction cannot mutate caller-owned wire input").toEqual(beforeWire);
		expect.soft(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(objectPrototypeBefore);
		expect.soft(Object.getOwnPropertyDescriptors(ReconstructionFixture.prototype)).toEqual(fixturePrototypeBefore);
		expect.soft(Reflect.getPrototypeOf(sibling)).toBe(ReconstructionFixture.prototype);

		result.nested.retained.value = 2;
		const canonical = stateFromDRP(result);
		expect.soft(canonical.state.map(({ key }) => key)).toEqual(["ordered", "__proto__", "nested"]);
		expect.soft(canonical.state.find(({ key }) => key === "ordered")?.value).toBe("last");
		expect
			.soft((raw.state[3].value as typeof nested).retained.value, "live reconstruction must not alias its snapshot")
			.toBe(1);
	});

	it("rejects every non-primitive-string direct-call key before coercion or partial materialization", () => {
		const manager = new DRPObjectStateManager(createACL({ admins: ADMINS }), new ReconstructionFixture());
		let coercions = 0;
		const hostile = {
			[Symbol.toPrimitive](): string {
				coercions++;
				return "__proto__";
			},
		};
		const cases: unknown[] = [7, Symbol("phase-1d-ii-key"), hostile];
		for (const key of cases) {
			const state = snapshot([
				["stable", "before"],
				[key, { attacker: true }],
			]);
			let caught: unknown;
			try {
				manager.fromStates(state, manager.getACLState(HashGraph.rootHash)!);
			} catch (error) {
				caught = error;
			}
			expect.soft(caught, `runtime key ${typeof key} must reject`).toBeInstanceOf(TypeError);
		}
		expect.soft(coercions, "hostile key coercion must never execute").toBe(0);
		expect.soft(Reflect.getPrototypeOf(manager.fromHash(HashGraph.rootHash)[0]!)).toBe(ReconstructionFixture.prototype);
	});

	it("uses the same own-data rule in governed and replica-local nested detachment", () => {
		const attackerPrototype = { inheritedAttack: true };
		const symbol = Symbol("detachment-control");
		const source = { retained: { value: 1 } } as Record<PropertyKey, unknown>;
		ownData(source, "__proto__", attackerPrototype);
		ownData(source, symbol, { symbolValue: 1 });
		for (const [domain, detach] of [
			["governed", detachStatePayload],
			["replica-local", detachReplicaLocalContext],
		] as const) {
			const copy = detach(source) as typeof source;
			expect.soft(Reflect.getPrototypeOf(copy), `${domain} clone prototype`).toBe(Object.prototype);
			expect.soft(Reflect.getOwnPropertyDescriptor(copy, "__proto__"), `${domain} reserved own data`).toMatchObject({
				enumerable: true,
				value: expect.objectContaining({ inheritedAttack: true }),
			});
			expect.soft(copy.__proto__).not.toBe(attackerPrototype);
			expect.soft(copy[symbol], `${domain} existing symbol detachment firewall`).toEqual({ symbolValue: 1 });
			expect.soft(copy[symbol]).not.toBe(source[symbol]);
		}
	});

	it("keeps __proto__ inert on the real dependent-hint clone path", async () => {
		const h = harness(new ReconstructionFixture());
		const source = new ReconstructionFixture();
		const attackerPrototype = {
			touch(): never {
				throw new Error("attacker prototype executed");
			},
		};
		ownData(source, "__proto__", attackerPrototype);
		const pending = remoteVertex("touch", ["hint-tail"], ["causal-head"], 20);
		const internals = h.applier as unknown as {
			prepareHintedAdoption(
				operation: object,
				expectedFrontier: Hash[],
				hint: object
			): Promise<{ drp?: ReconstructionFixture }>;
		};
		const adoption = await internals.prepareHintedAdoption(
			{ vertex: pending, isACL: false },
			["left-head", "causal-head"],
			{
				expectedFrontier: ["left-head", "causal-head"],
				causalHead: "causal-head",
				drpType: DrpType.DRP,
				replayRequiresConflictResolution: false,
				canonicalDRP: source,
				canonicalACL: h.acl,
			}
		);
		const clone = adoption.drp! as ReconstructionFixture & { __proto__: unknown };
		expect.soft(clone.revision).toBe("hint-tail");
		expect.soft(Reflect.getPrototypeOf(clone)).toBe(ReconstructionFixture.prototype);
		expect.soft(Object.hasOwn(clone, "__proto__")).toBe(true);
		expect.soft(clone.__proto__).not.toBe(attackerPrototype);
		expect.soft(Reflect.getPrototypeOf(source)).toBe(ReconstructionFixture.prototype);
	});
});

describe("Phase 1d(ii) COW/reconstruction work and live adoption RED", () => {
	it("removes the local live-capture round trip while retaining exact 1d(i) publication accounting", () => {
		const meter = { reads: 0 };
		const h = harness(new ReconstructionFixture(meteredBallast(meter)));
		expect(meter.reads, "positive control: root snapshot capture must cross the ballast read meter").toBeGreaterThan(0);
		meter.reads = 0;
		const rootBallast = storedValue<{ payload: string }>(h.states, HashGraph.rootHash, "ballast");

		h.applier.drp!.touch("local-small-change");
		const vertex = h.hashGraph
			.getAllVertices()
			.find(
				(candidate) => candidate.operation?.opType === "touch" && candidate.operation.value[0] === "local-small-change"
			)!;

		expect.soft(meter.reads, "unchanged 16 KiB ballast must not be copied during local staging").toBe(0);
		expectIncrementalScalarPublication(h.probe, vertex.hash);
		expect.soft(storedValue(h.states, vertex.hash, "ballast")).toBe(rootBallast);
		expect.soft(h.drp.ballast).not.toBe(rootBallast);
		expect.soft(snapshotBytes(h.states.getDRPState(vertex.hash)!)).toEqual(snapshotBytes(stateFromDRP(h.drp)));
	});

	it("keeps remote suffix/tail/checkpoint reconstruction proportional to changed payload without live/snapshot aliases", async () => {
		const previousSuffix = process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
		const meter: Meter = { reads: 0 };
		try {
			const h = harness(new ReconstructionFixture({ payload: "stable:" + "x".repeat(16 * 1024) }), 1);
			const rootEntry = h.states.getDRPState(HashGraph.rootHash)!.state.find(({ key }) => key === "ballast")!;
			const ownedBallast = meteredBallast(meter);
			void ownedBallast.payload;
			expect(meter.reads, "positive control: the injected owned-snapshot meter must be live").toBe(1);
			rootEntry.value = ownedBallast;
			meter.reads = 0;
			meter.readSites = [];
			const left = remoteVertex("touch", ["left"], [HashGraph.rootHash], 30);
			const right = remoteVertex("touch", ["right"], [HashGraph.rootHash], 31);
			const tail = remoteVertex("touch", ["tail"], [right.hash], 32);
			const join = remoteVertex("touch", ["joined"], [left.hash, tail.hash], 33);

			await expect(h.applier.applyVertices([left, right, tail, join])).resolves.toEqual({
				applied: true,
				invalid: [],
				missing: [],
			});

			const successfulMultiFrontierCheckpointIds = new Set(
				h.probe.publications
					.filter(
						({ kind, outcome, fallbackReason }) =>
							kind === "checkpoint" && outcome === "published" && fallbackReason === "multi-frontier-checkpoint"
					)
					.map(({ publicationId }) => publicationId)
			);
			const expectedReadSites = h.probe.copies
				.filter(
					({ publicationId, side, key, image }) =>
						successfulMultiFrontierCheckpointIds.has(publicationId) &&
						side === "drp" &&
						key === "ballast" &&
						image === "post"
				)
				.map(({ publicationId, side, key, image }) => `${publicationId}:${side}:${key}:${image}`);
			expect
				.soft(expectedReadSites, "positive control: canonical checkpoint ballast copies are observed")
				.not.toHaveLength(0);
			expect
				.soft(meter.reads, "only canonical multi-frontier checkpoint copies read owned unchanged ballast")
				.toBe(expectedReadSites.length);
			expect
				.soft(meter.readSites, "every owned unchanged ballast read is exactly attributed")
				.toEqual(expectedReadSites);
			expect.soft(h.drp.revision).toBe("joined");
			expect.soft(h.drp.ballast).not.toBe(rootEntry.value);
			expect.soft(h.probe.publications.some(({ fallbackReason }) => fallbackReason === "concurrent-tail")).toBe(true);
			expect.soft(h.probe.publications.some(({ kind }) => kind === "checkpoint")).toBe(true);
			for (const vertex of [left, right, tail, join]) {
				const stored = h.states.getDRPState(vertex.hash);
				expect.soft(stored, `stored state for ${vertex.hash}`).toBeDefined();
				expect
					.soft(snapshotBytes(stored!), `wire truth for ${vertex.hash}`)
					.toEqual(snapshotBytes(stateFromDRP(h.states.fromHash(vertex.hash)[0]!)));
			}
		} finally {
			if (previousSuffix === undefined) delete process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
			else process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = previousSuffix;
		}
	});

	it("materializes live __proto__ and ambient inherited-setter keys as own data on local, remote, and conflict adoption", async () => {
		const previousAmbient = Reflect.getOwnPropertyDescriptor(Object.prototype, AMBIENT_KEY);
		let ambientCalls = 0;
		Object.defineProperty(Object.prototype, AMBIENT_KEY, {
			configurable: true,
			set(): void {
				ambientCalls++;
			},
		});
		try {
			const local = harness(new ReconstructionFixture());
			const localPrototype = Reflect.getPrototypeOf(local.drp);
			const localAttack = { inheritedAttack: "local" };
			local.applier.drp!.installAmbient("local-ambient");
			local.applier.drp!.installReservedPrototype(localAttack);
			expect.soft(Reflect.getPrototypeOf(local.drp)).toBe(localPrototype);
			expect.soft(Reflect.getOwnPropertyDescriptor(local.drp, "__proto__")?.value).toEqual(localAttack);
			expect.soft(Reflect.getOwnPropertyDescriptor(local.drp, AMBIENT_KEY)?.value).toBe("local-ambient");

			const remote = harness(new ConflictReconstructionFixture());
			const sibling = new ConflictReconstructionFixture();
			const remotePrototype = Reflect.getPrototypeOf(remote.drp);
			const reserved = remoteVertex(
				"installReservedPrototype",
				[{ inheritedAttack: "remote" }],
				[HashGraph.rootHash],
				40
			);
			const ambient = remoteVertex("installAmbient", ["remote-ambient"], [HashGraph.rootHash], 41);
			await expect(remote.applier.applyVertices([reserved, ambient])).resolves.toEqual({
				applied: true,
				invalid: [],
				missing: [],
			});
			expect.soft(Reflect.getPrototypeOf(remote.drp)).toBe(remotePrototype);
			expect.soft(Object.hasOwn(remote.drp, "__proto__")).toBe(true);
			expect.soft(Reflect.getOwnPropertyDescriptor(remote.drp, AMBIENT_KEY)?.value).toBe("remote-ambient");
			expect.soft(ambientCalls).toBe(0);
			expect.soft(Reflect.getPrototypeOf(sibling)).toBe(ConflictReconstructionFixture.prototype);
			expect.soft(Reflect.getPrototypeOf(Object.prototype)).toBeNull();
			const stored = remote.states.getDRPState(ambient.hash)!;
			expect.soft(snapshotBytes(stored)).toEqual(snapshotBytes(stateFromDRP(remote.drp)));
		} finally {
			if (previousAmbient) Reflect.defineProperty(Object.prototype, AMBIENT_KEY, previousAmbient);
			else Reflect.deleteProperty(Object.prototype, AMBIENT_KEY);
		}
	});

	it("proves the copy meter and intentional application-accessor receiver as passing controls", async () => {
		const meter = { reads: 0 };
		const ballast = meteredBallast(meter, "control");
		const copied = detachStatePayload(ballast);
		expect(meter.reads).toBe(1);
		expect(copied).toEqual(ballast);
		expect(copied).not.toBe(ballast);

		applicationSetterEvents.length = 0;
		const h = harness(new ReconstructionFixture());
		const pending = remoteVertex("installApplicationValue", ["control-after"], [HashGraph.rootHash], 49);
		await expect(h.applier.applyVertices([pending])).resolves.toEqual({ applied: true, invalid: [], missing: [] });
		expect(applicationSetterEvents).toEqual([{ receiver: h.applier.drp, value: "control-after" }]);
		expect(h.drp._applicationValue).toBe("control-after");
		expect(Object.hasOwn(h.drp, "applicationValue")).toBe(false);
	});

	it("detaches a checkpoint-borrowed application-setter value before local multi-frontier adoption", async () => {
		const previousSuffix = process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
		try {
			process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = "1";
			applicationObjectSetterEvents.length = 0;
			const h = harness(new ApplicationObjectReconstructionFixture());
			const checkpoints = (): Array<{
				frontier: Hash[];
				state: { drpState: DRPState };
			}> =>
				(
					h.applier as unknown as {
						checkpoints: Array<{ frontier: Hash[]; state: { drpState: DRPState } }>;
					}
				).checkpoints;
			const frontierId = (frontier: readonly Hash[]): string => [...frontier].sort().join(",");
			const ownedApplicationObjects = (): Array<{
				label: string;
				state: DRPState;
				value: ApplicationObjectValue;
			}> => {
				const owned: Array<{ label: string; state: DRPState; value: ApplicationObjectValue }> = [];
				const hashes = new Set<Hash>([HashGraph.rootHash, ...h.hashGraph.getAllVertices().map(({ hash }) => hash)]);
				for (const hash of hashes) {
					const state = h.states.getDRPState(hash);
					const value = state?.state.find(({ key }) => key === "applicationObject")?.value;
					if (state && value) {
						owned.push({ label: `vertex:${hash}`, state, value: value as ApplicationObjectValue });
					}
				}
				for (const checkpoint of checkpoints()) {
					const value = checkpoint.state.drpState.state.find(({ key }) => key === "applicationObject")?.value;
					if (value) {
						owned.push({
							label: `checkpoint:${frontierId(checkpoint.frontier)}`,
							state: checkpoint.state.drpState,
							value: value as ApplicationObjectValue,
						});
					}
				}
				return owned;
			};

			const install = remoteVertex("installApplicationObject", ["installed"], [HashGraph.rootHash], 60);
			await expect(h.applier.applyVertices([install])).resolves.toEqual({
				applied: true,
				invalid: [],
				missing: [],
			});
			const left = remoteVertex("touch", ["left"], [install.hash], 61);
			const right = remoteVertex("touch", ["right"], [install.hash], 62);
			await expect(h.applier.applyVertices([left, right])).resolves.toEqual({
				applied: true,
				invalid: [],
				missing: [],
			});
			const concurrentFrontier = h.hashGraph.getFrontier();
			expect.soft(concurrentFrontier).toHaveLength(2);
			expect.soft(new Set(concurrentFrontier)).toEqual(new Set([left.hash, right.hash]));
			expect
				.soft(
					checkpoints().some(
						({ frontier, state }) =>
							frontierId(frontier) === frontierId(concurrentFrontier) &&
							state.drpState.state.some(({ key }) => key === "applicationObject")
					),
					"positive control: concurrent remote heads produced the canonical multi-frontier checkpoint"
				)
				.toBe(true);

			applicationObjectSetterEvents.length = 0;
			const verticesBeforeLocal = new Set(h.hashGraph.getAllVertices().map(({ hash }) => hash));
			h.applier.drp!.touch("local-on-multi-frontier");
			const localVertex = h.hashGraph.getAllVertices().find(({ hash }) => !verticesBeforeLocal.has(hash));
			expect(localVertex, "positive control: local authoring must commit a new vertex").toBeDefined();
			expect.soft(localVertex!.dependencies).toEqual(concurrentFrontier);
			expect.soft(applicationObjectSetterEvents).toHaveLength(1);

			const event = applicationObjectSetterEvents[0]!;
			const setterValue = event.value;
			const owned = ownedApplicationObjects();
			const retainedMultiFrontierCheckpoints = owned.filter(
				({ label }) => label === `checkpoint:${frontierId(concurrentFrontier)}`
			);
			expect
				.soft(retainedMultiFrontierCheckpoints.length, "positive control: source checkpoint remains retained")
				.toBeGreaterThan(0);
			expect.soft(event.receiver, "the qualified setter keeps the tracked application receiver").toBe(h.applier.drp);
			expect
				.soft(h.drp._applicationObject, "the setter installs its input as application-owned live state")
				.toBe(setterValue);
			expect.soft(setterValue.left).toBe(setterValue.right);
			expect.soft(setterValue.left).toBe(setterValue.aliases[0]);

			const borrowedAliases = owned.filter(({ value }) => value === setterValue).map(({ label }) => label);
			expect
				.soft(borrowedAliases, "setter input must be detached from every retained vertex/checkpoint value")
				.toEqual([]);

			const ownedBytesBeforeMutation = new Map(owned.map(({ state }) => [state, snapshotBytes(state)]));
			setterValue.left.marker = "mutated-through-live-setter";
			expect.soft(h.drp._applicationObject.right.marker).toBe("mutated-through-live-setter");
			for (const { label, state } of owned) {
				expect
					.soft(snapshotBytes(state), `live setter mutation cannot alter ${label}`)
					.toEqual(ownedBytesBeforeMutation.get(state));
			}
		} finally {
			applicationObjectSetterEvents.length = 0;
			if (previousSuffix === undefined) delete process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
			else process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = previousSuffix;
		}
	});

	it("qualifies only an intentional application accessor at live replacement and rolls it back atomically", async () => {
		applicationSetterEvents.length = 0;
		const h = harness(new ReconstructionFixture());
		const pending = remoteVertex("installApplicationValue", ["after"], [HashGraph.rootHash], 50);
		const internals = h.applier as unknown as {
			advanceCheckpointIfNeeded(...args: unknown[]): void;
		};
		const originalAdvance = internals.advanceCheckpointIfNeeded;
		internals.advanceCheckpointIfNeeded = (): void => {
			throw new Error("phase-1d-ii forced post-adoption rollback");
		};
		try {
			await expect(h.applier.applyVertices([pending])).resolves.toEqual({
				applied: false,
				invalid: [],
				missing: [],
				quarantined: [pending.hash],
			});
		} finally {
			internals.advanceCheckpointIfNeeded = originalAdvance;
		}

		expect.soft(applicationSetterEvents.length).toBeGreaterThan(0);
		expect.soft(applicationSetterEvents.every(({ receiver }) => receiver === h.applier.drp)).toBe(true);
		expect.soft(applicationSetterEvents.every(({ value }) => value === "after")).toBe(true);
		expect.soft(h.drp._applicationValue).toBe("before");
		expect.soft(Object.hasOwn(h.drp, "applicationValue")).toBe(false);
		expect.soft(Reflect.getPrototypeOf(h.drp)).toBe(ReconstructionFixture.prototype);
		expect.soft(h.hashGraph.vertices.has(pending.hash)).toBe(false);
		expect.soft(h.states.getDRPState(pending.hash)).toBeUndefined();
		expect
			.soft(
				h.probe.publications
					.filter(({ targetHash }) => targetHash === pending.hash)
					.every(({ outcome }) => outcome === "rolled-back")
			)
			.toBe(true);
	});
});
