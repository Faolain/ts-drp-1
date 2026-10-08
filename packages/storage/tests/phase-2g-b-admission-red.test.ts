/* eslint-disable @typescript-eslint/explicit-function-return-type -- concise fake ports make call-order assertions readable */
import { assert, integer, property } from "fast-check";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	bytes,
	GENERATION_A,
	GENERATION_B,
	GENERATION_C,
	noHead,
	OBJECT_A,
	presentHead,
	record,
	ref,
} from "./fixtures.js";
import * as storageRoot from "../src/index.js";
import {
	type AheDurableStore,
	type BlobDigest,
	createMemoryAheDurableStore,
	encodeGenerationRecordV1,
	type GenerationId,
	type GenerationRef,
	type StorageCapacityPort,
	type StoreResult,
} from "../src/index.js";
import { selectAdmissionApi, type TestBlobExistencePort } from "./fixtures/phase-2g-b-admission-scaffold.js";

const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../..");
const storageModule = storageRoot as unknown as Record<string, unknown>;
const api = selectAdmissionApi(storageModule);
const LARGE_PROFILE = Object.freeze({
	maxClosureReferences: 8,
	maxStageCostBytes: 50_000,
	reserveBytes: 17,
});

type BeginInput = Parameters<AheDurableStore["beginGeneration"]>[0];

type FakeOptions = Readonly<{
	begin?: AheDurableStore["beginGeneration"];
	events?: string[];
	presence?: readonly boolean[] | StoreResult<never>;
	probe?: TestBlobExistencePort["probeBlobPresence"];
}>;

function input(closure: readonly GenerationRef[], generationId: GenerationId = GENERATION_A): BeginInput {
	return { baseExpectedHead: noHead(), closure, generationId, objectId: OBJECT_A };
}

function fakeStore(options: FakeOptions = {}): AheDurableStore & TestBlobExistencePort {
	const memory = createMemoryAheDurableStore();
	const events = options.events ?? [];
	const probe =
		options.probe ??
		((_digests: readonly BlobDigest[]) => {
			events.push("presence");
			const selected = options.presence ?? [];
			return Promise.resolve(Array.isArray(selected) ? ({ ok: true, value: selected } as const) : selected);
		});
	return new Proxy(memory as AheDurableStore & TestBlobExistencePort, {
		get(target, property, receiver) {
			if (property === "probeBlobPresence") return probe;
			if (property === "beginGeneration") {
				return options.begin === undefined
					? (value: BeginInput) => {
							events.push("begin");
							return target.beginGeneration(value);
						}
					: options.begin;
			}
			if (
				[
					"close",
					"completeGeneration",
					"discardGeneration",
					"getBlob",
					"promoteReference",
					"putCachedBlob",
					"swapHead",
				].includes(String(property))
			) {
				const operation = Reflect.get(target, property, receiver) as (...args: unknown[]) => unknown;
				return (...args: unknown[]) => {
					events.push(String(property));
					return Reflect.apply(operation, target, args);
				};
			}
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function capacity(result: unknown, events: string[] = []): StorageCapacityPort {
	return Object.freeze({
		estimate: () => {
			events.push("estimate");
			if (result instanceof Error) throw result;
			return result;
		},
		persist: () => {
			events.push("persist");
			throw new Error("admission requested persistence");
		},
		persisted: () => {
			events.push("persisted");
			throw new Error("admission inspected persistence");
		},
	});
}

async function exactRecordBytes(value: BeginInput): Promise<number> {
	const sorted = [...value.closure].sort((left, right) =>
		left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
	);
	const result = await createMemoryAheDurableStore().beginGeneration({ ...value, closure: sorted });
	if (!result.ok) throw new Error(`fixture begin failed: ${result.reason}`);
	return encodeGenerationRecordV1(result.value).byteLength;
}

describe("Phase 2g-b closed capacity profile and public admission surface RED", () => {
	it("yields to supplied production functions and requires exactly the ratified root API", () => {
		const marker = {
			createStageAdmissionController: () =>
				Object.freeze({ beginAdmittedGeneration: () => Promise.resolve({ marker: true }) }),
			parseCapacityProfile: () => ({ marker: true }),
		};
		expect(selectAdmissionApi(marker).parseCapacityProfile(undefined)).toEqual({ marker: true });
		expect.soft(storageModule.parseCapacityProfile).toBeTypeOf("function");
		expect.soft(storageModule.createStageAdmissionController).toBeTypeOf("function");
		expect.soft(storageModule).not.toHaveProperty("computeStageCost");
	});

	it.each([
		{ maxClosureReferences: 1, maxStageCostBytes: 1, reserveBytes: 0 },
		Object.assign(Object.create(null) as Record<string, number>, {
			maxClosureReferences: 4,
			maxStageCostBytes: 8,
			reserveBytes: 2,
		}),
	])("parses and freezes an exact host-owned profile", (profile) => {
		const result = api.parseCapacityProfile(profile);
		expect(result).toEqual({ ok: true, value: profile });
		if (!result.ok) throw new Error("valid profile rejected");
		expect(result.value).not.toBe(profile);
		expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
		expect(Object.isFrozen(result.value)).toBe(true);
	});

	it.each([
		null,
		{},
		{ maxClosureReferences: 1, maxStageCostBytes: 1 },
		{ extra: true, maxClosureReferences: 1, maxStageCostBytes: 1, reserveBytes: 0 },
		Object.create({ maxClosureReferences: 1, maxStageCostBytes: 1, reserveBytes: 0 }),
		Object.defineProperty({ maxStageCostBytes: 1, reserveBytes: 0 }, "maxClosureReferences", { get: () => 1 }),
		{ maxClosureReferences: 0, maxStageCostBytes: 1, reserveBytes: 0 },
		{ maxClosureReferences: 1, maxStageCostBytes: 0, reserveBytes: 0 },
		{ maxClosureReferences: 1, maxStageCostBytes: 1, reserveBytes: -1 },
		{ maxClosureReferences: 1.5, maxStageCostBytes: 1, reserveBytes: 0 },
		{ maxClosureReferences: 1, maxStageCostBytes: Number.NaN, reserveBytes: 0 },
		{ maxClosureReferences: 1, maxStageCostBytes: Number.MAX_SAFE_INTEGER + 1, reserveBytes: 0 },
		{ maxClosureReferences: 1, maxStageCostBytes: Number.MAX_SAFE_INTEGER, reserveBytes: 1 },
		{ maxClosureReferences: "1", maxStageCostBytes: 1, reserveBytes: 0 },
	])("rejects a non-closed or unsafe profile without coercion: %#", (profile) => {
		expect(api.parseCapacityProfile(profile)).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
	});

	it("validates configuration before invoking either supplied port", () => {
		const calls: string[] = [];
		expect(() =>
			api.createStageAdmissionController({
				capacity: capacity({ quota: 1, usage: 0 }, calls),
				profile: { maxClosureReferences: 0, maxStageCostBytes: 1, reserveBytes: 0 },
				store: fakeStore({ events: calls }),
			})
		).toThrow(TypeError);
		expect(calls).toEqual([]);
	});

	it("matches a BigInt oracle for profile addition with a fixed bounded fast-check tier", () => {
		const started = performance.now();
		assert(
			property(
				integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
				integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
				(maxStageCostBytes, reserveBytes) => {
					const oracle = BigInt(maxStageCostBytes) + BigInt(reserveBytes) <= BigInt(Number.MAX_SAFE_INTEGER);
					const parsed = api.parseCapacityProfile({ maxClosureReferences: 1, maxStageCostBytes, reserveBytes });
					return parsed.ok === oracle;
				}
			),
			{ endOnFailure: true, numRuns: 250, seed: 0x2_0b_2026 }
		);
		expect(performance.now() - started).toBeLessThan(3_000);
	});

	it("ships the exact public type surface to one packed consumer", () => {
		const consumerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2g-b-storage-consumer-"));
		try {
			execFileSync("pnpm", ["--dir", PACKAGE_DIRECTORY, "build"], { cwd: WORKSPACE_DIRECTORY, stdio: "pipe" });
			const packed = JSON.parse(
				execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", consumerDirectory], {
					cwd: PACKAGE_DIRECTORY,
					encoding: "utf8",
				})
			) as readonly Readonly<{ filename: string }>[];
			const packageDirectory = path.join(consumerDirectory, "node_modules/@ts-drp/storage");
			fs.mkdirSync(packageDirectory, { recursive: true });
			execFileSync(
				"tar",
				[
					"-xzf",
					path.join(consumerDirectory, packed[0]?.filename ?? "missing.tgz"),
					"--strip-components=1",
					"-C",
					packageDirectory,
				],
				{ stdio: "pipe" }
			);
			fs.writeFileSync(
				path.join(consumerDirectory, "consumer.ts"),
				`import {
type AdmittedBeginResult, type AheDurableStore, type BlobDigest, type BlobExistencePort,
type CapacityProfile, type GenerationRecord, type ParseResult, type StageAdmission, type StageCost,
type StorageCapacityPort, type StoreResult,
createStageAdmissionController, parseCapacityProfile,
} from "@ts-drp/storage";
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;
type Expect<T extends true> = T;
type Profile = Readonly<{ maxClosureReferences:number; maxStageCostBytes:number; reserveBytes:number }>;
type Cost = Readonly<{ stagedGenerationRecordBytes:number; missingBlobBytes:number; totalBytes:number }>;
type Admission =
 | Readonly<{ admitted:true; basis:"measured"|"bounded-unavailable-estimate"; stageCostBytes:number; requiredBytes:number; availableBytes?:number }>
 | Readonly<{ admitted:false; reason:"STAGE_COST_LIMIT_EXCEEDED"|"QUOTA_HEADROOM_INSUFFICIENT"|"ARITHMETIC_UNSAFE"; stageCostBytes?:number; requiredBytes?:number; availableBytes?:number }>;
type Result =
 | Readonly<{ kind:"begun"; admission:Extract<Admission,{admitted:true}>; record:GenerationRecord }>
 | Readonly<{ kind:"refused"; admission:Extract<Admission,{admitted:false}> }>
 | Readonly<{ kind:"input-rejected"; reason:"INVALID_ARGUMENT"|"SHARED_BUFFER_INPUT" }>
 | Readonly<{ kind:"store-rejected"; phase:"presence"|"begin"; result:Extract<StoreResult<never>,{ok:false}> }>;
type _Profile = Expect<Equal<CapacityProfile, Profile>>;
type _Cost = Expect<Equal<StageCost, Cost>>;
type _Admission = Expect<Equal<StageAdmission, Admission>>;
type _Result = Expect<Equal<AdmittedBeginResult, Result>>;
type _Probe = Expect<Equal<BlobExistencePort, { probeBlobPresence(digests: readonly BlobDigest[]): Promise<import("@ts-drp/storage").StoreResult<readonly boolean[]>> }>>;
const parse: (value: unknown) => ParseResult<Profile> = parseCapacityProfile;
const create: (input: Readonly<{ store:AheDurableStore & BlobExistencePort; capacity:StorageCapacityPort; profile:CapacityProfile }>) => Readonly<{ beginAdmittedGeneration(input:Parameters<AheDurableStore["beginGeneration"]>[0]):Promise<AdmittedBeginResult> }> = createStageAdmissionController;
declare const admission: StageAdmission;
void [parse, create, admission];
`
			);
			fs.writeFileSync(
				path.join(consumerDirectory, "tsconfig.json"),
				`${JSON.stringify(
					{
						compilerOptions: {
							lib: ["ES2023"],
							module: "NodeNext",
							moduleResolution: "NodeNext",
							noEmit: true,
							skipLibCheck: false,
							strict: true,
							target: "ES2023",
							types: [],
						},
						files: ["./consumer.ts"],
					},
					undefined,
					"\t"
				)}\n`
			);
			const compilation = spawnSync(
				"pnpm",
				["exec", "tsc", "--project", path.join(consumerDirectory, "tsconfig.json"), "--pretty", "false"],
				{ cwd: WORKSPACE_DIRECTORY, encoding: "utf8" }
			);
			if (compilation.error) throw compilation.error;
			const diagnostics = `${compilation.stdout}${compilation.stderr}`.trim();
			expect(compilation.status, diagnostics).toBe(0);
			expect(diagnostics).toBe("");
		} finally {
			fs.rmSync(consumerDirectory, { force: true, recursive: true });
		}
	}, 30_000);
});

describe("Phase 2g-b bounded stage admission behavior RED", () => {
	it.each([
		null,
		{},
		{ baseExpectedHead: noHead(), closure: [], generationId: GENERATION_A, objectId: OBJECT_A, extra: true },
		{
			baseExpectedHead: noHead(),
			closure: [{ byteLength: 1, digest: "bad" }],
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		},
		Object.create({ baseExpectedHead: noHead(), closure: [], generationId: GENERATION_A, objectId: OBJECT_A }),
		Object.defineProperty({ baseExpectedHead: noHead(), closure: [], objectId: OBJECT_A }, "generationId", {
			get: () => GENERATION_A,
		}),
		{ baseExpectedHead: noHead(), closure: Array(1), generationId: GENERATION_A, objectId: OBJECT_A },
		{
			baseExpectedHead: noHead(),
			closure: [{ byteLength: Number.MAX_SAFE_INTEGER + 1, digest: ref(bytes(1)).digest }],
			generationId: GENERATION_A,
			objectId: OBJECT_A,
		},
	])("rejects malformed begin input before any port or store work: %#", async (value) => {
		const events: string[] = [];
		const controller = api.createStageAdmissionController({
			capacity: capacity({ quota: 10_000, usage: 0 }, events),
			profile: LARGE_PROFILE,
			store: fakeStore({ events }),
		});
		expect(await controller.beginAdmittedGeneration(value as BeginInput)).toEqual({
			kind: "input-rejected",
			reason: "INVALID_ARGUMENT",
		});
		expect(events).toEqual([]);
	});

	it("detaches, digest-sorts and de-duplicates the probe batch before async work", async () => {
		const first = ref(bytes(1));
		const second = ref(bytes(2, 2));
		const callerClosure = [second, first];
		let release!: (result: StoreResult<readonly boolean[]>) => void;
		const observed: BlobDigest[][] = [];
		const probe = (digests: readonly BlobDigest[]) => {
			observed.push(digests as BlobDigest[]);
			return new Promise<StoreResult<readonly boolean[]>>((resolve) => {
				release = resolve;
			});
		};
		const events: string[] = [];
		const controller = api.createStageAdmissionController({
			capacity: capacity({ quota: 50_000, usage: 0 }, events),
			profile: LARGE_PROFILE,
			store: fakeStore({ events, probe }),
		});
		const pending = controller.beginAdmittedGeneration(input(callerClosure));
		callerClosure.reverse();
		(second as { byteLength: number }).byteLength = 999;
		release({ ok: true, value: [false, false] });
		const result = await pending;
		expect(observed).toEqual([[first.digest, second.digest].sort()]);
		expect(Object.isFrozen(observed[0])).toBe(true);
		expect(result.kind).toBe("begun");
		if (result.kind === "begun") expect(result.record.closure.map(({ byteLength }) => byteLength)).toEqual([1, 2]);
		expect(events).toEqual(["estimate", "begin"]);
	});

	it("accepts an exact present-head shape and leaves its CAS semantics to begin", async () => {
		const events: string[] = [];
		const beginRejection = { ok: false, reason: "BASE_HEAD_MISMATCH" } as const;
		const value = input([ref(bytes(1))]);
		const result = await api
			.createStageAdmissionController({
				capacity: capacity({ quota: 50_000, usage: 0 }, events),
				profile: LARGE_PROFILE,
				store: fakeStore({
					begin: () => {
						events.push("begin");
						return Promise.resolve(beginRejection);
					},
					events,
					presence: [true],
				}),
			})
			.beginAdmittedGeneration({
				...value,
				baseExpectedHead: presentHead({ closureDigest: record().closureDigest }),
			});
		expect(result).toEqual({ kind: "store-rejected", phase: "begin", result: beginRejection });
		expect(events).toEqual(["presence", "estimate", "begin"]);
	});

	it.each([
		{ label: "none", presence: [false, false, false] },
		{ label: "partial", presence: [true, false, true] },
		{ label: "full", presence: [true, true, true] },
	] as const)("charges exact record bytes and $label globally missing blobs once", async ({ presence }) => {
		const closure = [ref(bytes(1)), ref(bytes(2, 2)), ref(bytes(3, 3, 3))];
		const beginInput = input(closure);
		const encoded = await exactRecordBytes(beginInput);
		const sorted = [...closure].sort((left, right) =>
			left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
		);
		const missing = sorted.reduce(
			(total, reference, index) => total + (presence[index] === false ? reference.byteLength : 0),
			0
		);
		const controller = api.createStageAdmissionController({
			capacity: capacity({ quota: 50_000, usage: 0 }),
			profile: LARGE_PROFILE,
			store: fakeStore({ presence }),
		});
		const result = await controller.beginAdmittedGeneration(beginInput);
		expect(result.kind).toBe("begun");
		if (result.kind === "begun") {
			expect(result.admission).toMatchObject({
				basis: "measured",
				requiredBytes: encoded + missing + LARGE_PROFILE.reserveBytes,
				stageCostBytes: encoded + missing,
			});
		}
	});

	it("bounds closure work and record bytes before presence or estimate", async () => {
		const closure = [ref(bytes(1)), ref(bytes(2))];
		const encoded = await exactRecordBytes(input([closure[0] as GenerationRef]));
		for (const profile of [
			{ maxClosureReferences: 1, maxStageCostBytes: 50_000, reserveBytes: 0 },
			{ maxClosureReferences: 8, maxStageCostBytes: encoded - 1, reserveBytes: 0 },
		]) {
			const events: string[] = [];
			const result = await api
				.createStageAdmissionController({
					capacity: capacity({ quota: 50_000, usage: 0 }, events),
					profile,
					store: fakeStore({ events, presence: [false, false] }),
				})
				.beginAdmittedGeneration(input(profile.maxClosureReferences === 1 ? closure : [closure[0] as GenerationRef]));
			expect(result).toMatchObject({
				admission: { admitted: false, reason: "STAGE_COST_LIMIT_EXCEEDED" },
				kind: "refused",
			});
			expect(events).toEqual([]);
		}
	});

	it("delegates empty and duplicate semantic rejection directly to begin after the raw count ceiling", async () => {
		const one = ref(bytes(1));
		for (const closure of [[], [one, { ...one }]]) {
			const events: string[] = [];
			const result = await api
				.createStageAdmissionController({
					capacity: capacity({ quota: 50_000, usage: 0 }, events),
					profile: LARGE_PROFILE,
					store: fakeStore({ events }),
				})
				.beginAdmittedGeneration(input(closure));
			expect(result).toMatchObject({ kind: "store-rejected", phase: "begin" });
			expect(events).toEqual(["begin"]);
		}
		const events: string[] = [];
		const overLimit = await api
			.createStageAdmissionController({
				capacity: capacity({}, events),
				profile: { maxClosureReferences: 1, maxStageCostBytes: 50_000, reserveBytes: 0 },
				store: fakeStore({ events }),
			})
			.beginAdmittedGeneration(input([one, { ...one }]));
		expect(overLimit).toMatchObject({ admission: { reason: "STAGE_COST_LIMIT_EXCEEDED" }, kind: "refused" });
		expect(events).toEqual([]);
	});

	it("returns presence rejection before estimate and all mutation", async () => {
		const cause = new Error("presence failed");
		const rejection = { cause, ok: false, reason: "SUBSTRATE_FAILURE" } as const;
		const events: string[] = [];
		const result = await api
			.createStageAdmissionController({
				capacity: capacity({ quota: 50_000, usage: 0 }, events),
				profile: LARGE_PROFILE,
				store: fakeStore({ events, presence: rejection }),
			})
			.beginAdmittedGeneration(input([ref(bytes(1))]));
		expect(result).toEqual({ kind: "store-rejected", phase: "presence", result: rejection });
		expect(events).toEqual(["presence"]);
	});

	it.each([
		{ delta: -1, admitted: false },
		{ delta: 0, admitted: true },
		{ delta: 1, admitted: true },
	])("uses exact known-quota equality at required $delta", async ({ admitted, delta }) => {
		const closure = [ref(bytes(1, 2, 3))];
		const staged = await exactRecordBytes(input(closure));
		const required = staged + 3 + LARGE_PROFILE.reserveBytes;
		const events: string[] = [];
		const result = await api
			.createStageAdmissionController({
				capacity: capacity({ quota: required + delta, usage: 0 }, events),
				profile: LARGE_PROFILE,
				store: fakeStore({ events, presence: [false] }),
			})
			.beginAdmittedGeneration(input(closure));
		expect(result.kind === "begun").toBe(admitted);
		expect(events).toEqual(admitted ? ["presence", "estimate", "begin"] : ["presence", "estimate"]);
		if (!admitted) {
			expect(result).toMatchObject({
				admission: {
					availableBytes: required - 1,
					reason: "QUOTA_HEADROOM_INSUFFICIENT",
					requiredBytes: required,
				},
				kind: "refused",
			});
		}
	});

	it.each([
		{ label: "unsupported", estimate: undefined },
		{ label: "throw", estimate: new Error("sync") },
		{ label: "rejection", estimate: "ASYNC_REJECTION" },
		{ label: "null", estimate: null },
		{ label: "primitive", estimate: 1 },
		{ label: "incomplete", estimate: { quota: 10 } },
		{ label: "inherited", estimate: Object.create({ quota: 10, usage: 0 }) },
		{ label: "negative", estimate: { quota: -1, usage: 0 } },
		{ label: "fractional", estimate: { quota: 10.5, usage: 0 } },
		{ label: "unsafe", estimate: { quota: Number.MAX_SAFE_INTEGER + 1, usage: 0 } },
		{ label: "inconsistent", estimate: { quota: 1, usage: 2 } },
	] as const)("admits the already bounded attempt for unavailable estimate: $label", async ({ estimate }) => {
		const store = fakeStore({ presence: [true] });
		const port =
			estimate === undefined
				? Object.freeze({})
				: estimate === "ASYNC_REJECTION"
					? Object.freeze({ estimate: () => Promise.reject(new Error("async")) })
					: capacity(estimate);
		const result = await api
			.createStageAdmissionController({ capacity: port, profile: LARGE_PROFILE, store })
			.beginAdmittedGeneration(input([ref(bytes(1))]));
		expect(result).toMatchObject({
			admission: { admitted: true, basis: "bounded-unavailable-estimate" },
			kind: "begun",
		});
	});

	it("accepts own extra/accessor estimate fields and contains a throwing accessor as unavailable", async () => {
		let reads = 0;
		const withAccessor = Object.defineProperties(
			{ opaque: true },
			{
				quota: { enumerable: true, get: () => (reads += 1) && 50_000 },
				usage: { enumerable: true, get: () => (reads += 1) && 0 },
			}
		);
		const measured = await api
			.createStageAdmissionController({
				capacity: capacity(withAccessor),
				profile: LARGE_PROFILE,
				store: fakeStore({ presence: [true] }),
			})
			.beginAdmittedGeneration(input([ref(bytes(1))]));
		expect(measured).toMatchObject({ admission: { basis: "measured" }, kind: "begun" });
		expect(reads).toBe(2);

		const throwing = Object.defineProperty({ usage: 0 }, "quota", {
			get: () => {
				throw new Error("quota accessor");
			},
		});
		const unavailable = await api
			.createStageAdmissionController({
				capacity: capacity(throwing),
				profile: LARGE_PROFILE,
				store: fakeStore({ presence: [true] }),
			})
			.beginAdmittedGeneration(input([ref(bytes(2))]));
		expect(unavailable).toMatchObject({
			admission: { basis: "bounded-unavailable-estimate" },
			kind: "begun",
		});
	});

	it("acquires estimate once, preserves its receiver, and contains a throwing estimate getter", async () => {
		let acquisitions = 0;
		let receiverPreserved = false;
		const port = Object.defineProperty({} as StorageCapacityPort, "estimate", {
			get() {
				acquisitions += 1;
				return function estimate(this: unknown) {
					receiverPreserved = this === port;
					return { quota: 50_000, usage: 0 };
				};
			},
		});
		const measured = await api
			.createStageAdmissionController({
				capacity: port,
				profile: LARGE_PROFILE,
				store: fakeStore({ presence: [true] }),
			})
			.beginAdmittedGeneration(input([ref(bytes(1))]));
		expect(measured).toMatchObject({ admission: { basis: "measured" }, kind: "begun" });
		expect({ acquisitions, receiverPreserved }).toEqual({ acquisitions: 1, receiverPreserved: true });

		const throwingPort = Object.defineProperty({} as StorageCapacityPort, "estimate", {
			get() {
				throw new Error("estimate getter");
			},
		});
		const unavailable = await api
			.createStageAdmissionController({
				capacity: throwingPort,
				profile: LARGE_PROFILE,
				store: fakeStore({ presence: [true] }),
			})
			.beginAdmittedGeneration(input([ref(bytes(2))]));
		expect(unavailable).toMatchObject({ admission: { basis: "bounded-unavailable-estimate" }, kind: "begun" });
	});

	it("checks overflow and the stage ceiling before estimate or mutation", async () => {
		const refs = [
			{ ...ref(bytes(1)), byteLength: Number.MAX_SAFE_INTEGER },
			{ ...ref(bytes(2)), byteLength: Number.MAX_SAFE_INTEGER },
		];
		const events: string[] = [];
		const arithmetic = await api
			.createStageAdmissionController({
				capacity: capacity({}, events),
				profile: { maxClosureReferences: 2, maxStageCostBytes: Number.MAX_SAFE_INTEGER, reserveBytes: 0 },
				store: fakeStore({ events, presence: [false, false] }),
			})
			.beginAdmittedGeneration(input(refs));
		expect(arithmetic).toMatchObject({ admission: { reason: "ARITHMETIC_UNSAFE" }, kind: "refused" });
		expect(events).toEqual(["presence"]);

		const one = [ref(bytes(1, 2, 3))];
		const staged = await exactRecordBytes(input(one));
		const ceilingEvents: string[] = [];
		const ceiling = await api
			.createStageAdmissionController({
				capacity: capacity({}, ceilingEvents),
				profile: { maxClosureReferences: 1, maxStageCostBytes: staged + 2, reserveBytes: 0 },
				store: fakeStore({ events: ceilingEvents, presence: [false] }),
			})
			.beginAdmittedGeneration(input(one));
		expect(ceiling).toMatchObject({ admission: { reason: "STAGE_COST_LIMIT_EXCEEDED" }, kind: "refused" });
		expect(ceilingEvents).toEqual(["presence"]);
	});

	it("uses one fresh estimate per attempt, never persistence, and leaves begin authoritative", async () => {
		const events: string[] = [];
		let estimates = 0;
		const port: StorageCapacityPort = {
			estimate: () => {
				events.push(`estimate-${++estimates}`);
				return { quota: 50_000, usage: 0 };
			},
			persist: () => {
				events.push("persist");
				return true;
			},
			persisted: () => {
				events.push("persisted");
				return true;
			},
		};
		const store = fakeStore({ events, presence: [true] });
		const controller = api.createStageAdmissionController({ capacity: port, profile: LARGE_PROFILE, store });
		expect((await controller.beginAdmittedGeneration(input([ref(bytes(1))], GENERATION_A))).kind).toBe("begun");
		expect((await controller.beginAdmittedGeneration(input([ref(bytes(2))], GENERATION_B))).kind).toBe("begun");
		expect(events).toEqual(["presence", "estimate-1", "begin", "presence", "estimate-2", "begin"]);

		const beginRejection = { ok: false, reason: "BASE_HEAD_MISMATCH" } as const;
		const rejected = await api
			.createStageAdmissionController({
				capacity: capacity({ quota: 50_000, usage: 0 }),
				profile: LARGE_PROFILE,
				store: fakeStore({ begin: () => Promise.resolve(beginRejection), presence: [true] }),
			})
			.beginAdmittedGeneration(input([ref(bytes(3))], GENERATION_C));
		expect(rejected).toEqual({ kind: "store-rejected", phase: "begin", result: beginRejection });
	});

	it("never materializes blobs or invokes cleanup, deletion, promotion, or persistence helpers", async () => {
		const events: string[] = [];
		const result = await api
			.createStageAdmissionController({
				capacity: capacity({ quota: 50_000, usage: 0 }, events),
				profile: LARGE_PROFILE,
				store: fakeStore({ events, presence: [true] }),
			})
			.beginAdmittedGeneration(input([ref(bytes(1))]));
		expect(result.kind).toBe("begun");
		expect(events).toEqual(["presence", "estimate", "begin"]);
	});
});
