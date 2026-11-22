/* eslint-disable import/no-duplicates -- each forbidden export is an independent audit */

// @ts-expect-error The built package must omit the deep proof-ID helper.
import { deriveEquivocationProofId } from "@ts-drp/protocol-v3";
// @ts-expect-error The built package must omit the deep proof materializer.
import { materializeCurrentEquivocationProof } from "@ts-drp/protocol-v3";

void [deriveEquivocationProofId, materializeCurrentEquivocationProof];
