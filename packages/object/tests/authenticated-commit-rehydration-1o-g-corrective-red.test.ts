/**
 * Phase 1o-g corrective RED: commit credit belongs to the still-installed
 * applier. Rehydration must clear a displaced applier's credit on both its
 * normal and rejected-boundary exits, even when the replacement already has
 * the same committed hash.
 */
import { type ApplyResult, DrpType, Operation, type Vertex } from "@ts-drp/types";
import { DRP_VERTEX_FUTURE_TOLERANCE_MS } from "@ts-drp/validation";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
	CompactHistoryDRP,
	type CompactHistoryIdentity,
	compactHistoryIdentity,
	signedCompactHistory,
} from "./helpers/compact-history-observer-1i-b.js";
import { createACL } from "../src/acl/index.js";
import { createVertex } from "../src/hashgraph/index.js";
import { AdoptionCommitExhaustedError, DRPObject, readAuthenticatedClockPending } from "../src/index.js";

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

interface BoundaryControl {
	readonly entered: Deferred;
	readonly error: AdoptionCommitExhaustedError;
	readonly release: Deferred;
}

interface PrivateApplier {
	applyVertices(vertices: never[]): Promise<ApplyResult>;
}

interface CommittedProvenanceFacade {
	readCommittedProvenance(target: unknown): readonly string[];
}

interface BoundaryOutcome {
	readonly committed: Vertex;
	readonly error: AdoptionCommitExhaustedError;
	readonly pending: Vertex;
}

const boundaryControls = new Map<string, BoundaryControl>();
let author: CompactHistoryIdentity;
let readCommittedProvenance: (target: unknown) => readonly string[] = () => [];

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class RehydrationBoundaryDRP extends CompactHistoryDRP {
	async rejectAfterRelease(controlId: string): Promise<void> {
		const control = boundaryControls.get(controlId);
		if (control === undefined) throw new Error(`Missing boundary control ${controlId}`);
		control.entered.resolve();
		await control.release.promise;
		throw control.error;
	}
}

function replica(): DRPObject<RehydrationBoundaryDRP> {
	return new DRPObject({
		peerId: author.peerId,
		acl: createACL({ admins: [author.peerId] }),
		drp: new RehydrationBoundaryDRP(),
		config: {
			history_storage: "compact",
			log_config: { level: "silent" },
			replica_mode: "observer",
		},
	});
}

async function signedVertex(
	opType: "append" | "rejectAfterRelease",
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

async function loadCommittedReader(): Promise<void> {
	const moduleUrl = new URL("../src/committed-provenance.js", import.meta.url).href;
	try {
		const facade = (await import(/* @vite-ignore */ moduleUrl)) as Partial<CommittedProvenanceFacade>;
		if (typeof facade.readCommittedProvenance === "function") {
			readCommittedProvenance = facade.readCommittedProvenance;
		}
	} catch {
		// The corrective RED is frozen before the provenance registry exists.
		readCommittedProvenance = (): readonly string[] => [];
	}
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

beforeAll(async (): Promise<void> => {
	author = await compactHistoryIdentity("phase-1o-g-corrective-rehydration-author");
	await loadCommittedReader();
});

afterEach(() => {
	for (const control of boundaryControls.values()) control.release.resolve();
	boundaryControls.clear();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("Phase 1o-g displaced-applier authenticated commit provenance", () => {
	test("returns a fresh empty-stamped result when rehydration already contains the stale applier's hash", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const history = await signedCompactHistory(author, 100);
		const dependency = history.at(-1)?.hash;
		if (dependency === undefined) throw new Error("Expected complete compact history");

		const controlObject = replica();
		await controlObject.applyVertices([...history]);
		const controlVertex = await signedVertex("append", [108], dependency, 1_700_000_012_008);
		const controlResult = await controlObject.applyVertices([controlVertex]);
		expect
			.soft(
				readCommittedProvenance(controlResult),
				"positive control: an installed applier exposes its physical commit"
			)
			.toEqual([controlVertex.hash]);

		const compact = replica();
		await compact.applyVertices([...history]);
		const raced = await signedVertex("append", [109], dependency, 1_700_000_012_009);
		const oldApplier = (compact as unknown as { _applier: PrivateApplier })._applier;
		const originalApply = oldApplier.applyVertices.bind(oldApplier);
		const committed = deferred();
		const release = deferred();
		let displacedResult: ApplyResult | undefined;
		oldApplier.applyVertices = async (vertices): Promise<ApplyResult> => {
			displacedResult = await originalApply(vertices);
			committed.resolve();
			await release.promise;
			return displacedResult;
		};

		const inFlight = compact.applyVertices([raced]);
		await committed.promise;
		expect(compact.getVertex(raced.hash), "positive control: the old applier physically committed H").toBeDefined();
		await expect(compact.rehydrateHistory([...history, raced].reverse())).resolves.toEqual({
			historyStorage: "full",
			status: "complete",
		});
		expect(compact.getVertex(raced.hash), "replacement graph independently contains the same H").toBeDefined();
		release.resolve();
		const result = await inFlight;

		expect(displacedResult).toBeDefined();
		expect(result, "the whole displaced branch must receive a fresh identity").not.toBe(displacedResult);
		expect(result).toMatchObject({ applied: true, invalid: [], missing: [] });
		expect(readCommittedProvenance(result), "replacement presence cannot lend the old call commit credit").toEqual([]);
	});

	test("restamps the same escaping error and partial result empty while preserving clock-pending provenance", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const history = await signedCompactHistory(author, 200);
		const dependency = history.at(-1)?.hash;
		if (dependency === undefined) throw new Error("Expected complete compact history");

		const runBoundary = async (displace: boolean, suffix: string): Promise<BoundaryOutcome> => {
			const compact = replica();
			await compact.applyVertices([...history]);
			const now = Date.now();
			const committed = await signedVertex("append", [208], dependency, now);
			const pending = await signedVertex(
				"append",
				[209],
				committed.hash,
				now + DRP_VERTEX_FUTURE_TOLERANCE_MS + 10_000
			);
			const controlId = `thrown-${suffix}`;
			const poison = await signedVertex("rejectAfterRelease", [controlId], committed.hash, now + 1);
			const exactError = new AdoptionCommitExhaustedError(poison.hash, 3);
			const control = { entered: deferred(), error: exactError, release: deferred() };
			boundaryControls.set(controlId, control);

			const inFlight = compact.applyVertices([committed, pending, poison]);
			await control.entered.promise;
			expect(compact.getVertex(committed.hash), "earlier H was physically committed before rejection").toBeDefined();
			if (displace) {
				await expect(compact.rehydrateHistory([...history, committed].reverse())).resolves.toEqual({
					historyStorage: "full",
					status: "complete",
				});
				expect(compact.getVertex(committed.hash), "replacement also contains H before rejection escapes").toBeDefined();
			}
			control.release.resolve();
			const caught = await captureError(inFlight);
			expect(caught, "the object boundary rethrows the exact original error identity").toBe(exactError);
			expect(exactError.partialResult).toBeDefined();
			return { committed, error: exactError, pending };
		};

		const installed = await runBoundary(false, "installed");
		expect
			.soft(
				readCommittedProvenance(installed.error),
				"positive control: a still-installed rejected call owns its earlier commit"
			)
			.toEqual([installed.committed.hash]);
		expect.soft(readCommittedProvenance(installed.error.partialResult)).toEqual([installed.committed.hash]);
		expect(readAuthenticatedClockPending(installed.error)).toEqual([installed.pending.hash]);
		expect(readAuthenticatedClockPending(installed.error.partialResult)).toEqual([installed.pending.hash]);

		const displaced = await runBoundary(true, "displaced");
		expect(readCommittedProvenance(displaced.error), "a displaced error cannot retain old-applier credit").toEqual([]);
		expect(
			readCommittedProvenance(displaced.error.partialResult),
			"a displaced partial result cannot retain old-applier credit"
		).toEqual([]);
		expect(
			readAuthenticatedClockPending(displaced.error),
			"empty restamping preserves clock-pending provenance"
		).toEqual([displaced.pending.hash]);
		expect(readAuthenticatedClockPending(displaced.error.partialResult)).toEqual([displaced.pending.hash]);
	});
});
