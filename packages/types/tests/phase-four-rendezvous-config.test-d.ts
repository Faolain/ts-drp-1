import type { ControlPlaneConfig, ControlPlaneEvent, DRPNetworkNodeConfig } from "@ts-drp/types";

const rendezvous: NonNullable<ControlPlaneConfig["rendezvous"]> = {
	allow_insecure_loopback_fixture: true,
	endpoints: ["http://127.0.0.1:4101/", "http://127.0.0.1:4102/"],
	namespace: `drp-network:v1:${"a".repeat(43)}`,
	publish: true,
	record_ttl_ms: 60_000,
	refresh_interval_ms: 20_000,
};

const config: DRPNetworkNodeConfig = { control_plane: { rendezvous } };
void config;

const accepted: ControlPlaneEvent = {
	acceptedSourceCount: 2,
	failedSourceCount: 0,
	kind: "rendezvous-registration",
	outcome: "accepted",
};

const partial: ControlPlaneEvent = {
	acceptedSourceCount: 1,
	failedSourceCount: 1,
	kind: "rendezvous-registration",
	outcome: "partial",
};

const failed: ControlPlaneEvent = {
	acceptedSourceCount: 0,
	failedSourceCount: 2,
	kind: "rendezvous-registration",
	outcome: "failed",
};

void accepted;
void partial;
void failed;

const unknownRendezvousKey: ControlPlaneConfig = {
	rendezvous: {
		// @ts-expect-error rendezvous rejects configuration not owned by its bounded contract.
		retries: 10,
	},
};

const invalidPublish: ControlPlaneConfig = {
	rendezvous: {
		// @ts-expect-error publish is a boolean policy switch.
		publish: "yes",
	},
};

void unknownRendezvousKey;
void invalidPublish;
