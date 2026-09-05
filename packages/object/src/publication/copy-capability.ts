import { type DRPState, type DRPStateEntry } from "@ts-drp/types";
import { serializedValuesEqual } from "@ts-drp/utils/serialization/equality";
import { createCustomEqual, type State } from "fast-equals";

import { detachStatePayload } from "../state-payload.js";

const publicationCapabilityBrand: unique symbol = Symbol("PublicationCapability");

function capturedGetter(prototype: object, key: PropertyKey): (this: object) => unknown {
	const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
	if (!getter) throw new Error(`${String(key)} accessor is unavailable`);
	return getter;
}

const mapEntries = Map.prototype.entries;
const mapSize = capturedGetter(Map.prototype, "size");
const mapIteratorNext = Object.getPrototypeOf(Reflect.apply(mapEntries, new Map(), [])).next as (
	this: MapIterator<unknown>
) => IteratorResult<unknown>;
const setValues = Set.prototype.values;
const setSize = capturedGetter(Set.prototype, "size");
const setIteratorNext = Object.getPrototypeOf(Reflect.apply(setValues, new Set(), [])).next as (
	this: SetIterator<unknown>
) => IteratorResult<unknown>;

interface CopyMetadata {
	publicationId: string;
	side: "acl" | "drp";
	key: string;
	image: "pre" | "post";
}

export type ComparisonPhase = "applier-candidacy" | "proxy-tracking" | "publisher-capture" | "publisher-override";

export interface ComparisonMetadata {
	publicationId: string;
	phase: ComparisonPhase;
	side: "acl" | "drp";
	key: string;
}

export interface ComparisonCounters {
	comparisonCalls: number;
	recursiveNodeVisits: number;
	recursiveEdgeVisits: number;
	mapEntriesVisited: number;
	setEntriesVisited: number;
	codecPasses: number;
	encodeCalls: number;
	encodedBytes: number;
}

export interface ComparisonEvent {
	type: "comparison";
	metadata: ComparisonMetadata;
	pair: { left: unknown; right: unknown };
	counters: ComparisonCounters;
	result: boolean;
}

interface SemanticComparisonState {
	counters: ComparisonCounters;
	cycleDetected: boolean;
}

/** Least-authority operations available to the publication pipeline. */
export interface PublicationCapability {
	readonly [publicationCapabilityBrand]: true;
	copy(value: unknown, metadata: CopyMetadata): unknown;
	createEntry(key: string, value: unknown): DRPStateEntry;
	createSnapshot(entries: readonly DRPStateEntry[]): DRPState;
	equal(left: unknown, right: unknown, metadata?: ComparisonMetadata): boolean;
	observe(event: { type: "publication"; record: unknown }): void;
}

function emptyComparisonCounters(): ComparisonCounters {
	return {
		comparisonCalls: 0,
		recursiveNodeVisits: 0,
		recursiveEdgeVisits: 0,
		mapEntriesVisited: 0,
		setEntriesVisited: 0,
		codecPasses: 0,
		encodeCalls: 0,
		encodedBytes: 0,
	};
}

function semanticValuesEqual(
	left: unknown,
	right: unknown,
	counters: ComparisonCounters
): { cycleDetected: boolean; result: boolean } {
	const meta: SemanticComparisonState = { counters, cycleDetected: false };
	const equal = createCustomEqual<SemanticComparisonState>({
		circular: true,
		createState: () => ({ meta }),
		createInternalComparator:
			(compare) =>
			(a, b, _keyA, _keyB, _parentA, _parentB, state): boolean => {
				state.meta.counters.recursiveEdgeVisits++;
				state.meta.counters.recursiveNodeVisits++;
				const cache = state.cache;
				if (
					a !== null &&
					b !== null &&
					typeof a === "object" &&
					typeof b === "object" &&
					cache !== undefined &&
					cache.get(a) === b &&
					cache.get(b) === a
				) {
					state.meta.cycleDetected = true;
				}
				return compare(a, b, state);
			},
		createCustomConfig: () => ({
			areMapsEqual: (
				a: Map<unknown, unknown>,
				b: Map<unknown, unknown>,
				state: State<SemanticComparisonState>
			): boolean => {
				if (Reflect.apply(mapSize, a, []) !== Reflect.apply(mapSize, b, [])) return false;
				const leftEntries = Reflect.apply(mapEntries, a, []);
				const rightEntries = Reflect.apply(mapEntries, b, []);
				let index = 0;
				while (true) {
					const leftResult = Reflect.apply(mapIteratorNext, leftEntries, []) as IteratorResult<[unknown, unknown]>;
					const rightResult = Reflect.apply(mapIteratorNext, rightEntries, []) as IteratorResult<[unknown, unknown]>;
					if (leftResult.done || rightResult.done) return leftResult.done === rightResult.done;
					state.meta.counters.mapEntriesVisited += 2;
					const [leftKey, leftValue] = leftResult.value;
					const [rightKey, rightValue] = rightResult.value;
					if (!state.equals(leftKey, rightKey, index, index, a, b, state)) return false;
					if (!state.equals(leftValue, rightValue, leftKey, rightKey, a, b, state)) return false;
					index++;
				}
			},
			areSetsEqual: (a: Set<unknown>, b: Set<unknown>, state: State<SemanticComparisonState>): boolean => {
				if (Reflect.apply(setSize, a, []) !== Reflect.apply(setSize, b, [])) return false;
				const leftEntries = Reflect.apply(setValues, a, []);
				const rightEntries = Reflect.apply(setValues, b, []);
				while (true) {
					const leftResult = Reflect.apply(setIteratorNext, leftEntries, []);
					const rightResult = Reflect.apply(setIteratorNext, rightEntries, []);
					if (leftResult.done || rightResult.done) return leftResult.done === rightResult.done;
					state.meta.counters.setEntriesVisited += 2;
					if (!state.equals(leftResult.value, rightResult.value, leftResult.value, rightResult.value, a, b, state)) {
						return false;
					}
				}
			},
		}),
	});
	counters.recursiveNodeVisits++;
	const result = equal(left, right);
	return { cycleDetected: meta.cycleDetected, result };
}

function compareValues(
	left: unknown,
	right: unknown,
	counters: ComparisonCounters,
	codecFailureIsEqual: boolean
): boolean {
	counters.comparisonCalls++;
	const semantic = semanticValuesEqual(left, right, counters);
	if (!semantic.result) return false;
	if (semantic.cycleDetected && !codecFailureIsEqual) throw new RangeError("Maximum call stack size exceeded");
	counters.codecPasses++;
	try {
		return serializedValuesEqual(left, right, (byteLength) => {
			counters.encodeCalls++;
			counters.encodedBytes += byteLength;
		});
	} catch (error) {
		if (codecFailureIsEqual) return true;
		throw error;
	}
}

/**
 * Preserve the direct mutation-tracking seam while keeping comparison ownership here.
 * @param left - Previous value
 * @param right - Resulting value
 * @returns Whether the values are semantically and byte equal, treating codec rejection as equal
 */
export function proxyValuesEqual(left: unknown, right: unknown): boolean {
	return compareValues(left, right, emptyComparisonCounters(), true);
}

/**
 * Construct the sole publication capability at the applier composition root.
 * @param observer - Optional publication-work observer
 * @param comparisonObserver - Optional pure comparison-work observer; defaults to the primary observer
 * @returns The privately branded capability
 */
export function createPublicationCapability<TEvent>(
	observer?: (event: TEvent) => unknown,
	comparisonObserver: ((event: ComparisonEvent) => unknown) | null = (observer as
		| ((event: ComparisonEvent) => unknown)
		| undefined) ?? null
): PublicationCapability {
	const emit = (event: unknown): unknown => observer?.(event as TEvent);
	const emitComparison = (event: ComparisonEvent): void => {
		try {
			comparisonObserver?.(event);
		} catch {
			// Diagnostic comparison observation is pure and cannot alter publication.
		}
	};
	return {
		[publicationCapabilityBrand]: true,
		copy(value, metadata): unknown {
			return observer ? emit({ type: "copy", value, metadata }) : detachStatePayload(value);
		},
		createEntry(key, value): DRPStateEntry {
			return { key, value };
		},
		createSnapshot(entries): DRPState {
			return { state: [...entries] };
		},
		equal(left, right, metadata): boolean {
			const counters = emptyComparisonCounters();
			let result: boolean;
			try {
				result = compareValues(left, right, counters, metadata?.phase === "proxy-tracking");
			} catch (error) {
				if (metadata) {
					emitComparison({
						type: "comparison",
						metadata,
						pair: { left, right },
						counters: { ...counters },
						result: false,
					});
				}
				throw error;
			}
			if (metadata) {
				emitComparison({
					type: "comparison",
					metadata,
					pair: { left, right },
					counters: { ...counters },
					result,
				});
			}
			return result;
		},
		observe(event): void {
			emit(event);
		},
	};
}
