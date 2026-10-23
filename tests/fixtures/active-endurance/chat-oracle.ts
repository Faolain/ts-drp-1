import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";

import type { RoleEndpoint } from "../track-m-apps/long-room-driver.js";

interface Message {
	author: string;
	clientOperationId: string;
	displayTimeMs: number;
	text: string;
}
interface State {
	version: 5;
	messages: Message[];
	capacity: { windowBytes: number; allocations: [string, number, number][] };
}
const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const parse = (value: string): State =>
	decodeCanonical(Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16))) as unknown as State;

/**
 * Independent application-policy oracle. The room supplies the authenticated
 * protocol order, but neither its reducer nor its resulting message window is
 * used to decide retention. Every successor base must equal the independently
 * frozen preceding cut. Protocol ordering and signature validity have separate gates.
 */
export class ChatWindowOracle {
	private readonly bases = new Map<number, State>();
	/**
	 *
	 * @param genesis - Exact signed empty Chat v5 state as hex.
	 */
	constructor(genesis: string) {
		const state = parse(genesis);
		if (state.version !== 5 || state.messages.length !== 0) throw new Error("ENDURANCE_CHAT_GENESIS");
		this.bases.set(0, state);
	}
	/**
	 *
	 * @param peer - Creator endpoint reporting the protocol projection order.
	 * @param freezeSuccessor - Successor epoch to bind to this exact closed-cut state.
	 */
	async check(peer: RoleEndpoint, freezeSuccessor?: number): Promise<void> {
		const audit = await peer.projectionAudit();
		const epoch = audit.base?.epoch ?? 0;
		const base = this.bases.get(epoch);
		if (base === undefined) throw new Error(`ENDURANCE_CHAT_MODEL_BASE_ABSENT:${epoch}`);
		if (audit.base !== null && audit.base.state !== hex(encodeCanonical(base)))
			throw new Error(`ENDURANCE_CHAT_BASE_DIVERGED:${epoch}`);
		const state: State = structuredClone(base);
		for (const row of audit.operations) {
			if (row.operation.action !== "message") continue;
			const message: Message = {
				author: row.author,
				clientOperationId: String(row.operation.clientOperationId),
				displayTimeMs: Number(row.operation.displayTimeMs),
				text: String(row.operation.text),
			};
			const previous = state.messages.findIndex(
				(value) => value.author === message.author && value.clientOperationId === message.clientOperationId
			);
			if (previous >= 0) {
				const removed = state.messages.splice(previous, 1)[0];
				if (removed === undefined) throw new Error("ENDURANCE_CHAT_RETRY_ABSENT");
				if (hex(encodeCanonical(removed)) !== hex(encodeCanonical(message)))
					throw new Error("ENDURANCE_CHAT_IDENTITY_CONFLICT");
			}
			state.messages.push(message);
			const budget = new Map(state.capacity.allocations.map(([author, bytes]) => [author, bytes]));
			const charge = new Map<string, number>();
			let total = 0;
			for (const value of state.messages) {
				const bytes = encodeCanonical(value).byteLength;
				total += bytes;
				charge.set(value.author, (charge.get(value.author) ?? 0) + bytes);
			}
			while (total > state.capacity.windowBytes) {
				let index = state.messages.findIndex((value) => !budget.has(value.author));
				if (index < 0)
					index = state.messages.findIndex(
						(value) => (charge.get(value.author) ?? 0) > (budget.get(value.author) ?? 0)
					);
				if (index < 0) throw new Error("ENDURANCE_CHAT_CANNOT_RECLAIM");
				const removed = state.messages.splice(index, 1)[0];
				if (removed === undefined) throw new Error("ENDURANCE_CHAT_RECLAIM_ABSENT");
				const bytes = encodeCanonical(removed).byteLength;
				total -= bytes;
				charge.set(removed.author, (charge.get(removed.author) ?? 0) - bytes);
			}
		}
		if ((await peer.state()) !== hex(encodeCanonical(state)))
			throw new Error(`ENDURANCE_CHAT_WINDOW_DIVERGED:${epoch}`);
		if (freezeSuccessor !== undefined) this.bases.set(freezeSuccessor, state);
		for (const retained of this.bases.keys()) if (retained < epoch - 1) this.bases.delete(retained);
	}
}
