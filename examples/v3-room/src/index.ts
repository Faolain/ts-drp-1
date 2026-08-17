import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import { MessageQueueManager } from "@ts-drp/message-queue";
import {
	activateV3LivePlane,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
	routeV3Ingress,
	type V3AdmittedVertexSink,
} from "@ts-drp/node/v3-live";
import {
	type AdmittedReceivedVertexView,
	createAdmissionBoundTransactionalVertexIssuer,
	prepareBlueprintAdmission,
	type SignRegisteredVertexDigest,
} from "@ts-drp/protocol-v3";
import { parseStorageObjectId } from "@ts-drp/storage";
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

export interface V3RoomTransport {
	readonly networkNode: DRPNetworkNode;
	close(): void;
	requestRetainedHistory(): void;
	setIngressHandler(handler: (message: Message) => void): void;
	setRetainedPublisher(publisher: () => Promise<void>): void;
}

export interface V3RoomApplication {
	readonly bootstrapOperation: Readonly<Record<string, unknown>>;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: Parameters<typeof prepareV3LiveGeneration>[0]["catalog"];
}

export interface CreateV3RoomSessionInput {
	readonly application: V3RoomApplication;
	readonly author: string;
	readonly creatorInvite: string | V3RoomCreatorInviteMaterial;
	readonly databaseName: string;
	readonly initialLogicalTime: number;
	readonly objectId: string;
	openTransport(): V3RoomTransport;
	onAcceptedVertex(vertex: AdmittedReceivedVertexView): void | Promise<void>;
	readonly publicKeyBytes: Uint8Array;
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
}

export interface V3RoomSession {
	readonly invite: string;
	readonly roomId: string;
	readonly trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.";
	close(): Promise<void>;
	issue(operation: Readonly<Record<string, unknown>>): Promise<void>;
	previewLatchedAcl(): Readonly<Record<string, unknown>>;
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
export async function createV3RoomSession(input: CreateV3RoomSessionInput): Promise<V3RoomSession> {
	const invite =
		typeof input.creatorInvite === "string" ? input.creatorInvite : encodeCreatorInvite(input.creatorInvite);
	const material = decodeCreatorInvite(invite);
	const objectIdResult = parseStorageObjectId(input.objectId);
	if (!objectIdResult.ok) throw new TypeError("v3 room object id is invalid");
	const aheStore = await createBrowserAheDurableStore({ databaseName: `${input.databaseName}--ahe` });
	const trustStore = createCurrentAnchorTrustStore({
		objectId: objectIdResult.value,
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
		objectId: objectIdResult.value,
		pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
		exactCanonicalAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
		detachedSignature: material.detachedGenesisSignature,
		exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
		catalog: input.application.catalog,
	});
	if (!prepared.ok) throw new TypeError(`v3 room preparation failed: ${prepared.kind}`);
	const issuanceStore = await createBrowserDurableIssuanceStore({ primaryDatabaseName: input.databaseName });
	const journalStore = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: input.databaseName });
	const scope = Object.freeze({ author: input.author, objectId: input.objectId });
	const lineage = await issuanceStore.readLineage(scope);
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
			transactIssue: (selectedScope, buildAndSign) => issuanceStore.transactIssue(selectedScope, buildAndSign),
		});
		const bootstrap = await issuer.issue({
			anchor: material.pinnedGenesisAnchorDigest,
			dependencies: [material.pinnedGenesisAnchorDigest],
			epoch: 0,
			logicalTime: 1,
			objectId: input.objectId,
			operation: input.application.bootstrapOperation,
		});
		await issuanceStore.compareAndMarkOutboxPublished({
			authorSequence: bootstrap.authorSequence,
			digest: bootstrap.envelope.digest,
			scope,
		});
	}
	const recovered = await recoverV3LiveReplica({
		capability: prepared.capability,
		exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
		issuanceScope: scope,
		issuanceStore,
		liveJournalStore: journalStore,
	});
	if (!recovered.ok) throw new TypeError(`v3 room recovery failed: ${recovered.kind}`);
	for (const vertex of recovered.descriptor.recoveredVertices) await input.onAcceptedVertex(vertex);
	const transport = input.openTransport();
	const messageQueueManager = new MessageQueueManager<Message>({ logConfig: { level: "silent" } });
	const admittedSink: V3AdmittedVertexSink = ({ vertex }) => input.onAcceptedVertex(vertex);
	const activated = activateV3LivePlane({
		capability: recovered.capability,
		messageQueueManager,
		networkNode: transport.networkNode,
		onAdmittedVertex: admittedSink,
	});
	if (!activated.ok) {
		messageQueueManager.closeAll();
		transport.close();
		await Promise.all([issuanceStore.close(), journalStore.close(), aheStore.close()]);
		throw new TypeError(`v3 room activation failed: ${activated.kind}`);
	}
	transport.setIngressHandler((message) => routeV3Ingress(transport.networkNode, message));
	transport.setRetainedPublisher(async () => {
		const result = await activated.handle.republishRetained();
		if (!result.ok) throw new TypeError(`v3 room retained publication failed: ${result.kind}`);
	});
	transport.requestRetainedHistory();
	let logicalTime = recovered.descriptor.recoveredVertices.reduce(
		(maximum, vertex) => Math.max(maximum, vertex.logicalTime + 2),
		input.initialLogicalTime
	);
	let closed = false;
	return Object.freeze({
		invite,
		roomId: prepared.descriptor.anchorDigest,
		trustStatus: "Creator-trusted; not Byzantine-fault-tolerant." as const,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			activated.handle.deactivate();
			messageQueueManager.closeAll();
			transport.close();
			await Promise.all([issuanceStore.close(), journalStore.close(), aheStore.close()]);
		},
		async issue(operation: Readonly<Record<string, unknown>>): Promise<void> {
			if (closed) throw new TypeError("v3 room session is closed");
			const current = logicalTime;
			logicalTime += 2;
			const issued = await activated.handle.issueLocal({
				dependencies: [prepared.descriptor.anchorDigest],
				logicalTime: current,
				operation,
				signRegisteredVertexDigest: input.signRegisteredVertexDigest,
			});
			if (!issued.ok) throw new TypeError(`v3 room issue failed: ${issued.kind}`);
			const published = await activated.handle.publishPending();
			if (!published.ok || published.kind !== "published") {
				throw new TypeError(`v3 room publication failed: ${published.kind}`);
			}
		},
		previewLatchedAcl(): Readonly<Record<string, unknown>> {
			const preview = Reflect.get(activated.handle, "previewLatchedAcl");
			if (typeof preview !== "function") throw new TypeError("v3 room latched ACL preview is unavailable");
			const result = Reflect.apply(preview, activated.handle, []) as unknown;
			if (typeof result !== "object" || result === null) {
				throw new TypeError("v3 room latched ACL preview is invalid");
			}
			return result as Readonly<Record<string, unknown>>;
		},
	});
}
