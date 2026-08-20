/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { armPhase2lCStatementTrace } from "./phase-2l-c-sqlite-preload.mjs";

const [, , primaryFilename] = process.argv;

async function run() {
	armPhase2lCStatementTrace({ edge: "admission-ddl" });
	const candidate = await import(new URL("../../dist/src/issuance.js", import.meta.url).href);
	const store = candidate.createNodeDurableIssuanceStore({ primaryFilename });
	if (typeof process.send === "function") process.send({ kind: "admitted" });
	await store.close();
}

run().catch((error) => {
	if (typeof process.send === "function")
		process.send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
	process.exitCode = 1;
});
