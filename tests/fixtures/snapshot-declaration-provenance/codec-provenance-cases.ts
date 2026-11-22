export const CODEC_BOUNDARIES = [
	"canonical-text-decode",
	"canonical-input-copy",
	"protocol-text-decode",
	"protocol-canonical-input-copy",
	"protocol-owned-allocation",
	"protocol-canonical-reencode",
] as const;
export type CodecBoundary = (typeof CODEC_BOUNDARIES)[number];
export const THROWN_VALUES = ["range-error", "misleading-type-error", "non-error"] as const;
export type ThrownValue = (typeof THROWN_VALUES)[number];
export interface ProvenanceEvent {
	phase: string;
	kind: string;
	stack: string;
	injected: boolean;
}
export interface ProvenanceResult {
	boundary: CodecBoundary;
	thrownValue: ThrownValue;
	bindings: { canonical: string; protocol: string; canonicalSha256: string; protocolSha256: string };
	controls: {
		importSucceeded: true;
		unarmedValid: true;
		recoveryValid: true;
		inputUnchanged: true;
		sameModuleDomainError: true;
		nativePrototypesPreserved: true;
	};
	events: ProvenanceEvent[];
	injections: number;
	observed: {
		threw: boolean;
		isExactSentinel: boolean;
		code: string | null;
		causeIncludesSentinel: boolean;
		chain: { name: string | null; code: string | null; message: string | null; isSentinel: boolean }[];
	};
}
