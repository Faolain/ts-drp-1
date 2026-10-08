/* eslint-disable import/no-duplicates, import/order -- forbidden primitive exports need independent expect-errors */

import { prepareBlueprintRuntime } from "../../../packages/protocol-v3/src/public.js";
import type {
	BlueprintRuntimePreparationInput,
	PreparedBlueprintAdmission,
	PreparedBlueprintRuntime,
} from "../../../packages/protocol-v3/src/public.js";

// @ts-expect-error The conformance primitive is absent from the application public entry.
import { verifyReceivedVertex } from "../../../packages/protocol-v3/src/public.js";
// @ts-expect-error The conformance primitive is absent from the application public entry.
import { createTransactionalVertexIssuer } from "../../../packages/protocol-v3/src/public.js";

declare const canonicalBlueprintPackageBytes: Uint8Array;
declare const exactArtifactBytes: Uint8Array;
declare const expectedBlueprintDigest: string;
declare const preparedBlueprintAdmission: PreparedBlueprintAdmission;

const input: BlueprintRuntimePreparationInput = {
	canonicalBlueprintPackageBytes,
	exactArtifactBytes,
	expectedBlueprintDigest,
	preparedBlueprintAdmission,
};
const prepared: Promise<PreparedBlueprintRuntime> = prepareBlueprintRuntime(input);

void [createTransactionalVertexIssuer, prepared, verifyReceivedVertex];
