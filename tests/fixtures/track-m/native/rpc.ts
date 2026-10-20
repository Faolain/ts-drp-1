import { hex } from "./dump.js";

// Track M, slice 14f: request/response between the creator worker (origin A) and the
// recipient worker (origin B). The product's browser writer exclusion admits one live
// owner per object per origin (packages/node/src/creator-adoption-activate.ts, the
// `ts-drp:<topic>` Web Lock), so, as in the product browser tests, each room runs in its
// own origin. Packets travel worker -> page -> Node child -> other page -> worker as
// JSON text with bytes as hex; nothing else is shared between the two realms.

type Json = Record<string, unknown>;

function fromHex(text: string): Uint8Array {
	const out = new Uint8Array(text.length / 2);
	for (let index = 0; index < out.length; index++)
		out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
	return out;
}

/** @returns JSON text of `value`, bytes as `{ $u8: hex }`. */
export function pack(value: unknown): string {
	return JSON.stringify(value === undefined ? null : value, (_key, item: unknown) =>
		item instanceof Uint8Array ? { $u8: hex(item) } : item
	);
}

/** @returns The value `pack` encoded. */
export function unpack<Value>(text: string): Value {
	return JSON.parse(text, (_key, item: unknown) =>
		item !== null &&
		typeof item === "object" &&
		!Array.isArray(item) &&
		Object.keys(item).length === 1 &&
		typeof (item as { $u8?: unknown }).$u8 === "string"
			? fromHex((item as { $u8: string }).$u8)
			: item
	) as Value;
}

type Handler = (args: unknown) => unknown;
const handlers = new Map<string, Handler>();
const pending = new Map<number, Readonly<{ resolve(value: unknown): void; reject(error: unknown): void }>>();
let next = 1;

/** Serves `method` to the other realm. */
export function serve(method: string, handler: Handler): void {
	handlers.set(method, handler);
}

/** Calls `method` in the other realm. */
export function call<Value>(method: string, args: unknown = null): Promise<Value> {
	const id = next++;
	return new Promise<Value>((resolve, reject) => {
		pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
		postMessage({ kind: "rpc-call", id, method, args: pack(args) });
	});
}

function describe(error: unknown): Json {
	return error instanceof Error
		? { name: error.name, message: error.message, stack: error.stack, code: (error as { code?: unknown }).code }
		: { message: String(error) };
}

/**
 * Handles one relayed packet.
 * @returns Whether the packet was an RPC packet.
 */
export function receive(data: Json): boolean {
	if (data.kind === "rpc-reply") {
		const waiting = pending.get(Number(data.id));
		pending.delete(Number(data.id));
		if (waiting === undefined) return true;
		if (data.ok === true) waiting.resolve(unpack(String(data.value)));
		else {
			const error = data.error as Json;
			const failure = new Error(`TRACK_M_14F_REMOTE ${String(data.method)}: ${String(error.message)}`);
			Object.assign(failure, { remote: error });
			waiting.reject(failure);
		}
		return true;
	}
	if (data.kind !== "rpc-call") return false;
	const handler = handlers.get(String(data.method));
	void (async (): Promise<void> => {
		try {
			if (handler === undefined) throw new TypeError(`TRACK_M_14F_NO_HANDLER ${String(data.method)}`);
			const value = await handler(unpack(String(data.args)));
			postMessage({ kind: "rpc-reply", id: data.id, method: data.method, ok: true, value: pack(value) });
		} catch (error) {
			postMessage({ kind: "rpc-reply", id: data.id, method: data.method, ok: false, error: describe(error) });
		}
	})();
	return true;
}
