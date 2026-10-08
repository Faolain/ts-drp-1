import type {
	Phase3ExitModelFault,
	Phase3ExitModelInput,
	Phase3ExitModelLimits,
	Phase3ExitModelResult,
	Phase3ExitModelVertex,
	Phase3ExitOutcomeProjection,
	Phase3ExitSchedule,
} from "./model-contract.js";
import { hashForIndex } from "../../../packages/compaction/tests/corpus.js";

const DEFAULT_LIMITS: Phase3ExitModelLimits = Object.freeze({
	anchorAcceptedByteCharge: 0,
	maxAcceptedBytes: Number.MAX_SAFE_INTEGER,
	maxAcceptedVertices: Number.MAX_SAFE_INTEGER,
	maxPendingBytes: Number.MAX_SAFE_INTEGER,
	maxPendingEntries: Number.MAX_SAFE_INTEGER,
});

function sorted(values: ReadonlySet<number>): number[] {
	return [...values].sort((left, right) => left - right);
}

function exactVertex(input: ReadonlyMap<number, Phase3ExitModelVertex>, label: number): Phase3ExitModelVertex {
	const vertex = input.get(label);
	if (vertex === undefined) throw new TypeError(`unknown Phase 3 exit model label ${label}`);
	return vertex;
}

function validLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function validateInput(input: Phase3ExitModelInput): void {
	if (!(input.vertices instanceof Map) || !Number.isSafeInteger(input.bootstrapLabel)) {
		throw new TypeError("Phase 3 exit model input is malformed");
	}
	for (const value of Object.values(input.limits)) {
		if (!validLimit(value)) throw new RangeError("Phase 3 exit model limit is invalid");
	}
	const bootstrap = exactVertex(input.vertices, input.bootstrapLabel);
	if (bootstrap.dependencies.length !== 0) throw new TypeError("logical bootstrap must have no pure-model dependency");
	for (const [label, vertex] of input.vertices) {
		if (label !== vertex.label || vertex.digest.length === 0)
			throw new TypeError("Phase 3 exit vertex identity is malformed");
		for (const dependency of vertex.dependencies) {
			if (!input.vertices.has(dependency) || dependency === label) {
				throw new TypeError("Phase 3 exit vertex dependency is malformed");
			}
		}
	}
}

/**
 * Materialize the immutable synthetic vertices for one frozen schedule.
 * @param schedule - Frozen dependency/action schedule.
 * @returns One exact label-to-vertex table.
 */
export function phase3ExitVerticesForSchedule(
	schedule: Phase3ExitSchedule
): ReadonlyMap<number, Phase3ExitModelVertex> {
	const vertices = new Map<number, Phase3ExitModelVertex>();
	for (let label = 0; label < schedule[0].length; label += 1) {
		vertices.set(
			label,
			Object.freeze({
				acceptedByteCharge: 1,
				authorized: true,
				canonicalPreimageByteCharge: 1,
				dependencies: Object.freeze([...(schedule[0][label] ?? [])]),
				digest: hashForIndex(label),
				label,
				malformed: false,
				pendingWireByteCharge: 1,
				scopeCurrent: true,
			})
		);
	}
	return vertices;
}

/**
 * Execute the independent immutable Phase 3 exit transition model.
 * @param input - Closed vertices, limits, and actions.
 * @param fault - Optional controlled defect used only to prove oracle sensitivity.
 * @returns Detached semantic outcome and capacity evidence.
 */
export function runPhase3ExitModel(input: Phase3ExitModelInput, fault?: Phase3ExitModelFault): Phase3ExitModelResult {
	validateInput(input);
	const accepted = new Set<number>([input.bootstrapLabel]);
	const journal = new Set<number>([input.bootstrapLabel]);
	const journalOrder = [input.bootstrapLabel];
	const pending = new Map<number, Phase3ExitModelVertex>();
	const callbacks = new Set<number>();
	const callbackOrder: number[] = [];
	const recovered = new Set<number>();
	const dropped = new Set<number>();
	let acceptedBytes =
		input.limits.anchorAcceptedByteCharge + exactVertex(input.vertices, input.bootstrapLabel).acceptedByteCharge;
	let pendingBytes = 0;

	const ready = (vertex: Phase3ExitModelVertex): boolean =>
		vertex.dependencies.every((dependency) => accepted.has(dependency));
	const hasAcceptedCapacity = (vertex: Phase3ExitModelVertex): boolean =>
		1 + accepted.size < input.limits.maxAcceptedVertices &&
		acceptedBytes + vertex.acceptedByteCharge <= input.limits.maxAcceptedBytes;
	const releasePending = (vertex: Phase3ExitModelVertex): void => {
		if (!pending.delete(vertex.label)) return;
		if (fault !== "subtract-no-pending-bytes") pendingBytes -= vertex.pendingWireByteCharge;
	};
	const accept = (vertex: Phase3ExitModelVertex, callback: boolean, capacityChecked = false): boolean => {
		if (accepted.has(vertex.label)) return true;
		if (!capacityChecked && !hasAcceptedCapacity(vertex)) {
			releasePending(vertex);
			dropped.add(vertex.label);
			return false;
		}
		if (!journal.has(vertex.label)) journalOrder.push(vertex.label);
		journal.add(vertex.label);
		accepted.add(vertex.label);
		acceptedBytes += vertex.acceptedByteCharge;
		releasePending(vertex);
		if (callback && !callbacks.has(vertex.label)) callbackOrder.push(vertex.label);
		if (callback) callbacks.add(vertex.label);
		return true;
	};
	const retainPending = (vertex: Phase3ExitModelVertex): void => {
		if (pending.has(vertex.label)) return;
		const charge =
			fault === "charge-pending-from-canonical" ? vertex.canonicalPreimageByteCharge : vertex.pendingWireByteCharge;
		if (pending.size >= input.limits.maxPendingEntries || pendingBytes + charge > input.limits.maxPendingBytes) {
			dropped.add(vertex.label);
			return;
		}
		pending.set(vertex.label, vertex);
		pendingBytes += charge;
	};
	const drain = (): void => {
		if (fault === "skip-pending-drain") return;
		for (;;) {
			const wave = [...pending.values()].filter(ready);
			if (fault !== "drain-in-insertion-order") {
				wave.sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0));
			}
			if (wave.length === 0) return;
			const waveCapacity =
				fault === "wave-capacity-check-once" ? hasAcceptedCapacity(wave[0] as Phase3ExitModelVertex) : false;
			for (const vertex of wave) accept(vertex, true, fault === "wave-capacity-check-once" && waveCapacity);
		}
	};

	for (const action of input.actions) {
		if (action[0] === "deliver" || action[0] === "redeliver") {
			const vertex = exactVertex(input.vertices, action[1]);
			if (journal.has(vertex.label) || pending.has(vertex.label)) continue;
			if (action[0] === "redeliver" && fault === "omit-post-restart-redelivery") continue;
			if (vertex.malformed || !vertex.scopeCurrent || !vertex.authorized) {
				dropped.add(vertex.label);
				continue;
			}
			if (!ready(vertex)) {
				retainPending(vertex);
				continue;
			}
			if (action[0] === "deliver" && action[2] === "commit-then-throw") {
				journal.add(vertex.label);
				journalOrder.push(vertex.label);
				continue;
			}
			if (accept(vertex, true)) drain();
			continue;
		}
		if (action[0] === "crash-restart") {
			accepted.clear();
			acceptedBytes = input.limits.anchorAcceptedByteCharge;
			for (const label of journalOrder) {
				const vertex = exactVertex(input.vertices, label);
				accepted.add(label);
				acceptedBytes += vertex.acceptedByteCharge;
				recovered.add(label);
			}
			if (fault !== "retain-pending-across-restart") {
				pending.clear();
				pendingBytes = 0;
			}
		}
	}

	if (fault === "count-pending-as-accepted") {
		for (const label of pending.keys()) accepted.add(label);
	}
	const acceptedAscending = sorted(accepted);
	const tips = acceptedAscending.filter((label) =>
		acceptedAscending.every((candidate) => !exactVertex(input.vertices, candidate).dependencies.includes(label))
	);
	const projection: Phase3ExitOutcomeProjection = Object.freeze([
		Object.freeze(acceptedAscending),
		Object.freeze([...journalOrder]),
		Object.freeze(sorted(new Set(pending.keys()))),
		Object.freeze([...callbackOrder]),
		Object.freeze(sorted(recovered)),
		Object.freeze(tips),
	]);
	return Object.freeze({
		acceptedByteCharge: acceptedBytes,
		acceptedVertexCount: 1 + accepted.size,
		droppedAscending: Object.freeze(sorted(dropped)),
		pendingByteCharge: pendingBytes,
		projection,
	});
}

/**
 * Execute one frozen schedule with its deterministic synthetic vertex table.
 * @param schedule - Frozen schedule.
 * @param options - Optional small bounds or controlled defect.
 * @returns Detached semantic outcome and capacity evidence.
 */
export function runPhase3ExitSchedule(
	schedule: Phase3ExitSchedule,
	options: Readonly<{ readonly fault?: Phase3ExitModelFault; readonly limits?: Phase3ExitModelLimits }> = {}
): Phase3ExitModelResult {
	return runPhase3ExitModel(
		Object.freeze({
			actions: schedule[2],
			bootstrapLabel: 0,
			limits: options.limits ?? DEFAULT_LIMITS,
			vertices: phase3ExitVerticesForSchedule(schedule),
		}),
		options.fault
	);
}
