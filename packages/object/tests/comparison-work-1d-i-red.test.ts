/* eslint-disable @typescript-eslint/no-non-null-assertion -- positive controls narrow required snapshots and vertices */
import { type DRPState, type IDRP, SemanticsType } from "@ts-drp/types";
import { serializedValuesEqual, serializeValue } from "@ts-drp/utils/serialization";
import { cloneDeep } from "es-toolkit";
import { deepEqual } from "fast-equals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { createPublicationCapability, type PublicationCapability } from "../src/publication/copy-capability.js";
import { PublicationPublisher, type PublicationRecord } from "../src/publication/publisher.js";
import { DRPObjectStateManager } from "../src/state.js";

type ComparisonPhase = "applier-candidacy" | "proxy-tracking" | "publisher-capture" | "publisher-override";
type SnapshotSide = "acl" | "drp";

interface ComparisonCounters {
	comparisonCalls: number;
	recursiveNodeVisits: number;
	recursiveEdgeVisits: number;
	mapEntriesVisited: number;
	setEntriesVisited: number;
	codecPasses: number;
	encodeCalls: number;
	encodedBytes: number;
}

interface ComparisonMetadata {
	publicationId: string;
	phase: ComparisonPhase;
	side: SnapshotSide;
	key: string;
}

interface ComparisonEvent {
	type: "comparison";
	metadata: ComparisonMetadata;
	pair: { left: unknown; right: unknown };
	counters: ComparisonCounters;
	result: boolean;
}

type ObserverEvent =
	| ComparisonEvent
	| { type: "copy"; value: unknown; metadata: unknown }
	| { type: "publication"; record: PublicationRecord };

type MeteredCapability = Omit<PublicationCapability, "equal"> & {
	equal(left: unknown, right: unknown, metadata?: ComparisonMetadata): boolean;
};

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const OBJECT_SOURCE = path.resolve(TEST_DIRECTORY, "../src");
const ROOT_HASH = HashGraph.rootHash;

function bytesEqual(left: unknown, right: unknown): boolean {
	const leftBytes = serializeValue(left);
	const rightBytes = serializeValue(right);
	return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function outcome(fn: () => boolean): { result?: boolean; thrown?: unknown } {
	try {
		return { result: fn() };
	} catch (thrown) {
		return { thrown };
	}
}

function expectSameOutcome(
	actual: ReturnType<typeof outcome>,
	expected: ReturnType<typeof outcome>,
	name: string,
	primary?: unknown
): void {
	expect(actual.result, name).toBe(expected.result);
	if (expected.thrown === undefined) {
		expect(actual.thrown, name).toBeUndefined();
		return;
	}
	if (expected.thrown === primary) {
		expect(actual.thrown, name).toBe(primary);
		return;
	}
	expect(actual.thrown, name).toBeInstanceOf((expected.thrown as Error).constructor);
	expect(actual.thrown, name).toMatchObject({
		name: (expected.thrown as Error).name,
		message: (expected.thrown as Error).message,
	});
}

function comparisonEvents(events: readonly ObserverEvent[]): ComparisonEvent[] {
	return events.filter((event): event is ComparisonEvent => event.type === "comparison");
}

function meteredCapability(events: ObserverEvent[], comparisonObserverResult: unknown = undefined): MeteredCapability {
	return createPublicationCapability((event: ObserverEvent): unknown => {
		events.push(event);
		if (event.type === "copy") return cloneDeep(event.value);
		if (event.type === "comparison") return comparisonObserverResult;
	}) as MeteredCapability;
}

function publication(metadata: Partial<PublicationRecord> = {}): PublicationRecord {
	return {
		publicationId: "vertex-1",
		kind: "vertex",
		mode: "incremental",
		outcome: "published",
		baselineHashes: [ROOT_HASH],
		frontier: [ROOT_HASH],
		changed: { acl: [], drp: [] },
		...metadata,
	};
}

function publisher(capability: PublicationCapability): PublicationPublisher<IDRP> {
	return new PublicationPublisher({} as never, capability);
}

function state(entries: Readonly<Record<string, unknown>>): DRPState {
	return { state: Object.entries(entries).map(([key, value]) => ({ key, value })) };
}

function capture(
	baselineEntries: Readonly<Record<string, unknown>>,
	target: IDRP | undefined,
	candidates: ReadonlySet<string> | undefined,
	incremental = true,
	comparisonObserverResult: unknown = undefined
): { events: ObserverEvent[]; record: PublicationRecord; snapshot: DRPState } {
	const events: ObserverEvent[] = [];
	const record = publication({ mode: incremental ? "incremental" : "fallback" });
	const snapshot = publisher(meteredCapability(events, comparisonObserverResult)).capturePublishedState(
		"drp",
		target,
		state(baselineEntries),
		record,
		incremental,
		candidates
	);
	return { events, record, snapshot };
}

function counterShape(event: ComparisonEvent): void {
	expect(event).toEqual({
		type: "comparison",
		metadata: expect.objectContaining({
			publicationId: expect.any(String),
			phase: expect.any(String),
			side: expect.stringMatching(/^(acl|drp)$/),
			key: expect.any(String),
		}),
		pair: { left: expect.anything(), right: expect.anything() },
		counters: {
			comparisonCalls: 1,
			recursiveNodeVisits: expect.any(Number),
			recursiveEdgeVisits: expect.any(Number),
			mapEntriesVisited: expect.any(Number),
			setEntriesVisited: expect.any(Number),
			codecPasses: expect.any(Number),
			encodeCalls: expect.any(Number),
			encodedBytes: expect.any(Number),
		},
		result: expect.any(Boolean),
	});
	for (const value of Object.values(event.counters)) {
		expect(Number.isSafeInteger(value)).toBe(true);
		expect(value).toBeGreaterThanOrEqual(0);
	}
}

function observedComparison(left: unknown, right: unknown, key = "payload"): ComparisonEvent {
	const events: ObserverEvent[] = [];
	const capability = meteredCapability(events);
	capability.equal(left, right, {
		publicationId: "matrix-1",
		phase: "publisher-capture",
		side: "drp",
		key,
	});
	const comparisons = comparisonEvents(events);
	expect(comparisons).toHaveLength(1);
	return comparisons[0]!;
}

class CandidateDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	ballast = { stable: true };
	nested = { value: 1 };
	replacement = "old";
	ordered = new Map([
		["a", 1],
		["b", 2],
	]);
	removable?: string = "present";
	declare added?: string;

	replace(): void {
		this.replacement = "new";
	}
	add(): void {
		this.added = "new";
	}
	remove(): void {
		delete this.removable;
	}
	reorder(): void {
		this.ordered = new Map([...this.ordered].reverse());
	}
}

function applierHarness(): {
	applier: DRPVertexApplier<CandidateDRP>;
	drp: CandidateDRP;
	events: ObserverEvent[];
	hashGraph: HashGraph;
	states: DRPObjectStateManager<CandidateDRP>;
} {
	const drp = new CandidateDRP();
	const acl = createACL({ admins: ["local"] });
	const hashGraph = new HashGraph("local", acl.resolveConflicts?.bind(acl), undefined, drp.semanticsType);
	const states = new DRPObjectStateManager(acl, drp);
	const events: ObserverEvent[] = [];
	const options = {
		drp,
		acl,
		hashGraph,
		states,
		finalityStore: new FinalityStore(),
		notify: (): void => {},
		publicationObserver: (event: ObserverEvent): unknown => {
			events.push(event);
			return event.type === "copy" ? cloneDeep(event.value) : undefined;
		},
	};
	return { applier: new DRPVertexApplier(options), drp, events, hashGraph, states };
}

function latestChangedKey(harness: ReturnType<typeof applierHarness>): string[] {
	const vertex = [...harness.hashGraph.vertices.values()].at(-1)!;
	const record = harness.events.find(
		(event): event is Extract<ObserverEvent, { type: "publication" }> =>
			event.type === "publication" && event.record.targetHash === vertex.hash
	)?.record;
	expect(record).toBeDefined();
	return [...(record?.changed.drp ?? [])];
}

function countedObject(value: number, work: { visits: number }): object {
	return Object.defineProperty({}, "value", {
		enumerable: true,
		get(): number {
			work.visits++;
			return value;
		},
	});
}

function currentReorderedWork(kind: "Map" | "Set", size: number): number {
	const work = { visits: 0 };
	const leftValues = Array.from({ length: size }, (_, index) => countedObject(index, work));
	const rightValues = Array.from({ length: size }, (_, index) => countedObject(index, work)).reverse();
	const left = kind === "Map" ? new Map(leftValues.map((value, index) => [value, index])) : new Set(leftValues);
	const right =
		kind === "Map" ? new Map(rightValues.map((value, index) => [value, size - index - 1])) : new Set(rightValues);
	expect(deepEqual(left, right)).toBe(true);
	return work.visits;
}

const DIRECT_EQUALITY_FILES = [
	"drp-applier.ts",
	"proxy.ts",
	"publication/copy-capability.ts",
	"publication/publisher.ts",
] as const;

const DIRECT_EQUALITY_TOKENS = [
	'from "fast-equals"',
	"serializedValuesEqual",
	"serializeValue",
	'from "@msgpack/msgpack"',
	"JSON.stringify",
	"JSON.parse",
	"fingerprint",
	"byteCache",
] as const;

function directEqualityCensus(sources: Readonly<Record<string, string>>): string[] {
	const sites: string[] = [];
	for (const [sourcePath, source] of Object.entries(sources)) {
		for (const [index, line] of source.split("\n").entries()) {
			for (const token of DIRECT_EQUALITY_TOKENS) {
				if (line.includes(token)) sites.push(`${sourcePath}:${index + 1}:${token}`);
			}
		}
	}
	return sites.sort();
}

function governedEqualitySources(): Record<string, string> {
	return Object.fromEntries(
		DIRECT_EQUALITY_FILES.map((sourcePath) => [
			sourcePath,
			fs.readFileSync(path.join(OBJECT_SOURCE, sourcePath), "utf8"),
		])
	);
}

describe("Phase 1d(i) D.92.3-P1 single linear comparison authority RED", () => {
	it("emits the complete counter schema for the exact compared phase/side/key/value pair", () => {
		const left = { nested: [1, 2, 3] };
		const right = { nested: [1, 2, 3] };
		const event = observedComparison(left, right);
		counterShape(event);
		expect(event.metadata).toEqual({
			publicationId: "matrix-1",
			phase: "publisher-capture",
			side: "drp",
			key: "payload",
		});
		expect(event.pair).toEqual({ left, right });
	});

	it("performs exactly one semantic traversal and event for each candidate baseline pair (kills duplicate-walk)", () => {
		const left = { value: 1 };
		const right = { value: 1 };
		const { events, record } = capture(
			{ payload: left },
			{ semanticsType: SemanticsType.pair, payload: right },
			new Set(["payload"])
		);
		const comparisons = comparisonEvents(events);
		expect(comparisons).toHaveLength(1);
		expect(comparisons[0]?.metadata).toEqual({
			publicationId: record.publicationId,
			phase: "publisher-capture",
			side: "drp",
			key: "payload",
		});
		expect(comparisons[0]?.counters.comparisonCalls).toBe(1);
	});

	it.each([
		["addition", {}, { semanticsType: SemanticsType.pair, added: 1 }, new Set(["added"]), true],
		["deletion", { removed: 1 }, { semanticsType: SemanticsType.pair }, new Set(["removed"]), true],
		["non-candidate", { stable: 1 }, { semanticsType: SemanticsType.pair, stable: 1 }, new Set(), true],
		["fallback", { stable: 1 }, { semanticsType: SemanticsType.pair, stable: 1 }, undefined, false],
	] as const)("does zero comparison work for the %s path", (_name, baseline, target, candidates, incremental) => {
		const { events } = capture(baseline, target, candidates as ReadonlySet<string> | undefined, incremental);
		expect(comparisonEvents(events)).toEqual([]);
	});

	it("keeps outcomes, bytes, changed sets and copying independent of observer returns (kills observer-controls-result and counter-free relocation)", () => {
		const equalEvents: ObserverEvent[] = [];
		const unequalEvents: ObserverEvent[] = [];
		const equal = meteredCapability(equalEvents, false).equal(
			{ a: 1 },
			{ a: 1 },
			{
				publicationId: "observer-equal",
				phase: "publisher-capture",
				side: "drp",
				key: "a",
			}
		);
		const unequal = meteredCapability(unequalEvents, true).equal(
			{ a: 1 },
			{ a: 2 },
			{
				publicationId: "observer-unequal",
				phase: "publisher-capture",
				side: "drp",
				key: "a",
			}
		);
		expect({ equal, unequal }).toEqual({ equal: true, unequal: false });
		expect(comparisonEvents(equalEvents)).toHaveLength(1);
		expect(comparisonEvents(unequalEvents)).toHaveLength(1);
		const falsePublication = capture(
			{ semanticsType: SemanticsType.pair, payload: { value: 1 } },
			{ semanticsType: SemanticsType.pair, payload: { value: 1 } },
			new Set(["payload"]),
			true,
			false
		);
		const truePublication = capture(
			{ semanticsType: SemanticsType.pair, payload: { value: 1 } },
			{ semanticsType: SemanticsType.pair, payload: { value: 1 } },
			new Set(["payload"]),
			true,
			true
		);
		expect(serializeValue(falsePublication.snapshot)).toEqual(serializeValue(truePublication.snapshot));
		expect(falsePublication.record.changed).toEqual(truePublication.record.changed);
		expect(falsePublication.events.filter(({ type }) => type === "copy")).toHaveLength(0);
		expect(truePublication.events.filter(({ type }) => type === "copy")).toHaveLength(0);
	});

	it("records deterministic pre-corrective quadratic Map and Set work at N/2N/4N", () => {
		const sizes = [8, 16, 32];
		for (const kind of ["Map", "Set"] as const) {
			const visits = sizes.map((size) => currentReorderedWork(kind, size));
			expect(visits).toEqual([72, 272, 1056]);
			expect(visits[1]! / visits[0]!).toBeGreaterThan(3.7);
			expect(visits[2]! / visits[1]!).toBeGreaterThan(3.8);
			expect(visits[2]! / visits[0]!).toBeGreaterThan(14);
		}
	});

	it.each(["Map", "Set"] as const)(
		"keeps %s comparison entry visits linear at N/2N/4N (kills quadratic-inner-scan)",
		(kind) => {
			const sizes = [8, 16, 32];
			const visits = sizes.map((size) => {
				const leftValues = Array.from({ length: size }, (_, index) => ({ index }));
				const rightValues = Array.from({ length: size }, (_, index) => ({ index }));
				const left = kind === "Map" ? new Map(leftValues.map((key, index) => [key, { index }])) : new Set(leftValues);
				const right =
					kind === "Map" ? new Map(rightValues.map((key, index) => [key, { index }])) : new Set(rightValues);
				const counters = observedComparison(left, right, `${kind}-${size}`).counters;
				expect(counters.comparisonCalls).toBe(1);
				expect(counters.codecPasses).toBe(1);
				expect(counters.encodeCalls).toBe(2);
				expect(counters.encodedBytes).toBe(serializeValue(left).byteLength + serializeValue(right).byteLength);
				return kind === "Map" ? counters.mapEntriesVisited : counters.setEntriesVisited;
			});
			expect(visits).toEqual(sizes.map((size) => size * 2));
			expect([visits[1]! / visits[0]!, visits[2]! / visits[1]!, visits[2]! / visits[0]!]).toEqual([2, 2, 4]);
		}
	);

	it("keeps equal, tail-different, reordered, nested-key and cyclic decisions inside the semantic-plus-byte contract (kills skipped-byte and order-insensitive verdicts)", () => {
		const cyclicLeft: { self?: unknown; value: number } = { value: 1 };
		const cyclicRight: { self?: unknown; value: number } = { value: 1 };
		cyclicLeft.self = cyclicLeft;
		cyclicRight.self = cyclicRight;
		const cases: Array<readonly [string, unknown, unknown]> = [
			["equal", new Map([["a", { value: 1 }]]), new Map([["a", { value: 1 }]])],
			["tail-different", new Set([1, 2, 3]), new Set([1, 2, 4])],
			[
				"reordered",
				new Map([
					["a", 1],
					["b", 2],
				]),
				new Map([
					["b", 2],
					["a", 1],
				]),
			],
			["nested-key", new Map([[{ key: { n: 1 } }, "v"]]), new Map([[{ key: { n: 1 } }, "v"]])],
			["cycle", cyclicLeft, cyclicRight],
		];
		for (const [name, left, right] of cases) {
			const expected = outcome(() => deepEqual(left, right) && serializedValuesEqual(left, right));
			const actual = outcome(() =>
				meteredCapability([]).equal(left, right, {
					publicationId: `corpus-${name}`,
					phase: "publisher-capture",
					side: "drp",
					key: name,
				})
			);
			expectSameOutcome(actual, expected, name);
		}
	});

	it("preserves the full ordinary-value differential corpus and primary throwables", () => {
		const getterError = new Error("comparison getter sentinel");
		const throwing = Object.defineProperty({}, "value", {
			enumerable: true,
			get: () => {
				throw getterError;
			},
		});
		const alias = { value: 1 };
		const corpus: Array<readonly [string, unknown, unknown]> = [
			["plain reorder", { a: 1, b: 2 }, { b: 2, a: 1 }],
			[
				"map reorder",
				new Map([
					["a", 1],
					["b", 2],
				]),
				new Map([
					["b", 2],
					["a", 1],
				]),
			],
			["set reorder", new Set([1, 2]), new Set([2, 1])],
			["deep-equal map keys", new Map([[{ id: 1 }, "v"]]), new Map([[{ id: 1 }, "v"]])],
			["arrays", [1, { a: 2 }], [1, { a: 2 }]],
			["aliases", { a: alias, b: alias }, { a: { value: 1 }, b: { value: 1 } }],
			["NaN", Number.NaN, Number.NaN],
			["signed zero", -0, 0],
			["undefined-null", undefined, null],
			["missing-present undefined", {}, { value: undefined }],
			["typed array types", new Uint8Array([1, 2]), new Uint16Array([513])],
			["Date", new Date(0), new Date(0)],
			["RegExp", /a/gi, /a/gi],
			["BigInt", BigInt(1), BigInt(1)],
			["functions", (): number => 1, (): number => 1],
			["throwing getter", throwing, { value: 1 }],
		];
		for (const [name, left, right] of corpus) {
			const expected = outcome(() => deepEqual(left, right) && serializedValuesEqual(left, right));
			const actual = outcome(() =>
				meteredCapability([]).equal(left, right, {
					publicationId: `differential-${name}`,
					phase: "publisher-capture",
					side: "drp",
					key: name,
				})
			);
			expectSameOutcome(actual, expected, name, getterError);
			if (actual.result === true) expect(bytesEqual(left, right), name).toBe(true);
		}
	});

	it("never invokes the codec after semantic rejection and invokes it once per accepted semantic pair", () => {
		const rejected = observedComparison({ value: 1 }, { value: 2 }, "rejected").counters;
		expect(rejected.codecPasses).toBe(0);
		expect(rejected.encodeCalls).toBe(0);
		const accepted = observedComparison({ value: 1 }, { value: 1 }, "accepted").counters;
		expect(accepted.codecPasses).toBe(1);
		expect(accepted.encodeCalls).toBe(2);
	});

	it.each(["Map", "Set"] as const)("uses captured %s traversal intrinsics for semantic early rejection", (kind) => {
		const sentinel = new Error(`${kind} hostile iterator`);
		const left = kind === "Map" ? new Map([[1, "a"]]) : new Set([1]);
		const right = kind === "Map" ? new Map([[2, "a"]]) : new Set([2]);
		Object.defineProperties(left, {
			[kind === "Map" ? "entries" : "values"]: {
				value: (): never => {
					throw sentinel;
				},
			},
			[Symbol.iterator]: {
				value: (): never => {
					throw sentinel;
				},
			},
		});
		expect(() =>
			meteredCapability([]).equal(left, right, {
				publicationId: `hostile-${kind}`,
				phase: "publisher-capture",
				side: "drp",
				key: kind,
			})
		).not.toThrow();
	});

	it.each([
		[
			"ambient nested mutation",
			(h: ReturnType<typeof applierHarness>): void => {
				h.drp.nested.value = 2;
				h.applier.drp?.replace();
			},
			"nested",
		],
		[
			"replacement",
			(h: ReturnType<typeof applierHarness>): void => {
				h.applier.drp?.replace();
			},
			"replacement",
		],
		[
			"addition",
			(h: ReturnType<typeof applierHarness>): void => {
				h.applier.drp?.add();
			},
			"added",
		],
		[
			"deletion",
			(h: ReturnType<typeof applierHarness>): void => {
				h.applier.drp?.remove();
			},
			"removable",
		],
		[
			"reorder-only",
			(h: ReturnType<typeof applierHarness>): void => {
				h.applier.drp?.reorder();
			},
			"ordered",
		],
	] as const)("keeps candidacy a safe superset for %s (kills under-candidacy)", (_name, mutate, expectedKey) => {
		const harness = applierHarness();
		mutate(harness);
		expect(latestChangedKey(harness)).toContain(expectedKey);
	});

	it("has one direct equality owner and rejects hidden direct relocation/cache paths", () => {
		const sources = governedEqualitySources();
		const sites = directEqualityCensus(sources);
		expect(sites.length).toBeGreaterThan(0);
		expect(new Set(sites.map((site) => site.slice(0, site.indexOf(":"))))).toEqual(
			new Set(["publication/copy-capability.ts"])
		);
		const mutants = [
			{ file: "drp-applier.ts", line: '\nimport { deepEqual as hiddenEqual } from "fast-equals"; void hiddenEqual;\n' },
			{ file: "proxy.ts", line: "\nvoid serializedValuesEqual;\n" },
			{ file: "publication/publisher.ts", line: "\nvoid JSON.stringify({ hidden: true });\n" },
			{ file: "publication/publisher.ts", line: "\nconst fingerprint = new Map(); void fingerprint;\n" },
			{ file: "publication/publisher.ts", line: "\nconst byteCache = new Map(); void byteCache;\n" },
		];
		for (const mutant of mutants) {
			const mutated = { ...sources, [mutant.file]: sources[mutant.file]! + mutant.line };
			const owners = new Set(directEqualityCensus(mutated).map((site) => site.slice(0, site.indexOf(":"))));
			expect(owners, mutant.line).not.toEqual(new Set(["publication/copy-capability.ts"]));
		}
	});
});
