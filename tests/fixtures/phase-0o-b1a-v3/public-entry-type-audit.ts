/* eslint-disable import/no-duplicates -- each forbidden export is an independent audit */

// @ts-expect-error The proof-ID helper is deep-only.
import { deriveEquivocationProofId } from "../../../packages/protocol-v3/src/public.js";
// @ts-expect-error The proof materializer is deep-only.
import { materializeCurrentEquivocationProof } from "../../../packages/protocol-v3/src/public.js";

void [deriveEquivocationProofId, materializeCurrentEquivocationProof];
