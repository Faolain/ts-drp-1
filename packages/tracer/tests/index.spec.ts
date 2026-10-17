import { type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { type IMetrics } from "@ts-drp/types";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { disableTracing, enableTracing, flush, isTracingEnabled, OpentelemetryMetrics } from "../src/index.js";
import * as contextManager from "../src/context-manager.js";

// Mock OpenTelemetry dependencies
vi.mock("@opentelemetry/api", () => {
	const mockSpan = {
		setAttribute: vi.fn(),
		recordException: vi.fn(),
		setStatus: vi.fn(),
		end: vi.fn(),
		_spanContext: {},
		kind: 0,
		attributes: {},
		links: [],
		events: [],
		duration: [],
		ended: false,
		instrumentationLibrary: { name: "test", version: "1.0.0" },
		resource: { attributes: {} },
		startTime: [0, 0],
		status: { code: 0 },
		name: "test",
	};
	const mockTracer = {
		startSpan: vi.fn(() => mockSpan),
	};
	return {
		trace: {
			setSpan: vi.fn(),
			getTracer: vi.fn(() => mockTracer),
		},
		context: {
			active: vi.fn(),
			with: vi.fn((_, fn, _thisArg, ...args) => fn(...args)),
			setGlobalContextManager: vi.fn(),
		},
		SpanStatusCode: {
			OK: 1,
			ERROR: 2,
		},
	};
});

vi.mock("@opentelemetry/context-async-hooks", () => ({
	AsyncHooksContextManager: vi.fn().mockImplementation(() => ({
		enable: vi.fn(),
		disable: vi.fn(),
	})),
}));

vi.mock("@opentelemetry/context-zone", () => ({
	ZoneContextManager: vi.fn().mockImplementation(() => ({
		enable: vi.fn(),
		disable: vi.fn(),
	})),
}));

vi.mock("@opentelemetry/sdk-trace-web", () => {
	const mockSpan = {
		setAttribute: vi.fn(),
		recordException: vi.fn(),
		setStatus: vi.fn(),
		end: vi.fn(),
		_spanContext: {},
		kind: 0,
		attributes: {},
		links: [],
		events: [],
		duration: [],
		ended: false,
		instrumentationLibrary: { name: "test", version: "1.0.0" },
		resource: { attributes: {} },
		startTime: [0, 0],
		status: { code: 0 },
		name: "test",
	};
	const mockTracer = {
		startSpan: vi.fn(() => mockSpan),
	};

	const WebTracerProvider = vi.fn().mockImplementation(() => ({
		register: vi.fn(),
		getTracer: vi.fn(() => mockTracer),
		forceFlush: vi.fn().mockResolvedValue(undefined),
		_config: {},
		_registeredSpanProcessors: [],
		_tracers: new Map(),
		activeSpanProcessor: {
			onStart: vi.fn(),
			onEnd: vi.fn(),
			shutdown: vi.fn(),
			forceFlush: vi.fn(),
		},
		resource: {
			attributes: {},
			merge: vi.fn(),
		},
		shutdown: vi.fn(),
		getActiveSpanProcessor: vi.fn(),
		addSpanProcessor: vi.fn(),
	}));

	const BatchSpanProcessor = vi.fn();

	return { WebTracerProvider, BatchSpanProcessor };
});

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
	OTLPTraceExporter: vi.fn(),
}));

describe("tracing lifecycle", () => {
	let metrics: IMetrics;

	beforeEach(() => {
		disableTracing();
		vi.clearAllMocks();
		metrics = new OpentelemetryMetrics("metric");
	});

	test("should enable and disable tracing", async () => {
		expect(isTracingEnabled()).toBe(false);
		await enableTracing({
			provider: {
				serviceName: "test",
				exporterUrl: "http://localhost:9999",
			},
		});
		expect(isTracingEnabled()).toBe(true);

		// Check if the tracer provider was initialized correctly
		expect(WebTracerProvider).toHaveBeenCalled();
		expect(OTLPTraceExporter).toHaveBeenCalledWith({
			url: "http://localhost:9999",
			headers: expect.any(Object),
		});

		const fn = metrics.traceFunc("test", (a: number) => a + 1);
		expect(fn(1)).toBe(2);

		disableTracing();
		expect(isTracingEnabled()).toBe(false);

		// Should still work when disabled, just without tracing
		const result = fn(1);
		expect(result).toBe(2);
	});

	test("metrics created while disabled acquire a tracer lazily after enablement", async () => {
		const fn = metrics.traceFunc("lazy", (value: number) => value + 1);
		await enableTracing();

		expect(fn(1)).toBe(2);
		const mockProvider = vi.mocked(WebTracerProvider).mock.results[0].value;
		expect(mockProvider.getTracer).toHaveBeenCalledWith("metric");
	});

	test("should allow flushing traces", async () => {
		await enableTracing();

		expect(WebTracerProvider).toHaveBeenCalled();
		const mockProvider = vi.mocked(WebTracerProvider).mock.results[0].value;

		await flush();
		expect(mockProvider.forceFlush).toHaveBeenCalled();
		disableTracing();
	});

	test("concurrent enablement joins one initialization and captures options", async () => {
		let resume!: () => void;
		const gate = new Promise<void>(resolve => {resume = resolve;});
		const initialize = vi.spyOn(contextManager, "initContextManager").mockImplementationOnce(() => gate);
		try {
			const options = {provider: {exporterUrl: "http://localhost:7777", exporterHeaders: {"x-test": "original"}}};
			const first = enableTracing(options), second = enableTracing({provider: {exporterUrl: "http://localhost:8888"}});
			expect(second).toBe(first);
			expect(isTracingEnabled()).toBe(false);
			await Promise.resolve();
			expect(initialize).toHaveBeenCalledOnce();
			options.provider.exporterHeaders["x-test"] = "mutated";
			resume(); await first;
			expect(isTracingEnabled()).toBe(true);
			expect(WebTracerProvider).toHaveBeenCalledOnce();
			expect(OTLPTraceExporter).toHaveBeenCalledWith({url: "http://localhost:7777", headers: {"x-test": "original"}});
		} finally {resume(); initialize.mockRestore();}
	});

	test("disablement fences pending enablement before provider effects", async () => {
		let resume!: () => void;
		const gate = new Promise<void>(resolve => {resume = resolve;});
		const initialize = vi.spyOn(contextManager, "initContextManager").mockImplementationOnce(() => gate);
		try {
			const pending = enableTracing();
			await Promise.resolve(); disableTracing(); resume(); await pending;
			expect(isTracingEnabled()).toBe(false);
			expect(WebTracerProvider).not.toHaveBeenCalled();
			expect(OTLPTraceExporter).not.toHaveBeenCalled();
			await enableTracing();
			expect(isTracingEnabled()).toBe(true);
			expect(WebTracerProvider).toHaveBeenCalledOnce();
		} finally {resume(); initialize.mockRestore();}
	});

	test("failed initialization stays disabled and permits an explicit retry", async () => {
		const failure = new Error("context initialization failed");
		const initialize = vi.spyOn(contextManager, "initContextManager").mockImplementationOnce(() => {throw failure;});
		try {
			await expect(enableTracing()).rejects.toBe(failure);
			expect(isTracingEnabled()).toBe(false);
			expect(WebTracerProvider).not.toHaveBeenCalled();
			await enableTracing();
			expect(isTracingEnabled()).toBe(true);
		} finally {initialize.mockRestore();}
	});

	describe("wrapping functions", () => {
		beforeEach(async () => {
			vi.clearAllMocks();
			await enableTracing();
		});

		test("should wrap synchronous functions", () => {
			const fn = metrics.traceFunc("test", (a: number, b: number) => a + b);
			expect(fn(1, 2)).toBe(3);
		});

		test("should wrap async functions", async () => {
			const fn = metrics.traceFunc("test", async (a: number, b: number): Promise<number> => {
				await Promise.resolve();
				return a + b;
			});
			expect(await fn(1, 2)).toBe(3);
		});

		test("should wrap generator functions", () => {
			const fn = metrics.traceFunc("test", function* (a: number) {
				yield a + 1;
				yield a + 2;
			});
			const gen = fn(1);
			expect(gen.next().value).toBe(2);
			expect(gen.next().value).toBe(3);
			expect(gen.next().done).toBe(true);
		});

		test("should wrap async generator functions", async () => {
			const fn = metrics.traceFunc("test", async function* (a: number) {
				await Promise.resolve();
				yield a + 1;
				yield a + 2;
			});
			const gen = fn(1);
			expect((await gen.next()).value).toBe(2);
			expect((await gen.next()).value).toBe(3);
			expect((await gen.next()).done).toBe(true);
		});

		test("should handle errors in synchronous functions", () => {
			const fn = metrics.traceFunc("test", () => {
				throw new Error("test error");
			});
			expect(() => fn()).toThrow("test error");
			const mockProvider = vi.mocked(WebTracerProvider).mock.results[0].value;
			const mockTracer = vi.mocked(mockProvider.getTracer).mock.results[0].value;
			const mockSpan = vi.mocked(mockTracer.startSpan).mock.results[0].value;
			expect(mockSpan.end).toHaveBeenCalledOnce();
		});

		test("should handle errors in async functions", async () => {
			const fn = metrics.traceFunc("test", async () => {
				await Promise.resolve();
				throw new Error("test error");
			});
			await expect(fn()).rejects.toThrow("test error");
			const mockProvider = vi.mocked(WebTracerProvider).mock.results[0].value;
			const mockTracer = vi.mocked(mockProvider.getTracer).mock.results[0].value;
			const mockSpan = vi.mocked(mockTracer.startSpan).mock.results[0].value;
			expect(mockSpan.end).toHaveBeenCalledOnce();
		});

		test("should apply custom attributes", () => {
			const fn = metrics.traceFunc(
				"test",
				(a: number) => a + 1,
				(span: Span, a: number) => {
					span.setAttribute("input", a);
				}
			);
			expect(fn(1)).toBe(2);
		});

		test("should apply result-derived attributes", async () => {
			const setResultAttributes = vi.fn();
			const fn = metrics.traceFunc(
				"result-attributes",
				async (a: number) => Promise.resolve(a + 1),
				undefined,
				setResultAttributes
			);

			expect(await fn(1)).toBe(2);
			expect(setResultAttributes).toHaveBeenCalledWith(expect.anything(), 2);
		});

		test("should trace functions that return promises", async () => {
			const tracedPromise = metrics.traceFunc("promise-test", () => Promise.resolve(42));
			const result = await tracedPromise();
			expect(result).toBe(42);
		});

		test("should trace functions that return generators", () => {
			const tracedGenerator = metrics.traceFunc("generator-test", function* () {
				yield 1;
				yield 2;
				return 3;
			});
			const gen = tracedGenerator();
			expect(gen.next().value).toBe(1);
			expect(gen.next().value).toBe(2);
			const final = gen.next();
			expect(final.value).toBe(3);
			expect(final.done).toBe(true);
		});

		test("should trace functions that return async generators", async () => {
			const tracedAsyncGenerator = metrics.traceFunc("async-generator-test", async function* () {
				await Promise.resolve();
				yield 1;
				yield 2;
				return 3;
			});
			const gen = tracedAsyncGenerator();
			expect((await gen.next()).value).toBe(1);
			expect((await gen.next()).value).toBe(2);
			const final = await gen.next();
			expect(final.value).toBe(3);
			expect(final.done).toBe(true);
		});

		test("should handle errors in returned promises", async () => {
			const tracedPromise = metrics.traceFunc("error-promise-test", () => Promise.reject(new Error("promise error")));
			await expect(tracedPromise()).rejects.toThrow("promise error");
		});

		test("should handle errors in returned generators", () => {
			const tracedGenerator = metrics.traceFunc("error-generator-test", function* () {
				yield 1;
				throw new Error("generator error");
			});
			const gen = tracedGenerator();
			expect(gen.next().value).toBe(1);
			expect(() => gen.next()).toThrow("generator error");
		});

		test("should handle errors in returned async generators", async () => {
			const tracedAsyncGenerator = metrics.traceFunc("error-async-generator-test", async function* () {
				await Promise.resolve();
				yield 1;
				throw new Error("async generator error");
			});
			const gen = tracedAsyncGenerator();
			expect((await gen.next()).value).toBe(1);
			await expect(gen.next()).rejects.toThrow("async generator error");
		});
	});
});
