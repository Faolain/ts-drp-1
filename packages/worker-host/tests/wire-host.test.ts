import { WorkerHostMetrics } from "@ts-drp/worker-host";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chunk, drain, EndpointDouble, PROTOCOL, ready, rejected, terminal, turn, VERSION } from "./wire-fixture.js";

const HOST_EXPORTS = [
	"WORKER_HOST_PROTOCOL",
	"WORKER_HOST_PROTOCOL_VERSION",
	"WORKER_WIRE_ERROR_CODES",
	"createWorkerHost",
] as const;
const WIRE_CODES = ["worker-internal", "worker-payload-invalid", "worker-task-failed", "worker-task-unknown"] as const;

type Host = {
	readonly state: "closed" | "ready" | "starting" | "terminated";
	close(): void;
	submit(
		task: string,
		payload: Uint8Array,
		options?: Readonly<{ signal?: AbortSignal }>
	): AsyncGenerator<Uint8Array, void, void>;
};
type HostModule = Record<string, unknown> & {
	createWorkerHost?(options: Record<string, unknown>): Host;
};

let hostModulePromise: Promise<HostModule> | undefined;

async function hostModule(): Promise<HostModule> {
	hostModulePromise ??= vi.importActual<HostModule>("@ts-drp/worker-host/host").catch(() => ({}));
	return hostModulePromise;
}

async function create(endpoint: EndpointDouble, options: Record<string, unknown> = {}): Promise<Host> {
	const module = await hostModule();
	expect(module.createWorkerHost, "missing production ./host export").toBeTypeOf("function");
	if (typeof module.createWorkerHost !== "function") throw new Error("missing production ./host export");
	return module.createWorkerHost({ endpoint, ...options });
}

function firstRequest(endpoint: EndpointDouble): Readonly<{ id: string; payload: Uint8Array }> {
	const request = endpoint.posted.find(
		(value): value is { id: string; kind: string; payload: Uint8Array } =>
			typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "request"
	);
	expect(request).toBeDefined();
	if (request === undefined) throw new Error("missing posted request");
	return request;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Phase 2f-b package boundary and wire registry RED", () => {
	it("publishes exactly root, host, and worker while preserving the Phase 2f-a root", async () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			exports: Record<string, unknown>;
		};
		expect(Object.keys(manifest.exports)).toEqual([".", "./host", "./worker"]);
		const module = await hostModule();
		expect(Object.keys(module).sort()).toEqual([...HOST_EXPORTS].sort());
		expect(module.WORKER_HOST_PROTOCOL).toBe(PROTOCOL);
		expect(module.WORKER_HOST_PROTOCOL_VERSION).toBe(VERSION);
		expect(module.WORKER_WIRE_ERROR_CODES).toEqual(WIRE_CODES);
		expect(Object.isFrozen(module.WORKER_WIRE_ERROR_CODES)).toBe(true);
	});

	it("keeps worker construction, restart, codec, hash, and fold owners out of the host source", () => {
		let source = "";
		try {
			source = readFileSync(new URL("../src/host.ts", import.meta.url), "utf8");
		} catch {
			// The absent implementation is the intended first RED.
		}
		expect(source).not.toMatch(/new\s+Worker|respawn|restart|replay|hashDomain|encodeCanonical|reducer|fold/u);
	});
});

describe("Phase 2f-b host admission, ready ordering, and bounds RED", () => {
	it("installs all listeners synchronously, starts in starting, and posts nothing before ready", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint);
		expect(host.state).toBe("starting");
		expect([...endpoint.listeners.keys()].sort()).toEqual(["error", "message", "messageerror"]);
		const stream = host.submit("echo", new Uint8Array([1]));
		expect(stream[Symbol.asyncIterator]()).toBe(stream);
		expect(endpoint.posted).toEqual([]);
		host.close();
	});

	it.each([
		["readyTimeoutMs", 99],
		["cancelAckTimeoutMs", 60_001],
		["maxPendingRequests", 0],
		["maxInFlightRequests", 65],
		["maxBufferedChunks", 1.5],
		["maxBufferedBytes", 65_535],
		["maxChunksPerRequest", 16_385],
		["maxResultBytesPerRequest", Number.NaN],
	] as const)("rejects invalid %s synchronously before endpoint side effects", async (name, value) => {
		const endpoint = new EndpointDouble();
		const module = await hostModule();
		expect(module.createWorkerHost, "missing production ./host export").toBeTypeOf("function");
		if (typeof module.createWorkerHost !== "function") throw new Error("missing production ./host export");
		const createHost = module.createWorkerHost;
		expect(() => createHost({ endpoint, [name]: value })).toThrowError(
			expect.objectContaining({ code: "worker-host-invalid-option" })
		);
		expect(endpoint.listeners.size).toBe(0);
		expect(endpoint.posted).toEqual([]);
	});

	it("flushes pre-ready FIFO to the in-flight cap with exact IDs and tight payloads", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint, { maxInFlightRequests: 2 });
		const backing = new Uint8Array([9, 1, 2, 9]);
		host.submit("echo", backing.subarray(1, 3));
		host.submit("echo", new Uint8Array([3]));
		host.submit("echo", new Uint8Array([4]));
		expect(endpoint.posted).toEqual([]);
		endpoint.emit("message", ready(["echo"]));
		expect(host.state).toBe("ready");
		expect(endpoint.posted).toHaveLength(2);
		expect(endpoint.posted[0]).toEqual({
			protocol: PROTOCOL,
			version: VERSION,
			kind: "request",
			id: "0000000000000001",
			task: "echo",
			payload: new Uint8Array([1, 2]),
		});
		const postedPayload = (endpoint.posted[0] as { payload: Uint8Array }).payload;
		expect(postedPayload.buffer.byteLength).toBe(2);
		expect((endpoint.posted[1] as { id: string }).id).toBe("0000000000000002");
		host.close();
	});

	it("rejects queue overflow before mutation and locally removes a pre-ready abort", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint, { maxPendingRequests: 1 });
		const controller = new AbortController();
		const cancelled = host.submit("echo", new Uint8Array(), { signal: controller.signal });
		expect(() => host.submit("echo", new Uint8Array())).toThrowError(
			expect.objectContaining({ code: "worker-host-queue-overflow" })
		);
		controller.abort();
		await rejected(cancelled.next(), "worker-host-cancelled");
		expect(endpoint.posted).toEqual([]);
		expect(() => host.submit("echo", new Uint8Array())).not.toThrow();
		host.close();
	});

	it("pre-abort is admitted locally without queue mutation or posting", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint, { maxPendingRequests: 1 });
		const controller = new AbortController();
		controller.abort();
		const stream = host.submit("echo", new Uint8Array(), { signal: controller.signal });
		await rejected(stream.next(), "worker-host-cancelled");
		expect(endpoint.posted).toEqual([]);
		expect(() => host.submit("echo", new Uint8Array())).not.toThrow();
		host.close();
	});

	it("rejects task grammar, payload type, and the 1 MiB request cap synchronously", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint);
		for (const [task, payload] of [
			["Bad", new Uint8Array()],
			["a-", new Uint8Array()],
			["a".repeat(65), new Uint8Array()],
			["echo", new Uint8Array(1_048_577)],
			["echo", new DataView(new ArrayBuffer(1))],
		] as const) {
			expect(() => host.submit(task, payload as Uint8Array)).toThrowError(
				expect.objectContaining({ code: "worker-host-invalid-option" })
			);
		}
		expect(endpoint.posted).toEqual([]);
		host.close();
	});

	it("fails a task absent from exact accepts locally and never posts it", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint);
		const stream = host.submit("missing", new Uint8Array());
		endpoint.emit("message", ready(["echo"]));
		const error = await rejected(stream.next(), "worker-host-task-failed");
		expect(error).toMatchObject({ detail: { wireCode: "worker-task-unknown" } });
		expect(endpoint.posted).toEqual([]);
		host.close();
	});
});

describe("Phase 2f-b host stream, cancellation, and lifecycle RED", () => {
	it("delivers contiguous chunks FIFO and accepts only exact terminal totals", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint);
		endpoint.emit("message", ready());
		const stream = host.submit("echo", new Uint8Array());
		const { id } = firstRequest(endpoint);
		endpoint.emit("message", chunk(id, 0, new Uint8Array([1, 2])));
		endpoint.emit("message", chunk(id, 1, new Uint8Array([3])));
		endpoint.emit("message", terminal(id, "done", 2, 3));
		await expect(drain(stream)).resolves.toEqual([new Uint8Array([1, 2]), new Uint8Array([3])]);
		host.close();
	});

	it("cancels once after dispatch and a valid terminal settles publicly cancelled", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint);
		endpoint.emit("message", ready());
		const controller = new AbortController();
		const stream = host.submit("echo", new Uint8Array(), { signal: controller.signal });
		const { id } = firstRequest(endpoint);
		controller.abort();
		controller.abort();
		expect(endpoint.posted.filter((value) => (value as { kind?: unknown }).kind === "cancel")).toEqual([
			{ protocol: PROTOCOL, version: VERSION, kind: "cancel", id },
		]);
		endpoint.emit("message", terminal(id, "done", 0, 0));
		await rejected(stream.next(), "worker-host-cancelled");
		host.close();
	});

	it("records only fixed caller-owned transport metrics and drops chunks after cancellation", async () => {
		const endpoint = new EndpointDouble();
		const metrics = new WorkerHostMetrics();
		const host = await create(endpoint, { metrics });
		const controller = new AbortController();
		const stream = host.submit("echo", new Uint8Array(), { signal: controller.signal });
		endpoint.emit("message", ready());
		const { id } = firstRequest(endpoint);
		controller.abort();
		endpoint.emit("message", chunk(id, 0, new Uint8Array([1])));
		endpoint.emit("message", terminal(id, "cancelled", 0, 0));
		await rejected(stream.next(), "worker-host-cancelled");
		const snapshot = metrics.snapshot();
		expect(snapshot.counters).toMatchObject({
			"chunks-dropped-after-cancel": 1,
			"requests-dispatched": 1,
			"requests-queued": 1,
		});
		expect(snapshot.timings["handshake-duration"].count).toBe(1);
		expect(snapshot.timings["request-duration"].count).toBe(1);
		host.close();
	});

	it("terminates every open request when a cancel acknowledgement never arrives", async () => {
		vi.useFakeTimers();
		const endpoint = new EndpointDouble();
		const host = await create(endpoint, { cancelAckTimeoutMs: 100, maxInFlightRequests: 2 });
		endpoint.emit("message", ready());
		const controller = new AbortController();
		const cancelled = host.submit("echo", new Uint8Array(), { signal: controller.signal });
		const sibling = host.submit("echo", new Uint8Array());
		controller.abort();
		await vi.advanceTimersByTimeAsync(101);
		await rejected(cancelled.next(), "worker-host-worker-terminated");
		await rejected(sibling.next(), "worker-host-worker-terminated");
		expect(endpoint.terminateCalls).toBe(1);
		expect(host.state).toBe("terminated");
	});

	it("fails loudly and cancels once when retained chunk or byte bounds are breached", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint, {
			maxBufferedChunks: 1,
			maxBufferedBytes: 65_536,
			maxChunksPerRequest: 2,
			maxResultBytesPerRequest: 65_536,
		});
		endpoint.emit("message", ready());
		const stream = host.submit("echo", new Uint8Array());
		const { id } = firstRequest(endpoint);
		endpoint.emit("message", chunk(id, 0, new Uint8Array([1])));
		endpoint.emit("message", chunk(id, 1, new Uint8Array([2])));
		await rejected(stream.next(), "worker-host-limit-exceeded");
		expect(endpoint.posted.filter((value) => (value as { kind?: unknown }).kind === "cancel")).toHaveLength(1);
		host.close();
	});

	it("enforces host-wide retained bytes across requests and per-request result totals independently", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint, {
			maxBufferedChunks: 4,
			maxBufferedBytes: 65_536,
			maxChunksPerRequest: 4,
			maxResultBytesPerRequest: 65_536,
			maxInFlightRequests: 3,
		});
		endpoint.emit("message", ready());
		const first = host.submit("echo", new Uint8Array());
		const firstId = firstRequest(endpoint).id;
		const second = host.submit("echo", new Uint8Array());
		const secondId = (endpoint.posted[1] as { id: string }).id;
		endpoint.emit("message", chunk(firstId, 0, new Uint8Array(40_000)));
		endpoint.emit("message", chunk(secondId, 0, new Uint8Array(30_000)));
		await rejected(second.next(), "worker-host-limit-exceeded");
		await expect(first.next()).resolves.toMatchObject({ done: false });
		endpoint.emit("message", terminal(firstId, "done", 1, 40_000));
		await expect(first.next()).resolves.toMatchObject({ done: true });

		const total = host.submit("echo", new Uint8Array());
		const totalId = (
			endpoint.posted.find(
				(value) =>
					(value as { kind?: unknown; id?: unknown }).kind === "request" &&
					(value as { id?: unknown }).id !== firstId &&
					(value as { id?: unknown }).id !== secondId
			) as { id: string }
		).id;
		const pendingFirst = total.next();
		endpoint.emit("message", chunk(totalId, 0, new Uint8Array(40_000)));
		await expect(pendingFirst).resolves.toMatchObject({ done: false });
		endpoint.emit("message", chunk(totalId, 1, new Uint8Array(30_000)));
		await rejected(total.next(), "worker-host-limit-exceeded");

		const count = host.submit("echo", new Uint8Array());
		const countId = (
			endpoint.posted.find(
				(value) =>
					(value as { kind?: unknown; id?: unknown }).kind === "request" &&
					![firstId, secondId, totalId].includes((value as { id: string }).id)
			) as { id: string }
		).id;
		for (let sequence = 0; sequence < 4; sequence += 1) {
			const next = count.next();
			endpoint.emit("message", chunk(countId, sequence, new Uint8Array([sequence])));
			await expect(next).resolves.toMatchObject({ done: false });
		}
		endpoint.emit("message", chunk(countId, 4, new Uint8Array([4])));
		await rejected(count.next(), "worker-host-limit-exceeded");
		host.close();
	});

	it("normalizes inbound chunk views and treats oversized chunk payloads as protocol violations", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint);
		endpoint.emit("message", ready());
		const stream = host.submit("echo", new Uint8Array());
		const { id } = firstRequest(endpoint);
		const backing = new Uint8Array([9, 5, 9]);
		const pending = stream.next();
		endpoint.emit("message", chunk(id, 0, backing.subarray(1, 2)));
		const delivered = await pending;
		expect(delivered).toMatchObject({ done: false, value: new Uint8Array([5]) });
		expect(delivered.value?.buffer.byteLength).toBe(1);
		endpoint.emit("message", chunk(id, 1, new Uint8Array(65_537)));
		await rejected(stream.next(), "worker-host-protocol-violation");
	});

	it("consumer abandonment posts one cancel and never replays or respawns the endpoint", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint);
		endpoint.emit("message", ready());
		const stream = host.submit("echo", new Uint8Array());
		const { id } = firstRequest(endpoint);
		const pending = stream.next();
		endpoint.emit("message", chunk(id, 0, new Uint8Array([1])));
		await pending;
		await stream.return(undefined);
		await turn();
		expect(endpoint.posted.filter((value) => (value as { kind?: unknown }).kind === "request")).toHaveLength(1);
		expect(endpoint.posted.filter((value) => (value as { kind?: unknown }).kind === "cancel")).toEqual([
			{ protocol: PROTOCOL, version: VERSION, kind: "cancel", id },
		]);
		expect(endpoint.terminateCalls).toBe(0);
		host.close();
	});

	it.each([
		["duplicate ready", ready()],
		["unsorted accepts", ready(["z", "a"])],
		["duplicate accepts", ready(["echo", "echo"])],
		["too many accepts", ready(Array.from({ length: 65 }, (_, index) => `t${index}`).sort())],
		["non-plain object", Object.assign(new Date(0), ready())],
		["extra field", { ...ready(), extra: true }],
		["wrong protocol", { ...ready(), protocol: "other" }],
	] as const)("terminates on %s before routing", async (_name, malformed) => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint);
		const stream = host.submit("echo", new Uint8Array());
		endpoint.emit("message", ready());
		endpoint.emit("message", malformed);
		await rejected(stream.next(), "worker-host-protocol-violation");
		expect(host.state).toBe("terminated");
		expect(endpoint.terminateCalls).toBe(1);
	});

	it.each([
		["sequence gap", (id: string): Record<string, unknown> => chunk(id, 1, new Uint8Array())],
		["wrong terminal chunks", (id: string): Record<string, unknown> => terminal(id, "done", 1, 0)],
		["never-issued id", (): Record<string, unknown> => terminal("000000000000ffff", "done", 0, 0)],
	] as const)("treats %s as a host-wide protocol violation", async (_name, message) => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint);
		endpoint.emit("message", ready());
		const stream = host.submit("echo", new Uint8Array());
		const { id } = firstRequest(endpoint);
		endpoint.emit("message", message(id));
		await rejected(stream.next(), "worker-host-protocol-violation");
		expect(endpoint.terminateCalls).toBe(1);
	});

	it("ignores a wholly valid stale terminal but validates malformed stale data first", async () => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint);
		endpoint.emit("message", ready());
		const first = host.submit("echo", new Uint8Array());
		const { id } = firstRequest(endpoint);
		endpoint.emit("message", terminal(id, "done", 0, 0));
		await expect(drain(first)).resolves.toEqual([]);
		endpoint.emit("message", terminal(id, "done", 0, 0));
		expect(host.state).toBe("ready");
		endpoint.emit("message", { ...terminal(id, "done", 0, 0), extra: true });
		expect(host.state).toBe("terminated");
	});

	it.each([
		["error", "worker-host-worker-terminated"],
		["messageerror", "worker-host-protocol-violation"],
	] as const)("settles all open work on endpoint %s", async (event, code) => {
		const endpoint = new EndpointDouble();
		const host = await create(endpoint);
		const streams = [host.submit("echo", new Uint8Array()), host.submit("echo", new Uint8Array())];
		endpoint.emit(event, new Error(event));
		for (const stream of streams) await rejected(stream.next(), code);
		expect(endpoint.terminateCalls).toBe(1);
	});

	it("ready timeout is bounded, and close is idempotent, terminal, and listener-clean", async () => {
		vi.useFakeTimers();
		const endpoint = new EndpointDouble();
		const host = await create(endpoint, { readyTimeoutMs: 100 });
		const stream = host.submit("echo", new Uint8Array());
		await vi.advanceTimersByTimeAsync(101);
		await rejected(stream.next(), "worker-host-handshake-timeout");
		expect(host.state).toBe("terminated");
		expect(() => host.submit("echo", new Uint8Array())).toThrowError(
			expect.objectContaining({ code: "worker-host-closed" })
		);
		host.close();
		host.close();
		expect(endpoint.terminateCalls).toBe(1);
		expect([...endpoint.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);

		const closeEndpoint = new EndpointDouble();
		const closedHost = await create(closeEndpoint);
		const open = closedHost.submit("echo", new Uint8Array());
		closedHost.close();
		closedHost.close();
		await rejected(open.next(), "worker-host-closed");
		expect(closedHost.state).toBe("closed");
		expect(closeEndpoint.terminateCalls).toBe(1);
		expect([...closeEndpoint.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
	});

	it("green endpoint-double control preserves exact fields and event custody", async () => {
		const endpoint = new EndpointDouble();
		const observed: unknown[] = [];
		endpoint.addEventListener("message", (event) => observed.push(event.data));
		const message = chunk("0000000000000001", 0, new Uint8Array([7]));
		endpoint.postMessage(message);
		endpoint.emit("message", message);
		await turn();
		expect(endpoint.posted).toEqual([message]);
		expect(observed).toEqual([message]);
	});
});
