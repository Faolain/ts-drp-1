/* eslint-disable import/no-duplicates */
// @ts-expect-error The durable author projection coordinator is absent from the built package root.
import { createDurableAuthorEquivocationProjection } from "@ts-drp/protocol-v3";
// @ts-expect-error The pure proof ID helper remains absent from the built package root.
import { deriveEquivocationProofId } from "@ts-drp/protocol-v3";
// @ts-expect-error Current-witness proof materialization remains absent from the built package root.
import { materializeCurrentEquivocationProof } from "@ts-drp/protocol-v3";

void createDurableAuthorEquivocationProjection;
void deriveEquivocationProofId;
void materializeCurrentEquivocationProof;
