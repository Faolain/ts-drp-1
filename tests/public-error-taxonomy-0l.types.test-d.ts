import { expectTypeOf } from "vitest";

import type * as BlueprintsRoot from "../packages/blueprints/src/index.js";
import type { CanonicalDecodingError, CanonicalEncodingError } from "../packages/canonical/src/index.js";
import type { EpochFullOutcome, LinearizationError } from "../packages/compaction/src/index.js";
// The package is intentionally absent at the RED baseline.
import type { DRP_ERROR_CODES, DRPError, DRPErrorCode } from "../packages/errors/src/index.js";
import type { AdoptionCommitExhaustedError, ApplyInvariantError } from "../packages/object/src/index.js";
import type {
	AdmissionResult,
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

const registryAndUnionCloseEachOther: Equal<RegistryCode, DRPErrorCode> = true;
const codedBaseIsAnError: Extends<DRPError, Error & { readonly code: DRPErrorCode }> = true;
const linearizationFieldIsClosed: Extends<LinearizationError["code"], DRPErrorCode> = true;
const linearizationConstructorIsClosed: Extends<ConstructorParameters<typeof LinearizationError>[0], DRPErrorCode> =
	true;
const admissionCodeIsClosed: Extends<AdmissionResult["code"], DRPErrorCode> = true;
const preparationCodeIsClosed: Extends<Extract<PrepareAdmissionContextResult, { ok: false }>["code"], DRPErrorCode> =
	true;
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
expectTypeOf(admissionCodeIsClosed).toEqualTypeOf<true>();
expectTypeOf(preparationCodeIsClosed).toEqualTypeOf<true>();
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
