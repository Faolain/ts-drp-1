import { peerIdFromString } from "@libp2p/peer-id";
import { lpStream } from "@libp2p/utils";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";

import type {
	RelayCandidate,
	RelayInspection,
	RelayInspector,
	RelayReservationClient,
	RelayReservationWireResponse,
} from "./index.js";
import { CIRCUIT_RELAY_V2_HOP_PROTOCOL, RELAY_RESERVATION_STATUS } from "./protocol.js";

interface CircuitRelayHost extends Pick<Libp2p, "getConnections" | "getMultiaddrs" | "peerStore"> {
	readonly components: {
		readonly transportManager: {
			getListeners(): Array<{ close(): Promise<void>; getAddrs(): Multiaddr[] }>;
			listen(addresses: Multiaddr[]): Promise<void>;
		};
	};
}

export interface Libp2pRelayClientOptions {
	connect(address: string, signal: AbortSignal): Promise<void>;
	disconnect(peerId: string): Promise<void>;
	readonly host: CircuitRelayHost;
	readonly identifyTimeoutMs?: number;
	readonly reservationTimeoutMs?: number;
}

interface CircuitListenerHandle {
	close(): Promise<void>;
}

interface LiveCircuitReservation {
	address: string;
	candidate: RelayCandidate;
	disconnected: boolean;
	readonly listeners: Set<CircuitListenerHandle>;
}

/**
 * One reusable owner for libp2p Identify and Circuit Relay v2 HOP/RESERVE wire mechanics.
 * Relay selection, diversity, retry, and terminal policy remain in `RelayPolicy`.
 */
export class Libp2pRelayClient implements RelayInspector, RelayReservationClient {
	readonly #active = new Map<string, LiveCircuitReservation>();
	readonly #connect: Libp2pRelayClientOptions["connect"];
	readonly #disconnect: Libp2pRelayClientOptions["disconnect"];
	readonly #host: CircuitRelayHost;
	readonly #identifyTimeoutMs: number;
	readonly #inspectedAddresses = new Map<string, string>();
	readonly #reservationTimeoutMs: number;

	constructor(options: Libp2pRelayClientOptions) {
		this.#host = options.host;
		this.#connect = options.connect;
		this.#disconnect = options.disconnect;
		this.#identifyTimeoutMs = boundedTimeout(options.identifyTimeoutMs ?? 3_000);
		this.#reservationTimeoutMs = boundedTimeout(options.reservationTimeoutMs ?? 3_000);
	}

	/** Returns defensive snapshots of circuit listen addresses owned by this client. */
	get activeCircuitAddresses(): readonly string[] {
		return [...this.#active.values()].map(({ address }) => address);
	}

	async inspect(candidate: RelayCandidate, address: string, signal: AbortSignal): Promise<RelayInspection> {
		const startedAt = performance.now();
		try {
			const peerId = peerIdFromString(candidate.peerId);
			await this.#connect(address, signal);
			const connection = await waitForValue(
				() => this.#host.getConnections(peerId)[0],
				this.#identifyTimeoutMs,
				signal
			);
			const peer = await waitForValue(
				async () => {
					const current = await this.#host.peerStore.get(peerId);
					return current.protocols.length > 0 ? current : undefined;
				},
				this.#identifyTimeoutMs,
				signal
			);
			this.#inspectedAddresses.set(candidate.peerId, address);
			return {
				connectionId: connection.id,
				hopAdvertised: peer.protocols.includes(CIRCUIT_RELAY_V2_HOP_PROTOCOL),
				latencyMs: performance.now() - startedAt,
				outcome: "connected",
				protocols: [...peer.protocols],
			};
		} catch (error) {
			return {
				hopAdvertised: false,
				latencyMs: performance.now() - startedAt,
				outcome: signal.aborted ? "aborted" : error instanceof RelayClientTimeoutError ? "timeout" : "refused",
				protocols: [],
			};
		}
	}

	async reserve(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse> {
		const relayAddress = this.#inspectedAddresses.get(candidate.peerId) ?? candidate.addresses[0];
		if (relayAddress === undefined) return { status: RELAY_RESERVATION_STATUS.CONNECTION_FAILED };
		await this.#connect(relayAddress, signal);
		const response = await this.#requestReservation(candidate, signal);
		if (response.status !== RELAY_RESERVATION_STATUS.OK) return response;

		const circuitAddress = multiaddr(`${relayAddress}/p2p-circuit`);
		try {
			if (!this.#hasAdvertisedCircuit(candidate.peerId)) {
				await this.#host.components.transportManager.listen([circuitAddress]);
				this.#rememberMatchingListeners(candidate, circuitAddress.toString());
			}
			const advertised = await waitForValue(
				() => this.#host.getMultiaddrs().find((address) => isCircuitForPeer(address.toString(), candidate.peerId)),
				this.#reservationTimeoutMs,
				signal
			);
			const listener = await waitForValue(
				() =>
					this.#host.components.transportManager
						.getListeners()
						.find((value) =>
							value.getAddrs().some((address) => isCircuitForPeer(address.toString(), candidate.peerId))
						),
				this.#reservationTimeoutMs,
				signal
			);
			this.#rememberListener(candidate, advertised.toString(), listener);
			return response;
		} catch (error) {
			this.#rememberMatchingListeners(candidate, circuitAddress.toString());
			throw error;
		}
	}

	refresh(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse> {
		return this.reserve(candidate, signal);
	}

	async release(candidate: RelayCandidate): Promise<void> {
		const active = this.#active.get(candidate.peerId);
		const failures: unknown[] = [];
		if (active !== undefined) {
			for (const listener of [...active.listeners]) {
				try {
					await listener.close();
					active.listeners.delete(listener);
				} catch (error) {
					failures.push(error);
				}
			}
		}
		if (active?.disconnected !== true) {
			try {
				await this.#disconnect(candidate.peerId);
				if (active !== undefined) active.disconnected = true;
			} catch (error) {
				failures.push(error);
			}
		}
		if (active === undefined || (active.listeners.size === 0 && active.disconnected)) {
			this.#active.delete(candidate.peerId);
			this.#inspectedAddresses.delete(candidate.peerId);
		}
		if (failures.length > 0) throw new AggregateError(failures, "relay listener or connection release failed");
	}

	/** Releases every listener and relay connection acquired by this client. */
	async stop(): Promise<void> {
		const candidates = [...this.#active.values()].map(({ candidate }) => candidate);
		await Promise.all(candidates.map(async (candidate) => this.release(candidate)));
	}

	#hasAdvertisedCircuit(peerId: string): boolean {
		return this.#host.getMultiaddrs().some((address) => isCircuitForPeer(address.toString(), peerId));
	}

	#rememberMatchingListeners(candidate: RelayCandidate, address: string): void {
		for (const listener of this.#host.components.transportManager.getListeners()) {
			if (listener.getAddrs().some((value) => isCircuitForPeer(value.toString(), candidate.peerId))) {
				this.#rememberListener(candidate, address, listener);
			}
		}
	}

	#rememberListener(candidate: RelayCandidate, address: string, listener: CircuitListenerHandle): void {
		const active = this.#active.get(candidate.peerId) ?? {
			address,
			candidate,
			disconnected: false,
			listeners: new Set<CircuitListenerHandle>(),
		};
		active.address = address;
		active.candidate = candidate;
		active.disconnected = false;
		active.listeners.add(listener);
		this.#active.set(candidate.peerId, active);
	}

	async #requestReservation(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse> {
		const peerId = peerIdFromString(candidate.peerId);
		const connection = await waitForValue(
			() => this.#host.getConnections(peerId)[0],
			this.#reservationTimeoutMs,
			signal
		);
		const stream = await connection.newStream(CIRCUIT_RELAY_V2_HOP_PROTOCOL, { signal });
		const framed = lpStream(stream, { maxDataLength: 4_096 });
		try {
			await framed.write(Uint8Array.of(8, 0), { signal });
			const response = await framed.read({ signal });
			try {
				return decodeHopReservationResponse(response.subarray());
			} catch {
				return { status: RELAY_RESERVATION_STATUS.MALFORMED_MESSAGE };
			}
		} finally {
			if (stream.status !== "closed") await stream.close().catch(() => undefined);
		}
	}
}

/** Decodes a length-delimited Relay v2 HopMessage response. */
export function decodeHopReservationResponse(bytes: Uint8Array): RelayReservationWireResponse {
	const fields = decodeProtobufFields(bytes);
	const statuses = fields.filter(({ field, wire }) => field === 5 && wire === 0);
	const statusValue = statuses[0]?.value;
	if (statuses.length !== 1 || typeof statusValue !== "bigint" || statusValue > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("Circuit Relay v2 HOP response omitted one safe status enum");
	}
	const reservationValue = fields.find(({ field, wire }) => field === 3 && wire === 2)?.value;
	const limitValue = fields.find(({ field, wire }) => field === 4 && wire === 2)?.value;
	const reservationFields = reservationValue instanceof Uint8Array ? decodeProtobufFields(reservationValue) : [];
	const limitFields = limitValue instanceof Uint8Array ? decodeProtobufFields(limitValue) : [];
	const expire = reservationFields.find(({ field, wire }) => field === 1 && wire === 0)?.value;
	const duration = limitFields.find(({ field, wire }) => field === 1 && wire === 0)?.value;
	const data = limitFields.find(({ field, wire }) => field === 2 && wire === 0)?.value;
	if (typeof duration === "bigint" && duration > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("Circuit Relay v2 duration exceeded the safe integer range");
	}
	return {
		...(typeof expire === "bigint" ? { reservation: { expire } } : {}),
		...(typeof duration === "bigint" || typeof data === "bigint"
			? {
					limit: {
						...(typeof data === "bigint" ? { data } : {}),
						...(typeof duration === "bigint" ? { duration: Number(duration) } : {}),
					},
				}
			: {}),
		status: Number(statusValue),
	};
}

function decodeProtobufFields(
	bytes: Uint8Array
): Array<{ readonly field: number; readonly value: bigint | Uint8Array; readonly wire: 0 | 2 }> {
	const fields: Array<{ field: number; value: bigint | Uint8Array; wire: 0 | 2 }> = [];
	let offset = 0;
	while (offset < bytes.byteLength) {
		const tag = readVarint(bytes, offset);
		offset = tag.next;
		const field = Number(tag.value >> BigInt(3));
		const wire = Number(tag.value & BigInt(7));
		if (field < 1 || (wire !== 0 && wire !== 2)) throw new Error("unsupported Relay v2 protobuf field");
		if (wire === 0) {
			const scalar = readVarint(bytes, offset);
			offset = scalar.next;
			fields.push({ field, value: scalar.value, wire });
			continue;
		}
		const length = readVarint(bytes, offset);
		if (length.value > BigInt(bytes.byteLength)) throw new Error("invalid Relay v2 protobuf length");
		offset = length.next;
		const end = offset + Number(length.value);
		if (end > bytes.byteLength) throw new Error("truncated Relay v2 protobuf field");
		fields.push({ field, value: bytes.slice(offset, end), wire });
		offset = end;
	}
	return fields;
}

function readVarint(bytes: Uint8Array, offset: number): { readonly next: number; readonly value: bigint } {
	let value = BigInt(0);
	for (let shift = BigInt(0); shift <= BigInt(63) && offset < bytes.byteLength; shift += BigInt(7)) {
		const byte = bytes[offset++] ?? 0;
		value |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return { next: offset, value };
	}
	throw new Error("invalid Relay v2 protobuf varint");
}

async function waitForValue<T>(
	read: () => Promise<T | undefined> | T | undefined,
	timeoutMs: number,
	signal: AbortSignal
): Promise<T> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		signal.throwIfAborted();
		const value = await read();
		if (value !== undefined) return value;
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
	throw new RelayClientTimeoutError();
}

function isCircuitForPeer(address: string, peerId: string): boolean {
	return address.includes(`/p2p/${peerId}/p2p-circuit`);
}

function boundedTimeout(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > 30_000)
		throw new Error("relay timeout must be within 1..30000ms");
	return value;
}

class RelayClientTimeoutError extends Error {}
