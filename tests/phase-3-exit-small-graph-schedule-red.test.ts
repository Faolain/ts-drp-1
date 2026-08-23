import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CompactMerkleAccumulator, deriveCloseSetHistoryCommitment } from "@ts-drp/compaction";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
	PHASE3_EXIT_REAL_SCENARIOS,
	type Phase3ExitDriverModule,
	type Phase3ExitModelInput,
	type Phase3ExitModelLimits,
	type Phase3ExitModelVertex,
	type Phase3ExitRealObservation,
} from "./fixtures/phase-3-exit-model/model-contract.js";
import { runPhase3ExitModel } from "./fixtures/phase-3-exit-model/oracle.js";
import {
	enumeratePhase3ExitSchedules,
	PHASE3_EXIT_CERTIFICATION_CORPUS_COUNT,
	PHASE3_EXIT_CERTIFICATION_CORPUS_SHA256,
	PHASE3_EXIT_CERTIFICATION_OUTCOME_SHA256,
	PHASE3_EXIT_CERTIFICATION_SCHEDULE_COUNT,
	PHASE3_EXIT_CERTIFICATION_SCHEDULE_SHA256,
	PHASE3_EXIT_ORDINARY_CORPUS_COUNT,
	PHASE3_EXIT_ORDINARY_CORPUS_SHA256,
	PHASE3_EXIT_ORDINARY_OUTCOME_SHA256,
	PHASE3_EXIT_ORDINARY_SCHEDULE_COUNT,
	PHASE3_EXIT_ORDINARY_SCHEDULE_SHA256,
	phase3ExitScheduleEvidence,
} from "./fixtures/phase-3-exit-model/schedules.js";
import { ObservedMessageQueueManager } from "./fixtures/shared/observed-message-queue.js";
import type { EpochVertex } from "../packages/compaction/tests/contract.js";
import { corpusHash, enumerateCorpus, hashForIndex, referenceOrder } from "../packages/compaction/tests/corpus.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DRIVER_URL = pathToFileURL(path.join(ROOT, "tests/fixtures/phase-3-exit-model", ["dri", "ver.ts"].join(""))).href;
const DRIVER_PATH = fileURLToPath(DRIVER_URL);
const LIVE_FIXTURE_URL = pathToFileURL(
	path.join(ROOT, "tests/fixtures/phase-3a1b-p3", ["live", "-fixture.ts"].join(""))
).href;
const A0_SEED = "11".repeat(32);
const A1_SEED = "22".repeat(32);
const A0_AUTHOR = lowerHex(ed25519.getPublicKey(hexBytes(A0_SEED)));
const A1_AUTHOR = lowerHex(ed25519.getPublicKey(hexBytes(A1_SEED)));
const AUTHORIZED_AUTHORS = Object.freeze([A0_AUTHOR, A1_AUTHOR].sort());

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
			? true
			: false
		: false;

type DriverResult = Awaited<ReturnType<Phase3ExitDriverModule["runPhase3ExitDriver"]>>;
const exactDriverParameters: Equal<
	DriverResult["parameters"],
	Readonly<{
		readonly maxDependencies: 16;
		readonly maxEpochBytes: 8_388_608;
		readonly maxEpochVertices: 8192;
		readonly maxPendingBytes: 16_777_216;
		readonly maxPendingEntries: 4096;
	}>
> = true;
void exactDriverParameters;

function modelVertex(
	label: number,
	dependencies: readonly number[],
	overrides: Partial<Phase3ExitModelVertex> = {}
): Phase3ExitModelVertex {
	return Object.freeze({
		acceptedByteCharge: 1,
		authorized: true,
		canonicalPreimageByteCharge: 1,
		dependencies: Object.freeze([...dependencies]),
		digest: hashForIndex(label),
		label,
		malformed: false,
		pendingWireByteCharge: 4,
		scopeCurrent: true,
		...overrides,
	});
}

function modelInput(
	vertices: readonly Phase3ExitModelVertex[],
	actions: Phase3ExitModelInput["actions"],
	limits: Partial<Phase3ExitModelLimits> = {}
): Phase3ExitModelInput {
	return Object.freeze({
		actions,
		bootstrapLabel: 0,
		limits: Object.freeze({
			anchorAcceptedByteCharge: 1,
			maxAcceptedBytes: 1_000,
			maxAcceptedVertices: 1_000,
			maxPendingBytes: 1_000,
			maxPendingEntries: 1_000,
			...limits,
		}),
		vertices: new Map(vertices.map((vertex) => [vertex.label, vertex])),
	});
}

async function loadDriver(): Promise<Phase3ExitDriverModule | undefined> {
	try {
		return (await import(DRIVER_URL)) as Phase3ExitDriverModule;
	} catch (error) {
		const message = typeof error === "object" && error !== null ? String(Reflect.get(error, "message")) : "";
		const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
		const exactNodeMiss =
			code === "ERR_MODULE_NOT_FOUND" &&
			(message.includes(`Cannot find module '${DRIVER_PATH}'`) ||
				message.includes(`Cannot find module '${DRIVER_URL}'`));
		const exactViteMiss =
			message.includes(`Failed to load url ${DRIVER_PATH}`) && message.includes("Does the file exist?");
		if (exactNodeMiss || exactViteMiss) {
			return undefined;
		}
		throw error;
	}
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value: string): Uint8Array {
	if (!/^[0-9a-f]+$/u.test(value) || value.length % 2 !== 0) throw new TypeError("expected lowercase even-length hex");
	return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
		Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
	);
}

function authenticatedGraph(row: Phase3ExitRealObservation): ReadonlyMap<string, EpochVertex> {
	const graph = new Map<string, EpochVertex>();
	expect(row.authorizedAuthors).toEqual(AUTHORIZED_AUTHORS);
	const anchor = decodeCanonical(row.exactCanonicalAnchorPreimageBytes) as Readonly<Record<string, unknown>>;
	expect(lowerHex(hashDomain("ts-drp/epoch-anchor/v3", row.exactCanonicalAnchorPreimageBytes))).toBe(row.anchorDigest);
	expect(ed25519.verify(row.detachedAnchorSignature, hexBytes(row.anchorDigest), row.anchorSignerPublicKey)).toBe(true);
	expect(anchor).toMatchObject({ kind: "drp-epoch-anchor", protocolMajor: 3 });
	graph.set(row.anchorDigest, {
		dependencies: [],
		epoch: anchor.epoch as number,
		hash: row.anchorDigest,
		kind: "drp-epoch-anchor",
		objectId: anchor.objectId as string,
	});
	for (const evidence of row.acceptedVertices) {
		expect(evidence.authenticatedCanonicalPreimageByteLength).toBe(evidence.exactCanonicalPreimageBytes.byteLength);
		expect(lowerHex(hashDomain("ts-drp/vertex/v3", evidence.exactCanonicalPreimageBytes))).toBe(evidence.digest);
		const vertex = decodeCanonical(evidence.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>;
		expect(vertex).toMatchObject({
			anchor: row.anchorDigest,
			epoch: anchor.epoch,
			kind: "drp-vertex",
			objectId: anchor.objectId,
			protocolMajor: 3,
		});
		expect(row.authorizedAuthors).toContain(vertex.author);
		expect(
			ed25519.verify(evidence.detachedSignature, hexBytes(evidence.digest), hexBytes(vertex.author as string))
		).toBe(true);
		graph.set(evidence.digest, {
			anchor: vertex.anchor as string,
			dependencies: [...(vertex.dependencies as string[])],
			epoch: vertex.epoch as number,
			hash: evidence.digest,
			kind: "drp-vertex",
			objectId: vertex.objectId as string,
			operation: vertex.operation as EpochVertex["operation"],
		});
	}
	return graph;
}

type StandardRealScenario = Exclude<
	Phase3ExitRealObservation["scenario"],
	"local-issue-release" | "post-issuance-commit-crash"
>;

function expectedStandardDependencies(
	scenario: StandardRealScenario,
	vertexCount: number
): readonly (readonly number[])[] {
	const expectedCount = {
		"accepted-capacity": 8191,
		"complete-reverse": 4,
		"duplicate-after-acceptance": 3,
		"duplicate-before-release": 3,
		"multi-member-commitment": 4,
		"pending-entry-capacity": 4099,
		"post-journal-append-crash": 2,
		"ready-forward": 4,
		"sibling-permutation": 4,
		"volatile-pending-crash": 3,
		"wrong-scope-author-signature": 1,
	} satisfies Readonly<Record<StandardRealScenario, number>>;
	expect(vertexCount).toBe(expectedCount[scenario]);
	if (scenario === "sibling-permutation") return Object.freeze([[-1], [0], [1], [1]]);
	if (scenario === "pending-entry-capacity") {
		return Object.freeze(
			Array.from({ length: vertexCount }, (_, label) => (label === 0 ? [-1] : label === 1 ? [0] : [1]))
		);
	}
	if (scenario === "multi-member-commitment") return Object.freeze([[-1], [0], [0], [0]]);
	if (scenario === "wrong-scope-author-signature") return Object.freeze([[-1]]);
	return Object.freeze(Array.from({ length: vertexCount }, (_, label) => (label === 0 ? [-1] : [label - 1])));
}

function standardLabelTable(row: Phase3ExitRealObservation): ReadonlyMap<string, number> {
	const byDigest = new Map<string, number>();
	const byLabel = new Map<number, string>();
	const authorSlots = new Set<string>();
	for (const evidence of row.acceptedVertices) {
		const vertex = decodeCanonical(evidence.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>;
		const operation = vertex.operation as Readonly<Record<string, unknown>>;
		expect(operation.action).toBe("add");
		expect(Number.isSafeInteger(operation.value)).toBe(true);
		const label = (operation.value as number) - 1;
		expect(label).toBeGreaterThanOrEqual(0);
		expect(byLabel.has(label)).toBe(false);
		byLabel.set(label, evidence.digest);
		byDigest.set(evidence.digest, label);
		const expectedAuthor = label === 0 ? A0_AUTHOR : A1_AUTHOR;
		const expectedSequence = label === 0 ? 0 : label - 1;
		expect(vertex).toMatchObject({
			author: expectedAuthor,
			authorSequence: expectedSequence,
			logicalTime: label + 1,
			operation: { action: "add", value: label + 1 },
		});
		const slot = `${String(vertex.author)}:${String(vertex.authorSequence)}`;
		expect(authorSlots.has(slot)).toBe(false);
		authorSlots.add(slot);
	}
	expect([...byLabel.keys()].sort((left, right) => left - right)).toEqual(
		Array.from({ length: byLabel.size }, (_, label) => label)
	);
	const expectedDependencies = expectedStandardDependencies(row.scenario as StandardRealScenario, byLabel.size);
	for (const evidence of row.acceptedVertices) {
		const vertex = decodeCanonical(evidence.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>;
		const label = byDigest.get(evidence.digest) as number;
		const dependencies = vertex.dependencies as readonly string[];
		const dependencyLabels = dependencies.map((dependency) =>
			dependency === row.anchorDigest ? -1 : (byDigest.get(dependency) as number)
		);
		expect(dependencyLabels).toEqual(expectedDependencies[label]);
	}
	return byDigest;
}

function digestForLabel(labels: ReadonlyMap<string, number>, selected: number): string {
	const digest = [...labels].find(([, label]) => label === selected)?.[0];
	if (digest === undefined) throw new TypeError(`missing authenticated real label ${selected}`);
	return digest;
}

function expectedStandardActionTrace(
	row: Phase3ExitRealObservation,
	labels: ReadonlyMap<string, number>
): Phase3ExitRealObservation["actionTrace"] {
	const deliver = (label: number, mode: "normal" | "commit-then-throw" = "normal") =>
		["deliver", digestForLabel(labels, label), mode] as const;
	const redeliver = (label: number) => ["redeliver", digestForLabel(labels, label)] as const;
	const query = ["query-commitment"] as const;
	if (row.scenario === "ready-forward") return [deliver(1), deliver(2), deliver(3), query];
	if (row.scenario === "complete-reverse") return [deliver(3), deliver(2), deliver(1), query];
	if (row.scenario === "sibling-permutation") {
		const siblings = [digestForLabel(labels, 2), digestForLabel(labels, 3)].sort().reverse();
		return [...siblings.map((digest) => ["deliver", digest, "normal"] as const), deliver(1), query];
	}
	if (row.scenario === "duplicate-before-release") return [deliver(2), redeliver(2), deliver(1), query];
	if (row.scenario === "duplicate-after-acceptance") return [deliver(1), deliver(2), redeliver(2), query];
	if (row.scenario === "volatile-pending-crash") {
		return [deliver(2), ["crash-restart"], redeliver(2), deliver(1), query];
	}
	if (row.scenario === "post-journal-append-crash") {
		return [deliver(1, "commit-then-throw"), ["crash-restart"], query];
	}
	if (row.scenario === "accepted-capacity") {
		const countDigest = row.capacityRejections.find((candidate) => candidate.kind === "accepted-count")
			?.digest as string;
		return [
			...Array.from({ length: 8190 }, (_, index) => deliver(index + 1)),
			["deliver", countDigest, "normal"],
			query,
		];
	}
	if (row.scenario === "pending-entry-capacity") {
		return [...Array.from({ length: 4097 }, (_, index) => deliver(index + 2)), deliver(1), redeliver(4098), query];
	}
	if (row.scenario === "wrong-scope-author-signature") {
		const rejectionOrder = [
			"wrong-object",
			"wrong-epoch",
			"wrong-anchor",
			"wrong-protocol",
			"unauthorized-author",
			"malformed-signature",
		] as const;
		return [
			...rejectionOrder.map(
				(classification) =>
					[
						"deliver",
						row.rejections.find((candidate) => candidate.classification === classification)?.digest as string,
						"normal",
					] as const
			),
			query,
		];
	}
	if (row.scenario === "multi-member-commitment") return [deliver(1), deliver(2), deliver(3), query];
	throw new TypeError(`unsupported standard real scenario ${row.scenario}`);
}

function rejectedDigests(row: Phase3ExitRealObservation): string[] {
	const anchor = decodeCanonical(row.exactCanonicalAnchorPreimageBytes) as Readonly<Record<string, unknown>>;
	expect(row.acceptedVertices).toHaveLength(1);
	const bootstrapDigest = row.acceptedVertices[0]?.digest as string;
	const expectedClasses = [
		"malformed-signature",
		"unauthorized-author",
		"wrong-anchor",
		"wrong-epoch",
		"wrong-object",
		"wrong-protocol",
	] as const;
	expect(row.rejections.map(({ classification }) => classification).sort()).toEqual([...expectedClasses].sort());
	for (const rejection of row.rejections) {
		expect(lowerHex(hashDomain("ts-drp/vertex/v3", rejection.exactCanonicalPreimageBytes))).toBe(rejection.digest);
		expect(occurrences(row.attemptedDigests, rejection.digest)).toBe(1);
		const vertex = decodeCanonical(rejection.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>;
		expect(vertex).toMatchObject({
			authorSequence: 0,
			dependencies: [bootstrapDigest],
			logicalTime: 2,
			operation: { action: "add", value: 2 },
		});
		if (rejection.classification === "unauthorized-author") expect(vertex.author).not.toBe(A1_AUTHOR);
		else expect(vertex.author).toBe(A1_AUTHOR);
		const signatureValid = ed25519.verify(
			rejection.detachedSignature,
			hexBytes(rejection.digest),
			hexBytes(vertex.author as string)
		);
		const failures = {
			"malformed-signature": !signatureValid,
			"unauthorized-author": !row.authorizedAuthors.includes(vertex.author as string),
			"wrong-anchor": vertex.anchor !== row.anchorDigest,
			"wrong-epoch": vertex.epoch !== anchor.epoch,
			"wrong-object": vertex.objectId !== anchor.objectId,
			"wrong-protocol": vertex.protocolMajor !== 3,
		};
		expect(
			Object.entries(failures)
				.filter(([, failed]) => failed)
				.map(([classification]) => classification)
		).toEqual([rejection.classification]);
	}
	return row.rejections.map(({ digest }) => digest);
}

function derivedTips(graph: ReadonlyMap<string, EpochVertex>, anchorDigest: string): string[] {
	const dependencies = new Set([...graph.values()].flatMap((vertex) => vertex.dependencies));
	return [...graph.keys()].filter((digest) => digest !== anchorDigest && !dependencies.has(digest)).sort();
}

function occurrences(values: readonly string[], selected: string): number {
	return values.filter((value) => value === selected).length;
}

function authenticateVertexEvidence(
	row: Pick<Phase3ExitRealObservation, "anchorDigest" | "authorizedAuthors" | "exactCanonicalAnchorPreimageBytes">,
	evidence: Readonly<{
		readonly detachedSignature: Uint8Array;
		readonly digest: string;
		readonly exactCanonicalPreimageBytes: Uint8Array;
	}>
): Readonly<Record<string, unknown>> {
	const anchor = decodeCanonical(row.exactCanonicalAnchorPreimageBytes) as Readonly<Record<string, unknown>>;
	expect(lowerHex(hashDomain("ts-drp/vertex/v3", evidence.exactCanonicalPreimageBytes))).toBe(evidence.digest);
	const vertex = decodeCanonical(evidence.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>;
	expect(vertex).toMatchObject({
		anchor: row.anchorDigest,
		epoch: anchor.epoch,
		kind: "drp-vertex",
		objectId: anchor.objectId,
		protocolMajor: 3,
	});
	expect(row.authorizedAuthors).toContain(vertex.author);
	expect(ed25519.verify(evidence.detachedSignature, hexBytes(evidence.digest), hexBytes(vertex.author as string))).toBe(
		true
	);
	return vertex;
}

interface LiveFixtureModule {
	createGenuinePreparedV3Fixture(options: Readonly<Record<string, unknown>>): Promise<
		Readonly<{
			readonly anchorDigest: string;
			readonly anchorPublicKey: Uint8Array;
			readonly authors: readonly string[];
			readonly detachedAnchorSignature: Uint8Array;
			readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
			readonly objectId: string;
			close(): Promise<void>;
			createRegisteredVertex(
				input: Readonly<{
					readonly anchor?: string;
					readonly authorSequence: number;
					readonly dependencies: readonly string[];
					readonly epoch?: number;
					readonly logicalTime: number;
					readonly objectId?: string;
					readonly operation: Readonly<Record<string, unknown>>;
					readonly privateKeySeedHex: string;
					readonly protocolMajor?: number;
				}>
			): Readonly<{
				readonly author: string;
				readonly canonicalPreimageBytes: Uint8Array;
				readonly digest: Uint8Array;
				readonly signature: Uint8Array;
			}>;
		}>
	>;
}

describe("Phase 3 exit-d bounded live-v3 graph/schedule model RED", () => {
	it("pins the exact ordinary topology corpus, schedule grammar, family counts and outcomes", () => {
		const started = performance.now();
		const corpus = enumerateCorpus(4);
		expect(corpus).toHaveLength(PHASE3_EXIT_ORDINARY_CORPUS_COUNT);
		expect(corpusHash(corpus)).toBe(PHASE3_EXIT_ORDINARY_CORPUS_SHA256);
		const schedules = enumeratePhase3ExitSchedules(4);
		expect(schedules).toHaveLength(PHASE3_EXIT_ORDINARY_SCHEDULE_COUNT);
		const evidence = phase3ExitScheduleEvidence(4);
		expect(evidence).toEqual({
			corpusCount: 10,
			corpusSha256: PHASE3_EXIT_ORDINARY_CORPUS_SHA256,
			familyCounts: {
				"accepted-duplicate": 135,
				"delivery": 47,
				"pending-crash": 9,
				"pending-duplicate": 9,
				"post-append-crash": 26,
			},
			outcomeSha256: PHASE3_EXIT_ORDINARY_OUTCOME_SHA256,
			scheduleCount: PHASE3_EXIT_ORDINARY_SCHEDULE_COUNT,
			scheduleSha256: PHASE3_EXIT_ORDINARY_SCHEDULE_SHA256,
		});
		for (const schedule of schedules) {
			expect(Object.isFrozen(schedule)).toBe(true);
			expect(JSON.stringify(schedule)).not.toContain("\n");
		}
		expect(performance.now() - started).toBeLessThan(10_000);
	});

	it("distinguishes entry, exact-wire-byte and release accounting with genuine redelivery", () => {
		const vertices = [
			modelVertex(0, []),
			modelVertex(1, [0]),
			modelVertex(2, [1], { canonicalPreimageByteCharge: 1, pendingWireByteCharge: 8 }),
			modelVertex(3, [1], { canonicalPreimageByteCharge: 1, pendingWireByteCharge: 8 }),
			modelVertex(4, [3], { canonicalPreimageByteCharge: 1, pendingWireByteCharge: 8 }),
		];
		const entryInput = modelInput(
			vertices,
			[
				["deliver", 2, "normal"],
				["deliver", 3, "normal"],
				["deliver", 1, "normal"],
				["redeliver", 3],
			],
			{ maxPendingEntries: 1 }
		);
		const entry = runPhase3ExitModel(entryInput);
		expect(entry.projection[0]).toEqual([0, 1, 2, 3]);
		expect(entry.droppedAscending).toEqual([3]);

		const byteInput = modelInput(
			vertices,
			[
				["deliver", 2, "normal"],
				["deliver", 3, "normal"],
			],
			{
				maxPendingBytes: 8,
			}
		);
		expect(runPhase3ExitModel(byteInput).projection[2]).toEqual([2]);
		expect(runPhase3ExitModel(byteInput, "charge-pending-from-canonical").projection[2]).toEqual([2, 3]);
		expect(runPhase3ExitModel(byteInput).projection[0]).toEqual([0]);
		expect(runPhase3ExitModel(byteInput, "count-pending-as-accepted").projection[0]).toEqual([0, 2]);

		const releaseInput = modelInput(
			vertices,
			[
				["deliver", 2, "normal"],
				["deliver", 1, "normal"],
				["deliver", 4, "normal"],
			],
			{ maxPendingBytes: 8 }
		);
		expect(runPhase3ExitModel(releaseInput).projection[2]).toEqual([4]);
		expect(runPhase3ExitModel(releaseInput, "subtract-no-pending-bytes").projection[2]).toEqual([]);
		expect(runPhase3ExitModel(releaseInput).projection[0]).toEqual([0, 1, 2]);
		expect(runPhase3ExitModel(releaseInput, "skip-pending-drain").projection[0]).toEqual([0, 1]);

		const redeliveryInput = modelInput(vertices, [
			["deliver", 2, "normal"],
			["crash-restart"],
			["redeliver", 2],
			["deliver", 1, "normal"],
		]);
		expect(runPhase3ExitModel(redeliveryInput).projection[0]).toEqual([0, 1, 2]);
		expect(runPhase3ExitModel(redeliveryInput, "omit-post-restart-redelivery").projection[0]).toEqual([0, 1]);
	});

	it("rechecks accepted capacity for each digest-sorted ready-wave member", () => {
		const vertices = [modelVertex(0, []), modelVertex(1, [0]), modelVertex(2, [1]), modelVertex(3, [1])];
		const input = modelInput(
			vertices,
			[
				["deliver", 3, "normal"],
				["deliver", 2, "normal"],
				["deliver", 1, "normal"],
			],
			{ maxAcceptedVertices: 4 }
		);
		const exact = runPhase3ExitModel(input);
		expect(exact.projection[0]).toEqual([0, 1, 2]);
		expect(exact.projection[3]).toEqual([1, 2]);
		expect(exact.droppedAscending).toEqual([3]);
		const once = runPhase3ExitModel(input, "wave-capacity-check-once");
		expect(once.acceptedVertexCount).toBe(5);
		expect(once.projection[0]).toEqual([0, 1, 2, 3]);
		const insertion = runPhase3ExitModel(modelInput(vertices, input.actions));
		const flawedInsertion = runPhase3ExitModel(modelInput(vertices, input.actions), "drain-in-insertion-order");
		expect(insertion.projection[3]).toEqual([1, 2, 3]);
		expect(flawedInsertion.projection[3]).toEqual([1, 3, 2]);

		const byteVertices = [
			modelVertex(0, [], { acceptedByteCharge: 1 }),
			modelVertex(1, [0], { acceptedByteCharge: 4 }),
			modelVertex(2, [0], { acceptedByteCharge: 4 }),
		];
		const byteFence = runPhase3ExitModel(
			modelInput(
				byteVertices,
				[
					["deliver", 1, "normal"],
					["deliver", 2, "normal"],
				],
				{ maxAcceptedBytes: 6 }
			)
		);
		expect(byteFence.projection[0]).toEqual([0, 1]);
		expect(byteFence.acceptedByteCharge).toBe(6);
		expect(byteFence.droppedAscending).toEqual([2]);
	});

	it("keeps pending volatile, rejects malformed authority and preserves durable post-append recovery", () => {
		const vertices = [
			modelVertex(0, []),
			modelVertex(1, [0]),
			modelVertex(2, [1]),
			modelVertex(3, [0], { scopeCurrent: false }),
			modelVertex(4, [0], { authorized: false }),
			modelVertex(5, [0], { malformed: true }),
		];
		const pendingCrash = modelInput(vertices, [["deliver", 2, "normal"], ["crash-restart"]]);
		expect(runPhase3ExitModel(pendingCrash).projection[2]).toEqual([]);
		expect(runPhase3ExitModel(pendingCrash, "retain-pending-across-restart").projection[2]).toEqual([2]);

		const invalid = runPhase3ExitModel(
			modelInput(vertices, [
				["deliver", 3, "normal"],
				["deliver", 4, "normal"],
				["deliver", 5, "normal"],
			])
		);
		expect(invalid.projection[0]).toEqual([0]);
		expect(invalid.projection[1]).toEqual([0]);
		expect(invalid.droppedAscending).toEqual([3, 4, 5]);

		const durable = runPhase3ExitModel(modelInput(vertices, [["deliver", 1, "commit-then-throw"], ["crash-restart"]]));
		expect(durable.projection[0]).toEqual([0, 1]);
		expect(durable.projection[1]).toEqual([0, 1]);
		expect(durable.projection[3]).toEqual([]);
		expect(durable.projection[4]).toEqual([0, 1]);
	});

	it("exposes one FIFO completion receipt per enqueue occurrence without message-identity reuse", async () => {
		const manager = new ObservedMessageQueueManager<object>({ logConfig: { level: "silent" } });
		const releases: Array<() => void> = [];
		manager.subscribe("", () => new Promise<void>((resolve) => releases.push(resolve)));
		const message = Object.freeze({ value: 1 });
		const firstPromise = manager.nextReceipt();
		const firstEnqueue = manager.enqueue("", message);
		const first = await firstPromise;
		expect(first.sequence).toBe(0);
		expect(first.settled).toBe(false);
		expect(await first.started).toBe(true);
		expect(first.handlerStarted).toBe(true);
		const secondPromise = manager.nextReceipt();
		const secondEnqueue = manager.enqueue("", message);
		const second = await secondPromise;
		expect(second.sequence).toBe(1);
		expect(second).not.toBe(first);
		expect(second.handlerStarted).toBe(false);
		expect(second.settled).toBe(false);
		(releases.shift() as () => void)();
		await first.processed;
		await firstEnqueue;
		expect(first.settled).toBe(true);
		expect(await second.started).toBe(true);
		expect(second.handlerStarted).toBe(true);
		expect(second.settled).toBe(false);
		(releases.shift() as () => void)();
		await second.processed;
		await secondEnqueue;
		expect(second.settled).toBe(true);

		manager.close("");
		const rejectedPromise = manager.nextReceipt();
		const rejectedEnqueue = manager.enqueue("", Object.freeze({ value: "closed" }));
		const rejected = await rejectedPromise;
		await expect(rejectedEnqueue).rejects.toThrow();
		expect(await rejected.started).toBe(false);
		await rejected.processed;
		expect(rejected.handlerStarted).toBe(false);
		expect(rejected.outcome).toBe("enqueue-rejected");
		expect(rejected.settled).toBe(true);
		const abandonedWaiter = manager.nextReceipt();
		manager.close("");
		await expect(abandonedWaiter).rejects.toThrow(/closed before the next occurrence/u);
		manager.subscribe("", () => Promise.resolve());
		const recreatedPromise = manager.nextReceipt();
		await manager.enqueue("", Object.freeze({ value: 2 }));
		const recreated = await recreatedPromise;
		expect(await recreated.started).toBe(true);
		await recreated.processed;
		expect(recreated.handlerStarted).toBe(true);
		expect(recreated.outcome).toBe("handler-settled");
		expect(recreated.settled).toBe(true);

		manager.close("");
		let releaseClosingHandler = (): void => undefined;
		manager.subscribe(
			"",
			() =>
				new Promise<void>((resolve) => {
					releaseClosingHandler = resolve;
				})
		);
		const closingPromise = manager.nextReceipt();
		void manager.enqueue("", Object.freeze({ value: 3 }));
		const closing = await closingPromise;
		expect(await closing.started).toBe(true);
		manager.close("");
		expect(closing.settled).toBe(false);
		manager.subscribe("", () => Promise.resolve());
		const replacementPromise = manager.nextReceipt();
		await manager.enqueue("", Object.freeze({ value: 4 }));
		const replacement = await replacementPromise;
		expect(await replacement.started).toBe(true);
		await replacement.processed;
		expect(replacement.outcome).toBe("handler-settled");
		releaseClosingHandler();
		await closing.processed;
		expect(closing.outcome).toBe("handler-settled");
		manager.closeAll();
	});

	it("pins the genuine fixture's closed author roster, empty history and arbitrary registered vertices", async () => {
		const fixtureModule = (await import(LIVE_FIXTURE_URL)) as LiveFixtureModule;
		const seedA = A0_SEED;
		const seedB = A1_SEED;
		const objectId = `creator:${"d".repeat(32)}`;
		const fixture = await fixtureModule.createGenuinePreparedV3Fixture({
			authorizedPrivateKeySeedHexes: [seedA, seedB],
			historyRoot: createHash("sha256").update(new Uint8Array()).digest("hex"),
			historySize: 0,
			objectId,
		});
		try {
			const authorA = A0_AUTHOR;
			const authorB = A1_AUTHOR;
			expect(fixture.objectId).toBe(objectId);
			expect(fixture.authors).toEqual([authorA, authorB].sort());
			expect(fixture.anchorDigest).toMatch(/^[0-9a-f]{64}$/u);
			expect(
				ed25519.verify(fixture.detachedAnchorSignature, hexBytes(fixture.anchorDigest), fixture.anchorPublicKey)
			).toBe(true);
			const anchor = decodeCanonical(fixture.exactCanonicalAnchorPreimageBytes) as Readonly<Record<string, unknown>>;
			expect(anchor).toMatchObject({
				historyRoot: createHash("sha256").update(new Uint8Array()).digest("hex"),
				historySize: 0,
			});
			const vertex = fixture.createRegisteredVertex({
				authorSequence: 0,
				dependencies: [fixture.anchorDigest],
				logicalTime: 2,
				operation: { action: "add", value: 2 },
				privateKeySeedHex: seedB,
			});
			expect(vertex.author).toBe(authorB);
			expect(vertex.canonicalPreimageBytes.byteLength).toBeGreaterThan(0);
			expect(vertex.digest).toHaveLength(32);
			expect(vertex.signature).toHaveLength(64);
			const decoded = decodeCanonical(vertex.canonicalPreimageBytes);
			expect(decoded).toEqual({
				anchor: fixture.anchorDigest,
				author: authorB,
				authorSequence: 0,
				dependencies: [fixture.anchorDigest],
				epoch: 0,
				kind: "drp-vertex",
				logicalTime: 2,
				objectId,
				operation: { action: "add", value: 2 },
				protocolMajor: 3,
			});
			expect(Buffer.from(hashDomain("ts-drp/vertex/v3", vertex.canonicalPreimageBytes)).toString("hex")).toBe(
				Buffer.from(vertex.digest).toString("hex")
			);
			expect(
				ed25519.verify(
					vertex.signature,
					vertex.digest,
					ed25519.getPublicKey(Uint8Array.from({ length: 32 }, () => 0x22))
				)
			).toBe(true);
			const hostileSeed = "33".repeat(32);
			const baseHostileInput = {
				authorSequence: 1,
				dependencies: [fixture.anchorDigest],
				logicalTime: 3,
				operation: { action: "add", value: 3 },
				privateKeySeedHex: seedB,
			};
			const hostileRows = [
				fixture.createRegisteredVertex({ ...baseHostileInput, objectId: `creator:${"e".repeat(32)}` }),
				fixture.createRegisteredVertex({ ...baseHostileInput, epoch: 1 }),
				fixture.createRegisteredVertex({ ...baseHostileInput, anchor: "f".repeat(64) }),
				fixture.createRegisteredVertex({ ...baseHostileInput, protocolMajor: 4 }),
				fixture.createRegisteredVertex({
					...baseHostileInput,
					authorSequence: 0,
					privateKeySeedHex: hostileSeed,
				}),
			];
			for (const hostile of hostileRows) {
				expect(ed25519.verify(hostile.signature, hostile.digest, hexBytes(hostile.author))).toBe(true);
			}
			expect(fixture.authors).not.toContain(hostileRows[4]?.author);
			const malformedSignature = new Uint8Array(vertex.signature);
			malformedSignature[0] = (malformedSignature[0] as number) ^ 0xff;
			expect(ed25519.verify(malformedSignature, vertex.digest, hexBytes(vertex.author))).toBe(false);
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(process.env.RUN_PHASE3_EXIT_MODEL_CERTIFICATION !== "true")(
		"runs the expanded 407-shape certification tier only when explicitly requested",
		() => {
			const corpus = enumerateCorpus(6);
			expect(corpus).toHaveLength(PHASE3_EXIT_CERTIFICATION_CORPUS_COUNT);
			expect(corpusHash(corpus)).toBe(PHASE3_EXIT_CERTIFICATION_CORPUS_SHA256);
			expect(phase3ExitScheduleEvidence(6)).toMatchObject({
				corpusCount: PHASE3_EXIT_CERTIFICATION_CORPUS_COUNT,
				corpusSha256: PHASE3_EXIT_CERTIFICATION_CORPUS_SHA256,
				outcomeSha256: PHASE3_EXIT_CERTIFICATION_OUTCOME_SHA256,
				scheduleCount: PHASE3_EXIT_CERTIFICATION_SCHEDULE_COUNT,
				scheduleSha256: PHASE3_EXIT_CERTIFICATION_SCHEDULE_SHA256,
			});
			const fenceVertices = [
				modelVertex(0, [], { acceptedByteCharge: 1 }),
				modelVertex(1, [0], { acceptedByteCharge: 4, pendingWireByteCharge: 8 }),
				modelVertex(2, [0], { acceptedByteCharge: 4, pendingWireByteCharge: 8 }),
			];
			const pendingFenceVertices = [
				modelVertex(0, [], { acceptedByteCharge: 1 }),
				modelVertex(1, [0], { acceptedByteCharge: 4, pendingWireByteCharge: 8 }),
				modelVertex(2, [1], { acceptedByteCharge: 4, pendingWireByteCharge: 8 }),
			];
			expect(
				runPhase3ExitModel(modelInput(fenceVertices, [["deliver", 1, "normal"]], { maxAcceptedVertices: 3 }))
					.projection[0]
			).toEqual([0, 1]);
			expect(
				runPhase3ExitModel(modelInput(fenceVertices, [["deliver", 1, "normal"]], { maxAcceptedVertices: 2 }))
					.projection[0]
			).toEqual([0]);
			expect(
				runPhase3ExitModel(modelInput(fenceVertices, [["deliver", 1, "normal"]], { maxAcceptedBytes: 6 })).projection[0]
			).toEqual([0, 1]);
			expect(
				runPhase3ExitModel(modelInput(fenceVertices, [["deliver", 1, "normal"]], { maxAcceptedBytes: 5 })).projection[0]
			).toEqual([0]);
			expect(
				runPhase3ExitModel(modelInput(pendingFenceVertices, [["deliver", 2, "normal"]], { maxPendingEntries: 1 }))
					.projection[2]
			).toEqual([2]);
			expect(
				runPhase3ExitModel(modelInput(pendingFenceVertices, [["deliver", 2, "normal"]], { maxPendingEntries: 0 }))
					.projection[2]
			).toEqual([]);
			expect(
				runPhase3ExitModel(modelInput(pendingFenceVertices, [["deliver", 2, "normal"]], { maxPendingBytes: 8 }))
					.projection[2]
			).toEqual([2]);
			expect(
				runPhase3ExitModel(modelInput(pendingFenceVertices, [["deliver", 2, "normal"]], { maxPendingBytes: 7 }))
					.projection[2]
			).toEqual([]);
		},
		180_000
	);

	it("requires the one genuine retained-integration driver and validates every named representative", async () => {
		const driver = await loadDriver();
		expect(driver?.runPhase3ExitDriver, "PHASE3_EXIT_DRIVER_READINESS").toBeTypeOf("function");
		if (driver === undefined) throw new TypeError("PHASE3_EXIT_DRIVER_READINESS");
		const result = await driver.runPhase3ExitDriver();
		expect(result.parameters).toEqual({
			maxDependencies: 16,
			maxEpochBytes: 8_388_608,
			maxEpochVertices: 8192,
			maxPendingBytes: 16_777_216,
			maxPendingEntries: 4096,
		});
		expect(result.observations.map((row) => row.scenario)).toEqual(PHASE3_EXIT_REAL_SCENARIOS);
		const graphByScenario = new Map<string, ReadonlyMap<string, EpochVertex>>();
		const orderByScenario = new Map<string, readonly string[]>();
		for (const row of result.observations) {
			const acceptedDigests = row.acceptedVertices.map(({ digest }) => digest);
			const tracedAttempts = row.actionTrace.flatMap((action) =>
				action[0] === "deliver" || action[0] === "redeliver" || action[0] === "issue-local" ? [action[1]] : []
			);
			expect(row.attemptedDigests).toEqual(tracedAttempts);
			expect(new Set(acceptedDigests).size).toBe(acceptedDigests.length);
			expect(new Set(row.journalDigests).size).toBe(row.journalDigests.length);
			expect([...row.journalDigests].sort()).toEqual([...acceptedDigests].sort());
			expect(row.replicaJournalDigests.length).toBeGreaterThan(0);
			for (const replica of row.replicaJournalDigests) {
				expect(new Set(replica).size).toBe(replica.length);
				expect([...replica].sort()).toEqual([...acceptedDigests].sort());
			}
			expect(new Set([...row.callbackDigests, ...row.recoveredDigests])).toEqual(new Set(acceptedDigests));
			expect(row.attemptedDigests.length).toBeGreaterThan(0);
			for (const rejected of [
				...row.droppedDigests.filter((digest) => !row.redeliveredDigests.includes(digest)),
				...row.rejections.map(({ digest }) => digest),
			]) {
				expect(acceptedDigests).not.toContain(rejected);
				expect(row.journalDigests).not.toContain(rejected);
				expect(row.callbackDigests).not.toContain(rejected);
				expect(row.recoveredDigests).not.toContain(rejected);
			}
			for (const retried of row.droppedDigests.filter((digest) => row.redeliveredDigests.includes(digest))) {
				expect(occurrences(row.attemptedDigests, retried)).toBe(2);
				expect(acceptedDigests).toContain(retried);
				expect(row.journalDigests).toContain(retried);
			}
			for (const issued of row.issuedVertices) {
				expect(issued.outboxDigest).toBe(issued.digest);
				expect(issued.journalDigest).toBe(issued.digest);
				expect(row.journalDigests).toContain(issued.digest);
				const issuedPreimage = authenticateVertexEvidence(row, issued);
				expect(issuedPreimage).toMatchObject({ author: issued.author, authorSequence: issued.authorSequence });
				const evidence = row.acceptedVertices.find(({ digest }) => digest === issued.digest);
				expect(evidence).toBeDefined();
				expect(issued.exactCanonicalPreimageBytes).toEqual(
					(evidence as NonNullable<typeof evidence>).exactCanonicalPreimageBytes
				);
				expect(issued.detachedSignature).toEqual((evidence as NonNullable<typeof evidence>).detachedSignature);
				const preimage = decodeCanonical(
					(evidence as NonNullable<typeof evidence>).exactCanonicalPreimageBytes
				) as Readonly<Record<string, unknown>>;
				expect(preimage).toMatchObject({ author: issued.author, authorSequence: issued.authorSequence });
			}
			expect(new Set(row.issuedVertices.map(({ author, authorSequence }) => `${author}:${authorSequence}`)).size).toBe(
				row.issuedVertices.length
			);
			const issuedDigests = new Set(row.issuedVertices.map(({ digest }) => digest));
			for (const vertex of row.acceptedVertices) {
				expect(vertex.source).toBe(issuedDigests.has(vertex.digest) ? "local-issued-journal" : "received-journal");
			}
			const graph = authenticatedGraph(row);
			const order = referenceOrder(graph);
			expect(order).toHaveLength(graph.size);
			expect(order[0]).toBe(row.anchorDigest);
			expect(new Set(order.slice(1))).toEqual(new Set(acceptedDigests));
			graphByScenario.set(row.scenario, graph);
			orderByScenario.set(row.scenario, order);
			expect(row.issuanceCrash === undefined).toBe(row.scenario !== "post-issuance-commit-crash");
		}
		for (const scenario of [
			"ready-forward",
			"complete-reverse",
			"sibling-permutation",
			"duplicate-before-release",
			"duplicate-after-acceptance",
			"volatile-pending-crash",
			"post-journal-append-crash",
			"accepted-capacity",
			"pending-entry-capacity",
			"wrong-scope-author-signature",
			"multi-member-commitment",
		] as const) {
			const row = result.observations.find((candidate) => candidate.scenario === scenario) as Phase3ExitRealObservation;
			const labels = standardLabelTable(row);
			const actualOrder = orderByScenario.get(scenario) as readonly string[];
			const orderedLabels = actualOrder.slice(1).map((digest) => labels.get(digest));
			expect(orderedLabels.every((label) => Number.isSafeInteger(label))).toBe(true);
			expect([...orderedLabels].sort((left, right) => (left as number) - (right as number))).toEqual(
				Array.from({ length: row.acceptedVertices.length }, (_, label) => label)
			);
			const attemptedAcceptedLabels = row.attemptedDigests
				.filter((digest) => labels.has(digest))
				.map((digest) => labels.get(digest) as number);
			expect(row.actionTrace).toEqual(expectedStandardActionTrace(row, labels));
			if (scenario === "ready-forward") expect(attemptedAcceptedLabels).toEqual([1, 2, 3]);
			if (scenario === "complete-reverse") expect(attemptedAcceptedLabels).toEqual([3, 2, 1]);
			if (scenario === "duplicate-before-release") expect(attemptedAcceptedLabels).toEqual([2, 2, 1]);
			if (scenario === "duplicate-after-acceptance") expect(attemptedAcceptedLabels).toEqual([1, 2, 2]);
			if (scenario === "volatile-pending-crash") expect(attemptedAcceptedLabels).toEqual([2, 2, 1]);
			if (scenario === "post-journal-append-crash") expect(attemptedAcceptedLabels).toEqual([1]);
			if (scenario === "accepted-capacity") {
				expect(attemptedAcceptedLabels).toEqual(Array.from({ length: 8190 }, (_, index) => index + 1));
			}
			if (scenario === "pending-entry-capacity") {
				expect(attemptedAcceptedLabels).toEqual([...Array.from({ length: 4097 }, (_, index) => index + 2), 1, 4098]);
			}
			if (scenario === "wrong-scope-author-signature") expect(attemptedAcceptedLabels).toEqual([]);
			if (scenario === "multi-member-commitment") expect(attemptedAcceptedLabels).toEqual([1, 2, 3]);
		}
		const byName = new Map(result.observations.map((row) => [row.scenario, row]));
		expect([...(byName.get("ready-forward")?.journalDigests ?? [])].sort()).toEqual(
			[...(byName.get("complete-reverse")?.journalDigests ?? [])].sort()
		);
		for (const scenario of ["ready-forward", "complete-reverse", "sibling-permutation"] as const) {
			expect((byName.get(scenario) as Phase3ExitRealObservation).acceptedVertices.length).toBeGreaterThanOrEqual(3);
		}
		expect((byName.get("sibling-permutation") as Phase3ExitRealObservation).replicaJournalDigests).toHaveLength(2);
		const acceptedAttemptOrder = (scenario: "complete-reverse" | "ready-forward"): string[] => {
			const row = byName.get(scenario) as Phase3ExitRealObservation;
			const accepted = new Set(row.acceptedVertices.map(({ digest }) => digest));
			return row.attemptedDigests.filter(
				(digest, index, values) => accepted.has(digest) && values.indexOf(digest) === index
			);
		};
		const readyJournalOrder = (orderByScenario.get("ready-forward") as readonly string[]).slice(1);
		const readyOrdinaryOrder = readyJournalOrder.slice(1);
		expect(acceptedAttemptOrder("ready-forward")).toEqual(readyOrdinaryOrder);
		expect((byName.get("ready-forward") as Phase3ExitRealObservation).journalDigests).toEqual(readyJournalOrder);
		expect((byName.get("ready-forward") as Phase3ExitRealObservation).callbackDigests).toEqual(readyOrdinaryOrder);
		const reverseJournalOrder = (orderByScenario.get("complete-reverse") as readonly string[]).slice(1);
		const reverseOrdinaryOrder = reverseJournalOrder.slice(1);
		expect(acceptedAttemptOrder("complete-reverse")).toEqual([...reverseOrdinaryOrder].reverse());
		expect((byName.get("complete-reverse") as Phase3ExitRealObservation).journalDigests).toEqual(reverseJournalOrder);
		expect((byName.get("complete-reverse") as Phase3ExitRealObservation).callbackDigests).toEqual(reverseOrdinaryOrder);
		expect(orderByScenario.get("sibling-permutation")?.length).toBeGreaterThan(3);
		const sibling = byName.get("sibling-permutation") as Phase3ExitRealObservation;
		const siblingLabels = standardLabelTable(sibling);
		const siblingDigest = (label: number): string =>
			[...siblingLabels].find(([, candidate]) => candidate === label)?.[0] as string;
		const siblingParent = siblingDigest(1);
		const siblingReadyWave = [siblingDigest(2), siblingDigest(3)].sort();
		const siblingExpectedJournal = [siblingDigest(0), siblingParent, ...siblingReadyWave];
		expect(sibling.attemptedDigests.filter((digest) => siblingLabels.has(digest))).toEqual(
			[...siblingReadyWave].reverse().concat(siblingParent)
		);
		expect(sibling.journalDigests).toEqual(siblingExpectedJournal);
		expect(sibling.callbackDigests).toEqual(siblingExpectedJournal.slice(1));
		for (const replica of sibling.replicaJournalDigests) expect(replica).toEqual(siblingExpectedJournal);
		expect(
			derivedTips(graphByScenario.get("sibling-permutation") as ReadonlyMap<string, EpochVertex>, sibling.anchorDigest)
		).toEqual(siblingReadyWave);

		for (const scenario of ["duplicate-before-release", "duplicate-after-acceptance"] as const) {
			const row = byName.get(scenario) as Phase3ExitRealObservation;
			const duplicate = row.attemptedDigests.find((digest) => occurrences(row.attemptedDigests, digest) > 1);
			expect(duplicate).toBeTypeOf("string");
			const duplicateVertex = (graphByScenario.get(scenario) as ReadonlyMap<string, EpochVertex>).get(
				duplicate as string
			) as EpochVertex;
			const firstDuplicate = row.attemptedDigests.indexOf(duplicate as string);
			const lastDuplicate = row.attemptedDigests.lastIndexOf(duplicate as string);
			const lastDependency = Math.max(
				...duplicateVertex.dependencies.map((dependency) => row.attemptedDigests.indexOf(dependency))
			);
			expect(
				scenario === "duplicate-before-release"
					? firstDuplicate < lastDependency && lastDuplicate < lastDependency
					: firstDuplicate > lastDependency && lastDuplicate > firstDuplicate
			).toBe(true);
			expect(new Set(row.callbackDigests).size).toBe(row.callbackDigests.length);
		}

		const volatile = byName.get("volatile-pending-crash") as Phase3ExitRealObservation;
		expect(volatile.redeliveredDigests.length).toBeGreaterThan(0);
		expect(volatile.redeliveredDigests.some((digest) => volatile.journalDigests.includes(digest))).toBe(true);

		const journalCrash = byName.get("post-journal-append-crash") as Phase3ExitRealObservation;
		expect(journalCrash.recoveredDigests.some((digest) => !journalCrash.callbackDigests.includes(digest))).toBe(true);
		const issuanceCrash = byName.get("post-issuance-commit-crash") as Phase3ExitRealObservation;
		expect(issuanceCrash.recoveredDigests.some((digest) => !issuanceCrash.callbackDigests.includes(digest))).toBe(true);
		expect(issuanceCrash.issuedVertices.map(({ authorSequence }) => authorSequence)).toEqual([0, 1]);
		expect(issuanceCrash.issuedVertices.map(({ author }) => author)).toEqual([A0_AUTHOR, A0_AUTHOR]);
		const issuanceBootstrap = issuanceCrash.issuedVertices[0] as (typeof issuanceCrash.issuedVertices)[number];
		const issuanceCandidate = issuanceCrash.issuedVertices[1] as (typeof issuanceCrash.issuedVertices)[number];
		expect(authenticateVertexEvidence(issuanceCrash, issuanceBootstrap)).toMatchObject({
			author: A0_AUTHOR,
			authorSequence: 0,
			dependencies: [issuanceCrash.anchorDigest],
			logicalTime: 1,
			operation: { action: "add", value: 1 },
		});
		expect(authenticateVertexEvidence(issuanceCrash, issuanceCandidate)).toMatchObject({
			author: A0_AUTHOR,
			authorSequence: 1,
			dependencies: [issuanceBootstrap.digest],
			logicalTime: 2,
			operation: { action: "add", value: 2 },
		});
		expect(occurrences(issuanceCrash.attemptedDigests, issuanceCandidate.digest)).toBe(1);
		expect(issuanceCrash.actionTrace).toEqual([
			["issue-local", issuanceCandidate.digest],
			["crash-restart"],
			["query-commitment"],
		]);
		const issuanceCrashEvidence = issuanceCrash.issuanceCrash as NonNullable<
			Phase3ExitRealObservation["issuanceCrash"]
		>;
		expect(issuanceCrashEvidence.preCrashOutboxVertices).toHaveLength(1);
		const preCrashOutbox = issuanceCrashEvidence
			.preCrashOutboxVertices[0] as (typeof issuanceCrashEvidence.preCrashOutboxVertices)[number];
		const preCrashOutboxVertex = authenticateVertexEvidence(issuanceCrash, preCrashOutbox);
		expect(preCrashOutbox.publishState).toBe("pending");
		expect(preCrashOutbox).toMatchObject({
			author: issuanceCandidate.author,
			authorSequence: issuanceCandidate.authorSequence,
			digest: issuanceCandidate.digest,
		});
		expect(preCrashOutbox.exactCanonicalPreimageBytes).toEqual(issuanceCandidate.exactCanonicalPreimageBytes);
		expect(preCrashOutbox.detachedSignature).toEqual(issuanceCandidate.detachedSignature);
		expect(preCrashOutboxVertex).toMatchObject({
			author: preCrashOutbox.author,
			authorSequence: preCrashOutbox.authorSequence,
		});
		expect(issuanceCrashEvidence.preCrashJournalDigests).toEqual([issuanceBootstrap.digest]);
		expect(issuanceCrashEvidence.preCrashCallbackDigests).toEqual([]);
		expect(issuanceCrashEvidence.postRecoveryJournalDigests).toEqual(issuanceCrash.journalDigests);
		expect(occurrences(issuanceCrashEvidence.postRecoveryJournalDigests, preCrashOutbox.digest)).toBe(1);
		expect(occurrences(issuanceCrash.recoveredDigests, preCrashOutbox.digest)).toBe(1);
		expect(
			issuanceCrash.issuedVertices.filter(
				({ author, authorSequence, digest }) =>
					author === preCrashOutbox.author &&
					authorSequence === preCrashOutbox.authorSequence &&
					digest === preCrashOutbox.digest
			)
		).toHaveLength(1);
		expect(
			issuanceCrash.acceptedVertices.find(({ digest }) => digest === preCrashOutbox.digest)?.exactCanonicalPreimageBytes
		).toEqual(preCrashOutbox.exactCanonicalPreimageBytes);

		const local = byName.get("local-issue-release") as Phase3ExitRealObservation;
		expect(local.issuedVertices.map(({ authorSequence }) => authorSequence)).toEqual([0, 1]);
		expect(local.issuedVertices.map(({ author }) => author)).toEqual([A0_AUTHOR, A0_AUTHOR]);
		const bootstrapDigest = local.issuedVertices[0]?.digest as string;
		const bootstrapEvidence = local.acceptedVertices.find(({ digest }) => digest === bootstrapDigest);
		const bootstrapPreimage = decodeCanonical(
			(bootstrapEvidence as NonNullable<typeof bootstrapEvidence>).exactCanonicalPreimageBytes
		) as Readonly<Record<string, unknown>>;
		expect(bootstrapPreimage).toMatchObject({
			author: A0_AUTHOR,
			authorSequence: 0,
			dependencies: [local.anchorDigest],
			logicalTime: 1,
			operation: { action: "add", value: 1 },
		});
		const localDigest = local.issuedVertices[1]?.digest as string;
		expect(local.localIssue).toEqual(
			expect.objectContaining({
				actualDigest: localDigest,
				author: A0_AUTHOR,
				authorSequence: 1,
				logicalTime: 3,
				operation: { action: "add", value: 3 },
				preflightSignerDigests: [localDigest],
			})
		);
		const localGraph = graphByScenario.get("local-issue-release") as ReadonlyMap<string, EpochVertex>;
		const localVertex = localGraph.get(localDigest) as EpochVertex;
		const localByValue = new Map<
			number,
			Readonly<{ readonly digest: string; readonly vertex: Readonly<Record<string, unknown>> }>
		>();
		for (const evidence of local.acceptedVertices) {
			const vertex = decodeCanonical(evidence.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>;
			const operation = vertex.operation as Readonly<Record<string, unknown>>;
			expect(operation.action).toBe("add");
			expect(Number.isSafeInteger(operation.value)).toBe(true);
			expect(localByValue.has(operation.value as number)).toBe(false);
			localByValue.set(operation.value as number, Object.freeze({ digest: evidence.digest, vertex }));
			expect(operation.action).not.toBe("causalJoin");
		}
		expect([...localByValue.keys()].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5]);
		const localEntry = (
			value: number
		): Readonly<{ readonly digest: string; readonly vertex: Readonly<Record<string, unknown>> }> =>
			localByValue.get(value) as Readonly<{
				readonly digest: string;
				readonly vertex: Readonly<Record<string, unknown>>;
			}>;
		const bootstrap = localEntry(1);
		const siblingA = localEntry(2);
		const issuedLocal = localEntry(3);
		const siblingC = localEntry(4);
		const releasedChild = localEntry(5);
		expect(bootstrap.digest).toBe(bootstrapDigest);
		expect(issuedLocal.digest).toBe(localDigest);
		expect(bootstrap.vertex.dependencies).toEqual([local.anchorDigest]);
		expect(siblingA.vertex.dependencies).toEqual([bootstrap.digest]);
		expect(siblingC.vertex.dependencies).toEqual([bootstrap.digest]);
		expect(siblingA.vertex).toMatchObject({
			author: A1_AUTHOR,
			authorSequence: 0,
			logicalTime: 2,
			operation: { action: "add", value: 2 },
		});
		expect(siblingC.vertex).toMatchObject({
			author: A1_AUTHOR,
			authorSequence: 1,
			logicalTime: 4,
			operation: { action: "add", value: 4 },
		});
		expect([...(issuedLocal.vertex.dependencies as readonly string[])].sort()).toEqual(
			[siblingA.digest, siblingC.digest].sort()
		);
		expect(releasedChild.vertex.dependencies).toEqual([issuedLocal.digest]);
		expect(releasedChild.vertex).toMatchObject({
			author: A1_AUTHOR,
			authorSequence: 2,
			logicalTime: 5,
			operation: { action: "add", value: 5 },
		});
		expect(local.attemptedDigests).toEqual([
			siblingA.digest,
			siblingC.digest,
			releasedChild.digest,
			issuedLocal.digest,
		]);
		expect(local.actionTrace).toEqual([
			["deliver", siblingA.digest, "normal"],
			["deliver", siblingC.digest, "normal"],
			["deliver", releasedChild.digest, "normal"],
			["issue-local", issuedLocal.digest],
			["query-commitment"],
		]);
		const localSlots = local.acceptedVertices.map((evidence) => {
			const vertex = decodeCanonical(evidence.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>;
			return `${String(vertex.author)}:${String(vertex.authorSequence)}`;
		});
		expect(new Set(localSlots).size).toBe(localSlots.length);
		expect(
			local.acceptedVertices
				.map((evidence) => decodeCanonical(evidence.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>)
				.filter(({ author }) => author === A1_AUTHOR)
				.map(({ authorSequence }) => authorSequence)
				.sort((left, right) => (left as number) - (right as number))
		).toEqual([0, 1, 2]);
		const localEvidence = local.acceptedVertices.find(({ digest }) => digest === localDigest);
		const localPreimage = decodeCanonical(
			(localEvidence as NonNullable<typeof localEvidence>).exactCanonicalPreimageBytes
		) as Readonly<Record<string, unknown>>;
		expect(localPreimage).toMatchObject({
			author: A0_AUTHOR,
			authorSequence: 1,
			dependencies: [siblingA.digest, siblingC.digest].sort(),
			logicalTime: 3,
			operation: { action: "add", value: 3 },
		});
		const preIssueGraph = new Map(localGraph);
		preIssueGraph.delete(issuedLocal.digest);
		preIssueGraph.delete(releasedChild.digest);
		expect(derivedTips(preIssueGraph, local.anchorDigest)).toEqual([siblingA.digest, siblingC.digest].sort());
		expect(localVertex.dependencies).toEqual([siblingA.digest, siblingC.digest].sort());
		expect(local.localIssue?.effectEvents).toEqual(
			["issuance-committed", "outbox-observed", "journal-appended", "accepted-observed", "callback-observed"].map(
				(kind, sequence) => Object.freeze({ digest: localDigest, kind, sequence })
			)
		);
		expect(local.issuedVertices.filter(({ digest }) => digest === localDigest)).toHaveLength(1);
		expect(local.journalDigests).toContain(localDigest);
		expect(local.callbackDigests).toContain(localDigest);
		const releasedChildren = [...localGraph.values()].filter(
			(vertex) => vertex.hash !== localDigest && vertex.dependencies.includes(localDigest)
		);
		expect(releasedChildren).toHaveLength(1);
		expect(local.localIssue?.releasedChildDigest).toBe(releasedChild.digest);
		expect(releasedChildren[0]?.hash).toBe(releasedChild.digest);
		expect(local.callbackDigests).toContain(releasedChild.digest);
		for (const row of result.observations.filter(({ scenario }) => scenario !== "local-issue-release")) {
			expect(row.localIssue).toBeUndefined();
		}

		const acceptedCapacity = byName.get("accepted-capacity") as Phase3ExitRealObservation;
		expect(acceptedCapacity.acceptedVertices).toHaveLength(result.parameters.maxEpochVertices - 1);
		expect(acceptedCapacity.capacityRejections.map(({ kind }) => kind)).toEqual(["accepted-count"]);
		const acceptedCountRejection = acceptedCapacity
			.capacityRejections[0] as (typeof acceptedCapacity.capacityRejections)[number];
		const acceptedCountCandidate = authenticateVertexEvidence(acceptedCapacity, acceptedCountRejection);
		const acceptedCapacitySlots = new Set(
			acceptedCapacity.acceptedVertices.map((evidence) => {
				const vertex = decodeCanonical(evidence.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>;
				return `${String(vertex.author)}:${String(vertex.authorSequence)}`;
			})
		);
		expect(
			acceptedCapacitySlots.has(
				`${String(acceptedCountCandidate.author)}:${String(acceptedCountCandidate.authorSequence)}`
			)
		).toBe(false);
		const independentlyCountedVertices = 1 + acceptedCapacity.acceptedVertices.length;
		const independentlyChargedBytes =
			acceptedCapacity.exactCanonicalAnchorPreimageBytes.byteLength +
			acceptedCapacity.acceptedVertices.reduce(
				(total, evidence) => total + evidence.exactCanonicalPreimageBytes.byteLength,
				0
			);
		expect(acceptedCountRejection.acceptedVertexCountBefore).toBe(independentlyCountedVertices);
		expect(acceptedCountRejection.acceptedByteChargeBefore).toBe(independentlyChargedBytes);
		expect(acceptedCountRejection.candidateByteCharge).toBe(
			acceptedCountRejection.exactCanonicalPreimageBytes.byteLength
		);
		expect(acceptedCountRejection.acceptedVertexCountBefore).toBe(result.parameters.maxEpochVertices);
		expect(
			acceptedCountRejection.acceptedByteChargeBefore + acceptedCountRejection.candidateByteCharge
		).toBeLessThanOrEqual(result.parameters.maxEpochBytes);
		expect(acceptedCountCandidate).toMatchObject({
			author: A1_AUTHOR,
			authorSequence: 8190,
			dependencies: [digestForLabel(standardLabelTable(acceptedCapacity), 8190)],
			logicalTime: 8192,
			operation: { action: "add", value: 8192 },
		});
		expect(acceptedCapacity.droppedDigests).toEqual([acceptedCountRejection.digest]);
		expect(occurrences(acceptedCapacity.attemptedDigests, acceptedCountRejection.digest)).toBe(1);
		expect(acceptedCapacity.journalDigests).not.toContain(acceptedCountRejection.digest);
		for (const row of result.observations.filter(({ scenario }) => scenario !== "accepted-capacity")) {
			expect(row.capacityRejections).toEqual([]);
		}
		const pendingCapacity = byName.get("pending-entry-capacity") as Phase3ExitRealObservation;
		const pendingLabels = standardLabelTable(pendingCapacity);
		const pendingDigest = (label: number): string =>
			[...pendingLabels].find(([, candidate]) => candidate === label)?.[0] as string;
		const dependencyDigest = pendingDigest(1);
		const parkedDigests = Array.from({ length: result.parameters.maxPendingEntries }, (_, index) =>
			pendingDigest(index + 2)
		);
		const overflowDigest = pendingDigest(result.parameters.maxPendingEntries + 2);
		expect(pendingCapacity.droppedDigests).toEqual([overflowDigest]);
		expect(pendingCapacity.redeliveredDigests).toEqual([overflowDigest]);
		expect(occurrences(pendingCapacity.attemptedDigests, overflowDigest)).toBe(2);
		expect(pendingCapacity.attemptedDigests).toEqual([
			...parkedDigests,
			overflowDigest,
			dependencyDigest,
			overflowDigest,
		]);
		const drainedWave = [...parkedDigests].sort();
		const expectedPendingJournal = [pendingDigest(0), dependencyDigest, ...drainedWave, overflowDigest];
		expect(pendingCapacity.journalDigests).toEqual(expectedPendingJournal);
		expect(pendingCapacity.callbackDigests).toEqual(expectedPendingJournal.slice(1));
		for (const replica of pendingCapacity.replicaJournalDigests) expect(replica).toEqual(expectedPendingJournal);
		expect(pendingCapacity.acceptedVertices.map(({ digest }) => digest)).toContain(overflowDigest);

		const hostile = byName.get("wrong-scope-author-signature") as Phase3ExitRealObservation;
		expect(rejectedDigests(hostile)).toHaveLength(6);
		for (const row of result.observations.filter(({ scenario }) => scenario !== "wrong-scope-author-signature")) {
			expect(row.rejections).toEqual([]);
		}

		const commitmentRow = byName.get("multi-member-commitment") as Phase3ExitRealObservation;
		const commitmentGraph = graphByScenario.get("multi-member-commitment") as ReadonlyMap<string, EpochVertex>;
		const commitmentTips = derivedTips(commitmentGraph, commitmentRow.anchorDigest);
		expect(commitmentTips.length).toBeGreaterThan(1);
		const commitment = await deriveCloseSetHistoryCommitment({
			authenticatedCanonicalPreimageByteLengths: new Map(
				commitmentRow.acceptedVertices.map((vertex) => [vertex.digest, vertex.authenticatedCanonicalPreimageByteLength])
			),
			exactCanonicalEpochAnchorPreimageBytes: commitmentRow.exactCanonicalAnchorPreimageBytes,
			frontier: commitmentTips,
			maxEpochBytes: result.parameters.maxEpochBytes,
			maxEpochVertices: result.parameters.maxEpochVertices,
			previousHistorySnapshot: new CompactMerkleAccumulator().snapshot(),
			vertices: commitmentGraph,
		});
		expect(commitment.closeSetOrder).toEqual(
			(orderByScenario.get("multi-member-commitment") as readonly string[]).slice(1)
		);
	});
});
