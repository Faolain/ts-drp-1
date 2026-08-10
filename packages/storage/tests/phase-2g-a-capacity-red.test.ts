/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await -- table-driven fake ports intentionally use concise callbacks */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as adapter from "../src/adapter.js";
import * as contract from "../src/contract.js";
import * as storageRoot from "../src/index.js";
import {
	selectCapacityApi,
	type TestCapacityApi,
	type TestStorageCapacityPort,
} from "./fixtures/phase-2g-a-capacity-scaffold.js";

const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../..");
const storageModule = storageRoot as unknown as Record<string, unknown>;
const capacity: TestCapacityApi = selectCapacityApi(storageModule);

function expectClosedFrozen(value: unknown): void {
	expect(value).not.toBeNull();
	expect(typeof value).toBe("object");
	expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
	expect(Object.isFrozen(value)).toBe(true);
	for (const child of Object.values(value as Record<string, unknown>)) {
		if (typeof child === "object" && child !== null) expectClosedFrozen(child);
	}
}

function rejection(message: string): Promise<never> {
	return Promise.reject(new Error(message));
}

describe("Phase 2g-a neutral capacity observation RED", () => {
	it.each([
		{
			label: "both methods absent",
			port: {},
			expected: {
				persistence: { status: "unsupported" },
				quota: { reason: "unsupported", status: "unavailable" },
			},
		},
		{
			label: "non-callable methods",
			port: { estimate: 1, persist: true, persisted: "yes" },
			expected: {
				persistence: { status: "unsupported" },
				quota: { reason: "unsupported", status: "unavailable" },
			},
		},
		{
			label: "unsupported persistence with available estimate",
			port: { estimate: () => ({ quota: 7, usage: 2 }) },
			expected: {
				persistence: { status: "unsupported" },
				quota: { availableBytes: 5, quotaBytes: 7, status: "available", usageBytes: 2 },
			},
		},
		{
			label: "granted persistence and complete estimate",
			port: { estimate: () => ({ quota: 100, usage: 40 }), persisted: () => true },
			expected: {
				persistence: { status: "granted" },
				quota: { availableBytes: 60, quotaBytes: 100, status: "available", usageBytes: 40 },
			},
		},
		{
			label: "not-granted persistence and equality estimate",
			port: { estimate: async () => ({ quota: 12, usage: 12 }), persisted: async () => false },
			expected: {
				persistence: { status: "not-granted" },
				quota: { availableBytes: 0, quotaBytes: 12, status: "available", usageBytes: 12 },
			},
		},
	] as const)("classifies $label as independent closed facts", async ({ port, expected }) => {
		const report = await capacity.inspectStorageCapability(port as TestStorageCapacityPort);
		expect(report).toEqual(expected);
		expectClosedFrozen(report);
	});

	it.each([
		{
			label: "sync throw",
			persisted: () => {
				throw new Error("persisted-sync");
			},
		},
		{ label: "rejection", persisted: () => rejection("persisted-async") },
	] as const)("contains a persisted $label and still attempts the estimate axis", async ({ persisted }) => {
		const calls: string[] = [];
		const report = await capacity.inspectStorageCapability({
			estimate: () => {
				calls.push("estimate");
				return { quota: 9, usage: 4 };
			},
			persisted: () => {
				calls.push("persisted");
				return persisted();
			},
		});
		expect(report).toEqual({
			persistence: { reason: "exception", status: "unavailable" },
			quota: { availableBytes: 5, quotaBytes: 9, status: "available", usageBytes: 4 },
		});
		expect(calls).toEqual(["persisted", "estimate"]);
	});

	it.each([undefined, null, 0, 1, "true", {}, []])(
		"rejects a non-boolean persisted response without coercion: %j",
		async (response) => {
			const report = await capacity.inspectStorageCapability({
				estimate: () => ({ quota: 2, usage: 1 }),
				persisted: () => response,
			});
			expect(report.persistence).toEqual({ reason: "invalid-response", status: "unavailable" });
			expect(report.quota).toEqual({
				availableBytes: 1,
				quotaBytes: 2,
				status: "available",
				usageBytes: 1,
			});
		}
	);

	it("calls each inspection method at most once, in order, and never requests persistence", async () => {
		const calls: string[] = [];
		const report = await capacity.inspectStorageCapability({
			estimate: async () => {
				calls.push("estimate");
				return { quota: 10, usage: 3 };
			},
			persist: () => {
				calls.push("persist");
				throw new Error("inspection requested persistence");
			},
			persisted: async () => {
				calls.push("persisted");
				return false;
			},
		});
		expect(calls).toEqual(["persisted", "estimate"]);
		expect(report.persistence).toEqual({ status: "not-granted" });
	});

	it.each([
		{ expected: "incomplete", label: "null result", result: null },
		{ expected: "incomplete", label: "primitive result", result: 1 },
		{ expected: "incomplete", label: "missing both", result: {} },
		{ expected: "incomplete", label: "missing usage", result: { quota: 5 } },
		{ expected: "incomplete", label: "missing quota", result: { usage: 1 } },
		{
			expected: "incomplete",
			label: "inherited fields",
			result: Object.create({ quota: 5, usage: 1 }) as unknown,
		},
		{ expected: "unsafe", label: "negative usage", result: { quota: 5, usage: -1 } },
		{ expected: "unsafe", label: "negative quota", result: { quota: -1, usage: 0 } },
		{ expected: "unsafe", label: "fractional usage", result: { quota: 5, usage: 0.5 } },
		{ expected: "unsafe", label: "fractional quota", result: { quota: 5.5, usage: 1 } },
		{ expected: "unsafe", label: "NaN", result: { quota: Number.NaN, usage: 1 } },
		{ expected: "unsafe", label: "infinity", result: { quota: Number.POSITIVE_INFINITY, usage: 1 } },
		{ expected: "unsafe", label: "unsafe integer", result: { quota: Number.MAX_SAFE_INTEGER + 1, usage: 1 } },
		{ expected: "unsafe", label: "numeric text", result: { quota: "5", usage: "1" } },
		{ expected: "unsafe", label: "own undefined fields", result: { quota: undefined, usage: undefined } },
		{ expected: "inconsistent", label: "usage exceeds quota", result: { quota: 4, usage: 5 } },
	] as const)("classifies an estimate with $label", async ({ expected, result }) => {
		const report = await capacity.inspectStorageCapability({ estimate: () => result });
		expect(report).toEqual({
			persistence: { status: "unsupported" },
			quota: { reason: expected, status: "unavailable" },
		});
		expectClosedFrozen(report);
	});

	it.each([
		{
			estimate: () => {
				throw new Error("estimate-sync");
			},
			label: "sync throw",
		},
		{ estimate: () => rejection("estimate-async"), label: "rejection" },
	] as const)("contains an estimate $label", async ({ estimate }) => {
		const report = await capacity.inspectStorageCapability({ estimate });
		expect(report.quota).toEqual({ reason: "exception", status: "unavailable" });
	});

	it("contains a returned estimate accessor exception instead of leaking it", async () => {
		const report = await capacity.inspectStorageCapability({
			estimate: () =>
				Object.defineProperty({ quota: 4 }, "usage", {
					enumerable: true,
					get: () => {
						throw new Error("hostile usage getter");
					},
				}),
		});
		expect(report.quota).toEqual({ reason: "exception", status: "unavailable" });
	});

	it("does not coerce estimate fields or retain the mutable response", async () => {
		let coercions = 0;
		const hostile = {
			quota: {
				valueOf: () => {
					coercions += 1;
					return 8;
				},
			},
			usage: {
				valueOf: () => {
					coercions += 1;
					return 3;
				},
			},
		};
		const report = await capacity.inspectStorageCapability({ estimate: () => hostile });
		hostile.quota = { valueOf: () => 100 };
		expect(coercions).toBe(0);
		expect(report.quota).toEqual({ reason: "unsafe", status: "unavailable" });
	});
});

describe("Phase 2g-a explicit persistence request RED", () => {
	it.each([
		{ expected: { status: "unsupported" }, label: "missing methods", port: {} },
		{ expected: { status: "unsupported" }, label: "non-callable methods", port: { persist: 1, persisted: false } },
		{
			expected: { status: "already-granted" },
			label: "already granted",
			port: {
				persist: () => {
					throw new Error("must skip");
				},
				persisted: () => true,
			},
		},
		{ expected: { status: "granted" }, label: "explicit grant", port: { persist: () => true, persisted: () => false } },
		{
			expected: { status: "denied" },
			label: "explicit denial",
			port: { persist: () => false, persisted: () => false },
		},
		{ expected: { status: "granted" }, label: "lone persist grant", port: { persist: () => true } },
		{ expected: { status: "denied" }, label: "lone persist denial", port: { persist: () => false } },
		{
			expected: { status: "granted" },
			label: "non-callable persisted plus usable persist",
			port: { persist: () => true, persisted: "not-callable" },
		},
		{ expected: { status: "unsupported" }, label: "false then absent persist", port: { persisted: () => false } },
		{
			expected: { status: "unsupported" },
			label: "false then non-callable persist",
			port: { persist: 1, persisted: () => false },
		},
	] as const)("returns a positive closed result for $label", async ({ expected, port }) => {
		const result = await capacity.requestPersistentStorage(port as TestStorageCapacityPort);
		expect(result).toEqual(expected);
		expectClosedFrozen(result);
	});

	it.each([
		{
			label: "sync throw",
			persisted: () => {
				throw new Error("persisted-sync");
			},
		},
		{ label: "rejection", persisted: () => rejection("persisted-async") },
	] as const)("does not request after persisted $label", async ({ persisted }) => {
		const calls: string[] = [];
		const result = await capacity.requestPersistentStorage({
			persist: () => {
				calls.push("persist");
				return true;
			},
			persisted: () => {
				calls.push("persisted");
				return persisted();
			},
		});
		expect(result).toEqual({ reason: "exception", status: "unavailable" });
		expect(calls).toEqual(["persisted"]);
	});

	it.each([undefined, null, 0, 1, "false", {}, []])(
		"does not request after a non-boolean persisted response: %j",
		async (response) => {
			let persistCalls = 0;
			const result = await capacity.requestPersistentStorage({
				persist: () => {
					persistCalls += 1;
					return true;
				},
				persisted: () => response,
			});
			expect(result).toEqual({ reason: "invalid-response", status: "unavailable" });
			expect(persistCalls).toBe(0);
		}
	);

	it.each([
		{
			label: "sync throw",
			persist: () => {
				throw new Error("persist-sync");
			},
			reason: "exception",
		},
		{ label: "rejection", persist: () => rejection("persist-async"), reason: "exception" },
		{ label: "undefined", persist: () => undefined, reason: "invalid-response" },
		{ label: "non-boolean", persist: () => "yes", reason: "invalid-response" },
	] as const)("contains a persist $label", async ({ persist, reason }) => {
		const result = await capacity.requestPersistentStorage({ persist, persisted: () => false });
		expect(result).toEqual({ reason, status: "unavailable" });
	});

	it("calls persisted before persist and calls each at most once", async () => {
		const calls: string[] = [];
		const result = await capacity.requestPersistentStorage({
			persist: async () => {
				calls.push("persist");
				return true;
			},
			persisted: async () => {
				calls.push("persisted");
				return false;
			},
		});
		expect(result).toEqual({ status: "granted" });
		expect(calls).toEqual(["persisted", "persist"]);
	});
});

describe("Phase 2g-a public neutral surface RED", () => {
	it("switches the permissive scaffold to supplied implementations instead of masking them", async () => {
		const calls: string[] = [];
		const selected = selectCapacityApi({
			inspectStorageCapability: async () => {
				calls.push("real-inspect");
				return Object.freeze({
					persistence: Object.freeze({ status: "granted" }),
					quota: Object.freeze({ availableBytes: 1, quotaBytes: 1, status: "available", usageBytes: 0 }),
				});
			},
			requestPersistentStorage: async () => {
				calls.push("real-request");
				return Object.freeze({ status: "denied" });
			},
		});
		expect(await selected.inspectStorageCapability({})).toMatchObject({ persistence: { status: "granted" } });
		expect(await selected.requestPersistentStorage({})).toEqual({ status: "denied" });
		expect(calls).toEqual(["real-inspect", "real-request"]);
	});

	it("keeps capacity at the existing root only and exposes the two real implementations", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIRECTORY, "package.json"), "utf8")) as {
			exports?: Record<string, unknown>;
		};
		expect.soft(Object.keys(manifest.exports ?? {})).toEqual([".", "./contract", "./adapter"]);
		expect.soft(fs.existsSync(path.join(PACKAGE_DIRECTORY, "src/capacity.ts"))).toBe(true);
		expect.soft(adapter).not.toHaveProperty("inspectStorageCapability");
		expect.soft(adapter).not.toHaveProperty("requestPersistentStorage");
		expect.soft(contract).not.toHaveProperty("inspectStorageCapability");
		expect.soft(contract).not.toHaveProperty("requestPersistentStorage");
		expect.soft(storageModule.inspectStorageCapability).toBeTypeOf("function");
		expect.soft(storageModule.requestPersistentStorage).toBeTypeOf("function");
		const capacitySource = path.join(PACKAGE_DIRECTORY, "src/capacity.ts");
		if (fs.existsSync(capacitySource)) {
			const source = fs.readFileSync(capacitySource, "utf8");
			expect
				.soft(source)
				.not.toMatch(
					/\b(?:incognito|private[-_ ]?mode|userAgent|quota[-_ ]?threshold|browser[-_ ]?brand|signer|authorization)\b/iu
				);
		}
	});

	it("ships the exact closed capacity types and signatures to a packed consumer", () => {
		const consumerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2g-a-storage-consumer-"));
		try {
			execFileSync("pnpm", ["--dir", PACKAGE_DIRECTORY, "build"], {
				cwd: WORKSPACE_DIRECTORY,
				stdio: "pipe",
			});
			const packed = JSON.parse(
				execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", consumerDirectory], {
					cwd: PACKAGE_DIRECTORY,
					encoding: "utf8",
				})
			) as readonly Readonly<{ filename: string }>[];
			const packageDirectory = path.join(consumerDirectory, "node_modules/@ts-drp/storage");
			fs.mkdirSync(packageDirectory, { recursive: true });
			execFileSync(
				"tar",
				[
					"-xzf",
					path.join(consumerDirectory, packed[0]?.filename ?? "missing.tgz"),
					"--strip-components=1",
					"-C",
					packageDirectory,
				],
				{ stdio: "pipe" }
			);
			fs.writeFileSync(
				path.join(consumerDirectory, "consumer.ts"),
				`import {
	type PersistenceObservation,
	type PersistenceRequestResult,
	type QuotaObservation,
	type StorageCapabilityReport,
	type StorageCapacityPort,
	inspectStorageCapability,
	requestPersistentStorage,
} from "@ts-drp/storage";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Port = Readonly<{ persisted?: () => unknown; persist?: () => unknown; estimate?: () => unknown }>;
type Persistence =
	| Readonly<{ status: "unsupported" }>
	| Readonly<{ status: "granted" }>
	| Readonly<{ status: "not-granted" }>
	| Readonly<{ status: "unavailable"; reason: "exception" | "invalid-response" }>;
type Quota =
	| Readonly<{ status: "available"; usageBytes: number; quotaBytes: number; availableBytes: number }>
	| Readonly<{ status: "unavailable"; reason: "unsupported" | "exception" | "incomplete" | "unsafe" | "inconsistent" }>;
type Report = Readonly<{ persistence: Persistence; quota: Quota }>;
type Request =
	| Readonly<{ status: "already-granted" | "granted" | "denied" | "unsupported" }>
	| Readonly<{ status: "unavailable"; reason: "exception" | "invalid-response" }>;
type _Port = Expect<Equal<StorageCapacityPort, Port>>;
type _Persistence = Expect<Equal<PersistenceObservation, Persistence>>;
type _Quota = Expect<Equal<QuotaObservation, Quota>>;
type _Report = Expect<Equal<StorageCapabilityReport, Report>>;
type _Request = Expect<Equal<PersistenceRequestResult, Request>>;
const inspect: (port: Port) => Promise<Report> = inspectStorageCapability;
const request: (port: Port) => Promise<Request> = requestPersistentStorage;
void [inspect, request];
`
			);
			fs.writeFileSync(
				path.join(consumerDirectory, "tsconfig.json"),
				`${JSON.stringify(
					{
						compilerOptions: {
							lib: ["ES2023"],
							module: "NodeNext",
							moduleResolution: "NodeNext",
							noEmit: true,
							skipLibCheck: false,
							strict: true,
							target: "ES2023",
							types: [],
						},
						files: ["./consumer.ts"],
					},
					undefined,
					"\t"
				)}\n`
			);
			const compilation = spawnSync(
				"pnpm",
				["exec", "tsc", "--project", path.join(consumerDirectory, "tsconfig.json"), "--pretty", "false"],
				{
					cwd: WORKSPACE_DIRECTORY,
					encoding: "utf8",
				}
			);
			if (compilation.error) throw compilation.error;
			const diagnostics = `${compilation.stdout}${compilation.stderr}`.trim();
			expect(compilation.status, diagnostics).toBe(0);
			expect(diagnostics).toBe("");
		} finally {
			fs.rmSync(consumerDirectory, { force: true, recursive: true });
		}
	});
});
