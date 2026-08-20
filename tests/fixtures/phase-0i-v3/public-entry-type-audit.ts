/* eslint-disable import/no-duplicates, import/order -- each forbidden export needs an independent expect-error */

import {
	admitReceivedVertex,
	createAdmissionBoundTransactionalVertexIssuer,
	prepareBlueprintAdmission,
} from "../../../packages/protocol-v3/src/public.js";

// @ts-expect-error The conformance primitive is absent from the application public entry.
import { verifyReceivedVertex } from "../../../packages/protocol-v3/src/public.js";
// @ts-expect-error The conformance primitive is absent from the application public entry.
import { createTransactionalVertexIssuer } from "../../../packages/protocol-v3/src/public.js";
// @ts-expect-error The equivocation observer is absent from the application public entry.
import { createRemoteEquivocationObserver } from "../../../packages/protocol-v3/src/public.js";
// @ts-expect-error The equivocation proof verifier is absent from the application public entry.
import { verifyEquivocationProof } from "../../../packages/protocol-v3/src/public.js";
// @ts-expect-error The primitive-only input type is absent from the application public entry.
import type { VerifyReceivedVertexInput } from "../../../packages/protocol-v3/src/public.js";
// @ts-expect-error The primitive-only options type is absent from the application public entry.
import type { TransactionalIssuerOptions } from "../../../packages/protocol-v3/src/public.js";

void [
	admitReceivedVertex,
	createAdmissionBoundTransactionalVertexIssuer,
	prepareBlueprintAdmission,
	verifyReceivedVertex,
	createTransactionalVertexIssuer,
	createRemoteEquivocationObserver,
	verifyEquivocationProof,
];
type PrimitiveOnlyTypesMustStayAbsent = VerifyReceivedVertexInput | TransactionalIssuerOptions;
export type { PrimitiveOnlyTypesMustStayAbsent };
