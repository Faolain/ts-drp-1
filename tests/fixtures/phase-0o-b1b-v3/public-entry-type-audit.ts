/* eslint-disable import/no-duplicates */
// @ts-expect-error The durable author projection coordinator is deep-only.
import { createDurableAuthorEquivocationProjection } from "../../../packages/protocol-v3/src/public.js";
// @ts-expect-error The pure proof ID helper remains deep-only.
import { deriveEquivocationProofId } from "../../../packages/protocol-v3/src/public.js";
// @ts-expect-error Current-witness proof materialization remains deep-only.
import { materializeCurrentEquivocationProof } from "../../../packages/protocol-v3/src/public.js";

void createDurableAuthorEquivocationProjection;
void deriveEquivocationProofId;
void materializeCurrentEquivocationProof;
