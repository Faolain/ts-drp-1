import type {
	ControlPlaneConfig,
	ControlPlaneEvent,
	ControlPlaneRecoveryConfig,
	DRPNetworkNodeConfig,
} from "@ts-drp/types";

const recovery: ControlPlaneRecoveryConfig = {
	backend_cooldown_ms: 30_000,
	max_attempts: 4,
	parent_deadline_ms: 60_000,
	retry_delays_ms: [100, 500, 1_000],
};

const phaseSixControlPlane: ControlPlaneConfig = {
	recovery,
};

const phaseSixNetworkConfig: DRPNetworkNodeConfig = {
	control_plane: phaseSixControlPlane,
};

const recoveryEvent: ControlPlaneEvent = {
	attempt: 1,
	kind: "recovery",
	outcome: "attempt",
	recovery: "fallback-rendezvous",
};

const healthEvent: ControlPlaneEvent = {
	kind: "health",
	state: "degraded",
};

const terminal: ControlPlaneEvent = { kind: "terminal", reason: "deadline" };
const exhausted: ControlPlaneEvent = { kind: "terminal", reason: "exhausted" };
const cleanup: ControlPlaneEvent = { kind: "cleanup", outcome: "complete" };

void phaseSixNetworkConfig;
void recoveryEvent;
void healthEvent;
void terminal;
void exhausted;
void cleanup;
