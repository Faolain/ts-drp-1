import type { RelayPolicyResult } from "@ts-drp/relay-policy";
import { namespaceCid } from "@ts-drp/rendezvous";
import type { CID } from "multiformats/cid";

export interface PublicOnlyPublisherNode {
	createGrid(objectId: string): Promise<void>;
	readonly peerId: string;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface PublicOnlyPublisherRouting {
	cancelReprovide(cid: CID, signal?: AbortSignal): Promise<void>;
	readonly peerId: string;
	provide(cid: CID, signal?: AbortSignal): Promise<{ cid: string }>;
	waitForRoutingTable(minimumPeers: number, signal?: AbortSignal): Promise<void>;
}

export interface PublicOnlyProviderObservation {
	readonly addresses: readonly string[];
	readonly peerId: string;
}

export interface PublicOnlyNodePublisherOptions {
	attachRouting(): Promise<PublicOnlyPublisherRouting>;
	getCircuitAddresses(): readonly string[];
	lookupProviders(cid: CID, signal: AbortSignal): AsyncIterable<PublicOnlyProviderObservation>;
	readonly node: PublicOnlyPublisherNode;
	reserveRelay(queryKey: Uint8Array, signal: AbortSignal): Promise<RelayPolicyResult>;
	stopRelay(): Promise<void>;
	readonly waitForCircuitAddressMs?: number;
}

export interface PublicOnlyNodePublisherResult {
	readonly cid: string;
	readonly circuitAddress: string;
	readonly milestones: readonly [
		"drp-started",
		"amino-attached",
		"routing-table-ready",
		"relay-reserved",
		"circuit-address-ready",
		"grid-created",
		"provider-published",
		"provider-independently-visible",
	];
	readonly peerId: string;
	readonly relay: RelayPolicyResult;
}

const SUCCESS_MILESTONES = [
	"drp-started",
	"amino-attached",
	"routing-table-ready",
	"relay-reserved",
	"circuit-address-ready",
	"grid-created",
	"provider-published",
	"provider-independently-visible",
] as const satisfies PublicOnlyNodePublisherResult["milestones"];

/** Fixed-order coordinator proving one identity owns DRP, relay dialability, and Amino publication. */
export class PublicOnlyNodePublisher {
	readonly #options: PublicOnlyNodePublisherOptions;
	#cid?: CID;
	#routing?: PublicOnlyPublisherRouting;
	#startPromise?: Promise<PublicOnlyNodePublisherResult>;
	#stopPromise?: Promise<void>;

	/**
	 *
	 * @param options
	 */
	constructor(options: PublicOnlyNodePublisherOptions) {
		this.#options = options;
	}

	/**
	 *
	 * @param namespace
	 * @param objectId
	 * @param signal
	 */
	start(namespace: string, objectId: string, signal: AbortSignal): Promise<PublicOnlyNodePublisherResult> {
		this.#startPromise ??= this.#start(namespace, objectId, signal);
		return this.#startPromise;
	}

	/**
	 *
	 */
	async stop(): Promise<void> {
		this.#stopPromise ??= this.#stop();
		return this.#stopPromise;
	}

	async #start(namespace: string, objectId: string, signal: AbortSignal): Promise<PublicOnlyNodePublisherResult> {
		const milestones: string[] = [];
		try {
			await this.#options.node.start();
			milestones.push("drp-started");
			const routing = await this.#options.attachRouting();
			this.#routing = routing;
			if (routing.peerId !== this.#options.node.peerId) {
				throw new PublicOnlyNodePublisherError("identity-mismatch");
			}
			milestones.push("amino-attached");
			await routing.waitForRoutingTable(1, signal);
			milestones.push("routing-table-ready");

			const cid = await namespaceCid(namespace);
			this.#cid = cid;
			const relay = await this.#options.reserveRelay(cid.multihash.digest, signal);
			if (relay.terminal !== "reserved" || relay.reservations.length === 0) {
				throw new PublicOnlyNodePublisherError("relay-exhausted");
			}
			milestones.push("relay-reserved");
			const circuitAddress = await waitForCircuitAddress(
				this.#options.getCircuitAddresses,
				this.#options.node.peerId,
				this.#options.waitForCircuitAddressMs ?? 5_000,
				signal
			);
			milestones.push("circuit-address-ready");

			await this.#options.node.createGrid(objectId);
			milestones.push("grid-created");
			await routing.provide(cid, signal);
			milestones.push("provider-published");

			let independentlyVisible = false;
			for await (const provider of this.#options.lookupProviders(cid, signal)) {
				if (provider.peerId !== this.#options.node.peerId) continue;
				if (provider.addresses.includes(circuitAddress)) independentlyVisible = true;
			}
			if (!independentlyVisible) throw new PublicOnlyNodePublisherError("provider-address-omitted");
			milestones.push("provider-independently-visible");
			return {
				cid: cid.toString(),
				circuitAddress,
				milestones: SUCCESS_MILESTONES,
				peerId: this.#options.node.peerId,
				relay,
			};
		} catch (error) {
			await this.stop().catch(() => undefined);
			throw error;
		}
	}

	async #stop(): Promise<void> {
		const cleanup: Promise<unknown>[] = [this.#options.stopRelay()];
		if (this.#cid !== undefined && this.#routing !== undefined) {
			cleanup.push(this.#routing.cancelReprovide(this.#cid));
		}
		cleanup.push(this.#options.node.stop());
		const results = await Promise.allSettled(cleanup);
		const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failures.length > 0)
			throw new AggregateError(
				failures.map(({ reason }) => reason),
				"publisher cleanup failed"
			);
	}
}

/**
 *
 */
export class PublicOnlyNodePublisherError extends Error {
	readonly terminal: "identity-mismatch" | "provider-address-omitted" | "relay-exhausted";

	/**
	 *
	 * @param terminal
	 */
	constructor(terminal: PublicOnlyNodePublisherError["terminal"]) {
		super(terminal);
		this.name = "PublicOnlyNodePublisherError";
		this.terminal = terminal;
	}
}

async function waitForCircuitAddress(
	read: () => readonly string[],
	peerId: string,
	timeoutMs: number,
	signal: AbortSignal
): Promise<string> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
		throw new Error("circuit address timeout must be within 1..30000ms");
	}
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		signal.throwIfAborted();
		const address = read().find((value) => value.includes("/p2p-circuit") && value.endsWith(`/p2p/${peerId}`));
		if (address !== undefined) return address;
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
	throw new PublicOnlyNodePublisherError("provider-address-omitted");
}
