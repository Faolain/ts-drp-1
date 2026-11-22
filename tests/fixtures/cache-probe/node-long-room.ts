import { appendFileSync } from "node:fs";

import { closeLongRooms, type RoleEndpoint, runLongRoom } from "../track-m-apps/app-long-room.js";
import type { AppKind, HostKind } from "../track-m-apps/long-room-driver.js";

// Track Y measurement only: Track M's Canvas / Chat long room with both roles in ONE Node process
// (tests/fixtures/track-m-apps/app-long-room.ts), run from a bundle built with the cache probe
// (./build-node.ts). In Node the library's caches are module state, so both roles (and every other room
// of the process) share one set: the probe sees the process's caches. Each endpoint call runs inside a
// probe phase named after its method; the epoch is the room's (the driver's seal epoch until the
// recipient's install returns, then the next one); the creator's event drain (once per epoch, after both
// lulls) and the end of the run flush the probe to <out.jsonl>. Run with `node --expose-gc`, each of those flushes
// is followed by a forced GC and a {kind: "heap"} line with the process's memory after it.
//
// usage: node <bundle.mjs> <canvas|chat> <node|room|room-retention> <epochs> <out.jsonl> [reader|product]

interface Probe {
	setContext(provider: () => { epoch: number; role: string }): void;
	enter(phase: string): void;
	exit(phase: string): void;
	flush(label: string): Promise<unknown>;
}

const installed = Reflect.get(globalThis, "__cacheProbe") as Probe | undefined;
if (installed === undefined) throw new TypeError("CACHE_PROBE_BUNDLE_REQUIRED");
const probe: Probe = installed;
const [app, host, epochText, out, lull = "reader"] = process.argv.slice(2);
if (
	(app !== "canvas" && app !== "chat") ||
	!["node", "room", "room-retention"].includes(host ?? "") ||
	out === undefined ||
	(lull !== "reader" && lull !== "product")
)
	throw new TypeError(
		"usage: node-long-room <canvas|chat> <node|room|room-retention> <epochs> <out.jsonl> [reader|product]"
	);
const epochs = Number(epochText);
if (!Number.isSafeInteger(epochs) || epochs < 1) throw new TypeError("CACHE_PROBE_EPOCHS");

Reflect.set(globalThis, "__cacheProbeSink", (line: string) => {
	appendFileSync(out, `${line}\n`);
	return Promise.resolve();
});
const context = { epoch: 0, role: "node-process" };
probe.setContext(() => context);

const gc = Reflect.get(globalThis, "gc") as (() => void) | undefined;
function heapAfterGc(label: string): void {
	if (typeof gc !== "function" || out === undefined) return;
	gc();
	const { heapUsed, heapTotal, external, arrayBuffers, rss } = process.memoryUsage();
	const line = { kind: "heap", label, epoch: context.epoch, heapUsed, heapTotal, external, arrayBuffers, rss };
	appendFileSync(out, `${JSON.stringify(line)}\n`);
}

function probed(endpoint: RoleEndpoint, role: "creator" | "recipient"): RoleEndpoint {
	const wrapped: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
	for (const [method, call] of Object.entries(endpoint) as [string, (...args: unknown[]) => Promise<unknown>][])
		wrapped[method] = async (...args: unknown[]): Promise<unknown> => {
			if ((method === "seal" || method === "issue") && typeof args[0] === "number") context.epoch = args[0];
			probe.enter(method);
			let result: unknown;
			try {
				result = await call(...args);
			} finally {
				probe.exit(method);
			}
			if (role === "recipient" && method === "install") context.epoch++;
			if (role === "creator" && method === "drainEvents") {
				await probe.flush(`e${context.epoch}`);
				heapAfterGc(`e${context.epoch}`);
			}
			return result;
		};
	return wrapped as unknown as RoleEndpoint;
}

const started = Date.now();
try {
	const run = await runLongRoom(
		{
			app: app as AppKind,
			host: host as HostKind,
			recipient: app === "chat" ? "writer" : "receive-only",
			creatorLull: lull === "reader",
			epochs,
			moves: 2,
		},
		(creator, recipient) => [probed(creator, "creator"), probed(recipient, "recipient")]
	);
	await probe.flush("close");
	process.stdout.write(
		`${JSON.stringify({ label: run.label, epochs: run.epochs.length, ms: Date.now() - started, out })}\n`
	);
} finally {
	const failures = await closeLongRooms();
	if (failures.length !== 0) process.stdout.write(`CACHE_PROBE_CLOSE_FAILURES ${failures.map(String).join("; ")}\n`);
}
