import {
	openCurrentEpochAuthorAuthorization,
	resolveCurrentEpochAuthorizedAuthor,
} from "@ts-drp/protocol-v3/author-authorization";
import type {
	AuthenticateCurrentEpochAnchorFailureReason,
	AuthenticateCurrentEpochAnchorSuccessProvenance,
	CurrentEpochAuthorAuthorization,
	OpenCurrentEpochAuthorAuthorizationInput,
	OpenCurrentEpochAuthorAuthorizationResult,
	ResolveCurrentEpochAuthorizedAuthorInput,
	ResolveCurrentEpochAuthorizedAuthorResult,
} from "@ts-drp/protocol-v3/author-authorization";

const values = [openCurrentEpochAuthorAuthorization, resolveCurrentEpochAuthorizedAuthor] as const;
declare const failure: AuthenticateCurrentEpochAnchorFailureReason;
declare const provenance: AuthenticateCurrentEpochAnchorSuccessProvenance;
declare const authorization: CurrentEpochAuthorAuthorization;
declare const openInput: OpenCurrentEpochAuthorAuthorizationInput;
declare const openResult: OpenCurrentEpochAuthorAuthorizationResult;
declare const resolveInput: ResolveCurrentEpochAuthorizedAuthorInput;
declare const resolveResult: ResolveCurrentEpochAuthorizedAuthorResult;
void [values, failure, provenance, authorization, openInput, openResult, resolveInput, resolveResult];
