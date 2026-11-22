import type { DRPNetworkNodeConfig } from "@ts-drp/types";

type WebRtcConfig = DRPNetworkNodeConfig["webrtc"];

/** One local ICE policy owner, returning fresh native dictionaries for each consumer. */
export interface WebRtcConfigurationOwner {
	forRawConnection(): RTCConfiguration;
	forLibp2pTransport(): RTCConfiguration | undefined;
}

function invalid(): never {
	// Do not include supplied URLs or credentials in exceptions/telemetry.
	throw new TypeError("Invalid local WebRTC ICE configuration");
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid();
	const captured: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !keys.includes(key)) return invalid();
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor)) return invalid();
		captured[key] = descriptor.value;
	}
	return captured;
}

function list(value: unknown, maximum: number): unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return invalid();
	if (Reflect.ownKeys(value).length !== value.length + 1) return invalid();
	const captured: unknown[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || !("value" in descriptor)) return invalid();
		captured.push(descriptor.value);
	}
	return captured;
}

function iceUrl(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048) return invalid();
	const match = /^(stun|stuns|turn|turns):([^/?#\\\s]+)(?:\?transport=(udp|tcp))?$/u.exec(value);
	if (match === null || (match[3] !== undefined && !match[1].startsWith("turn"))) return invalid();
	try {
		const address = new URL(`https://${match[2]}`);
		if (address.username || address.password || !address.hostname || address.pathname !== "/") return invalid();
		// An explicit zero port is not a useful ICE endpoint. URL validates other port bounds.
		if (address.port === "0" || match[2].endsWith(":")) return invalid();
	} catch {
		return invalid();
	}
	return value;
}

function credential(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > 1024) return invalid();
	return value;
}

function createConfigurationOwner(config: WebRtcConfig): WebRtcConfigurationOwner {
	const supplied = config === undefined ? undefined : record(config, ["ice_servers", "ice_transport_policy"]);
	const policy = supplied?.ice_transport_policy === undefined ? "all" : supplied.ice_transport_policy;
	if (policy !== "all" && policy !== "relay") return invalid();
	const servers = supplied?.ice_servers === undefined ? undefined : list(supplied.ice_servers, 8);
	const selected: RTCIceServer[] | undefined = servers?.map((entry: unknown) => {
		const server = record(entry, ["urls", "username", "credential"]);
		const urls = typeof server.urls === "string" ? [server.urls] : list(server.urls, 8);
		if (urls.length === 0) return invalid();
		const validated = urls.map(iceUrl);
		const username = credential(server.username);
		const password = credential(server.credential);
		if (validated.some((url) => /^turns?:/u.test(url)) && (username === undefined || password === undefined)) {
			return invalid();
		}
		return {
			urls: validated,
			...(username === undefined ? {} : { username }),
			...(password === undefined ? {} : { credential: password }),
		};
	});
	if (policy === "relay" && !selected?.some((server) => (server.urls as string[]).some((url) => /^turns?:/u.test(url)))) {
		return invalid();
	}
	const copy = (iceServers: RTCIceServer[] | undefined): RTCConfiguration => ({
		iceTransportPolicy: policy,
		...(iceServers === undefined
			? {}
			: { iceServers: iceServers.map((server) => ({ ...server, urls: [...(server.urls as string[])] })) }),
	});
	return Object.freeze({
		forRawConnection: (): RTCConfiguration => copy(selected ?? [{ urls: ["stun:stun.l.google.com:19302"] }]),
		// Undefined keeps libp2p's current multi-provider defaults; do not copy their private constants.
		forLibp2pTransport: (): RTCConfiguration | undefined => supplied === undefined ? undefined : copy(selected),
	});
}

export function resolveWebRtcConfiguration(config: WebRtcConfig): WebRtcConfigurationOwner {
	try {
		return createConfigurationOwner(config);
	} catch {
		// Even exotic local objects must not surface caller-thrown secret-bearing errors.
		return invalid();
	}
}
