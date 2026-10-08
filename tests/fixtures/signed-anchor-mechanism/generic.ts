/* eslint-disable jsdoc/require-jsdoc -- Actual shared generic ref, integrity fixture only; no producer or budget change. */
import { digestBlob, digestClosure, encodeGenerationRecordV1 } from "@ts-drp/storage";

import { editRefs, imageReader } from "../rollback-data-observation/integrity.js";
import { requireThat } from "../rollback-data-observation/proof.js";
import type { NativePort } from "../rollback-data-observation/types.js";
export async function addGenericToOldestClosure(
	port: NativePort
): Promise<{ actualGenericBytes: number; actualDistinctUnionBytes: number; closureCounts: number[] }> {
	let image = await port.image();
	const original = imageReader(image),
		bytes = new Uint8Array(65536).fill(0xaa),
		digest = digestBlob(bytes);
	requireThat(digest.ok, "actual inert generic bytes");
	image.blobs.push({ digest: digest.value, bytes });
	const oldest = original.generations.at(-1);
	requireThat(oldest, "actual selected oldest generation");
	for (const generation of [oldest]) {
		requireThat(generation.closure.length < 7, "fixed F7 capacity for actual generic ref");
		const closure = [...generation.closure, { digest: digest.value, byteLength: bytes.length }].sort((a, b) =>
			a.digest.localeCompare(b.digest)
		);
		const closureDigest = digestClosure(closure);
		requireThat(closureDigest.ok, "exact real generic closure");
		const row = image.generations.find((row) => row.generationId === generation.generationId);
		requireThat(row, "actual selected generation");
		row.record = encodeGenerationRecordV1({ ...generation, closure, closureDigest: closureDigest.value });
		image.promotions.push({
			objectId: generation.objectId,
			generationId: generation.generationId,
			digest: digest.value,
		});
	}
	image = editRefs(image, new Map());
	await port.replace(image);
	const actual = imageReader(image);
	return {
		actualGenericBytes: bytes.length,
		actualDistinctUnionBytes: actual.blobs.reduce((sum, blob) => sum + blob.bytes.length, 0),
		closureCounts: actual.generations.map((generation) => generation.closure.length),
	};
}
