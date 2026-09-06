import { declaredPhase2gObservations, derivePhase2gQuotaEdges } from "../fixtures/phase-2g-c-quota-fault-contract.js";
import { runPhase2gQuotaCaseObservation } from "../fixtures/phase-2g-c-quota-fault-instrument.js";

const REPRESENTATIVE_EDGE_ID = "swap-head-certificate-match/request-05-put-objects/settlement";
const REPRESENTATIVE_EDGE = derivePhase2gQuotaEdges(declaredPhase2gObservations()).find(
	({ id }) => id === REPRESENTATIVE_EDGE_ID
);
if (REPRESENTATIVE_EDGE === undefined) throw new TypeError("Phase 2h-c representative quota edge is absent");

Reflect.set(
	globalThis,
	"phase2gCQuotaFaultHarness",
	Object.freeze({
		runRepresentativeSettlement: () => runPhase2gQuotaCaseObservation(REPRESENTATIVE_EDGE),
	})
);

export {};
