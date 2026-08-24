import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { prepareBlueprintAdmission, prepareBlueprintRuntime, type PreparedBlueprintRuntime } from "@ts-drp/protocol-v3";
import { type DRPNetworkNode, type Message, MessageType, V3Envelope } from "@ts-drp/types";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import {
	fakeNetwork,
	type GenuinePreparedV3Fixture,
	recover,
	type RecoveredV3Live,
} from "./fixtures/phase-4b-v3/live-snapshot.js";
import packageGolden from "./fixtures/track-p2-b/forward-counter-package.json" with { type: "json" };
import { BlueprintStateMachine } from "../packages/compaction/src/blueprint-fold.js";
import { exportBlueprintSnapshotPayload } from "../packages/compaction/src/blueprint-snapshot.js";
import {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	type PreparedV3Live,
	republishV3RetainedTo,
	routeV3Ingress,
	routeV3RetainedIngress,
	type V3PlaneActivationInput,
	type V3PlaneActivationResult,
	type V3PlaneHandle,
} from "../packages/node/src/v3-live.js";
import {
	type LatchedAclOperation,
	openCanonicalLatchedAclSnapshot,
	stageLatchedAclOperations,
} from "../packages/protocol-v3/src/latched-acl.js";

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const SNAPSHOT_SCHEMA_VERSION = 1;
const PAYLOAD_DOMAIN = "ts-drp/snapshot-payload/v3";
const LATCHED_ACL_ARTIFACT_SOURCE = `function aclReducer(input){return {output:null,state:input.state}}function addReducer(input){const value=input.operation.value??1;const state=input.state+value;return {output:state,state}}function readReducer(input){return {output:input.state,state:input.state}}function setReducer(input){const state=input.operation.value??0;return {output:state,state}}export const blueprint={exportSchemaVersion:1,artifactId:"counter.v1",runtimeProfile:"ecmascript-2024-sync-v1",reducers:{acl:aclReducer,add:addReducer,"read-value":readReducer,set:setReducer}};`;
const V3_LIVE_EXPORT_ROSTER = Object.freeze([
	"PrepareV3LiveFailureKind",
	"PrepareV3LiveGenerationInput",
	"PrepareV3LiveResult",
	"PreparedV3Live",
	"RecoverV3LiveReplicaFailureKind",
	"RecoverV3LiveReplicaInput",
	"RecoverV3LiveReplicaResult",
	"RecoveredV3Live",
	"V3AdmittedVertexSink",
	"V3EgressResult",
	"V3LiveDescriptor",
	"V3LocalIssueInput",
	"V3LocalIssueResult",
	"V3PlaneActivationFailureKind",
	"V3PlaneActivationInput",
	"V3PlaneActivationResult",
	"V3PlaneHandle",
	"V3TerminalPublishResult",
	"V3TerminalTransitionResult",
	"V3TerminalVertexClassifier",
	"activateV3LivePlane",
	"bindV3BlueprintLivePlane",
	"prepareV3LiveGeneration",
	"recoverV3LiveReplica",
	"republishV3RetainedTo",
	"routeV3Ingress",
	"routeV3RetainedIngress",
]);
const FORBIDDEN_ROOT_AUTHORITY = Object.freeze([
	"BlueprintStateMachine",
	"exportBlueprintSnapshotPayload",
	"importBlueprintSnapshotPayload",
	"activateV3LivePlane",
	"bindV3BlueprintLivePlane",
	"exportSnapshotPayload",
]);

type SnapshotExportResult =
	| Readonly<{
			readonly ok: true;
			readonly kind: "exported";
			readonly applicationStateDigest: string;
			readonly exactCanonicalPayloadBytes: Uint8Array;
			readonly payloadDigest: string;
	  }>
	| Readonly<{
			readonly ok: false;
			readonly kind: "acl-rejected" | "authorization-rejected" | "not-active" | "not-adopted";
			readonly detail: string;
	  }>;

let surfacesReady = false;

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function detached(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
}

function digest(domain: string, bytes: Uint8Array): string {
	return hex(hashDomain(domain, bytes));
}

function exportedNames(sourceText: string): readonly string[] {
	const unit = ts.createSourceFile("module.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const names: string[] = [];
	for (const statement of unit.statements) {
		if (
			ts.isExportDeclaration(statement) &&
			statement.exportClause !== undefined &&
			ts.isNamedExports(statement.exportClause)
		) {
			for (const element of statement.exportClause.elements) names.push(element.name.text);
		}
		if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement)) &&
			statement.name !== undefined &&
			statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
		) {
			names.push(statement.name.text);
		}
	}
	return names.sort();
}

function silentQueue(): MessageQueueManager<Message> {
	return new MessageQueueManager<Message>({ logConfig: { level: "silent" } });
}

function genesisInput(
	capability: RecoveredV3Live,
	networkNode: DRPNetworkNode,
	messageQueueManager = silentQueue()
): V3PlaneActivationInput {
	return {
		capability,
		messageQueueManager,
		networkNode,
		onAdmittedVertex: vi.fn(),
	};
}

function snapshotInput(
	capability: RecoveredV3Live,
	networkNode: DRPNetworkNode,
	payload: Readonly<{
		readonly exactCanonicalPayloadBytes: Uint8Array;
		readonly expectedApplicationStateDigest: string;
		readonly expectedPayloadDigest: string;
	}>,
	messageQueueManager = silentQueue(),
	onAdmittedVertex: V3PlaneActivationInput["onAdmittedVertex"] = vi.fn()
): V3PlaneActivationInput {
	return {
		capability,
		exactCanonicalPayloadBytes: payload.exactCanonicalPayloadBytes,
		expectedApplicationStateDigest: payload.expectedApplicationStateDigest,
		expectedPayloadDigest: payload.expectedPayloadDigest,
		messageQueueManager,
		networkNode,
		onAdmittedVertex,
	} as V3PlaneActivationInput;
}

function activateGenesis(
	capability: RecoveredV3Live,
	peerId: string,
	messageQueueManager = silentQueue()
): V3PlaneActivationResult {
	return activateV3LivePlane(genesisInput(capability, fakeNetwork(peerId), messageQueueManager));
}

function exportSnapshotPayload(handle: object): SnapshotExportResult {
	const method = Reflect.get(handle, "exportSnapshotPayload");
	if (typeof method !== "function") throw new TypeError("live snapshot export is unavailable");
	return Reflect.apply(method, handle, []) as SnapshotExportResult;
}

function retrieveSnapshotHandle(plane: V3PlaneHandle): ReturnType<typeof bindV3BlueprintLivePlane> {
	return bindV3BlueprintLivePlane({ plane } as Parameters<typeof bindV3BlueprintLivePlane>[0]);
}

function signedAnchorRecord(fixture: GenuinePreparedV3Fixture): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(detached(fixture.exactCanonicalAnchorPreimageBytes));
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("signed anchor preimage is invalid");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

function signedAnchorMetadata(fixture: GenuinePreparedV3Fixture): {
	readonly anchor: string;
	readonly archiveIndexRoot: string;
	readonly epoch: number;
	readonly objectId: string;
} {
	const anchor = signedAnchorRecord(fixture);
	if (typeof anchor.archiveIndexRoot !== "string" || typeof anchor.epoch !== "number") {
		throw new TypeError("signed anchor metadata is invalid");
	}
	return {
		anchor: fixture.anchorDigest,
		archiveIndexRoot: anchor.archiveIndexRoot,
		epoch: anchor.epoch,
		objectId: fixture.objectId,
	};
}

function openedLatchedAcl(fixture: GenuinePreparedV3Fixture): ReturnType<typeof openCanonicalLatchedAclSnapshot> {
	const bytes = fixture.exactCanonicalLatchedAclBytes;
	if (bytes === undefined) throw new TypeError("latched ACL bytes are required");
	const anchor = signedAnchorRecord(fixture);
	if (typeof anchor.aclDigest !== "string") throw new TypeError("signed aclDigest is invalid");
	return openCanonicalLatchedAclSnapshot({
		exactCanonicalLatchedAclBytes: detached(bytes),
		expectedAclDigest: anchor.aclDigest,
		expectedEpoch: 0,
		expectedObjectId: fixture.objectId,
	});
}

function nextAclOperation(fixture: GenuinePreparedV3Fixture): LatchedAclOperation {
	return Object.freeze({
		actor: fixture.author,
		group: "writer",
		kind: "grant",
		target: fixture.author === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64),
	});
}

function nextAclApplicationOperation(fixture: GenuinePreparedV3Fixture): Readonly<Record<string, unknown>> {
	const operation = nextAclOperation(fixture);
	return Object.freeze({
		action: "acl",
		group: operation.group,
		kind: operation.kind,
		target: operation.target,
	});
}

function independentNextAclBytes(fixture: GenuinePreparedV3Fixture): Uint8Array {
	const opened = openedLatchedAcl(fixture);
	if (!opened.ok) throw new TypeError("authenticated latched ACL could not be opened");
	const staged = stageLatchedAclOperations({ operations: [nextAclOperation(fixture)], snapshot: opened.snapshot });
	if (!staged.ok) throw new TypeError("next ACL could not be derived");
	return encodeCanonical(staged.next);
}

function prepareLatchedRuntime(fixture: GenuinePreparedV3Fixture): Promise<PreparedBlueprintRuntime> {
	const exactArtifactBytes = new TextEncoder().encode(LATCHED_ACL_ARTIFACT_SOURCE);
	const artifactDigest = hex(hashDomain(packageGolden.artifactDigestDomain, exactArtifactBytes));
	const packageRecord = Object.freeze({
		...packageGolden.package,
		implementation: Object.freeze({ ...packageGolden.package.implementation, artifactDigest }),
		manifest: Object.freeze({
			...packageGolden.package.manifest,
			operations: Object.freeze([
				Object.freeze({
					argumentSchema: Object.freeze({
						fields: Object.freeze([
							Object.freeze({ name: "group", required: true, type: "string" }),
							Object.freeze({ name: "kind", required: true, type: "string" }),
							Object.freeze({ name: "target", required: true, type: "string" }),
						]),
						kind: "closed-record",
					}),
					name: "acl",
				}),
				...packageGolden.package.manifest.operations,
			]),
		}),
	});
	const canonicalBlueprintPackageBytes = encodeCanonical(packageRecord);
	const expectedBlueprintDigest = hex(hashDomain(packageGolden.blueprintDigestDomain, canonicalBlueprintPackageBytes));
	if (expectedBlueprintDigest !== fixture.descriptor.blueprintDigest) {
		throw new TypeError("independent blueprint identity does not match the authenticated fixture");
	}
	const admission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes,
		expectedBlueprintDigest,
	});
	return prepareBlueprintRuntime({
		canonicalBlueprintPackageBytes,
		exactArtifactBytes,
		expectedBlueprintDigest,
		preparedBlueprintAdmission: admission,
	});
}

async function independentSnapshotPayload(
	fixture: GenuinePreparedV3Fixture,
	adopted: Readonly<{
		readonly blueprintDigest: string;
		readonly exactCanonicalStateBytes: Uint8Array;
		readonly stateDigest: string;
	}>
): Promise<ReturnType<typeof exportBlueprintSnapshotPayload>> {
	const runtime = await prepareLatchedRuntime(fixture);
	const machine = new BlueprintStateMachine({
		exactCanonicalInitialStateBytes: detached(adopted.exactCanonicalStateBytes),
		expectedBlueprintDigest: adopted.blueprintDigest,
		expectedInitialStateDigest: adopted.stateDigest,
		preparedBlueprintRuntime: runtime,
	});
	const metadata = signedAnchorMetadata(fixture);
	return exportBlueprintSnapshotPayload({
		anchor: metadata.anchor,
		archiveIndexRoot: metadata.archiveIndexRoot,
		epoch: metadata.epoch,
		exactCanonicalAclBytes: independentNextAclBytes(fixture),
		machine,
		maxSnapshotBytes: fixture.parameters.maxSnapshotBytes,
		objectId: metadata.objectId,
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
	});
}

function mutatedPayloadBytes(
	exported: ReturnType<typeof exportBlueprintSnapshotPayload>,
	mutate: (payload: Record<string, unknown>) => void
): Uint8Array {
	const payload = decodeCanonical(detached(exported.exactCanonicalPayloadBytes)) as Record<string, unknown>;
	mutate(payload);
	return encodeCanonical(payload);
}

async function foldAdoptedHandle(
	fixture: GenuinePreparedV3Fixture,
	capability: PreparedV3Live,
	peerId: string
): Promise<
	Readonly<{
		readonly activation: Extract<V3PlaneActivationResult, { readonly ok: true }>;
		readonly adopted: Readonly<{
			readonly blueprintDigest: string;
			readonly exactCanonicalStateBytes: Uint8Array;
			readonly stateDigest: string;
		}>;
		readonly aclOperationDigest: string;
		readonly handle: object;
		readonly recovered: Awaited<ReturnType<typeof recover>>;
	}>
> {
	const recovered = await recover(fixture, capability);
	const activation = activateGenesis(recovered.capability, peerId);
	if (!activation.ok) throw new TypeError("activation failed");
	const binding = bindV3BlueprintLivePlane({
		exactCanonicalInitialStateBytes: encodeCanonical(0),
		plane: activation.handle,
	});
	if (!binding.ok) throw new TypeError("binding failed");
	const issuedAcl = await activation.handle.issueLocal({
		operations: Object.freeze([Object.freeze({ logicalTime: 1, operation: nextAclApplicationOperation(fixture) })]),
		signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
	});
	if (!issuedAcl.ok) throw new TypeError(`accepted ACL operation failed: ${issuedAcl.kind}`);
	const staged = await binding.handle.stageBlueprintEpoch();
	if (!staged.ok) throw new TypeError("fold failed");
	const adopted = staged.adopt();
	if (!adopted.ok) throw new TypeError("adoption failed");
	return Object.freeze({
		aclOperationDigest: issuedAcl.digest,
		activation,
		adopted: adopted.snapshot,
		handle: binding.handle,
		recovered,
	});
}

function expectClosedFailure(result: { readonly ok: boolean; readonly kind?: string }, kind: string): void {
	expect(result.ok).toBe(false);
	expect(result.kind).toBe(kind);
	expect(result).not.toHaveProperty("exactCanonicalPayloadBytes");
	expect(Object.isFrozen(result)).toBe(true);
}

function expectNoRegistrationEffects(
	network: DRPNetworkNode,
	queues: MessageQueueManager<Message>,
	subscribe: ReturnType<typeof vi.spyOn>
): void {
	expect(subscribe).not.toHaveBeenCalled();
	expect(network.subscribe).not.toHaveBeenCalled();
	expect(network.publishMessage).not.toHaveBeenCalled();
	expect(network.unsubscribe).not.toHaveBeenCalled();
	expect(queues.hasQueue("general")).toBe(true);
}

function activationRecord(input: V3PlaneActivationInput): Record<PropertyKey, unknown> {
	return { ...(input as unknown as Record<string, unknown>) };
}

function clearMockRecord(record: object): void {
	for (const value of Object.values(record)) {
		if (vi.isMockFunction(value)) value.mockClear();
	}
}

function expectNoMockRecordCalls(record: object): void {
	for (const [name, value] of Object.entries(record)) {
		if (vi.isMockFunction(value)) expect(value, name).not.toHaveBeenCalled();
	}
}

const NETWORK_EFFECT_METHODS = Object.freeze([
	"broadcastMessage",
	"changeTopicScoreParams",
	"connect",
	"connectToBootstraps",
	"disconnect",
	"publishMessage",
	"removeTopicScoreParams",
	"restart",
	"sendGroupMessage",
	"sendMessage",
	"sendMessageToRandomPeer",
	"start",
	"stop",
	"subscribe",
	"subscribeToMessageQueue",
	"unsubscribe",
] as const);

function clearNetworkEffects(network: DRPNetworkNode): void {
	for (const name of NETWORK_EFFECT_METHODS) {
		const method = Reflect.get(network, name);
		if (vi.isMockFunction(method)) method.mockClear();
	}
}

function expectNoNetworkEffects(network: DRPNetworkNode): void {
	for (const name of NETWORK_EFFECT_METHODS) {
		const method = Reflect.get(network, name);
		if (vi.isMockFunction(method)) expect(method, name).not.toHaveBeenCalled();
	}
}

async function probeSurfaces(): Promise<boolean> {
	const initialStateBytes = encodeCanonical(0);
	const fixture = await createGenuinePreparedV3Fixture({
		authorizationMode: "latched-acl",
		exactCanonicalInitialStateBytes: initialStateBytes,
	});
	try {
		const recovered = await recover(fixture, fixture.capability);
		const activation = activateGenesis(recovered.capability, "peer:phase4b:probe-export");
		if (!activation.ok) return false;
		const binding = bindV3BlueprintLivePlane({
			exactCanonicalInitialStateBytes: initialStateBytes,
			plane: activation.handle,
		});
		const exportReady = binding.ok && typeof Reflect.get(binding.handle, "exportSnapshotPayload") === "function";
		activation.handle.deactivate();

		const secondPrepared = await fixture.prepareAgain();
		const second = await recover(fixture, secondPrepared.capability);
		const dummyPayload = Object.freeze({
			exactCanonicalPayloadBytes: Uint8Array.of(1),
			expectedApplicationStateDigest: "0".repeat(64),
			expectedPayloadDigest: "0".repeat(64),
		});
		activateV3LivePlane(snapshotInput(second.capability, fakeNetwork("peer:phase4b:probe-snapshot"), dummyPayload));
		const replay = activateGenesis(second.capability, "peer:phase4b:probe-replay");
		const activationReady = replay.ok === false && replay.kind === "capability-consumed";
		return exportReady && activationReady;
	} finally {
		await fixture.close();
	}
}

describe("Phase 4b-b live snapshot replacement composition tests-only RED", () => {
	beforeAll(async () => {
		surfacesReady = await probeSurfaces();
	});

	it("has one causal readiness failure for the absent snapshot activation and export surfaces", () => {
		expect(
			surfacesReady,
			"Phase 4b-b GREEN must add the snapshot activation branch and private live snapshot export method"
		).toBe(true);
	});

	it("keeps package roots free of runtime/machine/snapshot authority and the v3-live roster unchanged", () => {
		expect(exportedNames(readFileSync(resolve(REPOSITORY_ROOT, "packages/node/src/v3-live.ts"), "utf8"))).toEqual([
			...V3_LIVE_EXPORT_ROSTER,
		]);
		for (const relative of [
			"packages/node/src/index.ts",
			"packages/node/src/runtime.ts",
			"packages/compaction/src/index.ts",
		]) {
			const names = exportedNames(readFileSync(resolve(REPOSITORY_ROOT, relative), "utf8"));
			expect(names.some((name) => FORBIDDEN_ROOT_AUTHORITY.includes(name))).toBe(false);
		}
		expect(existsSync(resolve(REPOSITORY_ROOT, "packages/compaction/src/blueprint-snapshot.ts"))).toBe(true);
	});

	describe("Phase 4b-b GREEN live snapshot composition", () => {
		it("exports the adopted epoch, matches independent D.99 reconstruction, and activates a third replica", async ({
			skip,
		}) => {
			if (!surfacesReady) skip();
			const fixture = await createGenuinePreparedV3Fixture({
				authorizationMode: "latched-acl",
				exactCanonicalInitialStateBytes: encodeCanonical(0),
			});
			try {
				const secondPrepared = await fixture.prepareAgain();
				const thirdPrepared = await fixture.prepareAgain();
				const [first, second] = await Promise.all([
					foldAdoptedHandle(fixture, fixture.capability, "peer:phase4b:a"),
					foldAdoptedHandle(fixture, secondPrepared.capability, "peer:phase4b:b"),
				]);
				expect(first.adopted.stateDigest).toBe(second.adopted.stateDigest);
				expect(first.adopted.exactCanonicalStateBytes).toEqual(second.adopted.exactCanonicalStateBytes);
				expect(first.aclOperationDigest).toBe(second.aclOperationDigest);

				const expected = await independentSnapshotPayload(fixture, first.adopted);
				const openedAcl = openedLatchedAcl(fixture);
				if (!openedAcl.ok) throw new TypeError("authenticated latched ACL could not be opened");
				const stagedNext = stageLatchedAclOperations({
					operations: [nextAclOperation(fixture)],
					snapshot: openedAcl.snapshot,
				});
				if (!stagedNext.ok) throw new TypeError("next ACL could not be derived");
				const expectedPayload = decodeCanonical(detached(expected.exactCanonicalPayloadBytes)) as Record<
					string,
					unknown
				>;
				expect(expectedPayload.acl).toEqual(stagedNext.next);
				expect(expectedPayload.acl).not.toEqual(openedAcl.snapshot);
				const liveExported = exportSnapshotPayload(first.handle);
				if (!liveExported.ok) throw new TypeError("live snapshot export failed");
				expect(liveExported).toMatchObject({
					applicationStateDigest: expected.applicationStateDigest,
					kind: "exported",
					ok: true,
					payloadDigest: expected.payloadDigest,
				});
				expect(liveExported.exactCanonicalPayloadBytes).toEqual(expected.exactCanonicalPayloadBytes);
				expect(liveExported.applicationStateDigest).toBe(first.adopted.stateDigest);
				const exportedBytes = detached(liveExported.exactCanonicalPayloadBytes);
				liveExported.exactCanonicalPayloadBytes.fill(0);
				const repeated = exportSnapshotPayload(first.handle);
				if (!repeated.ok) throw new TypeError("detached re-export failed");
				expect(repeated.exactCanonicalPayloadBytes).toEqual(exportedBytes);

				const thirdRecovered = await recover(fixture, thirdPrepared.capability);
				const thirdQueues = silentQueue();
				const thirdNetwork = fakeNetwork("peer:phase4b:c");
				const thirdSubscribe = vi.spyOn(thirdQueues, "subscribe");
				const thirdActivation = activateV3LivePlane(
					snapshotInput(
						thirdRecovered.capability,
						thirdNetwork,
						{
							exactCanonicalPayloadBytes: detached(exportedBytes),
							expectedApplicationStateDigest: expected.applicationStateDigest,
							expectedPayloadDigest: expected.payloadDigest,
						},
						thirdQueues
					)
				);
				if (!thirdActivation.ok) throw new TypeError("snapshot activation failed");
				expect(thirdSubscribe).toHaveBeenCalledTimes(1);
				expect(thirdNetwork.subscribe).toHaveBeenCalledTimes(1);
				expect(thirdActivation.handle.currentEphemeralAuthority()).toBeUndefined();
				const retrieved = retrieveSnapshotHandle(thirdActivation.handle);
				if (!retrieved.ok) throw new TypeError("snapshot handle retrieval failed");
				expect(retrieved.handle.blueprintSnapshot()).toEqual(first.adopted);
				const reexported = exportSnapshotPayload(retrieved.handle);
				if (!reexported.ok) throw new TypeError("imported re-export failed");
				expect(reexported.exactCanonicalPayloadBytes).toEqual(exportedBytes);
				exportedBytes.fill(255);
				const sourceAgain = exportSnapshotPayload(first.handle);
				if (!sourceAgain.ok) throw new TypeError("source re-export failed");
				expect(sourceAgain.exactCanonicalPayloadBytes).not.toEqual(exportedBytes);
				expect(sourceAgain.payloadDigest).toBe(expected.payloadDigest);
				const importedAgain = exportSnapshotPayload(retrieved.handle);
				if (!importedAgain.ok) throw new TypeError("imported re-export after caller mutation failed");
				expect(importedAgain.payloadDigest).toBe(expected.payloadDigest);

				first.activation.handle.deactivate();
				second.activation.handle.deactivate();
				thirdActivation.handle.deactivate();
			} finally {
				await fixture.close();
			}
		});

		it("rejects live export before adoption, after deactivation, and from author-list authority while invalid next-ACL operations fail before retention", async ({
			skip,
		}) => {
			if (!surfacesReady) skip();
			const initialStateBytes = encodeCanonical(0);
			const latched = await createGenuinePreparedV3Fixture({
				authorizationMode: "latched-acl",
				exactCanonicalInitialStateBytes: initialStateBytes,
			});
			const authors = await createGenuinePreparedV3Fixture({
				authorizationMode: "legacy-author-list",
				exactCanonicalInitialStateBytes: initialStateBytes,
			});
			try {
				const recovered = await recover(latched, latched.capability);
				const activation = activateGenesis(recovered.capability, "peer:phase4b:export-before");
				if (!activation.ok) throw new TypeError("activation failed");
				const binding = bindV3BlueprintLivePlane({
					exactCanonicalInitialStateBytes: initialStateBytes,
					plane: activation.handle,
				});
				if (!binding.ok) throw new TypeError("binding failed");
				expectClosedFailure(exportSnapshotPayload(binding.handle), "not-adopted");
				expect(
					await activation.handle.issueLocal({
						operations: Object.freeze([
							Object.freeze({
								logicalTime: 1,
								operation: Object.freeze({
									action: "acl",
									group: "admin",
									kind: "revoke",
									target: latched.author,
								}),
							}),
						]),
						signRegisteredVertexDigest: latched.signRegisteredVertexDigest,
					})
				).toEqual(expect.objectContaining({ kind: "authorization-rejected", ok: false }));
				expect(recovered.issuanceStore.transactIssue).not.toHaveBeenCalled();
				const staged = await binding.handle.stageBlueprintEpoch();
				if (!staged.ok) throw new TypeError("fold failed");
				if (!staged.adopt().ok) throw new TypeError("adoption failed");
				const adoptedExport = exportSnapshotPayload(binding.handle);
				if (!adoptedExport.ok) throw new TypeError("adopted live snapshot export failed");
				expect(adoptedExport.kind).toBe("exported");
				activation.handle.deactivate();
				expectClosedFailure(exportSnapshotPayload(binding.handle), "not-active");

				const authorRecovered = await recover(authors, authors.capability);
				const authorActivation = activateGenesis(authorRecovered.capability, "peer:phase4b:author-list");
				if (!authorActivation.ok) throw new TypeError("author-list activation failed");
				const authorBinding = bindV3BlueprintLivePlane({
					exactCanonicalInitialStateBytes: initialStateBytes,
					plane: authorActivation.handle,
				});
				if (!authorBinding.ok) throw new TypeError("author-list binding failed");
				const authorStaged = await authorBinding.handle.stageBlueprintEpoch();
				if (!authorStaged.ok) throw new TypeError("author-list fold failed");
				if (!authorStaged.adopt().ok) throw new TypeError("author-list adoption failed");
				expectClosedFailure(exportSnapshotPayload(authorBinding.handle), "authorization-rejected");
				authorActivation.handle.deactivate();

				const opened = openedLatchedAcl(latched);
				if (!opened.ok) throw new TypeError("authenticated latched ACL could not be opened");
				const failedNext = stageLatchedAclOperations({
					operations: Object.freeze([
						Object.freeze({
							actor: latched.author,
							group: "admin" as const,
							kind: "revoke" as const,
							target: latched.author,
						}),
					]),
					snapshot: opened.snapshot,
				});
				expect(failedNext.ok).toBe(false);
				const derived = await foldAdoptedHandle(
					latched,
					await latched.prepareAgain().then((entry) => entry.capability),
					"peer:phase4b:acl-control"
				);
				const preview = Reflect.get(derived.activation.handle, "previewLatchedAcl");
				expect(typeof preview).toBe("function");
				expect(Reflect.apply(preview as () => unknown, derived.activation.handle, [])).toEqual(
					expect.objectContaining({ next: decodeCanonical(independentNextAclBytes(latched)) })
				);
				expect(exportSnapshotPayload(derived.handle).ok).toBe(true);
				derived.activation.handle.deactivate();
				expectClosedFailure(exportSnapshotPayload(derived.handle), "not-active");
			} finally {
				await latched.close();
				await authors.close();
			}
		});

		it("fails closed on digest, identity, ACL, schema, oversize, and unsafe carriers before registration effects", async ({
			skip,
		}) => {
			if (!surfacesReady) skip();
			const fixture = await createGenuinePreparedV3Fixture({
				authorizationMode: "latched-acl",
				exactCanonicalInitialStateBytes: encodeCanonical(0),
			});
			try {
				const folded = await foldAdoptedHandle(fixture, fixture.capability, "peer:phase4b:control");
				const expected = await independentSnapshotPayload(fixture, folded.adopted);
				folded.activation.handle.deactivate();
				const valid = Object.freeze({
					exactCanonicalPayloadBytes: detached(expected.exactCanonicalPayloadBytes),
					expectedApplicationStateDigest: expected.applicationStateDigest,
					expectedPayloadDigest: expected.payloadDigest,
				});

				const rejectShapeBeforeConsumption = async (
					label: string,
					mutate: (input: Record<PropertyKey, unknown>) => object,
					after?: () => void
				): Promise<void> => {
					const prepared = await fixture.prepareAgain();
					const recovered = await recover(fixture, prepared.capability);
					const queues = silentQueue();
					const network = fakeNetwork(`peer:phase4b:shape-${label}`);
					const subscribe = vi.spyOn(queues, "subscribe");
					const base = activationRecord(snapshotInput(recovered.capability, network, valid, queues));
					const result = activateV3LivePlane(mutate(base) as V3PlaneActivationInput);
					expect(result, label).toEqual(expect.objectContaining({ kind: "malformed-input", ok: false }));
					expect(Object.isFrozen(result), label).toBe(true);
					expectNoRegistrationEffects(network, queues, subscribe);
					expect(recovered.journal.appendAccepted).not.toHaveBeenCalled();
					expect(recovered.issuanceStore.transactIssue).not.toHaveBeenCalled();
					after?.();
					const replay = activateGenesis(recovered.capability, `peer:phase4b:shape-${label}-control`);
					expect(replay.ok, `${label} must reject before consuming the capability`).toBe(true);
					if (replay.ok) replay.handle.deactivate();
				};

				await rejectShapeBeforeConsumption("extra", (input) => Object.assign(input, { extra: true }));
				await rejectShapeBeforeConsumption("missing", (input) => {
					Reflect.deleteProperty(input, "expectedPayloadDigest");
					return input;
				});
				await rejectShapeBeforeConsumption("mixed", (input) =>
					Object.assign(input, { exactCanonicalInitialStateBytes: encodeCanonical(0) })
				);
				await rejectShapeBeforeConsumption("inherited", (input) => {
					const capability = input.capability;
					Reflect.deleteProperty(input, "capability");
					return Object.assign(Object.create({ capability }), input) as object;
				});
				const accessorRead = vi.fn(() => valid.exactCanonicalPayloadBytes);
				await rejectShapeBeforeConsumption(
					"accessor",
					(input) => {
						Reflect.defineProperty(input, "exactCanonicalPayloadBytes", {
							enumerable: true,
							get: accessorRead,
						});
						return input;
					},
					() => expect(accessorRead).not.toHaveBeenCalled()
				);
				await rejectShapeBeforeConsumption("symbol", (input) => {
					Reflect.set(input, Symbol("extra"), true);
					return input;
				});
				await rejectShapeBeforeConsumption(
					"proxy",
					(input) =>
						new Proxy(input, {
							ownKeys: (): never => {
								throw new TypeError("hostile activation record");
							},
						})
				);

				const rejectBeforeEffects = async (
					payload: typeof valid,
					label: string
				): Promise<Extract<V3PlaneActivationResult, { readonly ok: false }>> => {
					const prepared = await fixture.prepareAgain();
					const recovered = await recover(fixture, prepared.capability);
					const queues = silentQueue();
					const network = fakeNetwork(`peer:phase4b:${label}`);
					const subscribe = vi.spyOn(queues, "subscribe");
					vi.mocked(recovered.journal.appendAccepted).mockClear();
					vi.mocked(recovered.issuanceStore.transactIssue).mockClear();
					const result = activateV3LivePlane(snapshotInput(recovered.capability, network, payload, queues));
					expect(result.ok, label).toBe(false);
					if (result.ok) throw new TypeError("expected snapshot activation to fail");
					expect(result.kind, label).toBe("malformed-input");
					expect(Object.isFrozen(result)).toBe(true);
					expectNoRegistrationEffects(network, queues, subscribe);
					expect(recovered.journal.appendAccepted).not.toHaveBeenCalled();
					expect(recovered.issuanceStore.transactIssue).not.toHaveBeenCalled();
					const replay = activateGenesis(recovered.capability, `peer:phase4b:${label}-replay`);
					expect(replay).toEqual(expect.objectContaining({ kind: "capability-consumed", ok: false }));
					return result;
				};

				await rejectBeforeEffects(
					{
						...valid,
						expectedPayloadDigest: "f".repeat(64),
					},
					"payload-digest"
				);
				await rejectBeforeEffects(
					{
						...valid,
						expectedApplicationStateDigest: "e".repeat(64),
					},
					"application-digest"
				);

				const fieldCases: Array<readonly [string, (payload: Record<string, unknown>) => void]> = [
					[
						"object",
						(payload): void => {
							payload.objectId = "object:foreign";
						},
					],
					[
						"epoch",
						(payload): void => {
							payload.epoch = Number(payload.epoch) + 1;
						},
					],
					[
						"anchor",
						(payload): void => {
							payload.anchor = "c".repeat(64);
						},
					],
					[
						"blueprint",
						(payload): void => {
							payload.blueprintDigest = "d".repeat(64);
						},
					],
					[
						"archive-root",
						(payload): void => {
							payload.archiveIndexRoot = "a".repeat(64);
						},
					],
					[
						"schema",
						(payload): void => {
							payload.schemaVersion = SNAPSHOT_SCHEMA_VERSION + 1;
						},
					],
				];
				for (const [label, mutate] of fieldCases) {
					const bytes = mutatedPayloadBytes(expected, mutate);
					await rejectBeforeEffects(
						{
							exactCanonicalPayloadBytes: bytes,
							expectedApplicationStateDigest: expected.applicationStateDigest,
							expectedPayloadDigest: digest(PAYLOAD_DOMAIN, bytes),
						},
						label
					);
				}

				const currentAclMachine = new BlueprintStateMachine({
					exactCanonicalInitialStateBytes: detached(folded.adopted.exactCanonicalStateBytes),
					expectedBlueprintDigest: folded.adopted.blueprintDigest,
					expectedInitialStateDigest: folded.adopted.stateDigest,
					preparedBlueprintRuntime: await prepareLatchedRuntime(fixture),
				});
				const metadata = signedAnchorMetadata(fixture);
				const currentAclBytes = fixture.exactCanonicalLatchedAclBytes;
				if (currentAclBytes === undefined) throw new TypeError("latched ACL bytes are required");
				const currentAclPayload = exportBlueprintSnapshotPayload({
					anchor: metadata.anchor,
					archiveIndexRoot: metadata.archiveIndexRoot,
					epoch: metadata.epoch,
					exactCanonicalAclBytes: detached(currentAclBytes),
					machine: currentAclMachine,
					maxSnapshotBytes: fixture.parameters.maxSnapshotBytes,
					objectId: metadata.objectId,
					schemaVersion: SNAPSHOT_SCHEMA_VERSION,
				});
				expect(currentAclPayload.exactCanonicalPayloadBytes).not.toEqual(expected.exactCanonicalPayloadBytes);
				await rejectBeforeEffects(
					{
						exactCanonicalPayloadBytes: detached(currentAclPayload.exactCanonicalPayloadBytes),
						expectedApplicationStateDigest: currentAclPayload.applicationStateDigest,
						expectedPayloadDigest: currentAclPayload.payloadDigest,
					},
					"current-acl"
				);

				await rejectBeforeEffects(
					{
						...valid,
						exactCanonicalPayloadBytes: new Uint8Array(fixture.parameters.maxSnapshotBytes + 1),
					},
					"oversize"
				);

				const trailing = new Uint8Array(expected.exactCanonicalPayloadBytes.byteLength + 1);
				trailing.set(expected.exactCanonicalPayloadBytes);
				await rejectBeforeEffects(
					{
						...valid,
						exactCanonicalPayloadBytes: trailing,
						expectedPayloadDigest: digest(PAYLOAD_DOMAIN, trailing),
					},
					"partial-trailing"
				);

				const backing = new Uint8Array(expected.exactCanonicalPayloadBytes.byteLength + 2);
				backing.set(expected.exactCanonicalPayloadBytes, 1);
				await rejectBeforeEffects(
					{
						...valid,
						exactCanonicalPayloadBytes: backing.subarray(1, -1),
					},
					"partial-view"
				);

				class ShadowedBytes extends Uint8Array {
					public override get buffer(): ArrayBuffer {
						return new ArrayBuffer(this.byteLength);
					}
				}
				await rejectBeforeEffects(
					{
						...valid,
						exactCanonicalPayloadBytes: new ShadowedBytes(expected.exactCanonicalPayloadBytes),
					},
					"shadowed"
				);

				if (typeof SharedArrayBuffer === "function") {
					const shared = new Uint8Array(new SharedArrayBuffer(expected.exactCanonicalPayloadBytes.byteLength));
					shared.set(expected.exactCanonicalPayloadBytes);
					await rejectBeforeEffects(
						{
							...valid,
							exactCanonicalPayloadBytes: shared,
						},
						"shared"
					);
				}

				const ResizableArrayBuffer = ArrayBuffer as unknown as new (
					byteLength: number,
					options: { readonly maxByteLength: number }
				) => ArrayBuffer;
				const resizableBuffer = new ResizableArrayBuffer(expected.exactCanonicalPayloadBytes.byteLength, {
					maxByteLength: expected.exactCanonicalPayloadBytes.byteLength + 1,
				});
				if ((resizableBuffer as ArrayBuffer & { readonly resizable?: boolean }).resizable === true) {
					const resizable = new Uint8Array(resizableBuffer);
					resizable.set(expected.exactCanonicalPayloadBytes);
					await rejectBeforeEffects(
						{
							...valid,
							exactCanonicalPayloadBytes: resizable,
						},
						"resizable"
					);
				}

				const mutated = detached(expected.exactCanonicalPayloadBytes);
				structuredClone(mutated.buffer, { transfer: [mutated.buffer] });
				expect(mutated.byteLength).toBe(0);
				await rejectBeforeEffects(
					{
						...valid,
						exactCanonicalPayloadBytes: mutated,
					},
					"mutated-detached"
				);
			} finally {
				await fixture.close();
			}
		});

		it("consumes the recovered capability once after snapshot success or failure", async ({ skip }) => {
			if (!surfacesReady) skip();
			const fixture = await createGenuinePreparedV3Fixture({
				authorizationMode: "latched-acl",
				exactCanonicalInitialStateBytes: encodeCanonical(0),
			});
			try {
				const folded = await foldAdoptedHandle(fixture, fixture.capability, "peer:phase4b:one-use-control");
				const expected = await independentSnapshotPayload(fixture, folded.adopted);
				folded.activation.handle.deactivate();

				const successPrepared = await fixture.prepareAgain();
				const successRecovered = await recover(fixture, successPrepared.capability);
				const success = activateV3LivePlane(
					snapshotInput(successRecovered.capability, fakeNetwork("peer:phase4b:one-use-success"), {
						exactCanonicalPayloadBytes: detached(expected.exactCanonicalPayloadBytes),
						expectedApplicationStateDigest: expected.applicationStateDigest,
						expectedPayloadDigest: expected.payloadDigest,
					})
				);
				if (!success.ok) throw new TypeError("snapshot activation control failed");
				expect(activateGenesis(successRecovered.capability, "peer:phase4b:one-use-success-replay")).toEqual(
					expect.objectContaining({ kind: "capability-consumed", ok: false })
				);
				success.handle.deactivate();

				const failedPrepared = await fixture.prepareAgain();
				const failedRecovered = await recover(fixture, failedPrepared.capability);
				const failed = activateV3LivePlane(
					snapshotInput(failedRecovered.capability, fakeNetwork("peer:phase4b:one-use-failure"), {
						exactCanonicalPayloadBytes: detached(expected.exactCanonicalPayloadBytes),
						expectedApplicationStateDigest: expected.applicationStateDigest,
						expectedPayloadDigest: "0".repeat(64),
					})
				);
				expect(failed.ok).toBe(false);
				expect(activateGenesis(failedRecovered.capability, "peer:phase4b:one-use-failure-replay")).toEqual(
					expect.objectContaining({ kind: "capability-consumed", ok: false })
				);
			} finally {
				await fixture.close();
			}
		});

		it("installs an already folded snapshot handle that rejects every effect-bearing method", async ({ skip }) => {
			if (!surfacesReady) skip();
			const fixture = await createGenuinePreparedV3Fixture({
				authorizationMode: "latched-acl",
				exactCanonicalInitialStateBytes: encodeCanonical(0),
			});
			try {
				const folded = await foldAdoptedHandle(fixture, fixture.capability, "peer:phase4b:closed-control");
				const expected = await independentSnapshotPayload(fixture, folded.adopted);
				folded.activation.handle.deactivate();

				const importedPrepared = await fixture.prepareAgain();
				const importedRecovered = await recover(fixture, importedPrepared.capability);
				const network = fakeNetwork("peer:phase4b:closed");
				const importedQueues = silentQueue();
				const importedEnqueue = vi.spyOn(importedQueues, "enqueue");
				const importedSubscribe = vi.spyOn(importedQueues, "subscribe");
				const importedClose = vi.spyOn(importedQueues, "close");
				const admittedSink = vi.fn();
				const signer = vi.fn(fixture.signRegisteredVertexDigest);
				const imported = activateV3LivePlane(
					snapshotInput(
						importedRecovered.capability,
						network,
						{
							exactCanonicalPayloadBytes: detached(expected.exactCanonicalPayloadBytes),
							expectedApplicationStateDigest: expected.applicationStateDigest,
							expectedPayloadDigest: expected.payloadDigest,
						},
						importedQueues,
						admittedSink
					)
				);
				if (!imported.ok) throw new TypeError("snapshot activation failed");
				clearMockRecord(importedRecovered.journal);
				clearMockRecord(importedRecovered.issuanceStore);
				clearNetworkEffects(network);
				importedEnqueue.mockClear();
				importedSubscribe.mockClear();
				importedClose.mockClear();
				admittedSink.mockClear();
				signer.mockClear();
				expect(imported.handle.currentEphemeralAuthority()).toBeUndefined();
				expect(typeof Reflect.get(imported.handle, "importSnapshot")).not.toBe("function");
				const importedPreview = Reflect.get(imported.handle, "previewLatchedAcl");
				expect(typeof importedPreview).toBe("function");
				expect(Reflect.apply(importedPreview as () => unknown, imported.handle, [])).toEqual(
					expect.objectContaining({ next: decodeCanonical(independentNextAclBytes(fixture)) })
				);
				expect(
					await imported.handle.issueLocal({
						operations: Object.freeze([
							Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "add", value: 2 }) }),
						]),
						signRegisteredVertexDigest: signer,
					})
				).toEqual(expect.objectContaining({ kind: "not-active", ok: false }));
				expect(await imported.handle.readRebaseOutbox()).toEqual(
					expect.objectContaining({ kind: "not-active", ok: false })
				);
				expect(await imported.handle.completeRebaseSource({ authorSequence: 0, digest: "0".repeat(64) })).toEqual(
					expect.objectContaining({ kind: "not-active", ok: false })
				);
				expect(await imported.handle.publishPending()).toEqual(
					expect.objectContaining({ kind: "not-active", ok: false })
				);
				expect(await imported.handle.republishRetained()).toEqual(
					expect.objectContaining({ kind: "not-active", ok: false })
				);
				expect(await imported.handle.beginTerminalTransition()).toEqual(
					expect.objectContaining({ kind: "not-active", ok: false })
				);
				vi.mocked(network.getAllPeers).mockReturnValue(["peer:other"]);
				expect(await republishV3RetainedTo(imported.handle, "peer:other")).toEqual(
					expect.objectContaining({ kind: "not-active", ok: false })
				);
				expect(
					routeV3RetainedIngress(imported.handle, {
						data: Uint8Array.of(),
						objectId: imported.handle.topic,
						sender: "peer:remote",
						type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
					} as Message)
				).toBe(false);

				const retrieved = retrieveSnapshotHandle(imported.handle);
				if (!retrieved.ok) throw new TypeError("snapshot handle retrieval failed");
				expect(await retrieved.handle.stageBlueprintEpoch()).toEqual(
					expect.objectContaining({ kind: "already-folded", ok: false })
				);
				expect(retrieved.handle.blueprintSnapshot()).toEqual(folded.adopted);
				expect(
					bindV3BlueprintLivePlane({
						exactCanonicalInitialStateBytes: encodeCanonical(0),
						plane: imported.handle,
					}).ok
				).toBe(false);

				const secondPrepared = await fixture.prepareAgain();
				const secondRecovered = await recover(fixture, secondPrepared.capability);
				const secondQueues = silentQueue();
				const secondSubscribe = vi.spyOn(secondQueues, "subscribe");
				const second = activateV3LivePlane(
					snapshotInput(
						secondRecovered.capability,
						network,
						{
							exactCanonicalPayloadBytes: detached(expected.exactCanonicalPayloadBytes),
							expectedApplicationStateDigest: expected.applicationStateDigest,
							expectedPayloadDigest: expected.payloadDigest,
						},
						secondQueues
					)
				);
				expect(second.ok).toBe(false);
				if (second.ok) throw new TypeError("second snapshot import must fail");
				expect(second.kind).toBe("internal-invariant");
				expect(secondSubscribe).not.toHaveBeenCalled();
				expect(activateGenesis(secondRecovered.capability, "peer:phase4b:second-import-replay")).toEqual(
					expect.objectContaining({ kind: "capability-consumed", ok: false })
				);

				Reflect.set(
					network,
					"gossipTopicFor",
					vi.fn(() => imported.handle.topic)
				);
				expect(
					routeV3Ingress(network, {
						data: V3Envelope.encode({
							canonicalPreimage: fixture.receivedCanonicalPreimageBytes,
							signature: fixture.receivedSignature,
						}).finish(),
						objectId: imported.handle.topic,
						sender: "peer:remote",
						type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
					} as Message)
				).toBe(true);
				expect(importedEnqueue).not.toHaveBeenCalled();
				expectNoMockRecordCalls(importedRecovered.journal);
				expectNoMockRecordCalls(importedRecovered.issuanceStore);
				expectNoNetworkEffects(network);
				expect(importedEnqueue).not.toHaveBeenCalled();
				expect(importedSubscribe).not.toHaveBeenCalled();
				expect(importedClose).not.toHaveBeenCalled();
				expect(admittedSink).not.toHaveBeenCalled();
				expect(signer).not.toHaveBeenCalled();
				imported.handle.deactivate();
			} finally {
				await fixture.close();
			}
		});
	});
});
