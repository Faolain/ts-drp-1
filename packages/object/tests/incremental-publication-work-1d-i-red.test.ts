/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow required snapshots and vertices */
import {
	ACLGroup,
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
import { serializeDRPState, serializeValue } from "@ts-drp/utils/serialization";
import { cloneDeep } from "es-toolkit";
import { deepEqual } from "fast-equals";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { DRPObjectStateManager } from "../src/state.js";

type PublicationMode = "incremental" | "fallback";
type PublicationKind = "vertex" | "checkpoint";
type SnapshotSide = "acl" | "drp";

interface PublicationRecord {
	publicationId: string;
	kind: PublicationKind;
	mode: PublicationMode;
	outcome: "published" | "rolled-back";
	targetHash?: Hash;
	baselineHashes: readonly Hash[];
	frontier: readonly Hash[];
	changed: Readonly<Record<SnapshotSide, readonly string[]>>;
	fallbackReason?:
		| "non-empty-suffix"
		| "conflict-replay"
		| "concurrent-tail"
		| "multi-head-local"
		| "multi-frontier-checkpoint";
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
	readonly copies: CopyObservation[] = [];
	readonly publications: PublicationRecord[] = [];

	observe(event: PublicationObserverEvent): unknown {
		if (event.type === "copy") {
			this.copies.push({ ...event.metadata, bytes: serializeValue(event.value).byteLength });
			return cloneDeep(event.value);
		}
		const { record } = event;
		this.publications.push({
			...record,
			baselineHashes: [...record.baselineHashes],
			frontier: [...record.frontier],
			changed: { acl: [...record.changed.acl], drp: [...record.changed.drp] },
		});
	}
}

class IdentityPublicationProbe extends PublicationProbe {
	override observe(event: PublicationObserverEvent): unknown {
		if (event.type !== "copy") return super.observe(event);
		this.copies.push({ ...event.metadata, bytes: serializeValue(event.value).byteLength });
		return event.value;
	}
}

class MatrixDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	ballast = "b".repeat(64 * 1024);
	replacement = "old";
	nested = { stable: "stable", child: { value: 1 } };
	array = [{ value: 1 }, { value: 2 }];
	map = new Map([["item", { value: 1 }]]);
	set = new Set(["one"]);
	date = new Date("2025-01-01T00:00:00.000Z");
	removable?: { value: string } = { value: "remove-me" };
	declare added?: { value: string };

	replace(value: string): void {
		this.replacement = value;
	}

	mutateNested(value: number): void {
		this.nested.child.value = value;
	}

	mutateArray(value: number): void {
		this.array[0].value = value;
	}

	mutateMap(value: number): void {
		this.map.get("item")!.value = value;
	}

	mutateSet(value: string): void {
		this.set.add(value);
	}

	mutateDate(year: number): void {
		this.date.setUTCFullYear(year);
	}

	add(value: string): void {
		this.added = { value };
	}

	remove(): void {
		delete this.removable;
	}

	setK(value: string): void {
		this.nested.stable = value;
	}

	setJ(value: string): void {
		this.replacement = value;
	}

	mutateTwo(value: number, replacement: string): void {
		this.nested.child.value = value;
		this.replacement = replacement;
	}
}

class ConflictMatrixDRP extends MatrixDRP {
	resolveConflicts(_vertices: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

interface Harness {
	applier: DRPVertexApplier<MatrixDRP>;
	drp: MatrixDRP;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<MatrixDRP>;
}

function harness(
	drp = new MatrixDRP(),
	configure?: (drp: MatrixDRP) => void,
	probe: PublicationProbe = new PublicationProbe()
): Harness {
	configure?.(drp);
	const acl = createACL({ admins: ["local", "remote"] });
	const hashGraph = new HashGraph(
		"local",
		acl.resolveConflicts?.bind(acl),
		(drp as IDRP).resolveConflicts?.bind(drp),
		drp.semanticsType
	);
	const states = new DRPObjectStateManager(acl, drp);
	const options = {
		drp,
		acl,
		hashGraph,
		states,
		finalityStore: new FinalityStore(),
		notify: (): void => {},
		publicationObserver: probe.observe.bind(probe),
	};
	const Applier = DRPVertexApplier as unknown as new (candidate: typeof options) => DRPVertexApplier<MatrixDRP>;
	return { applier: new Applier(options), drp, hashGraph, probe, states };
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

function mapState(snapshot: DRPState): Map<string, unknown> {
	return new Map(snapshot.state.map(({ key, value }) => [key, value]));
}

function snapshot(entries: Record<string, unknown>): DRPState {
	return DRPState.create({
		state: Object.entries(entries).map(([key, value]) => DRPStateEntry.create({ key, value })),
	});
}

function encodedState(value: DRPState): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(value)).finish();
}

function equalBytes(left: unknown, right: unknown): boolean {
	const leftBytes = serializeValue(left);
	const rightBytes = serializeValue(right);
	return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function effectiveDelta(before: DRPState, after: DRPState): { keys: string[]; mutatedBytes: number } {
	const beforeByKey = mapState(before);
	const afterByKey = mapState(after);
	const keys: string[] = [];
	let mutatedBytes = 0;
	for (const key of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
		const beforePresent = beforeByKey.has(key);
		const afterPresent = afterByKey.has(key);
		const beforeValue = beforeByKey.get(key);
		const afterValue = afterByKey.get(key);
		const semanticallyEqual = beforePresent === afterPresent && deepEqual(beforeValue, afterValue);
		const encodedEqual = beforePresent === afterPresent && equalBytes(beforeValue, afterValue);
		if (semanticallyEqual && encodedEqual) continue;
		keys.push(key);
		const beforeBytes = beforePresent ? serializeValue(beforeValue).byteLength : 0;
		const afterBytes = afterPresent ? serializeValue(afterValue).byteLength : 0;
		mutatedBytes += Math.max(beforeBytes, afterBytes);
	}
	return { keys: keys.sort(), mutatedBytes };
}

function publicationCopies(probe: PublicationProbe, publicationId: string): CopyObservation[] {
	return probe.copies.filter((copy) => copy.publicationId === publicationId);
}

function stateEntries(states: DRPObjectStateManager<MatrixDRP>, side: SnapshotSide, hash: Hash): DRPState["state"] {
	return (side === "acl" ? states.getACLState(hash) : states.getDRPState(hash))?.state ?? [];
}

function expectCountedFullCapture(h: Harness, record: PublicationRecord | undefined, targetHash: Hash): void {
	const copiedPostKeys = new Set(
		publicationCopies(h.probe, record?.publicationId ?? "missing")
			.filter(({ image }) => image === "post")
			.map(({ side, key }) => `${side}:${key}`)
	);
	const completeTargetKeys = [
		...stateEntries(h.states, "acl", targetHash).map(({ key }) => `acl:${key}`),
		...stateEntries(h.states, "drp", targetHash).map(({ key }) => `drp:${key}`),
	];
	expect([...copiedPostKeys].sort()).toEqual(completeTargetKeys.sort());
}

function expectCountedFallbackDelta(h: Harness, record: PublicationRecord | undefined, targetHash: Hash): void {
	expect(record?.mode).toBe("fallback");
	const copies = publicationCopies(h.probe, record?.publicationId ?? "missing");
	expect(copies.every(({ image }) => image === "post")).toBe(true);

	for (const side of ["acl", "drp"] as const) {
		const targetEntries = stateEntries(h.states, side, targetHash);
		const targetByKey = new Map(targetEntries.map((candidate) => [candidate.key, candidate]));
		const baselineEntries = (record?.baselineHashes ?? []).flatMap((hash) => stateEntries(h.states, side, hash));
		const baselineKeys = new Set(baselineEntries.map(({ key }) => key));
		const sideCopies = copies.filter((copy) => copy.side === side);
		expect(
			sideCopies.every(({ key }) => targetByKey.has(key)),
			`${side} copy events must describe present entries`
		).toBe(true);

		for (const candidate of targetEntries) {
			const retainedCandidates = baselineEntries.filter(
				(baseline) =>
					baseline.key === candidate.key &&
					deepEqual(baseline.value, candidate.value) &&
					equalBytes(baseline.value, candidate.value)
			);
			const candidateCopies = copies.filter((copy) => copy.side === side && copy.key === candidate.key);
			if (retainedCandidates.length > 0) {
				expect(candidateCopies, `unchanged borrowed ${side}.${candidate.key} must not be copied`).toEqual([]);
				expect(
					retainedCandidates.includes(candidate),
					`unchanged borrowed ${side}.${candidate.key} must retain an owned entry identity`
				).toBe(true);
			} else {
				expect(candidateCopies, `present changed ${side}.${candidate.key} must be copied exactly once`).toHaveLength(1);
			}
		}

		for (const key of baselineKeys) {
			if (targetByKey.has(key)) continue;
			expect(
				copies.filter((copy) => copy.side === side && copy.key === key),
				`deleted ${side}.${key} must not be copied`
			).toEqual([]);
		}
	}
}

function assertIncrementalPublication(
	h: Harness,
	targetHash: Hash,
	baselineHash: Hash,
	expectedSide: SnapshotSide
): { clonedBytes: number; mutatedBytes: number } {
	const record = h.probe.publications.find(
		(candidate) => candidate.kind === "vertex" && candidate.targetHash === targetHash
	);
	expect(record, `publication ${targetHash} must cross the governed observer`).toBeDefined();
	expect(record?.mode).toBe("incremental");
	expect(record?.baselineHashes).toEqual([baselineHash]);

	const before = expectedSide === "drp" ? h.states.getDRPState(baselineHash) : h.states.getACLState(baselineHash);
	const after = expectedSide === "drp" ? h.states.getDRPState(targetHash) : h.states.getACLState(targetHash);
	expect(before).toBeDefined();
	expect(after).toBeDefined();
	const delta = effectiveDelta(before!, after!);
	expect(delta.keys.length, "positive control: the operation must make an effective state change").toBeGreaterThan(0);
	expect([...(record?.changed[expectedSide] ?? [])].sort()).toEqual(delta.keys);
	expect(record?.changed[expectedSide === "drp" ? "acl" : "drp"]).toEqual([]);

	const copies = publicationCopies(h.probe, record?.publicationId ?? "missing");
	const clonedBytes = copies.reduce((total, copy) => total + copy.bytes, 0);
	expect(clonedBytes, "the trusted primitive must observe all governed payload detachment").toBeGreaterThanOrEqual(0);
	expect(clonedBytes).toBeLessThan(20 * delta.mutatedBytes);
	const afterByKey = mapState(after!);
	const expectedCopyOperations = delta.keys
		.filter((key) => afterByKey.has(key))
		.map((key) => `${expectedSide}:${key}:post`)
		.sort();
	expect(
		copies.map(({ image, key, side }) => `${side}:${key}:${image}`).sort(),
		"copiedKeys/copyOperations must expose discarded pre-copies and clone-everything-then-share"
	).toEqual(expectedCopyOperations);

	for (const side of ["acl", "drp"] as const) {
		const changed = new Set(record?.changed[side] ?? []);
		const baseline = new Map(stateEntries(h.states, side, baselineHash).map((candidate) => [candidate.key, candidate]));
		for (const candidate of stateEntries(h.states, side, targetHash)) {
			if (!changed.has(candidate.key)) {
				expect(candidate, `unchanged ${side}.${candidate.key} must share its owned entry`).toBe(
					baseline.get(candidate.key)
				);
			}
		}
	}
	return { clonedBytes, mutatedBytes: delta.mutatedBytes };
}

const DRP_CASES = [
	["replacement", "replace", ["new"]],
	["nested object", "mutateNested", [2]],
	["Array", "mutateArray", [3]],
	["Map", "mutateMap", [4]],
	["Set", "mutateSet", ["two"]],
	["Date", "mutateDate", [2026]],
	["add", "add", ["present"]],
	["delete", "remove", []],
] as const;

describe("Phase 1d(i) eligible incremental publication work", () => {
	it("keeps the identity observer as the sole copy result and emits exactly one event per changed key", async () => {
		const probe = new IdentityPublicationProbe();
		const h = harness(new MatrixDRP(), undefined, probe);
		const vertex = remoteVertex("mutateTwo", [17, "identity"], [HashGraph.rootHash], 1);
		await expect(h.applier.applyVertices([vertex])).resolves.toEqual({ applied: true, missing: [], invalid: [] });

		const publication = probe.publications.find((candidate) => candidate.targetHash === vertex.hash);
		expect(publication?.changed).toEqual({ acl: [], drp: ["nested", "replacement"] });
		const copies = publicationCopies(probe, publication?.publicationId ?? "missing");
		expect(copies.map(({ image, key, side }) => `${side}:${key}:${image}`).sort()).toEqual([
			"drp:nested:post",
			"drp:replacement:post",
		]);

		const published = mapState(h.states.getDRPState(vertex.hash)!);
		expect(published.get("nested"), "no unobserved copier may detach the observer result").toBe(h.drp.nested);
		expect(published.get("replacement"), "the changed-key payload is exactly the live value").toBe(h.drp.replacement);
	});

	it("pins the test-owned presence, semantic, and encoded effective-delta denominator", () => {
		const before = snapshot({
			reverted: { nested: [1, 2] },
			deleted: "before-only",
			replaced: "a much longer pre-image",
			encodedOrder: new Map([
				["a", 1],
				["b", 2],
			]),
		});
		const after = snapshot({
			reverted: { nested: [1, 2] },
			replaced: "post",
			added: { post: true },
			encodedOrder: new Map([
				["b", 2],
				["a", 1],
			]),
		});
		const delta = effectiveDelta(before, after);
		const expectedBytes =
			serializeValue("before-only").byteLength +
			Math.max(serializeValue("a much longer pre-image").byteLength, serializeValue("post").byteLength) +
			serializeValue({ post: true }).byteLength +
			Math.max(
				serializeValue(
					new Map([
						["a", 1],
						["b", 2],
					])
				).byteLength,
				serializeValue(
					new Map([
						["b", 2],
						["a", 1],
					])
				).byteLength
			);
		expect(delta).toEqual({
			keys: ["added", "deleted", "encodedOrder", "replaced"],
			mutatedBytes: expectedBytes,
		});
	});

	it.each(DRP_CASES)(
		"keeps linear-remote %s publication below the per-case byte bound",
		async (_label, opType, args) => {
			const h = harness();
			const vertex = remoteVertex(opType, [...args], [HashGraph.rootHash], 1);
			await expect(h.applier.applyVertices([vertex])).resolves.toEqual({ applied: true, missing: [], invalid: [] });
			assertIncrementalPublication(h, vertex.hash, HashGraph.rootHash, "drp");
		}
	);

	it("keeps single-head local publication incremental and reuses the unchanged ACL", () => {
		const h = harness();
		h.applier.drp?.mutateNested(7);
		const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === "mutateNested");
		expect(vertex).toBeDefined();
		assertIncrementalPublication(h, vertex!.hash, HashGraph.rootHash, "drp");
	});

	it("publishes an exact single-head checkpoint with zero payload detachment and unconstrained wrappers", async () => {
		const previousSuffix = process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
		process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = "1";
		try {
			const h = harness();
			const vertex = remoteVertex("replace", ["checkpoint"], [HashGraph.rootHash], 4);
			await expect(h.applier.applyVertices([vertex])).resolves.toEqual({ applied: true, missing: [], invalid: [] });
			assertIncrementalPublication(h, vertex.hash, HashGraph.rootHash, "drp");
			const publication = h.probe.publications.find(
				(candidate) =>
					candidate.kind === "checkpoint" && candidate.frontier.length === 1 && candidate.frontier[0] === vertex.hash
			);
			expect(publication).toMatchObject({
				kind: "checkpoint",
				mode: "incremental",
				outcome: "published",
				baselineHashes: [vertex.hash],
				frontier: [vertex.hash],
			});
			expect(publicationCopies(h.probe, publication?.publicationId ?? "missing")).toEqual([]);

			const checkpoint = (
				h.applier as unknown as {
					checkpoints: { frontier: Hash[]; state: { aclState: DRPState; drpState: DRPState } }[];
				}
			).checkpoints.find((candidate) => candidate.frontier.length === 1 && candidate.frontier[0] === vertex.hash);
			expect(checkpoint).toBeDefined();
			expect(encodedState(checkpoint!.state.aclState)).toEqual(encodedState(h.states.getACLState(vertex.hash)!));
			expect(encodedState(checkpoint!.state.drpState)).toEqual(encodedState(h.states.getDRPState(vertex.hash)!));
			expect(effectiveDelta(h.states.getACLState(vertex.hash)!, checkpoint!.state.aclState)).toEqual({
				keys: [],
				mutatedBytes: 0,
			});
			expect(effectiveDelta(h.states.getDRPState(vertex.hash)!, checkpoint!.state.drpState)).toEqual({
				keys: [],
				mutatedBytes: 0,
			});
		} finally {
			if (previousSuffix === undefined) delete process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
			else process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = previousSuffix;
		}
	});

	it("attributes an ACL operation while reusing the unchanged DRP entry-for-entry", () => {
		const h = harness();
		h.applier.acl.grant("writer", ACLGroup.Writer);
		const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === "grant");
		expect(vertex).toBeDefined();
		assertIncrementalPublication(h, vertex!.hash, HashGraph.rootHash, "acl");
	});

	it("enforces the aggregate bound without allowing one eligible case to hide another", async () => {
		let aggregateClonedBytes = 0;
		let aggregateMutatedBytes = 0;
		for (let index = 0; index < DRP_CASES.length; index++) {
			const [, opType, args] = DRP_CASES[index];
			const h = harness();
			const vertex = remoteVertex(opType, [...args], [HashGraph.rootHash], index + 10);
			await h.applier.applyVertices([vertex]);
			const result = assertIncrementalPublication(h, vertex.hash, HashGraph.rootHash, "drp");
			aggregateClonedBytes += result.clonedBytes;
			aggregateMutatedBytes += result.mutatedBytes;
		}
		expect(aggregateClonedBytes).toBeLessThan(20 * aggregateMutatedBytes);
	});
});

describe("Phase 1d(i) exact-cut fallback publication", () => {
	it("charges every speculative copy when guarded commit rolls publication back", async () => {
		const h = harness();
		const candidate = remoteVertex("replace", ["rolled-back"], [HashGraph.rootHash], 5);
		const originalAddVertex = h.hashGraph.addVertex.bind(h.hashGraph);
		h.hashGraph.addVertex = (): void => {
			throw new Error("controlled post-publication failure");
		};
		try {
			await expect(h.applier.applyVertices([candidate])).resolves.toEqual({
				applied: false,
				missing: [],
				invalid: [],
				quarantined: [candidate.hash],
			});
		} finally {
			h.hashGraph.addVertex = originalAddVertex;
		}

		const attempts = h.probe.publications.filter((record) => record.targetHash === candidate.hash);
		expect(attempts.length).toBeGreaterThan(0);
		expect(attempts.every(({ outcome }) => outcome === "rolled-back")).toBe(true);
		expect(
			h.probe.copies.filter(({ publicationId }) => attempts.some((attempt) => attempt.publicationId === publicationId))
				.length
		).toBeGreaterThan(0);
		expect(h.states.getACLState(candidate.hash)).toBeUndefined();
		expect(h.states.getDRPState(candidate.hash)).toBeUndefined();
	});

	it("counts a full fallback and preserves suffix-K before applying pending-J", async () => {
		const h = harness();
		const suffixK = remoteVertex("setK", ["suffix-K"], [HashGraph.rootHash], 1);
		const pendingJ = remoteVertex("setJ", ["pending-J"], [HashGraph.rootHash], 2);
		await expect(h.applier.applyVertices([suffixK])).resolves.toMatchObject({ applied: true });
		await expect(h.applier.applyVertices([pendingJ])).resolves.toMatchObject({ applied: true });

		const record = h.probe.publications.find((candidate) => candidate.targetHash === pendingJ.hash);
		expect(record?.mode).toBe("fallback");
		expect(["non-empty-suffix", "concurrent-tail"]).toContain(record?.fallbackReason);
		expect(record?.baselineHashes).not.toEqual([HashGraph.rootHash]);
		const target = mapState(h.states.getDRPState(pendingJ.hash)!);
		expect((target.get("nested") as MatrixDRP["nested"]).stable).toBe("suffix-K");
		expect(target.get("replacement")).toBe("pending-J");

		expectCountedFallbackDelta(h, record, pendingJ.hash);
	});

	it("counts multi-head local authoring as a complete fallback", async () => {
		const h = harness();
		const left = remoteVertex("setK", ["left"], [HashGraph.rootHash], 10);
		const right = remoteVertex("setJ", ["right"], [HashGraph.rootHash], 11);
		await h.applier.applyVertices([left, right]);
		expect(
			h.hashGraph.getFrontier().length,
			"positive control: local authoring starts at multiple heads"
		).toBeGreaterThan(1);
		h.applier.drp?.mutateNested(8);
		const local = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === "mutateNested");
		const record = h.probe.publications.find((candidate) => candidate.targetHash === local?.hash);
		expect(record).toMatchObject({ kind: "vertex", mode: "fallback", fallbackReason: "multi-head-local" });
		expect(record?.baselineHashes.length).toBeGreaterThan(1);
		expectCountedFullCapture(h, record, local!.hash);
	});

	it("counts a non-empty replay suffix even when the remote vertex joins the whole frontier", async () => {
		const h = harness();
		const left = remoteVertex("setK", ["left"], [HashGraph.rootHash], 12);
		const right = remoteVertex("setJ", ["right"], [HashGraph.rootHash], 13);
		await h.applier.applyVertices([left, right]);
		const join = remoteVertex("mutateNested", [9], [left.hash, right.hash], 14);
		await h.applier.applyVertices([join]);

		const record = h.probe.publications.find((candidate) => candidate.targetHash === join.hash);
		expect(record).toMatchObject({ kind: "vertex", mode: "fallback", fallbackReason: "non-empty-suffix" });
		expectCountedFallbackDelta(h, record, join.hash);
	});

	it("counts concurrent-tail adoption instead of sharing against the pending vertex's stale cut", async () => {
		const h = harness();
		const left = remoteVertex("setK", ["left"], [HashGraph.rootHash], 15);
		const right = remoteVertex("setJ", ["tail"], [HashGraph.rootHash], 16);
		await h.applier.applyVertices([left, right]);
		const pending = remoteVertex("mutateNested", [10], [left.hash], 17);
		await h.applier.applyVertices([pending]);

		const record = h.probe.publications.find((candidate) => candidate.targetHash === pending.hash);
		expect(record).toMatchObject({ kind: "vertex", mode: "fallback", fallbackReason: "concurrent-tail" });
		const target = mapState(h.states.getDRPState(pending.hash)!);
		expect(target.get("replacement")).toBe("tail");
		expect((target.get("nested") as MatrixDRP["nested"]).child.value).toBe(10);
		expectCountedFallbackDelta(h, record, pending.hash);
	});

	it("keeps resolver-bearing conflict replay in the counted full fallback", async () => {
		const h = harness(new ConflictMatrixDRP());
		const left = remoteVertex("setK", ["left"], [HashGraph.rootHash], 20);
		const right = remoteVertex("setJ", ["right"], [HashGraph.rootHash], 21);
		await h.applier.applyVertices([left]);
		await h.applier.applyVertices([right]);

		const record = h.probe.publications.find((candidate) => candidate.targetHash === right.hash);
		expect(record).toMatchObject({ kind: "vertex", mode: "fallback", fallbackReason: "conflict-replay" });
		expectCountedFallbackDelta(h, record, right.hash);
	});

	it("never reuses sorted origin for a multi-frontier checkpoint", async () => {
		const previousSuffix = process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
		process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = "1";
		try {
			const h = harness();
			const left = remoteVertex("setK", ["left"], [HashGraph.rootHash], 30);
			const right = remoteVertex("setJ", ["right"], [HashGraph.rootHash], 31);
			await h.applier.applyVertices([left]);
			await h.applier.applyVertices([right]);
			const frontier = h.hashGraph.getFrontier();
			expect(frontier.length, "positive control: checkpoint cut has multiple heads").toBeGreaterThan(1);
			const checkpoint = h.probe.publications.find(
				(candidate) => candidate.kind === "checkpoint" && candidate.frontier.length > 1
			);
			expect(checkpoint).toMatchObject({
				kind: "checkpoint",
				mode: "fallback",
				fallbackReason: "multi-frontier-checkpoint",
			});
			expect(checkpoint?.frontier.toSorted()).toEqual(frontier.toSorted());
			expect(checkpoint?.baselineHashes).not.toEqual([[...frontier].sort()[0]]);
			const copies = publicationCopies(h.probe, checkpoint?.publicationId ?? "missing");
			expect(new Set(copies.filter(({ image }) => image === "post").map(({ side }) => side))).toEqual(
				new Set(["acl", "drp"])
			);
			const checkpointState = (
				h.applier as unknown as {
					checkpoints: { frontier: string[]; state: { aclState: DRPState; drpState: DRPState } }[];
				}
			).checkpoints.find((candidate) => candidate.frontier.toSorted().join() === frontier.toSorted().join())?.state;
			expect(checkpointState).toBeDefined();
			const copiedKeys = copies
				.filter(({ image }) => image === "post")
				.map(({ side, key }) => `${side}:${key}`)
				.sort();
			const checkpointKeys = [
				...(checkpointState?.aclState.state ?? []).map(({ key }) => `acl:${key}`),
				...(checkpointState?.drpState.state ?? []).map(({ key }) => `drp:${key}`),
			].sort();
			expect(copiedKeys).toEqual(checkpointKeys);
		} finally {
			if (previousSuffix === undefined) delete process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
			else process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = previousSuffix;
		}
	});
});
