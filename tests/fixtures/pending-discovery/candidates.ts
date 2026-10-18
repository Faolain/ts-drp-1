import { publishUnrelatedHead } from "./ahe-race.js";
import type { RecoveryCase, RestartBootstrap } from "./types.js";
import { decodeCanonical, encodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import {
	type AheDurableStore,
	type BlobDigest,
	digestBlob,
	type GenerationRecord,
	parseGenerationId,
	parseStorageObjectId,
} from "../../../packages/storage/dist/src/index.js";
/**
 * Install actual durable retry/fork/control candidates through the existing owner, never synthesize authentication.
 * @param store - Explicit fixture-owned input for this isolated control.
 * @param bootstrap - Explicit fixture-owned input for this isolated control.
 * @param mode - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function prepareCandidates(
	store: AheDurableStore,
	bootstrap: RestartBootstrap,
	mode: RecoveryCase
): Promise<string[]> {
	const parsed = parseStorageObjectId(bootstrap.expectedPreviousRoomHead.objectId);
	if (!parsed.ok) throw new Error("CANDIDATE_OBJECT");
	const page = await store.readGenerationPage({ objectId: parsed.value, limit: 128 });
	if (!page.ok || page.value.nextCursor !== null) throw new Error("CANDIDATE_LINEAGE");
	let target: GenerationRecord | undefined;
	for (const generation of page.value.generations) {
		if (generation.state !== "Complete" && generation.state !== "Adopted") continue;
		for (const ref of generation.closure) {
			const blob = await store.getBlob(ref.digest);
			if (!blob.ok || blob.value === null) throw new Error("CANDIDATE_BLOB");
			const record = decodeCanonical(blob.value) as Record<string, unknown>;
			if (record.kind === "v3-live-generation-2" && record.epoch === bootstrap.expectedNextRoomHead.epoch) {
				if (target !== undefined) throw new Error("CANDIDATE_TARGET_AMBIGUOUS");
				target = generation;
				break;
			}
		}
	}
	if (target === undefined) throw new Error("CANDIDATE_TARGET_MISSING");
	const ids = [target.generationId];
	if (mode === "stale-base") {
		if (target.baseExpectedHead.kind !== "present") throw new Error("STALE_CONTROL_BASE");
		await publishUnrelatedHead(store, target.baseExpectedHead);
		return ids;
	}
	if (
		![
			"retry",
			"retry-active",
			"mixed-unavailable",
			"divergent-mixed-unavailable",
			"fork",
			"fork-active",
			"stale-base",
			"incomplete",
			"unmatched",
		].includes(mode)
	)
		return ids;
	const id = parseGenerationId("0".repeat(63) + "1");
	if (!id.ok) throw new Error("CANDIDATE_ID");
	if (target.generationId === id.value) throw new Error("CANDIDATE_ID_COLLISION");
	let closure = target.closure;
	let variant: { bytes: Uint8Array; digest: BlobDigest } | undefined;
	if (mode === "fork" || mode === "fork-active" || mode === "divergent-mixed-unavailable") {
		const found = [];
		for (const ref of closure) {
			const b = await store.getBlob(ref.digest);
			if (!b.ok || b.value === null) throw new Error("FORK_BLOB");
			const r = decodeCanonical(b.value) as Record<string, unknown>;
			if (r.kind === "v3-live-generation-2" && r.epoch === bootstrap.expectedNextRoomHead.epoch) found.push({ ref, r });
		}
		if (found.length !== 1) throw new Error("FORK_PROJECTION");
		const selected = found[0];
		if (selected === undefined) throw new Error("FORK_PROJECTION_MISSING");
		const bytes = encodeCanonical({ ...selected.r, pendingForkControl: "different-authenticated-closure" }),
			d = digestBlob(bytes);
		if (!d.ok) throw new Error("FORK_DIGEST");
		variant = { bytes, digest: d.value };
		closure = closure
			.map((ref) => (ref.digest === selected.ref.digest ? { digest: d.value, byteLength: bytes.byteLength } : ref))
			.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
	}
	const scope = { objectId: parsed.value, generationId: id.value };
	const baseExpectedHead = target.baseExpectedHead;
	const begun = await store.beginGeneration({ ...scope, baseExpectedHead, closure });
	if (!begun.ok) throw new Error("CANDIDATE_BEGIN:" + begun.reason);
	if (variant !== undefined) {
		const cached = await store.putCachedBlob({ ...scope, ...variant });
		if (!cached.ok) throw new Error("CANDIDATE_CACHE");
	}
	for (const ref of closure) {
		const promoted = await store.promoteReference({ ...scope, digest: ref.digest });
		if (!promoted.ok) throw new Error("CANDIDATE_PROMOTE");
	}
	if (mode !== "incomplete") {
		const done = await store.completeGeneration(scope);
		if (!done.ok) throw new Error("CANDIDATE_COMPLETE");
	}
	if (mode === "incomplete" || mode === "unmatched") {
		const discarded = await store.discardGeneration({ objectId: target.objectId, generationId: target.generationId });
		if (!discarded.ok) throw new Error("ORIGINAL_CANDIDATE_DISCARD");
	}
	ids.push(id.value);
	return ids;
}
