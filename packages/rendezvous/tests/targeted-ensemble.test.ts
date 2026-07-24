import {
	AddressPolicy,
	createRendezvousEnsemble,
	type PeerCache,
	type RegistryBackendSelection,
	type RendezvousDirectory,
	type SignedDrpRecordV1,
	type ValidatedDrpRecord,
} from "@ts-drp/rendezvous";
import { describe, expect, it, vi } from "vitest";

import { fixtureInput, fixtureSigner, NAMESPACE, validator } from "./fixtures.js";

const resolver = { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) };

describe("RendezvousEnsemble targeted discovery", () => {
	it("filters cache and registry bootstrap emissions while writing the target's network record back", async () => {
		const targetV1 = await freshRecord(1_300);
		const targetV2 = await freshRecord(1_300, { sequence: 2 });
		const otherV1 = await freshRecord(1_301);
		const otherV2 = await freshRecord(1_301, { sequence: 2 });
		const cache = memoryCache([validated(targetV1, "cache"), validated(otherV1, "cache")]);
		const registries = directory(() =>
			Promise.resolve([validated(targetV2, "registry-a"), validated(otherV2, "registry-a")])
		);
		const ensemble = createRendezvousEnsemble(options({ cache, registries }));

		const bootstrapped = await collect(ensemble.bootstrap(NAMESPACE, signal(), { targetPeerId: targetV1.peerId }));

		expect(bootstrapped.map(({ record }) => [record.peerId, record.sequence])).toEqual([
			[targetV1.peerId, 1],
			[targetV1.peerId, 2],
		]);
		expect(cache.put).toHaveBeenCalledOnce();
		expect(cache.put).toHaveBeenCalledWith(
			expect.objectContaining({ record: expect.objectContaining({ peerId: targetV1.peerId, sequence: 2 }) })
		);
	});

	it("filters the reconciled discover return while forwarding the target selection to registries", async () => {
		const target = await freshRecord(1_310);
		const other = await freshRecord(1_311);
		const discover = vi.fn(
			(
				_namespace: string,
				_signal: AbortSignal,
				_selection?: RegistryBackendSelection
			): Promise<readonly ValidatedDrpRecord[]> => Promise.resolve([validated(target), validated(other)])
		);
		const ensemble = createRendezvousEnsemble(options({ registries: directory(discover) }));

		const records = await ensemble.discover(NAMESPACE, signal(), { targetPeerId: target.peerId });

		expect(records.map(({ record }) => record.peerId)).toEqual([target.peerId]);
		expect(discover).toHaveBeenCalledWith(
			NAMESPACE,
			expect.any(AbortSignal),
			expect.objectContaining({ targetPeerId: target.peerId })
		);
	});

	it("treats an absent target as a successful empty bootstrap instead of exhaustion", async () => {
		const available = await freshRecord(1_320);
		const absent = await freshRecord(1_321);
		const ensemble = createRendezvousEnsemble(
			options({
				registries: directory(() => Promise.resolve([validated(available)])),
			})
		);

		await expect(collect(ensemble.bootstrap(NAMESPACE, signal(), { targetPeerId: absent.peerId }))).resolves.toEqual(
			[]
		);
	});
});

function options(
	overrides: Partial<Parameters<typeof createRendezvousEnsemble>[0]>
): Parameters<typeof createRendezvousEnsemble>[0] {
	return {
		addressPolicy: { policy: new AddressPolicy({ target: "node" }), resolver },
		limits: { maxRecordsPerSource: 16, timeoutMs: 1_000 },
		validatorFactory: () => validator(() => Date.now()),
		...overrides,
	};
}

function directory(discover: RendezvousDirectory["discover"]): RendezvousDirectory {
	return {
		discover,
		register: () => Promise.reject(new Error("registration unavailable")),
	};
}

function memoryCache(initial: readonly ValidatedDrpRecord[]): PeerCache & { readonly put: ReturnType<typeof vi.fn> } {
	const records = new Map(initial.map((entry) => [entry.record.peerId, entry]));
	const put = vi.fn((input: ValidatedDrpRecord | SignedDrpRecordV1): Promise<void> => {
		const entry = "record" in input ? input : validated(input, "cache-write");
		records.set(entry.record.peerId, entry);
		return Promise.resolve();
	});
	return {
		list: (namespace, operationSignal): Promise<readonly ValidatedDrpRecord[]> => {
			operationSignal.throwIfAborted();
			return Promise.resolve([...records.values()].filter(({ record }) => record.namespace === namespace));
		},
		prune: () => Promise.resolve(),
		put,
	};
}

async function freshRecord(
	index: number,
	overrides: Partial<Parameters<typeof fixtureInput>[1]> = {}
): Promise<SignedDrpRecordV1> {
	const issuedAtMs = Date.now() + ((overrides.sequence ?? 1) - 1) * 1_000;
	const { peerId, signer } = await fixtureSigner(index);
	return signer.sign(
		fixtureInput(peerId, {
			addresses: [`/ip4/93.184.216.34/tcp/443/wss/p2p/${peerId}`],
			expiresAtMs: issuedAtMs + 60_000,
			issuedAtMs,
			...overrides,
		})
	);
}

function validated(record: SignedDrpRecordV1, sourceEndpointId = "registry-a"): ValidatedDrpRecord {
	return { admissionMode: "invite", record, sourceEndpointId };
}

async function collect(records: AsyncIterable<ValidatedDrpRecord>): Promise<readonly ValidatedDrpRecord[]> {
	const collected: ValidatedDrpRecord[] = [];
	for await (const record of records) collected.push(record);
	return collected;
}

function signal(): AbortSignal {
	return new AbortController().signal;
}
