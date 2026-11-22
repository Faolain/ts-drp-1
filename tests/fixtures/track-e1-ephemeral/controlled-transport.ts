export interface ControlledIngress {
	readonly bytes: Uint8Array;
	readonly sender: string;
}

export interface ControlledTransportSendInput {
	readonly bytes: Uint8Array;
	readonly class: "reliable-unordered" | "unreliable-sequenced" | "unreliable-unordered";
	readonly recipients: "all" | readonly string[];
}

export interface ControlledTransportPort {
	readonly localPeerId: string;
	authorizedPeers(): readonly string[];
	close(): void;
	isAuthorized(sender: string): boolean;
	maxEnvelopeBytes(): number;
	onMessage(listener: (ingress: ControlledIngress) => void): () => void;
	send(input: Uint8Array | ControlledTransportSendInput): Promise<boolean>;
}

interface ControlledEndpoint {
	authorized: Set<string>;
	closeCount: number;
	connected: boolean;
	failuresRemaining: number;
	held: boolean;
	listeners: Set<(ingress: ControlledIngress) => void>;
	pending: {
		readonly bytes: Uint8Array;
		resolve(accepted: boolean): void;
	}[];
}

/**
 * Deterministic transport boundary for Track E1. It supplies transport facts only;
 * frame decoding, ordering, queueing and counters remain production responsibilities.
 */
export class ControlledEphemeralBus {
	readonly #endpoints = new Map<string, ControlledEndpoint>();
	readonly #sent: { readonly bytes: Uint8Array; readonly sender: string }[] = [];

	/**
	 * Create one isolated transport endpoint.
	 * @param peerId Authenticated sender identity.
	 * @param maxEnvelopeBytes Transport envelope ceiling.
	 * @returns The private transport port consumed by the production channel.
	 */
	createPort(peerId: string, maxEnvelopeBytes = 65_792): ControlledTransportPort {
		if (this.#endpoints.has(peerId)) throw new Error(`duplicate controlled peer: ${peerId}`);
		const endpoint: ControlledEndpoint = {
			authorized: new Set(),
			closeCount: 0,
			connected: true,
			failuresRemaining: 0,
			held: false,
			listeners: new Set(),
			pending: [],
		};
		this.#endpoints.set(peerId, endpoint);

		return {
			authorizedPeers: () =>
				[...endpoint.authorized].filter((sender) => this.#endpoints.get(sender)?.connected === true).sort(),
			close: (): void => {
				endpoint.closeCount += 1;
				endpoint.connected = false;
				for (const pending of endpoint.pending.splice(0)) pending.resolve(false);
				endpoint.authorized.clear();
				endpoint.listeners.clear();
			},
			localPeerId: peerId,
			maxEnvelopeBytes: (): number => maxEnvelopeBytes,
			isAuthorized: (sender) =>
				endpoint.connected && endpoint.authorized.has(sender) && this.#endpoints.get(sender)?.connected === true,
			onMessage: (listener) => {
				endpoint.listeners.add(listener);
				return () => endpoint.listeners.delete(listener);
			},
			send: (input): Promise<boolean> => {
				const bytes = input instanceof Uint8Array ? input : input.bytes;
				if (!endpoint.connected) return Promise.resolve(false);
				if (endpoint.failuresRemaining > 0) {
					endpoint.failuresRemaining -= 1;
					return Promise.resolve(false);
				}
				const detached = bytes.slice();
				if (!endpoint.held) return Promise.resolve(this.#deliver(peerId, detached));
				return new Promise((resolve) => endpoint.pending.push({ bytes: detached, resolve }));
			},
		};
	}

	/**
	 * Return how often production closed an endpoint.
	 * @param peerId Endpoint identity.
	 * @returns Close-call count.
	 */
	closeCount(peerId: string): number {
		return this.#endpoint(peerId).closeCount;
	}

	/**
	 * Hold accepted sends at the transport boundary so production queue behavior is observable.
	 * @param peerId Endpoint identity.
	 */
	hold(peerId: string): void {
		this.#endpoint(peerId).held = true;
	}

	/**
	 * Release every held send and allow subsequent sends to complete immediately.
	 * @param peerId Endpoint identity.
	 */
	release(peerId: string): void {
		const endpoint = this.#endpoint(peerId);
		endpoint.held = false;
		for (const { bytes, resolve } of endpoint.pending.splice(0)) {
			resolve(this.#deliver(peerId, bytes));
		}
	}

	/**
	 * Return the number of sends currently held by the controlled boundary.
	 * @param peerId Endpoint identity.
	 * @returns Pending held send count.
	 */
	pending(peerId: string): number {
		return this.#endpoint(peerId).pending.length;
	}

	/**
	 * Configure the receiver's current authority decision.
	 * @param recipient Receiver identity.
	 * @param sender Authenticated sender identity.
	 * @param authorized Whether the receiver currently authorizes the sender.
	 */
	authorize(recipient: string, sender: string, authorized = true): void {
		const endpoint = this.#endpoint(recipient);
		if (authorized) endpoint.authorized.add(sender);
		else endpoint.authorized.delete(sender);
	}

	/**
	 * Restore a live controlled endpoint.
	 * @param peerId Endpoint identity.
	 */
	connect(peerId: string): void {
		this.#endpoint(peerId).connected = true;
	}

	/**
	 * Suspend a controlled endpoint without discarding channel state.
	 * @param peerId Endpoint identity.
	 */
	disconnect(peerId: string): void {
		this.#endpoint(peerId).connected = false;
	}

	/**
	 * Make the next local transport sends fail before acceptance.
	 * @param peerId Endpoint identity.
	 * @param count Number of sends to reject.
	 */
	failNext(peerId: string, count: number): void {
		if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("count must be a non-negative safe integer");
		this.#endpoint(peerId).failuresRemaining = count;
	}

	/**
	 * Deliver raw ingress without invoking the sender's production channel.
	 * @param recipient Receiver identity.
	 * @param sender Authenticated sender identity.
	 * @param bytes Raw frame bytes.
	 */
	inject(recipient: string, sender: string, bytes: Uint8Array): void {
		const endpoint = this.#endpoint(recipient);
		if (!endpoint.connected) return;
		for (const listener of endpoint.listeners) listener({ bytes: bytes.slice(), sender });
	}

	/**
	 * Return detached accepted-transport evidence.
	 * @returns Accepted sends in transport order.
	 */
	sent(): readonly { readonly bytes: Uint8Array; readonly sender: string }[] {
		return this.#sent.map(({ bytes, sender }) => ({ bytes: bytes.slice(), sender }));
	}

	#deliver(sender: string, bytes: Uint8Array): boolean {
		const endpoint = this.#endpoint(sender);
		if (!endpoint.connected) return false;
		this.#sent.push({ bytes: bytes.slice(), sender });
		for (const [recipientId, recipient] of this.#endpoints) {
			if (recipientId === sender || !recipient.connected) continue;
			for (const listener of recipient.listeners) {
				listener({ bytes: bytes.slice(), sender });
			}
		}
		return true;
	}

	#endpoint(peerId: string): ControlledEndpoint {
		const endpoint = this.#endpoints.get(peerId);
		if (endpoint === undefined) throw new Error(`unknown controlled peer: ${peerId}`);
		return endpoint;
	}
}
