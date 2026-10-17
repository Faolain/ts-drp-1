import { AHE_BOUNDED_READ_LIMITS as LIMITS } from "@ts-drp/storage";
import {
	AHE_LOCAL_CONTROL_CENSUS_LIMITS,
	BoundedReadBudgetError,
	PersistedStorageError,
	type RetirementAdmissionRequest,
} from "@ts-drp/storage/adapter";
import type { DatabaseSync } from "node:sqlite";

type DatabaseRow = Record<string, unknown>;

/**
 * Loads original bounded native requests inside the caller's transaction.
 * Shared by ordinary bounded reads and local-control admission; owns no transaction/cache.
 * @param connection - Genuine existing transaction owner.
 * @param request - Shared mechanical request, not planner authority.
 * @returns Scalar-gated native values.
 */
export function loadNodeBoundedReadRequest(connection: DatabaseSync, request: RetirementAdmissionRequest): unknown {
	if (request.kind === "blob-preflight" || request.kind === "blob-census-preflight") {
		let total = 0;
		for (const ref of request.references) {
			const row = connection
				.prepare("SELECT typeof(bytes) AS value_type,length(bytes) AS value_bytes FROM blobs WHERE digest=?")
				.get(ref.digest) as DatabaseRow | undefined;
			if (row?.value_type === "blob" && typeof row.value_bytes === "number") {
				if (row.value_bytes > LIMITS.maxBlobBytes) return false;
				total += row.value_bytes;
				if (request.kind === "blob-census-preflight" && total > LIMITS.maxUnionBytes) return false;
			}
		}
		return true;
	}
	if (request.kind === "keys") {
		const rows = connection
			.prepare(
				"SELECT CASE WHEN typeof(generation_id)='text' AND length(CAST(generation_id AS BLOB))=64 THEN generation_id ELSE NULL END AS gated_key FROM generations WHERE object_id=? ORDER BY generation_id LIMIT ?"
			)
			.all(request.objectId, LIMITS.maxObjectGenerations + 1) as DatabaseRow[];
		return rows.map((row) => row.gated_key);
	}
	if (request.kind === "promotions") {
		const rows = connection
			.prepare(
				"SELECT CASE WHEN typeof(generation_id)='text' AND length(CAST(generation_id AS BLOB))=64 THEN generation_id ELSE NULL END AS generationId,CASE WHEN typeof(digest)='text' AND length(CAST(digest AS BLOB))=64 THEN digest ELSE NULL END AS digest FROM promotions WHERE object_id=? ORDER BY generation_id,digest LIMIT ?"
			)
			.all(request.objectId, AHE_LOCAL_CONTROL_CENSUS_LIMITS.maxPromotions + 1) as DatabaseRow[];
		return rows.map((row) => ({ generationId: row.generationId, digest: row.digest }));
	}
	if (request.kind === "promotion")
		return (
			connection
				.prepare("SELECT 1 FROM promotions WHERE object_id=? AND generation_id=? AND digest=?")
				.get(request.objectId, request.generationId, request.digest) !== undefined
		);
	const blob = request.kind === "blob",
		head = request.kind === "head";
	const limit = blob ? LIMITS.maxBlobBytes : head ? LIMITS.maxHeadBytes : LIMITS.maxGenerationBytes;
	const row = (
		blob
			? connection
					.prepare(
						"SELECT typeof(bytes) AS value_type,length(bytes) AS value_bytes,CASE WHEN typeof(bytes)='blob' AND length(bytes)<=? THEN bytes ELSE NULL END AS bytes FROM blobs WHERE digest=?"
					)
					.get(limit, request.digest)
			: head
				? connection
						.prepare(
							"SELECT typeof(head_record) AS value_type,length(head_record) AS value_bytes,CASE WHEN typeof(head_record)='blob' AND length(head_record)<=? THEN head_record ELSE NULL END AS head_record FROM objects WHERE object_id=?"
						)
						.get(limit, request.objectId)
				: connection
						.prepare(
							"SELECT typeof(record) AS value_type,length(record) AS value_bytes,CASE WHEN typeof(generation_id)='text' AND length(CAST(generation_id AS BLOB))=64 THEN generation_id ELSE NULL END AS gated_key,CASE WHEN typeof(record)='blob' AND length(record)<=? THEN record ELSE NULL END AS record FROM generations WHERE object_id=? AND generation_id=?"
						)
						.get(limit, request.objectId, request.generationId)
	) as DatabaseRow | undefined;
	if (row === undefined || (head && row.value_type === "null")) return null;
	if (head && row.value_type !== "blob") throw new PersistedStorageError("NON_CANONICAL_RECORD");
	if (row.value_type === "blob" && typeof row.value_bytes === "number" && row.value_bytes > limit)
		throw new BoundedReadBudgetError();
	if (blob) return row.value_type === "blob" ? row.bytes : undefined;
	return head
		? { objectId: request.objectId, record: row.head_record }
		: { objectId: request.objectId, generationId: row.gated_key, record: row.record };
}
