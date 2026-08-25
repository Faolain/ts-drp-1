import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import type { Message } from "@ts-drp/types";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { fakeNetwork, recoverLiveSnapshotPeer } from "./fixtures/phase-4b-v3/live-snapshot.js";
import {
	orderedMissingBatch,
	SNAPSHOT_CHUNK_PROTOCOL,
	SNAPSHOT_PULL_FAILURE_CODES,
	SNAPSHOT_PULL_INACTIVITY_MS,
	SNAPSHOT_PULL_MAX_ATTEMPTS,
	SNAPSHOT_PULL_MAX_BODY_BYTES,
	SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS,
	SNAPSHOT_PULL_MAX_MANIFEST_BYTES,
	SNAPSHOT_PULL_MAX_OUTSTANDING,
	SNAPSHOT_PULL_NETWORK_EXPORTS,
	SNAPSHOT_PULL_NODE_EXPORTS,
	SNAPSHOT_PULL_REQUEST_DESCRIPTOR_FIELDS,
	SNAPSHOT_PULL_REQUEST_FIELDS,
	SNAPSHOT_PULL_RESPONSE_FIELDS,
	SNAPSHOT_PULL_TOTAL_MS,
} from "./fixtures/phase-4c-v3/snapshot-pull-contract.js";
import {
	ScriptedSnapshotChunkPort,
	snapshotPeerAuthorization,
} from "./fixtures/phase-4c-v3/snapshot-pull-transport.js";
import type {
	SnapshotChunkProtocolModule,
	V3SnapshotTransferModule,
} from "./fixtures/phase-4c-v3/snapshot-pull-types.js";
import { snapshotPullTypeContractSource } from "./fixtures/phase-4c-v3/snapshot-pull-types.js";
import { createSnapshotQuarantineFixture } from "./fixtures/phase-4c-v3/snapshot-quarantine-contract.js";
import type {
	NodeSnapshotQuarantineModule,
	SnapshotQuarantineReceiptModule,
	SnapshotQuarantineScope,
	SnapshotVerificationReceipt,
} from "./fixtures/phase-4c-v3/snapshot-quarantine-types.js";

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const NETWORK_OWNER = resolve(REPOSITORY_ROOT, "packages/network/src/snapshot-transfer.ts");
const NODE_OWNER = resolve(REPOSITORY_ROOT, "packages/node/src/snapshot-transfer.ts");
const EXPECTED_TYPES = resolve(CURRENT_DIRECTORY, "fixtures/phase-4c-v3/snapshot-pull-types.ts");
const NETWORK_MODULE_PATH: string = "../packages/network/src/snapshot-transfer.js";
const NODE_MODULE_PATH: string = "../packages/node/src/snapshot-transfer.js";
const NODE_QUARANTINE_MODULE_PATH: string = "../packages/storage-node/src/snapshot-transfer.js";
const RECEIPT_MODULE_PATH: string = "@ts-drp/compaction/snapshot-quarantine-receipt";
const ownersExist = existsSync(NETWORK_OWNER) && existsSync(NODE_OWNER);
const PROFILE = Object.freeze({
	maxManifestBytes: 212_387 as const,
	maxSnapshotBytes: 268_435_456 as const,
	snapshotChunkBytes: 131_072 as const,
});

function required<Value>(value: Value | undefined, name: string): Value {
	if (value === undefined) throw new TypeError(`${name} is absent`);
	return value;
}

function packageExports(path: string): Readonly<Record<string, unknown>> {
	return (
		(JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, path), "utf8")) as { exports?: Record<string, unknown> })
			.exports ?? {}
	);
}

function assertTypeContract(): void {
	const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cc-types-"));
	try {
		const source = resolve(directory, "contract.ts");
		const project = resolve(directory, "tsconfig.json");
		writeFileSync(
			source,
			snapshotPullTypeContractSource({
				expectedModule: EXPECTED_TYPES,
				networkModule: NETWORK_OWNER,
				nodeModule: NODE_OWNER,
			})
		);
		writeFileSync(
			project,
			JSON.stringify({
				compilerOptions: {
					allowImportingTsExtensions: true,
					composite: false,
					declaration: false,
					declarationMap: false,
					noEmit: true,
				},
				extends: resolve(REPOSITORY_ROOT, "tsconfig.json"),
				files: [source],
			})
		);
		execFileSync("pnpm", ["exec", "tsc", "--project", project, "--pretty", "false"], {
			cwd: REPOSITORY_ROOT,
			stdio: "pipe",
		});
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

function exactRecord(value: unknown): Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("snapshot pull test record is invalid");
	}
	return value as Readonly<Record<string, unknown>>;
}

async function completeVerifiedScope(
	scope: SnapshotQuarantineScope<SnapshotVerificationReceipt>,
	fixture: ReturnType<typeof createSnapshotQuarantineFixture>
): Promise<void> {
	const receiptOwner = (await import(RECEIPT_MODULE_PATH)) as SnapshotQuarantineReceiptModule;
	const stream = receiptOwner.verifySnapshotStreamWithReceipt({
		exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
		expectedManifestDigest: fixture.declaration.scope.manifestDigest,
		expectedScope: fixture.declaration.scope,
		profile: PROFILE,
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

async function recoveredActivationBinding(peerId: string): Promise<
	Readonly<{
		readonly capability: object;
		readonly messageQueueManager: MessageQueueManager<Message>;
		readonly networkNode: ReturnType<typeof fakeNetwork>;
		close(): Promise<void>;
		onAdmittedVertex(...arguments_: readonly unknown[]): unknown;
	}>
> {
	const fixture = await createGenuinePreparedV3Fixture({
		authorizationMode: "latched-acl",
		exactCanonicalInitialStateBytes: encodeCanonical(0),
	});
	const recovered = await recoverLiveSnapshotPeer(fixture, fixture.capability);
	return Object.freeze({
		capability: recovered.capability,
		close: () => fixture.close(),
		messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
		networkNode: fakeNetwork(peerId),
		onAdmittedVertex: vi.fn(),
	});
}

describe("Phase 4c-c authenticated snapshot pull RED", () => {
	const cleanup: Array<() => Promise<void> | void> = [];
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		await Promise.allSettled(cleanup.splice(0).map((close) => close()));
		for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
	});

	it("pins the dedicated protocol, fixed limits, closed records and failure taxonomy", () => {
		expect(SNAPSHOT_CHUNK_PROTOCOL).toBe("/ts-drp/v3/snapshot-chunk/1.0.0");
		expect(SNAPSHOT_PULL_INACTIVITY_MS).toBe(10_000);
		expect(SNAPSHOT_PULL_TOTAL_MS).toBe(120_000);
		expect(SNAPSHOT_PULL_MAX_ATTEMPTS).toBe(3);
		expect(SNAPSHOT_PULL_MAX_OUTSTANDING).toBe(4);
		expect(SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS).toBe(4);
		expect(SNAPSHOT_PULL_MAX_BODY_BYTES).toBe(131_072);
		expect(SNAPSHOT_PULL_MAX_MANIFEST_BYTES).toBe(212_387);
		expect(new Set(SNAPSHOT_PULL_FAILURE_CODES).size).toBe(SNAPSHOT_PULL_FAILURE_CODES.length);
		expect(SNAPSHOT_PULL_FAILURE_CODES).toEqual([...SNAPSHOT_PULL_FAILURE_CODES].sort());
		expect(SNAPSHOT_PULL_REQUEST_FIELDS).toEqual({
			chunks: ["descriptors", "kind", "manifestDigest", "version"],
			manifest: ["kind", "manifestDigest", "version"],
		});
		expect(SNAPSHOT_PULL_REQUEST_DESCRIPTOR_FIELDS).toEqual(["digest", "index"]);
		expect(SNAPSHOT_PULL_RESPONSE_FIELDS).toEqual({
			chunk: ["byteLength", "digest", "index", "kind", "manifestDigest", "version"],
			manifest: ["exactCanonicalManifestBytes", "kind", "manifestDigest", "version"],
		});
	});

	it("derives ordered unique non-prefix requests without a prefix watermark", () => {
		const fixture = createSnapshotQuarantineFixture({
			chunks: [
				new Uint8Array(131_072).fill(1),
				new Uint8Array(131_072).fill(2),
				new Uint8Array(131_072).fill(3),
				new Uint8Array(131_072).fill(4),
				Uint8Array.of(5),
			],
		});
		expect(orderedMissingBatch(fixture.declaration.chunks, [4, 0, 3, 2, 0])).toEqual([
			{ digest: fixture.declaration.chunks[0]?.digest, index: 0 },
			{ digest: fixture.declaration.chunks[2]?.digest, index: 2 },
			{ digest: fixture.declaration.chunks[3]?.digest, index: 3 },
			{ digest: fixture.declaration.chunks[4]?.digest, index: 4 },
		]);
	});

	it("has exactly one readiness failure for the dedicated network and node owners", () => {
		expect(ownersExist).toBe(true);
	});

	describe.skipIf(!ownersExist)("dormant GREEN transfer owner", () => {
		it("adds only fixed non-root owners with exact types and unchanged roots", async () => {
			const [network, node, networkRoot, nodeRoot] = await Promise.all([
				import(NETWORK_MODULE_PATH) as Promise<SnapshotChunkProtocolModule>,
				import(NODE_MODULE_PATH) as Promise<V3SnapshotTransferModule>,
				import("../packages/network/src/index.js"),
				import("../packages/node/src/index.js"),
			]);
			expect(Object.keys(network).sort()).toEqual([...SNAPSHOT_PULL_NETWORK_EXPORTS].sort());
			expect(Object.keys(node).sort()).toEqual([...SNAPSHOT_PULL_NODE_EXPORTS].sort());
			expect(packageExports("packages/network/package.json")).toHaveProperty("./snapshot-transfer");
			expect(packageExports("packages/node/package.json")).toHaveProperty("./snapshot-transfer");
			expect(Object.keys(networkRoot)).not.toContain("createSnapshotChunkProtocolPort");
			expect(Object.keys(nodeRoot)).not.toContain("createV3SnapshotTransferOwner");
			assertTypeContract();
		});

		it("resumes a non-prefix durable subset, rejects corrupt and slow peers, and completes through 4c-a/4c-b", async () => {
			const fixture = createSnapshotQuarantineFixture();
			const activation = await recoveredActivationBinding("peer:receiver");
			cleanup.push(activation.close);
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cc-"));
			temporaryDirectories.push(directory);
			const quarantineModule = (await import(NODE_QUARANTINE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
			const store = quarantineModule.createNodeSnapshotQuarantineStore({ primaryFilename: join(directory, "live.db") });
			const scope = (await store.openScope(
				fixture.declaration
			)) as SnapshotQuarantineScope<SnapshotVerificationReceipt>;
			const seedPort = scope.verificationQuarantine.open(new AbortController().signal);
			await seedPort.write(
				required(fixture.declaration.chunks[1], "descriptor 1"),
				required(fixture.chunks[1], "chunk 1")
			);
			await seedPort.discard();
			expect(await scope.missingIndices()).toEqual([0, 2]);

			const transport = new ScriptedSnapshotChunkPort(
				fixture,
				new Map([
					["peer:corrupt", "corrupt"],
					["peer:honest", "honest"],
					["peer:slow", "slow"],
				])
			);
			const module = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
			const owner = module.createV3SnapshotTransferOwner({ transport });
			const result = await owner.receive({
				authorization: snapshotPeerAuthorization(transport.connectedPeers()),
				capability: activation.capability,
				descriptors: fixture.declaration.chunks,
				exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: fixture.declaration.scope.manifestDigest,
				messageQueueManager: activation.messageQueueManager,
				networkNode: activation.networkNode,
				onAdmittedVertex: activation.onAdmittedVertex,
				peers: ["peer:corrupt", "peer:slow", "peer:honest"],
				quarantine: scope,
			});
			expect(result.reference).toEqual({
				chunkCount: fixture.declaration.chunks.length,
				exactByteLength: fixture.declaration.totalBytes,
				scope: fixture.declaration.scope,
			});
			expect(result.stats.reusedIndices).toEqual([1]);
			expect(result.stats.fetchedIndices).toEqual([0, 2]);
			expect(result.stats.exactReceivedBytes).toBe(
				2 * required(fixture.declaration.chunks[0], "descriptor 0").byteLength +
					required(fixture.declaration.chunks[2], "descriptor 2").byteLength
			);
			expect(result.stats.exactReceivedBytes).toBe(
				transport.emittedBodyBytes.reduce((sum, byteLength) => sum + byteLength, 0)
			);
			expect(await scope.status()).toMatchObject({ kind: "verified", missingIndices: [] });
			expect(transport.opened).toContain("peer:corrupt");
			expect(transport.opened).toContain("peer:slow");
			expect(transport.opened).toContain("peer:honest");
			await owner.close();
			await store.close();
		}, 60_000);

		it("fails closed before transport for absent, disconnected, or unauthorized peers", async () => {
			const fixture = createSnapshotQuarantineFixture();
			const transport = new ScriptedSnapshotChunkPort(fixture, new Map([["peer:connected", "honest"]]));
			const module = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
			const owner = module.createV3SnapshotTransferOwner({ transport });
			const fakeScope = Object.freeze({}) as SnapshotQuarantineScope<object>;
			const queue = new MessageQueueManager<Message>({ logConfig: { level: "silent" } });
			const network = fakeNetwork("peer:receiver-closed");
			for (const [peers, selectedAuthorization, code] of [
				[[], snapshotPeerAuthorization([]), "connection-unavailable"],
				[["peer:absent"], snapshotPeerAuthorization(["peer:absent"]), "connection-unavailable"],
				[["peer:connected"], snapshotPeerAuthorization([]), "authorization-rejected"],
			] as const) {
				await expect(
					owner.receive({
						authorization: selectedAuthorization,
						capability: Object.freeze({}),
						descriptors: fixture.declaration.chunks,
						exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
						expectedManifestDigest: fixture.declaration.scope.manifestDigest,
						messageQueueManager: queue,
						networkNode: network,
						onAdmittedVertex: vi.fn(),
						peers,
						quarantine: fakeScope,
					})
				).rejects.toMatchObject({ code });
			}
			expect(transport.opened).toEqual([]);
			await owner.close();
		});

		it("captures manifest, descriptor and peer carriers before the first await", async () => {
			const fixture = createSnapshotQuarantineFixture();
			const activation = await recoveredActivationBinding("peer:capture-receiver");
			cleanup.push(activation.close);
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cc-capture-"));
			temporaryDirectories.push(directory);
			const quarantineModule = (await import(NODE_QUARANTINE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
			const store = quarantineModule.createNodeSnapshotQuarantineStore({
				primaryFilename: join(directory, "capture.db"),
			});
			const scope = (await store.openScope(
				fixture.declaration
			)) as SnapshotQuarantineScope<SnapshotVerificationReceipt>;
			const transport = new ScriptedSnapshotChunkPort(fixture, new Map([["peer:honest", "honest"]]));
			const module = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
			const owner = module.createV3SnapshotTransferOwner({ transport });
			const manifestCarrier = new Uint8Array(fixture.declaration.exactCanonicalManifestBytes);
			const descriptorCarriers = fixture.declaration.chunks.map((descriptor) => ({ ...descriptor }));
			const peerCarriers = ["peer:honest"];
			const pending = owner.receive({
				authorization: snapshotPeerAuthorization(peerCarriers),
				capability: activation.capability,
				descriptors: descriptorCarriers,
				exactCanonicalManifestBytes: manifestCarrier,
				expectedManifestDigest: fixture.declaration.scope.manifestDigest,
				messageQueueManager: activation.messageQueueManager,
				networkNode: activation.networkNode,
				onAdmittedVertex: activation.onAdmittedVertex,
				peers: peerCarriers,
				quarantine: scope,
			});
			manifestCarrier.fill(0);
			required(descriptorCarriers[0], "mutable descriptor 0").digest = "ff".repeat(32);
			peerCarriers[0] = "peer:absent-after-call";
			const result = await pending;
			expect(result.stats.fetchedIndices).toEqual([0, 1, 2]);
			expect(result.reference.scope).toEqual(fixture.declaration.scope);
			expect(await scope.status()).toMatchObject({ kind: "verified", missingIndices: [] });
			await owner.close();
			await store.close();
		});

		it("rejects mismatched response controls and an over-bound body before any durable write", async () => {
			const fixture = createSnapshotQuarantineFixture({ objectId: "phase-4c-c-response-bounds" });
			const expectedMissing = fixture.declaration.chunks.map(({ index }) => index);
			for (const causalCase of [
				{
					behavior: "mismatched-control" as const,
					emittedBodyBytes: [] as readonly number[],
					id: "mismatched-control",
				},
				{
					behavior: "oversized-body" as const,
					emittedBodyBytes: Array.from({ length: SNAPSHOT_PULL_MAX_ATTEMPTS }, () => SNAPSHOT_PULL_MAX_BODY_BYTES + 1),
					id: "oversized-body",
				},
			] as const) {
				const activation = await recoveredActivationBinding(`peer:${causalCase.id}-receiver`);
				cleanup.push(activation.close);
				const directory = mkdtempSync(join(tmpdir(), `ts-drp-phase4cc-${causalCase.id}-`));
				temporaryDirectories.push(directory);
				const quarantineModule = (await import(NODE_QUARANTINE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
				const store = quarantineModule.createNodeSnapshotQuarantineStore({
					primaryFilename: join(directory, "response.db"),
				});
				const scope = (await store.openScope(fixture.declaration)) as SnapshotQuarantineScope<object>;
				const transport = new ScriptedSnapshotChunkPort(fixture, new Map([["peer:malicious", causalCase.behavior]]));
				const module = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
				const owner = module.createV3SnapshotTransferOwner({ transport });
				await expect(
					owner.receive({
						authorization: snapshotPeerAuthorization(["peer:malicious"]),
						capability: activation.capability,
						descriptors: fixture.declaration.chunks,
						exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
						expectedManifestDigest: fixture.declaration.scope.manifestDigest,
						messageQueueManager: activation.messageQueueManager,
						networkNode: activation.networkNode,
						onAdmittedVertex: activation.onAdmittedVertex,
						peers: ["peer:malicious"],
						quarantine: scope,
					})
				).rejects.toMatchObject({ code: "transfer-exhausted" });
				expect(await scope.missingIndices(), causalCase.id).toEqual(expectedMissing);
				expect(transport.emittedBodyBytes, causalCase.id).toEqual(causalCase.emittedBodyBytes);
				await owner.close();
				await store.close();
			}
		});

		it("serves only a verified scope to an exactly authorized peer with bound manifest and chunk frames", async () => {
			const fixture = createSnapshotQuarantineFixture({
				chunks: [
					new Uint8Array(131_072).fill(1),
					new Uint8Array(131_072).fill(2),
					new Uint8Array(131_072).fill(3),
					new Uint8Array(131_072).fill(4),
					Uint8Array.of(5, 6, 7),
				],
			});
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cc-serve-"));
			temporaryDirectories.push(directory);
			const quarantineModule = (await import(NODE_QUARANTINE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
			const store = quarantineModule.createNodeSnapshotQuarantineStore({
				primaryFilename: join(directory, "serve.db"),
			});
			const scope = (await store.openScope(
				fixture.declaration
			)) as SnapshotQuarantineScope<SnapshotVerificationReceipt>;
			const transport = new ScriptedSnapshotChunkPort(
				fixture,
				new Map([
					["peer:authorized", "honest"],
					["peer:connected-only", "honest"],
				])
			);
			const module = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
			const owner = module.createV3SnapshotTransferOwner({ transport });
			const stopServing = owner.serve({
				authorization: snapshotPeerAuthorization(["peer:authorized"]),
				descriptors: fixture.declaration.chunks,
				exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
				quarantine: scope,
			});

			const manifestRequest = encodeCanonical({
				kind: "snapshot-manifest-request",
				manifestDigest: fixture.declaration.scope.manifestDigest,
				version: 1,
			});
			expect(await transport.dispatch("peer:authorized", [manifestRequest])).toEqual([]);
			expect(transport.servedWrites).toEqual([]);
			expect(transport.servedAborts.at(-1)).toMatchObject({ code: "quarantine-failed" });

			await completeVerifiedScope(scope, fixture);
			transport.servedAborts.length = 0;
			expect(await transport.dispatch("peer:connected-only", [manifestRequest])).toEqual([]);
			expect(transport.servedWrites).toEqual([]);
			expect(transport.servedAborts).toHaveLength(1);
			expect(transport.servedAborts[0]).toMatchObject({ code: "authorization-rejected" });

			transport.servedAborts.length = 0;
			const manifestResponses = await transport.dispatch("peer:authorized", [manifestRequest]);
			expect(manifestResponses).toHaveLength(1);
			expect(exactRecord(decodeCanonical(required(manifestResponses[0], "manifest response")))).toEqual({
				exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
				kind: "snapshot-manifest-response",
				manifestDigest: fixture.declaration.scope.manifestDigest,
				version: 1,
			});

			const requestDescriptor = (index: number): Readonly<{ readonly digest: string; readonly index: number }> => {
				const selected = required(fixture.declaration.chunks[index], `request descriptor ${index}`);
				return Object.freeze({ digest: selected.digest, index: selected.index });
			};
			const validChunkRequest = Object.freeze({
				descriptors: Object.freeze([requestDescriptor(2)]),
				kind: "snapshot-chunk-request",
				manifestDigest: fixture.declaration.scope.manifestDigest,
				version: 1,
			});
			const validChunkRequestBytes = encodeCanonical(validChunkRequest);
			const causalMutants = [
				{
					code: "protocol-violation",
					id: "duplicate-descriptor",
					value: { ...validChunkRequest, descriptors: [requestDescriptor(0), requestDescriptor(0)] },
				},
				{
					code: "protocol-violation",
					id: "unsorted-descriptors",
					value: { ...validChunkRequest, descriptors: [requestDescriptor(1), requestDescriptor(0)] },
				},
				{
					code: "protocol-violation",
					id: "five-outstanding-descriptors",
					value: {
						...validChunkRequest,
						descriptors: [
							requestDescriptor(0),
							requestDescriptor(1),
							requestDescriptor(2),
							requestDescriptor(3),
							requestDescriptor(4),
						],
					},
				},
				{
					code: "protocol-violation",
					id: "extra-request-field",
					value: { ...validChunkRequest, extra: true },
				},
				{
					code: "protocol-violation",
					id: "extra-descriptor-field",
					value: { ...validChunkRequest, descriptors: [{ ...requestDescriptor(2), byteLength: 3 }] },
				},
				{
					code: "manifest-invalid",
					id: "foreign-manifest",
					value: { ...validChunkRequest, manifestDigest: "ff".repeat(32) },
				},
			] as const;
			for (const mutant of causalMutants) {
				const encoded = encodeCanonical(mutant.value);
				expect(encoded, mutant.id).not.toEqual(validChunkRequestBytes);
				transport.servedAborts.length = 0;
				transport.servedWrites.length = 0;
				expect(await transport.dispatch("peer:authorized", [encoded]), mutant.id).toEqual([]);
				expect(transport.servedWrites, mutant.id).toEqual([]);
				expect(transport.servedAborts, mutant.id).toHaveLength(1);
				expect(transport.servedAborts[0], mutant.id).toMatchObject({ code: mutant.code });
			}

			const descriptor = required(fixture.declaration.chunks[2], "descriptor 2");
			transport.servedAborts.length = 0;
			transport.servedWrites.length = 0;
			const chunkResponses = await transport.dispatch("peer:authorized", [validChunkRequestBytes]);
			expect(chunkResponses).toHaveLength(2);
			expect(exactRecord(decodeCanonical(required(chunkResponses[0], "chunk control")))).toEqual({
				byteLength: descriptor.byteLength,
				digest: descriptor.digest,
				index: descriptor.index,
				kind: "snapshot-chunk-response",
				manifestDigest: fixture.declaration.scope.manifestDigest,
				version: 1,
			});
			expect(chunkResponses[1]).toEqual(fixture.chunks[2]);
			required(chunkResponses[1], "chunk body").fill(0);
			expect(await scope.verificationQuarantine.open(new AbortController().signal).read(descriptor)).toEqual(
				fixture.chunks[2]
			);
			expect(transport.servedAborts).toEqual([]);

			stopServing();
			await owner.close();
			await store.close();
		});

		it("admits one scope-peer transfer and four global sessions, then aborts every live body without a write", async () => {
			const fixtures = Array.from({ length: SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS + 1 }, (_, index) =>
				createSnapshotQuarantineFixture({ objectId: `phase-4c-c-capacity-${index}` })
			);
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cc-capacity-"));
			temporaryDirectories.push(directory);
			const quarantineModule = (await import(NODE_QUARANTINE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
			const store = quarantineModule.createNodeSnapshotQuarantineStore({
				primaryFilename: join(directory, "capacity.db"),
			});
			const scopes = await Promise.all(
				fixtures.map((fixture) => store.openScope(fixture.declaration) as Promise<SnapshotQuarantineScope<object>>)
			);
			const module = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
			const transports = fixtures.map(
				(fixture) => new ScriptedSnapshotChunkPort(fixture, new Map([["peer:slow", "slow"]]))
			);
			const owners = transports.map((transport) => module.createV3SnapshotTransferOwner({ transport }));
			const bindings = await Promise.all(
				Array.from({ length: SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS + 2 }, (_, index) =>
					recoveredActivationBinding(`peer:capacity-${index}`)
				)
			);
			for (const binding of bindings) cleanup.push(binding.close);
			const controllers = Array.from({ length: SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS }, () => new AbortController());
			const receive = (
				ownerIndex: number,
				scopeIndex: number,
				bindingIndex: number,
				signal: AbortSignal
			): ReturnType<ReturnType<V3SnapshotTransferModule["createV3SnapshotTransferOwner"]>["receive"]> => {
				const selected = required(fixtures[scopeIndex], `fixture ${scopeIndex}`);
				const binding = required(bindings[bindingIndex], `binding ${bindingIndex}`);
				const owner = required(owners[ownerIndex], `owner ${ownerIndex}`);
				return owner.receive({
					authorization: snapshotPeerAuthorization(["peer:slow"]),
					capability: binding.capability,
					descriptors: selected.declaration.chunks,
					exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
					expectedManifestDigest: selected.declaration.scope.manifestDigest,
					messageQueueManager: binding.messageQueueManager,
					networkNode: binding.networkNode,
					onAdmittedVertex: binding.onAdmittedVertex,
					peers: ["peer:slow"],
					quarantine: required(scopes[scopeIndex], `scope ${scopeIndex}`),
					signal,
				});
			};

			const pending = [receive(0, 0, 0, required(controllers[0], "controller 0").signal)];
			for (let attempt = 0; attempt < 100 && required(transports[0], "transport 0").opened.length < 1; attempt += 1) {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
			}
			await expect(receive(0, 0, 1, new AbortController().signal)).rejects.toMatchObject({
				code: "session-capacity",
			});
			for (let index = 1; index < SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS; index += 1) {
				pending.push(receive(index, index, index + 1, required(controllers[index], `controller ${index}`).signal));
			}
			for (
				let attempt = 0;
				attempt < 100 &&
				transports.reduce((sum, transport) => sum + transport.opened.length, 0) < SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS;
				attempt += 1
			) {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
			}
			expect(transports.reduce((sum, transport) => sum + transport.opened.length, 0)).toBe(
				SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS
			);
			await expect(
				receive(
					SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS,
					SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS,
					SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS + 1,
					new AbortController().signal
				)
			).rejects.toMatchObject({ code: "session-capacity" });
			expect(transports.reduce((sum, transport) => sum + transport.opened.length, 0)).toBe(
				SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS
			);

			for (const controller of controllers) controller.abort(new Error("phase4c-c-capacity-abort"));
			const settled = await Promise.allSettled(pending);
			expect(settled).toHaveLength(SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS);
			expect(
				settled.map((result) =>
					result.status === "rejected" ? Reflect.get(result.reason as object, "code") : "resolved"
				)
			).toEqual(Array.from({ length: SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS }, () => "aborted"));
			for (let index = 0; index < SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS; index += 1) {
				expect(await required(scopes[index], `scope ${index}`).missingIndices()).toEqual(
					required(fixtures[index], `fixture ${index}`).declaration.chunks.map(({ index: chunkIndex }) => chunkIndex)
				);
			}
			await Promise.all(owners.map((owner) => owner.close()));
			await store.close();
		});

		it("closes each inactive attempt at ten seconds and exhausts exactly three attempts", async () => {
			const fixture = createSnapshotQuarantineFixture({ objectId: "phase-4c-c-inactivity" });
			const activation = await recoveredActivationBinding("peer:inactivity-receiver");
			cleanup.push(activation.close);
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cc-inactivity-"));
			temporaryDirectories.push(directory);
			const quarantineModule = (await import(NODE_QUARANTINE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
			const store = quarantineModule.createNodeSnapshotQuarantineStore({
				primaryFilename: join(directory, "inactivity.db"),
			});
			const scope = (await store.openScope(fixture.declaration)) as SnapshotQuarantineScope<object>;
			const transport = new ScriptedSnapshotChunkPort(fixture, new Map([["peer:slow", "slow"]]));
			const module = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
			const owner = module.createV3SnapshotTransferOwner({ transport });
			vi.useFakeTimers();
			let outcome = "pending";
			const pending = owner
				.receive({
					authorization: snapshotPeerAuthorization(["peer:slow"]),
					capability: activation.capability,
					descriptors: fixture.declaration.chunks,
					exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
					expectedManifestDigest: fixture.declaration.scope.manifestDigest,
					messageQueueManager: activation.messageQueueManager,
					networkNode: activation.networkNode,
					onAdmittedVertex: activation.onAdmittedVertex,
					peers: ["peer:slow"],
					quarantine: scope,
				})
				.then(
					() => {
						outcome = "resolved";
					},
					(error: unknown) => {
						outcome = String(Reflect.get(error as object, "code"));
					}
				);
			await vi.advanceTimersByTimeAsync(SNAPSHOT_PULL_INACTIVITY_MS - 1);
			expect(outcome).toBe("pending");
			expect(transport.opened).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(transport.opened).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(SNAPSHOT_PULL_INACTIVITY_MS * 2 - 1);
			expect(outcome).toBe("pending");
			expect(transport.opened).toHaveLength(SNAPSHOT_PULL_MAX_ATTEMPTS);
			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(outcome).toBe("transfer-exhausted");
			expect(transport.opened).toHaveLength(SNAPSHOT_PULL_MAX_ATTEMPTS);
			expect(await scope.missingIndices()).toEqual([0, 1, 2]);
			await owner.close();
			await store.close();
		});

		it("terminates a progressing slow-drip session at the fixed 120-second total boundary", async () => {
			const fixture = createSnapshotQuarantineFixture({
				chunks: [
					new Uint8Array(131_072).fill(1),
					new Uint8Array(131_072).fill(2),
					new Uint8Array(131_072).fill(3),
					new Uint8Array(131_072).fill(4),
					new Uint8Array(131_072).fill(5),
					new Uint8Array(131_072).fill(6),
					Uint8Array.of(7),
				],
				objectId: "phase-4c-c-total",
			});
			const activation = await recoveredActivationBinding("peer:total-receiver");
			cleanup.push(activation.close);
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cc-total-"));
			temporaryDirectories.push(directory);
			const quarantineModule = (await import(NODE_QUARANTINE_MODULE_PATH)) as NodeSnapshotQuarantineModule;
			const store = quarantineModule.createNodeSnapshotQuarantineStore({
				primaryFilename: join(directory, "total.db"),
			});
			const scope = (await store.openScope(fixture.declaration)) as SnapshotQuarantineScope<object>;
			const transport = new ScriptedSnapshotChunkPort(fixture, new Map([["peer:paced", "paced"]]));
			const module = (await import(NODE_MODULE_PATH)) as V3SnapshotTransferModule;
			const owner = module.createV3SnapshotTransferOwner({ transport });
			vi.useFakeTimers();
			let outcome = "pending";
			const pending = owner
				.receive({
					authorization: snapshotPeerAuthorization(["peer:paced"]),
					capability: activation.capability,
					descriptors: fixture.declaration.chunks,
					exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
					expectedManifestDigest: fixture.declaration.scope.manifestDigest,
					messageQueueManager: activation.messageQueueManager,
					networkNode: activation.networkNode,
					onAdmittedVertex: activation.onAdmittedVertex,
					peers: ["peer:paced"],
					quarantine: scope,
				})
				.then(
					() => {
						outcome = "resolved";
					},
					(error: unknown) => {
						outcome = String(Reflect.get(error as object, "code"));
					}
				);
			await vi.advanceTimersByTimeAsync(SNAPSHOT_PULL_TOTAL_MS - 1);
			expect(outcome).toBe("pending");
			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(outcome).toBe("total-timeout");
			expect(await scope.status()).toMatchObject({ kind: "open" });
			await owner.close();
			await store.close();
		});
	});
});
