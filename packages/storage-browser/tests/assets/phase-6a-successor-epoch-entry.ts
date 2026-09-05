import { encodeCanonical, hashDomain } from "@ts-drp/canonical";

import { createBrowserDurableLiveJournalStore } from "../../src/live-journal.js";

interface CandidateJournalStore {
	appendAccepted(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	close(): Promise<void>;
	installEpochAnchor(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	installGenesis(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	readiness(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	readPage(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function material(): Readonly<Record<string, unknown>> {
	const objectId = `creator:${"1".repeat(32)}`;
	const parametersBytes = encodeCanonical({
		maxDependencies: 8,
		maxEpochBytes: 1_048_576,
		maxEpochVertices: 64,
		maxPendingBytes: 1_048_576,
		maxPendingEntries: 64,
		maxSnapshotBytes: 1_048_576,
		snapshotChunkBytes: 65_536,
	});
	const parametersDigest = lowerHex(hashDomain("ts-drp/parameters/v3", parametersBytes));
	const anchor = Object.freeze({
		aclDigest: "8".repeat(64),
		archiveIndexRoot: "9".repeat(64),
		blueprintDigest: "2".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: "6".repeat(64),
		epoch: 1,
		historyRoot: "7".repeat(64),
		historySize: 1,
		kind: "drp-epoch-anchor",
		objectId,
		parametersDigest,
		previousAnchor: "5".repeat(64),
		profileDigest: "4".repeat(64),
		protocolMajor: 3,
		signerSetDigest: "3".repeat(64),
		stateDigest: "a".repeat(64),
	});
	const anchorBytes = encodeCanonical(anchor);
	const anchorDigest = lowerHex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
	const vertexBytes = encodeCanonical({
		anchor: anchorDigest,
		author: "creator",
		authorSequence: 12,
		dependencies: ["b".repeat(64)],
		epoch: 1,
		kind: "drp-vertex",
		logicalTime: 13,
		objectId,
		operation: { arguments: { value: "successor" }, type: "append" },
		protocolMajor: 3,
	});
	const vertexDigest = lowerHex(hashDomain("ts-drp/vertex/v3", vertexBytes));
	const signature = new Uint8Array(64).fill(7);
	const scope = Object.freeze({ anchorDigest, epoch: 1, objectId });
	const zero = "0".repeat(64);
	const genesisAnchorBytes = encodeCanonical({
		aclDigest: zero,
		archiveIndexRoot: zero,
		blueprintDigest: "2".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: zero,
		epoch: 0,
		historyRoot: zero,
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId,
		parametersDigest,
		previousAnchor: zero,
		profileDigest: "4".repeat(64),
		protocolMajor: 3,
		signerSetDigest: "3".repeat(64),
		stateDigest: zero,
	});
	const genesisAnchorDigest = lowerHex(hashDomain("ts-drp/epoch-anchor/v3", genesisAnchorBytes));
	const genesisScope = Object.freeze({ anchorDigest: genesisAnchorDigest, epoch: 0, objectId });
	const genesisVertexBytes = encodeCanonical({
		anchor: genesisAnchorDigest,
		author: "creator",
		authorSequence: 0,
		dependencies: ["c".repeat(64)],
		epoch: 0,
		kind: "drp-vertex",
		logicalTime: 1,
		objectId,
		operation: { arguments: { value: "genesis" }, type: "append" },
		protocolMajor: 3,
	});
	const genesisVertexDigest = lowerHex(hashDomain("ts-drp/vertex/v3", genesisVertexBytes));
	return Object.freeze({
		anchor,
		genesis: Object.freeze({
			install: Object.freeze({
				detachedAnchorSignature: Uint8Array.from(signature),
				exactCanonicalAnchorPreimageBytes: Uint8Array.from(genesisAnchorBytes),
				exactCanonicalParametersCarrierBytes: Uint8Array.from(parametersBytes),
				objectId,
			}),
			received: Object.freeze({
				detachedSignature: Uint8Array.from(signature),
				exactCanonicalPreimageBytes: Uint8Array.from(genesisVertexBytes),
				scope: genesisScope,
				sourceKind: "received",
				vertexDigest: genesisVertexDigest,
			}),
			scope: genesisScope,
			vertexDigest: genesisVertexDigest,
		}),
		install: Object.freeze({
			detachedAnchorSignature: Uint8Array.from(signature),
			exactCanonicalAnchorPreimageBytes: Uint8Array.from(anchorBytes),
			exactCanonicalParametersCarrierBytes: Uint8Array.from(parametersBytes),
			objectId,
		}),
		parametersDigest,
		received: Object.freeze({
			detachedSignature: Uint8Array.from(signature),
			exactCanonicalPreimageBytes: Uint8Array.from(vertexBytes),
			scope,
			sourceKind: "received",
			vertexDigest,
		}),
		scope,
	});
}

declare global {
	interface Window {
		phase6aSuccessorEpoch: Readonly<{
			run(databaseName: string): Promise<unknown>;
		}>;
	}
}

if (typeof window !== "undefined") {
	window.phase6aSuccessorEpoch = Object.freeze({
		async run(databaseName: string): Promise<unknown> {
			const store = (await createBrowserDurableLiveJournalStore({
				primaryDatabaseName: databaseName,
			})) as unknown as CandidateJournalStore;
			try {
				const values = material();
				const anchor = values.anchor as Readonly<Record<string, unknown>>;
				const genesis = values.genesis as Readonly<Record<string, unknown>>;
				const genesisInstalled = await store.installGenesis(genesis.install as Readonly<Record<string, unknown>>);
				const genesisAppended = await store.appendAccepted(genesis.received as Readonly<Record<string, unknown>>);
				const installed = await store.installEpochAnchor(values.install as Readonly<Record<string, unknown>>);
				const repeated = await store.installEpochAnchor(values.install as Readonly<Record<string, unknown>>);
				const appended = await store.appendAccepted(values.received as Readonly<Record<string, unknown>>);
				const genesisReady = await store.readiness({ scope: genesis.scope });
				const ready = await store.readiness({ scope: values.scope });
				const genesisPage = await store.readPage({ limit: 1, scope: genesis.scope, snapshot: genesisReady.snapshot });
				const page = await store.readPage({ limit: 1, scope: values.scope, snapshot: ready.snapshot });
				const crossScopePage = await store.readPage({
					limit: 1,
					scope: values.scope,
					snapshot: genesisReady.snapshot,
				});
				const genesisRejected = await store.installGenesis(values.install as Readonly<Record<string, unknown>>);
				const invalidEpochs = await Promise.all(
					[0, -1, 1.5].map((epoch) =>
						store.installEpochAnchor({
							...(values.install as Readonly<Record<string, unknown>>),
							exactCanonicalAnchorPreimageBytes: encodeCanonical({ ...anchor, epoch }),
						})
					)
				);
				let unsafeEpochUnencodable = false;
				try {
					encodeCanonical({ ...anchor, epoch: Number.MAX_SAFE_INTEGER + 1 });
				} catch {
					unsafeEpochUnencodable = true;
				}
				const unsafeScopeRejected = await store.readiness({
					scope: { ...(values.scope as Readonly<Record<string, unknown>>), epoch: Number.MAX_SAFE_INTEGER + 1 },
				});
				const extraRejected = await store.installEpochAnchor({
					...(values.install as Readonly<Record<string, unknown>>),
					extra: true,
				});
				let hostileDispatchCount = 0;
				const hostile = Object.defineProperties(
					{},
					{
						detachedAnchorSignature: { enumerable: true, value: new Uint8Array(64).fill(7) },
						exactCanonicalAnchorPreimageBytes: {
							enumerable: true,
							value: (values.install as Readonly<Record<string, unknown>>).exactCanonicalAnchorPreimageBytes,
						},
						exactCanonicalParametersCarrierBytes: {
							enumerable: true,
							value: (values.install as Readonly<Record<string, unknown>>).exactCanonicalParametersCarrierBytes,
						},
						objectId: {
							enumerable: true,
							get: () => {
								hostileDispatchCount += 1;
								throw new Error("D108A_BROWSER_ACCESSOR_DISPATCHED");
							},
						},
					}
				);
				const hostileRejected = await store.installEpochAnchor(hostile);
				return structuredClone({
					appended,
					crossScopePage,
					extraRejected,
					genesisAppended,
					genesisInstalled,
					genesisPage,
					genesisReady,
					genesisRejected,
					hostileDispatchCount,
					hostileRejected,
					installed,
					invalidEpochs,
					page,
					ready,
					repeated,
					unsafeEpochUnencodable,
					unsafeScopeRejected,
					values,
				});
			} finally {
				await store.close();
			}
		},
	});
}
