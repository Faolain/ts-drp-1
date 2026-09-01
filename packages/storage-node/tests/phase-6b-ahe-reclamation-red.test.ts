import {
	type AheDurableStore,
	createMemoryAheDurableStore,
	decodeGenerationRecordV1,
	digestBlob,
	encodeGenerationRecordV1,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	type PresentHead,
	type StoreResult,
} from "@ts-drp/storage";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	D109C_CORRUPTION_MUTANTS,
	D109C_COUNT_MUTANTS,
	D109C_CRASH_EDGES,
	D109C_LINEAGE_MUTANTS,
	D109C_OBJECT,
	D109C_OTHER_OBJECT,
	D109C_POLICY_DIGEST,
	D109C_REFERENCE_CASES,
	d109cDeepFrozen,
	d109cErrorCode,
	d109cGenerationId,
	type D109cMaintenance,
	type D109cNodeMaintenanceModule,
	d109cNoHead,
} from "../../../tests/fixtures/phase-6b/ahe-reclamation-contract.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const REQUIRED_NODE_OWNERS = Object.freeze([
	"packages/storage-node/src/maintenance.ts",
	"packages/storage-node/src/internal/ahe-reclamation.ts",
] as const);
const directories: string[] = [];

function readiness(): Readonly<{ readonly missing: readonly string[]; readonly ready: boolean }> {
	const missing = REQUIRED_NODE_OWNERS.filter((owner) => {
		const filename = resolve(REPOSITORY_ROOT, owner);
		if (!existsSync(filename)) return true;
		const value = readFileSync(filename, "utf8");
		return owner.endsWith("maintenance.ts")
			? !value.includes("resolveNodeAheReclamationMaintenance")
			: !value.includes("reclaimClosedEpoch");
	});
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

function databaseFilename(label: string): string {
	const directory = mkdtempSync(join(tmpdir(), `d109c-node-${label}-`));
	directories.push(directory);
	return join(directory, "ahe.sqlite");
}

function successful<T>(result: StoreResult<T>, label: string): T {
	if (result.ok === false) throw new TypeError(`D109C_${label}:${result.reason}`);
	return result.value;
}

async function modules(): Promise<{
	create(options: { readonly filename: string }): AheDurableStore;
	readonly instrumentation: {
		installNodeAheReclamationCountFault(store: AheDurableStore, fault: string): void;
	};
	readonly maintenance: D109cNodeMaintenanceModule;
}> {
	const [root, maintenance, instrumentation] = await Promise.all([
		import(pathToFileURL(resolve(PACKAGE_DIRECTORY, "src/index.ts")).href),
		import(pathToFileURL(resolve(PACKAGE_DIRECTORY, "src/maintenance.ts")).href),
		import(pathToFileURL(resolve(PACKAGE_DIRECTORY, "src/test-instrumentation.ts")).href),
	]);
	return {
		create: (root as { createSqliteAheDurableStore(options: { filename: string }): AheDurableStore })
			.createSqliteAheDurableStore,
		instrumentation: instrumentation as {
			installNodeAheReclamationCountFault(store: AheDurableStore, fault: string): void;
		},
		maintenance: maintenance as D109cNodeMaintenanceModule,
	};
}

async function fiveGenerationInput(
	store: AheDurableStore,
	bytesForIndex: (index: number) => Uint8Array = (index) => Uint8Array.of(index, index + 1, index + 2),
	generationCount = 5
): Promise<{
	readonly input: Record<string, unknown>;
	readonly records: readonly GenerationRecord[];
}> {
	let head: ExpectedHead = successful(await store.readHead(D109C_OBJECT), "READ_HEAD");
	for (let index = 1; index <= generationCount; index += 1) {
		const generationId = index.toString(16).padStart(64, "0") as GenerationRecord["generationId"];
		const bytes = bytesForIndex(index);
		const digest = successful(digestBlob(bytes), "DIGEST_BLOB");
		const closure = [{ byteLength: bytes.byteLength, digest }];
		successful(
			await store.beginGeneration({ baseExpectedHead: head, closure, generationId, objectId: D109C_OBJECT }),
			"BEGIN"
		);
		successful(await store.putCachedBlob({ bytes, digest, generationId, objectId: D109C_OBJECT }), "PUT");
		successful(await store.promoteReference({ digest, generationId, objectId: D109C_OBJECT }), "PROMOTE");
		successful(await store.completeGeneration({ generationId, objectId: D109C_OBJECT }), "COMPLETE");
		head = successful(await store.swapHead({ expectedHead: head, generationId, objectId: D109C_OBJECT }), "SWAP").head;
	}
	const records = successful(await store.readGenerationPage({ limit: 16, objectId: D109C_OBJECT }), "PAGE").generations;
	const byId = new Map(records.map((record) => [record.generationId, record]));
	if (head.kind !== "present") throw new TypeError("D109C_HEAD_ABSENT");
	const active = byId.get(head.generationId);
	const first =
		active?.baseExpectedHead.kind === "present" ? byId.get(active.baseExpectedHead.generationId) : undefined;
	const floor = first?.baseExpectedHead.kind === "present" ? byId.get(first.baseExpectedHead.generationId) : undefined;
	if (active === undefined || first === undefined || floor === undefined) throw new TypeError("D109C_LINEAGE_MISSING");
	const selected = records
		.filter(
			(record) => !new Set([active.generationId, first.generationId, floor.generationId]).has(record.generationId)
		)
		.map(({ generationId }) => generationId)
		.sort();
	return {
		input: {
			activeGenerationId: active.generationId,
			availabilityPolicyDigest: D109C_POLICY_DIGEST,
			closedEpoch: 4,
			expectedHead: head,
			lineageFloor: {
				deleteGenerationIds: selected,
				expectedBaseExpectedHead: floor.baseExpectedHead,
				generationId: floor.generationId,
				replacementBaseExpectedHead: { kind: "none", objectId: D109C_OBJECT },
			},
			objectId: D109C_OBJECT,
			rollbackGenerationIds: [first.generationId, floor.generationId],
		},
		records,
	};
}

async function opened(label: string): Promise<{
	readonly filename: string;
	readonly instrumentation: Awaited<ReturnType<typeof modules>>["instrumentation"];
	readonly maintenance: D109cMaintenance;
	readonly store: AheDurableStore;
}> {
	const candidate = await modules();
	const filename = databaseFilename(label);
	const store = candidate.create({ filename });
	const maintenance = candidate.maintenance.resolveNodeAheReclamationMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D109C_NODE_MAINTENANCE_MISSING");
	return { filename, instrumentation: candidate.instrumentation, maintenance, store };
}

function withDatabase<T>(filename: string, run: (database: DatabaseSync) => T): T {
	const database = new DatabaseSync(filename);
	try {
		return run(database);
	} finally {
		database.close();
	}
}

function normalized(value: unknown): unknown {
	if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return value.map(normalized);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
	}
	return value;
}

function databaseImage(filename: string): string {
	return withDatabase(filename, (database) =>
		JSON.stringify(
			normalized({
				blobs: database.prepare("SELECT digest,bytes FROM blobs ORDER BY digest").all(),
				generations: database
					.prepare("SELECT object_id,generation_id,record FROM generations ORDER BY object_id,generation_id")
					.all(),
				objects: database.prepare("SELECT object_id,head_record FROM objects ORDER BY object_id").all(),
				promotions: database
					.prepare("SELECT object_id,generation_id,digest FROM promotions ORDER BY object_id,generation_id,digest")
					.all(),
			})
		)
	);
}

function generationRecord(database: DatabaseSync, generationId: GenerationId): GenerationRecord {
	const row = database
		.prepare("SELECT record FROM generations WHERE object_id = ? AND generation_id = ?")
		.get(D109C_OBJECT, generationId) as { readonly record?: unknown } | undefined;
	if (!(row?.record instanceof Uint8Array)) throw new TypeError("D109C_NATIVE_RECORD_MISSING");
	const decoded = decodeGenerationRecordV1(row.record);
	if (decoded.ok === false) throw new TypeError(`D109C_NATIVE_RECORD_INVALID:${decoded.reason}`);
	return decoded.value;
}

function replaceGeneration(database: DatabaseSync, key: GenerationId, record: GenerationRecord | Uint8Array): void {
	database
		.prepare("UPDATE generations SET record = ? WHERE object_id = ? AND generation_id = ?")
		.run(record instanceof Uint8Array ? record : encodeGenerationRecordV1(record), D109C_OBJECT, key);
}

type MutableRequest = Record<string, unknown> & {
	expectedHead: Record<string, unknown>;
	lineageFloor: Record<string, unknown>;
	rollbackGenerationIds: string[];
};

function mutableRequest(input: Record<string, unknown>): MutableRequest {
	return structuredClone(input) as MutableRequest;
}

function applyLineageOrCorruptionMutant(
	filename: string,
	input: Record<string, unknown>,
	mutant: string
): Readonly<{ code: string; request: MutableRequest }> {
	const request = mutableRequest(input);
	const corruptCode = "AHE_RECLAMATION_CORRUPT";
	const retryCode = "AHE_RECLAMATION_RETRY_REQUIRED";
	if (mutant === "head-different") {
		request.expectedHead.closureDigest = "f".repeat(64);
		return { code: retryCode, request };
	}
	if (mutant === "revision-stale") {
		request.expectedHead.revision = 4;
		return { code: retryCode, request };
	}
	if (mutant === "active-mismatch") {
		request.activeGenerationId = d109cGenerationId(4);
		return { code: "AHE_RECLAMATION_INVALID_ARGUMENT", request };
	}
	if (mutant === "rollback-insufficient" || mutant === "rollback-wrong-countable-pair" || mutant === "floor-wrong") {
		const second = mutant === "rollback-insufficient" ? d109cGenerationId(9) : d109cGenerationId(2);
		request.rollbackGenerationIds = [
			mutant === "rollback-wrong-countable-pair" ? d109cGenerationId(3) : d109cGenerationId(4),
			second,
		];
		if (mutant === "rollback-wrong-countable-pair") {
			request.lineageFloor.deleteGenerationIds = [d109cGenerationId(1), d109cGenerationId(4)];
		} else if (mutant === "floor-wrong") {
			request.lineageFloor.deleteGenerationIds = [d109cGenerationId(1), d109cGenerationId(3)];
		}
		request.lineageFloor.generationId = second;
		request.lineageFloor.expectedBaseExpectedHead = d109cNoHead();
		return { code: retryCode, request };
	}
	if (mutant === "former-parent-wrong") {
		request.lineageFloor.expectedBaseExpectedHead = d109cNoHead();
		return { code: retryCode, request };
	}
	withDatabase(filename, (database) => {
		const first = generationRecord(database, d109cGenerationId(1));
		const second = generationRecord(database, d109cGenerationId(2));
		const active = generationRecord(database, d109cGenerationId(5));
		if (mutant === "identity-duplicate" || mutant === "generation-key-record-mismatch") {
			replaceGeneration(database, first.generationId, second);
		} else if (mutant === "closure-changed") {
			replaceGeneration(database, active.generationId, {
				...active,
				closure: second.closure,
				closureDigest: second.closureDigest,
			});
		} else if (mutant === "state-changed") {
			replaceGeneration(database, active.generationId, { ...active, state: "Superseded" });
		} else if (mutant === "lineage-gap") {
			database
				.prepare("DELETE FROM promotions WHERE object_id = ? AND generation_id = ?")
				.run(D109C_OBJECT, first.generationId);
			database
				.prepare("DELETE FROM generations WHERE object_id = ? AND generation_id = ?")
				.run(D109C_OBJECT, first.generationId);
		} else if (mutant === "lineage-cycle") {
			replaceGeneration(database, first.generationId, {
				...first,
				baseExpectedHead: {
					closureDigest: second.closureDigest,
					generationId: second.generationId,
					kind: "present",
					objectId: D109C_OBJECT,
					revision: 2 as PresentHead["revision"],
				},
			});
		} else if (
			mutant === "surviving-branch" ||
			mutant === "extra-target-row" ||
			mutant === "post-state-dangling-parent"
		) {
			const generationId = d109cGenerationId(mutant === "extra-target-row" ? 7 : mutant === "surviving-branch" ? 8 : 9);
			const extra: GenerationRecord = {
				...first,
				baseExpectedHead: mutant === "extra-target-row" ? d109cNoHead() : second.baseExpectedHead,
				generationId,
				state: "Staged",
			};
			database
				.prepare("INSERT INTO generations(object_id,generation_id,record) VALUES (?,?,?)")
				.run(D109C_OBJECT, generationId, encodeGenerationRecordV1(extra));
			if (mutant === "post-state-dangling-parent") {
				const floor = generationRecord(database, d109cGenerationId(3));
				replaceGeneration(database, floor.generationId, { ...floor, baseExpectedHead: d109cNoHead() });
				database
					.prepare("DELETE FROM promotions WHERE object_id = ? AND generation_id IN (?,?)")
					.run(D109C_OBJECT, d109cGenerationId(1), d109cGenerationId(2));
				database
					.prepare("DELETE FROM generations WHERE object_id = ? AND generation_id IN (?,?)")
					.run(D109C_OBJECT, d109cGenerationId(1), d109cGenerationId(2));
			}
		} else if (mutant === "retained-blob-missing" || mutant === "retained-blob-corrupt") {
			const digest = active.closure[0]?.digest;
			if (digest === undefined) throw new TypeError("D109C_NATIVE_DIGEST_MISSING");
			if (mutant === "retained-blob-missing") {
				database.exec("PRAGMA foreign_keys=OFF");
				database.prepare("DELETE FROM blobs WHERE digest = ?").run(digest);
			} else database.prepare("UPDATE blobs SET bytes = ? WHERE digest = ?").run(Uint8Array.of(0), digest);
		} else if (mutant === "promotion-missing") {
			database
				.prepare("DELETE FROM promotions WHERE object_id = ? AND generation_id = ?")
				.run(D109C_OBJECT, active.generationId);
		} else if (mutant === "promotion-extra" || mutant === "promotion-wrong-digest") {
			const digest = second.closure[0]?.digest;
			if (digest === undefined) throw new TypeError("D109C_NATIVE_DIGEST_MISSING");
			database
				.prepare("INSERT INTO promotions(object_id,generation_id,digest) VALUES (?,?,?)")
				.run(D109C_OBJECT, active.generationId, digest);
		} else if (mutant === "target-generation-malformed") {
			replaceGeneration(database, first.generationId, Uint8Array.of(0));
		} else if (mutant === "unrelated-generation-malformed") {
			database.prepare("INSERT INTO objects(object_id,head_record) VALUES (?,NULL)").run(D109C_OTHER_OBJECT);
			database
				.prepare("INSERT INTO generations(object_id,generation_id,record) VALUES (?,?,?)")
				.run(D109C_OTHER_OBJECT, d109cGenerationId(9), Uint8Array.of(0));
		} else if (mutant === "partial-replay") {
			const floor = generationRecord(database, d109cGenerationId(3));
			replaceGeneration(database, floor.generationId, { ...floor, baseExpectedHead: d109cNoHead() });
			database
				.prepare("DELETE FROM promotions WHERE object_id = ? AND generation_id = ?")
				.run(D109C_OBJECT, first.generationId);
			database
				.prepare("DELETE FROM generations WHERE object_id = ? AND generation_id = ?")
				.run(D109C_OBJECT, first.generationId);
		}
	});
	return {
		code: mutant === "surviving-branch" || mutant === "extra-target-row" ? retryCode : corruptCode,
		request,
	};
}

async function rejectedCode(run: () => Promise<unknown>): Promise<string | undefined> {
	try {
		await run();
		return undefined;
	} catch (error) {
		expect(Object.isFrozen(error)).toBe(true);
		return d109cErrorCode(error);
	}
}

function countFault(mutant: string): "blob delete" | "floor rewrite" | "generation delete" | "promotion delete" {
	switch (mutant) {
		case "floor-update-count":
			return "floor rewrite";
		case "promotion-delete-count":
			return "promotion delete";
		case "generation-delete-count":
			return "generation delete";
		case "blob-delete-count":
			return "blob delete";
		default:
			throw new TypeError(`D109C_COUNT_MUTANT_UNKNOWN:${mutant}`);
	}
}

function blobBytes(filename: string, digest: string): Uint8Array | undefined {
	return withDatabase(filename, (database) => {
		const row = database.prepare("SELECT bytes FROM blobs WHERE digest = ?").get(digest) as
			| { readonly bytes?: unknown }
			| undefined;
		return row?.bytes instanceof Uint8Array ? new Uint8Array(row.bytes) : undefined;
	});
}

async function addOtherGeneration(
	store: AheDurableStore,
	input: Readonly<{
		closure: readonly GenerationRecord["closure"][number][];
		complete?: boolean;
		discard?: boolean;
		promote: readonly GenerationRecord["closure"][number]["digest"][];
	}>
): Promise<void> {
	const generationId = d109cGenerationId(9);
	const head = successful(await store.readHead(D109C_OTHER_OBJECT), "OTHER_HEAD");
	successful(
		await store.beginGeneration({
			baseExpectedHead: head,
			closure: input.closure,
			generationId,
			objectId: D109C_OTHER_OBJECT,
		}),
		"OTHER_BEGIN"
	);
	for (const digest of input.promote) {
		successful(await store.promoteReference({ digest, generationId, objectId: D109C_OTHER_OBJECT }), "OTHER_PROMOTE");
	}
	if (input.complete) {
		successful(await store.completeGeneration({ generationId, objectId: D109C_OTHER_OBJECT }), "OTHER_COMPLETE");
	}
	if (input.discard) {
		successful(await store.discardGeneration({ generationId, objectId: D109C_OTHER_OBJECT }), "OTHER_DISCARD");
	}
}

type ReopenShape = Readonly<{
	blobs: number;
	floorNormalized: boolean;
	generationIds: readonly string[];
	headGenerationId: string;
	integrity: string;
	promotions: number;
}>;

function reopenedShape(filename: string): ReopenShape {
	return withDatabase(filename, (database) => {
		const generations = database
			.prepare("SELECT generation_id,record FROM generations WHERE object_id = ? ORDER BY generation_id")
			.all(D109C_OBJECT) as Array<{ readonly generation_id: string; readonly record: Uint8Array }>;
		const floor = generations.find(({ generation_id }) => generation_id === d109cGenerationId(3));
		if (floor === undefined) throw new TypeError("D109C_REOPEN_FLOOR_MISSING");
		const decodedFloor = decodeGenerationRecordV1(floor.record);
		if (decodedFloor.ok === false) throw new TypeError(`D109C_REOPEN_FLOOR_INVALID:${decodedFloor.reason}`);
		const active = generations.find(({ generation_id }) => generation_id === d109cGenerationId(5));
		if (active === undefined) throw new TypeError("D109C_REOPEN_ACTIVE_MISSING");
		const decodedActive = decodeGenerationRecordV1(active.record);
		if (decodedActive.ok === false) throw new TypeError(`D109C_REOPEN_ACTIVE_INVALID:${decodedActive.reason}`);
		return Object.freeze({
			blobs: Number((database.prepare("SELECT COUNT(*) AS count FROM blobs").get() as { count: number }).count),
			floorNormalized: decodedFloor.value.baseExpectedHead.kind === "none",
			generationIds: Object.freeze(generations.map(({ generation_id }) => generation_id)),
			headGenerationId: decodedActive.value.generationId,
			integrity: String(
				(database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check
			),
			promotions: Number(
				(database.prepare("SELECT COUNT(*) AS count FROM promotions").get() as { count: number }).count
			),
		});
	});
}

async function hardKillAt(filename: string, edge: string): Promise<void> {
	const childFilename = resolve(PACKAGE_DIRECTORY, "tests/fixtures/phase-6b-ahe-reclamation-child.mjs");
	await new Promise<void>((resolvePromise, reject) => {
		const child = fork(childFilename, [filename, edge], {
			cwd: REPOSITORY_ROOT,
			execArgv: [],
			silent: true,
		});
		let stderr = "";
		let stdout = "";
		let checkpoint = false;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new TypeError(`D109C_CHILD_TIMEOUT:${edge}:${stdout}:${stderr}`));
		}, 15_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("message", (message: unknown) => {
			if (
				typeof message === "object" &&
				message !== null &&
				Reflect.get(message, "kind") === "checkpoint" &&
				Reflect.get(message, "edge") === edge
			) {
				checkpoint = true;
				child.kill("SIGKILL");
			} else if (typeof message === "object" && message !== null && Reflect.get(message, "kind") === "child-error") {
				clearTimeout(timer);
				reject(new TypeError(`D109C_CHILD_ERROR:${edge}:${String(Reflect.get(message, "message"))}`));
			}
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (_code, signal) => {
			clearTimeout(timer);
			if (!checkpoint || signal !== "SIGKILL") {
				reject(new TypeError(`D109C_CHILD_EXIT_INVALID:${edge}:${String(signal)}:${stdout}:${stderr}`));
				return;
			}
			resolvePromise();
		});
	});
}

const state = readiness();

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("D.109c Node AHE-reclamation causal RED", () => {
	it("freezes the native lineage/reference/count and hard-kill matrices", () => {
		expect(D109C_LINEAGE_MUTANTS).toHaveLength(15);
		expect(D109C_REFERENCE_CASES).toHaveLength(6);
		expect(D109C_COUNT_MUTANTS).toHaveLength(4);
		expect(D109C_CRASH_EDGES).toHaveLength(6);
	});

	it("[RED readiness] requires the Node identity owner and atomic reclamation transaction", () => {
		expect(state, "D109C_NODE_MAINTENANCE_MISSING").toEqual({ missing: [], ready: true });
	});

	it.skipIf(!state.ready)("reclaims a genuine five-generation prefix, reopens and replays idempotently", async () => {
		const { filename, maintenance, store } = await opened("positive");
		let liveStore: AheDurableStore | undefined = store;
		try {
			const { input, records } = await fiveGenerationInput(store);
			const receipt = await maintenance.reclaimClosedEpoch(input);
			expect(receipt.deletedGenerationIds).toEqual(
				(input.lineageFloor as { deleteGenerationIds: string[] }).deleteGenerationIds
			);
			expect(receipt.deletedPromotionCount).toBe(2);
			expect(receipt.floor.normalizedThisCall).toBe(true);
			expect(d109cDeepFrozen(receipt)).toBe(true);
			expect(records).toHaveLength(5);
			await store.close();
			liveStore = undefined;
			const candidate = await modules();
			const reopened = candidate.create({ filename });
			liveStore = reopened;
			const reopenedMaintenance = candidate.maintenance.resolveNodeAheReclamationMaintenance(reopened);
			if (reopenedMaintenance === undefined) throw new TypeError("D109C_NODE_MAINTENANCE_MISSING");
			const replay = await reopenedMaintenance.reclaimClosedEpoch(input);
			expect(replay.deletedGenerationIds).toEqual([]);
			expect(replay.floor.normalizedThisCall).toBe(false);
			const head = successful(await reopened.readHead(D109C_OBJECT), "REOPEN_HEAD");
			const bytes = Uint8Array.of(6, 7, 8);
			const digest = successful(digestBlob(bytes), "SUCCESSOR_DIGEST");
			const generationId = d109cGenerationId(6);
			successful(
				await reopened.beginGeneration({
					baseExpectedHead: head,
					closure: [{ byteLength: bytes.byteLength, digest }],
					generationId,
					objectId: D109C_OBJECT,
				}),
				"SUCCESSOR_BEGIN"
			);
			successful(
				await reopened.putCachedBlob({ bytes, digest, generationId, objectId: D109C_OBJECT }),
				"SUCCESSOR_PUT"
			);
			successful(
				await reopened.promoteReference({ digest, generationId, objectId: D109C_OBJECT }),
				"SUCCESSOR_PROMOTE"
			);
			successful(await reopened.completeGeneration({ generationId, objectId: D109C_OBJECT }), "SUCCESSOR_COMPLETE");
			const adopted = successful(
				await reopened.swapHead({ expectedHead: head, generationId, objectId: D109C_OBJECT }),
				"SUCCESSOR_SWAP"
			);
			expect(adopted.head).toMatchObject({ generationId, kind: "present", revision: 6 });
		} finally {
			await liveStore?.close();
		}

		const empty = await opened("empty-prefix");
		try {
			const fixture = await fiveGenerationInput(empty.store, undefined, 3);
			expect((fixture.input.lineageFloor as { deleteGenerationIds: string[] }).deleteGenerationIds).toEqual([]);
			const receipt = await empty.maintenance.reclaimClosedEpoch(fixture.input);
			expect(receipt.deletedGenerationIds).toEqual([]);
			expect(receipt.floor.normalizedThisCall).toBe(false);
		} finally {
			await empty.store.close();
		}

		const concurrentCandidate = await modules();
		const concurrentFilename = databaseFilename("two-handles");
		const firstStore = concurrentCandidate.create({ filename: concurrentFilename });
		const secondStore = concurrentCandidate.create({ filename: concurrentFilename });
		try {
			const fixture = await fiveGenerationInput(firstStore);
			const firstMaintenance = concurrentCandidate.maintenance.resolveNodeAheReclamationMaintenance(firstStore);
			const secondMaintenance = concurrentCandidate.maintenance.resolveNodeAheReclamationMaintenance(secondStore);
			if (firstMaintenance === undefined || secondMaintenance === undefined) {
				throw new TypeError("D109C_NODE_MAINTENANCE_MISSING");
			}
			const receipts = await Promise.all([
				firstMaintenance.reclaimClosedEpoch(fixture.input),
				secondMaintenance.reclaimClosedEpoch(fixture.input),
			]);
			expect(receipts.map(({ deletedGenerationIds }) => deletedGenerationIds.length).sort()).toEqual([0, 2]);
		} finally {
			await Promise.all([firstStore.close(), secondStore.close()]);
		}
	});

	it.skipIf(!state.ready)(
		"resolves only the exact strict facade and denies copy, proxy and memory facades",
		async () => {
			const candidate = await modules();
			const store = candidate.create({ filename: databaseFilename("identity") });
			let closed = false;
			try {
				expect(candidate.maintenance.resolveNodeAheReclamationMaintenance(store)).toBeDefined();
				expect(
					candidate.maintenance.resolveNodeAheReclamationMaintenance({ ...store } as AheDurableStore)
				).toBeUndefined();
				expect(candidate.maintenance.resolveNodeAheReclamationMaintenance(new Proxy(store, {}))).toBeUndefined();
				expect(candidate.maintenance.resolveNodeAheReclamationMaintenance({} as AheDurableStore)).toBeUndefined();
				const memory = createMemoryAheDurableStore();
				try {
					expect(candidate.maintenance.resolveNodeAheReclamationMaintenance(memory)).toBeUndefined();
				} finally {
					await memory.close();
				}
				const maintenance = candidate.maintenance.resolveNodeAheReclamationMaintenance(store);
				if (maintenance === undefined) throw new TypeError("D109C_NODE_MAINTENANCE_MISSING");
				const { input } = await fiveGenerationInput(store);
				await store.close();
				closed = true;
				const closedPromise = maintenance.reclaimClosedEpoch(input);
				expect(closedPromise).toBeInstanceOf(Promise);
				expect(await rejectedCode(() => closedPromise)).toBe("AHE_RECLAMATION_STORE_CLOSED");
				expect(await rejectedCode(() => maintenance.reclaimClosedEpoch({}))).toBe("AHE_RECLAMATION_INVALID_ARGUMENT");
			} finally {
				if (!closed) await store.close();
			}
		}
	);

	it.skipIf(!state.ready).each([...D109C_LINEAGE_MUTANTS, ...D109C_CORRUPTION_MUTANTS, ...D109C_COUNT_MUTANTS])(
		"refuses the frozen native mutant %s with zero committed deletion",
		async (mutant) => {
			const { filename, instrumentation, maintenance, store } = await opened(mutant);
			try {
				const { input } = await fiveGenerationInput(store);
				let request = mutableRequest(input);
				let code = "AHE_RECLAMATION_CORRUPT";
				if ((D109C_COUNT_MUTANTS as readonly string[]).includes(mutant)) {
					instrumentation.installNodeAheReclamationCountFault(store, countFault(mutant));
				} else {
					({ code, request } = applyLineageOrCorruptionMutant(filename, input, mutant));
				}
				const before = databaseImage(filename);
				expect(await rejectedCode(() => maintenance.reclaimClosedEpoch(request))).toBe(code);
				expect(databaseImage(filename)).toBe(before);
				const ordinary = await store.readHead(D109C_OBJECT);
				if (code === "AHE_RECLAMATION_CORRUPT") {
					expect(ordinary).toEqual({ ok: false, reason: "STORE_POISONED" });
				} else {
					expect(ordinary.ok).toBe(true);
				}
			} finally {
				await store.close();
			}
		}
	);

	it.skipIf(!state.ready).each(D109C_REFERENCE_CASES)("proves the frozen native reference case %s", async (caseId) => {
		const { filename, maintenance, store } = await opened(caseId);
		try {
			const fixture = await fiveGenerationInput(store, (index) =>
				caseId === "retained-shared-blob" && index === 3
					? Uint8Array.of(1, 2, 3)
					: Uint8Array.of(index, index + 1, index + 2)
			);
			const firstDigest = fixture.records.find(({ generationId }) => generationId === d109cGenerationId(1))?.closure[0]
				?.digest;
			const secondDigest = fixture.records.find(({ generationId }) => generationId === d109cGenerationId(2))?.closure[0]
				?.digest;
			if (firstDigest === undefined || secondDigest === undefined)
				throw new TypeError("D109C_REFERENCE_DIGEST_MISSING");
			if (caseId === "cross-object-shared-blob") {
				await addOtherGeneration(store, {
					closure: [{ byteLength: 3, digest: firstDigest }],
					complete: true,
					promote: [firstDigest],
				});
			} else if (caseId === "unrelated-orphan-retained") {
				const bytes = Uint8Array.of(240, 241, 242);
				const digest = successful(digestBlob(bytes), "ORPHAN_DIGEST");
				withDatabase(filename, (database) => {
					database.prepare("INSERT INTO blobs(digest,bytes) VALUES (?,?)").run(digest, bytes);
				});
			} else if (caseId === "staged-partial-promotions" || caseId === "discarded-partial-promotions") {
				await addOtherGeneration(store, {
					closure: [
						{ byteLength: 3, digest: firstDigest },
						{ byteLength: 3, digest: secondDigest },
					].sort((left, right) => left.digest.localeCompare(right.digest)),
					discard: caseId === "discarded-partial-promotions",
					promote: [firstDigest],
				});
			}
			const blobCountBefore = withDatabase(filename, (database) =>
				Number((database.prepare("SELECT COUNT(*) AS count FROM blobs").get() as { count: number }).count)
			);
			const receipt = await maintenance.reclaimClosedEpoch(fixture.input);
			expect(receipt.deletedGenerationIds).toEqual([d109cGenerationId(1), d109cGenerationId(2)]);
			if (
				caseId === "retained-shared-blob" ||
				caseId === "cross-object-shared-blob" ||
				caseId === "staged-partial-promotions" ||
				caseId === "discarded-partial-promotions"
			) {
				expect(blobBytes(filename, firstDigest)).toEqual(Uint8Array.of(1, 2, 3));
			} else if (caseId === "candidate-only-blob") {
				expect(blobBytes(filename, firstDigest)).toBeUndefined();
				expect(blobBytes(filename, secondDigest)).toBeUndefined();
			} else {
				const blobCountAfter = withDatabase(filename, (database) =>
					Number((database.prepare("SELECT COUNT(*) AS count FROM blobs").get() as { count: number }).count)
				);
				expect(blobCountAfter).toBe(blobCountBefore - 2);
			}
		} finally {
			await store.close();
		}
	});

	it.skipIf(!state.ready)("owns six genuine SIGKILL edges with old XOR complete-new reopen state", async () => {
		expect(D109C_CRASH_EDGES).toEqual([
			"after-floor-rewrite",
			"after-promotion-delete",
			"after-generation-delete",
			"after-blob-delete",
			"before-commit",
			"after-commit",
		]);
		for (const edge of D109C_CRASH_EDGES) {
			const filename = databaseFilename(`sigkill-${edge}`);
			await hardKillAt(filename, edge);
			const shape = reopenedShape(filename);
			expect(shape.integrity).toBe("ok");
			expect(shape.headGenerationId).toBe(d109cGenerationId(5));
			const old =
				shape.generationIds.length === 5 && !shape.floorNormalized && shape.promotions === 5 && shape.blobs === 5;
			const completeNew =
				shape.generationIds.join(",") ===
					d109cGenerationId(3) + "," + d109cGenerationId(4) + "," + d109cGenerationId(5) &&
				shape.floorNormalized &&
				shape.promotions === 3 &&
				shape.blobs === 3;
			expect(Number(old) + Number(completeNew)).toBe(1);
			expect(completeNew).toBe(edge === "after-commit");
		}
	});
});
