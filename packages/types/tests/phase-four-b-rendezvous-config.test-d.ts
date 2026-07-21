import type {
	ControlPlaneConfig,
	ControlPlaneEvent,
	ControlPlanePeerCacheConfig,
	ControlPlaneRendezvousConfig,
	DRPNetworkNodeConfig,
} from "@ts-drp/types";

const memoryCache: ControlPlanePeerCacheConfig = { enabled: true, max: 64, persistence: "memory" };
const fsCache: ControlPlanePeerCacheConfig = {
	enabled: true,
	max: 64,
	path: "/tmp/drp-peer-cache.json",
	persistence: "node-fs",
};
const localStorageCache: ControlPlanePeerCacheConfig = {
	enabled: true,
	key: "drp-peer-cache",
	max: 64,
	persistence: "browser-local",
};

const rendezvous: ControlPlaneRendezvousConfig = {
	cache: fsCache,
	endpoints: ["https://registry.example/v1"],
	invite: "signed-invite-envelope",
	namespace: `drp-network:v1:${"a".repeat(43)}`,
	publish: false,
};
const controlPlane: ControlPlaneConfig = { rendezvous };
const config: DRPNetworkNodeConfig = { control_plane: controlPlane };

const cacheHit: ControlPlaneEvent = { kind: "rendezvous-cache", outcome: "hit" };
const cacheWrite: ControlPlaneEvent = { kind: "rendezvous-cache", outcome: "write" };
const inviteAccepted: ControlPlaneEvent = { kind: "rendezvous-invite", outcome: "accepted" };
const inviteFailed: ControlPlaneEvent = { kind: "rendezvous-invite", outcome: "failed" };

void memoryCache;
void localStorageCache;
void config;
void cacheHit;
void cacheWrite;
void inviteAccepted;
void inviteFailed;
