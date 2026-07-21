import {
	AddressPolicy,
	type AdmissionCredential,
	type ClientRegistrationReceipt,
	type Resolver,
	type SignedDrpRecordV1,
	type ValidatedDrpRecord,
} from "@ts-drp/rendezvous";
import { describe, expect, it, vi } from "vitest";

import { NAMESPACE, signedFixture } from "./fixtures.js";

interface DirectoryLike {
	discover(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]>;
	register(
		record: SignedDrpRecordV1,
		signal: AbortSignal,
		credential?: AdmissionCredential
	): Promise<ClientRegistrationReceipt>;
}

interface AnchorRecordResolution {
	readonly records: readonly unknown[];
}

interface AnchorRecordResolver {
	resolve(namespace: string, signal: AbortSignal, maxResults?: number): Promise<AnchorRecordResolution>;
}

interface EnsembleTrace {
	readonly policyRejectedAddressCount: number;
	readonly recordRejectedCount: number;
	readonly sources: ReadonlyArray<{
		readonly id: "dht-anchor" | "registries";
		readonly status: "empty" | "failed" | "succeeded";
	}>;
}

interface EnsembleDirectory extends DirectoryLike {
	readonly lastTrace: EnsembleTrace | undefined;
}

interface EnsembleOptions {
	readonly addressPolicy: {
		readonly policy: AddressPolicy;
		readonly resolver: Resolver;
	};
	readonly anchors?: { readonly resolver: AnchorRecordResolver };
	readonly limits?: { readonly maxRecordsPerSource?: number; readonly timeoutMs?: number };
	readonly registries?: DirectoryLike;
}

interface PhaseFourEnsembleModule {
	createRendezvousEnsemble(options: EnsembleOptions): EnsembleDirectory;
}

const PUBLIC_RESOLVER: Resolver = { resolve: () => Promise.resolve(["93.184.216.34"]) };

describe("Phase 4a rendezvous ensemble", () => {
	it("queries registries and signed-record anchors in parallel and reconciles their union", async () => {
		const createEnsemble = await loadEnsembleFactory();
		if (createEnsemble === undefined) return;
		const registryRecord = await freshFixture(301);
		const anchorRecord = await freshFixture(302);
		const started = new Set<string>();
		let release!: () => void;
		const bothStarted = new Promise<void>((resolve) => {
			release = resolve;
		});
		const markStarted = (source: string): void => {
			started.add(source);
			if (started.size === 2) release();
		};
		const registries = directory(async () => {
			markStarted("registries");
			await bothStarted;
			return [validated(registryRecord, "registry-a")];
		});
		const resolver: AnchorRecordResolver = {
			resolve: async () => {
				markStarted("dht-anchor");
				await bothStarted;
				return { records: [validated(anchorRecord, "anchor-a")] };
			},
		};
		const ensemble = createEnsemble(options({ anchors: { resolver }, registries }));

		const records = await ensemble.discover(NAMESPACE, AbortSignal.timeout(250));
		expect(records.map(({ record }) => record.peerId).sort()).toEqual(
			[registryRecord.peerId, anchorRecord.peerId].sort()
		);
		expect(ensemble.lastTrace?.sources).toEqual([
			{ id: "registries", status: "succeeded" },
			{ id: "dht-anchor", status: "succeeded" },
		]);
	});

	it("continues from anchors when every registry endpoint is unavailable", async () => {
		const createEnsemble = await loadEnsembleFactory();
		if (createEnsemble === undefined) return;
		const anchorRecord = await freshFixture(303);
		const ensemble = createEnsemble(
			options({
				anchors: {
					resolver: {
						resolve: () => Promise.resolve({ records: [validated(anchorRecord, "anchor-a")] }),
					},
				},
				registries: directory(() => Promise.reject(new Error("registries offline"))),
			})
		);

		expect(await ensemble.discover(NAMESPACE, AbortSignal.timeout(100))).toMatchObject([
			{ record: { peerId: anchorRecord.peerId } },
		]);
		expect(ensemble.lastTrace?.sources).toEqual([
			{ id: "registries", status: "failed" },
			{ id: "dht-anchor", status: "succeeded" },
		]);
	});

	it("revalidates untrusted anchor records and counts signature and namespace rejections", async () => {
		const createEnsemble = await loadEnsembleFactory();
		if (createEnsemble === undefined) return;
		const valid = await freshFixture(310);
		const invalidSignature = { ...valid, signature: mutate(valid.signature) };
		const wrongNamespace = await freshFixture(311, { namespace: `drp-network:v1:${"b".repeat(43)}` });
		const ensemble = createEnsemble(
			options({
				anchors: {
					resolver: {
						resolve: () =>
							Promise.resolve({
								records: [
									validated(invalidSignature, "anchor-a"),
									validated(wrongNamespace, "anchor-a"),
									validated(valid, "anchor-a"),
								],
							}),
					},
				},
			})
		);

		expect(await ensemble.discover(NAMESPACE, AbortSignal.timeout(100))).toMatchObject([
			{ record: { peerId: valid.peerId }, sourceEndpointId: "dht-anchor" },
		]);
		expect(ensemble.lastTrace).toMatchObject({
			recordRejectedCount: 2,
			sources: [{ id: "dht-anchor", status: "succeeded" }],
		});
	});

	it("throws a typed exhausted error naming every failed source", async () => {
		const createEnsemble = await loadEnsembleFactory();
		if (createEnsemble === undefined) return;
		const ensemble = createEnsemble(
			options({
				anchors: { resolver: { resolve: () => Promise.reject(new Error("anchor offline")) } },
				registries: directory(() => Promise.reject(new Error("registries offline"))),
			})
		);

		await expect(ensemble.discover(NAMESPACE, AbortSignal.timeout(100))).rejects.toMatchObject({
			failedSourceIds: ["registries", "dht-anchor"],
			name: "RendezvousExhaustedError",
			operation: "discover",
		});
	});

	it("does not let a slow source extend discovery beyond one parent deadline", async () => {
		const createEnsemble = await loadEnsembleFactory();
		if (createEnsemble === undefined) return;
		const slowResolver: AnchorRecordResolver = {
			resolve: (_namespace, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		};
		const ensemble = createEnsemble(
			options({
				anchors: { resolver: slowResolver },
				limits: { maxRecordsPerSource: 16, timeoutMs: 5_000 },
				registries: directory(() => Promise.reject(new Error("registries offline"))),
			})
		);
		const startedAt = performance.now();

		await expect(ensemble.discover(NAMESPACE, AbortSignal.timeout(25))).rejects.toMatchObject({
			name: "RendezvousExhaustedError",
		});
		expect(performance.now() - startedAt).toBeLessThan(250);
	});

	it("bounds each source independently without discarding another source's valid results", async () => {
		const createEnsemble = await loadEnsembleFactory();
		if (createEnsemble === undefined) return;
		const registryRecords = [await freshFixture(307), await freshFixture(308)];
		const anchorRecord = await freshFixture(309);
		const ensemble = createEnsemble(
			options({
				anchors: {
					resolver: {
						resolve: () => Promise.resolve({ records: [validated(anchorRecord, "anchor-a")] }),
					},
				},
				limits: { maxRecordsPerSource: 1, timeoutMs: 100 },
				registries: directory(() => Promise.resolve(registryRecords.map((record) => validated(record)))),
			})
		);

		expect(await ensemble.discover(NAMESPACE, AbortSignal.timeout(100))).toMatchObject([
			{ record: { peerId: anchorRecord.peerId } },
		]);
		expect(ensemble.lastTrace?.sources).toEqual([
			{ id: "registries", status: "failed" },
			{ id: "dht-anchor", status: "succeeded" },
		]);
	});

	it("registers only through registries and preserves the registry receipt taxonomy", async () => {
		const createEnsemble = await loadEnsembleFactory();
		if (createEnsemble === undefined) return;
		const record = await freshFixture(304);
		const register = vi.fn(() =>
			Promise.resolve({
				acceptedEndpointIds: ["registry-b"],
				attempts: [
					{
						code: "endpoint-unavailable" as const,
						endpointId: "registry-a",
						operation: "register" as const,
						status: "rejected" as const,
					},
					{ endpointId: "registry-b", operation: "register" as const, status: "accepted" as const },
				],
				sequence: record.sequence,
			})
		);
		const registries = directory(() => Promise.resolve([]), register);
		const anchorResolve = vi.fn(() => Promise.resolve({ records: [] }));
		const ensemble = createEnsemble(options({ anchors: { resolver: { resolve: anchorResolve } }, registries }));

		await expect(
			ensemble.register(record, new AbortController().signal, { kind: "invite", token: "fixture-token-32-characters" })
		).resolves.toMatchObject({ acceptedEndpointIds: ["registry-b"], sequence: 1 });
		expect(register).toHaveBeenCalledOnce();
		expect(anchorResolve).not.toHaveBeenCalled();
	});

	it("filters addresses for the configured target, excludes all-rejected records, and counts them", async () => {
		const createEnsemble = await loadEnsembleFactory();
		if (createEnsemble === undefined) return;
		const accepted = await freshFixture(305, {
			addresses: ["/ip4/8.8.8.8/tcp/443/wss", "/ip4/10.0.0.8/tcp/443/wss"],
		});
		const rejected = await freshFixture(306, {
			addresses: ["/ip4/10.0.0.9/tcp/443/wss"],
		});
		const ensemble = createEnsemble(
			options({ registries: directory(() => Promise.resolve([validated(accepted), validated(rejected)])) })
		);

		const records = (await ensemble.discover(NAMESPACE, AbortSignal.timeout(100))) as readonly (ValidatedDrpRecord & {
			readonly acceptedAddresses: readonly string[];
		})[];
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			acceptedAddresses: ["/ip4/8.8.8.8/tcp/443/wss"],
			record: { peerId: accepted.peerId },
		});
		expect(ensemble.lastTrace?.policyRejectedAddressCount).toBe(2);

		// Phase 4b connection-auth integration applies membership after this admission seam.
	});
});

async function loadEnsembleFactory(): Promise<PhaseFourEnsembleModule["createRendezvousEnsemble"] | undefined> {
	const loaded = (await import("@ts-drp/rendezvous")) as unknown as Partial<PhaseFourEnsembleModule>;
	expect(loaded.createRendezvousEnsemble, "Phase 4a must export createRendezvousEnsemble").toBeTypeOf("function");
	return loaded.createRendezvousEnsemble;
}

function directory(
	discover: DirectoryLike["discover"],
	register: DirectoryLike["register"] = () => Promise.reject(new Error("registration unavailable"))
): DirectoryLike {
	return { discover, register };
}

function options(overrides: Partial<EnsembleOptions>): EnsembleOptions {
	return {
		addressPolicy: {
			policy: new AddressPolicy({ target: "browser" }),
			resolver: PUBLIC_RESOLVER,
		},
		...overrides,
	};
}

function validated(record: SignedDrpRecordV1, sourceEndpointId = "registry-a"): ValidatedDrpRecord {
	return { admissionMode: "invite", record, sourceEndpointId };
}

function freshFixture(
	index: number,
	overrides: Partial<Parameters<typeof signedFixture>[1]> = {}
): Promise<SignedDrpRecordV1> {
	const issuedAtMs = Date.now();
	return signedFixture(index, { expiresAtMs: issuedAtMs + 60_000, issuedAtMs, ...overrides });
}

function mutate(value: string): string {
	const last = value.at(-1);
	return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}
