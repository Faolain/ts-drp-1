import type { PublicCampaignConfig } from "./config.js";
import type {
	CampaignTask,
	PublicCampaignDriver,
	PublicCampaignPartialReason,
	PublicCampaignTaskResult,
} from "./runner.js";

interface TaskEvidence {
	observations: unknown[];
}

/**
 * Typed signal from the reviewed request executor when one protocol owner is
 * unavailable. The driver converts it to an honest partial cell only after the
 * gate has recorded the matching attempt.
 */
export class PublicCampaignOwnerOutage extends Error {
	readonly reason: PublicCampaignPartialReason;

	/**
	 * @param reason - Endpoint-owner outage category.
	 * @param message - Optional diagnostic message retained only in memory.
	 */
	constructor(reason: PublicCampaignPartialReason, message = reason) {
		super(message);
		this.name = "PublicCampaignOwnerOutage";
		this.reason = reason;
	}
}

/**
 * The repository-owned Phase 09 task composition. It performs no I/O itself:
 * every top-level DHT, delegated-routing, registry, relay, and grid attempt is
 * submitted to the serialized request gate. A protected, reviewed executor
 * owns the protocol-specific wire operation and returns aggregate-safe task
 * evidence on the final attempt.
 * @param config - Authorized, validated campaign configuration.
 * @returns Fixed repository-owned Phase 09 task driver.
 */
export function createReviewedPublicCampaignDriver(config: PublicCampaignConfig): PublicCampaignDriver {
	const dhtTarget = config.endpoints.publicDhtBootstrap[0];
	const delegatedTarget = config.endpoints.delegatedRouting[0];
	const relayTarget = config.endpoints.relays[0];
	if (dhtTarget === undefined || delegatedTarget === undefined || relayTarget === undefined) {
		throw new Error("reviewed campaign driver requires DHT, delegated-routing, and relay owners");
	}

	return {
		async runBrowserTask(task, gate, signal): Promise<PublicCampaignTaskResult> {
			return partialOnOwnerOutage(async () => {
				signal.throwIfAborted();
				await gate.request({ kind: "delegated-lookup", target: delegatedTarget });
				await gate.request({ kind: "registry-discover", target: registryTarget(config, task) });
				await gate.request({ kind: "relay-reserve", target: relayTarget });
				const evidence = await gate.request<unknown>({ kind: "relay-dial", target: relayTarget });
				return completeEvidence(evidence);
			});
		},
		async runGridCanaryTask(task, gate, signal): Promise<PublicCampaignTaskResult> {
			return partialOnOwnerOutage(async () => {
				signal.throwIfAborted();
				await gate.request({ kind: "dht-provide", target: dhtTarget });
				await gate.request({ kind: "dht-lookup", target: dhtTarget });
				await gate.request({ kind: "delegated-lookup", target: delegatedTarget });
				const registry = registryTarget(config, task);
				await gate.request({ kind: "registry-register", target: registry });
				await gate.request({ kind: "registry-discover", target: registry });
				await gate.request({ kind: "relay-reserve", target: relayTarget });
				await gate.request({ kind: "relay-dial", target: relayTarget });
				const evidence = await gate.request<unknown>({ kind: "grid-canary", target: relayTarget });
				return completeEvidence(evidence);
			});
		},
		async runNodeTask(_task, gate, signal): Promise<PublicCampaignTaskResult> {
			return partialOnOwnerOutage(async () => {
				signal.throwIfAborted();
				await gate.request({ kind: "dht-provide", target: dhtTarget });
				const evidence = await gate.request<unknown>({ kind: "dht-lookup", target: dhtTarget });
				return completeEvidence(evidence);
			});
		},
	};
}

async function partialOnOwnerOutage(run: () => Promise<PublicCampaignTaskResult>): Promise<PublicCampaignTaskResult> {
	try {
		return await run();
	} catch (error) {
		if (!(error instanceof PublicCampaignOwnerOutage)) throw error;
		return {
			observations: [],
			reason: error.reason,
			status: "partial",
		};
	}
}

function completeEvidence(value: unknown): PublicCampaignTaskResult {
	if (
		typeof value !== "object" ||
		value === null ||
		!("observations" in value) ||
		!Array.isArray((value as TaskEvidence).observations)
	) {
		throw new Error("reviewed request executor omitted final task observations");
	}
	return {
		observations: (value as TaskEvidence).observations,
		status: "complete",
	};
}

function registryTarget(config: PublicCampaignConfig, task: Pick<CampaignTask, "identityPseudonym">): string {
	const finalNibble = Number.parseInt(task.identityPseudonym.at(-1) ?? "0", 16);
	const endpoint = config.endpoints.registries[finalNibble % config.endpoints.registries.length];
	if (endpoint === undefined) throw new Error("reviewed campaign driver requires two registry endpoints");
	return endpoint.url;
}
