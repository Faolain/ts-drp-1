import { AdmissionPolicy, createHttpRegistryEndpoint, RegistryClient, RegistryServer } from "@ts-drp/rendezvous";
import type { RecordValidator, RegistryDiscoveryReceipt } from "@ts-drp/rendezvous";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NAMESPACE, NOW, signedFixture, validator } from "./fixtures.js";

interface RegistryHttpService {
	readonly url: string;
	close(): Promise<void>;
}

const services: RegistryHttpService[] = [];

afterEach(async () => {
	await Promise.allSettled(services.splice(0).map((service) => service.close()));
	vi.restoreAllMocks();
});

describe("scale-hardening HTTP targeted discovery", () => {
	it("filters a 64-record registry server before response-cap accounting", async () => {
		const server = registryServer("targeted-service");
		const records = await Promise.all(Array.from({ length: 64 }, (_, index) => signedFixture(900 + index)));
		for (const record of records) {
			await server.register({
				clientId: record.peerId,
				credential: { kind: "invite", token: "targeted-http-fixture" },
				record,
				signal: signal(),
			});
		}
		const target = records[37];
		if (target === undefined) throw new Error("target record fixture is missing");
		const { createRegistryHttpService } = await import("../src/service.js");
		const service = await createRegistryHttpService({ host: "127.0.0.1", port: 0, server });
		services.push(service);

		const response = await fetch(new URL("v1/discover", service.url), {
			body: JSON.stringify({ namespace: NAMESPACE, targetPeerId: target.peerId }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const body = (await response.json()) as RegistryDiscoveryReceipt;

		expect(response.status).toBe(200);
		expect(body.records).toHaveLength(1);
		expect(body.records[0]?.record.peerId).toBe(target.peerId);
	});

	it("threads RegistryClient target selection into the HTTP request body", async () => {
		const bodies: unknown[] = [];
		const endpoints = ["capturing-a", "capturing-b"].map((id) =>
			createHttpRegistryEndpoint({
				fetchImpl: (_input, init) => {
					bodies.push(JSON.parse(String(init?.body)) as unknown);
					return Promise.resolve(
						new Response(JSON.stringify({ endpointId: id, records: [] }), {
							headers: { "content-type": "application/json" },
							status: 200,
						})
					);
				},
				id,
				url: `https://${id}.example/`,
			})
		);
		const client = new RegistryClient({
			backoffMs: 0,
			clientId: "targeted-http-reader",
			endpoints,
			timeoutMs: 1_000,
			validatorFactory: (): RecordValidator => validator(),
		});
		const targetPeerId = (await signedFixture(980)).peerId;

		await client.discover(NAMESPACE, signal(), { targetPeerId });

		expect(bodies).toEqual([
			{ namespace: NAMESPACE, targetPeerId },
			{ namespace: NAMESPACE, targetPeerId },
		]);
	});

	it("rejects a non-string HTTP targetPeerId with the existing 400 rejection shape", async () => {
		const { createRegistryHttpService } = await import("../src/service.js");
		const service = await createRegistryHttpService({
			host: "127.0.0.1",
			port: 0,
			server: registryServer("target-validation"),
		});
		services.push(service);

		const response = await fetch(new URL("v1/discover", service.url), {
			body: JSON.stringify({ namespace: NAMESPACE, targetPeerId: 42 }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ accepted: false, code: "record-rejected" });
	});
});

function registryServer(endpointId: string): RegistryServer {
	return new RegistryServer({
		endpointId,
		limits: {
			maxRequestsPerNamespaceWindow: 1_000,
			maxRequestsPerWindow: 1_000,
			maxResponseRecords: 64,
		},
		now: (): number => NOW,
		policy: new AdmissionPolicy({ inviteToken: "targeted-http-fixture" }),
		validator: validator(),
	});
}

function signal(): AbortSignal {
	return new AbortController().signal;
}
