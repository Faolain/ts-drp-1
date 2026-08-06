import { Message, MessageType, Sync, SyncAccept } from "@ts-drp/types";

export const DRP_MESSAGE_PROTOCOL = "/drp/message/0.0.1";
export const DRP_HEADS_CHUNK_PROTOCOL = "/drp/message/1.0.0/heads-chunk";
export const DRP_SYNC_PROTOCOLS = [DRP_HEADS_CHUNK_PROTOCOL, DRP_MESSAGE_PROTOCOL] as const;

export const SYNC_HEADS_FIELD_HASH_CAP = 32;
export const SYNC_HEADS_TOTAL_HASH_CAP = 64;
export const SYNC_FALLBACK_HASH_CAP = 512;
export const SYNC_REQUEST_BYTE_CAP = 65_536;
export const SYNC_RESPONSE_VERTEX_CAP = 32;
export const SYNC_RESPONSE_BYTE_CAP = 262_144;
export const SYNC_RESPONSE_CHUNK_CAP = 4;
export const SYNC_OUTSTANDING_EXACT_CAP = 64;

export type DRPSyncProtocol = (typeof DRP_SYNC_PROTOCOLS)[number];
export type DRPSyncMode = "fallback" | "heads-chunk";

export interface SelectedSyncProtocol {
	readonly mode: DRPSyncMode;
	readonly protocol: DRPSyncProtocol;
}

export interface NegotiatedSyncSender {
	sendSyncMessage(
		peerId: string,
		payloadFactory: (selection: SelectedSyncProtocol) => Message | Promise<Message>,
		options?: { readonly signal?: AbortSignal }
	): Promise<void>;
	sendSyncResponseMessage(peerId: string, message: Message, options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export class SyncTransportError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SyncTransportError";
		this.code = code;
	}
}

class DirectSyncCompletion {
	private claimed = false;
	private readonly settled: Promise<void>;
	private reject!: (reason?: unknown) => void;
	private resolve!: () => void;

	constructor() {
		this.settled = new Promise<void>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	claim(result: void | Promise<void>): void {
		if (this.claimed) {
			const error = new SyncTransportError(
				"SYNC_ADMISSION_ALREADY_CLAIMED",
				"Direct sync admission already has an owner"
			);
			this.reject(error);
			throw error;
		}
		this.claimed = true;
		Promise.resolve(result).then(this.resolve, this.reject);
	}

	isClaimed(): boolean {
		return this.claimed;
	}

	wait(): Promise<void> {
		return this.settled;
	}
}

const authenticDirectSyncIngress = new WeakSet<object>();
const directSyncSelections = new WeakMap<Message, SelectedSyncProtocol>();

/** Private in-process ingress contract; this object is never serialized. */
export interface DirectSyncIngress {
	readonly message: Message;
	readonly mode: DRPSyncMode;
	readonly peerId: string;
	readonly protocol: DRPSyncProtocol;
	readonly transport: "direct";
	readonly completion: DirectSyncCompletion;
}

export function createDirectSyncIngress(
	message: Message,
	peerId: string,
	protocol: DRPSyncProtocol
): DirectSyncIngress {
	const ingress: DirectSyncIngress = {
		completion: new DirectSyncCompletion(),
		message,
		mode: syncModeForProtocol(protocol),
		peerId,
		protocol,
		transport: "direct",
	};
	authenticDirectSyncIngress.add(ingress);
	directSyncSelections.set(message, selectedSyncProtocol(protocol));
	return ingress;
}

/** Read unforgeable selected-stream truth attached at authenticated decode. */
export function directSyncProtocolFor(message: Message): SelectedSyncProtocol | undefined {
	return directSyncSelections.get(message);
}

export function isSyncProtocolMessage(message: Message): boolean {
	return (
		message.type === MessageType.MESSAGE_TYPE_SYNC ||
		message.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT ||
		message.type === MessageType.MESSAGE_TYPE_SYNC_REJECT
	);
}

export function isDirectSyncIngress(value: unknown): value is DirectSyncIngress {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<DirectSyncIngress>;
	return (
		authenticDirectSyncIngress.has(value) &&
		candidate.transport === "direct" &&
		typeof candidate.peerId === "string" &&
		typeof candidate.protocol === "string" &&
		candidate.message !== undefined &&
		candidate.completion instanceof DirectSyncCompletion
	);
}

export function syncModeForProtocol(protocol: string): DRPSyncMode {
	if (protocol === DRP_HEADS_CHUNK_PROTOCOL) return "heads-chunk";
	if (protocol === DRP_MESSAGE_PROTOCOL) return "fallback";
	throw new SyncTransportError("SYNC_PROTOCOL_UNKNOWN", `Unsupported sync protocol: ${protocol}`);
}

export function selectedSyncProtocol(protocol: string): SelectedSyncProtocol {
	return { mode: syncModeForProtocol(protocol), protocol: protocol as DRPSyncProtocol };
}

/** Validate negotiated Sync fields and actual encoded request bytes before admission. */
export function validateNegotiatedSync(message: Message, protocol: string): void {
	if (message.type === MessageType.MESSAGE_TYPE_SYNC_REJECT) {
		syncModeForProtocol(protocol);
		if (Message.encode(message).finish().byteLength > SYNC_RESPONSE_BYTE_CAP) {
			throw new SyncTransportError("SYNC_RESPONSE_LIMIT", "Sync rejection exceeds the v1 byte ceiling");
		}
		return;
	}
	if (message.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT) {
		syncModeForProtocol(protocol);
		let response: SyncAccept;
		try {
			response = SyncAccept.decode(message.data);
		} catch (cause) {
			throw new SyncTransportError("SYNC_PROTOCOL_VIOLATION", "Sync response is not canonical protobuf", {
				cause,
			});
		}
		if (
			response.requested.length > SYNC_RESPONSE_VERTEX_CAP ||
			Message.encode(message).finish().byteLength > SYNC_RESPONSE_BYTE_CAP
		) {
			throw new SyncTransportError("SYNC_RESPONSE_LIMIT", "Sync response exceeds the v1 sync ceiling");
		}
		return;
	}
	if (message.type !== MessageType.MESSAGE_TYPE_SYNC) return;
	const mode = syncModeForProtocol(protocol);
	let sync: Sync;
	try {
		sync = Sync.decode(message.data);
	} catch (cause) {
		throw new SyncTransportError("SYNC_PROTOCOL_VIOLATION", "Sync payload is not canonical protobuf", {
			cause,
		});
	}

	if (mode === "fallback") {
		if (sync.heads.length !== 0 || sync.sharedHeads.length !== 0 || sync.requestedHashes.length !== 0) {
			throw new SyncTransportError("SYNC_PROTOCOL_VIOLATION", "Heads fields are forbidden on fallback sync");
		}
		if (sync.vertexHashes.length > SYNC_FALLBACK_HASH_CAP || message.data.byteLength > SYNC_REQUEST_BYTE_CAP) {
			throw new SyncTransportError("SYNC_FALLBACK_LIMIT", "Fallback inventory exceeds the v1 sync ceiling");
		}
		return;
	}

	if (sync.vertexHashes.length !== 0) {
		throw new SyncTransportError("SYNC_PROTOCOL_VIOLATION", "Fallback inventory is forbidden on heads sync");
	}
	const fields = [sync.heads, sync.sharedHeads, sync.requestedHashes] as const;
	const total = fields.reduce((count, hashes) => count + hashes.length, 0);
	if (
		fields.some((hashes) => hashes.length > SYNC_HEADS_FIELD_HASH_CAP) ||
		total > SYNC_HEADS_TOTAL_HASH_CAP ||
		message.data.byteLength > SYNC_REQUEST_BYTE_CAP
	) {
		throw new SyncTransportError("SYNC_REQUEST_LIMIT", "Heads request exceeds the v1 sync ceiling");
	}
}
