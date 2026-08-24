import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import blueprintPackage from "./fixtures/phase-4a-v3/blueprint-package.json" with { type: "json" };
import contract from "./fixtures/phase-4b-v3/blueprint-snapshot-contract.json" with { type: "json" };
import {
	prepareBlueprintAdmission,
	prepareBlueprintRuntime,
	type PreparedBlueprintRuntime,
} from "../packages/protocol-v3/src/public.js";

interface BlueprintStateSnapshot {
	readonly blueprintDigest: string;
	readonly exactCanonicalStateBytes: Uint8Array;
	readonly stateDigest: string;
}

interface BlueprintStateMachineInstance {
	apply(operation: unknown): unknown;
	snapshot(): BlueprintStateSnapshot;
}

interface BlueprintStateMachineConstructor {
	new (input: {
		readonly exactCanonicalInitialStateBytes: Uint8Array;
		readonly expectedBlueprintDigest: string;
		readonly expectedInitialStateDigest: string;
		readonly preparedBlueprintRuntime: PreparedBlueprintRuntime;
	}): BlueprintStateMachineInstance;
}

interface EpochVertex {
	readonly anchor?: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly hash: string;
	readonly kind: "drp-epoch-anchor" | "drp-vertex";
	readonly objectId: string;
	readonly operation?: unknown;
}

interface FoldModule {
	BlueprintStateMachine: BlueprintStateMachineConstructor;
	foldBlueprintEpoch(input: {
		readonly anchorHash: string;
		authorize(): boolean;
		readonly machine: BlueprintStateMachineInstance;
		readonly vertices: ReadonlyMap<string, EpochVertex>;
	}): Readonly<{
		adopt(): BlueprintStateSnapshot;
		readonly order: readonly string[];
		readonly staged: BlueprintStateSnapshot;
	}>;
}

interface SnapshotMetadata {
	readonly anchor: string;
	readonly archiveIndexRoot: string;
	readonly epoch: number;
	readonly objectId: string;
	readonly schemaVersion: number;
}

interface ExportedSnapshotPayload {
	readonly applicationStateDigest: string;
	readonly exactCanonicalPayloadBytes: Uint8Array;
	readonly payloadDigest: string;
}

interface ImportedSnapshotPayload extends ExportedSnapshotPayload, SnapshotMetadata {
	readonly acl: unknown;
	readonly blueprintDigest: string;
	readonly exactCanonicalAclBytes: Uint8Array;
	readonly machine: BlueprintStateMachineInstance;
}

interface SnapshotModule {
	exportBlueprintSnapshotPayload(
		input: SnapshotMetadata & {
			readonly exactCanonicalAclBytes: Uint8Array;
			readonly machine: BlueprintStateMachineInstance;
			readonly maxSnapshotBytes: number;
		}
	): ExportedSnapshotPayload;
	importBlueprintSnapshotPayload(input: {
		readonly exactCanonicalPayloadBytes: Uint8Array;
		readonly expectedAnchor: string;
		readonly expectedApplicationStateDigest: string;
		readonly expectedArchiveIndexRoot: string;
		readonly expectedBlueprintDigest: string;
		readonly expectedEpoch: number;
		readonly expectedExactCanonicalAclBytes: Uint8Array;
		readonly expectedObjectId: string;
		readonly expectedPayloadDigest: string;
		readonly expectedSchemaVersion: number;
		readonly maxSnapshotBytes: number;
		readonly preparedBlueprintRuntime: PreparedBlueprintRuntime;
	}): ImportedSnapshotPayload;
}

type CanonicalRecord = Readonly<Record<string, unknown>>;

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const PHASE4A_FIXTURE_DIRECTORY = resolve(CURRENT_DIRECTORY, "fixtures/phase-4a-v3");
const SNAPSHOT_SOURCE = resolve(REPOSITORY_ROOT, "packages/compaction/src/blueprint-snapshot.ts");
const COMPACTION_PACKAGE = resolve(REPOSITORY_ROOT, "packages/compaction/package.json");
const SNAPSHOT_MODULE_PATH: string = "../packages/compaction/src/blueprint-snapshot.js";
const FOLD_MODULE_PATH: string = "../packages/compaction/src/blueprint-fold.js";
const REGISTRY_PATH = resolve(REPOSITORY_ROOT, "packages/protocol-v3/conformance/vectors/registry-v1.json");
const artifactBytes = new Uint8Array(readFileSync(resolve(PHASE4A_FIXTURE_DIRECTORY, "application-blueprint.mjs")));
const exactCanonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
const expectedBlueprintDigest = hex(hashDomain(contract.domains.blueprint, exactCanonicalBlueprintPackageBytes));
const exactCanonicalAclBytes = encodeCanonical(contract.acl);
const ownerExists =
	existsSync(SNAPSHOT_SOURCE) &&
	Object.hasOwn(
		(
			JSON.parse(readFileSync(COMPACTION_PACKAGE, "utf8")) as {
				readonly exports?: Readonly<Record<string, unknown>>;
			}
		).exports ?? {},
		"./blueprint-snapshot"
	);

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function fromHex(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "hex"));
}

function digest(domain: string, bytes: Uint8Array): string {
	return hex(hashDomain(domain, bytes));
}

function stateBytes(value: unknown): Uint8Array {
	return encodeCanonical(value, { maxBytes: 32_768, maxDepth: 16, maxItems: 16_384 });
}

function stateDigest(bytes: Uint8Array): string {
	return digest(contract.domains.state, bytes);
}

async function prepareRuntime(): Promise<PreparedBlueprintRuntime> {
	const admission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes: exactCanonicalBlueprintPackageBytes,
		expectedBlueprintDigest,
	});
	return prepareBlueprintRuntime({
		canonicalBlueprintPackageBytes: exactCanonicalBlueprintPackageBytes,
		exactArtifactBytes: artifactBytes,
		expectedBlueprintDigest,
		preparedBlueprintAdmission: admission,
	});
}

async function prepareForeignRuntime(): Promise<PreparedBlueprintRuntime> {
	const source = new TextDecoder().decode(artifactBytes);
	const foreignSource = source.replace("@example/phase-4a-blueprint@1.0.0", "@example/phase-4a-blueprint@1.0.1");
	if (foreignSource === source) throw new Error("foreign blueprint fixture did not change");
	const foreignArtifactBytes = new TextEncoder().encode(foreignSource);
	const foreignPackage = decodeCanonical(encodeCanonical(blueprintPackage)) as typeof blueprintPackage;
	foreignPackage.implementation.artifactId = "@example/phase-4a-blueprint@1.0.1";
	foreignPackage.implementation.artifactDigest = digest("ts-drp/blueprint-artifact/v3", foreignArtifactBytes);
	const canonicalPackageBytes = encodeCanonical(foreignPackage);
	const blueprintDigest = digest(contract.domains.blueprint, canonicalPackageBytes);
	const admission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes: canonicalPackageBytes,
		expectedBlueprintDigest: blueprintDigest,
	});
	return prepareBlueprintRuntime({
		canonicalBlueprintPackageBytes: canonicalPackageBytes,
		exactArtifactBytes: foreignArtifactBytes,
		expectedBlueprintDigest: blueprintDigest,
		preparedBlueprintAdmission: admission,
	});
}

async function loadOwners(): Promise<{
	readonly fold: FoldModule;
	readonly snapshot: SnapshotModule;
}> {
	const [fold, snapshot] = await Promise.all([import(FOLD_MODULE_PATH), import(SNAPSHOT_MODULE_PATH)]);
	return { fold: fold as FoldModule, snapshot: snapshot as SnapshotModule };
}

function machine(
	constructor: BlueprintStateMachineConstructor,
	runtime: PreparedBlueprintRuntime,
	state: unknown = { map: {}, set: [], total: 1 }
): BlueprintStateMachineInstance {
	const bytes = stateBytes(state);
	return new constructor({
		exactCanonicalInitialStateBytes: bytes,
		expectedBlueprintDigest,
		expectedInitialStateDigest: stateDigest(bytes),
		preparedBlueprintRuntime: runtime,
	});
}

function graph(
	epoch: number,
	anchorHash: string,
	operations: readonly CanonicalRecord[]
): ReadonlyMap<string, EpochVertex> {
	const entries: Array<readonly [string, EpochVertex]> = [
		[
			anchorHash,
			{
				dependencies: [],
				epoch,
				hash: anchorHash,
				kind: "drp-epoch-anchor",
				objectId: contract.metadata.objectId,
			},
		],
	];
	for (const [index, operation] of operations.entries()) {
		const hash = `${String(epoch * 16 + index + 1).padStart(2, "0")}`.repeat(32);
		const dependency = index === 0 ? anchorHash : entries.at(-1)?.[0];
		if (dependency === undefined) throw new Error("snapshot graph dependency is missing");
		entries.push([
			hash,
			{
				anchor: anchorHash,
				dependencies: [dependency],
				epoch,
				hash,
				kind: "drp-vertex",
				objectId: contract.metadata.objectId,
				operation: decodeCanonical(encodeCanonical(operation)),
			},
		]);
	}
	return new Map(entries);
}

function foldAndAdopt(
	fold: FoldModule,
	machineInstance: BlueprintStateMachineInstance,
	epoch: number,
	anchorHash: string,
	operations: readonly CanonicalRecord[]
): BlueprintStateSnapshot {
	const result = fold.foldBlueprintEpoch({
		anchorHash,
		authorize: () => true,
		machine: machineInstance,
		vertices: graph(epoch, anchorHash, operations),
	});
	expect(result.order).toHaveLength(operations.length);
	return result.adopt();
}

function metadata(): SnapshotMetadata & { readonly maxSnapshotBytes: number } {
	return {
		anchor: contract.metadata.anchor,
		archiveIndexRoot: contract.metadata.archiveIndexRoot,
		epoch: contract.metadata.epoch,
		maxSnapshotBytes: contract.limits.maxSnapshotBytes,
		objectId: contract.metadata.objectId,
		schemaVersion: contract.metadata.schemaVersion,
	};
}

function importInput(
	exported: ExportedSnapshotPayload,
	runtime: PreparedBlueprintRuntime,
	overrides: Partial<Parameters<SnapshotModule["importBlueprintSnapshotPayload"]>[0]> = {}
): Parameters<SnapshotModule["importBlueprintSnapshotPayload"]>[0] {
	return {
		exactCanonicalPayloadBytes: exported.exactCanonicalPayloadBytes,
		expectedAnchor: contract.metadata.anchor,
		expectedApplicationStateDigest: exported.applicationStateDigest,
		expectedArchiveIndexRoot: contract.metadata.archiveIndexRoot,
		expectedBlueprintDigest,
		expectedEpoch: contract.metadata.epoch,
		expectedExactCanonicalAclBytes: exactCanonicalAclBytes,
		expectedObjectId: contract.metadata.objectId,
		expectedPayloadDigest: exported.payloadDigest,
		expectedSchemaVersion: contract.metadata.schemaVersion,
		maxSnapshotBytes: contract.limits.maxSnapshotBytes,
		preparedBlueprintRuntime: runtime,
		...overrides,
	};
}

function mutatedPayload(
	exported: ExportedSnapshotPayload,
	mutate: (payload: Record<string, unknown>) => void
): ExportedSnapshotPayload {
	const payload = decodeCanonical(exported.exactCanonicalPayloadBytes) as Record<string, unknown>;
	mutate(payload);
	const exactCanonicalPayloadBytes = encodeCanonical(payload);
	return {
		applicationStateDigest: exported.applicationStateDigest,
		exactCanonicalPayloadBytes,
		payloadDigest: digest(contract.domains.payload, exactCanonicalPayloadBytes),
	};
}

describe("Phase 4b canonical blueprint snapshot tests-only RED", () => {
	it("pins the signed product predecessor, frozen payload shape, and causal axes", () => {
		expect(contract.schemaVersion).toBe("phase-4b-blueprint-snapshot-red-v1");
		expect(contract.lineage).toEqual({
			phase4aGreenCommit: "55d8eecfba7ea4e5850aaff5280bb0b4d058a254",
			phase4bPlanCommit: "4d11abe638fa7a2b5ae5326ce9e69511fe519a52",
		});
		expect(contract.domains).toEqual({
			blueprint: "ts-drp/blueprint-admission/v3",
			payload: "ts-drp/snapshot-payload/v3",
			state: "ts-drp/state/v3",
		});
		expect(contract.payloadFields).toEqual([
			"acl",
			"anchor",
			"application",
			"archiveIndexRoot",
			"blueprintDigest",
			"epoch",
			"kind",
			"objectId",
			"protocolMajor",
			"schemaVersion",
		]);
		expect(new Set(contract.causalMutants).size).toBe(10);
	});

	it("independently reproduces the frozen v3 snapshot-payload registry vector", () => {
		const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as {
			readonly vectors: readonly {
				readonly canonicalHex: string;
				readonly digestHex: string;
				readonly domain: string;
				readonly id: string;
				readonly input: unknown;
			}[];
		};
		const vector = registry.vectors.find(({ id }) => id === "snapshot-payload-basic");
		if (vector === undefined) throw new Error("frozen snapshot vector is missing");
		const bytes = fromHex(vector.canonicalHex);
		expect(vector.domain).toBe(contract.domains.payload);
		expect(encodeCanonical(vector.input)).toEqual(bytes);
		expect(decodeCanonical(bytes)).toEqual(vector.input);
		expect(digest(vector.domain, bytes)).toBe(vector.digestHex);
	});

	it("has one causal readiness failure for the absent snapshot owner and package subpath", () => {
		expect(ownerExists, "Phase 4b GREEN must add the snapshot owner and explicit non-root subpath").toBe(true);
	});

	describe.skipIf(!ownerExists)("Phase 4b GREEN snapshot behavior", () => {
		it("exports the exact frozen payload, binds the machine blueprint, and detaches caller bytes", async () => {
			const [{ fold, snapshot }, runtime] = await Promise.all([loadOwners(), prepareRuntime()]);
			const source = machine(fold.BlueprintStateMachine, runtime);
			foldAndAdopt(fold, source, 1, "01".repeat(32), [
				{ action: "map_set", key: "alpha", value: "one" },
				{ action: "set_add", value: "red" },
				{ action: "add_mul", add: 2, multiplier: 3 },
			]);
			const aclCarrier = exactCanonicalAclBytes.slice();
			const exported = snapshot.exportBlueprintSnapshotPayload({
				...metadata(),
				exactCanonicalAclBytes: aclCarrier,
				machine: source,
			});
			const payloadBeforeMutation = exported.exactCanonicalPayloadBytes.slice();
			aclCarrier.fill(255);
			exported.exactCanonicalPayloadBytes.fill(0);
			const repeated = snapshot.exportBlueprintSnapshotPayload({
				...metadata(),
				exactCanonicalAclBytes,
				machine: source,
			});
			expect(repeated.exactCanonicalPayloadBytes).toEqual(payloadBeforeMutation);
			expect(repeated.payloadDigest).toBe(digest(contract.domains.payload, payloadBeforeMutation));
			expect(repeated.applicationStateDigest).toBe(source.snapshot().stateDigest);
			const payload = decodeCanonical(payloadBeforeMutation) as CanonicalRecord;
			expect(Reflect.ownKeys(payload).sort()).toEqual(contract.payloadFields);
			expect(payload).toMatchObject({
				anchor: contract.metadata.anchor,
				archiveIndexRoot: contract.metadata.archiveIndexRoot,
				blueprintDigest: expectedBlueprintDigest,
				epoch: contract.metadata.epoch,
				kind: contract.metadata.kind,
				objectId: contract.metadata.objectId,
				protocolMajor: contract.metadata.protocolMajor,
				schemaVersion: contract.metadata.schemaVersion,
			});
			expect(payload.acl).toEqual(contract.acl);
			expect(payload.application).toEqual(decodeCanonical(source.snapshot().exactCanonicalStateBytes));
			expect(() =>
				snapshot.exportBlueprintSnapshotPayload({
					...metadata(),
					exactCanonicalAclBytes,
					machine: source,
					maxSnapshotBytes: repeated.exactCanonicalPayloadBytes.byteLength - 1,
				})
			).toThrow();
		});

		it("imports by isolated replacement and stays byte-identical to two-epoch archival replay", async () => {
			const [{ fold, snapshot }, runtime] = await Promise.all([loadOwners(), prepareRuntime()]);
			const archive = machine(fold.BlueprintStateMachine, runtime, {
				map: { stale: "delete-me" },
				set: ["stale"],
				total: 1,
			});
			const firstOperations = [
				{ action: "replace_state", value: { map: {}, set: [], total: 1 } },
				{ action: "map_set", key: "alpha", value: "one" },
				{ action: "set_add", value: "red" },
				{ action: "add_mul", add: 2, multiplier: 3 },
			] as const;
			foldAndAdopt(fold, archive, 1, "11".repeat(32), firstOperations);
			const exported = snapshot.exportBlueprintSnapshotPayload({
				...metadata(),
				exactCanonicalAclBytes,
				machine: archive,
			});
			const payloadInput = exported.exactCanonicalPayloadBytes.slice();
			const aclInput = exactCanonicalAclBytes.slice();
			const imported = snapshot.importBlueprintSnapshotPayload(
				importInput(exported, runtime, {
					exactCanonicalPayloadBytes: payloadInput,
					expectedExactCanonicalAclBytes: aclInput,
				})
			);
			const importedPayloadBytes = imported.exactCanonicalPayloadBytes.slice();
			const importedAclBytes = imported.exactCanonicalAclBytes.slice();
			payloadInput.fill(0);
			aclInput.fill(0);
			expect(imported.machine).not.toBe(archive);
			expect(imported.machine.snapshot()).toEqual(archive.snapshot());
			expect(imported.exactCanonicalPayloadBytes).toEqual(importedPayloadBytes);
			expect(imported.exactCanonicalAclBytes).toEqual(importedAclBytes);
			expect(imported.exactCanonicalAclBytes).toEqual(exactCanonicalAclBytes);
			expect(imported.acl).toEqual(contract.acl);
			expect(imported).toMatchObject({
				anchor: contract.metadata.anchor,
				applicationStateDigest: exported.applicationStateDigest,
				archiveIndexRoot: contract.metadata.archiveIndexRoot,
				blueprintDigest: expectedBlueprintDigest,
				epoch: contract.metadata.epoch,
				objectId: contract.metadata.objectId,
				payloadDigest: exported.payloadDigest,
				schemaVersion: contract.metadata.schemaVersion,
			});
			imported.exactCanonicalPayloadBytes.fill(255);
			imported.exactCanonicalAclBytes.fill(255);
			expect(imported.machine.snapshot()).toEqual(archive.snapshot());
			expect(imported.acl).toEqual(contract.acl);

			archive.apply({ action: "map_set", key: "after-export", value: "archive-only" });
			expect(decodeCanonical(imported.machine.snapshot().exactCanonicalStateBytes)).not.toHaveProperty(
				"map.after-export"
			);

			const secondOperations = [
				{ action: "map_set", key: "beta", value: "two" },
				{ action: "set_add", value: "blue" },
				{ action: "add_mul", add: 1, multiplier: 2 },
			] as const;
			const archivalReplay = machine(fold.BlueprintStateMachine, runtime, {
				map: { stale: "delete-me" },
				set: ["stale"],
				total: 1,
			});
			foldAndAdopt(fold, archivalReplay, 1, "11".repeat(32), firstOperations);
			foldAndAdopt(fold, archivalReplay, 2, "22".repeat(32), secondOperations);
			foldAndAdopt(fold, imported.machine, 2, "22".repeat(32), secondOperations);
			const replayed = archivalReplay.snapshot();
			const resumed = imported.machine.snapshot();
			expect(compareBytes(resumed.exactCanonicalStateBytes, replayed.exactCanonicalStateBytes)).toBe(0);
			expect(resumed.stateDigest).toBe(replayed.stateDigest);
			expect(decodeCanonical(resumed.exactCanonicalStateBytes)).toEqual({
				map: { alpha: "one", beta: "two" },
				set: ["red", "blue"],
				total: 20,
			});
		});

		it("fails closed on every metadata, digest, ACL, application, schema, and size mismatch", async () => {
			const [{ fold, snapshot }, runtime, foreignRuntime] = await Promise.all([
				loadOwners(),
				prepareRuntime(),
				prepareForeignRuntime(),
			]);
			const source = machine(fold.BlueprintStateMachine, runtime);
			const exported = snapshot.exportBlueprintSnapshotPayload({
				...metadata(),
				exactCanonicalAclBytes,
				machine: source,
			});
			const expectedFieldCases = [
				["objectId", "object:foreign"],
				["epoch", contract.metadata.epoch + 1],
				["anchor", "cc".repeat(32)],
				["schemaVersion", contract.metadata.schemaVersion + 1],
				["archiveIndexRoot", "dd".repeat(32)],
				["blueprintDigest", "ee".repeat(32)],
				["kind", "wrong-kind"],
				["protocolMajor", 4],
			] as const;
			for (const [field, value] of expectedFieldCases) {
				const changed = mutatedPayload(exported, (payload) => {
					payload[field] = value;
				});
				expect(
					() =>
						snapshot.importBlueprintSnapshotPayload(
							importInput(changed, runtime, { expectedPayloadDigest: changed.payloadDigest })
						),
					field
				).toThrow();
			}

			const changedAcl = mutatedPayload(exported, (payload) => {
				payload.acl = { kind: "phase-4b-acl", writers: ["mallory"] };
			});
			expect(() =>
				snapshot.importBlueprintSnapshotPayload(
					importInput(changedAcl, runtime, { expectedPayloadDigest: changedAcl.payloadDigest })
				)
			).toThrow();

			const changedApplication = mutatedPayload(exported, (payload) => {
				payload.application = { map: {}, set: [], total: 99 };
			});
			expect(() =>
				snapshot.importBlueprintSnapshotPayload(
					importInput(changedApplication, runtime, { expectedPayloadDigest: changedApplication.payloadDigest })
				)
			).toThrow();
			expect(() =>
				snapshot.importBlueprintSnapshotPayload(
					importInput(exported, runtime, { expectedPayloadDigest: "ff".repeat(32) })
				)
			).toThrow();
			expect(foreignRuntime.blueprintDigest).not.toBe(expectedBlueprintDigest);
			expect(() => snapshot.importBlueprintSnapshotPayload(importInput(exported, foreignRuntime))).toThrow();
			expect(() =>
				snapshot.importBlueprintSnapshotPayload(
					importInput(exported, runtime, {
						maxSnapshotBytes: exported.exactCanonicalPayloadBytes.byteLength - 1,
					})
				)
			).toThrow();

			const extra = mutatedPayload(exported, (payload) => {
				payload.extra = true;
			});
			expect(() =>
				snapshot.importBlueprintSnapshotPayload(
					importInput(extra, runtime, { expectedPayloadDigest: extra.payloadDigest })
				)
			).toThrow();
		});

		it("rejects noncanonical, partial, shared, subclassed, and shadowed byte carriers", async () => {
			const [{ fold, snapshot }, runtime] = await Promise.all([loadOwners(), prepareRuntime()]);
			const source = machine(fold.BlueprintStateMachine, runtime);
			const exported = snapshot.exportBlueprintSnapshotPayload({
				...metadata(),
				exactCanonicalAclBytes,
				machine: source,
			});
			const trailing = new Uint8Array(exported.exactCanonicalPayloadBytes.byteLength + 1);
			trailing.set(exported.exactCanonicalPayloadBytes);
			expect(() =>
				snapshot.importBlueprintSnapshotPayload(
					importInput(exported, runtime, {
						exactCanonicalPayloadBytes: trailing,
						expectedPayloadDigest: digest(contract.domains.payload, trailing),
					})
				)
			).toThrow();

			const backing = new Uint8Array(exported.exactCanonicalPayloadBytes.byteLength + 2);
			backing.set(exported.exactCanonicalPayloadBytes, 1);
			expect(() =>
				snapshot.importBlueprintSnapshotPayload(
					importInput(exported, runtime, {
						exactCanonicalPayloadBytes: backing.subarray(1, -1),
					})
				)
			).toThrow();

			class ShadowedBytes extends Uint8Array {
				override get buffer(): ArrayBuffer {
					return new ArrayBuffer(this.byteLength);
				}
			}
			const shadowed = new ShadowedBytes(exported.exactCanonicalPayloadBytes);
			expect(() =>
				snapshot.importBlueprintSnapshotPayload(
					importInput(exported, runtime, { exactCanonicalPayloadBytes: shadowed })
				)
			).toThrow();

			if (typeof SharedArrayBuffer === "function") {
				const shared = new Uint8Array(new SharedArrayBuffer(exported.exactCanonicalPayloadBytes.byteLength));
				shared.set(exported.exactCanonicalPayloadBytes);
				expect(() =>
					snapshot.importBlueprintSnapshotPayload(
						importInput(exported, runtime, { exactCanonicalPayloadBytes: shared })
					)
				).toThrow();
			}

			const ResizableArrayBuffer = ArrayBuffer as unknown as new (
				byteLength: number,
				options: { readonly maxByteLength: number }
			) => ArrayBuffer;
			const resizableBuffer = new ResizableArrayBuffer(exported.exactCanonicalPayloadBytes.byteLength, {
				maxByteLength: exported.exactCanonicalPayloadBytes.byteLength + 1,
			});
			if ((resizableBuffer as ArrayBuffer & { readonly resizable?: boolean }).resizable === true) {
				const resizable = new Uint8Array(resizableBuffer);
				resizable.set(exported.exactCanonicalPayloadBytes);
				expect(() =>
					snapshot.importBlueprintSnapshotPayload(
						importInput(exported, runtime, { exactCanonicalPayloadBytes: resizable })
					)
				).toThrow();
			}

			const detachable = exported.exactCanonicalPayloadBytes.slice();
			structuredClone(detachable.buffer, { transfer: [detachable.buffer] });
			expect(detachable.byteLength).toBe(0);
			expect(() =>
				snapshot.importBlueprintSnapshotPayload(
					importInput(exported, runtime, { exactCanonicalPayloadBytes: detachable })
				)
			).toThrow();
		});
	});
});
