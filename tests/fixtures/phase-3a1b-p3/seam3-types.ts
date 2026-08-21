import type { MessageQueueManager } from "@ts-drp/message-queue";
import type { AdmittedReceivedVertexView, SignRegisteredVertexDigest } from "@ts-drp/protocol-v3";
import { type DRPNetworkNode, type Message, type V3Envelope, V3Envelope as V3EnvelopeCodec } from "@ts-drp/types";

import type {
	activateV3LivePlane,
	RecoveredV3Live,
	routeV3Ingress,
	V3AdmittedVertexSink,
	V3EgressResult,
	V3LocalIssueInput,
	V3LocalIssueResult,
	V3PlaneActivationInput,
	V3PlaneActivationResult,
	V3PlaneHandle,
} from "../../../packages/node/src/v3-live.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type ExpectedV3Envelope = {
	canonicalPreimage: Uint8Array;
	signature: Uint8Array;
};

type ExpectedSink = (
	delivery: Readonly<{
		readonly vertex: AdmittedReceivedVertexView;
		readonly exactReceivedCanonicalPreimageBytes: Uint8Array;
		readonly signature: Uint8Array;
		readonly transportSender: string;
	}>
) => void | Promise<void>;

interface ExpectedHandle {
	readonly objectId: string;
	readonly epoch: 0;
	readonly topic: string;
	readonly queueId: string;
	currentEphemeralAuthority(): ExpectedEphemeralAuthority | undefined;
	issueLocal(input: ExpectedLocalIssueInput): Promise<ExpectedLocalIssueResult>;
	publishPending(): Promise<ExpectedEgress>;
	republishRetained(): Promise<ExpectedEgress>;
	deactivate(): void;
}

interface ExpectedEphemeralAuthority {
	readonly aclDigest: string;
	readonly anchorDigest: string;
	readonly epoch: 0;
	readonly objectId: string;
	isCurrentWriter(author: string): boolean;
}

interface ExpectedLocalIssueInput {
	readonly operations: readonly Readonly<{
		readonly logicalTime: number;
		readonly operation: Readonly<Record<string, unknown>>;
	}>[];
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
}

type ExpectedLocalIssueResult =
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

interface ExpectedInput {
	readonly capability: RecoveredV3Live;
	readonly messageQueueManager: MessageQueueManager<Message>;
	readonly networkNode: DRPNetworkNode;
	readonly onAdmittedVertex: ExpectedSink;
}

type ExpectedActivationResult =
	| Readonly<{ ok: true; handle: ExpectedHandle }>
	| Readonly<{
			ok: false;
			kind:
				| "malformed-input"
				| "capability-consumed"
				| "not-started"
				| "topic-derivation-failed"
				| "queue-capacity"
				| "subscribe-failed"
				| "internal-invariant";
			detail: string;
	  }>;

type ExpectedEgress =
	| Readonly<{ ok: true; kind: "empty" | "published" }>
	| Readonly<{
			ok: false;
			kind: "not-active" | "store-failed" | "record-rejected" | "publish-failed" | "publication-state-unknown";
			detail: string;
	  }>;

type _Input = Assert<Equal<V3PlaneActivationInput, ExpectedInput>>;
type _Sink = Assert<Equal<V3AdmittedVertexSink, ExpectedSink>>;
type _Activation = Assert<Equal<V3PlaneActivationResult, ExpectedActivationResult>>;
type _Egress = Assert<Equal<V3EgressResult, ExpectedEgress>>;
type _LocalIssueInput = Assert<Equal<V3LocalIssueInput, ExpectedLocalIssueInput>>;
type _LocalIssueResult = Assert<Equal<V3LocalIssueResult, ExpectedLocalIssueResult>>;
type _Handle = Assert<Equal<V3PlaneHandle, ExpectedHandle>>;
type _Activate = Assert<Equal<typeof activateV3LivePlane, (input: ExpectedInput) => ExpectedActivationResult>>;
type _Route = Assert<Equal<typeof routeV3Ingress, (networkNode: DRPNetworkNode, message: Message) => boolean>>;
type _Deactivate = Assert<Equal<ReturnType<V3PlaneHandle["deactivate"]>, void>>;
type _V3Envelope = Assert<Equal<V3Envelope, ExpectedV3Envelope>>;

declare const handle: V3PlaneHandle;
declare const localIssueInput: ExpectedLocalIssueInput;
const handleShape: readonly [
	string,
	0,
	string,
	string,
	ExpectedEphemeralAuthority | undefined,
	Promise<ExpectedLocalIssueResult>,
	Promise<ExpectedEgress>,
	Promise<ExpectedEgress>,
] = [
	handle.objectId,
	handle.epoch,
	handle.topic,
	handle.queueId,
	handle.currentEphemeralAuthority(),
	handle.issueLocal(localIssueInput),
	handle.publishPending(),
	handle.republishRetained(),
];
handle.deactivate();
const exactWireValue: V3Envelope = {
	canonicalPreimage: Uint8Array.of(1, 2),
	signature: Uint8Array.of(3),
};
const exactWireBytes: Uint8Array = V3EnvelopeCodec.encode(exactWireValue).finish();
const decodedWireValue: V3Envelope = V3EnvelopeCodec.decode(exactWireBytes);
void handleShape;
void decodedWireValue;
