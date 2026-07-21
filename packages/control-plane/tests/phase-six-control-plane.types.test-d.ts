import type {
	ControlPlaneCoordinatorOptions,
	ControlPlaneHealthInput,
	ControlPlaneHealthSnapshot,
	ControlPlaneMechanismPorts,
	ControlPlanePhaseSixEvent,
	ControlPlaneRecoveryAttemptId,
	ControlPlaneRecoveryConfig,
	RecoveryFault,
	RecoveryResult,
} from "@ts-drp/control-plane";
import { RecoveryTerminal } from "@ts-drp/control-plane";

const recoveryConfig: ControlPlaneRecoveryConfig = {
	backend_cooldown_ms: 30_000,
	max_attempts: 4,
	parent_deadline_ms: 60_000,
	retry_delays_ms: [100, 500, 1_000],
};

const failedAttempt: ControlPlaneRecoveryAttemptId = {
	action: "fallback-rendezvous",
	id: "rendezvous:attempt-2",
	terminal: RecoveryTerminal.Deadline,
};

const healthInput: ControlPlaneHealthInput = {
	authenticatedDrpPeerIds: ["member-a"],
	connectedBootstrapPeerIds: [],
	failedRecoveryAttempts: [failedAttempt],
	healthyBackendCount: 2,
	liveReservations: [{ operatorGroup: "operator-a", relayId: "relay-a" }],
	meshDiversity: { authenticatedPeerCount: 2, operatorGroupCount: 2, transportCount: 2 },
	objectSynchronization: "synchronized",
	rendezvous: { fresh: true, replicaAvailability: "available", replicaCount: 2 },
	traffic: { directConnections: 1, relayedConnections: 1 },
};

const healthSnapshot: ControlPlaneHealthSnapshot = {
	...healthInput,
	observedAtMs: 1_750_000_000_000,
	reasons: [],
	state: "healthy",
};

const faults: RecoveryFault[] = [
	{ backendId: "registry-a", kind: "registry-failed", remainingBackendIds: ["registry-b", "registry-c"] },
	{ kind: "all-registries-failed" },
	{ kind: "delegated-router-failed", routerId: "router-a" },
	{ kind: "relay-disconnected", operatorGroup: "operator-a", relayId: "relay-a" },
	{ kind: "direct-connection-failed", peerId: "member-a" },
	{ kind: "dht-unavailable" },
	{ authenticatedAlternates: ["member-b"], kind: "peer-disappeared", peerId: "member-a" },
	{ kind: "everything-unavailable" },
];

const events: ControlPlanePhaseSixEvent[] = [
	{ kind: "health", state: "degraded" },
	{ attempt: 1, kind: "recovery", outcome: "attempt", recovery: "fallback-router" },
	{ kind: "terminal", reason: "deadline" },
	{ kind: "cleanup", outcome: "complete" },
];

type IsAny<Value> = 0 extends 1 & Value ? true : false;
const healthIsTyped: IsAny<ControlPlaneHealthSnapshot> extends false ? true : never = true;
const portsAreTyped: IsAny<ControlPlaneMechanismPorts> extends false ? true : never = true;
const coordinatorOptionsAreTyped: IsAny<ControlPlaneCoordinatorOptions> extends false ? true : never = true;
const resultIsTyped: IsAny<RecoveryResult> extends false ? true : never = true;

void recoveryConfig;
void healthSnapshot;
void faults;
void events;
void healthIsTyped;
void portsAreTyped;
void coordinatorOptionsAreTyped;
void resultIsTyped;

const mutableAttempt: ControlPlaneRecoveryAttemptId = failedAttempt;
// @ts-expect-error snapshots expose failed attempts as readonly evidence.
healthSnapshot.failedRecoveryAttempts.push(mutableAttempt);

// @ts-expect-error recovery terminals are a bounded enum, never diagnostic strings.
const invalidTerminal: RecoveryTerminal = "registry-a failed at https://raw-endpoint.example";
void invalidTerminal;
