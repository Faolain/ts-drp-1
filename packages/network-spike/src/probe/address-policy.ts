import { multiaddr } from "@multiformats/multiaddr";

export type AddressFamily = "ipv4" | "ipv6" | "dns" | "unknown";
export type AddressScope =
	| "public"
	| "private"
	| "loopback"
	| "link-local"
	| "multicast"
	| "reserved"
	| "unresolved"
	| "unknown";
export type AddressTransport = "wss" | "webtransport" | "webrtc-direct" | "relay" | "tcp" | "quic-v1" | "unknown";

export interface Resolver {
	resolve(hostname: string, signal: AbortSignal): Promise<string[]>;
}

export interface AddressDecision {
	dialable: boolean;
	family: AddressFamily;
	reasons: string[];
	resolvedScopes: AddressScope[];
	scope: AddressScope;
	transports: AddressTransport[];
}

export interface AddressPolicyOptions {
	/** Test-fixture escape hatch; production callers retain secure WebSockets. */
	allowInsecureWebSocket?: boolean;
	allowLoopback?: boolean;
	allowPrivate?: boolean;
	target: "browser" | "node";
}

export interface AddressCandidate {
	address: string;
	addressPseudonym: string;
	candidatePseudonym: string;
}

export interface CandidatePlan {
	accepted: Array<{ candidate: AddressCandidate; decision: AddressDecision }>;
	rejected: Array<{ candidate: AddressCandidate; decision: AddressDecision }>;
}

/** Owns parsing, scope checks, DNS-rebinding rejection, and target-specific dialability. */
export class AddressPolicy {
	readonly #options: AddressPolicyOptions;

	/**
	 * Creates one address policy.
	 * @param options - Target and explicit private-network allowance.
	 */
	constructor(options: AddressPolicyOptions) {
		if (options.target !== "browser" && options.target !== "node") {
			throw new Error("address policy target must be browser or node");
		}
		if (options.allowPrivate !== undefined && typeof options.allowPrivate !== "boolean") {
			throw new Error("allowPrivate must be a boolean when provided");
		}
		if (options.allowLoopback !== undefined && typeof options.allowLoopback !== "boolean") {
			throw new Error("allowLoopback must be a boolean when provided");
		}
		if (options.allowInsecureWebSocket !== undefined && typeof options.allowInsecureWebSocket !== "boolean") {
			throw new Error("allowInsecureWebSocket must be a boolean when provided");
		}
		this.#options = Object.freeze({ ...options });
	}

	/**
	 * Classifies a validated multiaddr and resolves DNS before deciding dialability.
	 * @param input - Ephemeral raw multiaddr. It must not be emitted to durable evidence.
	 * @param resolver - Injected resolver used only for DNS components.
	 * @param signal - Abort signal for resolution.
	 * @returns A redaction-safe decision.
	 */
	async evaluate(input: string, resolver: Resolver, signal: AbortSignal): Promise<AddressDecision> {
		const address = multiaddr(input);
		const components = address.getComponents();
		const names = components.map((component) => component.name);
		const host = components.find((component) => {
			return ["ip4", "ip6", "dns", "dns4", "dns6"].includes(component.name);
		});
		const family = classifyFamily(host?.name);
		const transports = classifyTransports(names, this.#options.allowInsecureWebSocket === true);
		const reasons: string[] = [];
		let scope = classifyScope(family, host?.value);
		let resolvedScopes: AddressScope[] = [];

		if (family === "dns") {
			if (host?.value === undefined) {
				reasons.push("missing-dns-name");
			} else {
				const resolved = await resolver.resolve(host.value, signal);
				resolvedScopes = resolved.map((value) => classifyScope(value.includes(":") ? "ipv6" : "ipv4", value));
				if (resolved.length === 0) {
					reasons.push("dns-empty");
				} else if (
					(host.name === "dns4" && resolved.some((value) => value.includes(":"))) ||
					(host.name === "dns6" && resolved.some((value) => !value.includes(":")))
				) {
					reasons.push("dns-family-mismatch");
				} else if (resolvedScopes.some((value) => value !== "public")) {
					reasons.push("dns-rebinding-risk");
				} else {
					scope = "public";
				}
			}
		}

		if (
			scope !== "public" &&
			!(this.#options.allowPrivate === true && scope === "private") &&
			!(this.#options.allowLoopback === true && scope === "loopback")
		) {
			reasons.push(`scope-${scope}`);
		}
		if (transports.includes("unknown") || transports.length === 0) {
			reasons.push("unsupported-transport");
		}
		if (
			names.includes("ws") &&
			!names.includes("tls") &&
			!names.includes("wss") &&
			this.#options.allowInsecureWebSocket !== true
		) {
			reasons.push("insecure-websocket");
		}
		if (this.#options.target === "browser" && transports.some((value) => value === "tcp" || value === "quic-v1")) {
			reasons.push("node-only-transport");
		}
		if (this.#options.target === "node" && transports.includes("webrtc-direct")) {
			reasons.push("browser-oriented-transport");
		}

		return {
			dialable: reasons.length === 0,
			family,
			reasons: [...new Set(reasons)],
			resolvedScopes,
			scope,
			transports,
		};
	}

	/**
	 * Deduplicates and classifies a bounded candidate list while preserving multiple addresses per peer.
	 * @param candidates - Ephemeral candidates; raw addresses must not enter durable telemetry.
	 * @param resolver - Injected DNS resolver.
	 * @param signal - Abort signal.
	 * @param maximumAddresses - Hard upper bound before any resolution work.
	 * @returns Accepted and fast-rejected decisions.
	 */
	async plan(
		candidates: AddressCandidate[],
		resolver: Resolver,
		signal: AbortSignal,
		maximumAddresses = 64
	): Promise<CandidatePlan> {
		if (!Number.isInteger(maximumAddresses) || maximumAddresses < 1 || maximumAddresses > 64) {
			throw new Error("candidate address cap must be an integer within 1..64");
		}
		if (candidates.length > maximumAddresses) {
			throw new Error(`candidate address cap exceeded (${candidates.length}/${maximumAddresses})`);
		}
		const unique = new Map<string, AddressCandidate>();
		for (const candidate of candidates) {
			const canonical = multiaddr(candidate.address).toString();
			unique.set(`${candidate.candidatePseudonym}:${canonical}`, candidate);
		}
		const accepted: CandidatePlan["accepted"] = [];
		const rejected: CandidatePlan["rejected"] = [];
		for (const candidate of unique.values()) {
			const decision = await this.evaluate(candidate.address, resolver, signal);
			(decision.dialable ? accepted : rejected).push({ candidate, decision });
		}
		return { accepted, rejected };
	}
}

function classifyFamily(protocolName: string | undefined): AddressFamily {
	if (protocolName === "ip4") return "ipv4";
	if (protocolName === "ip6") return "ipv6";
	if (protocolName === "dns" || protocolName === "dns4" || protocolName === "dns6") return "dns";
	return "unknown";
}

function classifyTransports(names: string[], allowInsecureWebSocket = false): AddressTransport[] {
	const transports: AddressTransport[] = [];
	if (names.includes("p2p-circuit")) transports.push("relay");
	if (names.includes("webrtc-direct")) transports.push("webrtc-direct");
	if (names.includes("webtransport")) transports.push("webtransport");
	if (names.includes("wss") || (names.includes("ws") && (names.includes("tls") || allowInsecureWebSocket))) {
		transports.push("wss");
	}
	if (names.includes("tcp") && !transports.includes("wss") && !transports.includes("relay")) transports.push("tcp");
	if (names.includes("quic-v1") && !transports.includes("webtransport") && !transports.includes("relay")) {
		transports.push("quic-v1");
	}
	return transports.length === 0 ? ["unknown"] : transports;
}

function classifyScope(family: AddressFamily, value: string | undefined): AddressScope {
	if (value === undefined) return family === "dns" ? "unresolved" : "unknown";
	if (family === "ipv4") return classifyIpv4(value);
	if (family === "ipv6") return classifyIpv6(value);
	if (family === "dns") return "unresolved";
	return "unknown";
}

/**
 * Classifies a literal IP address using the same scope rules as multiaddr dialing.
 * @param value - IPv4 or IPv6 literal returned by a resolver.
 * @returns Its public/private/reserved scope, or unknown for malformed input.
 */
export function classifyIpAddressScope(value: string): AddressScope {
	return classifyScope(value.includes(":") ? "ipv6" : "ipv4", value);
}

function classifyIpv4(value: string): AddressScope {
	const octets = value.split(".").map(Number);
	if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return "unknown";
	}
	const [first, second, third] = octets;
	if (first === 127) return "loopback";
	if (first === 169 && second === 254) return "link-local";
	if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) {
		return "private";
	}
	if (first >= 224 && first <= 239) return "multicast";
	if (
		first === 0 ||
		first >= 240 ||
		(first === 100 && second >= 64 && second <= 127) ||
		(first === 192 && second === 0 && third === 0) ||
		(first === 192 && second === 0 && third === 2) ||
		(first === 192 && second === 88 && third === 99) ||
		(first === 198 && (second === 18 || second === 19)) ||
		(first === 198 && second === 51 && third === 100) ||
		(first === 203 && second === 0 && third === 113)
	) {
		return "reserved";
	}
	return "public";
}

function classifyIpv6(value: string): AddressScope {
	const parts = expandIpv6(value);
	if (parts === undefined) return "unknown";
	if (parts.every((part) => part === 0)) return "reserved";
	if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return "loopback";
	if ((parts[0] & 0xfe00) === 0xfc00) return "private";
	if ((parts[0] & 0xffc0) === 0xfe80) return "link-local";
	if ((parts[0] & 0xffc0) === 0xfec0) return "reserved";
	if ((parts[0] & 0xff00) === 0xff00) return "multicast";

	const isDeprecatedIpv4Compatible = parts.slice(0, 6).every((part) => part === 0);
	const isIpv4Translated = parts.slice(0, 4).every((part) => part === 0) && parts[4] === 0xffff && parts[5] === 0;
	const embeddedIpv4 = isDeprecatedIpv4Compatible
		? ipv4FromHextets(parts[6], parts[7])
		: isIpv4Translated
			? ipv4FromHextets(parts[6], parts[7])
			: parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff
				? ipv4FromHextets(parts[6], parts[7])
				: parts[0] === 0x2002
					? ipv4FromHextets(parts[1], parts[2])
					: parts[0] === 0x0064 && parts[1] === 0xff9b && parts.slice(2, 6).every((part) => part === 0)
						? ipv4FromHextets(parts[6], parts[7])
						: undefined;
	if (embeddedIpv4 !== undefined) {
		const embeddedScope = classifyIpv4(embeddedIpv4);
		if (embeddedScope !== "public") return embeddedScope;
		if (isDeprecatedIpv4Compatible || isIpv4Translated) return "reserved";
	}

	if (
		(parts[0] === 0x0064 && parts[1] === 0xff9b && parts[2] === 0x0001) ||
		(parts[0] === 0x0100 && parts.slice(1, 4).every((part) => part === 0)) ||
		(parts[0] === 0x2001 && parts[1] <= 0x01ff) ||
		(parts[0] === 0x2001 && parts[1] === 0x0db8) ||
		(parts[0] === 0x3fff && (parts[1] & 0xf000) === 0)
	) {
		return "reserved";
	}
	return "public";
}

function expandIpv6(value: string): number[] | undefined {
	const normalized = value.toLowerCase();
	if (!/^[0-9a-f:.]+$/u.test(normalized) || normalized.split("::").length > 2) return undefined;
	const [leftText, rightText] = normalized.split("::");
	const left = parseIpv6Side(leftText ?? "");
	const right = parseIpv6Side(rightText ?? "");
	if (left === undefined || right === undefined) return undefined;
	if (!normalized.includes("::")) return left.length === 8 ? left : undefined;
	const missing = 8 - left.length - right.length;
	if (missing < 1) return undefined;
	return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Side(value: string): number[] | undefined {
	if (value.length === 0) return [];
	const tokens = value.split(":");
	const parts: number[] = [];
	for (const [index, token] of tokens.entries()) {
		if (token.includes(".")) {
			if (index !== tokens.length - 1) return undefined;
			const octets = token.split(".").map(Number);
			if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
				return undefined;
			}
			parts.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
		} else {
			if (!/^[0-9a-f]{1,4}$/u.test(token)) return undefined;
			parts.push(Number.parseInt(token, 16));
		}
	}
	return parts;
}

function ipv4FromHextets(high: number, low: number): string {
	return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}
