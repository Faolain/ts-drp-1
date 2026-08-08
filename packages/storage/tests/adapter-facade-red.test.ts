import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { bytes, GENERATION_A, GENERATION_B, noHead, OBJECT_A, OBJECT_B, presentHead, record, ref } from "./fixtures.js";
import { createTransitionHarness } from "./internal-harness.js";
import * as adapter from "../src/adapter.js";
import {
	evaluateStorageAdapterCommand,
	type PreparedStorageAdapterCommand,
	prepareStorageAdapterCommand,
	type StorageAdapterCommand,
	type StorageAdapterFact,
	type StorageAdapterLoadRequirement,
	type StorageAdapterWrite,
} from "../src/adapter.js";
import {
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	encodeGenerationRecordV1,
	encodeHeadRecordV1,
} from "../src/codecs.js";
import * as contract from "../src/contract.js";
import * as root from "../src/index.js";
import type { GenerationRecord, StoreResult } from "../src/types.js";

type Scenario = Readonly<{
	command: StorageAdapterCommand;
	facts: readonly StorageAdapterFact[];
	name: string;
	writes(result: StoreResult<unknown>): readonly StorageAdapterWrite[];
}>;

function mustPrepare(command: StorageAdapterCommand): PreparedStorageAdapterCommand {
	const result = prepareStorageAdapterCommand(command);
	if (!result.ok) throw new Error(`valid command failed preparation: ${result.reason}`);
	return result.value;
}

function evaluateFacade(command: StorageAdapterCommand, facts: readonly StorageAdapterFact[]): StoreResult<unknown> {
	const prepared = prepareStorageAdapterCommand(command);
	return prepared.ok ? evaluateStorageAdapterCommand(prepared.value, facts).result : prepared;
}

function objectFact(
	state: Readonly<{ head: ReturnType<typeof noHead> | ReturnType<typeof presentHead>; generations: GenerationRecord[] }>
): StorageAdapterFact {
	return {
		kind: "object-state",
		objectId: state.head.objectId,
		headRecord: state.head.kind === "none" ? null : encodeHeadRecordV1(state.head),
		generationRecords: state.generations.map(encodeGenerationRecordV1),
	};
}

function executeHarness(
	harness: ReturnType<typeof createTransitionHarness>,
	command: StorageAdapterCommand
): StoreResult<unknown> {
	switch (command.kind) {
		case "readObjectState":
			return harness.readObjectState(command.objectId);
		case "getBlob":
			return harness.getBlob(command.digest);
		case "beginGeneration":
			return harness.beginGeneration({
				objectId: command.objectId,
				generationId: command.generationId,
				baseExpectedHead: command.baseExpectedHead,
				closure: command.closure,
			});
		case "putCachedBlob":
			return harness.putCachedBlob({
				objectId: command.objectId,
				generationId: command.generationId,
				digest: command.digest,
				bytes: command.bytes,
			});
		case "promoteReference":
			return harness.promoteReference({
				objectId: command.objectId,
				generationId: command.generationId,
				digest: command.digest,
			});
		case "completeGeneration":
			return harness.completeGeneration({ objectId: command.objectId, generationId: command.generationId });
		case "swapHead":
			return harness.swapHead({
				objectId: command.objectId,
				generationId: command.generationId,
				expectedHead: command.expectedHead,
			});
		case "discardGeneration":
			return harness.discardGeneration({ objectId: command.objectId, generationId: command.generationId });
	}
}

function expectedFromSharedKernel(
	command: StorageAdapterCommand,
	facts: readonly StorageAdapterFact[]
): StoreResult<unknown> {
	const harness = createTransitionHarness();
	for (const fact of facts) {
		switch (fact.kind) {
			case "store-closed":
				harness.close();
				break;
			case "object-state": {
				const head =
					fact.headRecord === null
						? { ok: true as const, value: noHead(fact.objectId) }
						: decodeHeadRecordV1(fact.headRecord);
				if (!head.ok) return head;
				const generations: GenerationRecord[] = [];
				for (const bytes of fact.generationRecords) {
					const decoded = decodeGenerationRecordV1(bytes);
					if (!decoded.ok) return decoded;
					generations.push(decoded.value);
				}
				harness.seedObjectState({ head: head.value, generations });
				break;
			}
			case "blob":
				if (fact.bytes !== null) harness.seedBlob(fact.digest, fact.bytes);
				break;
			case "promotion":
				harness.markPromoted(fact.objectId, fact.generationId, fact.digest);
		}
	}
	return executeHarness(harness, command);
}

function generationWrite(result: StoreResult<unknown>): readonly StorageAdapterWrite[] {
	if (!result.ok) return [];
	const generation = result.value as GenerationRecord;
	return [
		{
			kind: "replace-generation",
			objectId: generation.objectId,
			generationId: generation.generationId,
			record: encodeGenerationRecordV1(generation),
		},
	];
}

describe("Phase 2c-a durable adapter facade RED", () => {
	it("publishes only the strict runtime-neutral adapter-author surface", () => {
		const packageDirectory = new URL("../", import.meta.url);
		const manifest = JSON.parse(readFileSync(new URL("package.json", packageDirectory), "utf8")) as {
			dependencies?: Record<string, string>;
			exports?: Record<string, unknown>;
		};
		const sources = [readFileSync(new URL("src/adapter.ts", packageDirectory), "utf8")];
		const builtAdapter = new URL("dist/src/adapter.js", packageDirectory);
		if (existsSync(builtAdapter)) sources.push(readFileSync(builtAdapter, "utf8"));
		const combined = sources.join("\n");
		const declaredExports = Array.from(
			sources[0]?.matchAll(/^export (?:function|type) ([A-Za-z0-9_]+)/gmu) ?? [],
			(match) => match[1]
		).sort();

		expect(Object.keys(manifest.exports ?? {})).toEqual([".", "./contract", "./adapter"]);
		expect(manifest.exports?.["./internal/transition"]).toBeUndefined();
		expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@ts-drp/canonical"]);
		expect(Object.keys(adapter).sort()).toEqual(["evaluateStorageAdapterCommand", "prepareStorageAdapterCommand"]);
		expect(declaredExports).toEqual([
			"PreparedStorageAdapterCommand",
			"StorageAdapterCommand",
			"StorageAdapterEvaluation",
			"StorageAdapterFact",
			"StorageAdapterLoadRequirement",
			"StorageAdapterResultValue",
			"StorageAdapterWrite",
			"evaluateStorageAdapterCommand",
			"prepareStorageAdapterCommand",
		]);
		expect(Object.keys(root).sort()).toEqual([
			"createMemoryAheDurableStore",
			"decodeGenerationRecordV1",
			"decodeHeadRecordV1",
			"digestBlob",
			"digestClosure",
			"encodeGenerationRecordV1",
			"encodeHeadRecordV1",
			"parseBlobDigest",
			"parseClosureDigest",
			"parseGenerationId",
			"parseHeadRevision",
			"parseStorageObjectId",
		]);
		expect(Object.keys(contract)).toEqual(["STORE_CONTRACT_SCENARIOS", "runStoreContract"]);
		for (const forbidden of [
			"TransitionOwner",
			"seedObjectState",
			"seedBlob",
			"markPromoted",
			"createTransitionHarness",
			"capabilities",
			"createMemoryAheDurableStore",
			"signingAuthority",
		]) {
			expect(adapter).not.toHaveProperty(forbidden);
		}
		expect(combined).not.toMatch(/(?:from|import\s*)[ (]*["']node:/u);
		expect(combined).not.toMatch(/\b(?:document|HTMLElement|window|WorkerGlobalScope)\b/u);
	});

	it("detaches nested closure values and blob bytes synchronously before substrate work", () => {
		const closure = [ref(bytes(1, 2, 3))];
		const beginInput: StorageAdapterCommand = {
			kind: "beginGeneration",
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			baseExpectedHead: noHead(),
			closure,
		};
		const blobInput = bytes(4, 5, 6);
		const blobReference = ref(blobInput);
		const putInput: StorageAdapterCommand = {
			kind: "putCachedBlob",
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			digest: blobReference.digest,
			bytes: blobInput,
		};
		const preparedBegin = mustPrepare(beginInput);
		const preparedPut = mustPrepare(putInput);
		(closure[0] as { byteLength: number }).byteLength = 999;
		closure.push(ref(bytes(9)));
		blobInput.fill(0);

		expect(preparedBegin).toEqual({
			command: {
				...beginInput,
				closure: [{ digest: ref(bytes(1, 2, 3)).digest, byteLength: 3 }],
			},
			requirements: [{ kind: "object-state", objectId: OBJECT_A }],
		});
		expect(preparedPut.command).toMatchObject({ bytes: bytes(4, 5, 6) });
		const initial = objectFact({ head: noHead(), generations: [record({ closure: [blobReference] })] });
		const evaluated = evaluateStorageAdapterCommand(preparedPut, [
			initial,
			{ kind: "blob", digest: blobReference.digest, bytes: null },
		]);
		expect(evaluated).toEqual({
			result: { ok: true, value: { inserted: true } },
			writes: [{ kind: "insert-blob", digest: blobReference.digest, bytes: bytes(4, 5, 6) }],
		});

		const suppliedFactBytes = bytes(7, 8, 9);
		const factReference = ref(suppliedFactBytes);
		const blobRead = evaluateStorageAdapterCommand(mustPrepare({ kind: "getBlob", digest: factReference.digest }), [
			{ kind: "blob", digest: factReference.digest, bytes: suppliedFactBytes },
		]);
		expect(blobRead).toEqual({ result: { ok: true, value: bytes(7, 8, 9) }, writes: [] });
		if (!blobRead.result.ok || !(blobRead.result.value instanceof Uint8Array)) {
			throw new Error("positive getBlob evaluation failed");
		}
		expect(blobRead.result.value).not.toBe(suppliedFactBytes);
		suppliedFactBytes.fill(0);
		expect(blobRead.result.value).toEqual(bytes(7, 8, 9));
	});

	it("gives own SharedArrayBuffer bytes precedence over extra string and symbol siblings", () => {
		const payload = bytes(1, 2, 3);
		const item = ref(payload);
		const shared = new Uint8Array(new SharedArrayBuffer(payload.byteLength));
		shared.set(payload);
		const extras: readonly Record<PropertyKey, unknown>[] = [{ extra: true }, { [Symbol("extra")]: true }];

		for (const extra of extras) {
			const input = {
				kind: "putCachedBlob",
				objectId: OBJECT_A,
				generationId: GENERATION_A,
				digest: item.digest,
				bytes: shared,
				...extra,
			};
			expect.soft(prepareStorageAdapterCommand(input)).toEqual({
				ok: false,
				reason: "SHARED_BUFFER_INPUT",
			});
			expect.soft(prepareStorageAdapterCommand({ ...input, bytes: payload })).toEqual({
				ok: false,
				reason: "INVALID_ARGUMENT",
			});
		}
	});

	it("preserves closure reasons and lets STORE_CLOSED outrank semantic closure rejection", () => {
		const item = ref(bytes(1, 2, 3));
		const empty = objectFact({ head: noHead(), generations: [] });
		const cases = [
			{ closure: [], reason: "EMPTY_CLOSURE" },
			{ closure: [item, item], reason: "DUPLICATE_CLOSURE_REFERENCE" },
		] as const;

		for (const { closure, reason } of cases) {
			const command: StorageAdapterCommand = {
				kind: "beginGeneration",
				objectId: OBJECT_A,
				generationId: GENERATION_A,
				baseExpectedHead: noHead(),
				closure,
			};
			expect.soft(evaluateFacade(command, [empty])).toEqual({ ok: false, reason });
			expect.soft(evaluateFacade(command, [{ kind: "store-closed" }])).toEqual({
				ok: false,
				reason: "STORE_CLOSED",
			});
		}
		expect(
			evaluateFacade(
				{
					kind: "beginGeneration",
					objectId: OBJECT_A,
					generationId: GENERATION_A,
					baseExpectedHead: noHead(),
					closure: [item],
				},
				[empty]
			)
		).toMatchObject({ ok: true });
	});

	it("names exact fact loads and fails closed on every inexact fact set", () => {
		const item = ref(bytes(1));
		const requirements: ReadonlyArray<readonly [StorageAdapterCommand, readonly StorageAdapterLoadRequirement[]]> = [
			[
				{
					kind: "beginGeneration",
					objectId: OBJECT_A,
					generationId: GENERATION_A,
					baseExpectedHead: noHead(),
					closure: [item],
				},
				[{ kind: "object-state", objectId: OBJECT_A }],
			],
			[
				{ kind: "putCachedBlob", objectId: OBJECT_A, generationId: GENERATION_A, digest: item.digest, bytes: bytes(1) },
				[
					{ kind: "object-state", objectId: OBJECT_A },
					{ kind: "blob", digest: item.digest },
				],
			],
			[
				{ kind: "promoteReference", objectId: OBJECT_A, generationId: GENERATION_A, digest: item.digest },
				[
					{ kind: "object-state", objectId: OBJECT_A },
					{ kind: "blob", digest: item.digest },
					{ kind: "promotion", objectId: OBJECT_A, generationId: GENERATION_A, digest: item.digest },
				],
			],
			[
				{ kind: "completeGeneration", objectId: OBJECT_A, generationId: GENERATION_A },
				[
					{ kind: "object-state", objectId: OBJECT_A },
					{ kind: "generation-closure", objectId: OBJECT_A, generationId: GENERATION_A },
				],
			],
		];
		for (const [command, expected] of requirements) {
			expect(mustPrepare(command).requirements).toEqual(expected);
		}
		if (typeof SharedArrayBuffer !== "undefined") {
			const shared = new Uint8Array(new SharedArrayBuffer(1));
			expect(
				prepareStorageAdapterCommand({
					kind: "putCachedBlob",
					objectId: OBJECT_A,
					generationId: GENERATION_A,
					digest: item.digest,
					bytes: shared,
				})
			).toEqual({ ok: false, reason: "SHARED_BUFFER_INPUT" });
		}
		expect(
			prepareStorageAdapterCommand({ ...(requirements[0]?.[0] as StorageAdapterCommand), durability: "strict" })
		).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		expect(
			prepareStorageAdapterCommand({
				kind: "promoteReference",
				objectId: OBJECT_A,
				generationId: GENERATION_A,
				digest: item.digest,
				promoted: true,
			})
		).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });

		const prepared = mustPrepare(requirements[0]?.[0] as StorageAdapterCommand);
		const correct = objectFact({ head: noHead(), generations: [] });
		const foreign = objectFact({ head: noHead(OBJECT_B), generations: [] });
		for (const facts of [[], [correct, foreign], [correct, correct], [foreign]]) {
			expect(evaluateStorageAdapterCommand(prepared, facts)).toEqual({
				result: { ok: false, reason: "INVALID_ARGUMENT" },
				writes: [],
			});
		}
		expect(evaluateStorageAdapterCommand(prepared, [{ kind: "store-closed" }])).toEqual({
			result: { ok: false, reason: "STORE_CLOSED" },
			writes: [],
		});
	});

	it("matches the single transition kernel and emits only canonical whole-row or immutable-insert writes", () => {
		const payload = bytes(1, 2, 3);
		const item = ref(payload);
		const staged = record({ closure: [item] });
		const currentGeneration = record({ closure: [item], generationId: GENERATION_A, state: "Adopted" });
		const currentHead = presentHead({ closureDigest: currentGeneration.closureDigest });
		const candidate = record({
			baseExpectedHead: currentHead,
			closure: [item],
			generationId: GENERATION_B,
			state: "Complete",
		});
		const empty = objectFact({ head: noHead(), generations: [] });
		const stagedFact = objectFact({ head: noHead(), generations: [staged] });
		const promoted: StorageAdapterFact = {
			kind: "promotion",
			objectId: OBJECT_A,
			generationId: GENERATION_A,
			digest: item.digest,
		};
		const blob: StorageAdapterFact = { kind: "blob", digest: item.digest, bytes: payload };
		const scenarios: readonly Scenario[] = [
			{
				name: "read object",
				command: { kind: "readObjectState", objectId: OBJECT_A },
				facts: [stagedFact],
				writes: () => [],
			},
			{
				name: "read blob",
				command: { kind: "getBlob", digest: item.digest },
				facts: [blob],
				writes: () => [],
			},
			{
				name: "begin",
				command: {
					kind: "beginGeneration",
					objectId: OBJECT_A,
					generationId: GENERATION_A,
					baseExpectedHead: noHead(),
					closure: [item],
				},
				facts: [empty],
				writes: generationWrite,
			},
			{
				name: "cache",
				command: {
					kind: "putCachedBlob",
					objectId: OBJECT_A,
					generationId: GENERATION_A,
					digest: item.digest,
					bytes: payload,
				},
				facts: [stagedFact, { kind: "blob", digest: item.digest, bytes: null }],
				writes: (result) => (result.ok ? [{ kind: "insert-blob", digest: item.digest, bytes: payload }] : []),
			},
			{
				name: "promote",
				command: {
					kind: "promoteReference",
					objectId: OBJECT_A,
					generationId: GENERATION_A,
					digest: item.digest,
				},
				facts: [stagedFact, blob],
				writes: (result) =>
					result.ok
						? [
								{
									kind: "insert-promotion",
									objectId: OBJECT_A,
									generationId: GENERATION_A,
									digest: item.digest,
								},
							]
						: [],
			},
			{
				name: "complete",
				command: { kind: "completeGeneration", objectId: OBJECT_A, generationId: GENERATION_A },
				facts: [stagedFact, promoted],
				writes: generationWrite,
			},
			{
				name: "swap",
				command: {
					kind: "swapHead",
					objectId: OBJECT_A,
					generationId: GENERATION_B,
					expectedHead: currentHead,
				},
				facts: [objectFact({ head: currentHead, generations: [currentGeneration, candidate] })],
				writes: (result): readonly StorageAdapterWrite[] => {
					if (!result.ok) return [];
					const value = result.value as { head: ReturnType<typeof presentHead> };
					return [
						{
							kind: "replace-generation",
							objectId: OBJECT_A,
							generationId: GENERATION_A,
							record: encodeGenerationRecordV1({ ...currentGeneration, state: "Superseded" }),
						},
						{
							kind: "replace-generation",
							objectId: OBJECT_A,
							generationId: GENERATION_B,
							record: encodeGenerationRecordV1({ ...candidate, state: "Adopted" }),
						},
						{ kind: "replace-head", objectId: OBJECT_A, record: encodeHeadRecordV1(value.head) },
					];
				},
			},
			{
				name: "discard",
				command: { kind: "discardGeneration", objectId: OBJECT_A, generationId: GENERATION_A },
				facts: [stagedFact],
				writes: generationWrite,
			},
			{
				name: "current-head-first rejection",
				command: { kind: "swapHead", objectId: OBJECT_A, generationId: GENERATION_B, expectedHead: noHead() },
				facts: [objectFact({ head: currentHead, generations: [currentGeneration, candidate] })],
				writes: () => [],
			},
		];

		for (const scenario of scenarios) {
			const expectedResult = expectedFromSharedKernel(scenario.command, scenario.facts);
			const actual = evaluateStorageAdapterCommand(mustPrepare(scenario.command), scenario.facts);
			expect.soft(actual, scenario.name).toEqual({
				result: expectedResult,
				writes: scenario.writes(expectedResult),
			});
		}

		expect(
			evaluateStorageAdapterCommand(
				mustPrepare({ kind: "completeGeneration", objectId: OBJECT_A, generationId: GENERATION_A }),
				[stagedFact, { kind: "blob", digest: item.digest, bytes: bytes(9) }, promoted]
			)
		).toEqual({ result: { ok: false, reason: "INVALID_ARGUMENT" }, writes: [] });
	});
});
