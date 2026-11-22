import { createNodeSnapshotQuarantineStore } from "../../src/snapshot-transfer.js";

const [primaryFilename, policy] = process.argv.slice(2);
if (primaryFilename === undefined || policy === undefined) throw new Error("invalid child input");
const recoveryLimits: unknown = JSON.parse(policy);
process.once("message", () => {
	let store: ReturnType<typeof createNodeSnapshotQuarantineStore> | undefined;
	let code = "none";
	try {
		const options = { primaryFilename, recoveryLimits };
		store = createNodeSnapshotQuarantineStore(options as Parameters<typeof createNodeSnapshotQuarantineStore>[0]);
	} catch (error) {
		code = error !== null && typeof error === "object" ? String(Reflect.get(error, "code")) : "unclassified-error";
	}
	void (store?.close() ?? Promise.resolve()).then(() => {
		process.send?.({ kind: "result", code });
		process.disconnect?.();
	});
});
process.send?.({ kind: "ready" });
