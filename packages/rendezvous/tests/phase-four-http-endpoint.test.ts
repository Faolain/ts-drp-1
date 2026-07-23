import {
	type AdmissionCredential,
	type RegistrationReceipt,
	type RegistryDiscoveryReceipt,
	type RegistryDiscoveryRequest,
	type RegistryEndpoint,
	type RegistryRegistrationRequest,
	type RegistryRejection,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { signedFixture } from "./fixtures.js";

interface HttpRegistryLimits {
	readonly maxResponseBytes?: number;
	readonly requestTimeoutMs?: number;
}

interface HttpRegistryEndpointOptions {
	readonly allow_insecure_loopback_fixture?: boolean;
	readonly fetchImpl?: typeof globalThis.fetch;
	readonly id: string;
	readonly limits?: HttpRegistryLimits;
	readonly url: string;
}

interface PhaseFourHttpModule {
	createHttpRegistryEndpoint(options: HttpRegistryEndpointOptions): RegistryEndpoint;
}

describe("Phase 4a HTTP registry endpoint", () => {
	it("uses bounded JSON POST requests with canonical register and discover fields", async () => {
		const createEndpoint = await loadHttpFactory();
		if (createEndpoint === undefined) return;
		const record = await freshRecord(401);
		const credential: AdmissionCredential = { kind: "invite", token: "fixture-token-32-characters" };
		const fetchImpl = vi.fn<typeof globalThis.fetch>((input, _init) => {
			const path = new URL(String(input)).pathname;
			if (path === "/v1/register") {
				return Promise.resolve(
					jsonResponse({
						accepted: true,
						admissionMode: "invite",
						endpointId: "registry-a",
						expiresAtMs: record.expiresAtMs,
						refreshed: false,
						sequence: record.sequence,
					} satisfies RegistrationReceipt)
				);
			}
			return Promise.resolve(
				jsonResponse({ endpointId: "registry-a", records: [] } satisfies RegistryDiscoveryReceipt)
			);
		});
		const endpoint = createEndpoint({ id: "registry-a", fetchImpl, url: "https://registry.example/base/" });

		await endpoint.register({ clientId: record.peerId, credential, record, signal: signal() });
		await endpoint.discover({ clientId: "reader-a", namespace: record.namespace, signal: signal() });

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
			"/base/v1/register",
			"/base/v1/discover",
		]);
		for (const [, init] of fetchImpl.mock.calls) {
			expect(init).toMatchObject({
				credentials: "omit",
				headers: { "accept": "application/json", "content-type": "application/json" },
				method: "POST",
				redirect: "error",
			});
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		}
		expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ credential, record });
		expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({ namespace: record.namespace });
	});

	it("rejects redirects without issuing a request to the redirect target", async () => {
		const createEndpoint = await loadHttpFactory();
		if (createEndpoint === undefined) return;
		let redirectTargetCalls = 0;
		const redirectTarget = createServer((_request, response) => {
			redirectTargetCalls += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ endpointId: "redirect-target", records: [] }));
		});
		const redirectingRegistry = createServer((_request, response) => {
			response.writeHead(302, { location: serverUrl(redirectTarget) });
			response.end();
		});
		await Promise.all([listen(redirectTarget), listen(redirectingRegistry)]);
		try {
			const endpoint = createEndpoint({
				allow_insecure_loopback_fixture: true,
				id: "registry-a",
				url: `${serverUrl(redirectingRegistry)}registry/`,
			});
			const record = await freshRecord(402);

			await expect(endpoint.discover(discoveryRequest())).resolves.toMatchObject({
				accepted: false,
				code: "endpoint-unavailable",
			});
			await expect(endpoint.register({ clientId: record.peerId, record, signal: signal() })).resolves.toMatchObject({
				accepted: false,
				code: "endpoint-unavailable",
			});
			expect(redirectTargetCalls).toBe(0);
		} finally {
			await Promise.all([close(redirectingRegistry), close(redirectTarget)]);
		}
	});

	it("rejects plaintext non-loopback URLs and all URL credentials", async () => {
		const createEndpoint = await loadHttpFactory();
		if (createEndpoint === undefined) return;

		expect(() => createEndpoint({ id: "registry-a", url: "http://registry.example/v1/" })).toThrow(/https/iu);
		expect(() => createEndpoint({ id: "registry-a", url: "https://user:secret@registry.example/v1/" })).toThrow(
			/credential/iu
		);
		expect(() =>
			createEndpoint({
				allow_insecure_loopback_fixture: true,
				id: "registry-a",
				url: "http://registry.example/v1/",
			})
		).toThrow(/loopback|https/iu);
		expect(() =>
			createEndpoint({
				allow_insecure_loopback_fixture: true,
				id: "registry-a",
				url: "http://127.0.0.1:4100/v1/",
			})
		).not.toThrow();
	});

	it.each([
		[
			"wrong content type",
			(): Response => new Response("{}", { headers: { "content-type": "text/plain" }, status: 200 }),
		],
		[
			"malformed JSON",
			(): Response => new Response("{not-json", { headers: { "content-type": "application/json" }, status: 200 }),
		],
		[
			"oversized response",
			(): Response =>
				new Response(JSON.stringify({ padding: "x".repeat(262_145) }), {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
		],
	] as const)("maps a %s to a typed endpoint failure", async (_name, response) => {
		const createEndpoint = await loadHttpFactory();
		if (createEndpoint === undefined) return;
		const endpoint = createEndpoint({
			fetchImpl: () => Promise.resolve(response()),
			id: "registry-a",
			url: "https://registry.example/",
		});

		await expect(endpoint.discover(discoveryRequest())).resolves.toMatchObject({
			accepted: false,
			code: "endpoint-unavailable",
		});
	});

	it("aborts each fetch at the configured child deadline without waiting for the caller deadline", async () => {
		const createEndpoint = await loadHttpFactory();
		if (createEndpoint === undefined) return;
		const fetchImpl = vi.fn<typeof globalThis.fetch>(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				})
		);
		const endpoint = createEndpoint({
			fetchImpl,
			id: "registry-a",
			limits: { requestTimeoutMs: 20 },
			url: "https://registry.example/",
		});
		const startedAt = performance.now();

		await expect(endpoint.discover(discoveryRequest())).resolves.toMatchObject({
			accepted: false,
			code: "endpoint-unavailable",
		});
		expect(performance.now() - startedAt).toBeLessThan(250);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});
});

async function loadHttpFactory(): Promise<PhaseFourHttpModule["createHttpRegistryEndpoint"] | undefined> {
	const loaded = (await import("@ts-drp/rendezvous")) as unknown as Partial<PhaseFourHttpModule>;
	expect(loaded.createHttpRegistryEndpoint, "Phase 4a must export createHttpRegistryEndpoint").toBeTypeOf("function");
	return loaded.createHttpRegistryEndpoint;
}

function discoveryRequest(): RegistryDiscoveryRequest {
	return { clientId: "reader-a", namespace: `drp-network:v1:${"a".repeat(43)}`, signal: signal() };
}

async function freshRecord(index: number): Promise<SignedDrpRecordV1> {
	const issuedAtMs = Date.now();
	return signedFixture(index, { expiresAtMs: issuedAtMs + 60_000, issuedAtMs });
}

function jsonResponse(value: RegistryDiscoveryReceipt | RegistrationReceipt | RegistryRejection): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status: 200,
	});
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
}

function serverUrl(server: ReturnType<typeof createServer>): string {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fixture server is not listening");
	return `http://127.0.0.1:${address.port}/`;
}

type _RegisterWireSource = RegistryRegistrationRequest;
const _registerWireSource: _RegisterWireSource | undefined = undefined;
void _registerWireSource;
