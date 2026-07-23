import type {
	ClientRegistrationReceipt,
	RecordProducer,
	RendezvousDirectory,
	SignedDrpRecordV1,
	ValidatedDrpRecord,
} from "@ts-drp/rendezvous";
import type { ControlPlaneEvent, DRPNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

const INVITE = "rendezvous-registration-reason-fixture";
const NAMESPACE = `drp-network:v1:${"r".repeat(43)}`;

afterEach(() => vi.unstubAllGlobals());

describe("rendezvous-registration failure reason RED contract", () => {
	it("emits the sanitized failed-attempt reason when every rendezvous registration is rejected", async () => {
		const events: ControlPlaneEvent[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error("fixture transport failure")))
		);
		const node = new DRPNode(nodeConfig(events));

		try {
			await expect(node.start()).resolves.toBeUndefined();
			await vi.waitFor(
				() => {
					const failedRegistration = events.find(
						(event) => event.kind === "rendezvous-registration" && event.outcome === "failed"
					);
					expect(failedRegistration, "a failed rendezvous-registration event must be emitted").toBeDefined();
					expect(eventReason(failedRegistration)).toEqual(expect.stringContaining("endpoint-unavailable"));
					expect(reasonLength(failedRegistration)).toBeLessThanOrEqual(160);
				},
				{ timeout: 2_500 }
			);
		} finally {
			await node.stop();
		}
	}, 8_000);

	it("emits a bounded timeout token for a non-exhausted registration timeout", async () => {
		const events: ControlPlaneEvent[] = [];
		const node = new DRPNode(nodeConfig(events));
		const record = {} as SignedDrpRecordV1;
		const producer: RecordProducer = {
			current: (): Promise<SignedDrpRecordV1> => Promise.resolve(record),
			refresh: (): Promise<SignedDrpRecordV1> => Promise.resolve(record),
		};
		const directory: RendezvousDirectory = {
			discover: (): Promise<readonly ValidatedDrpRecord[]> => Promise.resolve([]),
			register: (_record, signal): Promise<ClientRegistrationReceipt> =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		};

		await expect(
			node["_registerRendezvousRecord"](producer, directory, undefined, 2, new AbortController().signal, 1)
		).resolves.toBe(true);

		const failedRegistration = events.find(
			(event) => event.kind === "rendezvous-registration" && event.outcome === "failed"
		);
		expect(eventReason(failedRegistration)).toBe("timeout");
		expect(reasonLength(failedRegistration)).toBeLessThanOrEqual(160);
	});

	it("includes an allowlisted rejection reason on a partial registration", async () => {
		const events: ControlPlaneEvent[] = [];
		stubRegistryFetch((url) =>
			url.includes("127.0.0.1:1")
				? { accepted: true, endpointId: "registry-accepted", sequence: 1 }
				: { accepted: false, code: "rate-limited" }
		);
		const node = new DRPNode(nodeConfig(events));

		try {
			await expect(node.start()).resolves.toBeUndefined();
			await vi.waitFor(
				() => {
					const partialRegistration = events.find(
						(event) => event.kind === "rendezvous-registration" && event.outcome === "partial"
					);
					expect(eventReason(partialRegistration)).toBe("rejected: rate-limited");
				},
				{ timeout: 2_500 }
			);
		} finally {
			await node.stop();
		}
	}, 8_000);

	it("drops an unknown attacker-controlled rejection code from registration telemetry", async () => {
		const events: ControlPlaneEvent[] = [];
		const attackerCode = "attacker-code:https://secret.example.test/private";
		stubRegistryFetch(() => ({ accepted: false, code: attackerCode }));
		const node = new DRPNode(nodeConfig(events));

		try {
			await expect(node.start()).resolves.toBeUndefined();
			await vi.waitFor(
				() => {
					const failedRegistration = events.find(
						(event) => event.kind === "rendezvous-registration" && event.outcome === "failed"
					);
					expect(failedRegistration, "a failed rendezvous-registration event must be emitted").toBeDefined();
					expect(eventReason(failedRegistration)).toBeUndefined();
					expect(JSON.stringify(failedRegistration)).not.toContain(attackerCode);
				},
				{ timeout: 2_500 }
			);
		} finally {
			await node.stop();
		}
	}, 8_000);
});

function eventReason(event: ControlPlaneEvent | undefined): unknown {
	if (event === undefined || !("reason" in event)) return undefined;
	return event.reason;
}

function reasonLength(event: ControlPlaneEvent | undefined): number {
	const reason = eventReason(event);
	return typeof reason === "string" ? reason.length : Number.POSITIVE_INFINITY;
}

function stubRegistryFetch(registrationResponse: (url: string) => unknown): void {
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof globalThis.fetch>((input): Promise<Response> => {
			const url = String(input);
			const body = url.endsWith("/v1/discover")
				? { endpointId: "registry-discovery", records: [] }
				: registrationResponse(url);
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					headers: { "content-type": "application/json" },
					status: 200,
				})
			);
		})
	);
}

function nodeConfig(events: ControlPlaneEvent[]): DRPNodeConfig {
	return {
		interval_reconnect_options: { interval: 60_000 },
		keychain_config: { private_key_seed: "rendezvous-registration-reason-red" },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				address_policy: {
					allowInsecureWebSocket: true,
					allowLoopback: true,
					target: "node",
				},
				membership: { invite: { inviteToken: INVITE }, mode: "invite" },
				observability: { sink: (event: ControlPlaneEvent): void => void events.push(event) },
				rollout: { public_components: { public_rendezvous: { enabled: true } } },
				rendezvous: {
					allow_insecure_loopback_fixture: true,
					endpoints: ["http://127.0.0.1:1/closed-registry", "http://127.0.0.1:2/closed-registry"],
					namespace: NAMESPACE,
					publish: true,
					record_ttl_ms: 60_000,
					refresh_interval_ms: 1_000,
				},
			},
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws", "/webrtc"],
			log_config: { level: "silent" },
			relay_service: { enabled: true, max_reservations: 4 },
		},
	} as unknown as DRPNodeConfig;
}
