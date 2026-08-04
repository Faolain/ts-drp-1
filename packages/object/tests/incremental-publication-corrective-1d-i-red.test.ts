/* eslint-disable import/order -- auth mock must register before object imports */
import { trustedTestVertices } from "./helpers/trusted-vertex-ingest.js";

/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow committed vertices and snapshots */
import {
	DRPState,
	DRPStateEntry,
	DRPStateOtherTheWire,
	DrpType,
	type Hash,
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

class CorrectiveFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "", localOnly: "excluded" };
	ballast = { bytes: "x".repeat(64 * 1024) };
	a = { nested: { value: 0 } };
	b = { nested: { value: -1 } };
	orderedMap = new Map([
		["first", 1],
		["second", 2],
	]);
	orderedSet = new Set(["first", "second"]);
	orderedObject: Record<string, number> = { first: 1, second: 2 };
	ambientNested = { value: 0 };
	ambientPrimitive = "before";
	removable?: { value: string } = { value: "present" };
	declare ambientAdded?: { value: string };
	touched = 0;

	aliasAndMutate(value: number): void {
		this.b = this.a;
		const held = this.a.nested;
		void this.b.nested;
		held.value = value;
	}

	reorderMap(): void {
		const entries = [...this.orderedMap];
		this.orderedMap.clear();
		for (const entry of entries.reverse()) this.orderedMap.set(...entry);
	}

	reorderSet(): void {
		const values = [...this.orderedSet];
		this.orderedSet.clear();
		for (const value of values.reverse()) this.orderedSet.add(value);
	}

	reorderObject(): void {
		const first = this.orderedObject.first;
		delete this.orderedObject.first;
		this.orderedObject.first = first;
	}

	touch(): void {
		this.touched++;
	}

	mutateHeldReplacementAdditionDeletion(): void {
		const held = this.ambientNested;
		held.value = 9;
		this.ambientPrimitive = "authored";
		this.ambientAdded = { value: "added" };
		delete this.removable;
	}
}

interface Harness {
	applier: DRPVertexApplier<CorrectiveFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<CorrectiveFixture>;
}

function harness(): Harness {
	const drp = new CorrectiveFixture();
	const acl = createACL({ admins: ["local", "remote"] });
	const hashGraph = new HashGraph("local", acl.resolveConflicts?.bind(acl), undefined, drp.semanticsType);
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
	const Applier = DRPVertexApplier as unknown as new (candidate: typeof options) => DRPVertexApplier<CorrectiveFixture>;
	return { applier: new Applier(options), hashGraph, probe, states };
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

function encodedState(value: DRPState): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(value)).finish();
}

function equalBytes(left: unknown, right: unknown): boolean {
	const leftBytes = serializeValue(left);
	const rightBytes = serializeValue(right);
	return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function byKey(value: DRPState): Map<string, unknown> {
	return new Map(value.state.map((entry) => [entry.key, entry.value]));
}

function effectiveDelta(before: DRPState, after: DRPState): { keys: string[]; mutatedBytes: number } {
	const beforeByKey = byKey(before);
	const afterByKey = byKey(after);
	const changed: string[] = [];
	let mutatedBytes = 0;
	for (const key of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
		const beforePresent = beforeByKey.has(key);
		const afterPresent = afterByKey.has(key);
		if (
			beforePresent === afterPresent &&
			deepEqual(beforeByKey.get(key), afterByKey.get(key)) &&
			equalBytes(beforeByKey.get(key), afterByKey.get(key))
		) {
			continue;
		}
		changed.push(key);
		mutatedBytes += Math.max(
			beforePresent ? serializeValue(beforeByKey.get(key)).byteLength : 0,
			afterPresent ? serializeValue(afterByKey.get(key)).byteLength : 0
		);
	}
	return { keys: changed.sort(), mutatedBytes };
}

function effectiveKeys(before: DRPState, after: DRPState): string[] {
	return effectiveDelta(before, after).keys;
}

function vertexFor(h: Harness, opType: string): Vertex {
	const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === opType);
	expect(vertex, `positive control: ${opType} must commit a vertex`).toBeDefined();
	return vertex!;
}

function assertExactIncrementalDRPPublication(
	h: Harness,
	vertex: Vertex,
	baselineBytes: Uint8Array,
	expected: DRPState
): void {
	const baseline = h.states.getDRPState(HashGraph.rootHash)!;
	const stored = h.states.getDRPState(vertex.hash)!;
	const delta = effectiveDelta(baseline, expected);
	const expectedKeys = delta.keys;
	const publication = h.probe.publications.find(
		(candidate) => candidate.kind === "vertex" && candidate.targetHash === vertex.hash
	);
	expect(publication).toMatchObject({ mode: "incremental", baselineHashes: [HashGraph.rootHash] });
	expect(publication?.changed.drp, "production attribution must equal semantic-plus-byte ground truth").toEqual(
		expectedKeys
	);
	expect(publication?.changed.acl).toEqual([]);
	expect(encodedState(stored), "stored bytes must equal the complete deep-capture oracle").toEqual(
		encodedState(expected)
	);
	expect(encodedState(baseline), "the historical baseline must remain immutable").toEqual(baselineBytes);

	const reconstructed = h.states.fromHash(vertex.hash)[0]!;
	expect(encodedState(stateFromDRP(reconstructed)), "reconstruction must match the published bytes").toEqual(
		encodedState(expected)
	);

	const baselineEntries = new Map(baseline.state.map((entry) => [entry.key, entry]));
	const storedEntries = new Map(stored.state.map((entry) => [entry.key, entry]));
	for (const key of expectedKeys) {
		expect(storedEntries.get(key), `changed key ${key} must have a fresh owned entry`).not.toBe(
			baselineEntries.get(key)
		);
	}
	expect(storedEntries.get("ballast"), "unchanged ballast must remain shared").toBe(baselineEntries.get("ballast"));
	const publicationCopies = h.probe.copied.filter((copy) => copy.publicationId === publication?.publicationId);
	const expectedCopyOperations = expectedKeys
		// Deletion charges its pre-image to mutatedBytes but has no target payload to detach.
		.filter((key) => byKey(expected).has(key))
		.map((key) => `drp:${key}:post`)
		.sort();
	expect(
		publicationCopies.map(({ image, key, side }) => `${side}:${key}:${image}`).sort(),
		"copy accounting must be precise and must not inflate every key"
	).toEqual(expectedCopyOperations);
	expect(publicationCopies.reduce((total, copy) => total + copy.bytes, 0)).toBeLessThan(20 * delta.mutatedBytes);
	expect(publication?.changed.drp).not.toContain("context");
}

describe("Phase 1d(i) corrective alias attribution", () => {
	it("charges every shared top-level owner on an eligible single-head local publication", () => {
		const h = harness();
		const baselineBytes = encodedState(h.states.getDRPState(HashGraph.rootHash)!);

		h.applier.drp!.aliasAndMutate(7);
		const vertex = vertexFor(h, "aliasAndMutate");
		const expected = stateFromDRP(h.applier.drp);
		expect(effectiveKeys(h.states.getDRPState(HashGraph.rootHash)!, expected)).toContain("a");
		expect(effectiveKeys(h.states.getDRPState(HashGraph.rootHash)!, expected)).toContain("b");
		assertExactIncrementalDRPPublication(h, vertex, baselineBytes, expected);
	});

	it("charges a held nested alias under every owner on an eligible linear-remote publication", async () => {
		const h = harness();
		const baselineBytes = encodedState(h.states.getDRPState(HashGraph.rootHash)!);
		const vertex = remoteVertex("aliasAndMutate", [11], 1);

		await expect(h.applier.applyVertices(trustedTestVertices([vertex]))).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});
		const expected = stateFromDRP(h.applier.drp);
		expect(effectiveKeys(h.states.getDRPState(HashGraph.rootHash)!, expected)).toContain("a");
		expect(effectiveKeys(h.states.getDRPState(HashGraph.rootHash)!, expected)).toContain("b");
		assertExactIncrementalDRPPublication(h, vertex, baselineBytes, expected);
	});
});

describe("Phase 1d(i) corrective encoded-byte equality", () => {
	it.each([
		["Map", "reorderMap", "orderedMap"],
		["Set", "reorderSet", "orderedSet"],
		["plain object", "reorderObject", "orderedObject"],
	] as const)("publishes a semantic-equal but byte-distinct %s reorder", (_label, opType, expectedKey) => {
		const h = harness();
		const baseline = h.states.getDRPState(HashGraph.rootHash)!;
		const baselineBytes = encodedState(baseline);
		const baselineValue = byKey(baseline).get(expectedKey);

		(h.applier.drp![opType] as () => void)();
		const vertex = vertexFor(h, opType);
		const expected = stateFromDRP(h.applier.drp);
		const expectedValue = byKey(expected).get(expectedKey);
		expect(deepEqual(baselineValue, expectedValue), "positive control: semantics must be equal").toBe(true);
		expect(equalBytes(baselineValue, expectedValue), "positive control: encoded payload bytes must differ").toBe(false);
		expect(effectiveKeys(baseline, expected)).toEqual([expectedKey]);
		assertExactIncrementalDRPPublication(h, vertex, baselineBytes, expected);
	});
});

describe("Phase 1d(i) corrective ambient public-live isolation", () => {
	it("publishes held-reference, replacement, addition, and deletion mutations authored by the encoded operation", async () => {
		const h = harness();
		const baselineBytes = encodedState(h.states.getDRPState(HashGraph.rootHash)!);
		const vertex = remoteVertex("mutateHeldReplacementAdditionDeletion", [], 2);

		await expect(h.applier.applyVertices(trustedTestVertices([vertex]))).resolves.toEqual({
			applied: true,
			missing: [],
			invalid: [],
		});
		const [canonical] = h.states.fromHash(HashGraph.rootHash);
		canonical!.mutateHeldReplacementAdditionDeletion();
		const expected = stateFromDRP(canonical);
		expect(effectiveKeys(h.states.getDRPState(HashGraph.rootHash)!, expected)).toEqual([
			"ambientAdded",
			"ambientNested",
			"ambientPrimitive",
			"removable",
		]);
		assertExactIncrementalDRPPublication(h, vertex, baselineBytes, expected);
	});

	it("isolates a direct ACL live mutation when a different ACL key creates the next vertex", () => {
		const h = harness();
		const baseline = h.states.getACLState(HashGraph.rootHash)!;
		const baselineBytes = encodedState(baseline);
		h.applier.acl.permissionless = true;

		h.applier.acl.setKey("next-key");
		const vertex = vertexFor(h, "setKey");
		const canonicalACL = h.states.fromHash(HashGraph.rootHash)[1];
		canonicalACL.context = { ...canonicalACL.context, caller: "local" };
		canonicalACL.setKey("next-key");
		const expected = stateFromDRP(canonicalACL);
		const delta = effectiveDelta(baseline, expected);
		const expectedKeys = delta.keys;
		expect(expectedKeys).toEqual(["_authorizedPeers"]);

		const stored = h.states.getACLState(vertex.hash)!;
		const publication = h.probe.publications.find(
			(candidate) => candidate.kind === "vertex" && candidate.targetHash === vertex.hash
		);
		expect(publication).toMatchObject({ mode: "incremental", baselineHashes: [HashGraph.rootHash] });
		expect(publication?.changed.acl).toEqual(expectedKeys);
		expect(publication?.changed.drp).toEqual([]);
		const copies = h.probe.copied.filter((copy) => copy.publicationId === publication?.publicationId);
		expect(copies.map(({ image, key, side }) => `${side}:${key}:${image}`).sort()).toEqual(
			expectedKeys.map((key) => `acl:${key}:post`).sort()
		);
		expect(copies.reduce((total, copy) => total + copy.bytes, 0)).toBeLessThan(20 * delta.mutatedBytes);
		expect(encodedState(stored)).toEqual(encodedState(expected));
		expect(encodedState(baseline)).toEqual(baselineBytes);
		expect(encodedState(stateFromDRP(h.states.fromHash(vertex.hash)[1]))).toEqual(encodedState(expected));
	});
});

describe("Phase 1d(i) corrective anti-reward-hacking controls", () => {
	it("does not deep-compare or serialize non-candidate payloads through the publication seam", () => {
		const h = harness();
		let traversals = 0;
		const baselineBallast = {
			get payload(): string {
				traversals++;
				return "stable";
			},
		};
		const targetBallast = {
			get payload(): string {
				traversals++;
				return "stable";
			},
		};
		const baseline = DRPState.create({
			state: [
				DRPStateEntry.create({ key: "ballast", value: baselineBallast }),
				DRPStateEntry.create({ key: "changed", value: "before" }),
			],
		});
		const instance = { ballast: targetBallast, changed: "after" } as unknown as IDRP;
		const publication: PublicationRecord = {
			publicationId: "direct-publication-seam",
			kind: "vertex",
			mode: "incremental",
			outcome: "published",
			targetHash: "target",
			baselineHashes: ["baseline"],
			frontier: ["baseline"],
			changed: { acl: [], drp: [] },
		};
		const seam = h.applier as unknown as {
			capturePublishedState(
				side: SnapshotSide,
				candidate: IDRP | undefined,
				ownedBaseline: DRPState | undefined,
				record: PublicationRecord,
				incremental: boolean,
				candidateKeys?: ReadonlySet<string>
			): DRPState;
		};
		traversals = 0;

		const captured = seam.capturePublishedState("drp", instance, baseline, publication, true, new Set(["changed"]));

		expect(traversals, "non-candidate payload traversal would reintroduce a whole-state publication scan").toBe(0);
		expect(publication.changed.drp).toEqual(["changed"]);
		expect(captured.state.find(({ key }) => key === "ballast")).toBe(baseline.state[0]);
	});
});
