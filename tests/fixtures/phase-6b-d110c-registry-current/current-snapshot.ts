import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, stringify } from "yaml";

export const ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const POLICY = "packages/protocol-v3/conformance/freeze-policy-v3.json";
export const CHECKER = "packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs";
export const V2_CHECKER = "packages/protocol-v2/scripts/check-protocol-freeze.mjs";
export const REGISTRY = "packages/protocol-v3/registry/registry-v1.json";
export const SCHEMA = "packages/protocol-v3/registry/registry-v1.schema.json";
export const ROOT_WORKFLOW = ".github/workflows/protocol-v3-registry.yml";
export const ORIGINAL_LOCK = "packages/protocol-v3/conformance/reference.lock.json";
export const REGENERATED_LOCK = "packages/protocol-v3/conformance/reference-regen.lock.json";

export interface Entry {
	type: string;
	mode: string;
}
export interface Policy {
	checker: { path: string; sha256: string };
	checkpoint: Record<string, unknown>;
	immutableInputs: Record<string, string>;
	locks: { original: string; regenerated: string };
	protectedPaths: string[];
	protocolMajor: number;
	registryPath: string;
	registryVersion: number;
	schemaVersion: string;
	version: number;
}
export interface SchemaProperty {
	"type"?: string;
	"minimum"?: number;
	"maximum"?: number;
	"const"?: unknown;
	"default"?: unknown;
	"x-registry-type"?: string;
	"x-registry-constraints"?: Record<string, unknown>;
	[key: string]: unknown;
}
export interface KindSchema {
	"type": string;
	"additionalProperties": boolean;
	"required": string[];
	"properties": Record<string, SchemaProperty>;
	"x-domain": string;
	"x-encoding": string;
	"x-canonical-key-order": string;
	[key: string]: unknown;
}
export interface RegistrySchema {
	$defs: Record<string, KindSchema>;
	[key: string]: unknown;
}
export interface RegistryField {
	name: string;
	type: string;
	required: boolean;
	const: unknown;
	constraints: Record<string, unknown>;
	sortRule: unknown;
}
export interface Registry {
	protocolMajor: number;
	registryVersion: number;
	domains: Record<string, string>;
	kinds: Record<string, { domain: string; encoding: string; fields: RegistryField[] }>;
}
export interface Snapshot {
	alternateCodeowners: string[];
	bootstrapConsumed: boolean;
	codeowners: string;
	files: Record<string, string>;
	fileEntries: Record<string, Entry>;
	sources: Record<string, string>;
	locks: { original: Record<string, unknown>; regenerated: Record<string, unknown> };
	policy: Policy;
	preV3: boolean;
	protocolMajor: number;
	registryPath: string;
	registryVersion: number;
	testLifecycle: { ordinaryCi: string; rootConfig: string; workspace: string };
	v2StatusPassed: boolean;
	workflow: string;
}
export interface WorkflowStep {
	"name"?: string;
	"uses"?: string;
	"run"?: string;
	"shell"?: string;
	"env"?: Record<string, string>;
	"with"?: Record<string, unknown>;
	"if"?: string | boolean;
	"continue-on-error"?: boolean;
	[key: string]: unknown;
}
export interface WorkflowJob {
	name?: string;
	steps: WorkflowStep[];
	if?: string | boolean;
	permissions?: Record<string, string>;
	[key: string]: unknown;
}
export interface Workflow {
	name: string;
	on: Record<string, unknown>;
	permissions: Record<string, string>;
	jobs: Record<string, WorkflowJob>;
}
interface InventoryRecord {
	file: string;
	classification: string;
	custody: string;
	fileEntry?: Entry;
	sha256?: string;
}
export interface Contract {
	schemaVersion: string;
	inventory: {
		records: InventoryRecord[];
		semanticSourcePaths: string[];
		semanticOnlyPaths: string[];
		prospectiveByteProtectedPaths: string[];
		newlyByteProtectedPaths: string[];
		preservedSuccessorFixtureClosure: string[];
		affectedCurrentTestFiles: string[];
		proposedNewRedFiles: string[];
		historicalRecordsWhoseLiveTargetsChange: Array<{
			document: string;
			location: string;
			target: string;
			historicalSha256: string;
			historicalProtectedPathCount?: number;
		}>;
		verificationOnlyV2Closure: {
			files: Record<string, string>;
			fileEntries: Record<string, Entry>;
			requiredAbsent: string[];
		};
	};
	runner: string;
	oracle: {
		domain: string;
		cases: Array<{
			id: string;
			input: Record<string, number>;
			byteLength: number;
			canonicalHex: string;
			digestHex: string;
		}>;
	};
	workflowOriginals: Record<string, string>;
	lifecycle: Record<string, string>;
	policyTemplate: Policy;
	schemaTemplate: RegistrySchema;
	schemaMutationIds: string[];
	lifecycleMutationIds: string[];
	transitionMutationIds: string[];
	workflowMutationIds: string[];
	routingMutationIds: string[];
	childCheckers: string[];
	closedTrees: Record<string, string[]>;
	bounds: Record<string, number>;
	fixedCounts: Record<string, number>;
	testIdentities: string[];
	executionCardinality: { testCount: number };
}

export const contract = JSON.parse(
	readFileSync(new URL("./current-registry-contract.json", import.meta.url), "utf8")
) as Contract;

export function clone<T>(value: T): T {
	return structuredClone(value);
}

export function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function json(value: unknown): string {
	return JSON.stringify(value, null, "\t") + "\n";
}

export function parseWorkflow(source: string): Workflow {
	const document = parseDocument(source, { uniqueKeys: true });
	assert.deepEqual(document.errors, [], "workflow YAML must parse without duplicate/shadowed keys");
	return document.toJS() as Workflow;
}

export function workflowYaml(value: Workflow): string {
	return stringify(value, { lineWidth: 0 });
}

export function baseExpression(file: string): string {
	return file.endsWith("protocol-v3-author-authorization.yml")
		? "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}"
		: "${{ github.event.pull_request.base.sha }}";
}

const childByWorkflow: Record<string, string> = {
	"seal-digest-identity": contract.childCheckers[0],
	"pacemaker-profile": contract.childCheckers[1],
	"ed25519-profile": contract.childCheckers[2],
	"blueprint-artifact-profile": contract.childCheckers[3],
	"author-authorization": contract.childCheckers[4],
};

/** Test data only: preserve subsystem/setup steps, replace only obsolete authorization. */
export function prospectiveWorkflow(file: string): string {
	const workflow = parseWorkflow(contract.workflowOriginals[file]);
	workflow.on.pull_request = { types: ["opened", "synchronize", "reopened", "edited", "ready_for_review"] };
	const jobs = Object.values(workflow.jobs);
	assert.equal(jobs.length, 1);
	const job = jobs[0];
	const retained: WorkflowStep[] = [];
	for (const step of job.steps) {
		const run = step.run ?? "";
		const authority =
			/git (?:cat-file|show|merge-base)|check-protocol(?:-v3)?-freeze\.mjs|(?:seal-digest-identity|pacemaker-profile|author-authorization)-v1\/check-freeze\.mjs|check-(?:ed25519|blueprint-artifact)-profile-freeze\.mjs/u.test(
				run
			);
		if (!authority) {
			retained.push(step);
			continue;
		}
		const intrinsic = run
			.split("\n")
			.filter((line) =>
				/^node packages\/protocol-v3\/supplements\/equivocation-(?:digest-identity|evidence-projection)-v1\/check-freeze\.mjs /u.test(
					line
				)
			);
		if (intrinsic.length > 0)
			retained.push({
				name: "Preserved equivocation integrity",
				env: { BASE_SHA: baseExpression(file) },
				run: intrinsic.join("\n") + "\n",
			});
	}
	const nodeIndex = retained.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
	assert.ok(nodeIndex >= 0);
	retained.splice(nodeIndex + 1, 0, {
		name: "Run base-governed current registry transition",
		shell: "bash",
		env: { BASE_SHA: baseExpression(file) },
		run: contract.runner,
	});
	const suffix = file.slice(".github/workflows/protocol-v3-".length, -4);
	const child = childByWorkflow[suffix];
	if (child !== undefined) retained.push({ name: "Validate child integrity only", run: `node ${child}` });
	job.steps = retained;
	return workflowYaml(workflow);
}

export interface Capture {
	bytes: Record<string, string>;
	entries: Record<string, Entry>;
}

/** One UTF-8 read per present governed path; source views never trigger a reread. */
export function capture(root = ROOT): Capture {
	const bytes: Record<string, string> = {};
	const entries: Record<string, Entry> = {};
	assert.equal(realpathSync(root), root, "capture root must be canonical");
	for (const item of contract.inventory.records) {
		const absolute = join(root, item.file);
		if (item.custody === "required-absent") {
			assert.throws(() => lstatSync(absolute), { code: "ENOENT" }, item.file);
			continue;
		}
		const stat = lstatSync(absolute);
		assert.ok(stat.isFile() && !stat.isSymbolicLink(), item.file);
		assert.equal(realpathSync(absolute), absolute, "no symlink ancestors in trusted capture");
		const entry = { type: "blob", mode: stat.mode & 0o111 ? "100755" : "100644" };
		assert.deepEqual(entry, item.fileEntry, item.file);
		bytes[item.file] = readFileSync(absolute, "utf8");
		entries[item.file] = entry;
	}
	const visitClosedTree = (directory: string): void => {
		for (const item of readdirSync(join(root, directory), { withFileTypes: true })) {
			const file = `${directory}/${item.name}`;
			if (item.isDirectory()) {
				visitClosedTree(file);
				continue;
			}
			if (Object.hasOwn(bytes, file)) continue;
			const absolute = join(root, file);
			const stat = lstatSync(absolute);
			assert.ok(stat.isFile() && !stat.isSymbolicLink(), "closed trees cannot hide non-regular entries");
			bytes[file] = readFileSync(absolute, "utf8");
			entries[file] = { type: "blob", mode: stat.mode & 0o111 ? "100755" : "100644" };
		}
	};
	for (const directory of Object.keys(contract.closedTrees)) visitClosedTree(directory);
	return { bytes, entries };
}

type SnapshotViews = Pick<
	Snapshot,
	| "policy"
	| "locks"
	| "protocolMajor"
	| "registryVersion"
	| "registryPath"
	| "workflow"
	| "codeowners"
	| "testLifecycle"
>;

function boundViews(source: Snapshot["sources"]): SnapshotViews {
	const policy = JSON.parse(source[POLICY]) as Policy;
	const locks = {
		original: JSON.parse(source[ORIGINAL_LOCK]) as Record<string, unknown>,
		regenerated: JSON.parse(source[REGENERATED_LOCK]) as Record<string, unknown>,
	};
	const registry = JSON.parse(source[REGISTRY]) as Registry;
	return {
		policy,
		locks,
		protocolMajor: registry.protocolMajor,
		registryVersion: registry.registryVersion,
		registryPath: REGISTRY,
		workflow: source[ROOT_WORKFLOW],
		codeowners: source.CODEOWNERS,
		testLifecycle: {
			rootConfig: source["vite.config.mts"],
			workspace: source["vitest.workspace.ts"],
			ordinaryCi: source[".github/workflows/test.yml"],
		},
	};
}

export function deriveViews(snapshot: Snapshot): void {
	Object.assign(snapshot, boundViews(snapshot.sources));
}

export function snapshotFromCapture(captured: Capture): Snapshot {
	const sources = Object.fromEntries(
		contract.inventory.semanticSourcePaths.map((file) => [file, captured.bytes[file]])
	);
	return {
		alternateCodeowners: [],
		bootstrapConsumed: true,
		files: Object.fromEntries(Object.entries(captured.bytes).map(([file, bytes]) => [file, sha256(bytes)])),
		fileEntries: clone(captured.entries),
		sources,
		preV3: false,
		v2StatusPassed: true,
		...boundViews(sources),
	};
}

/** Independent prospective fixture, never production code and never an obsolete-tree adapter. */
export function prospectiveCapture(captured = capture()): Capture {
	const result = clone(captured);
	const schema = clone(contract.schemaTemplate);
	schema.$defs.parameters.properties = {
		authorShareMultiplier: {
			"type": "integer",
			"x-registry-type": "safe-integer",
			"x-registry-constraints": { minimum: 1, maximum: 1000000 },
			"minimum": 1,
			"maximum": 1000000,
		},
		...schema.$defs.parameters.properties,
	};
	result.bytes[SCHEMA] = json(schema);
	for (const file of Object.keys(contract.workflowOriginals)) result.bytes[file] = prospectiveWorkflow(file);
	const policy = clone(contract.policyTemplate);
	policy.protectedPaths = [...contract.inventory.prospectiveByteProtectedPaths];
	policy.immutableInputs = Object.fromEntries(policy.protectedPaths.map((file) => [file, sha256(result.bytes[file])]));
	policy.checker.sha256 = sha256(result.bytes[CHECKER]);
	policy.checkpoint.baselineAmendment =
		"D.110c: explicitly reviewed prospective current development baseline; registry version 1 includes the already signed optional authorShareMultiplier. This is not approval by the obsolete seven-field policy.";
	policy.checkpoint.historicalEvidenceScope =
		"Historical version-1 references, signatures and attestations retain their original seven-field scope; no live-root repinning or reverse authority edge.";
	policy.checkpoint.localEvidenceLimits =
		"Local evidence does not install or verify host enforcement. Future registry changes require a separately reviewed baseline amendment and required version bump; no in-band exception.";
	result.bytes[POLICY] = json(policy);
	return result;
}

export function knownGood(): Snapshot {
	return snapshotFromCapture(prospectiveCapture());
}

/** Candidate source edit: update binding/views, deliberately leave independent base untouched. */
export function replaceSource(snapshot: Snapshot, file: string, source: string): void {
	assert.ok(Object.hasOwn(snapshot.sources, file), "closed source roster");
	snapshot.sources[file] = source;
	snapshot.files[file] = sha256(source);
	deriveViews(snapshot);
}

/** Invalid-base semantics are separately re-pinned, including policy bytes, never self-hashed. */
export function repinInvalidBase(snapshot: Snapshot): void {
	for (const [file, source] of Object.entries(snapshot.sources)) snapshot.files[file] = sha256(source);
	const policy = JSON.parse(snapshot.sources[POLICY]) as Policy;
	policy.immutableInputs = Object.fromEntries(policy.protectedPaths.map((file) => [file, snapshot.files[file]]));
	policy.checker.sha256 = snapshot.files[CHECKER];
	snapshot.sources[POLICY] = json(policy);
	snapshot.files[POLICY] = sha256(snapshot.sources[POLICY]);
	deriveViews(snapshot);
	assertBound(snapshot);
}

export function assertBound(snapshot: Snapshot): void {
	assert.deepEqual(Object.keys(snapshot.sources).sort(), [...contract.inventory.semanticSourcePaths].sort());
	assert.deepEqual(Object.keys(snapshot.files).sort(), Object.keys(snapshot.fileEntries).sort());
	for (const [file, source] of Object.entries(snapshot.sources))
		assert.equal(sha256(source), snapshot.files[file], file);
	assert.equal(Object.hasOwn(snapshot.policy.immutableInputs, POLICY), false, "no circular policy self hash");
	assert.deepEqual(Object.keys(snapshot.policy.immutableInputs).sort(), [...snapshot.policy.protectedPaths].sort());
	for (const file of snapshot.policy.protectedPaths)
		assert.equal(snapshot.policy.immutableInputs[file], snapshot.files[file], file);
}
