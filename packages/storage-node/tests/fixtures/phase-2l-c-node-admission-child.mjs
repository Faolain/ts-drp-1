/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { armPhase2lCStatementTrace } from "./phase-2l-c-sqlite-preload.mjs";

const [, , primaryFilename, mode] = process.argv;

async function waitForStart() {
	if (mode !== "plain-barrier") return;
	process.send?.({ kind: "ready" });
	await new Promise((resolve) => process.once("message", (message) => message === "start" && resolve()));
}

async function run() {
	await waitForStart();
	if (mode !== "plain-barrier") armPhase2lCStatementTrace({ edge: "admission-ddl" });
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
