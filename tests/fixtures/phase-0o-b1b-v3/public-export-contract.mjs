const expected = [
	"admitReceivedVertex",
	"createAdmissionBoundTransactionalVertexIssuer",
	"prepareBlueprintAdmission",
	"prepareBlueprintRuntime",
];

const target = process.env.PHASE_0O_B1B_PUBLIC_ENTRY ?? "../../../packages/protocol-v3/src/public.ts";
const actual = Object.keys(await import(new URL(target, import.meta.url))).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
	throw new Error(`protocol-v3 public export set changed: ${actual.join(",")}`);
}
console.log(`protocol-v3 closed public export set: ${actual.join(",")}`);
