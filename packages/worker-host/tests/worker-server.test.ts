import { describe, expect, it, vi } from "vitest";

import { EndpointDouble, PROTOCOL, turn, VERSION } from "./wire-fixture.js";

type WorkerModule = Record<string, unknown> & {
	serveWorkerTasks?(scope: EndpointDouble, tasks: Record<string, unknown>): void;
};

let workerModulePromise: Promise<WorkerModule> | undefined;
async function workerModule(): Promise<WorkerModule> {
	workerModulePromise ??= vi.importActual<WorkerModule>("@ts-drp/worker-host/worker").catch(() => ({}));
	return workerModulePromise;
}

async function serve(scope: EndpointDouble, tasks: Record<string, unknown>): Promise<void> {
	const module = await workerModule();
	expect(module.serveWorkerTasks, "missing production ./worker export").toBeTypeOf("function");
	if (typeof module.serveWorkerTasks !== "function") throw new Error("missing production ./worker export");
	module.serveWorkerTasks(scope, tasks);
}

function request(id: string, task: string, payload = new Uint8Array()): Record<string, unknown> {
	return { protocol: PROTOCOL, version: VERSION, kind: "request", id, task, payload };
}

function cancel(id: string): Record<string, unknown> {
	return { protocol: PROTOCOL, version: VERSION, kind: "cancel", id };
}

describe("Phase 2f-b worker task server RED", () => {
	it("exports only the server and posts one sorted exact ready after installing its listener", async () => {
		const module = await workerModule();
		expect(Object.keys(module)).toEqual(["serveWorkerTasks"]);
		const scope = new EndpointDouble();
		let handled = false;
		scope.postMessage = (message: unknown): void => {
			expect(scope.listeners.get("message")?.size).toBe(1);
			EndpointDouble.prototype.postMessage.call(scope, message);
		};
		await serve(scope, {
			zebra: (): void => undefined,
			alpha: (): void => {
				handled = true;
			},
		});
		expect(handled).toBe(false);
		expect(scope.posted).toEqual([
			{ protocol: PROTOCOL, version: VERSION, kind: "ready", accepts: ["alpha", "zebra"] },
		]);
	});

	it("uses sorted own registry keys and excludes inherited task names", async () => {
		const tasks = Object.create({ inherited: (): void => undefined }) as Record<string, unknown>;
		tasks.zeta = (): void => undefined;
		tasks.alpha = (): void => undefined;
		const scope = new EndpointDouble();
		await serve(scope, tasks);
		expect(scope.posted).toEqual([{ protocol: PROTOCOL, version: VERSION, kind: "ready", accepts: ["alpha", "zeta"] }]);
	});

	it("rejects invalid/oversized registries and duplicate installation synchronously", async () => {
		const module = await workerModule();
		expect(module.serveWorkerTasks, "missing production ./worker export").toBeTypeOf("function");
		if (typeof module.serveWorkerTasks !== "function") throw new Error("missing production ./worker export");
		const serveTasks = module.serveWorkerTasks;
		for (const tasks of [
			{ "Bad Name": (): void => undefined },
			Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`t${index}`, (): void => undefined])),
		]) {
			const scope = new EndpointDouble();
			expect(() => serveTasks(scope, tasks)).toThrowError(
				expect.objectContaining({ code: "worker-host-invalid-option" })
			);
			expect(scope.posted).toEqual([]);
		}
		const scope = new EndpointDouble();
		serveTasks(scope, { echo: (): void => undefined });
		expect(() => serveTasks(scope, { echo: (): void => undefined })).toThrowError(
			expect.objectContaining({ code: "worker-host-invalid-option" })
		);
	});

	it("processes a request received during the first ready post (listener-before-post causal control)", async () => {
		const scope = new EndpointDouble();
		const basePost = scope.postMessage.bind(scope);
		scope.postMessage = (message: unknown): void => {
			basePost(message);
			if ((message as { kind?: unknown }).kind === "ready") {
				scope.emit("message", request("0000000000000001", "echo", new Uint8Array([4])));
			}
		};
		await serve(scope, {
			echo: (payload: Uint8Array, context: { emit(value: Uint8Array): void }): void => {
				context.emit(payload);
			},
		});
		await turn();
		expect(scope.posted.map((value) => (value as { kind?: unknown }).kind)).toEqual(["ready", "chunk", "done"]);
		expect(scope.posted[1]).toMatchObject({ sequence: 0, payload: new Uint8Array([4]) });
		expect(scope.posted[2]).toMatchObject({ chunks: 1, bytes: 1 });
	});

	it("returns closed wire failures for unknown task, bad request, and handler rejection", async () => {
		const scope = new EndpointDouble();
		await serve(scope, { fail: async () => Promise.reject(new Error("private")) });
		scope.emit("message", request("0000000000000001", "unknown"));
		scope.emit("message", { ...request("0000000000000002", "fail"), extra: true });
		scope.emit("message", request("0000000000000003", "fail"));
		scope.emit("message", request("0000000000000004", "fail", new Uint8Array(1_048_577)));
		await turn();
		const failures = scope.posted.filter((value) => (value as { kind?: unknown }).kind === "failed");
		expect(failures).toHaveLength(4);
		expect(failures.map((value) => (value as { code: string }).code)).toEqual([
			"worker-task-unknown",
			"worker-payload-invalid",
			"worker-task-failed",
			"worker-payload-invalid",
		]);
		for (const failure of failures) expect(failure).toMatchObject({ chunks: 0, bytes: 0 });
	});

	it("aborts task context on cancel, emits one cancelled terminal, and stays alive", async () => {
		const scope = new EndpointDouble();
		let observedSignal: AbortSignal | undefined;
		await serve(scope, {
			wait: async (_payload: Uint8Array, context: { signal: AbortSignal }) => {
				observedSignal = context.signal;
				await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
			},
		});
		const id = "0000000000000001";
		scope.emit("message", request(id, "wait"));
		await turn();
		scope.emit("message", cancel(id));
		await turn();
		expect(observedSignal?.aborted).toBe(true);
		expect(scope.posted.filter((value) => (value as { kind?: unknown }).kind === "cancelled")).toEqual([
			{ protocol: PROTOCOL, version: VERSION, kind: "cancelled", id, chunks: 0, bytes: 0 },
		]);
		expect(scope.terminateCalls).toBe(0);
	});

	it("normalizes a small request view and rejects non-tight emits and post-settlement emits", async () => {
		const scope = new EndpointDouble();
		let retainedEmit: ((value: Uint8Array) => void) | undefined;
		let seenPayload: Uint8Array | undefined;
		await serve(scope, {
			echo: (payload: Uint8Array, context: { emit(value: Uint8Array): void }) => {
				seenPayload = payload;
				retainedEmit = context.emit;
				expect(() => context.emit(new Uint8Array(70_000))).toThrowError(
					expect.objectContaining({ code: "worker-host-invalid-option" })
				);
				expect(() => context.emit(new Uint8Array([9, 1, 9]).subarray(1, 2))).toThrowError(
					expect.objectContaining({ code: "worker-host-invalid-option" })
				);
				context.emit(new Uint8Array([1]));
			},
		});
		const backing = new Uint8Array([9, 2, 9]);
		scope.emit("message", request("0000000000000001", "echo", backing.subarray(1, 2)));
		await turn();
		expect(seenPayload).toEqual(new Uint8Array([2]));
		expect(seenPayload?.buffer.byteLength).toBe(1);
		expect(() => retainedEmit?.(new Uint8Array())).toThrowError(
			expect.objectContaining({ code: "worker-host-invalid-option" })
		);
	});

	it("green scope-double control distinguishes synchronous listener custody from server behavior", () => {
		const scope = new EndpointDouble();
		const seen: unknown[] = [];
		scope.addEventListener("message", (event) => seen.push(event.data));
		scope.emit("message", request("0000000000000001", "echo"));
		expect(seen).toHaveLength(1);
		expect(scope.posted).toEqual([]);
	});
});
