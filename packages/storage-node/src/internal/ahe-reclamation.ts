import {
	AHE_BOUNDED_READ_LIMITS,
	type AheDurableStore,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	encodeAheRetirementControl,
	encodeGenerationRecordV1,
	type ExpectedHead,
	type GenerationRecord,
	parseStorageObjectId,
} from "@ts-drp/storage";
import { isBoundedReadCorruption, PersistedStorageError } from "@ts-drp/storage/adapter";
import {
	AheReclamationError,
	type AheReclamationMaintenance,
	type AheReclamationPromotion,
	type AheReclamationReceipt,
	type AheReclamationSnapshot,
	bindAheReclamationMaintenance,
	captureAheReclamationInput,
	classifyAheReclamation,
	createAheReclamationError,
	createAheReclamationReceipt,
} from "@ts-drp/storage/maintenance";
import type { DatabaseSync } from "node:sqlite";

import {
	admitNodeRetirementControl,
	advanceNodeRetirementControl,
	readNodeRetirementControl,
} from "./retirement-control.js";

export type NodeAheReclamationCrashEdge =
	| "after-floor-rewrite"
	| "after-promotion-delete"
	| "after-generation-delete"
	| "after-blob-delete"
	| "before-commit"
	| "after-commit";

export type NodeAheReclamationCrashObserver = (edge: NodeAheReclamationCrashEdge) => void;

export type NodeAheReclamationCountFault = "blob delete" | "floor rewrite" | "generation delete" | "promotion delete";

type Lifecycle = Readonly<{
	isClosed(): boolean;
	isPoisoned(): boolean;
	latchPoison(): void;
}>;

type Row = Record<string, unknown>;

const maintenanceByStore = new WeakMap<AheDurableStore, AheReclamationMaintenance>();
const crashObserverByStore = new WeakMap<AheDurableStore, NodeAheReclamationCrashObserver>();
const countFaultByStore = new WeakMap<AheDurableStore, NodeAheReclamationCountFault>();

function databaseBytes(value: unknown): Uint8Array {
	if (!(value instanceof Uint8Array)) throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "row bytes invalid");
	return new Uint8Array(value);
}

function loadSnapshot(connection: DatabaseSync, objectId: string, bounded = false): AheReclamationSnapshot {
	const parsedObjectId = parseStorageObjectId(objectId);
	if (!parsedObjectId.ok) throw createAheReclamationError("AHE_RECLAMATION_INVALID_ARGUMENT", "object ID invalid");
	const objectRow = connection.prepare("SELECT head_record FROM objects WHERE object_id = ?").get(objectId) as
		| Row
		| undefined;
	let head: ExpectedHead = { kind: "none", objectId: parsedObjectId.value };
	if (objectRow !== undefined && objectRow.head_record !== null) {
		const decoded = decodeHeadRecordV1(databaseBytes(objectRow.head_record));
		if (!decoded.ok || decoded.value.objectId !== objectId) {
			throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "head row was malformed or misbound");
		}
		head = decoded.value;
	}

	const generations: GenerationRecord[] = [];
	for (const row of connection
		.prepare("SELECT object_id, generation_id, record FROM generations ORDER BY object_id, generation_id")
		.all() as Row[]) {
		const decoded = decodeGenerationRecordV1(databaseBytes(row.record));
		if (!decoded.ok || decoded.value.objectId !== row.object_id || decoded.value.generationId !== row.generation_id) {
			throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "generation row was malformed or misbound");
		}
		if (
			bounded &&
			decoded.value.objectId === objectId &&
			decoded.value.closure.length > AHE_BOUNDED_READ_LIMITS.maxClosureReferences
		)
			throw createAheReclamationError(
				"AHE_RECLAMATION_RETRY_REQUIRED",
				"shared native generation census exceeds bound"
			);
		generations.push(decoded.value);
	}

	if (
		bounded &&
		generations.filter((row) => row.objectId === objectId).length > AHE_BOUNDED_READ_LIMITS.maxObjectGenerations
	)
		throw createAheReclamationError(
			"AHE_RECLAMATION_RETRY_REQUIRED",
			"addressed native generation census exceeds bound"
		);
	const promotions = (
		connection
			.prepare("SELECT object_id, generation_id, digest FROM promotions ORDER BY object_id, generation_id, digest")
			.all() as Row[]
	).map(
		(row) =>
			({ objectId: row.object_id, generationId: row.generation_id, digest: row.digest }) as AheReclamationPromotion
	);
	const blobs = [];
	for (const row of connection
		.prepare(
			"SELECT blobs.digest, blobs.bytes FROM blobs " +
				"INNER JOIN (SELECT DISTINCT digest FROM promotions) AS referenced ON referenced.digest = blobs.digest " +
				"ORDER BY blobs.digest"
		)
		.all() as Row[]) {
		const capturedBytes = databaseBytes(row.bytes);
		blobs.push({ digest: row.digest, bytes: capturedBytes });
	}
	return { blobs, generations, head, promotions } as AheReclamationSnapshot;
}

function changed(result: { readonly changes: number | bigint }): number {
	return Number(result.changes);
}

function expectCount(
	store: AheDurableStore,
	actual: number,
	expected: number,
	label: NodeAheReclamationCountFault
): void {
	const observed = countFaultByStore.get(store) === label ? actual + 1 : actual;
	if (observed !== expected) {
		throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", `${label} count mismatch`);
	}
}

class NodeAheReclamationMaintenance implements AheReclamationMaintenance {
	public constructor(
		private readonly store: AheDurableStore,
		private readonly connection: DatabaseSync,
		private readonly lifecycle: Lifecycle
	) {}

	public async reclaimClosedEpoch(input: unknown): Promise<AheReclamationReceipt> {
		await Promise.resolve();
		const captured = captureAheReclamationInput(input);
		if (this.lifecycle.isClosed()) {
			throw createAheReclamationError("AHE_RECLAMATION_STORE_CLOSED", "store is closed");
		}
		if (this.lifecycle.isPoisoned()) {
			throw createAheReclamationError("AHE_RECLAMATION_STORE_POISONED", "store is poisoned");
		}
		let transaction = false;
		let committed = false;
		try {
			this.connection.exec("BEGIN IMMEDIATE");
			transaction = true;
			const objectId = parseStorageObjectId(captured.objectId);
			if (!objectId.ok) throw createAheReclamationError("AHE_RECLAMATION_INVALID_ARGUMENT", "object ID invalid");
			const control = readNodeRetirementControl(this.connection, objectId.value);
			if (
				control !== null &&
				(control.active !== null || control.completed !== null || control.revision === Number.MAX_SAFE_INTEGER)
			)
				throw createAheReclamationError(
					"AHE_RECLAMATION_RETRY_REQUIRED",
					"native AHE retirement reservation prevents reclamation"
				);
			if (control !== null) {
				const admitted = admitNodeRetirementControl(
					this.connection,
					control.objectId,
					encodeAheRetirementControl(control)
				);
				if (!admitted.ok)
					throw createAheReclamationError(
						isBoundedReadCorruption(admitted) ? "AHE_RECLAMATION_CORRUPT" : "AHE_RECLAMATION_RETRY_REQUIRED",
						`native control admission refused: ${admitted.reason}`
					);
			}
			const decision = applyNodeBoundedAheReclamation(this.connection, this.store, captured);
			const observer = crashObserverByStore.get(this.store);
			observer?.("before-commit");
			const advanced = advanceNodeRetirementControl(this.connection, control);
			if (!advanced.ok)
				throw createAheReclamationError(
					isBoundedReadCorruption(advanced) ? "AHE_RECLAMATION_CORRUPT" : "AHE_RECLAMATION_RETRY_REQUIRED",
					`native control postimage refused: ${advanced.reason}`
				);
			this.connection.exec("COMMIT");
			transaction = false;
			committed = true;
			observer?.("after-commit");
			return createAheReclamationReceipt(decision);
		} catch (error) {
			if (transaction) {
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					// Preserve the primary classified failure.
				}
			}
			if (error instanceof AheReclamationError) {
				if (error.code === "AHE_RECLAMATION_CORRUPT") this.lifecycle.latchPoison();
				throw error;
			}
			if (error instanceof PersistedStorageError) {
				this.lifecycle.latchPoison();
				throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "retirement metadata was malformed", error);
			}
			if (committed)
				throw createAheReclamationError("AHE_RECLAMATION_SUBSTRATE_FAILURE", "post-commit observer failed", error);
			throw createAheReclamationError("AHE_RECLAMATION_SUBSTRATE_FAILURE", "SQLite reclamation failed", error);
		}
	}
}

/**
 * Applies the original classified OLD/NEW rewrite in its caller-owned native
 * transaction. Bounded retirement is mechanical CAS enforcement, not eligibility.
 * @param connection Original native transaction/connection.
 * @param store Exact maintenance facade.
 * @param captured Original detached reclamation input.
 * @param bounded Whether the existing seven-row admission and fixed16 deletes apply.
 * @returns The original exact reclamation decision; caller still joins COMMIT.
 */
export function applyNodeBoundedAheReclamation(
	connection: DatabaseSync,
	store: AheDurableStore,
	captured: ReturnType<typeof captureAheReclamationInput>,
	bounded = false
): ReturnType<typeof classifyAheReclamation> {
	const decision = classifyAheReclamation(captured, loadSnapshot(connection, captured.objectId, bounded));
	if (
		bounded &&
		(decision.deleteGenerationIds.length > 1 ||
			decision.deleteGenerationIds.length + decision.deletePromotions.length + decision.deleteBlobDigests.length > 16)
	)
		throw createAheReclamationError("AHE_RECLAMATION_RETRY_REQUIRED", "bounded native reclamation exceeds fixed batch");
	const observer = crashObserverByStore.get(store);
	for (const source of decision.independentSourceFloors ?? [])
		if (source.normalizedThisCall) {
			expectCount(
				store,
				changed(
					connection
						.prepare("UPDATE generations SET record = ? WHERE object_id = ? AND generation_id = ?")
						.run(
							encodeGenerationRecordV1(source.rewrittenGeneration),
							captured.objectId,
							source.generation.generationId
						)
				),
				1,
				"floor rewrite"
			);
		}
	if (decision.floor.normalizedThisCall) {
		expectCount(
			store,
			changed(
				connection
					.prepare("UPDATE generations SET record = ? WHERE object_id = ? AND generation_id = ?")
					.run(
						encodeGenerationRecordV1(decision.floor.rewrittenGeneration),
						captured.objectId,
						captured.lineageFloor.generationId
					)
			),
			1,
			"floor rewrite"
		);
		observer?.("after-floor-rewrite");
	}
	let promotionDeletes = 0;
	const deletePromotion = connection.prepare(
		"DELETE FROM promotions WHERE object_id = ? AND generation_id = ? AND digest = ?"
	);
	for (const promotion of decision.deletePromotions) {
		promotionDeletes += changed(deletePromotion.run(promotion.objectId, promotion.generationId, promotion.digest));
	}
	expectCount(store, promotionDeletes, decision.deletePromotions.length, "promotion delete");
	if (decision.floor.normalizedThisCall) observer?.("after-promotion-delete");

	let generationDeletes = 0;
	const deleteGeneration = connection.prepare("DELETE FROM generations WHERE object_id = ? AND generation_id = ?");
	for (const generationId of decision.deleteGenerationIds) {
		generationDeletes += changed(deleteGeneration.run(captured.objectId, generationId));
	}
	expectCount(store, generationDeletes, decision.deleteGenerationIds.length, "generation delete");
	if (decision.floor.normalizedThisCall) observer?.("after-generation-delete");

	let blobDeletes = 0;
	const deleteBlob = connection.prepare("DELETE FROM blobs WHERE digest = ?");
	for (const digest of decision.deleteBlobDigests) blobDeletes += changed(deleteBlob.run(digest));
	expectCount(store, blobDeletes, decision.deleteBlobDigests.length, "blob delete");
	if (decision.floor.normalizedThisCall) observer?.("after-blob-delete");

	const post = classifyAheReclamation(captured, loadSnapshot(connection, captured.objectId, bounded));
	if (
		post.floor.normalizedThisCall ||
		post.independentSourceFloors?.some((source) => source.normalizedThisCall) ||
		post.deleteGenerationIds.length !== 0 ||
		post.deletePromotions.length !== 0 ||
		post.deleteBlobDigests.length !== 0
	) {
		throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "post-state was not a complete replay");
	}
	return decision;
}

/**
 * Registers maintenance authority for one genuine SQLite facade.
 * @param store - Exact facade identity.
 * @param connection - Live owning SQLite connection.
 * @param lifecycle - Owning facade lifecycle controls.
 */
export function registerNodeAheReclamationMaintenance(
	store: AheDurableStore,
	connection: DatabaseSync,
	lifecycle: Lifecycle
): void {
	const maintenance = new NodeAheReclamationMaintenance(store, connection, lifecycle);
	if (!bindAheReclamationMaintenance(store, maintenance)) {
		throw new TypeError("AHE maintenance facade is already registered");
	}
	maintenanceByStore.set(store, maintenance);
}

/**
 * Resolves maintenance only for the registered facade identity.
 * @param store - Candidate facade identity.
 * @returns The identity-bound maintenance owner, if registered.
 */
export function nodeAheReclamationMaintenanceForStore(store: AheDurableStore): AheReclamationMaintenance | undefined {
	return maintenanceByStore.get(store);
}

/**
 * Installs the maintenance-only process-death observer for a package-local test.
 * @param store - Exact registered SQLite facade.
 * @param observer - Fixed checkpoint observer.
 */
export function installNodeAheReclamationCrashObserver(
	store: AheDurableStore,
	observer: NodeAheReclamationCrashObserver
): void {
	if (!maintenanceByStore.has(store)) throw new TypeError("D109C_NODE_MAINTENANCE_MISSING");
	crashObserverByStore.set(store, observer);
}

/**
 * Installs one fixed maintenance-only count mismatch for a package-local test.
 * @param store - Exact registered SQLite facade.
 * @param fault - Fixed row-count category to misreport.
 */
export function installNodeAheReclamationCountFault(store: AheDurableStore, fault: NodeAheReclamationCountFault): void {
	if (!maintenanceByStore.has(store)) throw new TypeError("D109C_NODE_MAINTENANCE_MISSING");
	countFaultByStore.set(store, fault);
}
