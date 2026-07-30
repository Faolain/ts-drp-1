/**
 * Gate-0 differential convergence harness.
 *
 * The default tier is deliberately small and biased toward tiny DAGs. Set
 * GATE0_DIFFERENTIAL_NIGHTLY=1 for the larger sweep. To add the pinned
 * 7f9e66a engine as a third oracle, build that revision in a temporary git
 * worktree and set TS_DRP_BASELINE_OBJECT_MODULE to the absolute path of its
 * packages/object/dist/src/index.js.
 */
import { MapDRP, SetDRP } from "@ts-drp/blueprints";
import { SeededRandom } from "@ts-drp/test-utils";
import { ACLGroup, DrpType, Operation, type Vertex } from "@ts-drp/types";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { createACL, createPermissionlessACL } from "../../src/acl/index.js";
import { createVertex, HashGraph } from "../../src/hashgraph/index.js";
import { DRPObject } from "../../src/index.js";

type DRPKind = "resolver-free-set" | "resolver-bearing-map";
type SuffixSize = "default" | 1 | 2 | 4;
type Topology =
	| "linear"
	| "fork"
	| "fork-join"
	| "diamond"
	| "nested-fork"
	| "multi-head"
	| "acl-fork-tail"
	| "acl-admin-authority-chain"
	| "acl-resolver-drop"
	| "acl-held-group-coupling"
	| "acl-same-group-descendant"
	| "acl-three-way-held-group"
	| "acl-admin-revoke-absent-group"
	| "acl-arriving-built-in-rejection"
	| "transitive-join-children"
	| "wide-fan-in-out";
type DeliveryMode = "singles" | "batches" | "mixed";
type VertexKind = "drp" | "acl";

interface VertexSpec {
	label: string;
	kind?: VertexKind;
	op: "add" | "delete" | "set" | "grant" | "revoke";
	args: unknown[];
	dependencies: string[];
	peerId: string;
	timestamp: number;
}

interface DeliverySchedule {
	name: string;
	batches: string[][];
}

interface ConvergenceCase {
	id: string;
	kind: DRPKind;
	topology: Topology;
	suffixSize: SuffixSize;
	approvedBaselineDivergence?: boolean;
	vertices: VertexSpec[];
	schedules: DeliverySchedule[];
	acl?: {
		admins: string[];
		permissionless?: boolean;
	};
	expectedFresh?: {
		state: string;
		order: string[];
	};
	resolverPair?: [string, string];
}

type XverCase = Omit<ConvergenceCase, "approvedBaselineDivergence">;

interface EngineModule {
	DRPObject: new (options: Record<string, unknown>) => EngineObject;
	createACL(options?: { admins?: string[] | string; permissionless?: boolean }): unknown;
	createPermissionlessACL(writers?: string | string[]): unknown;
	createVertex(
		peerId: string,
		operation: Operation,
		dependencies: string[],
		timestamp: number,
		signature?: Uint8Array
	): Vertex;
}

interface EngineObject {
	acl: {
		query_isAdmin(peerId: string): boolean;
		query_isWriter(peerId: string): boolean;
		query_getFinalitySigners(): Map<string, string>;
	};
	drp?: {
		query_getValues?(): unknown[];
		query_entries?(): [unknown, unknown][];
		add?(value: unknown): Promise<unknown>;
		set?(key: unknown, value: unknown): Promise<unknown>;
	};
	applyVertices(vertices: Vertex[]): Promise<{
		applied: boolean;
		missing: string[];
		invalid: unknown[];
		quarantined?: string[];
	}>;
	vertices: Vertex[];
}

type AdmissionStatus = "applied" | "missing" | "invalid" | "quarantined";

interface Outcome {
	name: string;
	state: string;
	aclState: string;
	order: string[];
	members: string[];
	admissions: Record<string, AdmissionStatus>;
	admissionOutcomes?: AdmissionOutcome[];
	rawOrder?: string[];
	rawMembers?: string[];
}

interface NormalizedApplyResult {
	applied?: boolean;
	missing: string[];
	invalid: string[];
	quarantined: string[];
}

interface AdmissionOutcome {
	batch: string[];
	completion: "returned" | "threw";
	result?: NormalizedApplyResult;
	partialResult?: NormalizedApplyResult;
}

interface EngineRun {
	replicas: Outcome[];
	fresh: Outcome;
}

interface CaseResult {
	current: EngineRun;
	baseline?: EngineRun;
	problems: Problem[];
}

type ProblemKind =
	| "replica-vs-replica"
	| "replica-vs-fresh-replay"
	| "replica-vs-baseline"
	| "fresh-replay-vs-baseline"
	| "fresh-replay-vs-fixed-canonical-oracle";

interface Problem {
	scope: "current-engine" | "baseline";
	kind: ProblemKind;
	left: string;
	right?: string;
	dimensions: OutcomeDimension[];
}

type OutcomeDimension = "drp-state" | "acl-state" | "linear-order" | "graph-membership" | "admission";

const PR_SEEDS = 12;
const PR_SCHEDULES = 3;
const NIGHTLY_SEEDS = 80;
const NIGHTLY_SCHEDULES = 10;
const SUFFIX_SIZES: SuffixSize[] = [1, 2, 4, "default"];
// Resolver-free is intentionally two thirds of the generated corpus.
const KIND_SWEEP: DRPKind[] = ["resolver-free-set", "resolver-free-set", "resolver-bearing-map"];
const TOPOLOGIES: Topology[] = ["linear", "fork", "fork-join", "diamond", "nested-fork", "multi-head"];
const WRITERS = ["writer-a", "writer-b", "writer-c", "writer-d"];
const MANY_WRITERS = Array.from({ length: 16 }, (_, index) => `writer-${String(index).padStart(2, "0")}`);
const AUTHORITY_TARGETS = ["eve-a", "eve-b", "eve-c"] as const;
const WIDENED_SLOTS = [
	"mixed-acl",
	"admin-authority-chain",
	"resolver-drop",
	"held-group-coupling",
	"same-group-descendant",
	"admin-revoke-absent-group",
	"arriving-built-in-rejection",
	"transitive-join-children",
	"many-writers",
] as const;
const ACL_GROUP_PAIRS = [
	[ACLGroup.Writer, ACLGroup.Admin],
	[ACLGroup.Finality, ACLGroup.Admin],
] as const;
const MIN_GENERATOR_PRECONDITION_RATE = 0.95;
const DEFAULT_SUFFIX = process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
const BASELINE_MODULE_PATH = process.env.TS_DRP_BASELINE_OBJECT_MODULE;
const XVER_ENABLED = process.env.TS_DRP_XVER === "1";
const XVER_REFERENCE_SHA = "1d40885ffb2ab666ffb2817a99fe69a42af83e77";
const XVER_SURFACES = [
	"drp-state",
	"acl-state",
	"admission",
	"engine-authored-vertex-hashes",
	"raw-hash-membership",
	"raw-hash-order",
] as const;
type XverSurface = (typeof XVER_SURFACES)[number];

const currentEngine: EngineModule = {
	DRPObject: DRPObject as unknown as EngineModule["DRPObject"],
	createACL,
	createPermissionlessACL,
	createVertex,
};

const PRIMARY_MODULE_PATH = process.env.TS_DRP_PRIMARY_OBJECT_MODULE;

let baselineEnginePromise: Promise<EngineModule | undefined> | undefined;
let primaryEnginePromise: Promise<EngineModule> | undefined;
let xverConfigPromise: Promise<XverConfig> | undefined;

interface XverDelta {
	fixtureId: string;
	schedule: string;
	surface: XverSurface;
	current: unknown;
	reference: unknown;
}

interface XverConfig {
	primary: EngineModule;
	reference: EngineModule;
	expectedComparisons: number;
	deltas: XverDelta[];
	primaryObjectModule?: string;
	referenceObjectModule: string;
	referenceRuntimeClosureSha256: string;
}

interface XverEngineRun {
	replicas: Outcome[];
	fresh: Outcome;
	authoredHashes: Map<string, EngineAuthoredHashes>;
}

interface EngineAuthoredHashes {
	"resolver-free-set": string[];
	"resolver-bearing-map": string[];
}

interface XverFixtureComparison {
	comparisons: number;
	exercised: Set<XverDelta>;
	unexpected: Set<XverSurface>;
	mapFixture: boolean;
}

function xverFailure(code: string, detail: string): never {
	throw new Error(`${code}: ${detail}`);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return JSON.stringify(actual) === JSON.stringify(expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inside(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function nearestPackageManifest(entry: string, worktree: string): string {
	let directory = dirname(entry);
	while (inside(worktree, directory)) {
		const manifest = resolve(directory, "package.json");
		if (existsSync(manifest)) return manifest;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return xverFailure("XVER_ORACLE_RUNTIME_CLOSURE", `${entry} has no package manifest inside oracle worktree`);
}

function runtimeFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.flatMap((entry) => {
			const path = resolve(directory, entry);
			return statSync(path).isDirectory() ? runtimeFiles(path) : [path];
		})
		.filter((path) => !path.endsWith(".map") && !path.endsWith(".tsbuildinfo"))
		.sort();
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function authenticateWorkspaceRuntimeClosure(objectModule: string, worktree: string): string {
	const checked = new Map<string, string>();
	const visit = (manifestPath: string): void => {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
		if (!isRecord(manifest) || !isRecord(manifest.dependencies)) return;
		const packageName = typeof manifest.name === "string" ? manifest.name : manifestPath;
		if (checked.has(packageName)) return;
		checked.set(packageName, manifestPath);
		for (const dependency of Object.keys(manifest.dependencies)) {
			if (!dependency.startsWith("@ts-drp/")) continue;
			let dependencyRoot: string;
			try {
				dependencyRoot = realpathSync(resolve(dirname(manifestPath), "node_modules", dependency));
			} catch (error) {
				return xverFailure(
					"XVER_ORACLE_RUNTIME_CLOSURE",
					`${dependency} did not resolve from ${packageName}: ${String(error)}`
				);
			}
			if (!inside(worktree, dependencyRoot)) {
				xverFailure("XVER_ORACLE_RUNTIME_CLOSURE", `${dependency} resolved outside oracle worktree: ${dependencyRoot}`);
			}
			visit(resolve(dependencyRoot, "package.json"));
		}
	};
	visit(nearestPackageManifest(objectModule, worktree));
	const digest = createHash("sha256");
	for (const [packageName, manifestPath] of [...checked].sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0
	)) {
		const packageRoot = dirname(manifestPath);
		const files = [manifestPath, ...runtimeFiles(resolve(packageRoot, "dist"))];
		for (const path of files) {
			const logicalPath = `${packageName}/${relative(packageRoot, path)}`;
			digest.update(logicalPath).update("\0").update(readFileSync(path)).update("\0");
		}
	}
	return digest.digest("hex");
}

function parseXverManifest(path: string): XverDelta[] {
	const manifest = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (
		!isRecord(manifest) ||
		!exactKeys(manifest, ["schemaVersion", "referenceSha", "deltas"]) ||
		manifest.schemaVersion !== "phase-0m-xver-delta-v1" ||
		manifest.referenceSha !== XVER_REFERENCE_SHA ||
		!Array.isArray(manifest.deltas)
	) {
		return xverFailure("XVER_DELTA_MANIFEST_SCHEMA", "expected the exact phase-0m-xver-delta-v1 manifest");
	}
	const surfaces = new Set<string>(XVER_SURFACES);
	const keys = new Set<string>();
	return manifest.deltas.map((entry, index) => {
		if (
			!isRecord(entry) ||
			!exactKeys(entry, ["fixtureId", "schedule", "surface", "current", "reference"]) ||
			typeof entry.fixtureId !== "string" ||
			typeof entry.schedule !== "string" ||
			typeof entry.surface !== "string" ||
			entry.fixtureId.includes("*") ||
			entry.schedule.includes("*") ||
			!surfaces.has(entry.surface)
		) {
			return xverFailure(
				"XVER_DELTA_MANIFEST_SCHEMA",
				`delta ${index} must be one exact (fixtureId,schedule,surface,current,reference) tuple`
			);
		}
		const key = `${entry.fixtureId}\u0000${entry.schedule}\u0000${entry.surface}`;
		if (keys.has(key)) return xverFailure("XVER_DELTA_MANIFEST_SCHEMA", `duplicate exact tuple ${key}`);
		keys.add(key);
		return entry as unknown as XverDelta;
	});
}

function validateEngineModule(module: unknown, path: string): EngineModule {
	const candidate = module as Partial<EngineModule>;
	if (!candidate.DRPObject || !candidate.createACL || !candidate.createPermissionlessACL || !candidate.createVertex) {
		return xverFailure(
			"XVER_ENGINE_SURFACE",
			`${path} does not export DRPObject + createACL + createPermissionlessACL + createVertex`
		);
	}
	return candidate as EngineModule;
}

async function loadXverConfig(): Promise<XverConfig> {
	const configuredSha = process.env.TS_DRP_XVER_ORACLE_SHA;
	const configuredWorktree = process.env.TS_DRP_XVER_ORACLE_WORKTREE;
	const configuredObjectModule = process.env.TS_DRP_XVER_ORACLE_OBJECT_MODULE;
	const expectedComparisonsValue = process.env.TS_DRP_XVER_EXPECTED_COMPARISONS;
	const manifestPath = process.env.TS_DRP_XVER_DELTA_MANIFEST;
	if (!configuredSha || !configuredWorktree || !configuredObjectModule || !expectedComparisonsValue || !manifestPath) {
		return xverFailure("XVER_ORACLE_REQUIRED", `exact oracle tuple required for ${XVER_REFERENCE_SHA}`);
	}
	if (configuredSha !== XVER_REFERENCE_SHA) {
		return xverFailure("XVER_ORACLE_SHA_MISMATCH", `configured=${configuredSha} expected=${XVER_REFERENCE_SHA}`);
	}
	const worktree = realpathSync(configuredWorktree);
	let actualSha: string;
	try {
		actualSha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: worktree,
			encoding: "utf8",
			timeout: 10_000,
		}).trim();
	} catch (error) {
		return xverFailure("XVER_ORACLE_WORKTREE_SHA_MISMATCH", `expected=${XVER_REFERENCE_SHA} actual=${String(error)}`);
	}
	if (actualSha !== XVER_REFERENCE_SHA) {
		return xverFailure("XVER_ORACLE_WORKTREE_SHA_MISMATCH", `expected=${XVER_REFERENCE_SHA} actual=${actualSha}`);
	}
	const objectModule = realpathSync(configuredObjectModule);
	if (!inside(worktree, objectModule)) {
		return xverFailure(
			"XVER_ORACLE_RUNTIME_CLOSURE",
			`object module resolved outside oracle worktree: ${objectModule}`
		);
	}
	const referenceRuntimeClosureSha256 = authenticateWorkspaceRuntimeClosure(objectModule, worktree);
	const expectedComparisons = Number(expectedComparisonsValue);
	if (!Number.isSafeInteger(expectedComparisons) || expectedComparisons <= 0) {
		return xverFailure("XVER_COMPARISON_COUNT_NONZERO", `expected=${expectedComparisonsValue}`);
	}
	const reference = validateEngineModule(
		await import(/* @vite-ignore */ pathToFileURL(objectModule).href),
		objectModule
	);
	const configuredPrimaryPath = process.env.TS_DRP_XVER_PRIMARY_OBJECT_MODULE;
	const primaryPath = configuredPrimaryPath ? realpathSync(configuredPrimaryPath) : undefined;
	const primary = primaryPath
		? validateEngineModule(await import(/* @vite-ignore */ pathToFileURL(primaryPath).href), primaryPath)
		: currentEngine;
	return {
		primary,
		reference,
		expectedComparisons,
		deltas: parseXverManifest(manifestPath),
		primaryObjectModule: primaryPath,
		referenceObjectModule: objectModule,
		referenceRuntimeClosureSha256,
	};
}

function xverConfig(): Promise<XverConfig> {
	xverConfigPromise ??= loadXverConfig();
	return xverConfigPromise;
}

function baselineEngine(): Promise<EngineModule | undefined> {
	if (!BASELINE_MODULE_PATH) return Promise.resolve(undefined);
	baselineEnginePromise ??= import(/* @vite-ignore */ pathToFileURL(BASELINE_MODULE_PATH).href).then(
		(module: unknown) => {
			const candidate = module as Partial<EngineModule>;
			if (!candidate.DRPObject || !candidate.createACL || !candidate.createPermissionlessACL) {
				throw new Error(
					`Baseline module does not export DRPObject + createACL + createPermissionlessACL: ${BASELINE_MODULE_PATH}`
				);
			}
			return candidate as EngineModule;
		}
	);
	return baselineEnginePromise;
}

function setSuffixSize(size: SuffixSize): void {
	if (size === "default") {
		if (DEFAULT_SUFFIX === undefined) delete process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE;
		else process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = DEFAULT_SUFFIX;
		return;
	}
	process.env.TS_DRP_CHECKPOINT_SUFFIX_SIZE = String(size);
}

function makeOperation(spec: VertexSpec): Operation {
	return Operation.create({
		drpType: spec.kind === "acl" ? DrpType.ACL : DrpType.DRP,
		opType: spec.op,
		value: spec.args,
	});
}

function materialize(specs: VertexSpec[]): { vertices: Vertex[]; byLabel: Map<string, Vertex> } {
	return materializeWithEngine(currentEngine, specs);
}

function materializeWithEngine(
	engine: EngineModule,
	specs: VertexSpec[]
): { vertices: Vertex[]; byLabel: Map<string, Vertex> } {
	const byLabel = new Map<string, Vertex>();
	const vertices = specs.map((spec) => {
		const dependencies =
			spec.dependencies.length === 0
				? [HashGraph.rootHash]
				: spec.dependencies.map((label) => {
						const dependency = byLabel.get(label);
						if (!dependency) throw new Error(`Fixture ${spec.label} precedes dependency ${label}`);
						return dependency.hash;
					});
		const vertex = engine.createVertex(spec.peerId, makeOperation(spec), dependencies, spec.timestamp);
		byLabel.set(spec.label, vertex);
		return vertex;
	});
	return { vertices, byLabel };
}

function makeObject(engine: EngineModule, fixture: ConvergenceCase, peerId: string): EngineObject {
	const drp = fixture.kind === "resolver-free-set" ? new SetDRP<unknown>() : new MapDRP<unknown, unknown>();
	const acl = fixture.acl
		? engine.createACL({
				admins: fixture.acl.admins,
				permissionless: fixture.acl.permissionless,
			})
		: engine.createPermissionlessACL(WRITERS);
	return new engine.DRPObject({
		peerId,
		id: "writer-a:gate-0-differential",
		acl,
		drp,
		config: { log_config: { level: "silent" } },
	});
}

function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, entry]) => [key, normalize(entry)])
		);
	}
	return value;
}

function stateOf(object: EngineObject, kind: DRPKind): string {
	if (kind === "resolver-free-set") {
		const values = object.drp?.query_getValues?.() ?? [];
		return JSON.stringify([...values].sort((left, right) => Number(left) - Number(right)).map(normalize));
	}
	const entries = object.drp?.query_entries?.() ?? [];
	return JSON.stringify(
		[...entries]
			.sort(([left], [right]) => (String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0))
			.map(([key, value]) => [normalize(key), normalize(value)])
	);
}

function observedPeers(fixture: ConvergenceCase): string[] {
	const peers = new Set<string>([...WRITERS, ...(fixture.acl?.admins ?? [])]);
	for (const vertex of fixture.vertices) {
		peers.add(vertex.peerId);
		if (vertex.kind === "acl" && typeof vertex.args[0] === "string") peers.add(vertex.args[0]);
	}
	return [...peers].sort();
}

function aclStateOf(object: EngineObject, fixture: ConvergenceCase): string {
	const peers = observedPeers(fixture);
	const finalitySigners = [...object.acl.query_getFinalitySigners()]
		.map(([peerId, key]) => [peerId, key] as const)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return JSON.stringify({
		admins: peers.filter((peerId) => object.acl.query_isAdmin(peerId)),
		writers: peers.filter((peerId) => object.acl.query_isWriter(peerId)),
		finalitySigners,
	});
}

function orderOf(object: EngineObject, labelsByHash: Map<string, string>): string[] {
	const graph = (object as unknown as { hashGraph: HashGraph }).hashGraph;
	return graph
		.linearizeVertices()
		.filter((vertex) => vertex.hash !== HashGraph.rootHash)
		.map((vertex) => labelsByHash.get(vertex.hash) ?? vertex.hash);
}

function membersOf(object: EngineObject, labelsByHash: Map<string, string>): string[] {
	return object.vertices
		.map((vertex) => labelsByHash.get(vertex.hash))
		.filter((label): label is string => label !== undefined)
		.sort();
}

function rawOrderOf(object: EngineObject): string[] {
	const graph = (object as unknown as { hashGraph: HashGraph }).hashGraph;
	return graph
		.linearizeVertices()
		.filter((vertex) => vertex.hash !== HashGraph.rootHash)
		.map((vertex) => vertex.hash);
}

function rawMembersOf(object: EngineObject): string[] {
	return object.vertices
		.map((vertex) => vertex.hash)
		.filter((hash) => hash !== HashGraph.rootHash)
		.sort();
}

function admissionLabel(value: unknown, labelsByHash: Map<string, string>): string {
	const raw =
		typeof value === "string"
			? value
			: isRecord(value) && typeof value.hash === "string"
				? value.hash
				: JSON.stringify(normalize(value));
	return labelsByHash.get(raw) ?? raw;
}

function normalizeApplyResult(
	result:
		| {
				applied: boolean;
				missing: string[];
				invalid: unknown[];
				quarantined?: string[];
		  }
		| undefined,
	labelsByHash: Map<string, string>
): NormalizedApplyResult | undefined {
	if (!result) return undefined;
	return {
		applied: result.applied,
		missing: result.missing.map((value) => admissionLabel(value, labelsByHash)).sort(),
		invalid: result.invalid.map((value) => admissionLabel(value, labelsByHash)).sort(),
		quarantined: (result.quarantined ?? []).map((value) => admissionLabel(value, labelsByHash)).sort(),
	};
}

async function applySchedule(
	engine: EngineModule,
	fixture: ConvergenceCase,
	schedule: DeliverySchedule,
	byLabel: Map<string, Vertex>,
	labelsByHash: Map<string, string>,
	includeRawHashes = false
): Promise<Outcome> {
	const object = makeObject(engine, fixture, `replica-${schedule.name}`);
	const admissions: Record<string, AdmissionStatus> = {};
	const admissionOutcomes: AdmissionOutcome[] = [];
	for (const labels of schedule.batches) {
		const batch = labels.map((label) => {
			const vertex = byLabel.get(label);
			if (!vertex) throw new Error(`Schedule ${schedule.name} references unknown vertex ${label}`);
			return vertex;
		});
		let result:
			| {
					applied: boolean;
					missing: string[];
					invalid: unknown[];
					quarantined?: string[];
			  }
			| undefined;
		let rejected = false;
		let partialResult: typeof result;
		try {
			result = await object.applyVertices(batch);
		} catch (error) {
			rejected = true;
			partialResult = (error as { partialResult?: typeof result }).partialResult;
			result = partialResult;
		}
		admissionOutcomes.push({
			batch: [...labels],
			completion: rejected ? "threw" : "returned",
			...(rejected
				? { partialResult: normalizeApplyResult(partialResult, labelsByHash) }
				: { result: normalizeApplyResult(result, labelsByHash) }),
		});
		const missing = new Set((result?.missing ?? []).map(String));
		const invalid = new Set((result?.invalid ?? []).map(String));
		const quarantined = new Set((result?.quarantined ?? []).map(String));
		const members = new Set(object.vertices.map((vertex) => vertex.hash));
		for (const [index, vertex] of batch.entries()) {
			const label = labels[index];
			if (invalid.has(vertex.hash)) admissions[label] = "invalid";
			else if (quarantined.has(vertex.hash) || (rejected && !members.has(vertex.hash))) {
				admissions[label] = "quarantined";
			} else if (missing.has(vertex.hash) || !members.has(vertex.hash)) {
				admissions[label] = "missing";
			} else {
				admissions[label] = "applied";
			}
		}
	}
	const members = new Set(object.vertices.map((vertex) => vertex.hash));
	for (const vertex of fixture.vertices) {
		if (admissions[vertex.label] !== undefined) continue;
		const materialized = byLabel.get(vertex.label);
		admissions[vertex.label] = materialized && members.has(materialized.hash) ? "applied" : "missing";
	}
	return {
		name: schedule.name,
		state: stateOf(object, fixture.kind),
		aclState: aclStateOf(object, fixture),
		order: orderOf(object, labelsByHash),
		members: membersOf(object, labelsByHash),
		admissions: Object.fromEntries(
			Object.entries(admissions).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		),
		...(includeRawHashes ? { admissionOutcomes } : {}),
		...(includeRawHashes
			? {
					rawOrder: rawOrderOf(object),
					rawMembers: rawMembersOf(object),
				}
			: {}),
	};
}

async function runEngine(engine: EngineModule, fixture: ConvergenceCase): Promise<EngineRun> {
	setSuffixSize(fixture.suffixSize);
	const { vertices, byLabel } = materialize(fixture.vertices);
	const labelsByHash = new Map([...byLabel].map(([label, vertex]) => [vertex.hash, label]));
	const replicas: Outcome[] = [];
	for (const schedule of fixture.schedules) {
		replicas.push(await applySchedule(engine, fixture, schedule, byLabel, labelsByHash));
	}

	const fresh = await applySchedule(
		engine,
		fixture,
		{ name: "fresh-replay", batches: [vertices.map((vertex) => labelsByHash.get(vertex.hash) ?? vertex.hash)] },
		byLabel,
		labelsByHash
	);
	return {
		replicas,
		fresh,
	};
}

async function authorLocalHashLeg(
	engine: EngineModule,
	fixture: XverCase,
	schedule: DeliverySchedule,
	kind: DRPKind
): Promise<string[]> {
	const localFixture = { ...fixture, kind };
	const object = makeObject(engine, localFixture, fixture.acl?.admins[0] ?? "writer-a");
	const originalNow = Date.now;
	Date.now = (): number => 1_730_000_000_000;
	try {
		const value = `xver:${fixture.id}:${schedule.name}`;
		if (kind === "resolver-free-set") {
			const add = object.drp?.add;
			if (!add) {
				return xverFailure("XVER_ENGINE_LOCAL_AUTHORING", `${fixture.id}/${schedule.name}/${kind} has no add method`);
			}
			await add.call(object.drp, value);
		} else {
			const set = object.drp?.set;
			if (!set) {
				return xverFailure("XVER_ENGINE_LOCAL_AUTHORING", `${fixture.id}/${schedule.name}/${kind} has no set method`);
			}
			await set.call(object.drp, `${value}:key`, `${value}:value`);
		}
	} finally {
		Date.now = originalNow;
	}
	const hashes = object.vertices.map((vertex) => vertex.hash).filter((hash) => hash !== HashGraph.rootHash);
	if (hashes.length === 0) {
		return xverFailure("XVER_ENGINE_LOCAL_AUTHORING", `${fixture.id}/${schedule.name} authored zero vertices`);
	}
	return hashes;
}

async function authorLocalHashes(
	engine: EngineModule,
	fixture: XverCase,
	schedule: DeliverySchedule
): Promise<EngineAuthoredHashes> {
	return {
		"resolver-free-set": await authorLocalHashLeg(engine, fixture, schedule, "resolver-free-set"),
		"resolver-bearing-map": await authorLocalHashLeg(engine, fixture, schedule, "resolver-bearing-map"),
	};
}

async function runXverEngine(engine: EngineModule, fixture: XverCase): Promise<XverEngineRun> {
	setSuffixSize(fixture.suffixSize);
	const { vertices, byLabel } = materializeWithEngine(engine, fixture.vertices);
	const labelsByHash = new Map([...byLabel].map(([label, vertex]) => [vertex.hash, label]));
	const replicas: Outcome[] = [];
	const authoredHashes = new Map<string, EngineAuthoredHashes>();
	for (const schedule of fixture.schedules) {
		replicas.push(await applySchedule(engine, fixture, schedule, byLabel, labelsByHash, true));
		authoredHashes.set(schedule.name, await authorLocalHashes(engine, fixture, schedule));
	}
	const fresh = await applySchedule(
		engine,
		fixture,
		{ name: "fresh-replay", batches: [vertices.map((vertex) => labelsByHash.get(vertex.hash) ?? vertex.hash)] },
		byLabel,
		labelsByHash,
		true
	);
	return { replicas, fresh, authoredHashes };
}

function xverSurfaceValue(run: XverEngineRun, scheduleIndex: number, surface: XverSurface): unknown {
	const replica = run.replicas[scheduleIndex];
	switch (surface) {
		case "drp-state":
			return { live: replica.state, canonical: run.fresh.state };
		case "acl-state":
			return { live: replica.aclState, canonical: run.fresh.aclState };
		case "admission":
			return {
				live: { vertices: replica.admissions, outcomes: replica.admissionOutcomes },
				canonical: { vertices: run.fresh.admissions, outcomes: run.fresh.admissionOutcomes },
			};
		case "engine-authored-vertex-hashes":
			return run.authoredHashes.get(replica.name);
		case "raw-hash-membership":
			return replica.rawMembers;
		case "raw-hash-order":
			return replica.rawOrder;
	}
}

function sameXverValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

async function compareXverFixture(config: XverConfig, fixture: XverCase): Promise<XverFixtureComparison> {
	const primary = await runXverEngine(config.primary, fixture);
	const reference = await runXverEngine(config.reference, fixture);
	const exercised = new Set<XverDelta>();
	const unexpected = new Set<XverSurface>();
	let comparisons = 0;
	for (let scheduleIndex = 0; scheduleIndex < fixture.schedules.length; scheduleIndex++) {
		const schedule = fixture.schedules[scheduleIndex];
		for (const surface of XVER_SURFACES) {
			comparisons++;
			const currentValue = xverSurfaceValue(primary, scheduleIndex, surface);
			const referenceValue = xverSurfaceValue(reference, scheduleIndex, surface);
			if (sameXverValue(currentValue, referenceValue)) continue;
			const delta = config.deltas.find(
				(entry) => entry.fixtureId === fixture.id && entry.schedule === schedule.name && entry.surface === surface
			);
			if (delta && sameXverValue(delta.current, currentValue) && sameXverValue(delta.reference, referenceValue)) {
				exercised.add(delta);
			} else {
				unexpected.add(surface);
			}
		}
	}
	return {
		comparisons,
		exercised,
		unexpected,
		mapFixture: [...primary.authoredHashes.values()].every((hashes) => hashes["resolver-bearing-map"].length > 0),
	};
}

function mergeXverComparisons(results: XverFixtureComparison[]): XverFixtureComparison {
	return {
		comparisons: results.reduce((total, result) => total + result.comparisons, 0),
		exercised: new Set(results.flatMap((result) => [...result.exercised])),
		unexpected: new Set(results.flatMap((result) => [...result.unexpected])),
		mapFixture: results.every((result) => result.mapFixture),
	};
}

function assertXverComparison(
	config: XverConfig,
	fixtures: XverCase[],
	results: XverFixtureComparison[]
): XverFixtureComparison {
	const combined = mergeXverComparisons(results);
	const divergentFixtures = fixtures.filter((_, index) => results[index].unexpected.size > 0);
	const mapFixtures = fixtures.filter((_, index) => results[index].mapFixture).map((fixture) => fixture.id);
	if (combined.unexpected.size > 0) {
		xverFailure(
			"XVER_DELTA",
			`fixtures=${divergentFixtures.map((fixture) => fixture.id).join(",")} differs on ` +
				`${XVER_SURFACES.filter((surface) => combined.unexpected.has(surface)).join(",")} ` +
				`localKinds=resolver-free-set,resolver-bearing-map mapFixtures=${mapFixtures.length} ` +
				`comparisons=${combined.comparisons}`
		);
	}
	if (combined.comparisons !== config.expectedComparisons) {
		xverFailure("XVER_COMPARISON_COUNT", `expected=${config.expectedComparisons} actual=${combined.comparisons}`);
	}
	const stale = config.deltas.filter((entry) => !combined.exercised.has(entry));
	if (stale.length > 0) {
		xverFailure(
			"XVER_STALE_DELTA",
			`count=${stale.length} comparisons=${combined.comparisons} ` +
				stale.map((entry) => `${entry.fixtureId}/${entry.schedule}/${entry.surface}`).join(",")
		);
	}
	return combined;
}

function requiredXverEvidence(name: string): string {
	const value = process.env[name];
	if (!value) return xverFailure("XVER_ACCEPTANCE_PROVENANCE", `${name} is required`);
	return value;
}

function authenticateAcceptanceEvidence(config: XverConfig): {
	primarySha: string;
	primaryArtifactSha256: string;
	referenceArtifactSha256: string;
	referenceRuntimeClosureSha256: string;
} {
	const primarySha = requiredXverEvidence("TS_DRP_XVER_PRIMARY_SHA");
	const primaryWorktree = realpathSync(requiredXverEvidence("TS_DRP_XVER_PRIMARY_WORKTREE"));
	const primaryArtifactSha256 = requiredXverEvidence("TS_DRP_XVER_PRIMARY_ARTIFACT_SHA256");
	const referenceArtifactSha256 = requiredXverEvidence("TS_DRP_XVER_REFERENCE_ARTIFACT_SHA256");
	const referenceRuntimeClosureSha256 = requiredXverEvidence("TS_DRP_XVER_REFERENCE_RUNTIME_CLOSURE_SHA256");
	const primaryRuntimeClosureSha256 = requiredXverEvidence("TS_DRP_XVER_PRIMARY_RUNTIME_CLOSURE_SHA256");
	if (!config.primaryObjectModule || !inside(primaryWorktree, config.primaryObjectModule)) {
		return xverFailure(
			"XVER_ACCEPTANCE_PROVENANCE",
			`primary object module is not inside primary worktree: ${String(config.primaryObjectModule)}`
		);
	}
	const actualPrimarySha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: primaryWorktree,
		encoding: "utf8",
		timeout: 10_000,
	}).trim();
	if (actualPrimarySha !== primarySha) {
		return xverFailure("XVER_ACCEPTANCE_PROVENANCE", `primary SHA expected=${primarySha} actual=${actualPrimarySha}`);
	}
	const actualPrimaryArtifact = sha256File(config.primaryObjectModule);
	const actualReferenceArtifact = sha256File(config.referenceObjectModule);
	const actualPrimaryClosure = authenticateWorkspaceRuntimeClosure(config.primaryObjectModule, primaryWorktree);
	if (
		actualPrimaryArtifact !== primaryArtifactSha256 ||
		actualReferenceArtifact !== referenceArtifactSha256 ||
		actualPrimaryClosure !== primaryRuntimeClosureSha256 ||
		config.referenceRuntimeClosureSha256 !== referenceRuntimeClosureSha256
	) {
		return xverFailure("XVER_ACCEPTANCE_PROVENANCE", "runner evidence does not match the loaded artifact closure");
	}
	return {
		primarySha,
		primaryArtifactSha256,
		referenceArtifactSha256,
		referenceRuntimeClosureSha256,
	};
}

async function expectXverConverged(fixture: XverCase): Promise<void> {
	const config = await xverConfig();
	const result = await compareXverFixture(config, fixture);
	assertXverComparison(config, [fixture], [result]);
}

function sameOutcome(left: Outcome, right: Outcome): boolean {
	return differingDimensions(left, right).length === 0;
}

function differingDimensions(left: Outcome, right: Outcome): OutcomeDimension[] {
	const dimensions: OutcomeDimension[] = [];
	if (left.state !== right.state) dimensions.push("drp-state");
	if (left.aclState !== right.aclState) dimensions.push("acl-state");
	if (JSON.stringify(left.order) !== JSON.stringify(right.order)) dimensions.push("linear-order");
	if (JSON.stringify(left.members) !== JSON.stringify(right.members)) dimensions.push("graph-membership");
	if (JSON.stringify(left.admissions) !== JSON.stringify(right.admissions)) dimensions.push("admission");
	return dimensions;
}

function collectProblems(current: EngineRun, baseline?: EngineRun): Problem[] {
	const problems: Problem[] = [];
	const first = current.replicas[0];
	for (const replica of current.replicas.slice(1)) {
		if (!sameOutcome(first, replica)) {
			problems.push({
				scope: "current-engine",
				kind: "replica-vs-replica",
				left: first.name,
				right: replica.name,
				dimensions: differingDimensions(first, replica),
			});
		}
	}
	for (const replica of current.replicas) {
		if (!sameOutcome(replica, current.fresh)) {
			problems.push({
				scope: "current-engine",
				kind: "replica-vs-fresh-replay",
				left: replica.name,
				right: "fresh-replay",
				dimensions: differingDimensions(replica, current.fresh),
			});
		}
	}
	if (baseline) {
		for (let index = 0; index < current.replicas.length; index++) {
			if (!sameOutcome(current.replicas[index], baseline.replicas[index])) {
				problems.push({
					scope: "baseline",
					kind: "replica-vs-baseline",
					left: current.replicas[index].name,
					right: baseline.replicas[index].name,
					dimensions: differingDimensions(current.replicas[index], baseline.replicas[index]),
				});
			}
		}
		if (!sameOutcome(current.fresh, baseline.fresh)) {
			problems.push({
				scope: "baseline",
				kind: "fresh-replay-vs-baseline",
				left: current.fresh.name,
				right: baseline.fresh.name,
				dimensions: differingDimensions(current.fresh, baseline.fresh),
			});
		}
	}
	return problems;
}

/**
 * Self-validation hook: point the PRIMARY engine at a pinned build to prove the
 * gate is measuring a regression rather than a pre-existing defect.
 *
 * A fixture that fails with the primary engine set to `7f9e66a` is not a
 * regression pin — it is measuring behaviour that was already broken at
 * baseline, and must be relabelled as pre-existing rather than counted against
 * the current tree. Without this, "the harness fails on the current tree" is
 * not evidence on its own.
 * @returns The configured primary engine, or the current engine by default.
 */
async function primaryEngine(): Promise<EngineModule> {
	if (!PRIMARY_MODULE_PATH) return currentEngine;
	primaryEnginePromise ??= import(/* @vite-ignore */ pathToFileURL(PRIMARY_MODULE_PATH).href).then(
		(module: unknown) => {
			const candidate = module as Partial<EngineModule>;
			if (!candidate.DRPObject || !candidate.createACL || !candidate.createPermissionlessACL) {
				throw new Error(`Primary module does not export the engine surface: ${PRIMARY_MODULE_PATH}`);
			}
			return candidate as EngineModule;
		}
	);
	return primaryEnginePromise;
}

async function evaluate(fixture: ConvergenceCase): Promise<CaseResult> {
	if (XVER_ENABLED) {
		return xverFailure("XVER_INTERNAL_BYPASS", `${fixture.id} reached the ordinary Gate-0 evaluator`);
	}
	const current = await runEngine(await primaryEngine(), fixture);
	const pinned = PRIMARY_MODULE_PATH ? undefined : await baselineEngine();
	const baseline = pinned ? await runEngine(pinned, fixture) : undefined;
	const problems = collectProblems(current, baseline);
	if (
		fixture.expectedFresh &&
		(current.fresh.state !== fixture.expectedFresh.state ||
			JSON.stringify(current.fresh.order) !== JSON.stringify(fixture.expectedFresh.order))
	) {
		problems.push({
			scope: "current-engine",
			kind: "fresh-replay-vs-fixed-canonical-oracle",
			left: current.fresh.name,
			right: "fixed-canonical-oracle",
			dimensions: [
				...(current.fresh.state !== fixture.expectedFresh.state ? (["drp-state"] as const) : []),
				...(JSON.stringify(current.fresh.order) !== JSON.stringify(fixture.expectedFresh.order)
					? (["linear-order"] as const)
					: []),
			],
		});
	}
	return { current, baseline, problems };
}

function randomTopologicalOrder(vertices: VertexSpec[], random: SeededRandom): string[] {
	const remaining = new Map(vertices.map((vertex) => [vertex.label, vertex]));
	const delivered = new Set<string>();
	const order: string[] = [];
	while (remaining.size > 0) {
		const ready = [...remaining.values()].filter((vertex) =>
			vertex.dependencies.every((dependency) => delivered.has(dependency))
		);
		if (ready.length === 0) throw new Error("Generated graph is cyclic");
		const next = random.pick(ready);
		order.push(next.label);
		delivered.add(next.label);
		remaining.delete(next.label);
	}
	return order;
}

function batchOrder(order: string[], mode: DeliveryMode, random: SeededRandom): string[][] {
	if (mode === "singles") return order.map((label) => [label]);
	if (mode === "batches") {
		const batches: string[][] = [];
		for (let index = 0; index < order.length; ) {
			const size = Math.min(order.length - index, random.intBetween(2, 4));
			batches.push(order.slice(index, index + size));
			index += size;
		}
		return batches;
	}
	const batches: string[][] = [];
	for (let index = 0; index < order.length; ) {
		const size = Math.min(order.length - index, random.chance(0.6) ? 1 : random.intBetween(2, 3));
		batches.push(order.slice(index, index + size));
		index += size;
	}
	return batches;
}

function makeSchedules(vertices: VertexSpec[], seed: number, count: number): DeliverySchedule[] {
	const modes: DeliveryMode[] = ["singles", "batches", "mixed"];
	return Array.from({ length: count }, (_, index) => {
		const random = new SeededRandom(seed * 10_007 + index * 997 + 17);
		const mode = modes[index % modes.length];
		// The first replica uses creation order as singles. Besides being the
		// easiest schedule to read, this deliberately exercises "root head,
		// concurrent root head, then a child of the first" adoption.
		const order = index === 0 ? vertices.map((vertex) => vertex.label) : randomTopologicalOrder(vertices, random);
		return {
			name: `${mode}-${index}`,
			batches: batchOrder(order, mode, random),
		};
	});
}

function dependenciesFor(topology: Topology, count: number): string[][] {
	const labels = Array.from({ length: count }, (_, index) => `V${index}`);
	switch (topology) {
		case "linear":
			return labels.map((_, index) => (index === 0 ? [] : [labels[index - 1]]));
		case "fork":
			return labels.map((_, index) => {
				if (index < 2) return [];
				return [labels[index % 2]];
			});
		case "fork-join":
			return labels.map((_, index) => {
				if (index < 2) return [];
				if (index === 2) return [labels[0]];
				if (index === 3) return [labels[1], labels[2]];
				return [labels[index - 1]];
			});
		case "diamond":
			return labels.map((_, index) => {
				if (index === 0) return [];
				if (index < 3) return [labels[0]];
				if (index === 3) return [labels[1], labels[2]];
				return [labels[index - 1]];
			});
		case "nested-fork":
			return labels.map((_, index) => {
				if (index === 0) return [];
				if (index === 1 || index === 2) return [labels[0]];
				if (index === 3) return [labels[1]];
				if (index === 4) return [labels[3]];
				if (index === 5) return [labels[2], labels[4]];
				return [labels[index - 1]];
			});
		case "multi-head":
			return labels.map((_, index) => {
				if (index < Math.min(4, count - 1)) return [];
				if (index === count - 1 && count > 4) return labels.slice(0, Math.min(4, count - 1));
				return [labels[index - 1]];
			});
		default:
			// The widened topologies (`acl-fork-tail`, `transitive-join-children`,
			// `wide-fan-in-out`) build their dependency sets in their own generators,
			// because they need cross-type vertices and redundant edges that this
			// label-only builder cannot express. They are never in `TOPOLOGIES`.
			throw new Error(`dependenciesFor does not build the widened topology ${topology}`);
	}
}

function vertexCount(topology: Topology, seed: number): number {
	const tiny = seed % 5 !== 4;
	if (topology === "linear" || topology === "fork") return tiny ? 3 + (seed % 2) : 7 + (seed % 4);
	if (topology === "fork-join" || topology === "diamond") return tiny ? 4 : 8 + (seed % 4);
	if (topology === "nested-fork") return tiny ? 6 : 10 + (seed % 5);
	return tiny ? 5 : 9 + (seed % 5);
}

function areConcurrent(left: number, right: number, dependencies: string[][]): boolean {
	const labels = dependencies.map((_, index) => `V${index}`);
	const reaches = (from: number, target: number): boolean => {
		const stack = [...dependencies[from]];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const next = stack.pop();
			if (next === undefined) continue;
			if (next === labels[target]) return true;
			if (seen.has(next)) continue;
			seen.add(next);
			const index = labels.indexOf(next);
			if (index >= 0) stack.push(...dependencies[index]);
		}
		return false;
	};
	return !reaches(left, right) && !reaches(right, left);
}

function conflictingPair(dependencies: string[][]): [number, number] {
	for (let left = 0; left < dependencies.length; left++) {
		for (let right = left + 1; right < dependencies.length; right++) {
			if (areConcurrent(left, right, dependencies)) return [left, right];
		}
	}
	return [0, Math.min(1, dependencies.length - 1)];
}

function dependsOn(index: number, ancestor: number, dependencies: string[][]): boolean {
	const target = `V${ancestor}`;
	const stack = [...dependencies[index]];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const next = stack.pop();
		if (next === undefined) continue;
		if (next === target) return true;
		if (seen.has(next)) continue;
		seen.add(next);
		const dependencyIndex = Number(next.slice(1));
		if (Number.isInteger(dependencyIndex)) stack.push(...(dependencies[dependencyIndex] ?? []));
	}
	return false;
}

function generateCase(
	seed: number,
	kind: DRPKind,
	kindSlot: number,
	suffixSize: SuffixSize,
	scheduleCount: number
): ConvergenceCase {
	const topology = TOPOLOGIES[seed % TOPOLOGIES.length];
	const count = vertexCount(topology, seed);
	const dependencies = dependenciesFor(topology, count);
	const [conflictLeft, conflictRight] = conflictingPair(dependencies);
	const leftOnlyDescendant = dependencies.findIndex(
		(_, index) =>
			index > conflictRight &&
			dependsOn(index, conflictLeft, dependencies) &&
			!dependsOn(index, conflictRight, dependencies)
	);
	const random = new SeededRandom(seed * 65_537 + kindSlot * 4_099 + 31);
	const conflictKey = random.intBetween(0, 3);
	const vertices: VertexSpec[] = dependencies.map((vertexDependencies, index) => {
		let op: VertexSpec["op"];
		let args: unknown[];
		if (kind === "resolver-free-set") {
			op = random.chance(0.5) ? "add" : "delete";
			args = [random.intBetween(0, 3)];
			if (index === conflictLeft) {
				op = "add";
				args = [conflictKey];
			}
			if (index === conflictRight) {
				op = "delete";
				args = [conflictKey];
			}
			if (index === leftOnlyDescendant) {
				op = "add";
				args = [conflictKey];
			}
		} else {
			op = random.chance(0.7) ? "set" : "delete";
			const key = random.intBetween(0, 2);
			args = op === "set" ? [key, random.intBetween(0, 9)] : [key];
			if (index === conflictLeft) {
				op = "set";
				args = [conflictKey % 3, random.intBetween(0, 9)];
			}
			if (index === conflictRight) {
				op = "delete";
				args = [conflictKey % 3];
			}
		}
		return {
			label: `V${index}`,
			op,
			args,
			dependencies: vertexDependencies,
			peerId: WRITERS[index % WRITERS.length],
			timestamp: 1_700_000_000_000 + seed * 100 + kindSlot * 20 + index,
		};
	});
	return {
		id: `seed-${seed}-${kindSlot}-${kind}-${topology}-suffix-${suffixSize}`,
		kind,
		topology,
		suffixSize,
		vertices,
		schedules: makeSchedules(
			vertices,
			seed * 101 + kindSlot * 13 + Number(suffixSize === "default" ? 8 : suffixSize),
			scheduleCount
		),
	};
}

function widenedSchedules(
	vertices: VertexSpec[],
	seed: number,
	count: number,
	distinguishingSchedule: DeliverySchedule
): DeliverySchedule[] {
	const schedules = makeSchedules(vertices, seed, count);
	if (schedules.length > 1) schedules[1] = distinguishingSchedule;
	return schedules;
}

function generateMixedACLCase(seed: number, suffixSize: SuffixSize, scheduleCount: number): ConvergenceCase {
	const target = `value-${seed % 4}`;
	const otherTarget = `value-${(seed + 1) % 4}`;
	// Must be in the PAST: `validateVertex` rejects future-dated vertices as invalid,
	// which would fail the harness on delivery rather than on divergence.
	const baseTimestamp = 1_700_000_000_000 + seed * 10;
	const vertices: VertexSpec[] = [
		{
			label: "G",
			kind: "acl",
			op: "grant",
			args: [target, ACLGroup.Finality],
			dependencies: [],
			peerId: "admin",
			timestamp: baseTimestamp,
		},
		{
			label: "P",
			op: "add",
			args: [`value-${(seed + 2) % 4}`],
			dependencies: ["G"],
			peerId: MANY_WRITERS[seed % MANY_WRITERS.length],
			timestamp: baseTimestamp + 1,
		},
		{
			label: "R",
			kind: "acl",
			op: "revoke",
			args: [target, ACLGroup.Finality],
			dependencies: ["G"],
			peerId: "admin",
			// Deliberately tied with its concurrent DRP sibling.
			timestamp: baseTimestamp + 1,
		},
		{
			label: "M",
			op: "add",
			args: [target],
			dependencies: ["P"],
			peerId: MANY_WRITERS[(seed + 1) % MANY_WRITERS.length],
			timestamp: baseTimestamp + 2,
		},
		{
			label: "A",
			kind: "acl",
			op: "grant",
			args: [otherTarget, ACLGroup.Finality],
			dependencies: ["R"],
			peerId: "admin",
			timestamp: baseTimestamp + 2,
		},
		{
			label: "V",
			op: seed % 2 === 0 ? "add" : "delete",
			args: [otherTarget],
			dependencies: ["M"],
			peerId: MANY_WRITERS[(seed + 2) % MANY_WRITERS.length],
			// A second adversarial tie, this time across types later in the DAG.
			timestamp: baseTimestamp + 2,
		},
	];
	return {
		id: `widened-mixed-acl-seed-${seed}-suffix-${suffixSize}`,
		kind: "resolver-free-set",
		topology: "acl-fork-tail",
		suffixSize,
		vertices,
		acl: { admins: ["admin"], permissionless: true },
		schedules: widenedSchedules(vertices, seed * 109 + 1, scheduleCount, {
			name: "one-mixed-batch",
			batches: [vertices.map((vertex) => vertex.label)],
		}),
	};
}

function authorityChainSchedules(vertices: VertexSpec[], seed: number, count: number): DeliverySchedule[] {
	const distinguishing: DeliverySchedule[] = [
		{
			name: "grant-chain-before-revoke",
			batches: [["GA"], ["WG"], ["W"], ["RF"]],
		},
		{
			name: "revoke-before-grant-chain",
			batches: [["RF"], ["GA"], ["WG"], ["W"]],
		},
	];
	if (count <= distinguishing.length) return distinguishing.slice(0, count);
	return [...distinguishing, ...makeSchedules(vertices, seed, count).slice(distinguishing.length)];
}

function generateAdminAuthorityChainCase(seed: number, suffixSize: SuffixSize, scheduleCount: number): ConvergenceCase {
	// The resolver's faulty conflict predicate compares value[0], so draw the
	// authority target from a deliberately tiny domain and use that exact target
	// on both sides of the cross-group grant/revoke pair.
	const authority = AUTHORITY_TARGETS[seed % AUTHORITY_TARGETS.length];
	const delegatedWriter = `w2-${seed % AUTHORITY_TARGETS.length}`;
	const baseTimestamp = 1_703_000_000_000 + seed * 10;
	const vertices: VertexSpec[] = [
		{
			label: "GA",
			kind: "acl",
			op: "grant",
			args: [authority, ACLGroup.Admin],
			dependencies: [],
			peerId: "admin",
			timestamp: baseTimestamp,
		},
		{
			label: "RF",
			kind: "acl",
			op: "revoke",
			args: [authority, ACLGroup.Finality],
			dependencies: [],
			peerId: "admin",
			timestamp: baseTimestamp + 1,
		},
		{
			label: "WG",
			kind: "acl",
			op: "grant",
			args: [delegatedWriter, ACLGroup.Writer],
			dependencies: ["GA"],
			peerId: authority,
			timestamp: baseTimestamp + 2,
		},
		{
			label: "W",
			op: "add",
			args: [`hello-${seed % 3}`],
			dependencies: ["WG"],
			peerId: delegatedWriter,
			timestamp: baseTimestamp + 3,
		},
	];
	return {
		id: `widened-admin-authority-chain-seed-${seed}-suffix-${suffixSize}`,
		kind: "resolver-free-set",
		topology: "acl-admin-authority-chain",
		suffixSize,
		vertices,
		acl: { admins: ["admin"] },
		schedules: authorityChainSchedules(vertices, seed * 109 + 4, scheduleCount),
		resolverPair: ["GA", "RF"],
	};
}

function generateResolverDropCase(seed: number, suffixSize: SuffixSize, scheduleCount: number): ConvergenceCase {
	const authority = AUTHORITY_TARGETS[seed % AUTHORITY_TARGETS.length];
	const groups = [ACLGroup.Admin, ACLGroup.Finality, ACLGroup.Writer] as const;
	const group = groups[seed % groups.length];
	const baseTimestamp = 1_703_500_000_000 + seed * 10;
	const vertices: VertexSpec[] = [
		{
			label: "GR",
			kind: "acl",
			op: "grant",
			args: [authority, group],
			dependencies: [],
			peerId: "admin",
			timestamp: baseTimestamp,
		},
		{
			label: "RR",
			kind: "acl",
			op: "revoke",
			args: [authority, group],
			dependencies: [],
			peerId: "admin",
			timestamp: baseTimestamp + 1,
		},
	];
	return {
		id: `widened-resolver-drop-seed-${seed}-${group}-suffix-${suffixSize}`,
		kind: "resolver-free-set",
		topology: "acl-resolver-drop",
		suffixSize,
		vertices,
		acl: { admins: ["admin"] },
		schedules: widenedSchedules(vertices, seed * 109 + 7, scheduleCount, {
			name: "revoke-before-grant",
			batches: [["RR"], ["GR"]],
		}),
		resolverPair: ["GR", "RR"],
	};
}

function heldGroupSchedules(vertices: VertexSpec[], seed: number, count: number): DeliverySchedule[] {
	const distinguishing: DeliverySchedule[] = [
		{
			name: "pregrant-then-concurrent-grant-before-revoke",
			batches: [["W0"], ["GC"], ["RH"]],
		},
		{
			name: "pregrant-then-revoke-before-concurrent-grant",
			batches: [["W0"], ["RH"], ["GC"]],
		},
	];
	if (count <= distinguishing.length) return distinguishing.slice(0, count);
	return [...distinguishing, ...makeSchedules(vertices, seed, count).slice(distinguishing.length)];
}

function generateHeldGroupCouplingCase(seed: number, suffixSize: SuffixSize, scheduleCount: number): ConvergenceCase {
	const authority = AUTHORITY_TARGETS[seed % AUTHORITY_TARGETS.length];
	const [heldGroup, concurrentGrantGroup] = ACL_GROUP_PAIRS[seed % ACL_GROUP_PAIRS.length];
	const baseTimestamp = 1_704_000_000_000 + seed * 10;
	const vertices: VertexSpec[] = [
		{
			label: "W0",
			kind: "acl",
			op: "grant",
			args: [authority, heldGroup],
			dependencies: [],
			peerId: "admin",
			timestamp: baseTimestamp,
		},
		{
			label: "GC",
			kind: "acl",
			op: "grant",
			args: [authority, concurrentGrantGroup],
			dependencies: ["W0"],
			peerId: "admin",
			timestamp: baseTimestamp + 1,
		},
		{
			label: "RH",
			kind: "acl",
			op: "revoke",
			args: [authority, heldGroup],
			dependencies: ["W0"],
			peerId: "admin",
			timestamp: baseTimestamp + 2,
		},
	];
	for (let offset = 2; offset < 258; offset++) {
		vertices[2].timestamp = baseTimestamp + offset;
		const { byLabel } = materialize(vertices);
		const concurrentGrantHash = byLabel.get("GC")?.hash;
		const heldGroupRevokeHash = byLabel.get("RH")?.hash;
		if (concurrentGrantHash && heldGroupRevokeHash && concurrentGrantHash < heldGroupRevokeHash) break;
		if (offset === 257) throw new Error("Could not construct GC before RH in canonical hash order");
	}
	return {
		id: `widened-held-group-coupling-seed-${seed}-${heldGroup}-to-${concurrentGrantGroup}` + `-suffix-${suffixSize}`,
		kind: "resolver-free-set",
		topology: "acl-held-group-coupling",
		suffixSize,
		vertices,
		acl: { admins: ["admin"] },
		schedules: heldGroupSchedules(vertices, seed * 109 + 5, scheduleCount),
		resolverPair: ["GC", "RH"],
	};
}

function sameGroupDescendantSchedules(vertices: VertexSpec[], seed: number, count: number): DeliverySchedule[] {
	const descendantLabels = vertices.slice(2).map((vertex) => vertex.label);
	const distinguishing: DeliverySchedule[] = [
		{
			name: "grant-descendants-before-revoke",
			batches: [["GA2"], ...descendantLabels.map((label) => [label]), ["RA"]],
		},
		{
			name: "revoke-before-grant-descendants",
			batches: [["RA"], ["GA2"], ...descendantLabels.map((label) => [label])],
		},
	];
	if (count <= distinguishing.length) return distinguishing.slice(0, count);
	return [...distinguishing, ...makeSchedules(vertices, seed, count).slice(distinguishing.length)];
}

function generateSameGroupDescendantCase(seed: number, suffixSize: SuffixSize, scheduleCount: number): ConvergenceCase {
	const authority = AUTHORITY_TARGETS[seed % AUTHORITY_TARGETS.length];
	const delegatedWriter = `descendant-writer-${seed % AUTHORITY_TARGETS.length}`;
	const tailLength = 1 + (seed % 3);
	const baseTimestamp = 1_705_000_000_000 + seed * 10;
	const vertices: VertexSpec[] = [
		{
			label: "GA2",
			kind: "acl",
			op: "grant",
			args: [authority, ACLGroup.Admin],
			dependencies: [],
			peerId: "admin-a",
			timestamp: baseTimestamp,
		},
		{
			label: "RA",
			kind: "acl",
			op: "revoke",
			args: [authority, ACLGroup.Admin],
			dependencies: [],
			peerId: "admin-b",
			timestamp: baseTimestamp + 1,
		},
		{
			label: "WG2",
			kind: "acl",
			op: "grant",
			args: [delegatedWriter, ACLGroup.Writer],
			dependencies: ["GA2"],
			peerId: authority,
			timestamp: baseTimestamp + 2,
		},
		...Array.from(
			{ length: tailLength },
			(_, index): VertexSpec => ({
				label: `P${index}`,
				op: "add",
				args: [`descendant-${seed}-${index}`],
				dependencies: [index === 0 ? "WG2" : `P${index - 1}`],
				peerId: delegatedWriter,
				timestamp: baseTimestamp + 3 + index,
			})
		),
	];
	return {
		id: `widened-same-group-descendant-seed-${seed}-tail-${tailLength}-suffix-${suffixSize}`,
		kind: "resolver-free-set",
		topology: "acl-same-group-descendant",
		suffixSize,
		vertices,
		acl: { admins: ["admin-a", "admin-b"] },
		schedules: sameGroupDescendantSchedules(vertices, seed * 109 + 6, scheduleCount),
		resolverPair: ["GA2", "RA"],
	};
}

function generateAdminRevokeAbsentGroupCase(
	seed: number,
	suffixSize: SuffixSize,
	scheduleCount: number
): ConvergenceCase {
	const authority = AUTHORITY_TARGETS[seed % AUTHORITY_TARGETS.length];
	const absentGroup = seed % 2 === 0 ? ACLGroup.Writer : ACLGroup.Finality;
	const baseTimestamp = 1_706_000_000_000 + seed * 10;
	const vertices: VertexSpec[] = [
		{
			label: "GA",
			kind: "acl",
			op: "grant",
			args: [authority, ACLGroup.Admin],
			dependencies: [],
			peerId: "admin",
			timestamp: baseTimestamp,
		},
		{
			label: "RA",
			kind: "acl",
			op: "revoke",
			args: [authority, absentGroup],
			dependencies: ["GA"],
			peerId: "admin",
			timestamp: baseTimestamp + 1,
		},
	];
	return {
		id: `widened-admin-revoke-absent-${absentGroup}-seed-${seed}-suffix-${suffixSize}`,
		kind: "resolver-free-set",
		topology: "acl-admin-revoke-absent-group",
		suffixSize,
		vertices,
		acl: { admins: ["admin"] },
		schedules: widenedSchedules(vertices, seed * 109 + 8, scheduleCount, {
			name: "admin-grant-then-absent-group-revoke",
			batches: [["GA"], ["RA"]],
		}),
	};
}

function generateArrivingBuiltInRejectionCase(
	seed: number,
	suffixSize: SuffixSize,
	scheduleCount: number
): ConvergenceCase {
	const vertices: VertexSpec[] = [
		{
			label: "DENY",
			kind: "acl",
			op: "grant",
			args: [`target-${seed}`, seed % 2 === 0 ? ACLGroup.Writer : ACLGroup.Finality],
			dependencies: [],
			peerId: `non-admin-${seed}`,
			timestamp: 1_707_000_000_000 + seed,
		},
	];
	return {
		id: `widened-arriving-built-in-rejection-seed-${seed}-suffix-${suffixSize}`,
		kind: "resolver-free-set",
		topology: "acl-arriving-built-in-rejection",
		suffixSize,
		vertices,
		acl: { admins: ["admin"] },
		schedules: widenedSchedules(vertices, seed * 109 + 9, scheduleCount, {
			name: "direct-arrival",
			batches: [["DENY"]],
		}),
	};
}

function generateTransitiveJoinChildrenCase(
	seed: number,
	suffixSize: SuffixSize,
	scheduleCount: number
): ConvergenceCase {
	const baseTimestamp = 1_701_000_000_000 + seed * 10;
	const dependencies = [[], ["V0"], ["V0", "V1"], ["V2"], ["V2"]];
	const vertices: VertexSpec[] = dependencies.map((vertexDependencies, index) => ({
		label: `V${index}`,
		op: "add",
		args: [`edge-${seed}-${index}`],
		dependencies: vertexDependencies,
		peerId: MANY_WRITERS[(seed + index) % MANY_WRITERS.length],
		// V1/V2 and both children tie while their hashes remain adversarial.
		timestamp: baseTimestamp + Math.min(index, 2),
	}));
	return {
		id: `widened-transitive-join-children-seed-${seed}-suffix-${suffixSize}`,
		kind: "resolver-free-set",
		topology: "transitive-join-children",
		suffixSize,
		vertices,
		schedules: widenedSchedules(vertices, seed * 109 + 2, scheduleCount, {
			name: "last-two-batched",
			batches: [["V0"], ["V1"], ["V2"], ["V3", "V4"]],
		}),
	};
}

function generateManyWritersCase(seed: number, suffixSize: SuffixSize, scheduleCount: number): ConvergenceCase {
	const roots = MANY_WRITERS.map(
		(peerId, index): VertexSpec => ({
			label: `W${index}`,
			op: index % 3 === 0 ? "delete" : "add",
			args: [`wide-${seed}-${index % 7}`],
			dependencies: [],
			peerId,
			// All sixteen concurrent writers tie.
			timestamp: 1_702_000_000_000 + seed,
		})
	);
	const join: VertexSpec = {
		label: "J",
		op: "add",
		args: [`wide-${seed}-join`],
		dependencies: roots.map((vertex) => vertex.label),
		peerId: MANY_WRITERS[0],
		timestamp: 1_702_000_000_001 + seed,
	};
	const children: VertexSpec[] = Array.from({ length: 3 }, (_, index) => ({
		label: `C${index}`,
		op: "add",
		args: [`wide-${seed}-child-${index}`],
		dependencies: ["J"],
		peerId: MANY_WRITERS[index + 1],
		// Three concurrent children of the wide join tie too.
		timestamp: 1_702_000_000_002 + seed,
	}));
	const vertices = [...roots, join, ...children];
	return {
		id: `widened-many-writers-seed-${seed}-suffix-${suffixSize}`,
		kind: "resolver-free-set",
		topology: "wide-fan-in-out",
		suffixSize,
		vertices,
		schedules: widenedSchedules(vertices, seed * 109 + 3, scheduleCount, {
			name: "wide-roots-batched",
			batches: [roots.map((vertex) => vertex.label), ["J"], children.map((vertex) => vertex.label)],
		}),
	};
}

function generateWidenedCase(
	seed: number,
	slot: (typeof WIDENED_SLOTS)[number],
	suffixSize: SuffixSize,
	scheduleCount: number
): ConvergenceCase {
	switch (slot) {
		case "mixed-acl":
			return generateMixedACLCase(seed, suffixSize, scheduleCount);
		case "admin-authority-chain":
			return generateAdminAuthorityChainCase(seed, suffixSize, scheduleCount);
		case "resolver-drop":
			return generateResolverDropCase(seed, suffixSize, scheduleCount);
		case "held-group-coupling":
			return generateHeldGroupCouplingCase(seed, suffixSize, scheduleCount);
		case "same-group-descendant":
			return generateSameGroupDescendantCase(seed, suffixSize, scheduleCount);
		case "admin-revoke-absent-group":
			return generateAdminRevokeAbsentGroupCase(seed, suffixSize, scheduleCount);
		case "arriving-built-in-rejection":
			return generateArrivingBuiltInRejectionCase(seed, suffixSize, scheduleCount);
		case "transitive-join-children":
			return generateTransitiveJoinChildrenCase(seed, suffixSize, scheduleCount);
		case "many-writers":
			return generateManyWritersCase(seed, suffixSize, scheduleCount);
	}
}

function projectSchedule(schedule: DeliverySchedule, labels: Set<string>): DeliverySchedule {
	return {
		...schedule,
		batches: schedule.batches
			.map((batch) => batch.filter((label) => labels.has(label)))
			.filter((batch) => batch.length > 0),
	};
}

function removeVertex(fixture: ConvergenceCase, label: string): ConvergenceCase {
	const removed = fixture.vertices.find((vertex) => vertex.label === label);
	if (!removed) return fixture;
	const expandDependency = (dependency: string): string[] =>
		dependency === label ? removed.dependencies.flatMap(expandDependency) : [dependency];
	const vertices = fixture.vertices
		.filter((vertex) => vertex.label !== label)
		.map((vertex) => ({
			...vertex,
			dependencies: [...new Set(vertex.dependencies.flatMap(expandDependency))],
		}));
	const labels = new Set(vertices.map((vertex) => vertex.label));
	return {
		...fixture,
		vertices,
		schedules: fixture.schedules.map((schedule) => projectSchedule(schedule, labels)),
		expectedFresh: undefined,
	};
}

async function diverges(fixture: ConvergenceCase): Promise<boolean> {
	if (fixture.vertices.length < 2 || fixture.schedules.length === 0) return false;
	try {
		return (await evaluate(fixture)).problems.length > 0;
	} catch {
		return false;
	}
}

async function shrink(fixture: ConvergenceCase): Promise<ConvergenceCase> {
	let minimal = fixture;
	let changed = true;
	while (changed) {
		changed = false;
		for (const vertex of [...minimal.vertices].reverse()) {
			const candidate = removeVertex(minimal, vertex.label);
			if (await diverges(candidate)) {
				minimal = candidate;
				changed = true;
				break;
			}
		}
	}

	if (minimal.schedules.length > 1) {
		for (const schedule of minimal.schedules) {
			const candidate = { ...minimal, schedules: [schedule] };
			if (await diverges(candidate)) {
				minimal = candidate;
				break;
			}
		}
	}

	for (let index = 0; index < minimal.schedules.length; index++) {
		const schedule = minimal.schedules[index];
		const singles = schedule.batches.flat().map((label) => [label]);
		const candidate = {
			...minimal,
			schedules: minimal.schedules.map((entry, entryIndex) =>
				entryIndex === index ? { ...entry, name: `${entry.name}-singles`, batches: singles } : entry
			),
		};
		if (await diverges(candidate)) minimal = candidate;
	}
	return minimal;
}

function fixtureLiteral(fixture: ConvergenceCase): string {
	const hashes = Object.fromEntries(
		[...materialize(fixture.vertices).byLabel].map(([label, vertex]) => [label, vertex.hash])
	);
	return JSON.stringify(
		{
			id: fixture.id,
			kind: fixture.kind,
			topology: fixture.topology,
			suffixSize: fixture.suffixSize,
			hashes,
			vertices: fixture.vertices,
			schedules: fixture.schedules,
		},
		undefined,
		2
	);
}

function report(fixture: ConvergenceCase, result: CaseResult): string {
	return [
		"COPY-PASTEABLE FIXTURE:",
		fixtureLiteral(fixture),
		"RESULTS:",
		JSON.stringify(
			{
				problems: result.problems,
				current: result.current,
				baseline: result.baseline ?? "not configured",
			},
			undefined,
			2
		),
	].join("\n");
}

async function expectConverged(fixture: ConvergenceCase): Promise<void> {
	if (XVER_ENABLED) {
		const { approvedBaselineDivergence: _gate0Only, ...xverFixture } = fixture;
		void _gate0Only;
		await expectXverConverged(xverFixture);
		return;
	}
	const result = await evaluate(fixture);
	const baselineProblems = result.problems.filter(isBaselineProblem);
	const currentEngineProblems = result.problems.filter((problem) => !isBaselineProblem(problem));
	const approvedBaselineOnly =
		fixture.approvedBaselineDivergence === true && baselineProblems.length > 0 && currentEngineProblems.length === 0;
	if (result.problems.length > 0 && !approvedBaselineOnly) {
		const minimal = fixture.expectedFresh || fixture.resolverPair ? fixture : await shrink(fixture);
		const minimalResult = await evaluate(minimal);
		throw new Error(`${fixture.id}: ${result.problems.length} divergence(s)\n${report(minimal, minimalResult)}`);
	}
	expect(currentEngineProblems).toEqual([]);
	if (fixture.approvedBaselineDivergence && BASELINE_MODULE_PATH && !PRIMARY_MODULE_PATH) {
		expect(
			baselineProblems.length,
			`${fixture.id} no longer differs from baseline — remove its approvedBaselineDivergence classification`
		).toBeGreaterThan(0);
	} else {
		expect(baselineProblems).toEqual([]);
	}
}

function fixedThreeWayHeldGroupCase(): ConvergenceCase {
	const vertices: VertexSpec[] = [
		{
			label: "W0",
			kind: "acl",
			op: "grant",
			args: ["p", ACLGroup.Writer],
			dependencies: [],
			peerId: "adm",
			timestamp: 1_710_000_000_000,
		},
		{
			label: "F0",
			kind: "acl",
			op: "grant",
			args: ["p", ACLGroup.Finality],
			dependencies: ["W0"],
			peerId: "adm",
			timestamp: 1_710_000_000_001,
		},
		{
			label: "GA",
			kind: "acl",
			op: "grant",
			args: ["p", ACLGroup.Admin],
			dependencies: ["F0"],
			peerId: "adm",
			timestamp: 1_710_000_000_002,
		},
		{
			label: "RW",
			kind: "acl",
			op: "revoke",
			args: ["p", ACLGroup.Writer],
			dependencies: ["F0"],
			peerId: "adm",
			timestamp: 1_710_000_000_003,
		},
		{
			label: "RF",
			kind: "acl",
			op: "revoke",
			args: ["p", ACLGroup.Finality],
			dependencies: ["F0"],
			peerId: "adm",
			timestamp: 1_710_000_000_003,
		},
	];
	let hashes = materialize(vertices).byLabel;
	for (let offset = 0; offset < 512 && (hashes.get("GA")?.hash ?? "") >= (hashes.get("RW")?.hash ?? ""); offset++) {
		vertices[3].timestamp = 1_710_000_000_003 + offset;
		hashes = materialize(vertices).byLabel;
	}
	if ((hashes.get("GA")?.hash ?? "") >= (hashes.get("RW")?.hash ?? "")) {
		throw new Error("Could not force GA < RW for fixed-three-way-held-group in 512 timestamp assignments");
	}
	for (let offset = 0; offset < 512 && (hashes.get("RW")?.hash ?? "") >= (hashes.get("RF")?.hash ?? ""); offset++) {
		vertices[4].timestamp = 1_710_000_000_003 + offset;
		hashes = materialize(vertices).byLabel;
	}
	if ((hashes.get("RW")?.hash ?? "") >= (hashes.get("RF")?.hash ?? "")) {
		throw new Error("Could not force RW < RF for fixed-three-way-held-group in 512 timestamp assignments");
	}
	return {
		id: "fixed-three-way-held-group-attribution",
		kind: "resolver-free-set",
		topology: "acl-three-way-held-group",
		suffixSize: "default",
		// Anti-reintroduction pin: the attempt-1 resolver made this delivery-order dependent.
		acl: { admins: ["adm"] },
		vertices,
		schedules: [
			{ name: "grant-before-revokes", batches: [["W0"], ["F0"], ["GA"], ["RW"], ["RF"]] },
			{ name: "revokes-before-grant", batches: [["W0"], ["F0"], ["RW"], ["RF"], ["GA"]] },
		],
		resolverPair: ["GA", "RW"],
	};
}

const fixedCases: ConvergenceCase[] = [
	{
		id: "fixed-three-vertex-noncanonical-cut",
		kind: "resolver-free-set",
		topology: "fork",
		suffixSize: "default",
		vertices: [
			{ label: "A", op: "add", args: [9], dependencies: [], peerId: "writer-a", timestamp: 1 },
			{ label: "B1", op: "delete", args: [7], dependencies: [], peerId: "writer-b", timestamp: 2 },
			{ label: "C", op: "add", args: [7], dependencies: ["A"], peerId: "writer-c", timestamp: 3 },
		],
		schedules: [{ name: "documented-singles", batches: [["A"], ["B1"], ["C"]] }],
		expectedFresh: { state: "[9]", order: ["A", "C", "B1"] },
	},
	{
		id: "fixed-four-vertex-incomplete-tail",
		kind: "resolver-free-set",
		topology: "fork",
		suffixSize: "default",
		vertices: [
			{ label: "V0", op: "add", args: [3], dependencies: [], peerId: "writer-b", timestamp: 11 },
			{ label: "V1", op: "add", args: [0], dependencies: [], peerId: "writer-a", timestamp: 12 },
			{ label: "V2", op: "delete", args: [1], dependencies: ["V0"], peerId: "writer-c", timestamp: 12 },
			{ label: "V3", op: "delete", args: [1], dependencies: ["V2"], peerId: "writer-d", timestamp: 13 },
		],
		schedules: [{ name: "documented-singles", batches: [["V0"], ["V1"], ["V2"], ["V3"]] }],
		expectedFresh: { state: "[0,3]", order: ["V1", "V0", "V2", "V3"] },
	},
	{
		id: "fixed-four-vertex-cross-group-authority-chain",
		kind: "resolver-free-set",
		topology: "acl-admin-authority-chain",
		suffixSize: "default",
		// Deferred inherited HIGH: current and 7f9e66a both fork on this shape.
		acl: { admins: ["admin"] },
		vertices: [
			{
				label: "GA",
				kind: "acl",
				op: "grant",
				args: ["eve", ACLGroup.Admin],
				dependencies: [],
				peerId: "admin",
				timestamp: 1,
			},
			{
				label: "RF",
				kind: "acl",
				op: "revoke",
				args: ["eve", ACLGroup.Finality],
				dependencies: [],
				peerId: "admin",
				timestamp: 2,
			},
			{
				label: "WG",
				kind: "acl",
				op: "grant",
				args: ["w2", ACLGroup.Writer],
				dependencies: ["GA"],
				peerId: "eve",
				timestamp: 3,
			},
			{
				label: "W",
				op: "add",
				args: ["hello"],
				dependencies: ["WG"],
				peerId: "w2",
				timestamp: 4,
			},
		],
		schedules: [
			{ name: "grant-chain-before-revoke", batches: [["GA"], ["WG"], ["W"], ["RF"]] },
			{ name: "revoke-before-grant-chain", batches: [["RF"], ["GA"], ["WG"], ["W"]] },
		],
		resolverPair: ["GA", "RF"],
	},
	{
		id: "fixed-held-group-coupling-regression",
		kind: "resolver-free-set",
		topology: "acl-held-group-coupling",
		suffixSize: "default",
		// Anti-reintroduction pin: attempt 1 made this reference-green shape fork.
		acl: { admins: ["adm"] },
		vertices: [
			{
				label: "W0",
				kind: "acl",
				op: "grant",
				args: ["p", ACLGroup.Writer],
				dependencies: [],
				peerId: "adm",
				timestamp: 10,
			},
			{
				label: "GA",
				kind: "acl",
				op: "grant",
				args: ["p", ACLGroup.Admin],
				dependencies: ["W0"],
				peerId: "adm",
				timestamp: 11,
			},
			{
				label: "RW",
				kind: "acl",
				op: "revoke",
				args: ["p", ACLGroup.Writer],
				dependencies: ["W0"],
				peerId: "adm",
				timestamp: 12,
			},
		],
		schedules: [
			{ name: "grant-admin-before-revoke-held-writer", batches: [["W0"], ["GA"], ["RW"]] },
			{ name: "revoke-held-writer-before-grant-admin", batches: [["W0"], ["RW"], ["GA"]] },
		],
		resolverPair: ["GA", "RW"],
	},
	{
		id: "fixed-same-group-pair-with-descendant",
		kind: "resolver-free-set",
		topology: "acl-same-group-descendant",
		suffixSize: "default",
		// Deferred inherited HIGH beside the cross-group authority-chain shape.
		acl: { admins: ["a1", "a2"] },
		vertices: [
			{
				label: "GA2",
				kind: "acl",
				op: "grant",
				args: ["eve", ACLGroup.Admin],
				dependencies: [],
				peerId: "a1",
				timestamp: 20,
			},
			{
				label: "RA",
				kind: "acl",
				op: "revoke",
				args: ["eve", ACLGroup.Admin],
				dependencies: [],
				peerId: "a2",
				timestamp: 21,
			},
			{
				label: "WG2",
				kind: "acl",
				op: "grant",
				args: ["w", ACLGroup.Writer],
				dependencies: ["GA2"],
				peerId: "eve",
				timestamp: 22,
			},
			{
				label: "P",
				op: "add",
				args: ["x"],
				dependencies: ["WG2"],
				peerId: "w",
				timestamp: 23,
			},
		],
		schedules: [
			{ name: "grant-descendant-before-revoke", batches: [["GA2"], ["WG2"], ["P"], ["RA"]] },
			{ name: "revoke-before-grant-descendant", batches: [["RA"], ["GA2"], ["WG2"], ["P"]] },
		],
		resolverPair: ["GA2", "RA"],
	},
	fixedThreeWayHeldGroupCase(),
	{
		id: "fixed-admin-revoke-group-the-target-does-not-hold",
		kind: "resolver-free-set",
		topology: "acl-admin-revoke-absent-group",
		suffixSize: "default",
		// The revoke guard is reference-identical; only P5's invalid-vs-quarantined
		// admission taxonomy differs from 7f9e66a on this input.
		approvedBaselineDivergence: true,
		acl: { admins: ["adm"] },
		vertices: [
			{
				label: "GA",
				kind: "acl",
				op: "grant",
				args: ["p", ACLGroup.Admin],
				dependencies: [],
				peerId: "adm",
				timestamp: 1_711_000_000_000,
			},
			{
				label: "RA",
				kind: "acl",
				op: "revoke",
				args: ["p", ACLGroup.Writer],
				dependencies: ["GA"],
				peerId: "adm",
				timestamp: 1_711_000_000_001,
			},
		],
		schedules: [
			{ name: "singles", batches: [["GA"], ["RA"]] },
			{ name: "one-batch", batches: [["GA", "RA"]] },
		],
	},
	{
		id: "fixed-critical-1-cross-type-acl-drop",
		kind: "resolver-free-set",
		topology: "acl-fork-tail",
		suffixSize: "default",
		acl: { admins: ["adm"] },
		vertices: [
			{
				label: "G",
				kind: "acl",
				op: "grant",
				args: ["w", ACLGroup.Writer],
				dependencies: [],
				peerId: "adm",
				timestamp: 1,
			},
			{
				label: "R",
				kind: "acl",
				op: "revoke",
				args: ["w", ACLGroup.Finality],
				dependencies: ["G"],
				peerId: "adm",
				// This fixed timestamp makes hash(R) < hash(P).
				timestamp: 3,
			},
			{
				label: "P",
				op: "add",
				args: ["seed"],
				dependencies: ["G"],
				peerId: "w",
				timestamp: 2,
			},
			{ label: "M", op: "add", args: ["w"], dependencies: ["P"], peerId: "w", timestamp: 6 },
			{ label: "v", op: "add", args: ["z"], dependencies: ["M"], peerId: "w", timestamp: 7 },
		],
		schedules: [
			{ name: "singles", batches: [["G"], ["R"], ["P"], ["M"], ["v"]] },
			{ name: "one-mixed-batch", batches: [["G", "R", "P", "M", "v"]] },
			{ name: "singles-M-last", batches: [["G"], ["R"], ["P"], ["M"], ["v"]] },
			{
				name: "acl-then-drp-deferral-control",
				batches: [
					["G", "R"],
					["P", "M", "v"],
				],
			},
		],
		// NO hand-computed oracle. Critical 1 requires hash(R) < hash(P) so that
		// ObjectACL's resolver drops M; that ordering is a property of the vertex
		// hashes, not of the shape, and these timestamps do not produce it — both
		// engines legitimately agree on ["seed","w","z"] here. Asserting the
		// canonical ["seed","z"] made this fixture fail on BOTH engines for the
		// wrong reason, which is exactly how a real signal gets dismissed as noise.
		// The family is carried by the generated `mixed-acl` slot, which reproduces
		// it at 12/48 on the current tree and 0/48 at baseline. This fixture is
		// retained as a self-consistency + cross-engine pin over the shape itself.
	},
	{
		id: "fixed-critical-2-transitive-join-with-two-children",
		kind: "resolver-free-set",
		topology: "transitive-join-children",
		suffixSize: "default",
		approvedBaselineDivergence: true,
		vertices: [
			{ label: "V0", op: "add", args: ["e0"], dependencies: [], peerId: "s", timestamp: 504 },
			{ label: "V1", op: "add", args: ["e1"], dependencies: ["V0"], peerId: "s", timestamp: 1474 },
			{
				label: "V2",
				op: "add",
				args: ["e2"],
				dependencies: ["V0", "V1"],
				peerId: "s",
				timestamp: 2140,
			},
			{ label: "V3", op: "add", args: ["e3"], dependencies: ["V2"], peerId: "s", timestamp: 2511 },
			{ label: "V4", op: "add", args: ["e4"], dependencies: ["V2"], peerId: "s", timestamp: 3114 },
		],
		schedules: [
			{ name: "singles", batches: [["V0"], ["V1"], ["V2"], ["V3"], ["V4"]] },
			{ name: "last-two-batched", batches: [["V0"], ["V1"], ["V2"], ["V3", "V4"]] },
		],
		// Deliberately no hand-computed state oracle: the baseline's from-root
		// linearizer is already lossy for this shape. The gate compares the two
		// schedules and fresh replay within each engine, so only the regression's
		// newly disagreeing state-derivation paths fail.
	},
];

async function expectXverFixedCorpusAcceptance(): Promise<void> {
	const config = await xverConfig();
	const fixtures = fixedCases.map(({ approvedBaselineDivergence: _gate0Only, ...fixture }) => {
		void _gate0Only;
		return fixture;
	});
	const results: XverFixtureComparison[] = [];
	for (const fixture of fixtures) results.push(await compareXverFixture(config, fixture));
	const combined = assertXverComparison(config, fixtures, results);
	const evidence = authenticateAcceptanceEvidence(config);
	const mapFixtures = fixtures.filter((_, index) => results[index].mapFixture).map((fixture) => fixture.id);
	process.stdout.write(
		`XVER_ACCEPTANCE_SUMMARY ${JSON.stringify({
			referenceSha: XVER_REFERENCE_SHA,
			primarySha: evidence.primarySha,
			primaryArtifactSha256: evidence.primaryArtifactSha256,
			referenceArtifactSha256: evidence.referenceArtifactSha256,
			referenceRuntimeClosureSha256: evidence.referenceRuntimeClosureSha256,
			fixtures: fixtures.map((fixture) => fixture.id),
			scheduleCount: fixtures.reduce((total, fixture) => total + fixture.schedules.length, 0),
			surfaces: XVER_SURFACES,
			comparisons: combined.comparisons,
			mapFixtures,
			approvedDeltaCount: config.deltas.length,
		})}\n`
	);
}

describe("Gate-0 fixed differential convergence corpus", () => {
	for (const fixture of fixedCases) {
		it(fixture.id, async () => {
			await expectConverged(fixture);
		});
	}
});

if (XVER_ENABLED) {
	it("Phase 0m authenticated fixed-corpus acceptance", async () => {
		await expectXverFixedCorpusAcceptance();
	});
}

function resolverVertices(fixture: ConvergenceCase): [VertexSpec, VertexSpec] | undefined {
	if (!fixture.resolverPair) return undefined;
	const [leftLabel, rightLabel] = fixture.resolverPair;
	const left = fixture.vertices.find((vertex) => vertex.label === leftLabel);
	const right = fixture.vertices.find((vertex) => vertex.label === rightLabel);
	if (!left || !right || left.kind !== "acl" || right.kind !== "acl") return undefined;
	return [left, right];
}

function reachesLabel(fixture: ConvergenceCase, from: VertexSpec, target: string): boolean {
	const byLabel = new Map(fixture.vertices.map((vertex) => [vertex.label, vertex]));
	const stack = [...from.dependencies];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const next = stack.pop();
		if (next === undefined) continue;
		if (next === target) return true;
		if (seen.has(next)) continue;
		seen.add(next);
		stack.push(...(byLabel.get(next)?.dependencies ?? []));
	}
	return false;
}

function hasResolverCollisionPrecondition(fixture: ConvergenceCase): boolean {
	const pair = resolverVertices(fixture);
	if (!pair || !fixture.resolverPair) return false;
	const [left, right] = pair;
	const [leftLabel, rightLabel] = fixture.resolverPair;
	const oppositeOps = (left.op === "grant" && right.op === "revoke") || (left.op === "revoke" && right.op === "grant");
	const concurrent = !reachesLabel(fixture, left, rightLabel) && !reachesLabel(fixture, right, leftLabel);
	return oppositeOps && left.args[0] === right.args[0] && concurrent;
}

function heldGroupGrant(fixture: ConvergenceCase): VertexSpec | undefined {
	const pair = resolverVertices(fixture);
	if (!pair || !fixture.resolverPair || !hasResolverCollisionPrecondition(fixture)) return undefined;
	const revoke = pair.find((vertex) => vertex.op === "revoke");
	if (!revoke) return undefined;
	const [leftLabel, rightLabel] = fixture.resolverPair;
	return fixture.vertices.find(
		(vertex) =>
			vertex.label !== leftLabel &&
			vertex.label !== rightLabel &&
			vertex.kind === "acl" &&
			vertex.op === "grant" &&
			vertex.args[0] === revoke.args[0] &&
			vertex.args[1] === revoke.args[1] &&
			reachesLabel(fixture, pair[0], vertex.label) &&
			reachesLabel(fixture, pair[1], vertex.label)
	);
}

function hasHeldGroupPrecondition(fixture: ConvergenceCase, run: EngineRun): boolean {
	const priorGrant = heldGroupGrant(fixture);
	return (
		priorGrant !== undefined &&
		[...run.replicas, run.fresh].every(
			(outcome) => outcome.members.includes(priorGrant.label) && outcome.admissions[priorGrant.label] === "applied"
		)
	);
}

function resolverGrantWithDescendants(fixture: ConvergenceCase): VertexSpec | undefined {
	const pair = resolverVertices(fixture);
	if (!pair || !hasResolverCollisionPrecondition(fixture) || pair[0].args[1] !== pair[1].args[1]) return undefined;
	const grant = pair.find((vertex) => vertex.op === "grant");
	if (!grant || typeof grant.args[0] !== "string") return undefined;
	const authorityDependentDescendants = fixture.vertices.filter(
		(vertex) =>
			vertex.label !== grant.label && vertex.peerId === grant.args[0] && reachesLabel(fixture, vertex, grant.label)
	);
	return authorityDependentDescendants.length > 0 ? grant : undefined;
}

function hasDroppedVertexWithDescendantsPrecondition(fixture: ConvergenceCase, run: EngineRun): boolean {
	const grant = resolverGrantWithDescendants(fixture);
	const revoke = resolverVertices(fixture)?.find((vertex) => vertex.op === "revoke");
	if (!grant || !revoke) return false;
	return [...run.replicas, run.fresh].some(
		(outcome) => !outcome.order.includes(grant.label) && outcome.order.includes(revoke.label)
	);
}

function hasAdminRevokeAbsentGroupPrecondition(fixture: ConvergenceCase, run: EngineRun): boolean {
	const revoke = fixture.vertices.find((vertex) => vertex.kind === "acl" && vertex.op === "revoke");
	if (!revoke || typeof revoke.args[0] !== "string") return false;
	const adminGrant = fixture.vertices.find(
		(vertex) =>
			vertex.kind === "acl" &&
			vertex.op === "grant" &&
			vertex.args[0] === revoke.args[0] &&
			vertex.args[1] === ACLGroup.Admin &&
			reachesLabel(fixture, revoke, vertex.label)
	);
	if (!adminGrant) return false;
	const priorGroupGrant = fixture.vertices.some(
		(vertex) =>
			vertex.kind === "acl" &&
			vertex.op === "grant" &&
			vertex.args[0] === revoke.args[0] &&
			vertex.args[1] === revoke.args[1] &&
			reachesLabel(fixture, revoke, vertex.label)
	);
	return (
		!priorGroupGrant &&
		[...run.replicas, run.fresh].every(
			(outcome) => outcome.members.includes(adminGrant.label) && outcome.admissions[adminGrant.label] === "applied"
		)
	);
}

function adminRevokeAbsentGroupGuardOutcome(engine: EngineModule, fixture: ConvergenceCase): string {
	const revoke = fixture.vertices.find((vertex) => vertex.kind === "acl" && vertex.op === "revoke");
	const admin = fixture.acl?.admins[0];
	if (!revoke || !admin || typeof revoke.args[0] !== "string") return "fixture-missing-precondition";
	const acl = engine.createACL({ admins: [admin] }) as {
		context: { caller: string };
		grant(peerId: string, group: ACLGroup): void;
		revoke(peerId: string, group: ACLGroup): void;
	};
	acl.context.caller = admin;
	acl.grant(revoke.args[0], ACLGroup.Admin);
	try {
		acl.revoke(revoke.args[0], revoke.args[1] as ACLGroup);
		return "returned";
	} catch (error) {
		return `threw:${error instanceof Error ? error.message : String(error)}`;
	}
}

function hasArrivingBuiltInRejectionPrecondition(fixture: ConvergenceCase, run: EngineRun): boolean {
	const rejected = fixture.vertices.find(
		(vertex) =>
			vertex.kind === "acl" &&
			vertex.op === "grant" &&
			vertex.dependencies.length === 0 &&
			!fixture.acl?.admins.includes(vertex.peerId)
	);
	if (!rejected) return false;
	return [...run.replicas, run.fresh].every(
		(outcome) =>
			!outcome.members.includes(rejected.label) &&
			(outcome.admissions[rejected.label] === "invalid" || outcome.admissions[rejected.label] === "quarantined")
	);
}

function producedResolverDrop(run: EngineRun, pair: [string, string]): boolean {
	return [...run.replicas, run.fresh].some((outcome) => {
		const present = pair.filter((label) => outcome.order.includes(label));
		return present.length === 1;
	});
}

async function runGeneratedTier(seedCount: number, scheduleCount: number): Promise<void> {
	const failures: { fixture: ConvergenceCase; result: CaseResult }[] = [];
	for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
		const seed = seedIndex + 40;
		for (let kindSlot = 0; kindSlot < KIND_SWEEP.length; kindSlot++) {
			for (const suffixSize of SUFFIX_SIZES) {
				const fixture = generateCase(seed, KIND_SWEEP[kindSlot], kindSlot, suffixSize, scheduleCount);
				const result = await evaluate(fixture);
				if (result.problems.length > 0) failures.push({ fixture, result });
			}
		}
	}
	if (failures.length > 0) {
		const first = failures[0];
		const minimal = await shrink(first.fixture);
		const minimalResult = await evaluate(minimal);
		throw new Error(
			`${failures.length} / ${seedCount * KIND_SWEEP.length * SUFFIX_SIZES.length} generated DAG cases diverged ` +
				`(${scheduleCount} schedules/case)\n${report(minimal, minimalResult)}`
		);
	}
}

/**
 * The fixed engine intentionally differs from `7f9e66a` on the two
 * byzantine-reachable dependency classes already approved by slice 0r and on
 * deterministic built-in ACL admission: typed guards terminate instead of
 * entering retry quarantine. ACL conflict identity and the admin revoke guard
 * are reference-identical. Approval covers baseline-only differences. Any
 * current-engine replica or fresh-replay disagreement remains a failure.
 * @param fixture - Widened fixture under evaluation.
 * @returns Whether baseline-only divergence is approved for the fixture.
 */
function isApprovedBaselineDivergence(fixture: ConvergenceCase): boolean {
	return approvedBaselineDivergenceClass(fixture) !== undefined;
}

type ApprovedBaselineDivergenceClass = "dependency-shape" | "deterministic-acl-admission";

function approvedBaselineDivergenceClass(fixture: ConvergenceCase): ApprovedBaselineDivergenceClass | undefined {
	const hasDuplicateListedDependency = fixture.vertices.some(
		(vertex) => new Set(vertex.dependencies).size !== vertex.dependencies.length
	);
	if (fixture.topology === "transitive-join-children" || hasDuplicateListedDependency) return "dependency-shape";
	if (fixture.topology === "acl-admin-revoke-absent-group" || fixture.topology === "acl-arriving-built-in-rejection") {
		return "deterministic-acl-admission";
	}
	return undefined;
}

function isBaselineProblem(problem: Problem): boolean {
	return problem.scope === "baseline";
}

async function runWidenedTier(seedCount: number, scheduleCount: number): Promise<void> {
	const failures: { fixture: ConvergenceCase; result: CaseResult }[] = [];
	const failuresBySlot = new Map<(typeof WIDENED_SLOTS)[number], number>();
	const observedApprovedBaseline = new Set<string>();
	const observedApprovedBaselineClasses = new Set<ApprovedBaselineDivergenceClass>();
	let currentEngineFailureCases = 0;
	let replicaVsReplicaCases = 0;
	let replicaVsFreshCases = 0;
	let unapprovedBaselineFailureCases = 0;
	let p4CrossEngineDifferences = 0;
	let p4CrossEngineComparisons = 0;
	const currentDimensionCases = new Map<OutcomeDimension, number>();
	const baselineDimensionCases = new Map<OutcomeDimension, number>();
	const approvedBaselineDimensionCases = new Map<OutcomeDimension, number>();
	const preconditions = {
		P1: { fired: 0, generated: 0 },
		P2: { fired: 0, generated: 0 },
		P3: { fired: 0, generated: 0 },
		P4: { fired: 0, generated: 0 },
		P5: { fired: 0, generated: 0 },
	};
	for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
		const seed = seedIndex + 40;
		for (const slot of WIDENED_SLOTS) {
			for (const suffixSize of SUFFIX_SIZES) {
				const fixture = generateWidenedCase(seed, slot, suffixSize, scheduleCount);
				const result = await evaluate(fixture);
				if (slot === "resolver-drop") {
					preconditions.P1.generated++;
					if (
						hasResolverCollisionPrecondition(fixture) &&
						fixture.resolverPair &&
						producedResolverDrop(result.current, fixture.resolverPair)
					) {
						preconditions.P1.fired++;
					}
				}
				if (slot === "held-group-coupling") {
					preconditions.P2.generated++;
					if (hasHeldGroupPrecondition(fixture, result.current)) preconditions.P2.fired++;
				}
				if (slot === "same-group-descendant") {
					preconditions.P3.generated++;
					if (hasDroppedVertexWithDescendantsPrecondition(fixture, result.current)) preconditions.P3.fired++;
				}
				if (slot === "admin-revoke-absent-group") {
					preconditions.P4.generated++;
					if (hasAdminRevokeAbsentGroupPrecondition(fixture, result.current)) preconditions.P4.fired++;
					if (BASELINE_MODULE_PATH && !PRIMARY_MODULE_PATH) {
						const pinned = await baselineEngine();
						if (pinned) {
							p4CrossEngineComparisons++;
							if (
								adminRevokeAbsentGroupGuardOutcome(currentEngine, fixture) !==
								adminRevokeAbsentGroupGuardOutcome(pinned, fixture)
							) {
								p4CrossEngineDifferences++;
							}
						}
					}
				}
				if (slot === "arriving-built-in-rejection") {
					preconditions.P5.generated++;
					if (hasArrivingBuiltInRejectionPrecondition(fixture, result.current)) preconditions.P5.fired++;
				}
				if (result.problems.length > 0) {
					const baselineProblems = result.problems.filter(isBaselineProblem);
					const currentEngineProblems = result.problems.filter((problem) => !isBaselineProblem(problem));
					for (const dimension of new Set(currentEngineProblems.flatMap((problem) => problem.dimensions))) {
						currentDimensionCases.set(dimension, (currentDimensionCases.get(dimension) ?? 0) + 1);
					}
					for (const dimension of new Set(baselineProblems.flatMap((problem) => problem.dimensions))) {
						baselineDimensionCases.set(dimension, (baselineDimensionCases.get(dimension) ?? 0) + 1);
					}
					if (
						isApprovedBaselineDivergence(fixture) &&
						baselineProblems.length > 0 &&
						currentEngineProblems.length === 0
					) {
						for (const dimension of new Set(baselineProblems.flatMap((problem) => problem.dimensions))) {
							approvedBaselineDimensionCases.set(dimension, (approvedBaselineDimensionCases.get(dimension) ?? 0) + 1);
						}
						observedApprovedBaseline.add(fixture.id);
						const approvedClass = approvedBaselineDivergenceClass(fixture);
						if (approvedClass) observedApprovedBaselineClasses.add(approvedClass);
						continue;
					}
					failures.push({ fixture, result });
					failuresBySlot.set(slot, (failuresBySlot.get(slot) ?? 0) + 1);
					if (currentEngineProblems.length > 0) currentEngineFailureCases++;
					if (currentEngineProblems.some((problem) => problem.kind === "replica-vs-replica")) {
						replicaVsReplicaCases++;
					}
					if (currentEngineProblems.some((problem) => problem.kind === "replica-vs-fresh-replay")) {
						replicaVsFreshCases++;
					}
					if (baselineProblems.length > 0 && !isApprovedBaselineDivergence(fixture)) {
						unapprovedBaselineFailureCases++;
					}
				}
			}
		}
	}
	const tier = seedCount === NIGHTLY_SEEDS ? "nightly" : "per-PR";
	const preconditionSummary = (Object.keys(preconditions) as (keyof typeof preconditions)[])
		.map((name) => {
			const measurement = preconditions[name];
			const rate = measurement.generated === 0 ? 0 : measurement.fired / measurement.generated;
			return `${name}=${measurement.fired}/${measurement.generated} (${(rate * 100).toFixed(1)}%)`;
		})
		.join("; ");
	process.stdout.write(`Gate-0 widened preconditions [${tier}]: ${preconditionSummary}\n`);
	if (BASELINE_MODULE_PATH && !PRIMARY_MODULE_PATH) {
		process.stdout.write(
			`Gate-0 P4 revoke-guard equivalence [${tier}]: ${p4CrossEngineDifferences}/${p4CrossEngineComparisons} differences\n`
		);
		expect(p4CrossEngineDifferences, "P4 revoke-guard behavior must remain reference-identical").toBe(0);
	}
	for (const [name, measurement] of Object.entries(preconditions)) {
		expect(measurement.generated, `${name} generator slot must be present in the ${tier} tier`).toBeGreaterThan(0);
		expect(
			measurement.fired / measurement.generated,
			`${name} generator precondition firing rate must be at least ${MIN_GENERATOR_PRECONDITION_RATE * 100}%`
		).toBeGreaterThanOrEqual(MIN_GENERATOR_PRECONDITION_RATE);
	}
	if (BASELINE_MODULE_PATH && !PRIMARY_MODULE_PATH) {
		// Staleness enforcement is per approved class, so one live exception
		// cannot mask another class that no longer differs from the baseline.
		expect(
			[...(["dependency-shape", "deterministic-acl-admission"] as const)].filter(
				(approvedClass) => !observedApprovedBaselineClasses.has(approvedClass)
			),
			"an approved divergence class no longer differs from baseline — delete its manifest entry"
		).toEqual([]);
	}

	if (failures.length > 0) {
		const first = failures[0];
		const minimal = await shrink(first.fixture);
		const minimalResult = await evaluate(minimal);
		const counts = WIDENED_SLOTS.map((slot) => `${slot}=${failuresBySlot.get(slot) ?? 0}`).join(", ");
		const dimensionCounts = (["drp-state", "acl-state", "linear-order", "graph-membership", "admission"] as const)
			.map(
				(dimension) =>
					`${dimension}=${currentDimensionCases.get(dimension) ?? 0}` +
					` current/${approvedBaselineDimensionCases.get(dimension) ?? 0} approved-reference/` +
					`${baselineDimensionCases.get(dimension) ?? 0} all-reference`
			)
			.join(", ");
		// Every diverging id, not only the minimized one, keeps unexpected
		// current-engine and unapproved baseline differences enumerable.
		const ids = failures.map(({ fixture }) => fixture.id).join("\n  ");
		throw new Error(
			`DIVERGENT CASE IDS:\n  ${ids}\n` +
				`${failures.length} / ${seedCount * WIDENED_SLOTS.length * SUFFIX_SIZES.length} widened DAG cases diverged ` +
				`(${scheduleCount} schedules/case; approved-baseline=${observedApprovedBaseline.size}; ` +
				`current-engine=${currentEngineFailureCases}; replica-vs-replica=${replicaVsReplicaCases}; ` +
				`replica-vs-fresh=${replicaVsFreshCases}; unapproved-baseline=${unapprovedBaselineFailureCases}; ` +
				`${preconditionSummary}; ${dimensionCounts}; ${counts})\n` +
				report(minimal, minimalResult)
		);
	}
}

describe("Gate-0 differential convergence — per-PR tier", () => {
	it(
		`${PR_SEEDS} seeds × ${KIND_SWEEP.length} kind slots × ${SUFFIX_SIZES.length} suffixes × ` +
			`${PR_SCHEDULES} schedules`,
		{ timeout: 120_000 },
		async () => {
			await runGeneratedTier(PR_SEEDS, PR_SCHEDULES);
		}
	);
});

describe("Gate-0 widened differential convergence — per-PR tier", () => {
	it(
		`${PR_SEEDS} seeds × ${WIDENED_SLOTS.length} widened slots × ${SUFFIX_SIZES.length} suffixes × ` +
			`${PR_SCHEDULES} schedules`,
		{ timeout: 120_000 },
		async () => {
			await runWidenedTier(PR_SEEDS, PR_SCHEDULES);
		}
	);
});

describe.skipIf(process.env.GATE0_DIFFERENTIAL_NIGHTLY !== "1")(
	"Gate-0 differential convergence — nightly tier",
	() => {
		it(
			`${NIGHTLY_SEEDS} seeds × ${KIND_SWEEP.length} kind slots × ${SUFFIX_SIZES.length} suffixes × ` +
				`${NIGHTLY_SCHEDULES} schedules`,
			{ timeout: 600_000 },
			async () => {
				await runGeneratedTier(NIGHTLY_SEEDS, NIGHTLY_SCHEDULES);
			}
		);
	}
);

describe.skipIf(process.env.GATE0_DIFFERENTIAL_NIGHTLY !== "1")(
	"Gate-0 widened differential convergence — nightly tier",
	() => {
		it(
			`${NIGHTLY_SEEDS} seeds × ${WIDENED_SLOTS.length} widened slots × ${SUFFIX_SIZES.length} suffixes × ` +
				`${NIGHTLY_SCHEDULES} schedules`,
			{ timeout: 600_000 },
			async () => {
				await runWidenedTier(NIGHTLY_SEEDS, NIGHTLY_SCHEDULES);
			}
		);
	}
);
