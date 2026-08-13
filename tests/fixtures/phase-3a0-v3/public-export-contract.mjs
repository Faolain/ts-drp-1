const expected = [
	"ANCHOR_TRUST_STATE_MAX_RECORD_BYTES",
	"admitReceivedVertex",
	"authenticateCurrentEpochAnchor",
	"createAdmissionBoundTransactionalVertexIssuer",
	"installCreatorAnchorTrustRoot",
	"isAnchorTrustStateRecordBytes",
	"openCurrentAnchorTrust",
	"prepareBlueprintAdmission",
	"prepareBlueprintRuntime",
];

const target = process.env.PHASE_3A0_PUBLIC_ENTRY ?? "../../../packages/protocol-v3/src/public.ts";
const actual = Object.keys(await import(new URL(target, import.meta.url))).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
	throw new Error(`protocol-v3 public export set changed: ${actual.join(",")}`);
}
console.log(`protocol-v3 closed public export set: ${actual.join(",")}`);
