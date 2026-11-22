import { deepStrictEqual, throws } from "node:assert/strict";

import {
	assertNativeSelectedRead,
	id,
	must,
	OBJECT,
	OTHER,
	payload,
	type Reader,
	ref,
	type Trace,
} from "./contract.js";
import {
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	digestClosure,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
	type GenerationRecord,
	type PresentHead,
} from "../../../packages/storage/dist/src/index.js";

const nativeBytes = [payload(1), payload(2)],
	closure = nativeBytes.map(ref).sort((a, b) => a.digest.localeCompare(b.digest)),
	closureDigest = must(digestClosure(closure));
const nativeHead = (n: number): PresentHead => ({
	kind: "present",
	objectId: OBJECT,
	generationId: id(n),
	revision: n as PresentHead["revision"],
	closureDigest,
});
const nativeRecords = [3, 2, 1].map(
	(n): GenerationRecord =>
		must(
			decodeGenerationRecordV1(
				encodeGenerationRecordV1({
					objectId: OBJECT,
					generationId: id(n),
					state: n === 3 ? "Adopted" : "Superseded",
					baseExpectedHead: n === 1 ? { kind: "none", objectId: OBJECT } : nativeHead(n - 1),
					closure,
					closureDigest,
				})
			)
		)
);
const expectedHead = must(decodeHeadRecordV1(encodeHeadRecordV1(nativeHead(3))));
if (expectedHead.kind !== "present") throw new Error("pure fixture requires present head");
const nativeImage = {
	blobs: nativeBytes.map((bytes) => ({ digest: ref(bytes).digest, bytes })),
	promotions: nativeRecords.flatMap((g) =>
		g.closure.map((r) => ({ objectId: g.objectId, generationId: g.generationId, digest: r.digest }))
	),
};
const trace: Trace = {
	modes: [],
	writes: 0,
	terminals: 0,
	reads: nativeImage.promotions.map((p) => ({
		table: "promotions",
		operation: "get",
		query: [p.objectId, p.generationId, p.digest],
	})),
};
type Observation = Pick<Reader, "head" | "generations" | "blobs">;
const correct = (): Observation => ({
	head: { ...expectedHead },
	generations: nativeRecords.map((g) => ({
		...g,
		baseExpectedHead: { ...g.baseExpectedHead },
		closure: g.closure.map((r) => ({ ...r })),
	})),
	blobs: closure.map((r) => {
		const bytes = nativeImage.blobs.find((b) => b.digest === r.digest)?.bytes;
		if (!bytes) throw new Error("pure expected bytes absent");
		return { ref: { ...r }, bytes: bytes.slice() };
	}),
});
const firstRecord = nativeRecords[0];
if (!firstRecord || firstRecord.baseExpectedHead.kind !== "present") throw new Error("pure active/base record absent");
const firstBlob = correct().blobs[0];
if (!firstBlob) throw new Error("pure selected blob absent");
const changedRecord = (changes: Partial<GenerationRecord>): Observation => ({
	...correct(),
	generations: [{ ...firstRecord, ...changes }, ...nativeRecords.slice(1)],
});
const alternateDigest = must(digestClosure([ref(payload(9))]));
const faults: Record<string, Observation> = {
	"duplicate-valid-blob-omits-another-digest": { ...correct(), blobs: [firstBlob, firstBlob] },
	"omitted-digest": { ...correct(), blobs: [firstBlob] },
	"wrong-state": changedRecord({ state: "Discarded" }),
	"wrong-object-identity": changedRecord({ objectId: OTHER }),
	"wrong-generation-identity": changedRecord({ generationId: id(99) }),
	"wrong-base-revision": changedRecord({
		baseExpectedHead: { ...firstRecord.baseExpectedHead, revision: 99 as PresentHead["revision"] },
	}),
	"wrong-closure-digest": changedRecord({ closureDigest: alternateDigest }),
	"wrong-closure-metadata": changedRecord({ closure: [...closure].reverse() }),
	"wrong-native-head": { ...correct(), head: { ...expectedHead, revision: 99 as PresentHead["revision"] } },
	"wrong-ref-declared-length": {
		...correct(),
		blobs: correct().blobs.map((b) => ({ ...b, ref: { ...b.ref, byteLength: b.ref.byteLength + 1 } })),
	},
	"wrong-actual-bytes": {
		...correct(),
		blobs: correct().blobs.map((b) => ({ ...b, bytes: payload(77, b.bytes.byteLength) })),
	},
	"wrong-selected-record-order": { ...correct(), generations: [...nativeRecords].reverse() },
};
const verify = (observation: Observation): void => {
	const union = assertNativeSelectedRead(observation, expectedHead, nativeRecords, nativeImage, trace);
	deepStrictEqual([...union.keys()].sort(), closure.map((r) => r.digest).sort());
};
verify(correct());
verify({ ...correct(), blobs: [...correct().blobs].reverse() }); // Blob output ordering is not a new contract.
for (const [name, observation] of Object.entries(faults)) throws(() => verify(observation), /AHE_ORACLE:/u, name);
console.log(
	JSON.stringify({ pureControlOnly: true, productApiExecuted: false, accepted: 2, rejected: Object.keys(faults) })
);
