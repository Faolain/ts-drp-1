import type { ControlPlaneRendezvousConfig } from "@ts-drp/types";

const enabledRoomPresence: ControlPlaneRendezvousConfig = {
	room_presence: {
		enabled: true,
		max_rooms: 8,
	},
};

const disabledRoomPresence: ControlPlaneRendezvousConfig = {
	room_presence: {
		enabled: false,
	},
};

const unknownRoomPresenceKey: ControlPlaneRendezvousConfig = {
	room_presence: {
		enabled: true,
		// @ts-expect-error room presence rejects configuration not owned by its bounded contract.
		max_peers: 8,
	},
};

void enabledRoomPresence;
void disabledRoomPresence;
void unknownRoomPresenceKey;
