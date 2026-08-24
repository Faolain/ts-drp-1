/* eslint-disable jsdoc/require-jsdoc -- Shared controlled test boundary. */
import type { DRPUnreliableWebRtcOwner, DRPUnreliableWebRtcRoute, DRPUnreliableWebRtcSnapshot } from "@ts-drp/network";

export interface ControlledRawSend {
	readonly bytes: Uint8Array;
	readonly peers: readonly string[];
	readonly routeId: string;
	readonly sender: string;
}

function snapshot(peers: readonly string[], backpressuredDrops: number): DRPUnreliableWebRtcSnapshot {
	return Object.freeze({
		activeLinks: peers.length,
		authenticatedConnectionLosses: 0,
		backpressuredDrops,
		handshakeFailures: 0,
		lastLinkDrop: undefined,
		linkDrops: 0,
		links: Object.freeze(
			peers.map((peerId) =>
				Object.freeze({
					connectionId: `controlled-${peerId}`,
					generation: 0,
					label: "ts-drp-ephemeral/1",
					maxRetransmits: 0,
					ordered: false,
					peerId,
					remoteAddr: `/controlled/${peerId}`,
				})
			)
		),
		received: 0,
		sent: 0,
		unknownRouteDrops: 0,
	});
}

export class ControlledRawRoute implements DRPUnreliableWebRtcRoute {
	readonly maxPayloadBytes = 1_167;
	readonly #bus: ControlledRawBus;
	readonly #listeners = new Set<(ingress: { readonly bytes: Uint8Array; readonly sender: string }) => void>();
	readonly #localPeerId: string;
	readonly routeId: string;
	backpressured = false;
	closed = false;
	readonly reconciledPeers: string[][] = [];

	constructor(bus: ControlledRawBus, localPeerId: string, routeId: string) {
		this.#bus = bus;
		this.#localPeerId = localPeerId;
		this.routeId = routeId;
	}

	close(): void {
		this.closed = true;
		this.#listeners.clear();
	}

	emit(bytes: Uint8Array, sender: string): void {
		if (this.closed) return;
		for (const listener of this.#listeners) listener({ bytes: bytes.slice(), sender });
	}

	onMessage(listener: (ingress: { readonly bytes: Uint8Array; readonly sender: string }) => void): () => void {
		if (this.closed) return (): void => undefined;
		this.#listeners.add(listener);
		return (): void => {
			this.#listeners.delete(listener);
		};
	}

	reconcile(peers: readonly string[]): Promise<void> {
		this.reconciledPeers.push([...peers]);
		return Promise.resolve();
	}

	restart(): Promise<void> {
		return Promise.resolve();
	}

	send(peers: readonly string[], bytes: Uint8Array): Promise<boolean> {
		if (this.closed || this.backpressured) return Promise.resolve(false);
		return Promise.resolve(this.#bus.send(this.#localPeerId, this.routeId, peers, bytes));
	}

	snapshot(): DRPUnreliableWebRtcSnapshot {
		return snapshot(this.closed ? [] : (this.reconciledPeers.at(-1) ?? []), this.backpressured ? 1 : 0);
	}
}

export class ControlledRawOwner implements DRPUnreliableWebRtcOwner {
	readonly opened = new Map<string, ControlledRawRoute>();
	readonly #bus: ControlledRawBus;
	readonly #peerId: string;
	closed = false;

	constructor(bus: ControlledRawBus, peerId: string) {
		this.#bus = bus;
		this.#peerId = peerId;
	}

	close(): void {
		this.closed = true;
		for (const route of this.opened.values()) route.close();
	}

	openUnreliableWebRtcRoute(routeId: string): DRPUnreliableWebRtcRoute {
		const existing = this.opened.get(routeId);
		if (existing !== undefined) return existing;
		const route = new ControlledRawRoute(this.#bus, this.#peerId, routeId);
		this.opened.set(routeId, route);
		this.#bus.register(this.#peerId, routeId, route);
		return route;
	}
}

export class ControlledRawBus {
	readonly sends: ControlledRawSend[] = [];
	readonly #connected = new Set<string>();
	readonly #routes = new Map<string, ControlledRawRoute>();

	connect(left: string, right: string): void {
		this.#connected.add(this.#pair(left, right));
	}

	disconnect(left: string, right: string): void {
		this.#connected.delete(this.#pair(left, right));
	}

	inject(recipient: string, routeId: string, sender: string, bytes: Uint8Array): void {
		this.#routes.get(`${recipient}\0${routeId}`)?.emit(bytes, sender);
	}

	owner(peerId: string): ControlledRawOwner {
		return new ControlledRawOwner(this, peerId);
	}

	register(peerId: string, routeId: string, route: ControlledRawRoute): void {
		this.#routes.set(`${peerId}\0${routeId}`, route);
	}

	route(peerId: string, routeId: string): ControlledRawRoute | undefined {
		return this.#routes.get(`${peerId}\0${routeId}`);
	}

	send(sender: string, routeId: string, peers: readonly string[], bytes: Uint8Array): boolean {
		if (peers.length === 0 || bytes.byteLength > 1_167) return false;
		const targets = peers.map((peerId) => ({ peerId, route: this.route(peerId, routeId) }));
		if (
			targets.some(
				({ peerId, route }) =>
					route === undefined || route.closed || route.backpressured || !this.#connected.has(this.#pair(sender, peerId))
			)
		) {
			return false;
		}
		this.sends.push(Object.freeze({ bytes: bytes.slice(), peers: Object.freeze([...peers]), routeId, sender }));
		for (const { route } of targets) route?.emit(bytes, sender);
		return true;
	}

	#pair(left: string, right: string): string {
		return [left, right].sort().join("\0");
	}
}
