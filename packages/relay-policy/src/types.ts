export type RelayCandidateOrigin =
	| "browser-closest-peers"
	| "cached-relay"
	| "configured-fallback"
	| "configured-relay"
	| "dht-relay-provider"
	| "node-connected-hop"
	| "registry-relay-record";

export type RelayCandidateRoutingSource =
	| "configured"
	| "connected-peers"
	| "delegated-routing"
	| "peer-cache"
	| "public-dht"
	| "registry";

export type RelayReservationFailure =
	| "aborted"
	| "connection-failed"
	| "malformed-response"
	| "no-reservation"
	| "permission-denied"
	| "refused"
	| "resource-limit"
	| "timeout"
	| "unexpected-response";

export interface RelayOperatorEvidence {
	readonly credential: string;
	readonly signedRecordDigest: string;
}

export interface VerifiedRelayOperatorEvidence {
	readonly credentialDigest: string;
	readonly operatorGroup: string;
	readonly verified: true;
}

export type RelayCandidateOperatorEvidence = RelayOperatorEvidence | VerifiedRelayOperatorEvidence;

export interface RelayCandidate {
	readonly addresses: readonly string[];
	readonly operatorEvidence?: RelayCandidateOperatorEvidence;
	readonly operatorGroup: string;
	readonly peerId: string;
	readonly protocols: readonly string[];
	readonly provenance: {
		readonly origin: RelayCandidateOrigin;
		readonly queryDigest: string;
		readonly resultIndex: number;
		readonly routingSource: RelayCandidateRoutingSource;
	};
}

export interface RelayInspection {
	readonly connectionId?: string;
	readonly hopAdvertised: boolean;
	readonly latencyMs: number;
	readonly outcome: "aborted" | "connected" | "refused" | "timeout";
	readonly protocols: readonly string[];
}

export interface RelayInspector {
	inspect(candidate: RelayCandidate, address: string, signal: AbortSignal): Promise<RelayInspection>;
}

export interface RelayReservationWireResponse {
	readonly expire?: bigint | number;
	readonly limit?: {
		readonly data?: bigint | number;
		readonly duration?: number;
	};
	readonly reservation?: {
		readonly expire: bigint | number;
	};
	readonly status: number;
}

export interface RelayReservationClient {
	refresh(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse>;
	release(candidate: RelayCandidate): Promise<void>;
	reserve(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse>;
}
