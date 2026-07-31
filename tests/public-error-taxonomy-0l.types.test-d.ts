import { expectTypeOf } from "vitest";

import type * as BlueprintsRoot from "../packages/blueprints/src/index.js";
import type { CanonicalDecodingError, CanonicalEncodingError } from "../packages/canonical/src/index.js";
import type { EpochFullOutcome, LinearizationError } from "../packages/compaction/src/index.js";
// The package is intentionally absent at the RED baseline.
import type { DRP_ERROR_CODES, DRPError, DRPErrorCode } from "../packages/errors/src/index.js";
import type { AdoptionCommitExhaustedError, ApplyInvariantError } from "../packages/object/src/index.js";
import type {
	AdmissionResult,
	AdmissionResultCode,
	PrepareAdmissionContextResult,
	UnsupportedProfileError,
} from "../packages/protocol-v2/src/index.js";
import type * as TypesRoot from "../packages/types/src/index.js";
import type * as ValidationErrorsRoot from "../packages/validation/src/errors.js";
import type {
	DRPValidationError,
	InvalidDependenciesError,
	InvalidHashError,
	InvalidTimestampError,
	ValidationResult,
} from "../packages/validation/src/index.js";
import type * as ValidationMessageRoot from "../packages/validation/src/schemas/message.js";
import type * as ValidationVertexRoot from "../packages/validation/src/vertex.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Extends<Left, Right> = [Left] extends [Right] ? true : false;
type ExactKeys<Value, Keys extends PropertyKey> = Equal<keyof Value, Keys>;
type RegistryCode = (typeof DRP_ERROR_CODES)[number];
type HasNoDRPErrorExport<Module> = "DRPError" extends keyof Module ? false : true;
type EmittedAdmissionResultCode =
	| "ADMISSIBLE"
	| "ADMISSION_CONTEXT_INVALID"
	| "ADMISSION_CONTEXT_UNPREPARED"
	| "AUTHORIZATION_EXCEPTION"
	| "AUTHORIZATION_UNAVAILABLE"
	| "AUTHOR_KEY_RESOLVER_UNAVAILABLE"
	| "CRYPTO_SUITE_UNAVAILABLE"
	| "DEPENDENCY_ACCEPTANCE_ORACLE_UNAVAILABLE"
	| "DEPENDENCY_DOMAIN_MISMATCH"
	| "DEPENDENCY_RESOLVER_UNAVAILABLE"
	| "DEPENDENCY_WRONG_ANCHOR"
	| "DEPENDENCY_WRONG_EPOCH"
	| "DETERMINISTIC_INVARIANT_VALIDATOR_UNAVAILABLE"
	| "FUTURE_EPOCH"
	| "FUTURE_PROTOCOL"
	| "INVALID_DEPENDENCY_ENVELOPE"
	| "INVALID_HASH"
	| "INVALID_LOGICAL_TIME"
	| "INVALID_OPERATION_SCHEMA"
	| "INVALID_SIGNATURE"
	| "INVARIANT_VIOLATION"
	| "LEGACY_PROTOCOL"
	| "LIMIT_EXCEEDED"
	| "MALFORMED_VERTEX"
	| "MISSING_CURRENT_EPOCH_DEPENDENCIES"
	| "MISSING_DEPENDENCIES"
	| "NON_ANTICHAIN_DEPENDENCIES"
	| "NON_CANONICAL_ENVELOPE"
	| "OPERATION_SCHEMA_VALIDATOR_UNAVAILABLE"
	| "STALE_EPOCH"
	| "UNACCEPTED_DEPENDENCIES"
	| "UNAUTHORIZED"
	| "WRONG_ANCHOR"
	| "WRONG_OBJECT";
type EmittedPrepareAdmissionContextFailureCode = "ADMISSION_CONTEXT_INVALID";

const registryAndUnionCloseEachOther: Equal<RegistryCode, DRPErrorCode> = true;
const codedBaseIsAnError: Extends<DRPError, Error & { readonly code: DRPErrorCode }> = true;
const linearizationFieldIsClosed: Extends<LinearizationError["code"], DRPErrorCode> = true;
const linearizationConstructorIsClosed: Extends<ConstructorParameters<typeof LinearizationError>[0], DRPErrorCode> =
	true;
const admissionAliasEqualsEmittedCodes: Equal<AdmissionResultCode, EmittedAdmissionResultCode> = true;
const admissionResultEqualsPublicAlias: Equal<AdmissionResult["code"], AdmissionResultCode> = true;
const preparationFailureEqualsEmittedCodes: Equal<
	Extract<PrepareAdmissionContextResult, { ok: false }>["code"],
	EmittedPrepareAdmissionContextFailureCode
> = true;
const epochFullCodeIsClosed: Extends<EpochFullOutcome["code"], DRPErrorCode> = true;

const governedInstancesHaveClosedCodes: Extends<
	| CanonicalDecodingError
	| CanonicalEncodingError
	| DRPValidationError
	| InvalidDependenciesError
	| InvalidHashError
	| InvalidTimestampError
	| UnsupportedProfileError
	| AdoptionCommitExhaustedError
	| ApplyInvariantError,
	Error & { readonly code: DRPErrorCode }
> = true;

const admissionKeysStayExact: ExactKeys<AdmissionResult, "code" | "latchByHash" | "status"> = true;
const validationKeysStayExact: ExactKeys<ValidationResult, "error" | "success"> = true;
const applyKeysStayExact: ExactKeys<TypesRoot.ApplyResult, "applied" | "invalid" | "missing" | "quarantined"> = true;
const mergeTupleStaysExact: Equal<TypesRoot.MergeResult, [merged: boolean, missing: string[], invalid: string[]]> =
	true;
const epochFullKeysStayExact: ExactKeys<EpochFullOutcome, "code" | "latchByHash" | "status"> = true;
const blueprintsHaveNoErrorExport: HasNoDRPErrorExport<typeof BlueprintsRoot> = true;
const typesHaveNoErrorExport: HasNoDRPErrorExport<typeof TypesRoot> = true;

expectTypeOf(registryAndUnionCloseEachOther).toEqualTypeOf<true>();
expectTypeOf(codedBaseIsAnError).toEqualTypeOf<true>();
expectTypeOf(linearizationFieldIsClosed).toEqualTypeOf<true>();
expectTypeOf(linearizationConstructorIsClosed).toEqualTypeOf<true>();
expectTypeOf(admissionAliasEqualsEmittedCodes).toEqualTypeOf<true>();
expectTypeOf(admissionResultEqualsPublicAlias).toEqualTypeOf<true>();
expectTypeOf(preparationFailureEqualsEmittedCodes).toEqualTypeOf<true>();
expectTypeOf(epochFullCodeIsClosed).toEqualTypeOf<true>();
expectTypeOf(governedInstancesHaveClosedCodes).toEqualTypeOf<true>();
expectTypeOf(admissionKeysStayExact).toEqualTypeOf<true>();
expectTypeOf(validationKeysStayExact).toEqualTypeOf<true>();
expectTypeOf(applyKeysStayExact).toEqualTypeOf<true>();
expectTypeOf(mergeTupleStaysExact).toEqualTypeOf<true>();
expectTypeOf(epochFullKeysStayExact).toEqualTypeOf<true>();
expectTypeOf(blueprintsHaveNoErrorExport).toEqualTypeOf<true>();
expectTypeOf(typesHaveNoErrorExport).toEqualTypeOf<true>();

expectTypeOf<ValidationErrorsRoot.InvalidHashError>().toExtend<Error>();
expectTypeOf<ValidationVertexRoot.ValidationResult>().toEqualTypeOf<ValidationResult>();
expectTypeOf<typeof ValidationMessageRoot.MessageSchema>().toBeObject();
