import {
	openCurrentEpochAuthorAuthorization,
	resolveCurrentEpochAuthorizedAuthor,
} from "../../../packages/protocol-v3/src/author-authorization.js";
import type {
	AuthenticateCurrentEpochAnchorFailureReason,
	AuthenticateCurrentEpochAnchorSuccessProvenance,
	CurrentEpochAuthorAuthorization,
	OpenCurrentEpochAuthorAuthorizationInput,
	OpenCurrentEpochAuthorAuthorizationResult,
	ResolveCurrentEpochAuthorizedAuthorInput,
	ResolveCurrentEpochAuthorizedAuthorResult,
} from "../../../packages/protocol-v3/src/author-authorization.js";
import type { CurrentAnchorTrust, RawEd25519PublicKey } from "../../../packages/protocol-v3/src/public.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;
type ExpectedProvenance = Readonly<{
	readonly anchorDigest: string;
	readonly blueprintDigest: string;
	readonly epoch: number;
	readonly objectId: string;
	readonly parametersDigest: string;
	readonly profileDigest: string;
	readonly signerSetDigest: string;
}>;
type ExpectedAuthorization = Readonly<{
	readonly aclDigest: string;
	readonly currentAnchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
	readonly profileId: "creator-author-authorization-v1";
}>;
type ExpectedOpenInput = Readonly<{
	readonly detachedAnchorSignature: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalAuthorAuthorizationBytes: Uint8Array;
	readonly trust: CurrentAnchorTrust;
}>;
type ExpectedResolveInput = Readonly<{ authorization: CurrentEpochAuthorAuthorization; author: string }>;
type ExpectedOpenResult =
	| Readonly<{ ok: false; reason: "malformed-input" }>
	| Readonly<{
			cause: AuthenticateCurrentEpochAnchorFailureReason;
			ok: false;
			reason: "anchor-rejected";
	  }>
	| Readonly<{
			ok: false;
			reason:
				| "acl-decode-failed"
				| "noncanonical-acl"
				| "acl-schema-invalid"
				| "unsupported-acl-version"
				| "unsupported-acl-profile"
				| "object-id-mismatch"
				| "epoch-mismatch"
				| "acl-digest-mismatch";
	  }>
	| Readonly<{
			authorization: CurrentEpochAuthorAuthorization;
			ok: true;
			provenance: AuthenticateCurrentEpochAnchorSuccessProvenance;
	  }>;
type ExpectedResolveResult =
	| Readonly<{ ok: false; reason: "malformed-input" | "untrusted-context" | "author-not-authorized" }>
	| Readonly<{ ok: true; publicKey: RawEd25519PublicKey }>;
type ExpectedOpen = (input: OpenCurrentEpochAuthorAuthorizationInput) => OpenCurrentEpochAuthorAuthorizationResult;
type ExpectedResolve = (input: ResolveCurrentEpochAuthorizedAuthorInput) => ResolveCurrentEpochAuthorizedAuthorResult;

type _Provenance = Assert<Equal<AuthenticateCurrentEpochAnchorSuccessProvenance, ExpectedProvenance>>;
type _Authorization = Assert<Equal<CurrentEpochAuthorAuthorization, ExpectedAuthorization>>;
type _OpenInput = Assert<Equal<OpenCurrentEpochAuthorAuthorizationInput, ExpectedOpenInput>>;
type _ResolveInput = Assert<Equal<ResolveCurrentEpochAuthorizedAuthorInput, ExpectedResolveInput>>;
type _OpenResult = Assert<Equal<OpenCurrentEpochAuthorAuthorizationResult, ExpectedOpenResult>>;
type _ResolveResult = Assert<Equal<ResolveCurrentEpochAuthorizedAuthorResult, ExpectedResolveResult>>;
type _OpenFunction = Assert<Equal<typeof openCurrentEpochAuthorAuthorization, ExpectedOpen>>;
type _ResolveFunction = Assert<Equal<typeof resolveCurrentEpochAuthorizedAuthor, ExpectedResolve>>;

declare const failure: AuthenticateCurrentEpochAnchorFailureReason;
declare const publicKey: RawEd25519PublicKey;
void [failure, publicKey];
export type P6SourceTypeAudit =
	| _Provenance
	| _Authorization
	| _OpenInput
	| _ResolveInput
	| _OpenResult
	| _ResolveResult
	| _OpenFunction
	| _ResolveFunction;
