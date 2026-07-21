import * as relayPolicy from "@ts-drp/relay-policy";
import { describe, expect, it, vi } from "vitest";

const QUERY = Uint8Array.from([1, 2, 3, 4]);

type PhaseFiveOrigin =
	| "browser-closest-peers"
	| "cached-relay"
	| "configured-fallback"
	| "dht-relay-provider"
	| "node-closest-peers"
	| "registry-relay-record";

type PhaseFiveRoutingSource = "configured" | "delegated-routing" | "peer-cache" | "public-dht" | "registry";

interface PhaseFiveCandidate {
	readonly addresses: readonly string[];
	readonly operatorEvidence?: {
		readonly credentialDigest: string;
		readonly operatorGroup: string;
		readonly verified: true;
	};
	readonly operatorGroup: string;
	readonly peerId: string;
	readonly protocols: readonly string[];
	readonly provenance: {
		readonly origin: PhaseFiveOrigin;
		readonly queryDigest: string;
		readonly resultIndex: number;
		readonly routingSource: PhaseFiveRoutingSource;
	};
}

interface PhaseFiveSource {
	getCandidates(queryKey: Uint8Array, signal: AbortSignal): AsyncIterable<PhaseFiveCandidate>;
}

interface CompositeSourceEntry {
	readonly enabled: boolean;
	readonly name: string;
	readonly priority: "overflow" | "primary";
	readonly source: PhaseFiveSource;
}

type CompositeRelayCandidateSourceConstructor = new (options: {
	readonly requiredOperatorGroups: number;
	readonly sources: readonly CompositeSourceEntry[];
}) => PhaseFiveSource;

describe("Phase 5 composite relay candidate source", () => {
	it("exhausts primary sources in priority order, deduplicates by peerId, and skips unnecessary overflow", async () => {
		const calls: string[] = [];
		const overflow = trackedSource("delegated", calls, [candidate("public-a", "public:a", "browser-closest-peers")]);
		const source = composite([
			{
				enabled: true,
				name: "configured-fallback",
				priority: "primary",
				source: trackedSource("configured", calls, [
					candidate("owned-a", "verified:owned-a", "configured-fallback"),
					candidate("shared", "verified:owned-a", "configured-fallback"),
				]).source,
			},
			{
				enabled: true,
				name: "registry-relay-records",
				priority: "primary",
				source: trackedSource("registry", calls, [
					candidate("shared", "verified:registry", "registry-relay-record"),
					candidate("registry-b", "verified:registry", "registry-relay-record"),
				]).source,
			},
			{ enabled: true, name: "delegated-closest-peers", priority: "overflow", source: overflow.source },
		]);

		const output = await collect(source);

		expect(output.map(({ peerId }) => peerId)).toEqual(["owned-a", "shared", "registry-b"]);
		expect(output.find(({ peerId }) => peerId === "shared")?.provenance.origin).toBe("configured-fallback");
		expect(calls).toEqual(["configured", "registry"]);
		expect(overflow.started).toHaveBeenCalledTimes(0);
	});

	it("consults overflow only after primaries are exhausted without enough diversity", async () => {
		const calls: string[] = [];
		const source = composite([
			{
				enabled: true,
				name: "configured-fallback",
				priority: "primary",
				source: trackedSource("configured", calls, [candidate("owned-a", "verified:owned", "configured-fallback")])
					.source,
			},
			{
				enabled: true,
				name: "registry-relay-records",
				priority: "primary",
				source: trackedSource("registry", calls, [candidate("registry-a", "verified:owned", "registry-relay-record")])
					.source,
			},
			{
				enabled: true,
				name: "dht-relay-providers",
				priority: "overflow",
				source: trackedSource("dht", calls, [candidate("public-b", "verified:community", "dht-relay-provider")]).source,
			},
		]);

		await expect(collect(source)).resolves.toMatchObject([
			{ peerId: "owned-a" },
			{ peerId: "registry-a" },
			{ peerId: "public-b" },
		]);
		expect(calls).toEqual(["configured", "registry", "dht"]);
	});

	it("consults overflow when primary candidates are unknown or carry only unattested advertised labels", async () => {
		const calls: string[] = [];
		const source = composite([
			{
				enabled: true,
				name: "registry-relay-records",
				priority: "primary",
				source: trackedSource("registry", calls, [
					candidate("registry-unknown", "unknown", "registry-relay-record"),
					candidate("registry-label", "advertised:different", "registry-relay-record"),
				]).source,
			},
			{
				enabled: true,
				name: "dht-relay-providers",
				priority: "overflow",
				source: trackedSource("dht", calls, [candidate("public-live", "unknown", "dht-relay-provider")]).source,
			},
		]);

		await expect(collect(source)).resolves.toMatchObject([
			{ peerId: "registry-unknown" },
			{ peerId: "registry-label" },
			{ peerId: "public-live" },
		]);
		expect(calls).toEqual(["registry", "dht"]);
	});

	it.each(["delegated-closest-peers", "dht-relay-providers", "registry-relay-records"])(
		"disables %s independently without disabling configured owned fallback",
		async (disabledName) => {
			const disabled = trackedSource(
				disabledName,
				[],
				[candidate(`disabled-${disabledName}`, "public", "dht-relay-provider")]
			);
			const source = composite([
				{
					enabled: true,
					name: "configured-fallback",
					priority: "primary",
					source: sourceOf([candidate("owned-floor", "verified:owned", "configured-fallback")]),
				},
				{
					enabled: false,
					name: disabledName,
					priority: disabledName === "registry-relay-records" ? "primary" : "overflow",
					source: disabled.source,
				},
			]);

			await expect(collect(source)).resolves.toMatchObject([{ peerId: "owned-floor" }]);
			expect(disabled.started).toHaveBeenCalledTimes(0);
		}
	);

	it("propagates AbortSignal cancellation into the active source and closes its iterator", async () => {
		const controller = new AbortController();
		let activeIterators = 0;
		let abortListeners = 0;
		const blockingSource: PhaseFiveSource = {
			async *getCandidates(_queryKey, signal): AsyncIterable<PhaseFiveCandidate> {
				activeIterators++;
				try {
					yield candidate("owned-a", "verified:owned", "configured-fallback");
					await new Promise<void>((resolve) => {
						const onAbort = (): void => {
							signal.removeEventListener("abort", onAbort);
							abortListeners--;
							resolve();
						};
						abortListeners++;
						signal.addEventListener("abort", onAbort, { once: true });
					});
					signal.throwIfAborted();
				} finally {
					activeIterators--;
				}
			},
		};
		const source = composite([
			{
				enabled: true,
				name: "configured-fallback",
				priority: "primary",
				source: blockingSource,
			},
		]);
		const iterator = source.getCandidates(QUERY, controller.signal)[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { peerId: "owned-a" } });
		controller.abort(new DOMException("test cancellation", "AbortError"));
		await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
		expect(activeIterators).toBe(0);
		expect(abortListeners).toBe(0);
	});
});

function composite(sources: readonly CompositeSourceEntry[]): PhaseFiveSource {
	const Constructor = (
		relayPolicy as unknown as { CompositeRelayCandidateSource?: CompositeRelayCandidateSourceConstructor }
	).CompositeRelayCandidateSource;
	expect(
		Constructor,
		"Phase 5 must export CompositeRelayCandidateSource as the single ordered source composer"
	).toBeTypeOf("function");
	if (Constructor === undefined) throw new Error("CompositeRelayCandidateSource is not exported");
	return new Constructor({ requiredOperatorGroups: 2, sources });
}

function trackedSource(
	name: string,
	calls: string[],
	candidates: readonly PhaseFiveCandidate[]
): { readonly source: PhaseFiveSource; readonly started: ReturnType<typeof vi.fn> } {
	const started = vi.fn();
	return {
		started,
		source: {
			async *getCandidates(): AsyncIterable<PhaseFiveCandidate> {
				started();
				calls.push(name);
				await Promise.resolve();
				yield* candidates;
			},
		},
	};
}

function sourceOf(candidates: readonly PhaseFiveCandidate[]): PhaseFiveSource {
	return {
		async *getCandidates(): AsyncIterable<PhaseFiveCandidate> {
			await Promise.resolve();
			yield* candidates;
		},
	};
}

async function collect(source: PhaseFiveSource, signal = new AbortController().signal): Promise<PhaseFiveCandidate[]> {
	const output: PhaseFiveCandidate[] = [];
	for await (const candidateItem of source.getCandidates(QUERY, signal)) output.push(candidateItem);
	return output;
}

function candidate(peerId: string, operatorGroup: string, origin: PhaseFiveOrigin): PhaseFiveCandidate {
	const routingSource: PhaseFiveRoutingSource =
		origin === "configured-fallback"
			? "configured"
			: origin === "registry-relay-record"
				? "registry"
				: origin === "cached-relay"
					? "peer-cache"
					: origin === "browser-closest-peers"
						? "delegated-routing"
						: "public-dht";
	return {
		addresses: [`/dns4/${peerId}.example.test/tcp/443/wss/p2p/${peerId}`],
		...(operatorGroup.startsWith("verified:")
			? {
					operatorEvidence: {
						credentialDigest: `sha256:${operatorGroup}`,
						operatorGroup,
						verified: true as const,
					},
				}
			: {}),
		operatorGroup,
		peerId,
		protocols: [relayPolicy.CIRCUIT_RELAY_V2_HOP_PROTOCOL],
		provenance: { origin, queryDigest: "query_5734a87d", resultIndex: 0, routingSource },
	};
}
