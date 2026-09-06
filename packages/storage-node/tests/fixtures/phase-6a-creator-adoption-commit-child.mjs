/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createSqliteAheDurableStore } from "../../dist/src/index.js";
import { createInstrumentedSqliteAheDurableStore } from "../../dist/src/test-instrumentation.js";

const [, , filename, mode, encodedInput] = process.argv;
const input = JSON.parse(Buffer.from(encodedInput ?? "", "base64url").toString("utf8"));

function send(value) {
	if (typeof process.send === "function") process.send(value);
}

function bytes(value) {
	return Uint8Array.from(Buffer.from(value, "base64"));
}

function successful(result, label) {
	if (!result.ok) throw new Error(`${label}: ${result.reason}`);
	return result.value;
}

async function putGeneration(store, generation, blobs) {
	await successful(await store.beginGeneration(generation), "beginGeneration");
	for (const entry of blobs) {
		await successful(
			await store.putCachedBlob({
				bytes: bytes(entry.bytes),
				digest: entry.ref.digest,
				generationId: generation.generationId,
				objectId: generation.objectId,
			}),
			"putCachedBlob"
		);
	}
	for (const ref of generation.closure) {
		await successful(
			await store.promoteReference({
				digest: ref.digest,
				generationId: generation.generationId,
				objectId: generation.objectId,
			}),
			"promoteReference"
		);
	}
	await successful(
		await store.completeGeneration({ generationId: generation.generationId, objectId: generation.objectId }),
		"completeGeneration"
	);
}

async function seedPending() {
	const store = createSqliteAheDurableStore({ filename });
	await putGeneration(store, input.pendingGeneration, input.pendingBlobs);
	await successful(
		await store.swapHead({
			expectedHead: { kind: "none", objectId: input.pendingGeneration.objectId },
			generationId: input.pendingGeneration.generationId,
			objectId: input.pendingGeneration.objectId,
		}),
		"seed swapHead"
	);
	await store.close();
}

async function mutate() {
	await seedPending();
	const occurrences = new Map();
	const armedOccurrence = new Map();
	const target = input.target;
	const instrumented = createInstrumentedSqliteAheDurableStore(
		{ filename },
		(checkpoint) => {
			if (checkpoint.edge !== "before-commit" && checkpoint.edge !== "after-commit") return;
			let occurrence;
			if (checkpoint.edge === "before-commit") {
				occurrence = occurrences.get(checkpoint.operation) ?? 0;
				occurrences.set(checkpoint.operation, occurrence + 1);
				armedOccurrence.set(checkpoint.operation, occurrence);
			} else {
				occurrence = armedOccurrence.get(checkpoint.operation) ?? 0;
			}
			if (
				checkpoint.operation === target.operation &&
				checkpoint.edge === target.edge &&
				occurrence === target.occurrence
			) {
				send({ checkpoint: { ...checkpoint, occurrence }, kind: "checkpoint" });
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			}
		},
		{ crashCheckpoints: "expanded" }
	);
	const store = instrumented.store;
	const generation = input.candidateGeneration;
	await successful(await store.beginGeneration(generation), "candidate beginGeneration");
	await successful(
		await store.putCachedBlob({
			bytes: bytes(input.projectionBlob.bytes),
			digest: input.projectionBlob.ref.digest,
			generationId: generation.generationId,
			objectId: generation.objectId,
		}),
		"candidate putCachedBlob"
	);
	for (const ref of generation.closure) {
		await successful(
			await store.promoteReference({
				digest: ref.digest,
				generationId: generation.generationId,
				objectId: generation.objectId,
			}),
			"candidate promoteReference"
		);
	}
	await successful(
		await store.completeGeneration({ generationId: generation.generationId, objectId: generation.objectId }),
		"candidate completeGeneration"
	);
	const result = await store.swapHead({
		expectedHead: input.pendingHead,
		generationId: generation.generationId,
		objectId: generation.objectId,
	});
	send({ kind: "unexpected-result", result });
	await store.close();
}

async function recover() {
	const store = createSqliteAheDurableStore({ filename });
	const recovered = await store.recoverActiveGeneration(input.pendingGeneration.objectId);
	const generations = [];
	let cursor;
	do {
		const page = successful(
			await store.readGenerationPage({
				...(cursor === undefined ? {} : { cursor }),
				limit: 128,
				objectId: input.pendingGeneration.objectId,
			}),
			"readGenerationPage"
		);
		generations.push(...page.generations);
		cursor = page.nextCursor;
	} while (cursor !== null);
	send({ generations, kind: "recovery", recovered });
	await store.close();
}

void (mode === "mutate" ? mutate() : recover()).catch((error) => {
	send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
	process.exitCode = 1;
});
