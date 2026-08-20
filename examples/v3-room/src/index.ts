import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import type { EphemeralChannel, EphemeralChannelOptions } from "@ts-drp/ephemeral";
import { MessageQueueManager } from "@ts-drp/message-queue";
import {
	activateV3LivePlane,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
	republishV3RetainedTo,
	routeV3Ingress,
	routeV3RetainedIngress,
	type V3AdmittedVertexSink,
	type V3PlaneHandle,
} from "@ts-drp/node/v3-live";
import {
	type AdmittedReceivedVertexView,
	createAdmissionBoundTransactionalVertexIssuer,
	prepareBlueprintAdmission,
	type SignRegisteredVertexDigest,
} from "@ts-drp/protocol-v3";
import { parseStorageObjectId, type StorageObjectId } from "@ts-drp/storage";
import { createBrowserAheDurableStore } from "@ts-drp/storage-browser";
import { createBrowserDurableIssuanceStore } from "@ts-drp/storage-browser/issuance";
import { createBrowserDurableLiveJournalStore } from "@ts-drp/storage-browser/live-journal";
import type { DRPNetworkNode, Message } from "@ts-drp/types";

const CREATOR_INVITE_KEYS = Object.freeze([
	"detachedGenesisSignature",
	"exactCanonicalLatchedAclBytes",
	"exactCanonicalGenesisAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"exactCanonicalProfileBytes",
	"exactCanonicalSignerSetBytes",
	"kind",
	"pinnedGenesisAnchorDigest",
	"version",
]);

export interface V3RoomCreatorInviteMaterial {
	readonly detachedGenesisSignature: Uint8Array;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalGenesisAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly pinnedGenesisAnchorDigest: string;
}

export type V3RoomAcceptedVertex = AdmittedReceivedVertexView;

export interface V3RoomProjectionAuthority {
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly writerAuthors: readonly string[];
}

export interface V3RoomEphemeralAuthorizationProvider {
	authorForPeer(peerId: string): string | undefined;
	currentAuthority():
		| Readonly<{
				readonly aclDigest: string;
				readonly anchorDigest: string;
				readonly epoch: 0;
				readonly objectId: string;
		  }>
		| undefined;
	isCurrentWriter(author: string): boolean;
}

export interface V3RoomTransport {
	readonly networkNode: DRPNetworkNode;
	close(): void;
	openEphemeral(provider: V3RoomEphemeralAuthorizationProvider, options: EphemeralChannelOptions): EphemeralChannel;
	requestRetainedHistory(): void;
	setIngressHandler(
		ingressId: string,
		liveHandler: (message: Message) => void,
		retainedHandler: (message: Message) => void
	): void;
	setRetainedPublisher(publisher: (targetPeerId?: string) => Promise<void>): void;
}

export interface V3RoomApplication<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	readonly bootstrapOperation: Readonly<Record<string, unknown>>;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: Parameters<typeof prepareV3LiveGeneration>[0]["catalog"];
	projectAcceptedVertices(vertices: readonly V3RoomAcceptedVertex[]): Projection;
}

export interface CreateV3RoomSessionInput<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	readonly application: V3RoomApplication<Projection>;
	readonly author: string;
	readonly creatorInvite: string | V3RoomCreatorInviteMaterial;
	readonly databaseName: string;
	readonly initialLogicalTime: number;
	readonly objectId: string;
	openTransport(): V3RoomTransport;
	onAcceptedVertex(vertex: AdmittedReceivedVertexView): void | Promise<void>;
	onProjection(projection: Projection): void;
	readonly publicKeyBytes: Uint8Array;
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
}

export interface V3RoomSession<Projection extends V3RoomProjectionAuthority = V3RoomProjectionAuthority> {
	readonly invite: string;
	readonly roomId: string;
	readonly trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.";
	close(): Promise<void>;
	issue(operation: Readonly<Record<string, unknown>>): Promise<void>;
	openEphemeral(options: EphemeralChannelOptions): EphemeralChannel;
	previewLatchedAcl(): Readonly<Record<string, unknown>>;
	projection(): Projection;
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string): Uint8Array {
	if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
		throw new TypeError("v3 room hex value is invalid");
	}
	return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function encodeCreatorInvite(material: V3RoomCreatorInviteMaterial): string {
	return hex(
		encodeCanonical({
			detachedGenesisSignature: material.detachedGenesisSignature,
			exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
			exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
			exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
			kind: "ts-drp-example-v3-room-creator-invite",
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			version: 1,
		})
	);
}

function inviteBytes(values: Record<string, unknown>, field: string): Uint8Array {
	const value = values[field];
	if (!(value instanceof Uint8Array) || value.byteLength === 0) {
		throw new TypeError(`v3 room creator invite ${field} is invalid`);
	}
	return new Uint8Array(value);
}

function decodeCreatorInvite(invite: string): V3RoomCreatorInviteMaterial {
	const encoded = bytes(invite);
	const decoded = decodeCanonical(encoded, { maxBytes: 65_536, maxDepth: 4, maxItems: 128 });
	if (
		typeof decoded !== "object" ||
		decoded === null ||
		Object.getPrototypeOf(decoded) !== null ||
		!sameBytes(encodeCanonical(decoded), encoded)
	) {
		throw new TypeError("v3 room creator invite is invalid");
	}
	const keys = Reflect.ownKeys(decoded);
	if (
		keys.length !== CREATOR_INVITE_KEYS.length ||
		keys.some((key) => typeof key !== "string" || !CREATOR_INVITE_KEYS.includes(key))
	) {
		throw new TypeError("v3 room creator invite fields are invalid");
	}
	const record = decoded as Record<string, unknown>;
	const values = Object.fromEntries(
		CREATOR_INVITE_KEYS.map((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(record, key);
			if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
				throw new TypeError("v3 room creator invite field ownership is invalid");
			}
			return [key, descriptor.value] as const;
		})
	) as Record<(typeof CREATOR_INVITE_KEYS)[number], unknown>;
	if (values.kind !== "ts-drp-example-v3-room-creator-invite" || values.version !== 1) {
		throw new TypeError("v3 room creator invite version is invalid");
	}
	if (
		typeof values.pinnedGenesisAnchorDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(values.pinnedGenesisAnchorDigest)
	) {
		throw new TypeError("v3 room creator invite anchor is invalid");
	}
	const detachedGenesisSignature = inviteBytes(values, "detachedGenesisSignature");
	if (detachedGenesisSignature.byteLength !== 64) {
		throw new TypeError("v3 room creator invite signature is invalid");
	}
	return Object.freeze({
		detachedGenesisSignature,
		exactCanonicalLatchedAclBytes: inviteBytes(values, "exactCanonicalLatchedAclBytes"),
		exactCanonicalGenesisAnchorPreimageBytes: inviteBytes(values, "exactCanonicalGenesisAnchorPreimageBytes"),
		exactCanonicalParametersCarrierBytes: inviteBytes(values, "exactCanonicalParametersCarrierBytes"),
		exactCanonicalProfileBytes: inviteBytes(values, "exactCanonicalProfileBytes"),
		exactCanonicalSignerSetBytes: inviteBytes(values, "exactCanonicalSignerSetBytes"),
		pinnedGenesisAnchorDigest: values.pinnedGenesisAnchorDigest,
	});
}

/**
 * Opens one browser v3 room from application material and a real transport adapter.
 * @param input - Closed application, identity, durable-store and transport bindings.
 * @returns The active room session after durable recovery and live activation.
 */
export async function createV3RoomSession<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>
): Promise<V3RoomSession<Projection>> {
	const invite =
		typeof input.creatorInvite === "string" ? input.creatorInvite : encodeCreatorInvite(input.creatorInvite);
	const material = decodeCreatorInvite(invite);
	const objectIdResult = parseStorageObjectId(input.objectId);
	if (!objectIdResult.ok) throw new TypeError("v3 room object id is invalid");
	const { aheStore, issuanceStore, journalStore, prepared, recovered } = await prepareDurableRoomState(
		input,
		material,
		objectIdResult.value
	);
	const acceptedVertices = new Map<string, V3RoomAcceptedVertex>();
	let projection: Projection;
	let logicalTime = input.initialLogicalTime;
	const stage = (
		vertices: readonly V3RoomAcceptedVertex[]
	): Readonly<{
		readonly additions: readonly Readonly<{ readonly identity: string; readonly vertex: V3RoomAcceptedVertex }>[];
		readonly projection: Projection;
	}> => {
		const candidate = new Map(acceptedVertices);
		const additions: Readonly<{ readonly identity: string; readonly vertex: V3RoomAcceptedVertex }>[] = [];
		for (const vertex of vertices) {
			const identity = hex(vertex.digest);
			if (candidate.has(identity)) continue;
			candidate.set(identity, vertex);
			additions.push(Object.freeze({ identity, vertex }));
		}
		return Object.freeze({
			additions: Object.freeze(additions),
			projection: input.application.projectAcceptedVertices(
				Object.freeze([...candidate.values()].sort(compareAcceptedVertices))
			),
		});
	};
	const commit = async (vertices: readonly V3RoomAcceptedVertex[]): Promise<boolean> => {
		const candidate = stage(vertices);
		if (candidate.additions.length === 0) return false;
		for (const { vertex } of candidate.additions) await input.onAcceptedVertex(vertex);
		input.onProjection(candidate.projection);
		for (const { identity, vertex } of candidate.additions) {
			acceptedVertices.set(identity, vertex);
			logicalTime = Math.max(logicalTime, vertex.logicalTime + 2);
		}
		projection = candidate.projection;
		return true;
	};
	try {
		if (!(await commit(recovered.descriptor.recoveredVertices))) {
			projection = input.application.projectAcceptedVertices(Object.freeze([]));
			input.onProjection(projection);
		}
	} catch (error) {
		await Promise.all([issuanceStore.close(), journalStore.close(), aheStore.close()]);
		throw error;
	}
	const messageQueueManager = new MessageQueueManager<Message>({ logConfig: { level: "silent" } });
	let activeHandle: V3PlaneHandle | undefined;
	let transport: V3RoomTransport | undefined;
	let terminalFailure: unknown;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		if (closePromise !== undefined) return closePromise;
		closed = true;
		closePromise = (async (): Promise<void> => {
			const failures: unknown[] = [];
			try {
				activeHandle?.deactivate();
			} catch (error) {
				failures.push(error);
			}
			try {
				messageQueueManager.closeAll();
			} catch (error) {
				failures.push(error);
			}
			try {
				transport?.close();
			} catch (error) {
				failures.push(error);
			}
			for (const result of await Promise.allSettled([issuanceStore.close(), journalStore.close(), aheStore.close()])) {
				if (result.status === "rejected") failures.push(result.reason);
			}
			if (failures.length > 0) throw failures[0];
		})();
		return closePromise;
	};
	const admittedSink: V3AdmittedVertexSink = async ({ vertex }) => {
		try {
			await commit([vertex]);
		} catch (error) {
			terminalFailure = error;
			await shutdown().catch(() => undefined);
			throw error;
		}
	};
	try {
		const openedTransport = input.openTransport();
		transport = openedTransport;
		const activated = activateV3LivePlane({
			capability: recovered.capability,
			messageQueueManager,
			networkNode: openedTransport.networkNode,
			onAdmittedVertex: admittedSink,
		});
		if (!activated.ok) throw new TypeError(`v3 room activation failed: ${activated.kind}`);
		activeHandle = activated.handle;
		openedTransport.setIngressHandler(
			activeHandle.topic,
			(message) => {
				routeV3Ingress(openedTransport.networkNode, message);
			},
			(message) => {
				if (activeHandle !== undefined) routeV3RetainedIngress(activeHandle, message);
			}
		);
		openedTransport.setRetainedPublisher(async (targetPeerId) => {
			if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
			const result =
				targetPeerId === undefined
					? await activeHandle.republishRetained()
					: await republishV3RetainedTo(activeHandle, targetPeerId);
			if (!result.ok) throw new TypeError(`v3 room retained publication failed: ${result.kind}`);
		});
		openedTransport.requestRetainedHistory();
	} catch (error) {
		await shutdown().catch(() => undefined);
		throw error;
	}
	return Object.freeze({
		invite,
		roomId: prepared.descriptor.anchorDigest,
		trustStatus: "Creator-trusted; not Byzantine-fault-tolerant." as const,
		async close(): Promise<void> {
			await shutdown();
		},
		async issue(operation: Readonly<Record<string, unknown>>): Promise<void> {
			if (terminalFailure !== undefined) throw terminalFailure;
			if (closed) throw new TypeError("v3 room session is closed");
			const current = logicalTime;
			logicalTime += 2;
			if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
			const issued = await activeHandle.issueLocal({
				dependencies: [prepared.descriptor.anchorDigest],
				logicalTime: current,
				operation,
				signRegisteredVertexDigest: input.signRegisteredVertexDigest,
			});
			if (terminalFailure !== undefined) throw terminalFailure;
			if (!issued.ok) throw new TypeError(`v3 room issue failed: ${issued.kind}`);
			const published = await activeHandle.publishPending();
			if (!published.ok || published.kind !== "published") {
				throw new TypeError(`v3 room publication failed: ${published.kind}`);
			}
		},
		openEphemeral(options: EphemeralChannelOptions): EphemeralChannel {
			if (terminalFailure !== undefined) throw terminalFailure;
			if (closed) throw new TypeError("v3 room session is closed");
			if (transport === undefined) throw new TypeError("v3 room transport is unavailable");
			return transport.openEphemeral(
				{
					authorForPeer(peerId: string): string | undefined {
						const matches = projection.transportPeerAuthors.filter((entry) => entry.peerId === peerId);
						return matches.length === 1 ? matches[0]?.author : undefined;
					},
					currentAuthority() {
						return activeHandle?.currentEphemeralAuthority();
					},
					isCurrentWriter(author: string): boolean {
						return activeHandle?.currentEphemeralAuthority()?.isCurrentWriter(author) === true;
					},
				},
				options
			);
		},
		previewLatchedAcl(): Readonly<Record<string, unknown>> {
			if (terminalFailure !== undefined) throw terminalFailure;
			if (activeHandle === undefined) throw new TypeError("v3 room live plane is unavailable");
			const preview = Reflect.get(activeHandle, "previewLatchedAcl");
			if (typeof preview !== "function") throw new TypeError("v3 room latched ACL preview is unavailable");
			const result = Reflect.apply(preview, activeHandle, []) as unknown;
			if (typeof result !== "object" || result === null) {
				throw new TypeError("v3 room latched ACL preview is invalid");
			}
			return result as Readonly<Record<string, unknown>>;
		},
		projection(): Projection {
			if (terminalFailure !== undefined) throw terminalFailure;
			return projection;
		},
	});
}

async function prepareDurableRoomState<Projection extends V3RoomProjectionAuthority>(
	input: CreateV3RoomSessionInput<Projection>,
	material: V3RoomCreatorInviteMaterial,
	objectId: StorageObjectId
): Promise<
	Readonly<{
		readonly aheStore: Awaited<ReturnType<typeof createBrowserAheDurableStore>>;
		readonly issuanceStore: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>;
		readonly journalStore: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>>;
		readonly prepared: Extract<Awaited<ReturnType<typeof prepareV3LiveGeneration>>, { readonly ok: true }>;
		readonly recovered: Extract<Awaited<ReturnType<typeof recoverV3LiveReplica>>, { readonly ok: true }>;
	}>
> {
	const aheStore = await createBrowserAheDurableStore({ databaseName: `${input.databaseName}--ahe` });
	let issuanceStore: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>> | undefined;
	let journalStore: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>> | undefined;
	try {
		const trustStore = createCurrentAnchorTrustStore({
			objectId,
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			store: aheStore,
		});
		const installed = await trustStore.install({
			detachedGenesisSignature: material.detachedGenesisSignature,
			exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
		});
		if (!installed.ok && installed.reason !== "already-installed") {
			throw new TypeError(`v3 room trust installation failed: ${installed.reason}`);
		}
		const openedTrust = installed.ok ? installed : await trustStore.open();
		if (!openedTrust.ok || openedTrust.trust.profileId !== "creator-trusted-v1") {
			throw new TypeError("v3 room verified trust profile is invalid");
		}
		const prepared = await prepareV3LiveGeneration({
			authenticationProfile: "creator-only",
			store: aheStore,
			objectId,
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			exactCanonicalAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
			detachedSignature: material.detachedGenesisSignature,
			exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
			catalog: input.application.catalog,
		});
		if (!prepared.ok) throw new TypeError(`v3 room preparation failed: ${prepared.kind}`);
		const openedIssuanceStore = await createBrowserDurableIssuanceStore({ primaryDatabaseName: input.databaseName });
		issuanceStore = openedIssuanceStore;
		const openedJournalStore = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: input.databaseName });
		journalStore = openedJournalStore;
		const scope = Object.freeze({ author: input.author, objectId: input.objectId });
		const lineage = await openedIssuanceStore.readLineage(scope);
		if (lineage.next === 0) {
			const admission = prepareBlueprintAdmission({
				canonicalBlueprintPackageBytes: input.application.canonicalBlueprintPackageBytes,
				expectedBlueprintDigest: prepared.descriptor.blueprintDigest,
			});
			const issuer = createAdmissionBoundTransactionalVertexIssuer({
				author: input.author,
				preparedBlueprintAdmission: admission,
				publicKey: Object.freeze({ bytes: new Uint8Array(input.publicKeyBytes), format: "raw" as const }),
				signRegisteredVertexDigest: input.signRegisteredVertexDigest,
				transactIssue: (selectedScope, buildAndSign) => openedIssuanceStore.transactIssue(selectedScope, buildAndSign),
			});
			const bootstrap = await issuer.issue({
				anchor: material.pinnedGenesisAnchorDigest,
				dependencies: [material.pinnedGenesisAnchorDigest],
				epoch: 0,
				logicalTime: 1,
				objectId: input.objectId,
				operation: input.application.bootstrapOperation,
			});
			await openedIssuanceStore.compareAndMarkOutboxPublished({
				authorSequence: bootstrap.authorSequence,
				digest: bootstrap.envelope.digest,
				scope,
			});
		}
		const recovered = await recoverV3LiveReplica({
			capability: prepared.capability,
			exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
			issuanceScope: scope,
			issuanceStore: openedIssuanceStore,
			liveJournalStore: openedJournalStore,
		});
		if (!recovered.ok) throw new TypeError(`v3 room recovery failed: ${recovered.kind}`);
		return Object.freeze({
			aheStore,
			issuanceStore: openedIssuanceStore,
			journalStore: openedJournalStore,
			prepared,
			recovered,
		});
	} catch (error) {
		const closers: Promise<void>[] = [aheStore.close()];
		if (issuanceStore !== undefined) closers.push(issuanceStore.close());
		if (journalStore !== undefined) closers.push(journalStore.close());
		await Promise.allSettled(closers);
		throw error;
	}
}

function compareAcceptedVertices(left: V3RoomAcceptedVertex, right: V3RoomAcceptedVertex): number {
	return (
		left.epoch - right.epoch ||
		left.logicalTime - right.logicalTime ||
		compareText(left.author, right.author) ||
		left.authorSequence - right.authorSequence ||
		compareText(hex(left.digest), hex(right.digest))
	);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
