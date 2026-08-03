import { type DRPState, type Hash, type IACL, type IDRP, type IHashGraph, type Vertex } from "@ts-drp/types";

import { type OperationJournal } from "../operation.js";
import {
	borrowedStateEntry,
	defineEnumerableOwnData,
	materializeEnumerableStateValue,
	readEnumerableStateValue,
} from "../state-payload.js";
import { type DRPStateStore, REPLICA_LOCAL_STATE_KEYS } from "../state-store.js";
import { type PublicationCapability } from "./copy-capability.js";

const MAX_CHECKPOINTS = 32;

export type SnapshotSide = "acl" | "drp";
export type PublicationFallbackReason =
	| "non-empty-suffix"
	| "conflict-replay"
	| "concurrent-tail"
	| "multi-head-local"
	| "multi-frontier-checkpoint";

export interface PublicationWorkCounters {
	egressWidenings: number;
	comparedKeys: number;
	comparisonPasses: number;
}

export interface PublicationRecord {
	publicationId: string;
	kind: "vertex" | "checkpoint";
	mode: "incremental" | "fallback";
	outcome: "published" | "rolled-back";
	targetHash?: Hash;
	baselineHashes: readonly Hash[];
	frontier: readonly Hash[];
	changed: Readonly<Record<SnapshotSide, readonly string[]>>;
	/**
	 * Bounded raw-egress decision work. Real records always populate it; fallback
	 * capture remains zero because it performs no incremental comparison/reuse pass.
	 */
	work?: Readonly<Record<SnapshotSide, PublicationWorkCounters>>;
	fallbackReason?: PublicationFallbackReason;
}

interface LivePublicationRecord extends PublicationRecord {
	work: Readonly<Record<SnapshotSide, PublicationWorkCounters>>;
}

export type PublicationObserverEvent =
	| {
			type: "copy";
			value: unknown;
			metadata: { publicationId: string; side: SnapshotSide; key: string; image: "pre" | "post" };
	  }
	| { type: "publication"; record: PublicationRecord };

export interface LinearizationCheckpoint {
	frontier: Hash[];
	origin: Hash;
	vertexCount: number;
	state: { aclState: DRPState; drpState: DRPState };
}

interface PublisherOperation<T extends IDRP> {
	isACL: boolean;
	isLocal?: boolean;
	currentDRP?: T | IACL;
	acl: IACL;
	drp?: T;
	journal: OperationJournal;
	vertex: Vertex;
	drpVertices: Vertex[];
	aclVertices: Vertex[];
	mutatedKeys?: readonly string[];
	rawEgress?: Readonly<{ side: SnapshotSide; candidateKeys: readonly string[] }>;
}

interface PreparedPublicationAdoption<T extends IDRP> {
	expectedFrontier: Hash[];
	drp?: T;
	acl?: IACL;
}

interface PublisherHost<T extends IDRP> {
	readonly acl: IACL;
	readonly drp?: T;
	readonly hashGraph: IHashGraph & { hasCustomConflictResolver(drpType: string | undefined): boolean };
	readonly states: DRPStateStore;
	readonly checkpoints: LinearizationCheckpoint[];
	readonly checkpointSuffixSize: number;
	readonly rootHash: Hash;
}

interface PublicationPlan {
	mode: "incremental" | "fallback";
	baselineHashes: Hash[];
	fallbackReason?: PublicationFallbackReason;
}

interface PublicationOverride {
	baseline: DRPState;
	instance: IDRP;
}

/** Isolated incremental snapshot publisher. Nested payload values stay opaque. */
export class PublicationPublisher<T extends IDRP> {
	private sequence = 0;
	private canonicalCheckpointState?: { aclState: DRPState; drpState: DRPState };

	/**
	 * Create a publisher over injected storage and copy authority.
	 * @param host - Publication-owned state and graph ports
	 * @param capability - Sole copy and comparison authority
	 */
	constructor(
		private readonly host: PublisherHost<T>,
		private readonly capability: PublicationCapability
	) {}

	/**
	 * Supply the canonical frontier pair to one synchronous checkpoint attempt.
	 * The context cannot survive the delegate call or be nested accidentally.
	 * @param state - Canonical state published for the pending frontier
	 * @param state.aclState - Canonical ACL state for the pending frontier
	 * @param state.drpState - Canonical DRP state for the pending frontier
	 * @param advance - Synchronous checkpoint attempt
	 */
	withCanonicalCheckpointState(state: { aclState: DRPState; drpState: DRPState }, advance: () => void): void {
		if (this.canonicalCheckpointState !== undefined) {
			throw new Error("Canonical checkpoint state is already active");
		}
		this.canonicalCheckpointState = state;
		try {
			advance();
		} finally {
			this.canonicalCheckpointState = undefined;
		}
	}

	/**
	 * Publish the snapshots produced by an accepted vertex.
	 * @param operation - Accepted operation and mutation attribution
	 * @param adoption - Prepared live-state adoption
	 * @param publicationAttempts - Transaction-local publication records
	 * @param publicationFrontier - Frontier used to choose the publication mode
	 */
	assignState(
		operation: PublisherOperation<T>,
		adoption: PreparedPublicationAdoption<T>,
		publicationAttempts: PublicationRecord[],
		publicationFrontier: Hash[]
	): void {
		const {
			isACL,
			currentDRP,
			acl,
			drp,
			journal,
			vertex: { hash },
		} = operation;
		const targetACL = adoption.acl ?? (isACL ? (currentDRP as IACL | undefined) : acl);
		const targetDRP = adoption.drp ?? (isACL ? drp : (currentDRP as T | undefined));
		const plan = this.vertexPublicationPlan(operation, publicationFrontier);
		const baselineHash = plan.mode === "incremental" ? plan.baselineHashes[0] : undefined;
		const publication = this.beginPublication("vertex", plan, hash, publicationFrontier);
		publicationAttempts.push(publication);
		const dependencyHash = operation.vertex.dependencies.length === 1 ? operation.vertex.dependencies[0] : undefined;
		const concurrentOverride = plan.fallbackReason === "concurrent-tail" && dependencyHash !== undefined;
		const dependencyACLState = dependencyHash === undefined ? undefined : this.host.states.getACLState(dependencyHash);
		const dependencyDRPState = dependencyHash === undefined ? undefined : this.host.states.getDRPState(dependencyHash);
		const aclCandidateKeys = new Set([
			...(isACL ? (operation.mutatedKeys ?? []) : []),
			...(operation.rawEgress?.side === "acl" ? operation.rawEgress.candidateKeys : []),
		]);
		const drpCandidateKeys = new Set([
			...(isACL ? [] : (operation.mutatedKeys ?? [])),
			...(operation.rawEgress?.side === "drp" ? operation.rawEgress.candidateKeys : []),
		]);
		const retainFallbackEntries =
			plan.mode === "fallback" &&
			plan.fallbackReason !== "multi-head-local" &&
			plan.fallbackReason !== "multi-frontier-checkpoint";
		const aclRetentionBaselines = retainFallbackEntries
			? plan.baselineHashes
					.map((candidateHash) => this.host.states.getACLState(candidateHash))
					.filter((state): state is DRPState => state !== undefined)
			: undefined;
		const drpRetentionBaselines = retainFallbackEntries
			? plan.baselineHashes
					.map((candidateHash) => this.host.states.getDRPState(candidateHash))
					.filter((state): state is DRPState => state !== undefined)
			: undefined;
		const aclState = this.capturePublishedState(
			"acl",
			targetACL,
			baselineHash === undefined ? undefined : this.host.states.getACLState(baselineHash),
			publication,
			plan.mode === "incremental",
			plan.mode === "incremental" ? aclCandidateKeys : undefined,
			concurrentOverride && isACL && currentDRP && dependencyACLState
				? { instance: currentDRP, baseline: dependencyACLState }
				: undefined,
			operation.rawEgress?.side === "acl",
			aclRetentionBaselines
		);
		const drpState = this.capturePublishedState(
			"drp",
			targetDRP,
			baselineHash === undefined ? undefined : this.host.states.getDRPState(baselineHash),
			publication,
			plan.mode === "incremental",
			plan.mode === "incremental" ? drpCandidateKeys : undefined,
			concurrentOverride && !isACL && currentDRP && dependencyDRPState
				? { instance: currentDRP, baseline: dependencyDRPState }
				: undefined,
			operation.rawEgress?.side === "drp",
			drpRetentionBaselines
		);
		this.installState("acl", hash, aclState, journal);
		this.installState("drp", hash, drpState, journal);
	}

	/**
	 * Publish and retain a checkpoint when the configured boundary is reached.
	 * @param journal - Transaction rollback journal
	 * @param force - Whether to force checkpoint consideration
	 * @param publicationAttempts - Transaction-local publication records
	 */
	advanceCheckpointIfNeeded(
		journal: OperationJournal,
		force = false,
		publicationAttempts: PublicationRecord[] = []
	): void {
		const canonicalState = this.canonicalCheckpointState;
		const { checkpoints, hashGraph } = this.host;
		const latest = checkpoints[checkpoints.length - 1];
		if (!force && hashGraph.vertices.size - latest.vertexCount < this.host.checkpointSuffixSize) return;
		if (latest.vertexCount === hashGraph.vertices.size) {
			if (!force || latest === checkpoints[0]) return;
			checkpoints.pop();
			journal.record(() => {
				if (!checkpoints.includes(latest)) checkpoints.push(latest);
			});
		}

		const frontier = hashGraph.getFrontier();
		const frontierHead = frontier[0];
		const frontierACLState = frontierHead === undefined ? undefined : this.host.states.getACLState(frontierHead);
		const frontierDRPState = frontierHead === undefined ? undefined : this.host.states.getDRPState(frontierHead);
		const plan: PublicationPlan =
			frontier.length === 1 && frontierACLState !== undefined && frontierDRPState !== undefined
				? { mode: "incremental", baselineHashes: [...frontier] }
				: { mode: "fallback", baselineHashes: [...frontier], fallbackReason: "multi-frontier-checkpoint" };
		const publication = this.beginPublication("checkpoint", plan, undefined, frontier);
		publicationAttempts.push(publication);
		const checkpointState =
			plan.mode === "incremental" && frontierACLState !== undefined && frontierDRPState !== undefined
				? { aclState: frontierACLState, drpState: frontierDRPState }
				: canonicalState === undefined
					? ((): never => {
							throw new Error("A multi-frontier checkpoint requires canonical frontier state");
						})()
					: {
							aclState: this.capturePublishedState(
								"acl",
								this.materializeCanonicalCheckpointSource(canonicalState.aclState),
								undefined,
								publication,
								false
							),
							drpState: this.capturePublishedState(
								"drp",
								this.materializeCanonicalCheckpointSource(canonicalState.drpState),
								undefined,
								publication,
								false
							),
						};
		const checkpoint: LinearizationCheckpoint = {
			frontier,
			origin: [...frontier].sort()[0],
			vertexCount: hashGraph.vertices.size,
			state: checkpointState,
		};
		checkpoints.push(checkpoint);
		journal.record(() => {
			const index = checkpoints.indexOf(checkpoint);
			if (index !== -1) checkpoints.splice(index, 1);
		});
		if (checkpoints.length > MAX_CHECKPOINTS) this.removeOldCheckpoint(journal);
		this.pruneSnapshots(journal);
	}

	private materializeCanonicalCheckpointSource(state: DRPState): IDRP {
		for (const entry of state.state) {
			if (typeof entry.key !== "string") throw new TypeError("DRP state key must be a primitive string");
		}
		const source = Object.create(null) as IDRP;
		for (const entry of state.state) defineEnumerableOwnData(source, entry.key, entry.value);
		return source;
	}

	/**
	 * Emit the final outcome for attempted publications.
	 * @param publications - Publication records to report
	 * @param outcome - Final transaction outcome
	 */
	reportPublications(publications: readonly PublicationRecord[], outcome: PublicationRecord["outcome"]): void {
		for (const publication of publications) {
			this.capability.observe({ type: "publication", record: { ...publication, outcome } });
		}
	}

	private installState(side: SnapshotSide, hash: Hash, state: DRPState, journal: OperationJournal): void {
		const store = this.host.states;
		const previous = side === "acl" ? store.getACLState(hash) : store.getDRPState(hash);
		if (side === "acl") store.setACLState(hash, state);
		else store.setDRPState(hash, state);
		journal.record(() => {
			const current = side === "acl" ? store.getACLState(hash) : store.getDRPState(hash);
			if (current !== state) return;
			if (side === "acl") {
				if (previous) store.setACLState(hash, previous);
				else store.deleteACLState(hash, state);
			} else if (previous) store.setDRPState(hash, previous);
			else store.deleteDRPState(hash, state);
		});
	}

	private vertexPublicationPlan(operation: PublisherOperation<T>, frontier: Hash[]): PublicationPlan {
		if (operation.isLocal) {
			if (
				frontier.length === 1 &&
				this.host.states.getACLState(frontier[0]) !== undefined &&
				this.host.states.getDRPState(frontier[0]) !== undefined
			) {
				return { mode: "incremental", baselineHashes: [...frontier] };
			}
			return { mode: "fallback", baselineHashes: [...frontier], fallbackReason: "multi-head-local" };
		}
		const dependency = operation.vertex.dependencies.length === 1 ? operation.vertex.dependencies[0] : undefined;
		const hasEmptySuffix =
			operation.vertex.dependencies.length === 1 &&
			operation.drpVertices.length === 0 &&
			operation.aclVertices.length === 0;
		const exactFrontier = dependency !== undefined && sameHashes(frontier, [dependency]);
		if (
			hasEmptySuffix &&
			exactFrontier &&
			this.host.states.getACLState(dependency) !== undefined &&
			this.host.states.getDRPState(dependency) !== undefined
		) {
			return { mode: "incremental", baselineHashes: [dependency] };
		}
		const conflictReplay =
			!exactFrontier && this.host.hashGraph.hasCustomConflictResolver(operation.vertex.operation?.drpType);
		return {
			mode: "fallback",
			baselineHashes: [...frontier],
			fallbackReason: conflictReplay ? "conflict-replay" : hasEmptySuffix ? "concurrent-tail" : "non-empty-suffix",
		};
	}

	private beginPublication(
		kind: "vertex" | "checkpoint",
		plan: PublicationPlan,
		targetHash: Hash | undefined,
		frontier: readonly Hash[]
	): LivePublicationRecord {
		return {
			publicationId: `${kind}-${++this.sequence}`,
			kind,
			mode: plan.mode,
			outcome: "published",
			targetHash,
			baselineHashes: [...plan.baselineHashes],
			frontier: [...frontier],
			changed: { acl: [], drp: [] },
			work: {
				acl: { egressWidenings: 0, comparedKeys: 0, comparisonPasses: 0 },
				drp: { egressWidenings: 0, comparedKeys: 0, comparisonPasses: 0 },
			},
			fallbackReason: plan.fallbackReason,
		};
	}

	/**
	 * Preserve the historical applier test seam without granting copy authority.
	 * @param side - Snapshot side being captured
	 * @param instance - Live instance to publish
	 * @param baseline - Previously owned snapshot
	 * @param publication - Publication accounting record
	 * @param incremental - Whether unchanged entries may be retained
	 * @param candidateKeys - Keys eligible for equality comparison
	 * @param override - Concurrent-tail override source
	 * @param rawEgress - Whether candidacy widened to every governed key
	 * @param retentionBaselines - Additional owned snapshots eligible for entry retention
	 * @returns Independently owned published snapshot
	 */
	capturePublishedState(
		side: SnapshotSide,
		instance: IDRP | undefined,
		baseline: DRPState | undefined,
		publication: PublicationRecord,
		incremental: boolean,
		candidateKeys?: ReadonlySet<string>,
		override?: PublicationOverride,
		rawEgress = false,
		retentionBaselines?: readonly DRPState[]
	): DRPState {
		if (rawEgress && incremental && candidateKeys === undefined) {
			throw new Error("Raw-egress publication requires an explicit candidate keyset");
		}
		const baselineByKey = new Map(baseline?.state.map((entry) => [entry.key, entry]) ?? []);
		const targetKeys = new Set<string>();
		const values = new Map<string, unknown>();
		const borrowedEntries = new Map<string, DRPState["state"][number]>();
		this.collectValues(instance, targetKeys, values, borrowedEntries, rawEgress && incremental);
		if (override) this.applyOverride(side, publication, override, targetKeys, values, borrowedEntries);
		const fallbackRetention = this.selectFallbackRetention(
			side,
			publication,
			targetKeys,
			values,
			borrowedEntries,
			retentionBaselines
		);
		const entries: DRPState["state"] = [];
		const changed = publication.changed[side] as string[];
		if (rawEgress && incremental) {
			const governedUnion = new Set([...targetKeys, ...baselineByKey.keys()]);
			const explicitCandidates = governedUnion;
			const work = publication.work?.[side];
			if (work) {
				work.egressWidenings = 1;
				work.comparedKeys = explicitCandidates.size;
				work.comparisonPasses = 1;
			}

			// Decide every key before copying or retaining any entry. A comparison
			// failure therefore cannot leave a partially materialized publication.
			const reuse = new Map<string, boolean>();
			for (const key of explicitCandidates) {
				const targetPresent = targetKeys.has(key);
				const ownedEntry = baselineByKey.get(key);
				if (!targetPresent || ownedEntry === undefined) {
					reuse.set(key, false);
					continue;
				}
				reuse.set(
					key,
					this.capability.equal(ownedEntry.value, values.get(key), {
						publicationId: publication.publicationId,
						phase: "publisher-capture",
						side,
						key,
					})
				);
			}

			for (const key of targetKeys) {
				const ownedEntry = baselineByKey.get(key);
				if (ownedEntry !== undefined && reuse.get(key) === true) {
					entries.push(ownedEntry);
					continue;
				}
				const borrowedEntry = borrowedEntries.get(key);
				if (
					borrowedEntry !== undefined &&
					Object.is(values.get(key), borrowedEntry.value) &&
					(incremental || retentionBaselines !== undefined)
				) {
					entries.push(borrowedEntry);
					continue;
				}
				changed.push(key);
				entries.push(
					this.capability.createEntry(
						key,
						this.capability.copy(values.get(key), {
							publicationId: publication.publicationId,
							side,
							key,
							image: "post",
						})
					)
				);
			}
			for (const key of baselineByKey.keys()) {
				if (!targetKeys.has(key)) changed.push(key);
			}
			changed.sort();
			return this.capability.createSnapshot(entries);
		}
		if (instance || override) {
			for (const key of targetKeys) {
				const value = values.get(key);
				const retainedEntry = fallbackRetention.get(key);
				if (retainedEntry !== undefined) {
					entries.push(retainedEntry);
					continue;
				}
				const ownedEntry = baselineByKey.get(key);
				if (
					incremental &&
					ownedEntry !== undefined &&
					(candidateKeys === undefined ||
						!candidateKeys.has(key) ||
						this.capability.equal(ownedEntry.value, value, {
							publicationId: publication.publicationId,
							phase: "publisher-capture",
							side,
							key,
						}))
				) {
					entries.push(ownedEntry);
					continue;
				}
				const borrowedEntry = borrowedEntries.get(key);
				if (
					borrowedEntry !== undefined &&
					Object.is(value, borrowedEntry.value) &&
					(incremental || retentionBaselines !== undefined)
				) {
					entries.push(borrowedEntry);
					continue;
				}
				changed.push(key);
				entries.push(
					this.capability.createEntry(
						key,
						this.capability.copy(value, {
							publicationId: publication.publicationId,
							side,
							key,
							image: "post",
						})
					)
				);
			}
		}
		if (incremental) {
			for (const key of baselineByKey.keys()) {
				if (!targetKeys.has(key)) changed.push(key);
			}
		}
		changed.sort();
		return this.capability.createSnapshot(entries);
	}

	private selectFallbackRetention(
		side: SnapshotSide,
		publication: PublicationRecord,
		targetKeys: ReadonlySet<string>,
		values: ReadonlyMap<string, unknown>,
		borrowedEntries: ReadonlyMap<string, DRPState["state"][number]>,
		baselines: readonly DRPState[] | undefined
	): Map<string, DRPState["state"][number]> {
		const retained = new Map<string, DRPState["state"][number]>();
		if (baselines === undefined || baselines.length === 0) return retained;

		const candidatesByKey = new Map<string, DRPState["state"]>();
		for (const baseline of baselines) {
			for (const entry of baseline.state) {
				const candidates = candidatesByKey.get(entry.key);
				if (candidates === undefined) candidatesByKey.set(entry.key, [entry]);
				else candidates.push(entry);
			}
		}

		for (const key of targetKeys) {
			const candidates = candidatesByKey.get(key);
			if (candidates === undefined) continue;
			const borrowed = borrowedEntries.get(key);
			if (borrowed !== undefined && Object.is(values.get(key), borrowed.value)) {
				// The current identity proves the deferred cell remained unmaterialized, so
				// replay neither observed nor replaced this key. A semantic change between
				// the replay source and every frontier state would require such an access;
				// publication-only copies may change identity but preserve value. Therefore
				// unanimous frontier identity is a safe no-read retention proof.
				const exactEntry = candidates.find(
					(candidate) => candidate === borrowed || Object.is(candidate.value, borrowed.value)
				);
				if (exactEntry !== undefined) {
					retained.set(key, exactEntry);
					continue;
				}
				const consensus = candidates[0];
				if (
					consensus !== undefined &&
					candidates.every((candidate) => candidate === consensus || Object.is(candidate.value, consensus.value))
				) {
					retained.set(key, consensus);
					continue;
				}
			}
			for (const candidate of candidates) {
				if (
					this.capability.equal(candidate.value, values.get(key), {
						publicationId: publication.publicationId,
						phase: "publisher-capture",
						side,
						key,
					})
				) {
					retained.set(key, candidate);
					break;
				}
			}
		}
		return retained;
	}

	private collectValues(
		instance: IDRP | undefined,
		targetKeys: Set<string>,
		values: Map<string, unknown>,
		borrowedEntries: Map<string, DRPState["state"][number]>,
		materializeBorrowed = false
	): void {
		if (!instance) return;
		for (const key of Object.keys(instance)) {
			const value = materializeBorrowed
				? materializeEnumerableStateValue(instance, key)
				: readEnumerableStateValue(instance, key);
			if (REPLICA_LOCAL_STATE_KEYS.has(key) || typeof value === "function") continue;
			targetKeys.add(key);
			values.set(key, value);
			const borrowed = borrowedStateEntry(instance, key) as DRPState["state"][number] | undefined;
			if (borrowed?.key === key) borrowedEntries.set(key, borrowed);
		}
	}

	private applyOverride(
		side: SnapshotSide,
		publication: PublicationRecord,
		override: PublicationOverride,
		targetKeys: Set<string>,
		values: Map<string, unknown>,
		borrowedEntries: Map<string, DRPState["state"][number]>
	): void {
		const overrideKeys = new Set<string>();
		const baselineEntries = new Map(override.baseline.state.map((entry) => [entry.key, entry]));
		for (const key of Object.keys(override.instance)) {
			const value = readEnumerableStateValue(override.instance, key);
			if (REPLICA_LOCAL_STATE_KEYS.has(key) || typeof value === "function") continue;
			overrideKeys.add(key);
			const baselineEntry = baselineEntries.get(key);
			const borrowed = borrowedStateEntry(override.instance, key) as DRPState["state"][number] | undefined;
			if (borrowed !== undefined && (borrowed === baselineEntry || Object.is(borrowed.value, baselineEntry?.value))) {
				continue;
			}
			if (
				baselineEntry === undefined ||
				!this.capability.equal(baselineEntry.value, value, {
					publicationId: publication.publicationId,
					phase: "publisher-override",
					side,
					key,
				})
			) {
				targetKeys.add(key);
				values.set(key, value);
				borrowedEntries.delete(key);
			}
		}
		for (const key of baselineEntries.keys()) {
			if (!overrideKeys.has(key)) {
				targetKeys.delete(key);
				values.delete(key);
				borrowedEntries.delete(key);
			}
		}
	}

	private removeOldCheckpoint(journal: OperationJournal): void {
		const { checkpoints } = this.host;
		const removed = checkpoints[1];
		const previous = checkpoints[0];
		const next = checkpoints[2];
		const removedIndex = checkpoints.indexOf(removed);
		if (removedIndex !== -1) checkpoints.splice(removedIndex, 1);
		journal.record(() => {
			if (checkpoints.includes(removed)) return;
			const nextIndex = checkpoints.indexOf(next);
			if (nextIndex !== -1) checkpoints.splice(nextIndex, 0, removed);
			else {
				const previousIndex = checkpoints.indexOf(previous);
				if (previousIndex !== -1) checkpoints.splice(previousIndex + 1, 0, removed);
			}
		});
	}

	private pruneSnapshots(journal: OperationJournal): void {
		const retained = new Set<Hash>([this.host.rootHash]);
		for (const checkpoint of this.host.checkpoints) {
			for (const hash of checkpoint.frontier) retained.add(hash);
		}
		const latest = this.host.checkpoints[this.host.checkpoints.length - 1];
		const hashes = Array.from(this.host.hashGraph.vertices.keys());
		for (let index = latest.vertexCount; index < hashes.length; index++) retained.add(hashes[index]);
		const pruned = this.host.states.prune(retained);
		journal.record(() => this.host.states.restorePruned(pruned));
	}
}

function sameHashes(left: Hash[], right: Hash[]): boolean {
	return left.length === right.length && left.every((hash, index) => hash === right[index]);
}
