import {
	AddressPolicy,
	type AdmissionCredential,
	type ClientRegistrationReceipt,
	type RecordValidator,
	type Resolver,
	type SignedDrpRecordV1,
	type ValidatedDrpRecord,
} from "@ts-drp/rendezvous";
import { describe, expect, it, vi } from "vitest";

import { fixtureInput, fixtureSigner, NAMESPACE, validator } from "./fixtures.js";

interface DirectoryLike {
	discover(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]>;
	register(
		record: SignedDrpRecordV1,
		signal: AbortSignal,
		credential?: AdmissionCredential
	): Promise<ClientRegistrationReceipt>;
}

interface PeerCacheLike {
	put(record: ValidatedDrpRecord | SignedDrpRecordV1): Promise<void>;
	list(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]>;
	prune(): Promise<void>;
}

interface BootstrapEnsemble extends DirectoryLike {
	bootstrap(namespace: string, signal: AbortSignal): AsyncIterable<ValidatedDrpRecord>;
	readonly lastTrace:
		| {
				readonly sources: ReadonlyArray<{
					readonly id: "cache" | "dht-anchor" | "invite" | "peer-exchange" | "registries";
					readonly status: "empty" | "failed" | "succeeded";
				}>;
		  }
		| undefined;
}

interface BootstrapOptions {
	readonly addressPolicy: { readonly policy: AddressPolicy; readonly resolver: Resolver };
	readonly anchors?: {
		readonly resolver: {
			resolve(
				namespace: string,
				signal: AbortSignal,
				maxResults?: number
			): Promise<{ readonly records: readonly unknown[] }>;
		};
	};
	readonly cache?: PeerCacheLike;
	readonly invite?: DirectoryLike;
	readonly limits?: { readonly maxRecordsPerSource?: number; readonly timeoutMs?: number };
	readonly peerExchange?: DirectoryLike;
	readonly registries?: DirectoryLike;
	validatorFactory?(): RecordValidator;
}

interface PhaseFourBootstrapModule {
	createRendezvousEnsemble(options: BootstrapOptions): BootstrapEnsemble;
}

const PUBLIC_RESOLVER: Resolver = { resolve: () => Promise.resolve(["93.184.216.34"]) };

describe("Phase 4b ensemble bootstrap and restart ordering", () => {
	it("yields cached peers before a slow registry can reach the parent deadline", async () => {
		const createEnsemble = await loadBootstrapFactory();
		if (createEnsemble === undefined) return;
		const cached = validated(await freshRecord(601), "cache");
		const cache = memoryCache([cached]);
		const registryStarted = vi.fn();
		const ensemble = createEnsemble(
			options({
				cache,
				limits: { timeoutMs: 1_000 },
				registries: directory((_namespace, signal) => {
					registryStarted();
					return new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				}),
			})
		);
		const controller = new AbortController();
		const iterator = bootstrapOf(ensemble, controller.signal)[Symbol.asyncIterator]();
		const startedAt = performance.now();

		await expect(iterator.next()).resolves.toMatchObject({
			done: false,
			value: { record: { peerId: cached.record.peerId } },
		});
		expect(performance.now() - startedAt).toBeLessThan(100);
		expect(registryStarted).toHaveBeenCalledOnce();
		controller.abort(new Error("fixture complete"));
		await iterator.return?.();
	});

	it("revalidates network results and writes every authenticated peer back to the cache", async () => {
		const createEnsemble = await loadBootstrapFactory();
		if (createEnsemble === undefined) return;
		const good = await freshRecord(602);
		const bad = { ...good, signature: mutate(good.signature) };
		const cache = memoryCache();
		const ensemble = createEnsemble(
			options({
				cache,
				registries: directory(() => Promise.resolve([validated(bad), validated(good)])),
			})
		);

		const bootstrapped = await collect(bootstrapOf(ensemble));
		expect(bootstrapped).toMatchObject([{ record: { peerId: good.peerId } }]);
		expect(cache.put).toHaveBeenCalledOnce();
		expect(await cache.list(NAMESPACE, AbortSignal.timeout(100))).toMatchObject([{ record: { peerId: good.peerId } }]);
	});

	it("uses a warm cache on the next restart when every network source is down", async () => {
		const createEnsemble = await loadBootstrapFactory();
		if (createEnsemble === undefined) return;
		const record = await freshRecord(603);
		const cache = memoryCache();
		let online = true;
		const registries = directory(() =>
			online ? Promise.resolve([validated(record)]) : Promise.reject(new Error("registry offline"))
		);
		const anchors = {
			resolver: {
				resolve: (): Promise<{ readonly records: readonly unknown[] }> =>
					online ? Promise.resolve({ records: [] }) : Promise.reject(new Error("DHT anchor routing offline")),
			},
		};
		const ensemble = createEnsemble(options({ anchors, cache, registries }));

		expect(await collect(bootstrapOf(ensemble))).toMatchObject([{ record: { peerId: record.peerId } }]);
		online = false;
		expect(await collect(bootstrapOf(ensemble))).toMatchObject([{ record: { peerId: record.peerId } }]);
		expect(ensemble.lastTrace?.sources).toEqual(
			expect.arrayContaining([
				{ id: "cache", status: "succeeded" },
				{ id: "registries", status: "failed" },
				{ id: "dht-anchor", status: "failed" },
			])
		);
	});

	it("throws typed exhausted only when every source fails and the cache is empty", async () => {
		const createEnsemble = await loadBootstrapFactory();
		if (createEnsemble === undefined) return;
		const failed = directory(() => Promise.reject(new Error("offline")));
		const ensemble = createEnsemble(
			options({
				anchors: { resolver: { resolve: () => Promise.reject(new Error("offline")) } },
				cache: memoryCache(),
				invite: failed,
				peerExchange: failed,
				registries: failed,
			})
		);

		await expect(collect(bootstrapOf(ensemble))).rejects.toMatchObject({
			failedSourceIds: ["registries", "dht-anchor", "invite", "peer-exchange"],
			name: "RendezvousExhaustedError",
			operation: "bootstrap",
		});
	});

	it("returns a clean empty result when an empty cache and every network source succeed empty", async () => {
		const createEnsemble = await loadBootstrapFactory();
		if (createEnsemble === undefined) return;
		const ensemble = createEnsemble(
			options({
				anchors: { resolver: { resolve: () => Promise.resolve({ records: [] }) } },
				cache: memoryCache(),
				invite: directory(() => Promise.resolve([])),
				peerExchange: directory(() => Promise.resolve([])),
				registries: directory(() => Promise.resolve([])),
			})
		);

		await expect(collect(bootstrapOf(ensemble))).resolves.toEqual([]);
		expect(ensemble.lastTrace?.sources).toEqual(
			expect.arrayContaining([
				{ id: "cache", status: "empty" },
				{ id: "registries", status: "empty" },
				{ id: "dht-anchor", status: "empty" },
				{ id: "invite", status: "empty" },
				{ id: "peer-exchange", status: "empty" },
			])
		);
	});

	it("starts authenticated GossipSub peer exchange only after registry, anchor, and invite bootstrap settle", async () => {
		const createEnsemble = await loadBootstrapFactory();
		if (createEnsemble === undefined) return;
		let releaseInitial!: () => void;
		const initialSettled = new Promise<void>((resolve) => {
			releaseInitial = resolve;
		});
		const peer = await freshRecord(604);
		const peerExchangeDiscover = vi.fn(() => Promise.resolve([validated(peer, "peer-exchange")]));
		const ensemble = createEnsemble(
			options({
				anchors: {
					resolver: { resolve: async () => (await initialSettled, { records: [] }) },
				},
				cache: memoryCache(),
				invite: directory(async () => (await initialSettled, [])),
				peerExchange: directory(peerExchangeDiscover),
				registries: directory(async () => (await initialSettled, [])),
			})
		);
		const iterator = bootstrapOf(ensemble)[Symbol.asyncIterator]();
		const first = iterator.next();
		await Promise.resolve();
		await Promise.resolve();
		expect(peerExchangeDiscover).not.toHaveBeenCalled();

		releaseInitial();
		await expect(first).resolves.toMatchObject({ done: false, value: { record: { peerId: peer.peerId } } });
		expect(peerExchangeDiscover).toHaveBeenCalledOnce();
		await iterator.return?.();
	});
});

async function loadBootstrapFactory(): Promise<PhaseFourBootstrapModule["createRendezvousEnsemble"] | undefined> {
	const loaded = (await import("@ts-drp/rendezvous")) as unknown as Partial<PhaseFourBootstrapModule>;
	expect(loaded.createRendezvousEnsemble).toBeTypeOf("function");
	return loaded.createRendezvousEnsemble;
}

function bootstrapOf(
	ensemble: BootstrapEnsemble,
	signal = AbortSignal.timeout(500)
): AsyncIterable<ValidatedDrpRecord> {
	expect(ensemble.bootstrap, "Phase 4b ensembles must expose streaming bootstrap()").toBeTypeOf("function");
	return ensemble.bootstrap(NAMESPACE, signal);
}

async function collect(records: AsyncIterable<ValidatedDrpRecord>): Promise<readonly ValidatedDrpRecord[]> {
	const collected: ValidatedDrpRecord[] = [];
	for await (const record of records) collected.push(record);
	return collected;
}

function memoryCache(initial: readonly ValidatedDrpRecord[] = []): PeerCacheLike & { put: ReturnType<typeof vi.fn> } {
	const records = new Map(initial.map((entry) => [`${entry.record.namespace}\0${entry.record.peerId}`, entry]));
	const put = vi.fn((input: ValidatedDrpRecord | SignedDrpRecordV1): Promise<void> => {
		const entry = "record" in input ? input : validated(input, "cache-write");
		records.set(`${entry.record.namespace}\0${entry.record.peerId}`, entry);
		return Promise.resolve();
	});
	return {
		list: (namespace, signal): Promise<readonly ValidatedDrpRecord[]> => {
			signal.throwIfAborted();
			return Promise.resolve([...records.values()].filter(({ record }) => record.namespace === namespace));
		},
		prune: () => Promise.resolve(),
		put,
	};
}

function directory(discover: DirectoryLike["discover"]): DirectoryLike {
	return {
		discover,
		register: () => Promise.reject(new Error("registration unavailable")),
	};
}

function options(overrides: Partial<BootstrapOptions>): BootstrapOptions {
	return {
		addressPolicy: { policy: new AddressPolicy({ target: "node" }), resolver: PUBLIC_RESOLVER },
		limits: { maxRecordsPerSource: 16, timeoutMs: 250 },
		validatorFactory: () => validator(() => Date.now()),
		...overrides,
	};
}

function validated(record: SignedDrpRecordV1, sourceEndpointId = "registry-a"): ValidatedDrpRecord {
	return { admissionMode: "invite", record, sourceEndpointId };
}

async function freshRecord(index: number): Promise<SignedDrpRecordV1> {
	const issuedAtMs = Date.now();
	const { peerId, signer } = await fixtureSigner(index);
	return signer.sign(
		fixtureInput(peerId, {
			addresses: [`/ip4/93.184.216.34/tcp/443/wss/p2p/${peerId}`],
			expiresAtMs: issuedAtMs + 60_000,
			issuedAtMs,
		})
	);
}

function mutate(value: string): string {
	return `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
}
