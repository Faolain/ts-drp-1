/* eslint-disable @typescript-eslint/explicit-function-return-type */
// One-command local WebRTC grid demos.
//
// Stands up the full MODULAR network stack on a single host — two independent
// rendezvous registries + a delegated-routing endpoint (co-located in one small
// server) and two operator-diverse Circuit Relay v2 relays — then serves the grid
// app in modular mode with NO fixed bootstrap seeds. Open the printed URL in two
// browser windows: they cold-start, discover each other through rendezvous, connect
// through a relay, and upgrade to a DIRECT WebRTC connection where the network allows
// (falling back to relayed otherwise).
//
// Usage (from the repo root):  pnpm --filter ts-drp-example-grid demo
// Nostr discovery profile:     pnpm --filter ts-drp-example-grid demo:public-infra
// Stop with Ctrl+C.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const profile = process.env.GRID_DEMO_PROFILE ?? "default";
if (profile !== "default" && profile !== "public-infra") {
	throw new Error(`Unknown GRID_DEMO_PROFILE: ${profile}`);
}
const publicInfra = profile === "public-infra";
const useLocalNostrFixture = publicInfra && process.env.VITE_NOSTR_RELAYS === undefined;

// Deterministic relay peer ids come from the relay configs' private_key_seed, so the
// routing endpoint, the operator-group map, and the running relays all agree.
const RELAY_A = "16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5";
const RELAY_B = "16Uiu2HAmT72TapomemeWskZbmzd4hZcakAzYnTwLtbdsvdaSUvXU";

const gridEnv = {
	...process.env,
	// Local fixtures advertise loopback + private-LAN addresses; this flag is a demo-only
	// opt-in and is never emitted by a non-fixture config. Do NOT set it in production.
	VITE_ALLOW_INSECURE_FIXTURE: "true",
	VITE_BOOTSTRAP_PEERS: "",
	VITE_NETWORK_MODE: "modular",
	VITE_MEMBERSHIP_INVITE: "grid-local-demo-invite-0123456789",
	VITE_RENDEZVOUS_NAMESPACE: "drp-network:v1:Z2F0ZS03LWxvY2FsLWZpeHR1cmU",
	...(publicInfra
		? {
				VITE_NOSTR_RELAYS: process.env.VITE_NOSTR_RELAYS ?? "ws://127.0.0.1:4180",
				VITE_RENDEZVOUS_ENDPOINTS: "",
			}
		: {
				VITE_RENDEZVOUS_ENDPOINTS: [
					"http://127.0.0.1:4175/grid-registry/primary",
					"http://127.0.0.1:4175/grid-registry/secondary",
				].join(","),
			}),
	VITE_ROUTING_ENDPOINTS: [
		"http://127.0.0.1:4175/fixture/grid-relays-success/primary/",
		"http://127.0.0.1:4175/fixture/grid-relays-success/secondary/",
	].join(","),
	VITE_RELAY_OPERATOR_GROUPS: [`${RELAY_A}=demo-operator-a`, `${RELAY_B}=demo-operator-b`].join(","),
	VITE_RENDER_INFO_INTERVAL: "250",
};

const discoveryProcesses = publicInfra
	? [
			{ name: "routing", command: "node examples/network-spike/fixtures/delegated-server.mjs --routing-only" },
			...(useLocalNostrFixture
				? [{ name: "nostr-relay", command: "node examples/network-spike/fixtures/nostr-relay.mjs 4180" }]
				: []),
		]
	: [{ name: "registries+routing", command: "pnpm --filter ts-drp-example-network-spike fixtures" }];

const processes = [
	...discoveryProcesses,
	{
		name: "relay-a",
		command: "pnpm --filter @ts-drp/network-spike grid:relay ../../configs/network-spike-relay.json 51000",
	},
	{
		name: "relay-b",
		command: "pnpm --filter @ts-drp/network-spike grid:relay ../../configs/network-spike-relay-replacement.json 51002",
	},
	{ name: "grid", command: "pnpm --filter ts-drp-example-grid dev --host 127.0.0.1 --port 4174", env: gridEnv },
];

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	process.stdout.write("\n[demo] shutting down…\n");
	for (const child of children) {
		try {
			child.kill("SIGTERM");
		} catch {
			// process already gone
		}
	}
	setTimeout(() => process.exit(code), 500);
}

for (const { name, command, env } of processes) {
	const child = spawn(command, { cwd: repoRoot, env: env ?? process.env, shell: true });
	children.push(child);
	const prefix = `[${name}] `;
	child.stdout.on("data", (chunk) => process.stdout.write(prefix + String(chunk).replace(/\n(?!$)/gu, `\n${prefix}`)));
	child.stderr.on("data", (chunk) => process.stderr.write(prefix + String(chunk).replace(/\n(?!$)/gu, `\n${prefix}`)));
	child.on("exit", (code) => {
		if (!shuttingDown) {
			process.stderr.write(`[demo] "${name}" exited (code ${code ?? "?"}) — stopping the demo.\n`);
			shutdown(1);
		}
	});
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

setTimeout(() => {
	if (shuttingDown) return;
	process.stdout.write(
		[
			"",
			"────────────────────────────────────────────────────────────",
			publicInfra
				? "  DRP public-infra grid demo is starting (Nostr discovery; no HTTP registry)."
				: "  DRP modular grid demo is starting (no fixed bootstrap seeds).",
			"  Once vite prints its URL, open it in TWO browser windows:",
			"",
			"      http://127.0.0.1:4174",
			"",
			"  In one window click CREATE and copy the grid id; in the other",
			"  paste it into GRID ID and click JOIN. Move with W/A/S/D.",
			publicInfra
				? "  Peers discover each other via Nostr, connect through a relay,"
				: "  Peers discover each other via HTTP rendezvous, connect through a relay,",
			"  and upgrade to direct WebRTC where the network allows.",
			"  Ctrl+C to stop everything.",
			"────────────────────────────────────────────────────────────",
			"",
		].join("\n")
	);
}, 4_000);
