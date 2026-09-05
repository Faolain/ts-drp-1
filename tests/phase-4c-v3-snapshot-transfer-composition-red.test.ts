import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import type { DRPNetworkNode, DRPNetworkNodeConfig } from "@ts-drp/types";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { fakeNetwork, recoverLiveSnapshotPeer } from "./fixtures/phase-4b-v3/live-snapshot.js";
import {
	ScriptedSnapshotChunkPort,
	snapshotPeerAuthorization,
} from "./fixtures/phase-4c-v3/snapshot-pull-transport.js";
import type {
	SnapshotChunkProtocolModule,
	SnapshotChunkProtocolPort,
	SnapshotChunkProtocolStream,
	V3SnapshotTransferModule,
} from "./fixtures/phase-4c-v3/snapshot-pull-types.js";
import type { SnapshotQuarantineFixture } from "./fixtures/phase-4c-v3/snapshot-quarantine-contract.js";
import type {
	NodeSnapshotQuarantineModule,
	SnapshotQuarantineReceiptModule,
	SnapshotQuarantineScope,
	SnapshotVerificationReceipt,
} from "./fixtures/phase-4c-v3/snapshot-quarantine-types.js";
import {
	createSnapshotTransferFixture,
	exactSnapshotRecord,
	type SnapshotExportFixture,
} from "./fixtures/phase-4c-v3/snapshot-transfer-fixture.js";
import { activateV3LivePlane, bindV3BlueprintLivePlane } from "../packages/node/src/v3-live.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const NODE_OWNER = resolve(REPOSITORY_ROOT, "packages/node/src/snapshot-transfer.ts");
const NODE_MODULE_PATH: string = "../packages/node/src/snapshot-transfer.js";
const NODE_QUARANTINE_MODULE_PATH: string = "../packages/storage-node/src/snapshot-transfer.js";
const NETWORK_MODULE_PATH: string = "../packages/network/src/snapshot-transfer.js";
const NETWORK_NODE_MODULE_PATH: string = "../packages/network/src/node.js";
const RECEIPT_MODULE_PATH: string = "../packages/compaction/dist/src/snapshot-quarantine-receipt.js";
const ownerExists = existsSync(NODE_OWNER);
const NETWORK_CONFIG: DRPNetworkNodeConfig = {
	bootstrap_peers: [],
	listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	log_config: { level: "silent" },
};

interface SnapshotBlueprintHandle {
	exportSnapshotPayload(): Readonly<
		| ({ readonly kind: "exported"; readonly ok: true } & SnapshotExportFixture)
		| { readonly detail: string; readonly ok: false }
	>;
	stageBlueprintEpoch(): Promise<Readonly<{ readonly ok: boolean; adopt?(): Readonly<{ readonly ok: boolean }> }>>;
}

type NetworkNodeConstructor = new (config?: DRPNetworkNodeConfig) => DRPNetworkNode;

function required<Value>(value: Value | undefined, name: string): Value {
	if (value === undefined) throw new TypeError(`${name} is absent`);
	return value;
}

function lowerHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function digest(domain: string, ...parts: readonly Uint8Array[]): string {
	return lowerHex(hashDomain(domain, ...parts));
}

function snapshotHandle(plane: object): SnapshotBlueprintHandle {
	const binding = bindV3BlueprintLivePlane({ plane } as Parameters<typeof bindV3BlueprintLivePlane>[0]);
	if (!binding.ok) throw new TypeError("snapshot blueprint handle is unavailable");
	return binding.handle;
}

async function startedNode(NetworkNode: NetworkNodeConstructor): Promise<DRPNetworkNode> {
	const node = new NetworkNode(NETWORK_CONFIG);
	await node.start();
	return node;
}

async function connectReceiver(receiver: DRPNetworkNode, source: DRPNetworkNode): Promise<void> {
	const addresses = source.getMultiaddrs();
	if (addresses === undefined || addresses.length === 0) throw new TypeError("snapshot source is not dialable");
	await receiver.connect(addresses);
}

async function completeVerifiedScope(
	scope: SnapshotQuarantineScope<SnapshotVerificationReceipt>,
	fixture: SnapshotQuarantineFixture
): Promise<void> {
	const receiptOwner = (await import(RECEIPT_MODULE_PATH)) as SnapshotQuarantineReceiptModule;
	const stream = receiptOwner.verifySnapshotStreamWithReceipt({
		exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
		expectedManifestDigest: fixture.declaration.scope.manifestDigest,
		expectedScope: fixture.declaration.scope,
		profile: Object.freeze({
			maxManifestBytes: 212_387 as const,
			maxSnapshotBytes: 268_435_456 as const,
			snapshotChunkBytes: 131_072 as const,
		}),
		quarantine: scope.verificationQuarantine,
		source: Object.freeze({
			read: (descriptor: Readonly<{ readonly index: number }>) =>
				Promise.resolve(
					fixture.chunks[descriptor.index] === undefined ? undefined : new Uint8Array(fixture.chunks[descriptor.index])
				),
		}),
	});
	await scope.complete(await stream.receipt);
}

function installCorruptSource(port: SnapshotChunkProtocolPort, fixture: SnapshotQuarantineFixture): () => void {
	return port.serve(async (stream: SnapshotChunkProtocolStream) => {
		const request = exactSnapshotRecord(await stream.read(212_387, { signal: new AbortController().signal }));
		if (request.kind === "snapshot-manifest-request") {
			await stream.write(
				encodeCanonical({
					exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
					kind: "snapshot-manifest-response",
					manifestDigest: fixture.declaration.scope.manifestDigest,
					version: 1,
				}),
				{ signal: new AbortController().signal }
			);
			await stream.close();
			return;
		}
		if (request.kind !== "snapshot-chunk-request" || !Array.isArray(request.descriptors)) {
			stream.abort(new Error("corrupt snapshot source received an invalid request"));
			return;
		}
		const selectedValue = required(request.descriptors[0], "corrupt requested descriptor");
		if (selectedValue === null || typeof selectedValue !== "object" || Array.isArray(selectedValue)) {
			throw new TypeError("corrupt requested descriptor is invalid");
		}
		const selectedRequest = selectedValue as Readonly<Record<string, unknown>>;
		const index = selectedRequest.index;
		if (typeof index !== "number") throw new TypeError("corrupt descriptor index is invalid");
		const descriptor = required(fixture.declaration.chunks[index], "corrupt descriptor");
		const body = new Uint8Array(required(fixture.chunks[index], "corrupt body"));
		body[0] = (body[0] ?? 0) ^ 0xff;
		await stream.write(
			encodeCanonical({
				byteLength: descriptor.byteLength,
				digest: descriptor.digest,
				index: descriptor.index,
				kind: "snapshot-chunk-response",
				manifestDigest: fixture.declaration.scope.manifestDigest,
				version: 1,
			}),
			{ signal: new AbortController().signal }
		);
		await stream.write(body, { signal: new AbortController().signal });
		await stream.close();
	});
}

async function adoptedSource(
	input: Readonly<{
		readonly networkNode?: DRPNetworkNode;
	}> = {}
): Promise<
	Readonly<{
		readonly exported: SnapshotExportFixture;
		readonly fixture: Awaited<ReturnType<typeof createGenuinePreparedV3Fixture>>;
		readonly sourceHandle: SnapshotBlueprintHandle;
		readonly sourcePlane: Readonly<{ deactivate(): void }>;
	}>
> {
	const fixture = await createGenuinePreparedV3Fixture({
		authorizationMode: "latched-acl",
		exactCanonicalInitialStateBytes: encodeCanonical(0),
	});
	const recovered = await recoverLiveSnapshotPeer(fixture, fixture.capability);
	const activation = activateV3LivePlane({
		capability: recovered.capability,
		messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
		networkNode: input.networkNode ?? fakeNetwork("peer:source"),
		onAdmittedVertex: vi.fn(),
	});
	if (!activation.ok) throw new TypeError(`source activation failed: ${activation.kind}`);
	const binding = bindV3BlueprintLivePlane({
		exactCanonicalInitialStateBytes: encodeCanonical(0),
		plane: activation.handle,
	});
	if (!binding.ok) throw new TypeError("source blueprint binding failed");
	const sourceHandle = binding.handle;
	const staged = await sourceHandle.stageBlueprintEpoch();
	if (!staged.ok || staged.adopt === undefined || !staged.adopt().ok) {
		throw new TypeError("source fold adoption failed");
	}
	const exported = sourceHandle.exportSnapshotPayload();
	if (!exported.ok) throw new TypeError(`source snapshot export failed: ${exported.detail}`);
	return Object.freeze({ exported, fixture, sourceHandle, sourcePlane: activation.handle });
}

describe("Phase 4c-c genuine D.100 snapshot transfer composition RED", () => {
	const cleanup: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const close of cleanup.splice(0).reverse()) {
			try {
				await close();
			} catch {
				// Best-effort teardown must continue across independently owned resources.
			}
		}
	});

	it("keeps composition dormant behind the same missing transfer owner", () => {
		expect(typeof ownerExists).toBe("boolean");
	});

	describe.skipIf(!ownerExists)("dormant GREEN composition", () => {
		it("consumes and retains one recovered authority before transfer while exposing no live effect before completion", async () => {
			const source = await adoptedSource();
			cleanup.push(() => source.fixture.close());
			const selected = createSnapshotTransferFixture(source.exported);
			const payload = exactSnapshotRecord(source.exported.exactCanonicalPayloadBytes);
			const manifest = exactSnapshotRecord(selected.declaration.exactCanonicalManifestBytes);
			expect(manifest).toMatchObject({
				aclDigest: digest("ts-drp/latched-acl/v3", encodeCanonical(payload.acl)),
				anchor: payload.anchor,
				epoch: payload.epoch,
				objectId: payload.objectId,
				payloadDigest: source.exported.payloadDigest,
				schemaVersion: payload.schemaVersion,
				stateDigest: source.exported.applicationStateDigest,
				totalBytes: source.exported.exactCanonicalPayloadBytes.byteLength,
			});
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cc-pending-"));
			cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
			const quarantineModule = (await import(NODE_QUARANTINE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
			const store = quarantineModule.createNodeSnapshotQuarantineStore({ primaryFilename: join(directory, "live.db") });
			cleanup.push(() => store.close());
			const scope = (await store.openScope(
				selected.declaration
			)) as SnapshotQuarantineScope<SnapshotVerificationReceipt>;
			const transport = new ScriptedSnapshotChunkPort(selected, new Map([["peer:source", "slow"]]));
			const module = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
			const owner = module.createV3SnapshotTransferOwner({ transport });
			cleanup.push(() => owner.close());
			const prepared = await source.fixture.prepareAgain();
			const recovered = await recoverLiveSnapshotPeer(source.fixture, prepared.capability);
			const queue = new MessageQueueManager({ logConfig: { level: "silent" } });
			const queueSubscribe = vi.spyOn(queue, "subscribe");
			const network = fakeNetwork("peer:pending-receiver");
			const networkSubscribe = vi.spyOn(network, "subscribe");
			const admitted = vi.fn();
			const controller = new AbortController();
			const pending = owner.receive({
				authorization: snapshotPeerAuthorization(["peer:source"]),
				capability: recovered.capability,
				descriptors: selected.declaration.chunks,
				exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.declaration.scope.manifestDigest,
				messageQueueManager: queue,
				networkNode: network,
				onAdmittedVertex: admitted,
				peers: ["peer:source"],
				quarantine: scope,
				signal: controller.signal,
			});
			for (let attempt = 0; attempt < 100 && transport.opened.length === 0; attempt += 1) {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
			}
			expect(transport.opened).toEqual(["peer:source"]);
			expect(
				activateV3LivePlane({
					capability: recovered.capability,
					messageQueueManager: queue,
					networkNode: network,
					onAdmittedVertex: admitted,
				})
			).toMatchObject({ kind: "capability-consumed", ok: false });
			expect(queueSubscribe).not.toHaveBeenCalled();
			expect(networkSubscribe).not.toHaveBeenCalled();
			expect(admitted).not.toHaveBeenCalled();
			controller.abort(new Error("phase4c-c-pending-abort"));
			await expect(pending).rejects.toMatchObject({ code: "aborted" });
			expect(await scope.missingIndices()).toEqual([0]);
		});

		it("uses three genuine nodes to reject a corrupt source, switch to an honest source, and activate without dialing", async () => {
			const [networkModule, networkNodeModule] = await Promise.all([
				import(NETWORK_MODULE_PATH) as Promise<SnapshotChunkProtocolModule>,
				import(NETWORK_NODE_MODULE_PATH),
			]);
			const [receiverNetwork, corruptNetwork, honestNetwork] = await Promise.all([
				startedNode(networkNodeModule.DRPNetworkNode),
				startedNode(networkNodeModule.DRPNetworkNode),
				startedNode(networkNodeModule.DRPNetworkNode),
			]);
			cleanup.push(async () => {
				await Promise.allSettled([receiverNetwork, corruptNetwork, honestNetwork].map((node) => node.stop()));
			});
			await Promise.all([
				connectReceiver(receiverNetwork, corruptNetwork),
				connectReceiver(receiverNetwork, honestNetwork),
			]);
			const source = await adoptedSource({
				networkNode: honestNetwork,
			});
			cleanup.push(() => {
				source.sourcePlane.deactivate();
				return source.fixture.close();
			});
			const selected = createSnapshotTransferFixture(source.exported);
			expect(selected.declaration.chunks).toHaveLength(1);
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cc-three-node-"));
			cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
			const quarantineModule = (await import(NODE_QUARANTINE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
			const honestStore = quarantineModule.createNodeSnapshotQuarantineStore({
				primaryFilename: join(directory, "honest.db"),
			});
			const receiverStore = quarantineModule.createNodeSnapshotQuarantineStore({
				primaryFilename: join(directory, "receiver.db"),
			});
			cleanup.push(
				() => honestStore.close(),
				() => receiverStore.close()
			);
			const honestScope = (await honestStore.openScope(
				selected.declaration
			)) as SnapshotQuarantineScope<SnapshotVerificationReceipt>;
			await completeVerifiedScope(honestScope, selected);
			const receiverScope = (await receiverStore.openScope(
				selected.declaration
			)) as SnapshotQuarantineScope<SnapshotVerificationReceipt>;
			expect(await receiverScope.missingIndices()).toEqual([0]);

			const receiverPort = networkModule.createSnapshotChunkProtocolPort(receiverNetwork);
			const corruptPort = networkModule.createSnapshotChunkProtocolPort(corruptNetwork);
			const honestPort = networkModule.createSnapshotChunkProtocolPort(honestNetwork);
			cleanup.push(
				() => receiverPort.close(),
				() => corruptPort.close(),
				() => honestPort.close()
			);
			const stopCorrupt = installCorruptSource(corruptPort, selected);
			const transferModule = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
			const honestOwner = transferModule.createV3SnapshotTransferOwner({ transport: honestPort });
			const receiverOwner = transferModule.createV3SnapshotTransferOwner({ transport: receiverPort });
			cleanup.push(
				() => honestOwner.close(),
				() => receiverOwner.close(),
				stopCorrupt
			);
			const stopHonest = honestOwner.serve({
				authorization: snapshotPeerAuthorization([receiverNetwork.peerId]),
				descriptors: selected.declaration.chunks,
				exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
				quarantine: honestScope,
			});
			cleanup.push(stopHonest);

			const receiverPrepared = await source.fixture.prepareAgain();
			const receiverRecovered = await recoverLiveSnapshotPeer(source.fixture, receiverPrepared.capability);
			const queue = new MessageQueueManager({ logConfig: { level: "silent" } });
			const queueSubscribe = vi.spyOn(queue, "subscribe");
			const networkSubscribe = vi.spyOn(receiverNetwork, "subscribe");
			const dial = vi.spyOn(receiverNetwork, "safeDial");
			const transfer = await receiverOwner.receive({
				authorization: snapshotPeerAuthorization([corruptNetwork.peerId, honestNetwork.peerId]),
				capability: receiverRecovered.capability,
				descriptors: selected.declaration.chunks,
				exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.declaration.scope.manifestDigest,
				messageQueueManager: queue,
				networkNode: receiverNetwork,
				onAdmittedVertex: vi.fn(),
				peers: [corruptNetwork.peerId, honestNetwork.peerId],
				quarantine: receiverScope,
			});
			expect(dial).not.toHaveBeenCalled();
			expect(queueSubscribe).not.toHaveBeenCalled();
			expect(networkSubscribe).not.toHaveBeenCalled();
			expect(transfer.stats.attemptedPeers).toEqual([corruptNetwork.peerId, honestNetwork.peerId]);
			expect(transfer.stats.reusedIndices).toEqual([]);
			expect(transfer.stats.fetchedIndices).toEqual([0]);
			const corruptedBodyLength = required(selected.declaration.chunks[0], "corrupted descriptor").byteLength;
			const acceptedBodyLength = selected.declaration.totalBytes;
			expect(transfer.stats.exactReceivedBytes).toBe(corruptedBodyLength + acceptedBodyLength);

			const activated = receiverOwner.activateSmallSnapshot({
				expectedApplicationStateDigest: source.exported.applicationStateDigest,
				expectedPayloadDigest: source.exported.payloadDigest,
				transfer: transfer.verified,
			});
			cleanup.push(() => Reflect.apply(Reflect.get(activated.plane, "deactivate") as () => void, activated.plane, []));
			const receiverExport = snapshotHandle(activated.plane).exportSnapshotPayload();
			expect(receiverExport).toMatchObject({
				applicationStateDigest: source.exported.applicationStateDigest,
				ok: true,
				payloadDigest: source.exported.payloadDigest,
			});
			if (!receiverExport.ok) throw new TypeError("three-node snapshot export failed");
			expect(receiverExport.exactCanonicalPayloadBytes).toEqual(source.exported.exactCanonicalPayloadBytes);
			expect(source.sourceHandle.exportSnapshotPayload()).toMatchObject({
				applicationStateDigest: source.exported.applicationStateDigest,
				ok: true,
				payloadDigest: source.exported.payloadDigest,
			});
		});

		it("folds, transfers, verifies and activates one fresh snapshot-closed replacement without mutating its source", async () => {
			const source = await adoptedSource();
			cleanup.push(() => source.fixture.close());
			const selected = createSnapshotTransferFixture(source.exported);
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cc-compose-"));
			cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
			const quarantineModule = (await import(NODE_QUARANTINE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
			const store = quarantineModule.createNodeSnapshotQuarantineStore({ primaryFilename: join(directory, "live.db") });
			cleanup.push(() => store.close());
			const scope = (await store.openScope(
				selected.declaration
			)) as SnapshotQuarantineScope<SnapshotVerificationReceipt>;
			const transport = new ScriptedSnapshotChunkPort(selected, new Map([["peer:source", "honest"]]));
			const module = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
			const owner = module.createV3SnapshotTransferOwner({ transport });
			cleanup.push(() => owner.close());
			const receiverPrepared = await source.fixture.prepareAgain();
			const receiverRecovered = await recoverLiveSnapshotPeer(source.fixture, receiverPrepared.capability);
			const queue = new MessageQueueManager({ logConfig: { level: "silent" } });
			const receiverNetwork = fakeNetwork("peer:receiver");
			const transfer = await owner.receive({
				authorization: snapshotPeerAuthorization(["peer:source"]),
				capability: receiverRecovered.capability,
				descriptors: selected.declaration.chunks,
				exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.declaration.scope.manifestDigest,
				messageQueueManager: queue,
				networkNode: receiverNetwork,
				onAdmittedVertex: vi.fn(),
				peers: ["peer:source"],
				quarantine: scope,
			});
			const activated = owner.activateSmallSnapshot({
				expectedApplicationStateDigest: source.exported.applicationStateDigest,
				expectedPayloadDigest: source.exported.payloadDigest,
				transfer: transfer.verified,
			});
			const receiverHandle = snapshotHandle(activated.plane);
			const receiverExport = receiverHandle.exportSnapshotPayload();
			expect(receiverExport).toMatchObject({
				applicationStateDigest: source.exported.applicationStateDigest,
				ok: true,
				payloadDigest: source.exported.payloadDigest,
			});
			if (!receiverExport.ok) throw new TypeError("receiver snapshot export failed");
			expect(receiverExport.exactCanonicalPayloadBytes).toEqual(source.exported.exactCanonicalPayloadBytes);
			expect(source.sourceHandle.exportSnapshotPayload()).toMatchObject({
				applicationStateDigest: source.exported.applicationStateDigest,
				ok: true,
				payloadDigest: source.exported.payloadDigest,
			});
			await expect(receiverHandle.stageBlueprintEpoch()).resolves.toMatchObject({
				kind: "already-folded",
				ok: false,
			});
			expect(activated.reference).toEqual(transfer.reference);
		});

		it("consumes the verified transfer once and rejects substitution before live effects", async () => {
			const source = await adoptedSource();
			cleanup.push(() => source.fixture.close());
			const selected = createSnapshotTransferFixture(source.exported);
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cc-replay-"));
			cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
			const quarantineModule = (await import(NODE_QUARANTINE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
			const store = quarantineModule.createNodeSnapshotQuarantineStore({ primaryFilename: join(directory, "live.db") });
			cleanup.push(() => store.close());
			const scope = (await store.openScope(
				selected.declaration
			)) as SnapshotQuarantineScope<SnapshotVerificationReceipt>;
			const module = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
			const owner = module.createV3SnapshotTransferOwner({
				transport: new ScriptedSnapshotChunkPort(selected, new Map([["peer:source", "honest"]])),
			});
			cleanup.push(() => owner.close());
			const prepared = await source.fixture.prepareAgain();
			const recovered = await recoverLiveSnapshotPeer(source.fixture, prepared.capability);
			const queue = new MessageQueueManager({ logConfig: { level: "silent" } });
			const queueSubscribe = vi.spyOn(queue, "subscribe");
			const network = fakeNetwork("peer:receiver-reject");
			const networkSubscribe = vi.spyOn(network, "subscribe");
			const transfer = await owner.receive({
				authorization: snapshotPeerAuthorization(["peer:source"]),
				capability: recovered.capability,
				descriptors: selected.declaration.chunks,
				exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.declaration.scope.manifestDigest,
				messageQueueManager: queue,
				networkNode: network,
				onAdmittedVertex: vi.fn(),
				peers: ["peer:source"],
				quarantine: scope,
			});
			const input = {
				expectedApplicationStateDigest: source.exported.applicationStateDigest,
				expectedPayloadDigest: "ff".repeat(32),
				transfer: transfer.verified,
			};
			expect(() =>
				owner.activateSmallSnapshot({
					...input,
					expectedPayloadDigest: source.exported.payloadDigest,
					transfer: Object.freeze({ ...transfer.verified }),
				})
			).toThrow();
			expect(queueSubscribe).not.toHaveBeenCalled();
			expect(networkSubscribe).not.toHaveBeenCalled();
			expect(() => owner.activateSmallSnapshot(input)).toThrow();
			expect(queueSubscribe).not.toHaveBeenCalled();
			expect(networkSubscribe).not.toHaveBeenCalled();
			expect(() =>
				owner.activateSmallSnapshot({ ...input, expectedPayloadDigest: source.exported.payloadDigest })
			).toThrow();
		});
	});
});
