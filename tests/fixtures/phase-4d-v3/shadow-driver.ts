/* eslint-disable import/order, jsdoc/require-jsdoc, sort-imports -- the tests-only driver keeps original/current owner namespaces visibly separate */
import { compareBytes, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import type { Message } from "@ts-drp/types";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import blueprintPackage from "../phase-4a-v3/blueprint-package.json" with { type: "json" };
import snapshotContract from "../phase-4b-v3/blueprint-snapshot-contract.json" with { type: "json" };
import {
	prepareBlueprintAdmission,
	prepareBlueprintRuntime,
	type PreparedBlueprintRuntime,
} from "../../../packages/protocol-v3/src/public.js";
import {
	BlueprintStateMachine,
	foldBlueprintEpoch,
	type BlueprintStateSnapshot,
} from "../../../packages/compaction/src/blueprint-fold.js";
import { exportBlueprintSnapshotPayload } from "../../../packages/compaction/src/blueprint-snapshot.js";
import { encodeCanonical as referenceEncodeCanonical } from "../../../packages/protocol-v2/conformance/ahe-reference/src/canonical.js";
import { foldEpoch as referenceFoldEpoch } from "../../../packages/protocol-v2/conformance/ahe-reference/src/fold.js";
import {
	bytesToHex as referenceBytesToHex,
	hashDomain as referenceHashDomain,
} from "../../../packages/protocol-v2/conformance/ahe-reference/src/hash.js";
import { DeterministicStateMachine as ReferenceStateMachine } from "../../../packages/protocol-v2/conformance/ahe-reference/src/state.js";
import { activateV3LivePlane, bindV3BlueprintLivePlane } from "../../../packages/node/src/v3-live.js";

import { createGenuinePreparedV3Fixture } from "../phase-3a1b-p3/live-fixture.js";
import {
	EXPECTED_REFERENCE_SAMPLES,
	FOREIGN_AUTHOR,
	OBJECT_ID,
	REFERENCE_HASHES,
	REFERENCE_SAMPLE_INTERVAL,
	SHADOW_CLOSES,
	SHADOW_SEED,
	STATE_DOMAIN,
	type ShadowCloseObservation,
	type ShadowIdentity,
	type ShadowStateObservation,
	type ShadowTypeScriptObservation,
	WRITER,
} from "./shadow-contract.js";
import { fakeNetwork, recover } from "../phase-4b-v3/live-snapshot.js";

type PlainState = { map: Record<string, string>; set: string[]; total: number };
type Operation =
	| Readonly<{ action: "add_mul"; add: number; multiplier: number }>
	| Readonly<{ action: "map_set"; key: string; value: string }>
	| Readonly<{ action: "set_add"; value: string }>;

interface EpochVertex {
	readonly anchor?: string;
	readonly author?: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly hash: string;
	readonly kind: "drp-epoch-anchor" | "drp-vertex";
	readonly objectId: string;
	readonly operation?: Operation;
}

interface FoldCurrentResult {
	readonly order: readonly string[];
	readonly snapshot: BlueprintStateSnapshot;
}

export interface LivePeerCheckpoint {
	readonly engineA: ShadowTypeScriptObservation;
	readonly engineB: ShadowTypeScriptObservation;
}

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const ARTIFACT_PATH = path.join(REPOSITORY_ROOT, "tests/fixtures/phase-4a-v3/application-blueprint.mjs");
const REFERENCE_DIRECTORY = path.join(REPOSITORY_ROOT, "packages/protocol-v2/conformance/ahe-reference/src");
const artifactBytes = new Uint8Array(readFileSync(ARTIFACT_PATH));
const exactCanonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
const expectedBlueprintDigest = bytesHex(
	hashDomain("ts-drp/blueprint-admission/v3", exactCanonicalBlueprintPackageBytes)
);
const exactCanonicalAclBytes = encodeCanonical(snapshotContract.acl);
const INITIAL_STATE: PlainState = Object.freeze({ map: Object.freeze({}), set: Object.freeze([]), total: 1 });

function bytesHex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function authenticateReferenceClosure(): Readonly<Record<string, string>> {
	const observed: Record<string, string> = {};
	for (const [name, expected] of Object.entries(REFERENCE_HASHES)) {
		const actual = sha256(new Uint8Array(readFileSync(path.join(REFERENCE_DIRECTORY, name))));
		if (actual !== expected) throw new TypeError(`reference hash mismatch: ${name}`);
		observed[name] = actual;
	}
	return Object.freeze(observed);
}

function assertPlainSubset(value: unknown, seen = new Set<object>()): void {
	if (value === null || typeof value === "boolean" || typeof value === "string") return;
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
			throw new TypeError("shadow fixture value is outside the reference/v3 integer subset");
		}
		return;
	}
	if (typeof value !== "object" || seen.has(value)) throw new TypeError("shadow fixture value is not plain data");
	seen.add(value);
	if (Array.isArray(value)) {
		for (const entry of value) assertPlainSubset(entry, seen);
		seen.delete(value);
		return;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("shadow fixture value is not a plain object");
	}
	if (Object.getOwnPropertySymbols(value).length !== 0) {
		throw new TypeError("shadow fixture symbols are forbidden");
	}
	for (const key of Object.keys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
			throw new TypeError("shadow fixture accessors are forbidden");
		}
		assertPlainSubset(descriptor.value, seen);
	}
	seen.delete(value);
}

export function assertReferenceSubset(value: unknown): void {
	assertPlainSubset(value);
}

function cloneState(state: PlainState): PlainState {
	return {
		map: { ...state.map },
		set: [...state.set],
		total: state.total,
	};
}

function applyPlainOperation(state: PlainState, operation: Operation): PlainState {
	assertReferenceSubset(operation);
	const next = cloneState(state);
	if (operation.action === "map_set") next.map[operation.key] = operation.value;
	else if (operation.action === "set_add") {
		if (!next.set.includes(operation.value)) next.set.push(operation.value);
	} else next.total = (next.total + operation.add) * operation.multiplier;
	assertReferenceSubset(next);
	return next;
}

function anchorFor(epoch: number): string {
	return (epoch + 1).toString(16).padStart(64, "0");
}

function vertexHash(epoch: number, index: number): string {
	return (10_000 + epoch * 8 + index).toString(16).padStart(64, "0");
}

function operationsFor(epoch: number): readonly Operation[] {
	return Object.freeze([
		Object.freeze({ action: "map_set" as const, key: `key-${epoch % 7}`, value: `value-${epoch}` }),
		Object.freeze({ action: "set_add" as const, value: `member-${epoch % 11}` }),
		Object.freeze({ action: "add_mul" as const, add: (epoch % 3) + 1, multiplier: 1 }),
	]);
}

function graphFor(epoch: number, operations: readonly Operation[], author = WRITER): Map<string, EpochVertex> {
	const anchor = anchorFor(epoch);
	const graph = new Map<string, EpochVertex>([
		[
			anchor,
			Object.freeze({
				dependencies: Object.freeze([]),
				epoch,
				hash: anchor,
				kind: "drp-epoch-anchor" as const,
				objectId: OBJECT_ID,
			}),
		],
	]);
	let dependency = anchor;
	for (const [index, operation] of operations.entries()) {
		const hash = vertexHash(epoch, index);
		graph.set(
			hash,
			Object.freeze({
				anchor,
				author,
				dependencies: Object.freeze([dependency]),
				epoch,
				hash,
				kind: "drp-vertex" as const,
				objectId: OBJECT_ID,
				operation,
			})
		);
		dependency = hash;
	}
	return graph;
}

function identity(epoch: number): ShadowIdentity {
	return Object.freeze({
		anchor: anchorFor(epoch),
		blueprintDigest: expectedBlueprintDigest,
		epoch,
		objectId: OBJECT_ID,
	});
}

function stateDigest(bytes: Uint8Array): string {
	return bytesHex(hashDomain(STATE_DOMAIN, bytes));
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

function createMachine(runtime: PreparedBlueprintRuntime): BlueprintStateMachine {
	const initialBytes = encodeCanonical(INITIAL_STATE);
	return new BlueprintStateMachine({
		exactCanonicalInitialStateBytes: initialBytes,
		expectedBlueprintDigest,
		expectedInitialStateDigest: stateDigest(initialBytes),
		preparedBlueprintRuntime: runtime,
	});
}

function foldCurrent(
	machine: BlueprintStateMachine,
	epoch: number,
	operations: readonly Operation[]
): FoldCurrentResult {
	const graph = graphFor(epoch, operations);
	const folded = foldBlueprintEpoch({
		anchorHash: anchorFor(epoch),
		authorize: ({ hash }) => graph.get(hash)?.author === WRITER,
		machine,
		vertices: graph,
	});
	return { order: folded.order, snapshot: folded.adopt() };
}

function typeScriptObservation(
	epoch: number,
	order: readonly string[],
	machine: BlueprintStateMachine
): ShadowTypeScriptObservation {
	const snapshot = machine.snapshot();
	const exported = exportBlueprintSnapshotPayload({
		anchor: anchorFor(epoch),
		archiveIndexRoot: snapshotContract.metadata.archiveIndexRoot,
		epoch,
		exactCanonicalAclBytes,
		machine,
		maxSnapshotBytes: snapshotContract.limits.maxSnapshotBytes,
		objectId: OBJECT_ID,
		schemaVersion: snapshotContract.metadata.schemaVersion,
	});
	return Object.freeze({
		...identity(epoch),
		exactCanonicalStateBytes: snapshot.exactCanonicalStateBytes,
		order: Object.freeze([...order]),
		payloadDigest: exported.payloadDigest,
		stateDigest: snapshot.stateDigest,
	});
}

function stateObservation(epoch: number, snapshot: BlueprintStateSnapshot): ShadowStateObservation {
	return Object.freeze({
		...identity(epoch),
		exactCanonicalStateBytes: snapshot.exactCanonicalStateBytes,
		stateDigest: snapshot.stateDigest,
	});
}

function referenceAuthorizer(vertex: EpochVertex, _plane: string, authority: { writers: readonly string[] }): boolean {
	return vertex.author !== undefined && authority.writers.includes(vertex.author);
}

function referenceMachine(initialState: PlainState): InstanceType<typeof ReferenceStateMachine> {
	return new ReferenceStateMachine({
		initialState,
		reduce: (state: PlainState, operation: Operation) => applyPlainOperation(state, operation),
	});
}

async function foldReference(
	application: InstanceType<typeof ReferenceStateMachine>,
	epoch: number,
	operations: readonly Operation[],
	author = WRITER
): Promise<ShadowStateObservation> {
	const acl = new ReferenceStateMachine({
		initialState: { writers: [WRITER] },
		reduce: (state: unknown): unknown => state,
	});
	const folded = await referenceFoldEpoch({
		acl,
		anchorHash: anchorFor(epoch),
		application,
		authorize: referenceAuthorizer,
		vertices: graphFor(epoch, operations, author),
	});
	folded.adopt();
	const state = application.snapshot() as PlainState;
	assertReferenceSubset(state);
	const bytes = referenceEncodeCanonical(state);
	const digest = referenceBytesToHex(await referenceHashDomain(STATE_DOMAIN, bytes));
	return Object.freeze({ ...identity(epoch), exactCanonicalStateBytes: bytes, stateDigest: digest });
}

export async function assertReferenceAuthorizationRejectsForeignWriter(): Promise<void> {
	const application = referenceMachine(INITIAL_STATE);
	let rejected = false;
	try {
		await foldReference(application, 0, operationsFor(0), FOREIGN_AUTHOR);
	} catch {
		rejected = true;
	}
	if (!rejected) throw new TypeError("reference authorizer accepted a foreign writer");
}

export async function referenceVector(value: unknown): Promise<Readonly<{ bytes: Uint8Array; digest: string }>> {
	assertReferenceSubset(value);
	const bytes = referenceEncodeCanonical(value);
	return Object.freeze({ bytes, digest: referenceBytesToHex(await referenceHashDomain(STATE_DOMAIN, bytes)) });
}

export async function buildShadowRun(): Promise<readonly ShadowCloseObservation[]> {
	const [runtimeA, runtimeB, runtimeArchive] = await Promise.all([
		prepareRuntime(),
		prepareRuntime(),
		prepareRuntime(),
	]);
	const machineA = createMachine(runtimeA);
	const machineB = createMachine(runtimeB);
	const reference = referenceMachine(INITIAL_STATE);
	const fixtures: Array<readonly Operation[]> = [];
	const observations: ShadowCloseObservation[] = [];
	for (let epoch = 0; epoch < SHADOW_CLOSES; epoch++) {
		const operations = operationsFor(epoch);
		fixtures.push(operations);
		const resultA = foldCurrent(machineA, epoch, operations);
		const resultB = foldCurrent(machineB, epoch, operations);
		const archive = createMachine(runtimeArchive);
		let archiveResult: ReturnType<typeof foldCurrent> | undefined;
		for (const [replayEpoch, replayOperations] of fixtures.entries()) {
			archiveResult = foldCurrent(archive, replayEpoch, replayOperations);
		}
		if (archiveResult === undefined) throw new TypeError("archival replay executed zero epochs");
		const referenceObservation = await foldReference(reference, epoch, operations);
		observations.push(
			Object.freeze({
				appliedVertices: operations.length,
				archival: stateObservation(epoch, archiveResult.snapshot),
				engineA: typeScriptObservation(epoch, resultA.order, machineA),
				engineB: typeScriptObservation(epoch, resultB.order, machineB),
				reference:
					(epoch + 1) % REFERENCE_SAMPLE_INTERVAL === 0
						? Object.freeze({ kind: "observed" as const, value: referenceObservation })
						: Object.freeze({ kind: "not-sampled" as const }),
				seed: SHADOW_SEED,
			})
		);
	}
	const referenceSamples = observations.filter((entry) => entry.reference.kind === "observed").length;
	if (referenceSamples !== EXPECTED_REFERENCE_SAMPLES) {
		throw new TypeError("shadow reference sample schedule drifted");
	}
	return Object.freeze(observations);
}

export async function runLivePeerCheckpoint(): Promise<LivePeerCheckpoint> {
	const initialStateBytes = encodeCanonical(0);
	const fixture = await createGenuinePreparedV3Fixture({
		authorizationMode: "latched-acl",
		exactCanonicalInitialStateBytes: initialStateBytes,
	});
	try {
		const second = await fixture.prepareAgain();
		const recovered = await Promise.all([recover(fixture, fixture.capability), recover(fixture, second.capability)]);
		const activations = recovered.map((entry, index) =>
			activateV3LivePlane({
				capability: entry.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork(`peer:phase4d:${index}`),
				onAdmittedVertex: () => undefined,
			})
		);
		if (!activations[0]?.ok || !activations[1]?.ok) throw new TypeError("shadow live activation failed");
		const bindings = activations.map((activation) =>
			bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: initialStateBytes, plane: activation.handle })
		);
		if (!bindings[0]?.ok || !bindings[1]?.ok) throw new TypeError("shadow live binding failed");
		const staged = await Promise.all(bindings.map((binding) => binding.handle.stageBlueprintEpoch()));
		if (!staged[0]?.ok || !staged[1]?.ok) throw new TypeError("shadow live fold failed");
		const adopted = staged.map((entry) => entry.adopt());
		if (!adopted[0]?.ok || !adopted[1]?.ok) throw new TypeError("shadow live adoption failed");
		const exported = bindings.map((binding) => binding.handle.exportSnapshotPayload());
		if (!exported[0]?.ok || !exported[1]?.ok) throw new TypeError("shadow live export failed");
		const makeObservation = (index: 0 | 1): ShadowTypeScriptObservation => {
			const selected = staged[index];
			const payload = exported[index];
			if (!selected?.ok || !payload?.ok) throw new TypeError("shadow live observation is unavailable");
			return Object.freeze({
				anchor: fixture.anchorDigest,
				blueprintDigest: selected.staged.blueprintDigest,
				epoch: 0,
				exactCanonicalStateBytes: selected.staged.exactCanonicalStateBytes,
				objectId: fixture.objectId,
				order: selected.order,
				payloadDigest: payload.payloadDigest,
				stateDigest: selected.staged.stateDigest,
			});
		};
		return Object.freeze({ engineA: makeObservation(0), engineB: makeObservation(1) });
	} finally {
		await fixture.close();
	}
}

export function currentAndReferenceAgree(value: unknown): Promise<boolean> {
	return referenceVector(value).then(
		(reference) =>
			compareBytes(reference.bytes, encodeCanonical(value)) === 0 &&
			reference.digest === stateDigest(encodeCanonical(value))
	);
}
