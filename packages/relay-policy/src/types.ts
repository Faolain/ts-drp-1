export type RelayCandidateOrigin = "browser-closest-peers" | "node-closest-peers";

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

export interface RelayCandidate {
	readonly addresses: readonly string[];
	readonly operatorGroup: string;
	readonly peerId: string;
	readonly protocols: readonly string[];
	readonly provenance: {
		readonly origin: RelayCandidateOrigin;
		readonly queryDigest: string;
		readonly resultIndex: number;
		readonly routingSource: "delegated-routing" | "public-dht";
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
