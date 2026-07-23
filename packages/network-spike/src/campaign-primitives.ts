import type { PublicCampaignPlan } from "./schemas.js";

// The network-spike evidence contract and campaign runners consume the promoted budget through this module.
export { RequestBudget } from "@ts-drp/rendezvous";

export interface PlannedMatrixSummary {
	browserTrials: number;
	hardRequestCap: number;
	nodeTrials: number;
	requiredTrialCount: number;
	rows: Array<{
		browser?: string;
		condition: string;
		identities: number;
		target: "browser" | "grid-canary" | "node";
		transportProfile?: string;
	}>;
}

export interface WilsonInterval {
	lower: number;
	upper: number;
}

/**
 * Computes the exact public trial matrix and endpoint-call ceiling.
 * @param plan - Pre-registered public campaign plan.
 * @returns Exact cell rows, trial counts, and request ceiling.
 */
export function summarizePublicCampaign(plan: PublicCampaignPlan): PlannedMatrixSummary {
	const rows: PlannedMatrixSummary["rows"] = [];
	for (const condition of plan.conditions) {
		rows.push({
			condition,
			identities: plan.nodeIdentitiesPerCondition,
			target: "node",
		});
		for (const browser of plan.browsers) {
			for (const [transportProfile, identities] of Object.entries(plan.transportProfileSplit)) {
				rows.push({
					browser,
					condition,
					identities,
					target: "browser",
					transportProfile,
				});
			}
			rows.push({
				browser,
				condition,
				identities: 1,
				target: "grid-canary",
			});
		}
	}

	const nodeTrials = plan.conditions.length * plan.nodeIdentitiesPerCondition;
	const browserTrials = plan.conditions.length * plan.browsers.length * plan.browserIdentitiesPerBrowserCondition;
	const browserCallsPerIdentity =
		plan.endpointCallCaps.delegatedPerBrowserIdentity +
		plan.endpointCallCaps.registryPerBrowserIdentity +
		plan.endpointCallCaps.relayPerBrowserIdentity;
	const hardRequestCap =
		nodeTrials * plan.endpointCallCaps.nodeRoutingPerIdentity +
		browserTrials * browserCallsPerIdentity +
		plan.conditions.length * plan.browsers.length * plan.endpointCallCaps.gridCanaryPerBrowserCondition;

	return {
		browserTrials,
		hardRequestCap,
		nodeTrials,
		requiredTrialCount: nodeTrials + browserTrials,
		rows,
	};
}

/**
 * Computes the Wilson score interval used by public observed-rate rules.
 * @param successes - Verified successful-trial count.
 * @param sampleCount - Verified usable-trial count.
 * @returns Wilson 95% lower and upper bounds.
 */
export function wilson95(successes: number, sampleCount: number): WilsonInterval {
	if (
		!Number.isSafeInteger(successes) ||
		!Number.isSafeInteger(sampleCount) ||
		successes < 0 ||
		successes > sampleCount
	) {
		throw new Error("Wilson interval counts are invalid");
	}
	if (sampleCount === 0) return { lower: 0, upper: 0 };
	const z = 1.959963984540054;
	const observed = successes / sampleCount;
	const denominator = 1 + (z * z) / sampleCount;
	const center = observed + (z * z) / (2 * sampleCount);
	const margin = z * Math.sqrt((observed * (1 - observed)) / sampleCount + (z * z) / (4 * sampleCount * sampleCount));
	return {
		lower: Math.max(0, (center - margin) / denominator),
		upper: Math.min(1, (center + margin) / denominator),
	};
}
