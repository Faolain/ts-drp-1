// Track M, slice 14f: the page. It runs the scenario in a dedicated worker (needed for
// Atomics.wait), relays the worker's messages to the console for the Node child, and,
// for case 3, starts the foreign writer in a second worker and relays between them. The
// creator's page and the recipient's page (two origins, see rpc.ts) exchange RPC packets
// through the Node child: `__tm14fRelay` (exposed by the child) sends one to the other
// page, and the child calls `__tm14fDeliver` here to hand one to this page's worker.

const parameters = new URLSearchParams(location.search);
const encoded = parameters.get("input");
if (encoded === null) throw new TypeError("TRACK_M_14F_MISSING_INPUT");
const input = JSON.parse(atob(encoded)) as Record<string, unknown>;
const order = new Int32Array(new SharedArrayBuffer(16));
const LIMIT = 24_000;
let chunks = 0;

function emit(data: unknown): void {
	const text = JSON.stringify(data, (_key, value: unknown) =>
		value instanceof Uint8Array ? { $u8: value.byteLength } : value
	);
	if (text.length <= LIMIT) {
		console.log(`TM14F:${text}`);
		return;
	}
	const id = `c${++chunks}`;
	const total = Math.ceil(text.length / LIMIT);
	for (let index = 0; index < total; index++)
		console.log(`TM14FC:${id}:${index}:${total}:${text.slice(index * LIMIT, (index + 1) * LIMIT)}`);
}

const worker = new Worker(new URL("./tm14f-worker.js", import.meta.url), { type: "module" });
let foreign: Worker | undefined;
const relay = Reflect.get(window, "__tm14fRelay") as ((text: string) => Promise<unknown>) | undefined;
Reflect.set(window, "__tm14fDeliver", (text: string): void => worker.postMessage(JSON.parse(text)));
worker.addEventListener("message", ({ data }: MessageEvent<Record<string, unknown>>) => {
	if (data?.kind === "rpc-call" || data?.kind === "rpc-reply") {
		if (relay === undefined) emit({ kind: "worker-error", error: { message: "TRACK_M_14F_NO_RELAY" } });
		else
			void relay(JSON.stringify(data)).catch((error: unknown) =>
				emit({ kind: "worker-error", error: { message: `TRACK_M_14F_RELAY ${String(error)}` } })
			);
		return;
	}
	if (data?.kind === "foreign-request") {
		foreign ??= new Worker(new URL("./tm14f-foreign.js", import.meta.url), { type: "module" });
		foreign.addEventListener("message", ({ data: reply }: MessageEvent<Record<string, unknown>>) => {
			emit(reply);
			worker.postMessage(reply);
		});
		foreign.postMessage({ ...data, order });
	}
	emit(data);
});
worker.addEventListener("error", (event) =>
	emit({ kind: "worker-error", error: { message: event.message, filename: event.filename, lineno: event.lineno } })
);
worker.addEventListener("messageerror", () => emit({ kind: "worker-error", error: { message: "messageerror" } }));
emit({ kind: "page", isolated: crossOriginIsolated, userAgent: navigator.userAgent, origin: location.origin });
worker.postMessage({ ...input, order });
