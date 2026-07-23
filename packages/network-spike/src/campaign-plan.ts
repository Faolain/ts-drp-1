import type { PublicCampaignPlan } from "./schemas.js";

/** Frozen Issue 05 matrix shared by manifests, controls, and blocked evidence. */
export const frozenPublicCampaign: PublicCampaignPlan = {
	browserIdentitiesPerBrowserCondition: 100,
	browsers: ["chromium", "firefox", "webkit"],
	conditions: ["primary-home-nat", "authorized-secondary-egress"],
	endpointCallCaps: {
		delegatedPerBrowserIdentity: 4,
		gridCanaryPerBrowserCondition: 20,
		nodeRoutingPerIdentity: 4,
		registryPerBrowserIdentity: 4,
		relayPerBrowserIdentity: 12,
	},
	nodeIdentitiesPerCondition: 100,
	transportProfileSplit: {
		"wss-only": 50,
		"wss-wt-webrtc-direct": 50,
	},
};
