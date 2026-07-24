import type {
	RegistrationReceipt,
	RegistryDiscoveryReceipt,
	RegistryDiscoveryRequest,
	RegistryEndpoint,
	RegistryRegistrationRequest,
	RegistryRejection,
} from "./registry.js";

const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 4_000;

export interface HttpRegistryLimits {
	readonly maxResponseBytes?: number;
	readonly requestTimeoutMs?: number;
}

export interface HttpRegistryEndpointOptions {
	readonly allow_insecure_loopback_fixture?: boolean;
	readonly fetchImpl?: typeof globalThis.fetch;
	readonly id: string;
	readonly limits?: HttpRegistryLimits;
	readonly url: string;
}

/**
 * Creates a bounded browser-safe JSON transport for a RegistryEndpoint.
 * @param options - Endpoint identity, base URL, fetch implementation, and transport limits.
 * @returns A registry endpoint that maps transport failures to typed rejections.
 */
export function createHttpRegistryEndpoint(options: HttpRegistryEndpointOptions): RegistryEndpoint {
	const baseUrl = validateRegistryUrl(options.url, options.allow_insecure_loopback_fixture === true);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const maxResponseBytes = boundedInteger(
		options.limits?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
		1_024,
		1024 * 1024,
		"maxResponseBytes"
	);
	const requestTimeoutMs = boundedInteger(
		options.limits?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		1,
		30_000,
		"requestTimeoutMs"
	);

	const request = async (
		path: "/v1/discover" | "/v1/register",
		body: unknown,
		signal: AbortSignal
	): Promise<unknown | RegistryRejection> => {
		try {
			const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]);
			const response = await fetchImpl(resolveRegistryPath(baseUrl, path), {
				body: JSON.stringify(body),
				credentials: "omit",
				headers: { "accept": "application/json", "content-type": "application/json" },
				method: "POST",
				redirect: "error",
				signal: boundedSignal,
			});
			if (!response.ok || !isJsonContentType(response.headers.get("content-type"))) {
				await response.body?.cancel();
				return unavailable();
			}
			const value = JSON.parse(await readBoundedText(response, maxResponseBytes)) as unknown;
			return value;
		} catch {
			return unavailable();
		}
	};

	return Object.freeze({
		id: options.id,
		discover: async (input: RegistryDiscoveryRequest): Promise<RegistryDiscoveryReceipt | RegistryRejection> => {
			const value = await request(
				"/v1/discover",
				{
					namespace: input.namespace,
					...(input.targetPeerId === undefined ? {} : { targetPeerId: input.targetPeerId }),
				},
				input.signal
			);
			return isDiscoveryResult(value) ? value : unavailable();
		},
		register: async (input: RegistryRegistrationRequest): Promise<RegistrationReceipt | RegistryRejection> => {
			const value = await request(
				"/v1/register",
				{ ...(input.credential === undefined ? {} : { credential: input.credential }), record: input.record },
				input.signal
			);
			return isRegistrationResult(value) ? value : unavailable();
		},
	} satisfies RegistryEndpoint);
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
		throw new Error("registry response cap exceeded");
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let output = "";
	let complete = false;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			received += chunk.value.byteLength;
			if (received > maximumBytes) throw new Error("registry response cap exceeded");
			output += decoder.decode(chunk.value, { stream: true });
		}
		complete = true;
		return output + decoder.decode();
	} finally {
		if (!complete) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

function resolveRegistryPath(baseUrl: URL, path: "/v1/discover" | "/v1/register"): URL {
	const directoryUrl = new URL(baseUrl);
	if (!directoryUrl.pathname.endsWith("/")) directoryUrl.pathname += "/";
	return new URL(path.slice(1), directoryUrl);
}

function validateRegistryUrl(input: string, allowInsecureLoopback: boolean): URL {
	const url = new URL(input);
	if (url.username !== "" || url.password !== "") throw new Error("registry URL must not contain credentials");
	if (url.search !== "" || url.hash !== "") throw new Error("registry URL must not contain query or fragment");
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:")) {
		throw new Error("registry URL must use HTTPS (plaintext is allowed only for an explicit loopback fixture)");
	}
	return url;
}

function isJsonContentType(value: string | null): boolean {
	return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function isRejection(value: unknown): value is RegistryRejection {
	return (
		typeof value === "object" &&
		value !== null &&
		"accepted" in value &&
		value.accepted === false &&
		"code" in value &&
		typeof value.code === "string"
	);
}

function isDiscoveryResult(value: unknown): value is RegistryDiscoveryReceipt | RegistryRejection {
	return (
		isRejection(value) ||
		(typeof value === "object" &&
			value !== null &&
			"endpointId" in value &&
			typeof value.endpointId === "string" &&
			"records" in value &&
			Array.isArray(value.records))
	);
}

function isRegistrationResult(value: unknown): value is RegistrationReceipt | RegistryRejection {
	return (
		isRejection(value) ||
		(typeof value === "object" &&
			value !== null &&
			"accepted" in value &&
			value.accepted === true &&
			"endpointId" in value &&
			typeof value.endpointId === "string" &&
			"sequence" in value &&
			typeof value.sequence === "number")
	);
}

function unavailable(): RegistryRejection {
	return { accepted: false, code: "endpoint-unavailable" };
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
	}
	return value;
}
