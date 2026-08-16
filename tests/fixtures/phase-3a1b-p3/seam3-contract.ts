import type { MessageQueueManager } from "@ts-drp/message-queue";
import type { AdmittedReceivedVertexView, SignRegisteredVertexDigest } from "@ts-drp/protocol-v3";
import type { DRPNetworkNode, Message } from "@ts-drp/types";

export const SEAM3_BUF_CLI_PACKAGE = "@bufbuild/buf@1.69.0";
export const SEAM3_BUF_VERSION = "1.69.0";
export const SEAM3_TS_PROTO_PACKAGE = "ts-proto";
export const SEAM3_TS_PROTO_VERSION = "2.7.0";
export const SEAM3_TS_PROTO_PLUGIN = "./node_modules/ts-proto/protoc-gen-ts_proto";
export const SEAM3_BUF_GENERATE_ARGS = Object.freeze([
	"generate",
	"packages/types/src/proto",
	"-o",
	"packages/types/src/proto",
] as const);

export const SEAM3_TYPES_GENERATED_MESSAGE_EXPORTS = Object.freeze([
	"AttestationUpdate",
	"DRPDiscovery",
	"DRPDiscoveryResponse",
	"DRPDiscoveryResponse_Subscribers",
	"DRPDiscoveryResponse_SubscribersEntry",
	"FetchState",
	"FetchStateResponse",
	"Message",
	"MessageType",
	"Sync",
	"SyncAccept",
	"SyncReject",
	"Update",
	"V3Envelope",
] as const);

export const SEAM3_TYPES_RUNTIME_EXPORTS = Object.freeze([
	"ACLConflictResolution",
	"ACLGroup",
	"ActionType",
	"AggregatedAttestation",
	"Attestation",
	"AttestationUpdate",
	"DRPDiscovery",
	"DRPDiscoveryResponse",
	"DRPDiscoveryResponse_Subscribers",
	"DRPDiscoveryResponse_SubscribersEntry",
	"DRPObjectBase",
	"DRPState",
	"DRPStateEntry",
	"DRPStateEntryOtherTheWire",
	"DRPStateOtherTheWire",
	"DRP_DISCOVERY_TOPIC",
	"DRP_INTERVAL_DISCOVERY_TOPIC",
	"DrpType",
	"FetchState",
	"FetchStateResponse",
	"IntervalRunnerState",
	"Message",
	"MessageType",
	"NodeEventName",
	"Operation",
	"SemanticsType",
	"Sync",
	"SyncAccept",
	"SyncReject",
	"Update",
	"V3Envelope",
	"Vertex",
] as const);

export const ACTIVATION_FAILURE_KINDS = Object.freeze([
	"malformed-input",
	"capability-consumed",
	"not-started",
	"topic-derivation-failed",
	"queue-capacity",
	"subscribe-failed",
	"internal-invariant",
] as const);

export const EGRESS_FAILURE_KINDS = Object.freeze([
	"not-active",
	"store-failed",
	"record-rejected",
	"publish-failed",
	"publication-state-unknown",
] as const);

export const ACTIVATION_ORDER = Object.freeze([
	"outer.snapshot",
	"capability.consume",
	"nested.validate",
	"network.started",
	"topic.derive",
	"registration.inspect",
	"ownership.inspect",
	"queue.subscribe",
	"queue.postcondition",
	"network.subscribe",
	"network.postcondition",
	"registration.install",
] as const);

export const INGRESS_ORDER = Object.freeze([
	"provenance.lookup",
	"registration.lookup",
	"wire.classify",
	"queue.enqueue",
	"handler.revalidate",
	"envelope.snapshot",
	"envelope.decode",
	"envelope.reencode",
	"envelope.detach",
	"vertex.extract",
	"journal.append",
	"index.append",
	"sink.invoke",
] as const);

export const EGRESS_ORDER = Object.freeze([
	"gate.enter",
	"liveness.entry",
	"scope.copy",
	"page.read",
	"liveness.after-page",
	"page.snapshot",
	"published.skip",
	"pending.snapshot",
	"message.encode",
	"liveness.before-publish",
	"publish.invoke",
	"publish.literal-true",
	"liveness.before-mark",
	"mark.invoke",
	"mark.settle",
] as const);

export interface V3PlaneActivationInputContract {
	readonly capability: object;
	readonly messageQueueManager: MessageQueueManager<Message>;
	readonly networkNode: DRPNetworkNode;
	readonly onAdmittedVertex: V3AdmittedVertexSinkContract;
}

export type V3AdmittedVertexSinkContract = (
	delivery: Readonly<{
		readonly vertex: AdmittedReceivedVertexView;
		readonly exactReceivedCanonicalPreimageBytes: Uint8Array;
		readonly signature: Uint8Array;
		readonly transportSender: string;
	}>
) => void | Promise<void>;

export interface V3PlaneHandleContract {
	readonly objectId: string;
	readonly epoch: 0;
	readonly topic: string;
	readonly queueId: string;
	issueLocal(input: V3LocalIssueInputContract): Promise<V3LocalIssueResultContract>;
	publishPending(): Promise<V3EgressResultContract>;
	republishRetained(): Promise<V3EgressResultContract>;
	deactivate(): void;
}

export interface V3LocalIssueInputContract {
	readonly dependencies: readonly string[];
	readonly logicalTime: number;
	readonly operation: Readonly<Record<string, unknown>>;
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
}

export type V3LocalIssueResultContract =
	| Readonly<{ readonly ok: true; readonly kind: "accepted"; readonly authorSequence: number; readonly digest: string }>
	| Readonly<{
			readonly ok: false;
			readonly kind:
				| "not-active"
				| "malformed-input"
				| "authorization-rejected"
				| "issuance-rejected"
				| "admission-rejected"
				| "journal-rejected"
				| "graph-rejected";
			readonly detail: string;
	  }>;

export type V3PlaneActivationResultContract =
	| Readonly<{ ok: true; handle: V3PlaneHandleContract }>
	| Readonly<{
			ok: false;
			kind: (typeof ACTIVATION_FAILURE_KINDS)[number];
			detail: string;
	  }>;

export type V3EgressResultContract =
	| Readonly<{ ok: true; kind: "empty" | "published" }>
	| Readonly<{
			ok: false;
			kind: (typeof EGRESS_FAILURE_KINDS)[number];
			detail: string;
	  }>;

export interface Seam3PrivateSurface {
	activateV3LivePlane?(input: V3PlaneActivationInputContract): V3PlaneActivationResultContract;
	prepareV3LiveGeneration?(input: unknown): Promise<unknown>;
	recoverV3LiveReplica?(
		input: Readonly<Record<string, unknown>>
	): Promise<
		| Readonly<{ readonly ok: true; readonly capability: object }>
		| Readonly<{ readonly ok: false; readonly kind: string }>
	>;
	routeV3Ingress?(networkNode: DRPNetworkNode, message: Message): boolean;
}
