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

export const PHASE_3H_MIGRATION_RECORD_KEYS = Object.freeze([
	"applicationStateDigest",
	"archivePolicy",
	"authorityKind",
	"exactCanonicalApplicationStateBytes",
	"kind",
	"rehearsalNonce",
	"sourceAcceptedOperationCount",
	"sourceAcceptedOperationsDigest",
	"sourceAnchorDigest",
	"sourceBlueprintDigest",
	"sourceCreatorAuthor",
	"sourceObjectId",
	"targetAnchorDigest",
	"targetBlueprintDigest",
	"targetCreatorAuthor",
	"targetImportOperationCount",
	"targetImportOperationsDigest",
	"targetObjectId",
	"version",
] as const);

export const PHASE_3H_MIGRATION_DOMAINS = Object.freeze({
	activation: "ts-drp/v3-room-migration-activation/v1",
	import: "ts-drp/v3-room-migration-import/v1",
	record: "ts-drp/v3-room-migration-record/v1",
	scratch: "ts-drp/v3-room-migration-scratch/v1",
	source: "ts-drp/v3-room-migration-source/v1",
	state: "ts-drp/v3-room-migration-state/v1",
	targetObject: "ts-drp/v3-room-migration-target-object/v1",
} as const);

export const PHASE_3H_MIGRATION_ACTIVATION_DECISION_KEYS = Object.freeze([
	"activationAuthority",
	"applicationStateDigest",
	"exactCanonicalTargetCreatorInviteBytes",
	"kind",
	"migrationRecordDigest",
	"migrationRecordVertexDigest",
	"rehearsalNonce",
	"sourceAcceptedOperationCount",
	"sourceAcceptedOperationsDigest",
	"sourceAnchorDigest",
	"sourceBlueprintDigest",
	"sourceCreatorAuthor",
	"sourceObjectId",
	"targetAnchorDigest",
	"targetBlueprintDigest",
	"targetCreatorAuthor",
	"targetImportOperationCount",
	"targetImportOperationsDigest",
	"targetObjectId",
	"version",
] as const);

export const PHASE_3H_TERMINAL_DISPOSITIONS = Object.freeze([
	"continue",
	"retained-bootstrap-ready",
	"terminal-accepted",
	"terminal-rejected",
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
	"scope.classify",
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

/* eslint-disable @typescript-eslint/no-invalid-void-type -- the signed sink contract deliberately retains legacy void beside terminal dispositions. */
export type V3AdmittedVertexSinkContract = (
	delivery: Readonly<{
		readonly vertex: AdmittedReceivedVertexView;
		readonly exactReceivedCanonicalPreimageBytes: Uint8Array;
		readonly signature: Uint8Array;
		readonly transportSender: string;
	}>
) =>
	| void
	| Readonly<{ readonly kind: "continue" | "retained-bootstrap-ready" | "terminal-accepted" | "terminal-rejected" }>
	| Promise<void | Readonly<{
			readonly kind: "continue" | "retained-bootstrap-ready" | "terminal-accepted" | "terminal-rejected";
	  }>>;
/* eslint-enable @typescript-eslint/no-invalid-void-type */

export interface V3PlaneHandleContract {
	readonly objectId: string;
	readonly epoch: number;
	readonly topic: string;
	readonly queueId: string;
	currentEphemeralAuthority():
		| Readonly<{
				readonly aclDigest: string;
				readonly anchorDigest: string;
				readonly epoch: number;
				readonly objectId: string;
				isCurrentWriter(author: string): boolean;
		  }>
		| undefined;
	issueLocal(input: V3LocalIssueInputContract): Promise<V3LocalIssueResultContract>;
	readRebaseOutbox(): Promise<
		| Readonly<{ readonly ok: true; readonly kind: "empty" }>
		| Readonly<{
				readonly ok: true;
				readonly kind: "displaced";
				readonly source: Readonly<{
					readonly author: string;
					readonly authorSequence: number;
					readonly publishState?: "pending" | "published";
					readonly vertexDigest: string;
					readonly intents: readonly Readonly<{
						readonly logicalTime: number;
						readonly operation: Readonly<Record<string, unknown>>;
						readonly operationCount: number;
						readonly operationIndex: number;
					}>[];
				}>;
		  }>
		| Readonly<{ readonly ok: false; readonly kind: "not-active" | "record-rejected" | "store-failed" }>
	>;
	completeRebaseSource(
		input: Readonly<{ readonly authorSequence: number; readonly digest: string }>
	): Promise<V3EgressResultContract>;
	publishPending(): Promise<V3EgressResultContract>;
	republishRetained(): Promise<V3EgressResultContract>;
	beginTerminalTransition(): Promise<
		| Readonly<{
				readonly ok: true;
				readonly capability: Readonly<{
					publishTerminal(input: V3LocalIssueInputContract): Promise<
						| Readonly<{
								readonly ok: true;
								readonly kind: "accepted";
								readonly authorSequence: number;
								readonly digest: string;
								readonly terminalIntent: "committed";
						  }>
						| Readonly<{
								readonly ok: false;
								readonly kind:
									| "not-active"
									| "malformed-input"
									| "authorization-rejected"
									| "issuance-rejected"
									| "admission-rejected"
									| "journal-rejected"
									| "graph-rejected"
									| "terminal-rejected";
								readonly detail: string;
								readonly terminalIntent: "absent" | "outcome-unknown";
						  }>
					>;
					resume():
						| Readonly<{ readonly ok: true; readonly kind: "resumed" }>
						| Readonly<{ readonly ok: false; readonly kind: "invalid-state"; readonly detail: string }>;
				}>;
		  }>
		| Readonly<{
				readonly ok: false;
				readonly kind: "not-active" | "transition-active" | "already-terminal";
				readonly detail: string;
		  }>
	>;
	deactivate(): void;
}

export interface V3LocalIssueInputContract {
	readonly operations: readonly Readonly<{
		readonly logicalTime: number;
		readonly operation: Readonly<Record<string, unknown>>;
	}>[];
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
}

export type V3LocalIssueResultContract =
	| Readonly<{ readonly ok: true; readonly kind: "accepted"; readonly authorSequence: number; readonly digest: string }>
	| Readonly<{
			readonly ok: false;
			readonly kind: "split-required";
			readonly detail: string;
			readonly prefixLength: number;
	  }>
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
