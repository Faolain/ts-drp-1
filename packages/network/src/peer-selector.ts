import {
	type PeerDiscovery,
	peerDiscoverySymbol,
	type PeerId,
	type PeerInfo,
	type PeerUpdate,
} from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import { type Libp2p } from "libp2p";

import { type ConnectionAdmissionController } from "./connection-budget.js";

interface RemoteRouteGroup {
	readonly addresses: readonly Multiaddr[];
	readonly peerId: PeerId;
}

interface ProtobufField {
	readonly bytes?: Uint8Array;
	readonly number: number;
	readonly wire: number;
}

function readVarint(bytes: Uint8Array, start: number): readonly [number, number] {
	let offset = start;
	let multiplier = 1;
	let value = 0;
	for (let index = 0; index < 10 && offset < bytes.length; index++) {
		const byte = bytes[offset++];
		if (byte === undefined) break;
		value += (byte & 0x7f) * multiplier;
		if (!Number.isSafeInteger(value)) throw new Error("signed peer record varint exceeds the safe range");
		if ((byte & 0x80) === 0) return [value, offset];
		multiplier *= 128;
	}
	throw new Error("signed peer record has a malformed varint");
}

function skipVarint(bytes: Uint8Array, start: number): number {
	let offset = start;
	for (let index = 0; index < 10 && offset < bytes.length; index++) {
		const byte = bytes[offset++];
		if (byte !== undefined && (byte & 0x80) === 0) return offset;
	}
	throw new Error("signed peer record has a malformed varint");
}

function decodeProtobufFields(bytes: Uint8Array): readonly ProtobufField[] {
	const fields: ProtobufField[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		const [tag, afterTag] = readVarint(bytes, offset);
		offset = afterTag;
		const number = Math.floor(tag / 8);
		const wire = tag & 7;
		if (number === 0) throw new Error("signed peer record has a zero field number");
		if (wire === 0) {
			offset = skipVarint(bytes, offset);
			fields.push({ number, wire });
			continue;
		}
		if (wire === 1 || wire === 5) {
			offset += wire === 1 ? 8 : 4;
			if (offset > bytes.length) throw new Error("signed peer record has a truncated fixed-width field");
			fields.push({ number, wire });
			continue;
		}
		if (wire !== 2) throw new Error("signed peer record has an unsupported wire type");
		const [length, afterLength] = readVarint(bytes, offset);
		offset = afterLength;
		const end = offset + length;
		if (end > bytes.length) throw new Error("signed peer record has a truncated length-delimited field");
		fields.push({ bytes: bytes.slice(offset, end), number, wire });
		offset = end;
	}
	return fields;
}

function decodeSignedPeerRecordAddresses(record: Uint8Array): readonly Multiaddr[] {
	const payloads = decodeProtobufFields(record).filter(({ number, wire }) => number === 3 && wire === 2);
	if (payloads.length !== 1 || payloads[0]?.bytes === undefined) {
		throw new Error("signed peer record envelope must contain one payload");
	}
	return decodeProtobufFields(payloads[0].bytes)
		.filter(({ number, wire }) => number === 3 && wire === 2)
		.map(({ bytes }) => {
			if (bytes === undefined) throw new Error("signed peer record address wrapper is absent");
			const addresses = decodeProtobufFields(bytes).filter(({ number, wire }) => number === 1 && wire === 2);
			if (addresses.length !== 1 || addresses[0]?.bytes === undefined) {
				throw new Error("signed peer record address wrapper must contain one multiaddr");
			}
			return multiaddr(addresses[0].bytes);
		});
}

function isPeerId(value: unknown): value is PeerId {
	return (
		typeof value === "object" &&
		value !== null &&
		"equals" in value &&
		typeof value.equals === "function" &&
		"toString" in value &&
		typeof value.toString === "function"
	);
}

function terminalPeerId(address: Multiaddr): string | undefined {
	return address
		.getComponents()
		.filter(({ name }) => name === "p2p")
		.at(-1)?.value;
}

function routePeerIds(address: Multiaddr): string[] {
	return address
		.getComponents()
		.filter(({ name, value }) => name === "p2p" && value !== undefined)
		.map(({ value }) => value as string);
}

/** Synchronous source adapter into the single combined T1/T3 controller. */
export class PeerSelector {
	readonly #controller: ConnectionAdmissionController;
	readonly #sourceDiscovered = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #detach: Array<() => void> = [];

	/**
	 * Create one source adapter for the host lifecycle.
	 * @param controller - The combined T1/T3 admission owner.
	 */
	constructor(controller: ConnectionAdmissionController) {
		this.#controller = controller;
	}

	/**
	 * Wrap component access so dependency-owned dials cross the pre-queue owner.
	 * @param components - The dependency factory's concrete component set.
	 * @returns A component view with the owned connection-manager boundary.
	 */
	wrapComponents<T extends object>(components: T): T {
		return new Proxy(components, {
			get: (target, property, receiver): unknown => {
				const value = Reflect.get(target, property, receiver) as unknown;
				if (typeof value !== "object" || value === null) return value;
				if (property === "connectionManager") return this.#controller.wrapConnectionManager(value);
				if (property === "transportManager") return this.#controller.wrapTransportManager(value);
				return value;
			},
		});
	}

	/**
	 * Attach discovery emitted by a configured factory or extension service.
	 * @param candidate - A constructed service that may expose peer discovery.
	 */
	attachDiscovery(candidate: unknown): void {
		if (typeof candidate !== "object" || candidate === null || !(peerDiscoverySymbol in candidate)) return;
		const advertised = (candidate as { [peerDiscoverySymbol]: unknown })[peerDiscoverySymbol];
		const discovery =
			typeof advertised === "object" && advertised !== null && "addEventListener" in advertised
				? (advertised as PeerDiscovery)
				: (candidate as unknown as PeerDiscovery);
		if (typeof discovery.addEventListener !== "function") return;
		const listener = (event: CustomEvent<PeerInfo>): void => this.#observePeerInfo(event.detail, true);
		discovery.addEventListener("peer", listener);
		this.#detach.push(() => discovery.removeEventListener("peer", listener));
	}

	/**
	 * Attach the concrete host's normalized discovery and signed peer-record evidence.
	 * @param host - The concrete production libp2p host.
	 */
	attachHost(host: Libp2p): void {
		const peerStoreMutations = new Map<string, number>();
		const duringPeerStoreMutation = async <T>(peerId: PeerId, operation: () => Promise<T>): Promise<T> => {
			const key = peerId.toString();
			peerStoreMutations.set(key, (peerStoreMutations.get(key) ?? 0) + 1);
			try {
				return await operation();
			} finally {
				const remaining = (peerStoreMutations.get(key) ?? 0) - 1;
				if (remaining > 0) peerStoreMutations.set(key, remaining);
				else peerStoreMutations.delete(key);
			}
		};
		const onDiscovery = (event: CustomEvent<PeerInfo>): void => {
			const peerId = isPeerId(event.detail?.id) ? event.detail.id.toString() : undefined;
			if (peerId === undefined || (peerStoreMutations.get(peerId) ?? 0) === 0) {
				this.#observePeerInfo(event.detail, false);
			}
		};
		const onUpdate = (event: CustomEvent<PeerUpdate>): void => {
			const peer = event.detail.peer;
			if (peer.peerRecordEnvelope !== undefined) return;
			const sourceTimer = this.#sourceDiscovered.get(peer.id.toString());
			if (sourceTimer !== undefined) {
				clearTimeout(sourceTimer);
				this.#sourceDiscovered.delete(peer.id.toString());
				return;
			}
			this.#controller.revokeDiscoveredPeer(peer.id);
		};
		const merge = host.peerStore.merge.bind(host.peerStore);
		host.peerStore.merge = async (peerId, data, options): ReturnType<typeof merge> => {
			const { addresses, peerRecordEnvelope: _untrustedEnvelope, ...rest } = data;
			return duringPeerStoreMutation(peerId, () =>
				merge(
					peerId,
					{
						...rest,
						...(addresses === undefined
							? {}
							: {
									addresses: addresses.map(({ multiaddr }) => ({ isCertified: false, multiaddr })),
								}),
					},
					options
				)
			);
		};
		const patch = host.peerStore.patch.bind(host.peerStore);
		host.peerStore.patch = (peerId, data, options): ReturnType<typeof patch> =>
			duringPeerStoreMutation(peerId, () => patch(peerId, data, options));
		const save = host.peerStore.save.bind(host.peerStore);
		host.peerStore.save = (peerId, data, options): ReturnType<typeof save> =>
			duringPeerStoreMutation(peerId, () => save(peerId, data, options));
		const consumePeerRecord = host.peerStore.consumePeerRecord.bind(host.peerStore);
		host.peerStore.consumePeerRecord = async (record, options): Promise<boolean> => {
			const expectedPeer = options?.expectedPeer;
			if (expectedPeer === undefined || !isPeerId(expectedPeer)) return consumePeerRecord(record, options);
			const verifiedRecord = record.slice();
			const addresses = decodeSignedPeerRecordAddresses(verifiedRecord);
			const consumed = await consumePeerRecord(verifiedRecord, options);
			if (consumed) this.#controller.admitDiscoveredPeer(expectedPeer, addresses);
			return consumed;
		};
		host.addEventListener("peer:discovery", onDiscovery);
		host.addEventListener("peer:update", onUpdate);
		this.#detach.push(() => {
			host.peerStore.merge = merge;
			host.peerStore.patch = patch;
			host.peerStore.save = save;
			host.peerStore.consumePeerRecord = consumePeerRecord;
		});
		this.#detach.push(() => host.removeEventListener("peer:discovery", onDiscovery));
		this.#detach.push(() => host.removeEventListener("peer:update", onUpdate));
	}

	/**
	 * Partition remote records by terminal peer and admit each group independently.
	 * @param addresses - Remote routes supplied by an owned discovery response.
	 * @returns Canonical terminal-peer groups admitted by the shared controller.
	 */
	admitRemoteRoutes(addresses: readonly Multiaddr[]): readonly RemoteRouteGroup[] {
		const groups = new Map<string, Multiaddr[]>();
		for (const address of addresses) {
			const peerId = terminalPeerId(address);
			if (peerId === undefined) {
				this.#controller.recordDenied();
				continue;
			}
			groups.set(peerId, [...(groups.get(peerId) ?? []), address]);
		}
		const admitted: RemoteRouteGroup[] = [];
		for (const [peerIdText, group] of groups) {
			let peerId: PeerId | undefined;
			try {
				const candidate = group[0]?.getComponents().findLast(({ name }) => name === "p2p")?.value;
				if (candidate !== peerIdText) throw new Error("terminal peer mismatch");
				peerId = peerIdFromString(peerIdText);
			} catch {
				this.#controller.recordDenied();
				continue;
			}
			const routePeers: PeerId[] = [];
			try {
				for (const routePeerId of new Set(group.flatMap((address) => routePeerIds(address)))) {
					routePeers.push(peerIdFromString(routePeerId));
				}
			} catch {
				this.#controller.recordDenied();
				continue;
			}
			if (this.#controller.admitDiscoveredPeers(routePeers, group)) admitted.push({ addresses: group, peerId });
		}
		return admitted;
	}

	/** Detach every source listener and clear transient envelope evidence. */
	stop(): void {
		for (const detach of this.#detach.splice(0)) detach();
		for (const timer of this.#sourceDiscovered.values()) clearTimeout(timer);
		this.#sourceDiscovered.clear();
	}

	#observePeerInfo(info: PeerInfo, sourceOwned: boolean): void {
		if (!isPeerId(info?.id) || !Array.isArray(info.multiaddrs)) {
			this.#controller.recordDenied();
			return;
		}
		if (this.#controller.admitDiscoveredPeer(info.id, [...info.multiaddrs]) && sourceOwned) {
			const peerId = info.id.toString();
			const existing = this.#sourceDiscovered.get(peerId);
			if (existing !== undefined) clearTimeout(existing);
			const timer = setTimeout(() => this.#sourceDiscovered.delete(peerId), 60_000);
			(timer as ReturnType<typeof setTimeout> & { unref?(): void }).unref?.();
			this.#sourceDiscovered.set(peerId, timer);
		}
	}
}
