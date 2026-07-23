import { dns, RecordType } from "@multiformats/dns";

import type { Resolver } from "./address-policy.js";

interface DnsAnswer {
	data: string;
	type: unknown;
}

interface DnsQueryClient {
	query(
		hostname: string,
		options: { cached?: boolean; signal?: AbortSignal; types?: RecordType[] }
	): Promise<{ Answer: DnsAnswer[] }>;
}

export interface DnsResolverOptions {
	client?: DnsQueryClient;
}

/**
 * Adapts `@multiformats/dns` to the address-policy resolver contract.
 *
 * The package uses the operating system's dns/promises resolver in Node. Its
 * browser bundle uses DNS-over-HTTPS resolvers for Cloudflare and Google,
 * shuffled before lookup. `cached:false` enforces a dial-time DNS recheck.
 * @param options - Optional DNS query client override.
 * @returns A resolver suitable for address-policy evaluation.
 */
export function createDnsResolver(options: DnsResolverOptions = {}): Resolver {
	const client = options.client ?? dns();
	return {
		async resolve(hostname, signal, family): Promise<string[]> {
			const types =
				family === "ipv4" ? [RecordType.A] : family === "ipv6" ? [RecordType.AAAA] : [RecordType.A, RecordType.AAAA];
			const results = await Promise.allSettled(
				types.map(async (recordType) => {
					const response = await client.query(hostname, {
						cached: false,
						signal,
						types: [recordType],
					});
					return response.Answer.filter(({ type }) => isAddressRecordType(type, recordType)).map(({ data }) => data);
				})
			);
			const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
			if (failures.length === results.length) {
				throw new AggregateError(
					failures.map(({ reason }) => reason),
					`DNS address lookup failed for ${hostname}`
				);
			}
			return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
		},
	};
}

function isAddressRecordType(type: unknown, requestedType: RecordType): boolean {
	return requestedType === RecordType.A
		? type === RecordType.A || type === "A"
		: type === RecordType.AAAA || type === "AAAA";
}
