import type {
	RelayCandidate,
	RelayCandidateSource,
	RelayPolicyResult,
	RelayReplacementResult,
} from "@ts-drp/relay-policy";
import type { DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRPNetworkNode, type RelayPolicyDriver, type RelayPolicyFactoryOptions } from "../src/node.js";

const PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";
const RELAY_ADDRESS = `/dns4/configured-public.example.test/tcp/443/wss/p2p/${PEER_ID}`;

describe("configured public relay wiring RED contract", () => {
	const started: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(started.splice(0).map((node) => node.stop()));
	});

	it("feeds sources.configured_relays directly into reservation policy without discovery injection", async () => {
		let composedSource: RelayCandidateSource | undefined;
		const relayPolicyFactory = vi.fn((options: RelayPolicyFactoryOptions): RelayPolicyDriver => {
			composedSource = options.source;
			return idlePolicy();
		});
		const config = {
			bootstrap_peers: [],
			control_plane: {
				relay_policy: {
					sources: { configured_relays: [RELAY_ADDRESS] },
					target_reservations: 1,
				},
			},
			listen_addresses: [],
			log_config: { level: "silent" },
			seed: true,
		} as unknown as DRPNetworkNodeConfig;
		const node = new DRPNetworkNode(config, { relayPolicyFactory });
		started.push(node);

		await node.start();
		expect(relayPolicyFactory, "a configured list must create its own primary source").toHaveBeenCalledOnce();
		if (composedSource === undefined) return;
		await expect(collect(composedSource)).resolves.toMatchObject([
			{
				addresses: [RELAY_ADDRESS],
				peerId: PEER_ID,
				protocols: ["/libp2p/circuit/relay/0.2.0/hop"],
				provenance: { origin: "configured-relay", routingSource: "configured" },
			},
		]);
	});
});

function idlePolicy(): RelayPolicyDriver {
	return {
		acquire: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
		refresh: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
		replace: (_peerId, reason): Promise<RelayReplacementResult> =>
			Promise.resolve({ ...exhausted(), reason, replacedPeerId: _peerId }),
		stop: (): Promise<void> => Promise.resolve(),
	};
}

function exhausted(): RelayPolicyResult {
	return {
		attempts: [],
		candidatesObserved: 0,
		durationMs: 0,
		operatorGroups: [],
		reservations: [],
		terminal: "exhausted",
	};
}

async function collect(source: RelayCandidateSource): Promise<RelayCandidate[]> {
	const candidates: RelayCandidate[] = [];
	for await (const candidate of source.getCandidates(Uint8Array.from([9]), new AbortController().signal)) {
		candidates.push(candidate);
	}
	return candidates;
}
