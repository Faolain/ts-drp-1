import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { bytes, GENERATION_A, noHead, OBJECT_A, OBJECT_B, record, ref } from "./fixtures.js";
import * as adapter from "../src/adapter.js";
import {
	evaluateStorageAdapterCommand,
	type PreparedStorageAdapterCommand,
	prepareStorageAdapterCommand,
	type StorageAdapterCommand,
	type StorageAdapterFact,
	type StorageAdapterWrite,
} from "../src/adapter.js";
import { encodeGenerationRecordV1 } from "../src/codecs.js";
import * as contract from "../src/contract.js";
import * as root from "../src/index.js";
import type { GenerationRecord } from "../src/types.js";

type AdapterCommandFixture =
	| StorageAdapterCommand
	| Readonly<{ kind: "readHead"; objectId: typeof OBJECT_A }>
	| Readonly<{ cursor?: string; kind: "readGenerationPage"; limit: number; objectId: typeof OBJECT_A }>;

type Phase2e3LoadKind = "blob" | "generation" | "generation-page" | "head" | "promotion";

function mustPrepare(command: unknown): PreparedStorageAdapterCommand {
	const result = prepareStorageAdapterCommand(command);
	if (!result.ok) throw new Error(`valid command failed preparation: ${result.reason}`);
	return result.value;
}

function requirementKinds(command: AdapterCommandFixture): readonly string[] {
	return mustPrepare(command).requirements.map(({ kind }) => kind);
}

function headFact(objectId = OBJECT_A): StorageAdapterFact {
	return { headRecord: null, kind: "head", objectId } as unknown as StorageAdapterFact;
}

function generationPageFact(generations: readonly GenerationRecord[]): StorageAdapterFact {
	return {
		afterGenerationId: null,
		generationRecords: generations.map(encodeGenerationRecordV1),
		kind: "generation-page",
		objectId: OBJECT_A,
	} as unknown as StorageAdapterFact;
}

describe("Phase 2e3 durable adapter facade correction RED", () => {
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
			sources[0]?.matchAll(/^export (?:const|function|type) ([A-Za-z0-9_]+)/gmu) ?? [],
			(match) => match[1]
		).sort();

		expect(Object.keys(manifest.exports ?? {})).toEqual([
			".",
			"./contract",
			"./maintenance",
			"./adapter",
			"./snapshot-transfer",
		]);
		expect(manifest.exports?.["./internal/transition"]).toBeUndefined();
		expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@ts-drp/canonical"]);
		expect(Object.keys(adapter).sort()).toEqual([
			"PersistedStorageError",
			"classifyPersistedState",
			"evaluateStorageAdapterCommand",
			"prepareStorageAdapterCommand",
			"storageAdapterClosureVerifier",
		]);
		expect(declaredExports).toEqual([
			"PreparedStorageAdapterCommand",
			"StorageAdapterCommand",
			"StorageAdapterEvaluation",
			"StorageAdapterFact",
			"StorageAdapterLoadRequirement",
			"StorageAdapterResultValue",
			"StorageAdapterWrite",
			"classifyPersistedState",
			"evaluateStorageAdapterCommand",
			"prepareStorageAdapterCommand",
			"storageAdapterClosureVerifier",
		]);
		const authorizedRootRuntimeKeys = [
			"createStageAdmissionController",
			"createMemoryAheDurableStore",
			"decodeGenerationRecordV1",
			"decodeHeadRecordV1",
			"digestBlob",
			"digestClosure",
			"encodeGenerationRecordV1",
			"encodeHeadRecordV1",
			"inspectStorageCapability",
			"parseBlobDigest",
			"parseCapacityProfile",
			"parseClosureDigest",
			"parseGenerationId",
			"parseHeadRevision",
			"parseStorageObjectId",
			"requestPersistentStorage",
		];
		const observedRootRuntimeKeys = Object.keys(root).sort();
		expect(observedRootRuntimeKeys).toEqual(
			expect.arrayContaining([
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
			])
		);
		expect(observedRootRuntimeKeys.every((key) => authorizedRootRuntimeKeys.includes(key))).toBe(true);
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

	it("detaches caller closure and blob bytes synchronously before substrate work", () => {
		const closure = [ref(bytes(1, 2, 3))];
		const beginInput: StorageAdapterCommand = {
			baseExpectedHead: noHead(),
			closure,
			generationId: GENERATION_A,
			kind: "beginGeneration",
			objectId: OBJECT_A,
		};
		const blobInput = bytes(4, 5, 6);
		const blobReference = ref(blobInput);
		const putInput: StorageAdapterCommand = {
			bytes: blobInput,
			digest: blobReference.digest,
			generationId: GENERATION_A,
			kind: "putCachedBlob",
			objectId: OBJECT_A,
		};
		const preparedBegin = mustPrepare(beginInput);
		const preparedPut = mustPrepare(putInput);
		(closure[0] as { byteLength: number }).byteLength = 999;
		closure.push(ref(bytes(9)));
		blobInput.fill(0);

		expect(preparedBegin.command).toEqual({
			...beginInput,
			closure: [{ byteLength: 3, digest: ref(bytes(1, 2, 3)).digest }],
		});
		expect(preparedPut.command).toMatchObject({ bytes: bytes(4, 5, 6) });

		const suppliedFactBytes = bytes(7, 8, 9);
		const factReference = ref(suppliedFactBytes);
		const blobRead = evaluateStorageAdapterCommand(mustPrepare({ kind: "getBlob", digest: factReference.digest }), [
			{ bytes: suppliedFactBytes, digest: factReference.digest, kind: "blob" },
		]);
		expect(blobRead).toEqual({ result: { ok: true, value: bytes(7, 8, 9) }, writes: [] });
		if (!blobRead.result.ok || !(blobRead.result.value instanceof Uint8Array)) {
			throw new Error("positive getBlob evaluation failed");
		}
		expect(blobRead.result.value).not.toBe(suppliedFactBytes);
		suppliedFactBytes.fill(0);
		expect(blobRead.result.value).toEqual(bytes(7, 8, 9));
	});

	it("gives own SharedArrayBuffer bytes precedence over extra siblings", () => {
		const payload = bytes(1, 2, 3);
		const item = ref(payload);
		const shared = new Uint8Array(new SharedArrayBuffer(payload.byteLength));
		shared.set(payload);
		const extras: readonly Record<PropertyKey, unknown>[] = [{ extra: true }, { [Symbol("extra")]: true }];

		for (const extra of extras) {
			const input = {
				bytes: shared,
				digest: item.digest,
				generationId: GENERATION_A,
				kind: "putCachedBlob",
				objectId: OBJECT_A,
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

	it("uses only the ratified bounded load vocabulary and addresses every mutation generation", () => {
		const item = ref(bytes(1));
		const commands: readonly AdapterCommandFixture[] = [
			{
				baseExpectedHead: noHead(),
				closure: [item],
				generationId: GENERATION_A,
				kind: "beginGeneration",
				objectId: OBJECT_A,
			},
			{
				bytes: bytes(1),
				digest: item.digest,
				generationId: GENERATION_A,
				kind: "putCachedBlob",
				objectId: OBJECT_A,
			},
			{
				digest: item.digest,
				generationId: GENERATION_A,
				kind: "promoteReference",
				objectId: OBJECT_A,
			},
			{ generationId: GENERATION_A, kind: "completeGeneration", objectId: OBJECT_A },
			{ expectedHead: noHead(), generationId: GENERATION_A, kind: "swapHead", objectId: OBJECT_A },
			{ generationId: GENERATION_A, kind: "discardGeneration", objectId: OBJECT_A },
		];
		const allowed = new Set<Phase2e3LoadKind>(["blob", "generation", "generation-page", "head", "promotion"]);
		for (const command of commands) {
			const kinds = requirementKinds(command);
			expect.soft(kinds, command.kind).toContain("generation");
			expect
				.soft(
					kinds.every((kind) => allowed.has(kind as Phase2e3LoadKind)),
					command.kind
				)
				.toBe(true);
		}

		const source = readFileSync(new URL("../src/adapter.ts", import.meta.url), "utf8");
		expect.soft(source).toContain('kind: "generation"');
		expect.soft(source).not.toContain('kind: "object-state"');
		expect.soft(source).not.toContain('kind: "generation-closure"');
	});

	it("keeps bounded public read facts exact and rejects inexact fact sets", () => {
		const generation = record();
		const decodedGeneration = generationPageFact([generation]);
		const cases = [
			{
				command: { kind: "readHead", objectId: OBJECT_A } as const,
				fact: headFact(),
				expected: { ok: true, value: noHead() },
			},
			{
				command: { kind: "readGenerationPage", limit: 1, objectId: OBJECT_A } as const,
				fact: decodedGeneration,
				expected: { ok: true, value: { generations: [generation], nextCursor: null } },
			},
		] as const;
		for (const { command, expected, fact } of cases) {
			const prepared = mustPrepare(command);
			expect.soft(evaluateStorageAdapterCommand(prepared, [fact]).result).toEqual(expected);
			expect.soft(evaluateStorageAdapterCommand(prepared, []).result).toEqual({
				ok: false,
				reason: "INVALID_ARGUMENT",
			});
			expect.soft(evaluateStorageAdapterCommand(prepared, [fact, fact]).result).toEqual({
				ok: false,
				reason: "INVALID_ARGUMENT",
			});
		}
		expect(
			evaluateStorageAdapterCommand(mustPrepare({ kind: "readHead", objectId: OBJECT_A }), [headFact(OBJECT_B)])
		).toEqual({ result: { ok: false, reason: "INVALID_ARGUMENT" }, writes: [] });
	});

	it("keeps exact command-owned write kinds and caller-input failure precedence", () => {
		const ownership: Record<StorageAdapterWrite["kind"], string> = {
			"insert-blob": "blobs",
			"insert-promotion": "promotions",
			"replace-generation": "generations",
			"replace-head": "objects",
		};
		expect(ownership).toEqual({
			"insert-blob": "blobs",
			"insert-promotion": "promotions",
			"replace-generation": "generations",
			"replace-head": "objects",
		});
		const item = ref(bytes(1));
		expect(
			prepareStorageAdapterCommand({
				baseExpectedHead: noHead(),
				closure: [item],
				durability: "strict",
				generationId: GENERATION_A,
				kind: "beginGeneration",
				objectId: OBJECT_A,
			})
		).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		expect(
			prepareStorageAdapterCommand({
				digest: item.digest,
				generationId: GENERATION_A,
				kind: "promoteReference",
				objectId: OBJECT_A,
				promoted: true,
			})
		).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
		expect(
			evaluateStorageAdapterCommand(mustPrepare({ kind: "readHead", objectId: OBJECT_A }), [{ kind: "store-closed" }])
		).toEqual({ result: { ok: false, reason: "STORE_CLOSED" }, writes: [] });
	});

	it("keeps the bounded load kind ledger exhaustive without private authorization guesses", () => {
		const owners = {
			"blob": "blob",
			"generation": "generation",
			"generation-page": "generation",
			"head": "head",
			"promotion": "promotion",
		} satisfies Record<Phase2e3LoadKind, string>;
		expect(Object.keys(owners).sort()).toEqual(["blob", "generation", "generation-page", "head", "promotion"]);
	});
});
