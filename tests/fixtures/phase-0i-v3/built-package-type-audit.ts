/* eslint-disable import/no-duplicates, import/order -- each forbidden export needs an independent expect-error */

import {
	admitReceivedVertex,
	createAdmissionBoundTransactionalVertexIssuer,
	prepareBlueprintAdmission,
} from "@ts-drp/protocol-v3";

// @ts-expect-error The built package omits the conformance primitive.
import { verifyReceivedVertex } from "@ts-drp/protocol-v3";
// @ts-expect-error The built package omits the conformance primitive.
import { createTransactionalVertexIssuer } from "@ts-drp/protocol-v3";
// @ts-expect-error The built package omits the primitive-only input type.
import type { VerifyReceivedVertexInput } from "@ts-drp/protocol-v3";
// @ts-expect-error The built package omits the primitive-only options type.
import type { TransactionalIssuerOptions } from "@ts-drp/protocol-v3";

void [
	admitReceivedVertex,
	createAdmissionBoundTransactionalVertexIssuer,
	prepareBlueprintAdmission,
	verifyReceivedVertex,
	createTransactionalVertexIssuer,
];
type PrimitiveOnlyBuiltTypesMustStayAbsent = VerifyReceivedVertexInput | TransactionalIssuerOptions;
export type { PrimitiveOnlyBuiltTypesMustStayAbsent };
