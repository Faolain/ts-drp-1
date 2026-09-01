import {
	type AheDurableStore,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	encodeGenerationRecordV1,
	type ExpectedHead,
	type GenerationRecord,
	parseStorageObjectId,
} from "@ts-drp/storage";
import {
	AheReclamationError,
	type AheReclamationMaintenance,
	type AheReclamationPromotion,
	type AheReclamationReceipt,
	type AheReclamationSnapshot,
	captureAheReclamationInput,
	classifyAheReclamation,
	createAheReclamationError,
	createAheReclamationReceipt,
} from "@ts-drp/storage/maintenance";
import type { DatabaseSync } from "node:sqlite";

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

function loadSnapshot(connection: DatabaseSync, objectId: string): AheReclamationSnapshot {
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
		generations.push(decoded.value);
	}

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
		blobs.push({ digest: row.digest, bytes: databaseBytes(row.bytes) });
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
			const decision = classifyAheReclamation(captured, loadSnapshot(this.connection, captured.objectId));
			const observer = crashObserverByStore.get(this.store);
			if (decision.floor.normalizedThisCall) {
				expectCount(
					this.store,
					changed(
						this.connection
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
			const deletePromotion = this.connection.prepare(
				"DELETE FROM promotions WHERE object_id = ? AND generation_id = ? AND digest = ?"
			);
			for (const promotion of decision.deletePromotions) {
				promotionDeletes += changed(deletePromotion.run(promotion.objectId, promotion.generationId, promotion.digest));
			}
			expectCount(this.store, promotionDeletes, decision.deletePromotions.length, "promotion delete");
			if (decision.floor.normalizedThisCall) observer?.("after-promotion-delete");

			let generationDeletes = 0;
			const deleteGeneration = this.connection.prepare(
				"DELETE FROM generations WHERE object_id = ? AND generation_id = ?"
			);
			for (const generationId of decision.deleteGenerationIds) {
				generationDeletes += changed(deleteGeneration.run(captured.objectId, generationId));
			}
			expectCount(this.store, generationDeletes, decision.deleteGenerationIds.length, "generation delete");
			if (decision.floor.normalizedThisCall) observer?.("after-generation-delete");

			let blobDeletes = 0;
			const deleteBlob = this.connection.prepare("DELETE FROM blobs WHERE digest = ?");
			for (const digest of decision.deleteBlobDigests) blobDeletes += changed(deleteBlob.run(digest));
			expectCount(this.store, blobDeletes, decision.deleteBlobDigests.length, "blob delete");
			if (decision.floor.normalizedThisCall) observer?.("after-blob-delete");

			const post = classifyAheReclamation(captured, loadSnapshot(this.connection, captured.objectId));
			if (
				post.floor.normalizedThisCall ||
				post.deleteGenerationIds.length !== 0 ||
				post.deletePromotions.length !== 0 ||
				post.deleteBlobDigests.length !== 0
			) {
				throw createAheReclamationError("AHE_RECLAMATION_CORRUPT", "post-state was not a complete replay");
			}
			observer?.("before-commit");
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
			if (committed)
				throw createAheReclamationError("AHE_RECLAMATION_SUBSTRATE_FAILURE", "post-commit observer failed", error);
			throw createAheReclamationError("AHE_RECLAMATION_SUBSTRATE_FAILURE", "SQLite reclamation failed", error);
		}
	}
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
	maintenanceByStore.set(store, new NodeAheReclamationMaintenance(store, connection, lifecycle));
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
