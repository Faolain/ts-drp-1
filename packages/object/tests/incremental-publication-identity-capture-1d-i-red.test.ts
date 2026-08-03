/* eslint-disable @typescript-eslint/no-non-null-assertion -- committed vertices and snapshots are narrowed by positive controls */
import {
	type DRPState,
	DRPStateOtherTheWire,
	DrpType,
	type Hash,
	type IACL,
	type IDRP,
	Operation,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { serializeDRPState, serializeValue } from "@ts-drp/utils/serialization";
import { cloneDeep } from "es-toolkit";
import { deepEqual } from "fast-equals";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { trackMutations } from "../src/proxy.js";
import { DRPObjectStateManager, stateFromDRP } from "../src/state.js";

type SnapshotSide = "acl" | "drp";

interface PublicationRecord {
	publicationId: string;
	kind: "vertex" | "checkpoint";
	mode: "incremental" | "fallback";
	outcome: "published" | "rolled-back";
	targetHash?: Hash;
	baselineHashes: readonly Hash[];
	frontier: readonly Hash[];
	changed: Readonly<Record<SnapshotSide, readonly string[]>>;
}

interface PublicationCopyMetadata {
	publicationId: string;
	side: SnapshotSide;
	key: string;
	image: "pre" | "post";
}

interface CopyObservation extends PublicationCopyMetadata {
	bytes: number;
}

type PublicationObserverEvent =
	| { type: "copy"; value: unknown; metadata: PublicationCopyMetadata }
	| { type: "publication"; record: PublicationRecord };

class PublicationProbe {
	readonly copied: CopyObservation[] = [];
	readonly publications: PublicationRecord[] = [];

	observe(event: PublicationObserverEvent): unknown {
		if (event.type === "copy") {
			this.copied.push({ ...event.metadata, bytes: serializeValue(event.value).byteLength });
			return cloneDeep(event.value);
		}
		this.publications.push({
			...event.record,
			baselineHashes: [...event.record.baselineHashes],
			frontier: [...event.record.frontier],
			changed: { acl: [...event.record.changed.acl], drp: [...event.record.changed.drp] },
		});
	}
}

class IdentityCaptureFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "", localOnly: "excluded" };
	ballast = { bytes: "x".repeat(64 * 1024) };
	nested = { child: { value: 0 } };
	nestedOfNested = { first: { second: { value: 0 } } };
	map = new Map([
		["first", { value: 1 }],
		["second", { value: 2 }],
	]);
	set = new Set(["first", "second"]);
	date = new Date("2025-01-01T00:00:00.000Z");
	orderedObject: Record<string, number> = { first: 1, second: 2 };
	removable?: { value: string } = { value: "present" };
	declare added?: { value: string };
	shared = { value: 0 };
	aliasA = this.shared;
	aliasB = this.shared;
	touches = 0;

	touch(): void {
		this.touches++;
	}

	mutateInitialShared(value: number): void {
		this.shared.value = value;
	}

	mutateEveryShape(): void {
		this.nested.child.value = 9;
		const mapEntries = [...this.map];
		this.map.clear();
		for (const entry of mapEntries.reverse()) this.map.set(...entry);
		const setValues = [...this.set];
		this.set.clear();
		for (const value of setValues.reverse()) this.set.add(value);
		this.date.setUTCFullYear(2030);
		const first = this.orderedObject.first;
		delete this.orderedObject.first;
		this.orderedObject.first = first;
		this.added = { value: "added" };
		delete this.removable;
		this.shared.value = 11;
	}
}

interface Harness {
	rawACL: IACL;
	rawDRP: IdentityCaptureFixture;
	applier: DRPVertexApplier<IdentityCaptureFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<IdentityCaptureFixture>;
}

function harness(configure?: (rawDRP: IdentityCaptureFixture, rawACL: IACL) => void): Harness {
	const rawDRP = new IdentityCaptureFixture();
	const rawACL = createACL({ admins: ["local", "remote"] });
	configure?.(rawDRP, rawACL);
	const hashGraph = new HashGraph("local", rawACL.resolveConflicts?.bind(rawACL), undefined, rawDRP.semanticsType);
	const states = new DRPObjectStateManager(rawACL, rawDRP);
	const probe = new PublicationProbe();
	const options = {
		drp: rawDRP,
		acl: rawACL,
		hashGraph,
		states,
		finalityStore: new FinalityStore(),
		notify: (): void => {},
		publicationObserver: probe.observe.bind(probe),
	};
	const Applier = DRPVertexApplier as unknown as new (
		candidate: typeof options
	) => DRPVertexApplier<IdentityCaptureFixture>;
	return { rawACL, rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

function remoteVertex(opType: string, value: unknown[], timestamp: number): Vertex {
	const operation = Operation.create({ drpType: DrpType.DRP, opType, value });
	const dependencies = [HashGraph.rootHash];
	return {
		hash: computeHash("remote", operation, dependencies, timestamp),
		peerId: "remote",
		dependencies,
		operation,
		timestamp,
		signature: new Uint8Array(),
	};
}

function encodedState(state: DRPState): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(state)).finish();
}

function equalBytes(left: unknown, right: unknown): boolean {
	const leftBytes = serializeValue(left);
	const rightBytes = serializeValue(right);
	return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function byKey(state: DRPState): Map<string, unknown> {
	return new Map(state.state.map(({ key, value }) => [key, value]));
}

function effectiveDelta(before: DRPState, after: DRPState): { keys: string[]; mutatedBytes: number } {
	const beforeByKey = byKey(before);
	const afterByKey = byKey(after);
	const keys: string[] = [];
	let mutatedBytes = 0;
	for (const key of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
		const beforePresent = beforeByKey.has(key);
		const afterPresent = afterByKey.has(key);
		const beforeValue = beforeByKey.get(key);
		const afterValue = afterByKey.get(key);
		if (beforePresent === afterPresent && deepEqual(beforeValue, afterValue) && equalBytes(beforeValue, afterValue)) {
			continue;
		}
		keys.push(key);
		mutatedBytes += Math.max(
			beforePresent ? serializeValue(beforeValue).byteLength : 0,
			afterPresent ? serializeValue(afterValue).byteLength : 0
		);
	}
	return { keys: keys.sort(), mutatedBytes };
}

function vertexFor(h: Harness, opType: string): Vertex {
	const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === opType);
	expect(vertex, `positive control: ${opType} must commit`).toBeDefined();
	return vertex!;
}

function assertExactPublication(
	h: Harness,
	vertex: Vertex,
	rootBytes: Readonly<Record<SnapshotSide, Uint8Array>>,
	expected: Readonly<Record<SnapshotSide, DRPState>>
): void {
	const roots = {
		acl: h.states.getACLState(HashGraph.rootHash)!,
		drp: h.states.getDRPState(HashGraph.rootHash)!,
	};
	const stored = {
		acl: h.states.getACLState(vertex.hash)!,
		drp: h.states.getDRPState(vertex.hash)!,
	};
	const deltas = {
		acl: effectiveDelta(roots.acl, expected.acl),
		drp: effectiveDelta(roots.drp, expected.drp),
	};
	const publication = h.probe.publications.find(
		(candidate) =>
			candidate.kind === "vertex" && candidate.targetHash === vertex.hash && candidate.outcome === "published"
	);
	expect(publication).toMatchObject({ mode: "incremental", baselineHashes: [HashGraph.rootHash] });
	expect(publication?.changed.acl).toEqual(deltas.acl.keys);
	expect(publication?.changed.drp).toEqual(deltas.drp.keys);

	for (const side of ["acl", "drp"] as const) {
		expect(encodedState(stored[side]), `${side} stored bytes must equal the complete capture oracle`).toEqual(
			encodedState(expected[side])
		);
		expect(encodedState(roots[side]), `${side} historical baseline must remain immutable`).toEqual(rootBytes[side]);
		const baselineEntries = new Map(roots[side].state.map((entry) => [entry.key, entry]));
		const changed = new Set(deltas[side].keys);
		for (const entry of stored[side].state) {
			if (changed.has(entry.key)) expect(entry).not.toBe(baselineEntries.get(entry.key));
			else
				expect(entry, `unchanged ${side}.${entry.key} must reuse its owned entry`).toBe(baselineEntries.get(entry.key));
		}
	}

	const [reconstructedDRP, reconstructedACL] = h.states.fromHash(vertex.hash);
	expect(encodedState(stateFromDRP(reconstructedACL))).toEqual(encodedState(expected.acl));
	expect(encodedState(stateFromDRP(reconstructedDRP))).toEqual(encodedState(expected.drp));

	const copies = h.probe.copied.filter(({ publicationId }) => publicationId === publication?.publicationId);
	const expectedCopies = (["acl", "drp"] as const).flatMap((side) => {
		const target = byKey(expected[side]);
		return deltas[side].keys.filter((key) => target.has(key)).map((key) => `${side}:${key}:post`);
	});
	expect(copies.map(({ image, key, side }) => `${side}:${key}:${image}`).sort()).toEqual(expectedCopies.sort());
	const mutatedBytes = deltas.acl.mutatedBytes + deltas.drp.mutatedBytes;
	expect(copies.reduce((total, { bytes }) => total + bytes, 0)).toBeLessThan(20 * mutatedBytes);
	expect(copies.some(({ key }) => key === "removable" && byKey(expected.drp).has(key) === false)).toBe(false);
}

function rootBytes(h: Harness): Record<SnapshotSide, Uint8Array> {
	return {
		acl: encodedState(h.states.getACLState(HashGraph.rootHash)!),
		drp: encodedState(h.states.getDRPState(HashGraph.rootHash)!),
	};
}

function canonicalExpected(
	h: Harness,
	mutate: (drp: IdentityCaptureFixture, acl: IACL) => void
): Readonly<Record<SnapshotSide, DRPState>> {
	const [drp, acl] = h.states.fromHash(HashGraph.rootHash);
	expect(drp, "positive control: root reconstruction includes the DRP").toBeDefined();
	mutate(drp!, acl);
	return { acl: stateFromDRP(acl), drp: stateFromDRP(drp) };
}

describe("Phase 1d(i) raw identity and capture correction", () => {
	it("preserves exact raw public live member identity", () => {
		const h = harness();
		expect(h.applier.drp!.nested).toBe(h.rawDRP.nested);
		expect(h.applier.drp!.nested.child).toBe(h.rawDRP.nested.child);
		expect(h.applier.drp!.nestedOfNested.first.second).toBe(h.rawDRP.nestedOfNested.first.second);
		expect(h.applier.drp!.map).toBe(h.rawDRP.map);
		expect(h.applier.drp!.set).toBe(h.rawDRP.set);
		expect(h.applier.drp!.date).toBe(h.rawDRP.date);
		expect((h.applier.acl as unknown as { _authorizedPeers: Map<string, unknown> })._authorizedPeers).toBe(
			(h.rawACL as unknown as { _authorizedPeers: Map<string, unknown> })._authorizedPeers
		);
	});

	it("charges every pre-existing top-level alias when an operation reads only one owner path", () => {
		const raw = new IdentityCaptureFixture();
		const tracked = trackMutations(raw);

		tracked.proxy.mutateInitialShared(17);

		expect(raw.shared.value).toBe(17);
		expect(raw.aliasA.value).toBe(17);
		expect(raw.aliasB.value).toBe(17);
		expect([...tracked.changedKeys()].sort()).toEqual(["aliasA", "aliasB", "shared"]);
	});

	it("isolates retained raw drift while authored object, Map, Set, Date, add/delete, reorder-only, and aliases publish", () => {
		const h = harness();
		const baseline = h.states.getDRPState(HashGraph.rootHash)!;
		const beforeMap = byKey(baseline).get("map");
		const beforeSet = byKey(baseline).get("set");
		const beforeObject = byKey(baseline).get("orderedObject");
		const roots = rootBytes(h);
		const heldNested = h.rawDRP.nested.child;
		const heldMap = h.rawDRP.map;
		const heldSet = h.rawDRP.set;
		const heldDate = h.rawDRP.date;
		const heldShared = h.rawDRP.shared;

		heldNested.value = 9;
		const mapEntries = [...heldMap];
		heldMap.clear();
		for (const entry of mapEntries.reverse()) heldMap.set(...entry);
		const setValues = [...heldSet];
		heldSet.clear();
		for (const value of setValues.reverse()) heldSet.add(value);
		heldDate.setUTCFullYear(2030);
		const first = h.rawDRP.orderedObject.first;
		delete h.rawDRP.orderedObject.first;
		h.rawDRP.orderedObject.first = first;
		h.rawDRP.added = { value: "added" };
		delete h.rawDRP.removable;
		heldShared.value = 11;

		h.applier.drp!.touch();
		const vertex = vertexFor(h, "touch");
		const expected = canonicalExpected(h, (canonicalDRP) => canonicalDRP.touch());
		expect(effectiveDelta(baseline, expected.drp).keys).toEqual(["touches"]);

		const authored = harness();
		const authoredBaseline = authored.states.getDRPState(HashGraph.rootHash)!;
		const authoredRoots = rootBytes(authored);
		authored.applier.drp!.mutateEveryShape();
		const authoredVertex = vertexFor(authored, "mutateEveryShape");
		const authoredExpected = canonicalExpected(authored, (canonicalDRP) => canonicalDRP.mutateEveryShape());
		expect(deepEqual(beforeMap, byKey(authoredExpected.drp).get("map"))).toBe(true);
		expect(deepEqual(beforeSet, byKey(authoredExpected.drp).get("set"))).toBe(true);
		expect(equalBytes(beforeSet, byKey(authoredExpected.drp).get("set"))).toBe(false);
		expect(deepEqual(beforeObject, byKey(authoredExpected.drp).get("orderedObject"))).toBe(true);
		expect(equalBytes(beforeObject, byKey(authoredExpected.drp).get("orderedObject"))).toBe(false);
		expect(equalBytes(beforeMap, byKey(authoredExpected.drp).get("map"))).toBe(false);
		expect(effectiveDelta(authoredBaseline, authoredExpected.drp).keys).toEqual([
			"added",
			"aliasA",
			"aliasB",
			"date",
			"map",
			"nested",
			"orderedObject",
			"removable",
			"set",
			"shared",
		]);
		assertExactPublication(authored, authoredVertex, authoredRoots, authoredExpected);
		assertExactPublication(h, vertex, roots, expected);
	});
});

describe("Phase 1d(i) cross-side ambient isolation", () => {
	it("does not publish ambient ACL drift when a DRP vertex is the authored trigger", () => {
		const h = harness();
		const roots = rootBytes(h);
		h.rawACL.permissionless = true;

		h.applier.drp!.touch();
		const vertex = vertexFor(h, "touch");
		const expected = canonicalExpected(h, (canonicalDRP) => canonicalDRP.touch());
		expect(effectiveDelta(h.states.getACLState(HashGraph.rootHash)!, expected.acl).keys).toEqual([]);
		expect(effectiveDelta(h.states.getDRPState(HashGraph.rootHash)!, expected.drp).keys).toEqual(["touches"]);
		assertExactPublication(h, vertex, roots, expected);
	});

	it("does not publish ambient DRP drift when an ACL vertex is the authored trigger", () => {
		const h = harness();
		const roots = rootBytes(h);
		h.rawDRP.nested.child.value = 23;

		h.applier.acl.setKey("next-key");
		const vertex = vertexFor(h, "setKey");
		const expected = canonicalExpected(h, (_canonicalDRP, canonicalACL) => {
			canonicalACL.context = { ...canonicalACL.context, caller: "local" };
			canonicalACL.setKey("next-key");
		});
		expect(effectiveDelta(h.states.getACLState(HashGraph.rootHash)!, expected.acl).keys).toEqual(["_authorizedPeers"]);
		expect(effectiveDelta(h.states.getDRPState(HashGraph.rootHash)!, expected.drp).keys).toEqual([]);
		assertExactPublication(h, vertex, roots, expected);
	});
});

describe("Phase 1d(i) live-capture and remote controls", () => {
	it("does not add a second live full capture to either local authored side", () => {
		const reads = { acl: 0, drp: 0 };
		const h = harness((rawDRP, rawACL) => {
			let drpValue = "drp-live";
			let aclValue = "acl-live";
			Object.defineProperty(rawDRP, "instrumentedDRP", {
				enumerable: true,
				configurable: true,
				get: () => {
					reads.drp++;
					return drpValue;
				},
				set: (value: string) => {
					drpValue = value;
				},
			});
			Object.defineProperty(rawACL, "instrumentedACL", {
				enumerable: true,
				configurable: true,
				get: () => {
					reads.acl++;
					return aclValue;
				},
				set: (value: string) => {
					aclValue = value;
				},
			});
		});
		reads.acl = 0;
		reads.drp = 0;

		h.applier.drp!.touch();
		expect(reads).toEqual({ acl: 0, drp: 0 });

		reads.acl = 0;
		reads.drp = 0;
		h.applier.acl.setKey("counted");
		expect(reads).toEqual({ acl: 0, drp: 0 });
	});

	it("keeps linear remote replay independent of ambient live state and local comparison work", async () => {
		const reads = { acl: 0, drp: 0 };
		const h = harness((rawDRP, rawACL) => {
			let drpValue = "root-dpr";
			let aclValue = "root-acl";
			Object.defineProperty(rawDRP, "instrumentedDRP", {
				enumerable: true,
				configurable: true,
				get: () => {
					reads.drp++;
					return drpValue;
				},
				set: (value: string) => {
					drpValue = value;
				},
			});
			Object.defineProperty(rawACL, "instrumentedACL", {
				enumerable: true,
				configurable: true,
				get: () => {
					reads.acl++;
					return aclValue;
				},
				set: (value: string) => {
					aclValue = value;
				},
			});
		});
		(h.rawDRP as unknown as Record<string, unknown>).instrumentedDRP = "ambient-dpr";
		(h.rawACL as unknown as Record<string, unknown>).instrumentedACL = "ambient-acl";
		reads.acl = 0;
		reads.drp = 0;
		const vertex = remoteVertex("touch", [], 1);

		await expect(h.applier.applyVertices([vertex])).resolves.toEqual({ applied: true, missing: [], invalid: [] });
		expect(reads).toEqual({ acl: 0, drp: 0 });
		const rootDRP = byKey(h.states.getDRPState(HashGraph.rootHash)!);
		const rootACL = byKey(h.states.getACLState(HashGraph.rootHash)!);
		const storedDRP = byKey(h.states.getDRPState(vertex.hash)!);
		const storedACL = byKey(h.states.getACLState(vertex.hash)!);
		expect(storedDRP.get("instrumentedDRP")).toBe(rootDRP.get("instrumentedDRP"));
		expect(storedACL.get("instrumentedACL")).toBe(rootACL.get("instrumentedACL"));
		const publication = h.probe.publications.find(({ targetHash }) => targetHash === vertex.hash);
		expect(publication?.changed).toEqual({ acl: [], drp: ["touches"] });
		expect(h.probe.copied.filter(({ publicationId }) => publicationId === publication?.publicationId)).toHaveLength(1);
	});
});

describe("Phase 1d(i) ambient rollback lifecycle", () => {
	it("keeps ambient drift out of a rolled-back attempt and the exactly-once successful retry", () => {
		const h = harness();
		const roots = rootBytes(h);
		h.rawDRP.nested.child.value = 41;
		const originalAddVertex = h.hashGraph.addVertex.bind(h.hashGraph);
		h.hashGraph.addVertex = (): void => {
			throw new Error("controlled local commit failure");
		};
		expect(() => h.applier.drp!.touch()).toThrow("controlled local commit failure");
		h.hashGraph.addVertex = originalAddVertex;

		expect(h.hashGraph.getAllVertices()).toHaveLength(1);
		expect(h.states.getDRPState(vertexForRootFailureCandidate(h))).toBeUndefined();
		expect(h.probe.publications.length).toBeGreaterThan(0);
		expect(h.probe.publications.every(({ outcome }) => outcome === "rolled-back")).toBe(true);
		expect(encodedState(h.states.getDRPState(HashGraph.rootHash)!)).toEqual(roots.drp);

		h.applier.drp!.touch();
		const vertex = vertexFor(h, "touch");
		const expected = canonicalExpected(h, (canonicalDRP) => canonicalDRP.touch());
		assertExactPublication(h, vertex, roots, expected);
		const successfulPublications = h.probe.publications.filter(
			({ outcome, targetHash }) => outcome === "published" && targetHash === vertex.hash
		);
		expect(successfulPublications).toHaveLength(1);
		const successful = successfulPublications[0];
		const successfulCopies = h.probe.copied.filter(({ publicationId }) => publicationId === successful?.publicationId);
		expect(successfulCopies.filter(({ side, key }) => side === "drp" && key === "nested")).toEqual([]);
		expect(successfulCopies.filter(({ side, key }) => side === "drp" && key === "touches")).toHaveLength(1);
	});
});

function vertexForRootFailureCandidate(h: Harness): Hash {
	const rolledBack = h.probe.publications.find(({ outcome }) => outcome === "rolled-back");
	expect(rolledBack?.targetHash).toBeDefined();
	return rolledBack!.targetHash!;
}
