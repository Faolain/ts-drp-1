/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { encodeCanonical } from "../../../canonical/dist/src/index.js";

const [, , primaryFilename, seedText] = process.argv;
const seed = Number(seedText);
const scope = { author: "alice", objectId: "room:process-race" };

function send(message) {
	if (typeof process.send === "function") process.send(message);
}

async function run() {
	const candidate = await import(new URL("../../dist/src/issuance.js", import.meta.url).href);
	const store = candidate.createNodeDurableIssuanceStore({ primaryFilename });
	try {
		const value = await store.transactIssue(scope, (authorSequence) => {
			send({ authorSequence, kind: "ready", seed });
			return new Promise((resolve) => {
				process.once("message", () => {
					const envelope = {
						canonicalPreimageBytes: encodeCanonical({ ...scope, authorSequence }),
						digest: Uint8Array.of(seed, 0xd1),
						signature: Uint8Array.of(seed, 0x51),
					};
					resolve({
						authorSequence,
						envelope,
						issuedRecord: { authorSequence, envelope, scope },
						outboxEntry: { authorSequence, envelope, scope },
					});
				});
			});
		});
		send({ digest0: value.envelope.digest[0], kind: "fulfilled", seed });
	} catch (error) {
		send({ code: error?.code, kind: "rejected", seed });
	} finally {
		await store.close();
		process.disconnect?.();
	}
}

run().catch((error) => {
	send({ kind: "child-error", message: error instanceof Error ? error.message : String(error), seed });
	process.exitCode = 1;
});
