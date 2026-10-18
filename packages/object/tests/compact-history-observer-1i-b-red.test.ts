import { Signature } from "@noble/secp256k1";
import { ACLGroup, type DRPObjectConfig, DrpType, Operation, type Vertex, Vertex as VertexCodec } from "@ts-drp/types";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createACL } from "../src/acl/index.js";
import { createVertex, HashGraph } from "../src/hashgraph/index.js";
import { authenticateVertices, DRPObject } from "../src/index.js";
import {
	cloneVertex,
	compactHistoryDigest,
	CompactHistoryDRP,
	type CompactHistoryIdentity,
	compactHistoryIdentity,
	compactHistoryReplica,
	signedCompactHistory,
} from "./helpers/compact-history-observer-1i-b.js";

let attacker: CompactHistoryIdentity;
let author: CompactHistoryIdentity;

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

interface RaceControl {
	entered: Deferred;
	release: Deferred;
}

const raceControls = new Map<string, RaceControl>();

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function raceControl(id: string): RaceControl {
	const control = { entered: deferred(), release: deferred() };
	raceControls.set(id, control);
	return control;
}

class RehydrationRaceDRP extends CompactHistoryDRP {
	async equalAfterRelease(controlId: string): Promise<void> {
		const control = raceControls.get(controlId);
		if (control === undefined) throw new Error(`Missing race control ${controlId}`);
		control.entered.resolve();
		await control.release.promise;
	}

	async appendBeforeRelease(controlId: string, value: number): Promise<void> {
		const control = raceControls.get(controlId);
		if (control === undefined) throw new Error(`Missing race control ${controlId}`);
		this.values.push(value);
		control.entered.resolve();
		await control.release.promise;
	}
}

beforeAll(async () => {
	[author, attacker] = await Promise.all([
		compactHistoryIdentity("phase-1i-b-object-author"),
		compactHistoryIdentity("phase-1i-b-object-attacker"),
	]);
});

afterEach(() => {
	raceControls.clear();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function payloadBytes(vertices: readonly Vertex[]): Uint8Array[] {
	return vertices.map((vertex) => VertexCodec.encode(vertex).finish());
}

function compactConfigWithoutObserver(historyStorage: string): DRPObjectConfig {
	return {
		history_storage: historyStorage,
		log_config: { level: "silent" },
	};
}

function rehydrationRaceReplica(): DRPObject<RehydrationRaceDRP> {
	return new DRPObject({
		peerId: author.peerId,
		acl: createACL({ admins: [author.peerId] }),
		drp: new RehydrationRaceDRP(),
		config: {
			history_storage: "compact",
			log_config: { level: "silent" },
			replica_mode: "observer",
		},
	});
}

async function signedRaceVertex(
	opType: "appendBeforeRelease" | "equalAfterRelease",
	value: unknown[],
	dependency: string,
	timestamp: number
): Promise<Vertex> {
	const vertex = createVertex(
		author.peerId,
		Operation.create({ drpType: DrpType.DRP, opType, value }),
		[dependency],
		timestamp
	);
	vertex.signature = await author.keychain.signWithSecp256k1(vertex.hash);
	return vertex;
}

describe("Phase 1i-b explicit compact-history capability", () => {
	it("rejects writer+compact, unknown storage and compact storage with an ambiguous omitted replica mode", () => {
		expect(() => compactHistoryReplica(author, "writer", "compact")).toThrow(/compact.*observer|observer.*compact/i);
		expect(
			() =>
				new DRPObject({
					peerId: author.peerId,
					config: compactConfigWithoutObserver("compact"),
				})
		).toThrow(/compact.*observer|observer.*compact|replica.*required/i);
		expect(
			() =>
				new DRPObject({
					peerId: author.peerId,
					config: {
						history_storage: "archive",
						log_config: { level: "silent" },
						replica_mode: "observer",
					} satisfies DRPObjectConfig,
				})
		).toThrow(/history.*storage|unsupported.*archive/i);
	});

	it("preserves omitted writer and full-history observer signed history and authorship", async () => {
		const writer = compactHistoryReplica(author, "writer");
		const fullObserver = compactHistoryReplica(author, "observer");
		const history = await signedCompactHistory(author);

		expect(history.every(({ signature }) => signature.length === 65)).toBe(true);
		expect(payloadBytes(authenticateVertices([...history]))).toEqual(payloadBytes(history));
		await expect(writer.applyVertices([...history])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		await expect(fullObserver.applyVertices([...history])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect(writer.replicaMode).toBe("writer");
		expect(fullObserver.replicaMode).toBe("observer");
		expect(payloadBytes(fullObserver.vertices)).toEqual(payloadBytes(writer.vertices));
		expect(
			compactHistoryDigest(
				fullObserver,
				fullObserver.vertices.map(({ hash }) => hash)
			)
		).toBe(
			compactHistoryDigest(
				writer,
				writer.vertices.map(({ hash }) => hash)
			)
		);
		for (const vertex of history) expect(fullObserver.getVertex(vertex.hash)).toEqual(vertex);

		expect(() => fullObserver.drp?.append(92)).not.toThrow();
		expect(() => writer.drp?.append(93)).not.toThrow();
		expect(fullObserver.vertices).toHaveLength(history.length + 2);
		expect(writer.vertices).toHaveLength(history.length + 2);
		expect(() => fullObserver.finalityStore).toThrow(/observer.*finality|finality.*observer/i);
		expect(() => writer.finalityStore).not.toThrow();
	});

	it("denies compact ACL/DRP authorship without silently changing replica mode", () => {
		const compact = compactHistoryReplica(author, "observer", "compact");
		expect.soft(compact.replicaMode).toBe("observer");
		expect.soft(compact.historyStorage).toBe("compact");

		expect.soft(() => compact.drp?.append(91)).toThrow(/compact.*author|author.*compact/i);
		expect
			.soft(() => compact.acl.grant("phase-1i-b-local-grant", ACLGroup.Writer))
			.toThrow(/compact.*author|author.*compact/i);
		expect(compact.vertices).toHaveLength(1);
		expect(compact.drp?.query_values()).toEqual([]);
	});

	it("separates canonical authenticated inventory from complete locally available payloads", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const history = await signedCompactHistory(author);
		const writer = compactHistoryReplica(author, "writer");
		const compact = compactHistoryReplica(author, "observer", "compact");
		await expect(writer.applyVertices([...history])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		await expect(compact.applyVertices([...history])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});

		expect.soft(compact.historyStorage, "missing explicit compact-history runtime capability").toBe("compact");
		const inventory = compact.historyInventory;
		expect.soft(inventory, "missing authenticated history inventory").toBeDefined();
		if (inventory === undefined) return;

		const writerHashes = writer.vertices.map(({ hash }) => hash);
		expect(inventory.knownHashes).toEqual(writerHashes);
		expect(new Set(inventory.knownHashes).size).toBe(inventory.knownHashes.length);
		expect(inventory.availablePayloadHashes).toEqual(compact.vertices.map(({ hash }) => hash));
		expect(inventory.availablePayloadHashes.every((hash: string) => inventory.knownHashes.includes(hash))).toBe(true);

		const prunedHashes = inventory.knownHashes.filter(
			(hash: string) => !inventory.availablePayloadHashes.includes(hash)
		);
		expect(prunedHashes.length, "fixture must cross an honest retention boundary").toBeGreaterThan(0);
		for (const vertex of compact.vertices) {
			const source = writer.getVertex(vertex.hash);
			if (source === undefined) throw new Error(`Writer lost complete payload ${vertex.hash}`);
			expect(VertexCodec.encode(vertex).finish()).toEqual(VertexCodec.encode(source).finish());
			if (vertex.hash !== HashGraph.rootHash) {
				expect(vertex.signature).toHaveLength(65);
				expect(vertex.operation).toBeDefined();
				expect(vertex.dependencies.length).toBeGreaterThan(0);
			}
		}

		const inventoryBeforeDuplicate = structuredClone(inventory);
		await expect(compact.applyVertices([...history].reverse())).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect(compact.historyInventory).toEqual(inventoryBeforeDuplicate);

		const prunedHash = prunedHashes[0];
		const availableHash = inventory.availablePayloadHashes.find((hash: string) => hash !== HashGraph.rootHash);
		if (prunedHash === undefined || availableHash === undefined)
			throw new Error("Expected pruned and available payloads");
		expect(compact.getVertex(prunedHash)).toBeUndefined();
		expect(compact.getVertexPayload(prunedHash)).toEqual({
			missingHashes: [prunedHash],
			status: "history-unavailable",
		});
		const available = compact.getVertexPayload(availableHash);
		expect(available.status).toBe("available");
		if (available.status === "available") {
			const writerVertex = writer.getVertex(availableHash);
			if (writerVertex === undefined) throw new Error(`Writer lost available payload ${availableHash}`);
			expect(VertexCodec.encode(available.vertex).finish()).toEqual(VertexCodec.encode(writerVertex).finish());
		}
		expect(compact.getVertexPayload("f".repeat(64))).toEqual({ hash: "f".repeat(64), status: "unknown" });
		expect(compact.readHistory([availableHash, prunedHash])).toEqual({
			missingHashes: [prunedHash],
			status: "history-unavailable",
		});
	});

	it("authenticates complete offers before inventory admission and admits a later correct same-hash offer", async () => {
		const compact = compactHistoryReplica(author, "observer", "compact");
		const valid = (await signedCompactHistory(author))[0];
		if (valid === undefined) throw new Error("Expected a signed positive-control vertex");

		const forged = cloneVertex(valid);
		forged.signature = await attacker.keychain.signWithSecp256k1(forged.hash);
		const malformed = cloneVertex(valid);
		malformed.timestamp++;
		const wrongAuthor = createVertex(
			attacker.peerId,
			Operation.create({ drpType: DrpType.DRP, opType: "append", value: [3] }),
			[HashGraph.rootHash],
			1_700_000_012_001
		);
		wrongAuthor.signature = await author.keychain.signWithSecp256k1(wrongAuthor.hash);
		const missingDependency = createVertex(
			author.peerId,
			Operation.create({ drpType: DrpType.DRP, opType: "append", value: [4] }),
			["e".repeat(64)],
			1_700_000_012_002
		);
		missingDependency.signature = await author.keychain.signWithSecp256k1(missingDependency.hash);
		const recoveries = vi.spyOn(Signature.prototype, "recoverPublicKey");

		for (const rejected of [forged, malformed, wrongAuthor]) {
			const result = await compact.applyVertices([rejected]);
			expect(result.applied).toBe(false);
			expect(result.invalid).toContain(rejected.hash);
			expect(compact.getVertex(rejected.hash)).toBeUndefined();
		}
		const missingResult = await compact.applyVertices([missingDependency]);
		expect(missingResult.applied).toBe(false);
		expect(missingResult.missing).toContain(missingDependency.hash);
		expect(compact.getVertex(missingDependency.hash)).toBeUndefined();
		expect(recoveries.mock.calls.length).toBeGreaterThanOrEqual(4);

		await expect(compact.applyVertices([valid])).resolves.toMatchObject({ applied: true, invalid: [], missing: [] });
		expect(compact.getVertex(valid.hash)).toEqual(valid);
		expect.soft(compact.historyInventory, "missing authenticated history inventory").toBeDefined();
		if (compact.historyInventory === undefined) return;
		expect(compact.historyInventory.knownHashes).toEqual([HashGraph.rootHash, valid.hash]);
		expect(compact.historyInventory.knownHashes).not.toContain(missingDependency.hash);
		expect(compact.drp?.query_values()).toEqual([1]);
	});
});

describe("Phase 1i-b atomic rehydration", () => {
	it("does not report or notify a value-equal stale-applier commit outside the installed rehydrated history", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const history = await signedCompactHistory(author);
		const compact = rehydrationRaceReplica();
		await expect(compact.applyVertices([...history])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		const dependency = history.at(-1)?.hash;
		if (dependency === undefined) throw new Error("Expected a complete compact-history fixture");

		const control = raceControl("value-equal-stale-applier");
		const raced = await signedRaceVertex(
			"equalAfterRelease",
			["value-equal-stale-applier"],
			dependency,
			1_700_000_011_008
		);
		const notifications: string[] = [];
		compact.subscribe((_object, _origin, vertices) => {
			notifications.push(...vertices.map(({ hash }) => hash));
		});

		const inFlightApply = compact.applyVertices([raced]);
		await control.entered.promise;
		await expect(
			compact.rehydrateHistory([...history].reverse()),
			"positive control: the value-equal in-flight operation must not weaken complete authenticated rehydration"
		).resolves.toEqual({ historyStorage: "full", status: "complete" });
		control.release.resolve();
		const applyResult = await inFlightApply;
		const readResult = compact.readHistory([raced.hash]);
		const installed =
			compact.historyInventory.knownHashes.includes(raced.hash) &&
			compact.historyInventory.availablePayloadHashes.includes(raced.hash) &&
			readResult.status === "available" &&
			readResult.vertices.some(({ hash }) => hash === raced.hash);

		expect(
			{
				appliedWithoutInstalledHistory: applyResult.applied && !installed,
				notifiedWithoutInstalledHistory: notifications.includes(raced.hash) && !installed,
			},
			"a stale applier must join the installed runtime or fail without publishing a ghost commit"
		).toEqual({
			appliedWithoutInstalledHistory: false,
			notifiedWithoutInstalledHistory: false,
		});
	});

	it("keeps a state-changing in-flight application and rehydration truthful", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const baseHistory = await signedCompactHistory(author);
		const baseDependency = baseHistory.at(-1)?.hash;
		if (baseDependency === undefined) throw new Error("Expected a complete compact-history fixture");
		const initialReplayControl = raceControl("state-changing-candidate-replay");
		initialReplayControl.release.resolve();
		const replayBarrier = await signedRaceVertex(
			"equalAfterRelease",
			["state-changing-candidate-replay"],
			baseDependency,
			1_700_000_011_008
		);
		const history = [...baseHistory, replayBarrier];
		const compact = rehydrationRaceReplica();
		await compact.applyVertices([...history]);
		const dependency = history.at(-1)?.hash;
		if (dependency === undefined) throw new Error("Expected a complete compact-history fixture");

		const control = raceControl("state-changing-rehydration");
		const raced = await signedRaceVertex(
			"appendBeforeRelease",
			["state-changing-rehydration", 808],
			dependency,
			1_700_000_011_009
		);
		const notifications: string[] = [];
		compact.subscribe((_object, _origin, vertices) => {
			notifications.push(...vertices.map(({ hash }) => hash));
		});

		const inFlightApply = compact.applyVertices([raced]);
		await control.entered.promise;
		const candidateReplay = raceControl("state-changing-candidate-replay");
		const inFlightRehydration = compact.rehydrateHistory([...history]);
		await candidateReplay.entered.promise;
		control.release.resolve();
		await expect(inFlightApply).resolves.toEqual({ applied: true, invalid: [], missing: [] });
		candidateReplay.release.resolve();
		await expect(
			inFlightRehydration,
			"a candidate that excludes an already-visible state change must not replace the installed runtime"
		).resolves.toMatchObject({ status: "rejected" });
		expect(compact.historyStorage).toBe("compact");
		expect(compact.historyInventory.knownHashes).toContain(raced.hash);
		expect(compact.readHistory([raced.hash])).toMatchObject({ status: "available" });
		expect(notifications).toContain(raced.hash);
		expect(compact.drp?.query_values()).toContain(808);
	});

	it("applies, inventories, serves and rehydrates a non-racing value-equal operation", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const history = await signedCompactHistory(author);
		const compact = rehydrationRaceReplica();
		await compact.applyVertices([...history]);
		const dependency = history.at(-1)?.hash;
		if (dependency === undefined) throw new Error("Expected a complete compact-history fixture");

		const control = raceControl("ordinary-value-equal");
		control.release.resolve();
		const ordinary = await signedRaceVertex(
			"equalAfterRelease",
			["ordinary-value-equal"],
			dependency,
			1_700_000_011_010
		);
		const notifications: string[] = [];
		compact.subscribe((_object, _origin, vertices) => {
			notifications.push(...vertices.map(({ hash }) => hash));
		});

		await expect(compact.applyVertices([ordinary])).resolves.toEqual({ applied: true, invalid: [], missing: [] });
		await control.entered.promise;
		expect(compact.historyInventory.knownHashes).toContain(ordinary.hash);
		expect(compact.readHistory([ordinary.hash])).toMatchObject({ status: "available" });
		expect(notifications).toContain(ordinary.hash);
		await expect(compact.rehydrateHistory([...history, ordinary].reverse())).resolves.toEqual({
			historyStorage: "full",
			status: "complete",
		});
		expect(compact.readHistory([ordinary.hash])).toMatchObject({ status: "available" });
	});

	it("rejects every incomplete or unauthenticated attempt without changing compact state", async () => {
		const attempts = [
			["partial", "incomplete"],
			["forged", "invalid"],
			["reordered-with-missing-dependencies", "incomplete"],
			["wrong-history", "wrong-history"],
			["interrupted", "interrupted"],
		] as const;
		for (const [attempt, reason] of attempts) {
			vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
			const history = await signedCompactHistory(author);
			const compact = compactHistoryReplica(author, "observer", "compact");
			await compact.applyVertices([...history]);
			expect.soft(compact.historyInventory, `${attempt}: missing authenticated history inventory`).toBeDefined();
			if (compact.historyInventory === undefined || typeof compact.rehydrateHistory !== "function") {
				expect.soft(typeof compact.rehydrateHistory, `${attempt}: missing atomic rehydration API`).toBe("function");
				continue;
			}

			let offered: Vertex[];
			let signal: AbortSignal | undefined;
			switch (attempt) {
				case "partial":
					offered = [...history.slice(1)];
					break;
				case "forged": {
					offered = history.map(cloneVertex);
					const target = offered[2];
					if (target === undefined) throw new Error("Expected forged rehydration target");
					target.signature = await attacker.keychain.signWithSecp256k1(target.hash);
					break;
				}
				case "reordered-with-missing-dependencies":
					offered = [...history].reverse().slice(0, -1);
					break;
				case "wrong-history":
					offered = [...(await signedCompactHistory(author, 100))];
					break;
				case "interrupted": {
					offered = [...history];
					const controller = new AbortController();
					controller.abort();
					signal = controller.signal;
					break;
				}
			}

			const before = {
				digest: compactHistoryDigest(compact, compact.historyInventory.knownHashes),
				historyInventory: structuredClone(compact.historyInventory),
				historyStorage: compact.historyStorage,
				payloads: payloadBytes(compact.vertices),
				replicaMode: compact.replicaMode,
			};
			const result = await compact.rehydrateHistory(offered, { signal });
			expect(result, attempt).toMatchObject({ reason, status: "rejected" });
			expect(
				{
					digest: compactHistoryDigest(compact, compact.historyInventory.knownHashes),
					historyInventory: compact.historyInventory,
					historyStorage: compact.historyStorage,
					payloads: payloadBytes(compact.vertices),
					replicaMode: compact.replicaMode,
				},
				attempt
			).toEqual(before);
		}
	});

	it("atomically restores full signed history and the existing full-observer capability", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const history = await signedCompactHistory(author);
		const writer = compactHistoryReplica(author, "writer");
		const compact = compactHistoryReplica(author, "observer", "compact");
		await writer.applyVertices([...history]);
		await compact.applyVertices([...history]);
		expect.soft(typeof compact.rehydrateHistory, "missing atomic rehydration API").toBe("function");
		if (typeof compact.rehydrateHistory !== "function") return;

		await expect(compact.rehydrateHistory([...history].reverse())).resolves.toEqual({
			historyStorage: "full",
			status: "complete",
		});
		expect(compact.replicaMode, "rehydration must not silently promote replica mode").toBe("observer");
		expect(compact.historyStorage).toBe("full");
		expect(compact.historyInventory.knownHashes).toEqual(writer.vertices.map(({ hash }) => hash));
		expect(compact.historyInventory.availablePayloadHashes).toEqual(compact.historyInventory.knownHashes);
		expect(payloadBytes(compact.vertices)).toEqual(payloadBytes(writer.vertices));
		expect(compactHistoryDigest(compact, compact.historyInventory.knownHashes)).toBe(
			compactHistoryDigest(
				writer,
				writer.vertices.map(({ hash }) => hash)
			)
		);
		for (const vertex of writer.vertices) {
			const result = compact.getVertexPayload(vertex.hash);
			expect(result.status).toBe("available");
			if (result.status === "available") {
				expect(VertexCodec.encode(result.vertex).finish()).toEqual(VertexCodec.encode(vertex).finish());
			}
		}
		expect(compact.readHistory(compact.historyInventory.knownHashes)).toEqual({
			status: "available",
			vertices: compact.vertices,
		});

		expect(() => compact.drp?.append(99)).not.toThrow();
		expect(compact.drp?.query_values()).toContain(99);
		expect(() => compact.finalityStore).toThrow(/observer.*finality|finality.*observer/i);
	});
});
