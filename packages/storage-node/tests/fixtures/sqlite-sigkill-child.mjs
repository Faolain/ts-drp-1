/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { digestBlob, parseGenerationId, parseStorageObjectId } from "@ts-drp/storage";

import { createSqliteAheDurableStore } from "../../dist/src/index.js";
import { createInstrumentedSqliteAheDurableStore } from "../../dist/src/test-instrumentation.js";

const [, , filename, scenarioName, mode, encodedTarget] = process.argv;

function must(result) {
	if (!result.ok) throw new Error(`invalid fixture value: ${result.reason}`);
	return result.value;
}

const OBJECT = must(parseStorageObjectId(`sqlite-crash:${"c".repeat(32)}`));
const GENERATION_A = must(parseGenerationId("3".repeat(64)));
const GENERATION_B = must(parseGenerationId("4".repeat(64)));
const BYTES_A = Uint8Array.of(31, 32, 33);
const BYTES_B = Uint8Array.of(41, 42, 43);
const DIGEST_A = must(digestBlob(BYTES_A));
const DIGEST_B = must(digestBlob(BYTES_B));

function send(message) {
	if (typeof process.send === "function") process.send(message);
}

function checkpointMatches(actual, expected) {
	return (
		expected !== undefined &&
		Object.entries(expected).every(
			([key, value]) => Object.prototype.hasOwnProperty.call(actual, key) && actual[key] === value
		)
	);
}

function noHead() {
	return { kind: "none", objectId: OBJECT };
}

function reference(digest, bytes) {
	return { byteLength: bytes.byteLength, digest };
}

function successful(result, label) {
	if (!result.ok) throw new Error(`${label} failed: ${result.reason}`);
	return result.value;
}

async function prepareGeneration(store, generationId, digest, bytes, baseExpectedHead) {
	await successful(
		await store.beginGeneration({
			baseExpectedHead,
			closure: [reference(digest, bytes)],
			generationId,
			objectId: OBJECT,
		}),
		"beginGeneration"
	);
	await successful(await store.putCachedBlob({ bytes, digest, generationId, objectId: OBJECT }), "putCachedBlob");
	await successful(await store.promoteReference({ digest, generationId, objectId: OBJECT }), "promoteReference");
}

async function setup(store, scenario) {
	switch (scenario) {
		case "beginGeneration":
			return;
		case "putCachedBlob":
			await successful(
				await store.beginGeneration({
					baseExpectedHead: noHead(),
					closure: [reference(DIGEST_A, BYTES_A)],
					generationId: GENERATION_A,
					objectId: OBJECT,
				}),
				"setup beginGeneration"
			);
			return;
		case "promoteReference":
			await successful(
				await store.beginGeneration({
					baseExpectedHead: noHead(),
					closure: [reference(DIGEST_A, BYTES_A)],
					generationId: GENERATION_A,
					objectId: OBJECT,
				}),
				"setup beginGeneration"
			);
			await successful(
				await store.putCachedBlob({
					bytes: BYTES_A,
					digest: DIGEST_A,
					generationId: GENERATION_A,
					objectId: OBJECT,
				}),
				"setup putCachedBlob"
			);
			return;
		case "completeGeneration":
			await prepareGeneration(store, GENERATION_A, DIGEST_A, BYTES_A, noHead());
			return;
		case "discardGeneration":
			await successful(
				await store.beginGeneration({
					baseExpectedHead: noHead(),
					closure: [reference(DIGEST_A, BYTES_A)],
					generationId: GENERATION_A,
					objectId: OBJECT,
				}),
				"setup beginGeneration"
			);
			return;
		case "swapHead": {
			await prepareGeneration(store, GENERATION_A, DIGEST_A, BYTES_A, noHead());
			await successful(
				await store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT }),
				"setup completeGeneration A"
			);
			const first = await successful(
				await store.swapHead({ expectedHead: noHead(), generationId: GENERATION_A, objectId: OBJECT }),
				"setup swapHead A"
			);
			await prepareGeneration(store, GENERATION_B, DIGEST_B, BYTES_B, first.head);
			await successful(
				await store.completeGeneration({ generationId: GENERATION_B, objectId: OBJECT }),
				"setup completeGeneration B"
			);
			return;
		}
		default:
			throw new Error(`unknown scenario: ${scenario}`);
	}
}

async function expectedFirstHead(store) {
	const state = await successful(await store.readObjectState(OBJECT), "readObjectState");
	const generation = state.generations.find(({ generationId }) => generationId === GENERATION_A);
	if (generation === undefined) throw new Error("missing first generation");
	return {
		closureDigest: generation.closureDigest,
		generationId: GENERATION_A,
		kind: "present",
		objectId: OBJECT,
		revision: 1,
	};
}

async function runTarget(store, scenario) {
	switch (scenario) {
		case "beginGeneration":
			return store.beginGeneration({
				baseExpectedHead: noHead(),
				closure: [reference(DIGEST_A, BYTES_A)],
				generationId: GENERATION_A,
				objectId: OBJECT,
			});
		case "putCachedBlob":
			return store.putCachedBlob({
				bytes: BYTES_A,
				digest: DIGEST_A,
				generationId: GENERATION_A,
				objectId: OBJECT,
			});
		case "promoteReference":
			return store.promoteReference({ digest: DIGEST_A, generationId: GENERATION_A, objectId: OBJECT });
		case "completeGeneration":
			return store.completeGeneration({ generationId: GENERATION_A, objectId: OBJECT });
		case "swapHead":
			return store.swapHead({
				expectedHead: await expectedFirstHead(store),
				generationId: GENERATION_B,
				objectId: OBJECT,
			});
		case "discardGeneration":
			return store.discardGeneration({ generationId: GENERATION_A, objectId: OBJECT });
		default:
			throw new Error(`unknown scenario: ${scenario}`);
	}
}

const target = encodedTarget === undefined ? undefined : JSON.parse(encodedTarget);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const observed = [];
const expandedCrashInstrumentation = Object.freeze({ crashCheckpoints: "expanded" });

try {
	if (mode !== "retry") {
		const setupStore = createSqliteAheDurableStore({ filename });
		await setup(setupStore, scenarioName);
		await setupStore.close();
	}
	if (mode === "old") {
		send({ kind: "ready-old" });
	} else {
		const instrumented = createInstrumentedSqliteAheDurableStore(
			{ filename },
			(checkpoint) => {
				observed.push(checkpoint);
				send({ checkpoint, kind: "checkpoint" });
				if (mode === "crash" && checkpointMatches(checkpoint, target)) {
					Atomics.wait(waitBuffer, 0, 0);
				}
			},
			expandedCrashInstrumentation
		);
		const result = await runTarget(instrumented.store, scenarioName);
		send({ kind: "result", observed, result });
		await instrumented.store.close();
	}
} catch (error) {
	send({ kind: "fixture-error", message: error instanceof Error ? error.stack : String(error) });
	process.exitCode = 1;
}
