/* eslint-disable @typescript-eslint/no-non-null-assertion -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
/* eslint-disable jsdoc/require-jsdoc -- Explicit persistence integrity fixture; not shipped custody or retirement policy. */
import {
	completeCreatorAuthorIssuanceFrontiers,
	CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
	prepareCreatorAuthorIssuanceFrontiers,
} from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import {
	type AheBoundedActiveRead,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestBlob,
	digestClosure,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type GenerationRecord,
	type GenerationRef,
} from "@ts-drp/storage";

import { record, requireThat, trustedPair, unique, views } from "./proof.js";
import type { Bootstrap, Floor, NativeImage, NativePort } from "./types.js";
import {
	createRecoverableFinalitySigner,
	signCreatorIssuanceRetirementRequest,
} from "../../../packages/keychain/dist/src/finality.js";
import { seed } from "../cold-discovery/application.js";
export function imageReader(image: NativeImage): AheBoundedActiveRead {
	const h = decodeHeadRecordV1(image.heads[0]!.record);
	requireThat(h.ok && h.value.kind === "present", "real head image");
	const records = image.generations.map((r) => {
		const g = decodeGenerationRecordV1(r.record);
		requireThat(g.ok, "real generation record");
		return g.value;
	});
	const selected: GenerationRecord[] = [];
	let id: string | undefined = h.value.generationId;
	for (let i = 0; i < 3 && id; i++) {
		const r = records.find((r) => r.generationId === id);
		requireThat(r, "real selected ancestry");
		selected.push(r);
		id = r.baseExpectedHead.kind === "present" ? r.baseExpectedHead.generationId : undefined;
	}
	const refs = new Map(selected.flatMap((g) => g.closure).map((r) => [r.digest, r]));
	const blobs = [...refs.values()].map((ref) => {
		const row = image.blobs.find((b) => b.digest === ref.digest);
		requireThat(row, "real blob row");
		return { ref, bytes: row.bytes };
	});
	return {
		head: h.value,
		generations: selected,
		blobs,
		checkCurrent: () => Promise.reject(new Error("fixture view is not an owner")),
		release: () => Promise.reject(new Error("fixture view is not a reader")),
	};
}
export function normalizeImage(image: NativeImage): NativeImage {
	const selected = imageReader(image).generations,
		ids = new Set<string>(selected.map((g) => g.generationId)),
		oldest = selected.at(-1)!;
	const generations = image.generations
		.filter((g) => ids.has(g.generationId))
		.map((row) =>
			row.generationId === oldest.generationId
				? {
						...row,
						record: encodeGenerationRecordV1({
							...oldest,
							baseExpectedHead: { kind: "none", objectId: oldest.objectId },
						}),
					}
				: row
		);
	const refs = new Set<string>(selected.flatMap((g) => g.closure.map((r) => r.digest)));
	return {
		heads: image.heads,
		generations,
		blobs: image.blobs.filter((b) => refs.has(b.digest)),
		promotions: image.promotions.filter((p) => ids.has(p.generationId) && refs.has(p.digest)),
	};
}
export function editRefs(
	image: NativeImage,
	replacements: Map<string, Uint8Array>,
	removeFrom?: { generationId: string; digest: string }
): NativeImage {
	const newRefs = new Map<string, GenerationRef>();
	for (const [old, bytes] of replacements) {
		const d = digestBlob(bytes);
		requireThat(d.ok, "replacement digest");
		newRefs.set(old, { digest: d.value, byteLength: bytes.length });
	}
	const originals = image.generations.map((row) => {
		const r = decodeGenerationRecordV1(row.record);
		requireThat(r.ok, "original metadata");
		return r.value;
	});
	const changed = new Map<string, GenerationRecord>();
	function rewrite(g: GenerationRecord): GenerationRecord {
		const prior = changed.get(g.generationId);
		if (prior) return prior;
		const closure = g.closure
			.filter((r) => !(removeFrom?.generationId === g.generationId && removeFrom.digest === r.digest))
			.map((r) => newRefs.get(r.digest) ?? r)
			.sort((a, b) => a.digest.localeCompare(b.digest));
		const d = digestClosure(closure);
		requireThat(d.ok, "new exact closure");
		let baseExpectedHead = g.baseExpectedHead;
		if (baseExpectedHead.kind === "present") {
			const baseId = baseExpectedHead.generationId;
			const p = originals.find((r) => r.generationId === baseId);
			if (p) baseExpectedHead = { ...baseExpectedHead, closureDigest: rewrite(p).closureDigest };
		}
		const r = { ...g, closure, closureDigest: d.value, baseExpectedHead };
		changed.set(g.generationId, r);
		return r;
	}
	const records = originals.map(rewrite);
	const heads = image.heads.map((row) => {
		const h = decodeHeadRecordV1(row.record);
		requireThat(h.ok && h.value.kind === "present", "native head");
		const g = changed.get(h.value.generationId)!;
		return { ...row, record: encodeHeadRecordV1({ ...h.value, closureDigest: g.closureDigest }) };
	});
	const promotions = records.flatMap((g) =>
		g.closure.map((r) => ({ objectId: g.objectId, generationId: g.generationId, digest: r.digest }))
	);
	const blobs = [
		...image.blobs.filter((b) => !replacements.has(b.digest)),
		...[...replacements].map(([old, bytes]) => ({ digest: newRefs.get(old)!.digest, bytes })),
	];
	return {
		heads,
		generations: records.map((r) => ({
			objectId: r.objectId,
			generationId: r.generationId,
			record: encodeGenerationRecordV1(r),
		})),
		promotions,
		blobs,
	};
}
export async function provisionLegacy(port: NativePort, b: Bootstrap, floor: Floor): Promise<unknown> {
	let image = normalizeImage(await port.image());
	const reader = imageReader(image),
		pair = trustedPair(b, floor, reader),
		v = views(reader);
	const oldAggregate = unique(v[2]!, "drp-creator-author-issuance-frontiers-state");
	const latest = unique(v[1]!, "drp-creator-author-issuance-frontiers-state"),
		r = record(latest.bytes);
	const prepared = prepareCreatorAuthorIssuanceFrontiers({
		commitQcRef: r.commitQcRef,
		currentAclDigest: r.currentAclDigest,
		currentTrust: pair.current,
		cutValueDigest: r.cutValueDigest,
		frontiers: r.frontiers,
		priorAggregateCandidateDigest: CREATOR_AUTHOR_ISSUANCE_FRONTIERS_GENESIS_SENTINEL,
		snapshotManifestDigest: r.snapshotManifestDigest,
		successorAclDigest: r.successorAclDigest,
		successorTrust: pair.successor,
	});
	requireThat(prepared.ok, "genuine existing aggregate preparation against real pair");
	const signer = await createRecoverableFinalitySigner({ seed: Uint8Array.from(seed) });
	const signature = await signCreatorIssuanceRetirementRequest({
		request: prepared.signingRequest,
		signer: signer.signer,
	});
	const completed = completeCreatorAuthorIssuanceFrontiers({
		detachedSignature: signature,
		preparation: prepared.preparation,
	});
	requireThat(completed.ok, "genuine signed aggregate completion");
	const oldRetirement = unique(v[2]!, "drp-creator-issuance-retirement-state", floor.stable.epoch - 2);
	image = editRefs(image, new Map([[latest.ref.digest, completed.exactCanonicalRecordBytes]]), {
		generationId: reader.generations[2]!.generationId,
		digest: oldAggregate.ref.digest,
	});
	await port.replace(image);
	return {
		integrityFixtureOnly: true,
		notShippedCustody: true,
		signedOwner:
			"prepareCreatorAuthorIssuanceFrontiers -> signCreatorIssuanceRetirementRequest -> completeCreatorAuthorIssuanceFrontiers",
		unchangedGenuineOldRetirementRef: oldRetirement.ref,
		oldEpoch: floor.stable.epoch - 2,
		selectedRows: image.generations.length,
		physicallyErasedPrefix: true,
	};
}
