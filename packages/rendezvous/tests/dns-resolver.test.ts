import type { Resolver } from "@ts-drp/rendezvous";
import * as rendezvous from "@ts-drp/rendezvous";
import { describe, expect, it, vi } from "vitest";

interface StubDnsClient {
	query(
		hostname: string,
		options: { cached?: boolean; signal?: AbortSignal; types?: number[] }
	): Promise<{ Answer: Array<{ data: string; type: number | string }> }>;
}

interface DnsResolverFactory {
	(options?: { client?: StubDnsClient }): Resolver;
}

describe("createDnsResolver", () => {
	it.each([
		{
			answers: [
				{ data: "9.9.9.9", type: 1 },
				{ data: "8.8.8.8", type: "A" },
			],
			family: "ipv4",
			type: 1,
		},
		{
			answers: [
				{ data: "2620:fe::fe", type: 28 },
				{ data: "2001:4860:4860::8888", type: "AAAA" },
			],
			family: "ipv6",
			type: 28,
		},
	] as const)("accepts string and numeric $family record types", async ({ answers, family, type }) => {
		const query = vi.fn(() => Promise.resolve({ Answer: [...answers] }));
		const resolver = factory()({ client: { query } });
		const signal = new AbortController().signal;

		await expect(resolver.resolve("public.example", signal, family)).resolves.toEqual(answers.map(({ data }) => data));
		expect(query).toHaveBeenCalledOnce();
		expect(query).toHaveBeenCalledWith("public.example", {
			cached: false,
			signal,
			types: [type],
		});
	});

	it("queries A and AAAA independently and tolerates a partial AAAA failure", async () => {
		const query = vi.fn((_hostname: string, options: { types?: number[] }) => {
			if (options.types?.[0] === 1) {
				return Promise.resolve({ Answer: [{ data: "9.9.9.9", type: "A" }] });
			}
			return Promise.reject(new Error("fixture has no AAAA record"));
		});
		const resolver = factory()({ client: { query } });
		const signal = new AbortController().signal;

		await expect(resolver.resolve("public.example", signal, undefined)).resolves.toEqual(["9.9.9.9"]);
		expect(query.mock.calls.map(([, options]) => options.types)).toEqual([[1], [28]]);
	});
});

function factory(): DnsResolverFactory {
	const value: unknown = Reflect.get(rendezvous, "createDnsResolver");
	expect(value).toBeTypeOf("function");
	if (typeof value !== "function") throw new Error("@ts-drp/rendezvous does not export createDnsResolver");
	return value as DnsResolverFactory;
}
