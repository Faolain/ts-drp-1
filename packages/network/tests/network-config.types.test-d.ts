import type { ControlPlaneConfig, ControlPlaneEvent, DRPNetworkNodeConfig } from "@ts-drp/types";

const controlPlane: ControlPlaneConfig = {
	address_policy: {
		resolver: {
			resolve: (_hostname, _signal, _family): Promise<string[]> => Promise.resolve(["9.9.9.9"]),
		},
		target: "node",
	},
	membership: {
		invite: { inviteToken: "0123456789abcdef" },
		mode: "invite",
	},
	observability: {
		sink: (_event: ControlPlaneEvent): void => {},
	},
	relay_policy: { target_reservations: 2 },
	rendezvous: { endpoints: ["https://rendezvous.example"], namespace: "example" },
	routing: {
		browser: { endpoints: ["https://routing.example"] },
		node: { enabled: true },
	},
};

const emptyControlPlane: ControlPlaneConfig = {};
const emptyPlaceholderSections: ControlPlaneConfig = {
	relay_policy: {},
	rendezvous: {},
	routing: { browser: {}, node: {} },
};
void emptyControlPlane;
void emptyPlaceholderSections;

const phaseTwoConfig: DRPNetworkNodeConfig = {
	autonat: false,
	bootstrap_peers: [],
	control_plane: controlPlane,
	relay_service: { enabled: true, max_reservations: 8 },
	seed: true,
};

const defaultConfig: DRPNetworkNodeConfig = {};
void phaseTwoConfig;
void defaultConfig;

const removedBootstrap: DRPNetworkNodeConfig = {
	// @ts-expect-error bootstrap was removed; use seed and relay_service explicitly.
	bootstrap: true,
};
const removedRelay: DRPNetworkNodeConfig = {
	// @ts-expect-error relay was removed; local server capacity is relay_service.
	relay: { max_reservations: 8 },
};
void removedBootstrap;
void removedRelay;

const events: ControlPlaneEvent[] = [
	{
		family: "ipv4",
		kind: "dial-attempt",
		outcome: "denied",
		reason: "address-policy",
		scope: "private",
		transport: "tcp",
	},
	{
		family: "ipv6",
		kind: "address-admission",
		outcome: "denied",
		reason: "scope-loopback",
		scope: "loopback",
		transport: "tcp",
	},
	{
		family: "ipv4",
		kind: "dial-attempt",
		outcome: "denied",
		reason: "injected-policy",
		scope: "public",
		transport: "ws",
	},
	{ kind: "listen-readiness", outcome: "ready", transport: "wss" },
	{ kind: "relay-reservation", outcome: "acquired", relayIdHash: "a1b2c3d4" },
	{ kind: "first-authenticated-peer", peerIdHash: "d4c3b2a1" },
	{ kind: "terminal", reason: "stopped" },
	{ kind: "cleanup", outcome: "complete" },
];
void events;

type ForbiddenRawField = "address" | "multiaddr" | "namespace" | "peerId" | "token";
type KeysOfUnion<Value> = Value extends unknown ? keyof Value : never;
type RawFieldLeak = Extract<KeysOfUnion<ControlPlaneEvent>, ForbiddenRawField>;
const noRawFields: RawFieldLeak extends never ? true : never = true;
void noRawFields;

const rawAddressLeak: ControlPlaneEvent = {
	kind: "terminal",
	// @ts-expect-error raw multiaddrs are forbidden from sanitized control-plane events.
	multiaddr: "/ip4/127.0.0.1/tcp/443",
	reason: "stopped",
};
const freeFormReason: ControlPlaneEvent = {
	family: "ipv4",
	kind: "dial-attempt",
	outcome: "failed",
	// @ts-expect-error reasons are bounded categories, not diagnostic strings.
	reason: "dial to /ip4/127.0.0.1/tcp/443 failed for peer 12D3KooWRaw",
	scope: "loopback",
	transport: "tcp",
};
void rawAddressLeak;
void freeFormReason;
