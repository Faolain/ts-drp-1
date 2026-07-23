import type {
	RegistrationReceipt,
	RegistryDiscoveryReceipt,
	RegistryDiscoveryRequest,
	RegistryEndpoint,
	RegistryRegistrationRequest,
	RegistryRejection,
} from "@ts-drp/rendezvous";

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Bounded browser wire adapter for the deterministic two-endpoint signed
 * registry fixture. RegistryClient/RecordValidator still own validation.
 */
export class HttpGridRegistryEndpoint implements RegistryEndpoint {
	readonly id: string;
	readonly #baseUrl: string;

	/**
	 * @param id - Sanitized endpoint identity. @param baseUrl - Fixture endpoint root.
	 * @param baseUrl
	 */
	constructor(id: string, baseUrl: string) {
		this.id = id;
		this.#baseUrl = baseUrl.replace(/\/$/u, "");
	}

	/**
	 *
	 * @param request
	 */
	async register(request: RegistryRegistrationRequest): Promise<RegistrationReceipt | RegistryRejection> {
		const response = await fetch(`${this.#baseUrl}/register`, {
			body: JSON.stringify({ record: request.record }),
			headers: { "content-type": "application/json" },
			method: "POST",
			signal: request.signal,
		});
		return readBoundedJson<RegistrationReceipt | RegistryRejection>(response);
	}

	/**
	 *
	 * @param request
	 */
	async discover(request: RegistryDiscoveryRequest): Promise<RegistryDiscoveryReceipt | RegistryRejection> {
		const url = new URL(`${this.#baseUrl}/discover`);
		url.searchParams.set("namespace", request.namespace);
		const response = await fetch(url, { signal: request.signal });
		return readBoundedJson<RegistryDiscoveryReceipt | RegistryRejection>(response);
	}
}

async function readBoundedJson<T>(response: Response): Promise<T> {
	const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
	if (contentLength > MAX_RESPONSE_BYTES) throw new Error("registry response exceeded byte cap");
	const text = await response.text();
	if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
		throw new Error("registry response exceeded byte cap");
	}
	if (!response.ok) throw new Error(`registry endpoint returned ${response.status}`);
	return JSON.parse(text) as T;
}
