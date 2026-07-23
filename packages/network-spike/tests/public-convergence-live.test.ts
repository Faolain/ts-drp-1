import { createConfiguredRendezvousRegistries } from "@ts-drp/node";
import { createNodeRuntime } from "@ts-drp/node/runtime";
import { createDnsResolver, RecordValidator } from "@ts-drp/rendezvous";
import { ActionType, type IDRP, type ResolveConflictsType, SemanticsType, type Vertex } from "@ts-drp/types";
import type { Libp2p } from "libp2p";
import { describe, expect, it } from "vitest";

// LIVE fully-public two-node convergence — OPT-IN ONLY (`RUN_PUBLIC_LIVE=true`), never a CI gate.
// It sends real traffic to public Nostr relays (relay.damus.io, nos.lol) and the canonical public
// Amino bootstrappers, and depends on ephemeral third-party circuit relays, so it is skipped by
// default. Run it with: `pnpm test:public-convergence`.
//
// What it proves — the COMPLETE "boot on public infra with no DRP-operated relay" story at the
// NODE level: two real DRP nodes each (1) reserve a REAL public Circuit Relay v2 node via the warm
// HOP harvest, (2) publish their record to PUBLIC Nostr and discover each other's record over it
// (read back through the production rendezvous directory), (3) connect through a public relay and
// upgrade to WebRTC, and (4) sync a shared grid object to identical state. Every hop is public.
//
// Note: DRP's sync protocol will NOT run over the *limited* relayed connection itself
// (LimitedConnectionError) — the relay is first-contact/signalling; data flows over the
// `/p2p-circuit -> /webrtc` upgrade, exactly the browser grid's contract. That is why the nodes
// listen on `["/p2p-circuit", "/webrtc"]` (the production default) rather than relay-only.
const RUN_LIVE = process.env.RUN_PUBLIC_LIVE === "true";
const describeLive = RUN_LIVE ? describe : describe.skip;

const NOSTR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];
const RUN_TAG = `pubconv-${Date.now().toString(36)}`;
const NAMESPACE = `drp-network:v1:${Buffer.from(RUN_TAG).toString("base64url")}`;
const OBJECT_ID = `${RUN_TAG}-grid`;
const TEST_TIMEOUT_MS = 200_000;

/** Minimal grid DRP (positions map), same shape as examples/grid. */
class MiniGrid implements IDRP {
	semanticsType = SemanticsType.pair;
	positions = new Map<string, { x: number; y: number }>();

	addUser(id: string): void {
		this.positions.set(id, { x: 0, y: 0 });
	}

	moveUser(id: string, dx: number, dy: number): void {
		const p = this.positions.get(id);
		if (p) this.positions.set(id, { x: p.x + dx, y: p.y + dy });
	}

	queryPositions(): Record<string, { x: number; y: number }> {
		return Object.fromEntries([...this.positions.entries()].sort());
	}

	resolveConflicts(_vertices: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

interface RuntimeNode {
	readonly networkNode: {
		readonly peerId: string;
		getMultiaddrs(): unknown[];
		connect(addr: string[]): Promise<unknown>;
	} & Record<string, unknown>;
	readonly keychain: { readonly secp256k1PrivateKey: unknown };
	createObject(options: {
		drp: MiniGrid;
		id: string;
	}): Promise<{ drp: MiniGrid; vertices: readonly { hash: string }[] }>;
	syncObject(id: string, peerId: string): Promise<unknown>;
	stop(): Promise<void>;
}

function makeConfig(seed: string): Record<string, unknown> {
	return {
		keychain_config: { private_key_seed: seed },
		log_config: { level: "error" },
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/p2p-circuit", "/webrtc"],
			log_config: { level: "error" },
			control_plane: {
				address_policy: { target: "node" },
				rendezvous: {
					endpoints: [],
					namespace: NAMESPACE,
					nostr: { relays: NOSTR_RELAYS },
					publish: true,
					record_ttl_ms: 60_000,
					refresh_interval_ms: 2_000,
				},
				rollout: {
					public_components: { delegated_routing: { enabled: true }, public_rendezvous: { enabled: true } },
				},
				routing: {
					node: {
						enabled: true,
						network: "public",
						public_network_acknowledgement: "I_ACKNOWLEDGE_PUBLIC_NETWORK_TRAFFIC",
					},
				},
			},
		},
	};
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms: number, label: string, pollMs = 500): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await fn()) return;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	throw new Error(`timeout waiting for ${label} after ${ms}ms`);
}

const circuitAddrs = (node: RuntimeNode): string[] =>
	node.networkNode
		.getMultiaddrs()
		.map(String)
		.filter((a) => a.includes("/p2p-circuit"));
const libp2pOf = (node: RuntimeNode): Libp2p => node.networkNode["_node"] as Libp2p;
const connectionsToPeer = (node: RuntimeNode, peerId: string): ReturnType<Libp2p["getConnections"]> =>
	libp2pOf(node)
		.getConnections()
		.filter((c) => c.remotePeer.toString() === peerId);
const fingerprint = (obj: { drp: MiniGrid; vertices: readonly { hash: string }[] }): string =>
	JSON.stringify({ positions: obj.drp.queryPositions(), vertices: obj.vertices.map((v) => v.hash).sort() });

/**
 * Read-only production Nostr directory — proves public discovery through the real reader path.
 * @param node
 */
function makeReader(node: RuntimeNode): ReturnType<typeof createConfiguredRendezvousRegistries> {
	return createConfiguredRendezvousRegistries({
		clientId: `${node.networkNode.peerId}-reader`,
		publicRendezvousEnabled: true,
		rendezvousConfig: { endpoints: [], namespace: NAMESPACE, nostr: { relays: NOSTR_RELAYS }, publish: false },
		secp256k1PrivateKey: node.keychain.secp256k1PrivateKey as never,
		validatorFactory: () => new RecordValidator({ addressPolicyOptions: {}, resolver: createDnsResolver() }),
	});
}

describeLive("live fully-public two-node convergence (opt-in: RUN_PUBLIC_LIVE=true)", () => {
	it(
		"two DRP nodes discover over public Nostr, connect via a public relay, and converge a grid object",
		async () => {
			const runtimeA = (await createNodeRuntime(makeConfig(`${RUN_TAG}-a`))) as unknown as { node: RuntimeNode };
			const runtimeB = (await createNodeRuntime(makeConfig(`${RUN_TAG}-b`))) as unknown as { node: RuntimeNode };
			const A = runtimeA.node;
			const B = runtimeB.node;
			try {
				// 1. Both nodes reserve a REAL public circuit relay via the warm HOP harvest.
				await waitFor(
					() => circuitAddrs(A).length > 0 && circuitAddrs(B).length > 0,
					60_000,
					"public relay reservations"
				);
				expect(circuitAddrs(A).length).toBeGreaterThan(0);
				expect(circuitAddrs(B).length).toBeGreaterThan(0);

				// 2. Both records (incl. circuit addrs) are discoverable on PUBLIC Nostr.
				const reader = makeReader(B);
				expect(reader).toBeDefined();
				if (reader === undefined) throw new Error("rendezvous reader unavailable");
				let recA: { readonly peerId: string; readonly addresses: readonly string[] } | undefined;
				await waitFor(
					async () => {
						const validated = await reader.discover(NAMESPACE, AbortSignal.timeout(10_000)).catch(() => []);
						const records = validated.map((v) => v.record);
						recA = records.find(
							(r) => r.peerId === A.networkNode.peerId && r.addresses.some((x) => x.includes("/p2p-circuit"))
						);
						const recB = records.find(
							(r) => r.peerId === B.networkNode.peerId && r.addresses.some((x) => x.includes("/p2p-circuit"))
						);
						return recA !== undefined && recB !== undefined;
					},
					60_000,
					"both records with circuit addrs on public Nostr",
					2_000
				);
				expect(recA).toBeDefined();
				if (recA === undefined) throw new Error("A record not discovered on public Nostr");

				// 3. Connect B -> A through A's PUBLIC relay circuit address (from the Nostr record),
				//    upgrading to WebRTC (DRP sync will not run on the limited relayed connection).
				const webrtcAddrs = recA.addresses.filter((x) => x.includes("/p2p-circuit/webrtc/"));
				const circuitOnly = recA.addresses.filter((x) => x.includes("/p2p-circuit") && !x.includes("/webrtc"));
				const target = webrtcAddrs.length > 0 ? webrtcAddrs : circuitOnly;
				await B.networkNode.connect(target).catch(() => B.networkNode.connect(circuitOnly));
				await waitFor(() => connectionsToPeer(B, A.networkNode.peerId).length > 0, 30_000, "B connected to A");
				const conns = connectionsToPeer(B, A.networkNode.peerId).map((c) => c.remoteAddr.toString());
				// The connection path must go through a circuit relay (no local/direct listen exists).
				expect(conns.some((a) => a.includes("/p2p-circuit"))).toBe(true);

				// 4. Shared object; concurrent mutations on both sides converge.
				const objA = await A.createObject({ drp: new MiniGrid(), id: OBJECT_ID });
				const objB = await B.createObject({ drp: new MiniGrid(), id: OBJECT_ID });
				objA.drp.addUser("alice");
				objA.drp.moveUser("alice", 2, 1);
				objB.drp.addUser("bob");
				objB.drp.moveUser("bob", -1, 3);

				await waitFor(
					async () => {
						if (fingerprint(objA) === fingerprint(objB) && objA.vertices.length > 2) return true;
						await A.syncObject(OBJECT_ID, B.networkNode.peerId).catch(() => undefined);
						await B.syncObject(OBJECT_ID, A.networkNode.peerId).catch(() => undefined);
						return false;
					},
					90_000,
					"state convergence over public infra",
					2_000
				);

				expect(fingerprint(objA)).toBe(fingerprint(objB));
				expect(objA.vertices.length).toBeGreaterThan(2);
				console.log(`[public-convergence] converged: ${fingerprint(objA)}`);
			} finally {
				await Promise.allSettled([A.stop(), B.stop()]);
			}
		},
		TEST_TIMEOUT_MS
	);
});
