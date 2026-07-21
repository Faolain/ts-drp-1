import {
	AdmissionPolicy,
	RecordValidator,
	RegistryClient,
	type RegistryEndpoint,
	RegistryServer,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";

import { signedFixture } from "./fixtures.js";

interface RegistryHttpService {
	readonly url: string;
	close(): Promise<void>;
}

interface RegistryServiceModule {
	createRegistryHttpService(options: {
		readonly host?: string;
		readonly port?: number;
		readonly requestTimeoutMs?: number;
		readonly server: Pick<RegistryServer, "discover" | "register">;
	}): Promise<RegistryHttpService> | RegistryHttpService;
}

interface HttpEndpointModule {
	createHttpRegistryEndpoint(options: {
		readonly allow_insecure_loopback_fixture?: boolean;
		readonly id: string;
		readonly url: string;
	}): RegistryEndpoint;
}

const INVITE = "phase-four-http-fixture-token";

describe("Phase 4a real HTTP registry round trip", () => {
	it("replicates to two loopback services, unions their records, and survives one service closing", async () => {
		const modules = await loadHttpModules();
		if (modules === undefined) return;
		const servers = [registryServer("registry-a"), registryServer("registry-b")] as const;
		const services: RegistryHttpService[] = [];
		try {
			for (const server of servers) {
				services.push(await modules.service.createRegistryHttpService({ host: "127.0.0.1", port: 0, server }));
			}
			const endpoints = services.map((service, index) =>
				modules.http.createHttpRegistryEndpoint({
					allow_insecure_loopback_fixture: true,
					id: `registry-${index === 0 ? "a" : "b"}`,
					url: service.url,
				})
			);
			const client = registryClient(endpoints);
			const published = await freshRecord(501);

			await expect(
				client.register(published, AbortSignal.timeout(2_000), { kind: "invite", token: INVITE })
			).resolves.toMatchObject({ acceptedEndpointIds: ["registry-a", "registry-b"], sequence: 1 });

			const onlyOnSecond = await freshRecord(502);
			await servers[1].register({
				clientId: onlyOnSecond.peerId,
				credential: { kind: "invite", token: INVITE },
				record: onlyOnSecond,
				signal: AbortSignal.timeout(1_000),
			});
			expect((await client.discover(published.namespace, AbortSignal.timeout(2_000))).map(peerId).sort()).toEqual(
				[published.peerId, onlyOnSecond.peerId].sort()
			);

			await services[0]?.close();
			services.shift();
			expect((await client.discover(published.namespace, AbortSignal.timeout(2_000))).map(peerId).sort()).toEqual(
				[published.peerId, onlyOnSecond.peerId].sort()
			);
			expect(client.lastAttempts).toEqual([
				{
					code: "endpoint-unavailable",
					endpointId: "registry-a",
					operation: "discover",
					status: "rejected",
				},
				{ endpointId: "registry-b", operation: "discover", status: "accepted" },
			]);
		} finally {
			await Promise.allSettled(services.map((service) => service.close()));
		}
	});

	it("returns bounded negative-path status codes before invoking registry logic", async () => {
		const modules = await loadHttpModules();
		if (modules === undefined) return;
		const service = await modules.service.createRegistryHttpService({
			host: "127.0.0.1",
			port: 0,
			server: registryServer("negative-paths"),
		});
		try {
			const oversizedStartedAt = performance.now();
			expect(
				await requestStatus(new URL("v1/register", service.url), {
					headers: { "content-length": String(64 * 1024 + 1), "content-type": "application/json" },
					method: "POST",
				})
			).toBe(413);
			expect(performance.now() - oversizedStartedAt).toBeLessThan(250);

			expect(
				await requestStatus(new URL("v1/register", service.url), {
					body: "{not-json",
					headers: { "content-type": "application/json" },
					method: "POST",
				})
			).toBe(400);
			expect(await requestStatus(new URL("unknown", service.url), { method: "POST" })).toBe(404);
			expect(await requestStatus(new URL("v1/discover", service.url), { method: "GET" })).toBe(405);
			expect(
				await requestStatus(new URL("v1/discover", service.url), {
					body: "{}",
					headers: { "content-type": "text/plain" },
					method: "POST",
				})
			).toBe(415);
		} finally {
			await service.close();
		}
	});

	it("destroys a slow-drip request socket at the configured deadline", async () => {
		const modules = await loadHttpModules();
		if (modules === undefined) return;
		const service = await modules.service.createRegistryHttpService({
			host: "127.0.0.1",
			port: 0,
			requestTimeoutMs: 40,
			server: registryServer("slow-drip"),
		});
		const url = new URL(service.url);
		const socket = createConnection({ host: url.hostname, port: Number(url.port) });
		try {
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			const closed = new Promise<boolean>((resolve) => socket.once("close", () => resolve(true)));
			socket.write(
				`POST /v1/register HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`
			);

			await expect(
				Promise.race([closed, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))])
			).resolves.toBe(true);
		} finally {
			socket.destroy();
			await service.close();
		}
	});
});

async function loadHttpModules(): Promise<{ http: HttpEndpointModule; service: RegistryServiceModule } | undefined> {
	const http = (await import("@ts-drp/rendezvous")) as unknown as Partial<HttpEndpointModule>;
	let service: Partial<RegistryServiceModule> = {};
	try {
		service = (await import(
			/* @vite-ignore */ new URL("../src/service.ts", import.meta.url).href
		)) as Partial<RegistryServiceModule>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/service\.ts|load url|does the file exist/iu.test(message)) throw error;
	}
	expect(http.createHttpRegistryEndpoint, "the browser-safe HTTP RegistryEndpoint factory is missing").toBeTypeOf(
		"function"
	);
	expect(service.createRegistryHttpService, "the Node-only registry HTTP service factory is missing").toBeTypeOf(
		"function"
	);
	if (http.createHttpRegistryEndpoint === undefined || service.createRegistryHttpService === undefined)
		return undefined;
	return { http: http as HttpEndpointModule, service: service as RegistryServiceModule };
}

function registryServer(endpointId: string): RegistryServer {
	return new RegistryServer({
		endpointId,
		policy: new AdmissionPolicy({ inviteToken: INVITE }),
		validator: new RecordValidator({
			resolver: { resolve: () => Promise.resolve(["93.184.216.34"]) },
		}),
	});
}

function registryClient(endpoints: readonly RegistryEndpoint[]): RegistryClient {
	return new RegistryClient({
		backoffMs: 0,
		clientId: "phase-four-reader",
		endpoints,
		timeoutMs: 1_000,
		validatorFactory: () => new RecordValidator({ resolver: { resolve: () => Promise.resolve(["93.184.216.34"]) } }),
	});
}

async function freshRecord(index: number): Promise<SignedDrpRecordV1> {
	const issuedAtMs = Date.now();
	return signedFixture(index, { expiresAtMs: issuedAtMs + 60_000, issuedAtMs });
}

function peerId(value: { readonly record: SignedDrpRecordV1 }): string {
	return value.record.peerId;
}

function requestStatus(
	url: URL,
	options: { readonly body?: string; readonly headers?: Record<string, string>; readonly method: string }
): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(url, { headers: options.headers, method: options.method }, (response) => {
			response.resume();
			response.once("end", () => resolve(response.statusCode ?? 0));
		});
		request.once("error", reject);
		if (options.body !== undefined) request.write(options.body);
		request.end();
	});
}
