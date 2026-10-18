import { encodeCanonical } from "../../../packages/canonical/dist/src/index.js";
import {
	type AheDurableStore,
	digestBlob,
	parseGenerationId,
	type PresentHead,
} from "../../../packages/storage/dist/src/index.js";
/**
 * Publish a genuine unrelated native head as a controlled concurrent owner race.
 * @param store - Exact actual native AHE owner.
 * @param base - Durable compare-and-swap base, not a snapshot selection hint.
 */
export async function publishUnrelatedHead(store: AheDurableStore, base: PresentHead): Promise<void> {
	const generationId = parseGenerationId("0".repeat(63) + "2"),
		bytes = encodeCanonical({ kind: "pending-unrelated-head-control" }),
		digest = digestBlob(bytes);
	if (!generationId.ok || !digest.ok) throw new Error("UNRELATED_CONTROL_ID");
	const scope = { objectId: base.objectId, generationId: generationId.value };
	const begun = await store.beginGeneration({
		...scope,
		baseExpectedHead: base,
		closure: [{ digest: digest.value, byteLength: bytes.byteLength }],
	});
	if (!begun.ok) throw new Error("UNRELATED_CONTROL_BEGIN");
	if (
		!(await store.putCachedBlob({ ...scope, bytes, digest: digest.value })).ok ||
		!(await store.promoteReference({ ...scope, digest: digest.value })).ok ||
		!(await store.completeGeneration(scope)).ok ||
		!(await store.swapHead({ ...scope, expectedHead: base })).ok
	)
		throw new Error("UNRELATED_CONTROL_PUBLICATION");
}
