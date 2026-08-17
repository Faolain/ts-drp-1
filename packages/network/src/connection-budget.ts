import {
	type Connection,
	type ConnectionGater,
	type Libp2p,
	type MultiaddrConnection,
	type PeerId,
} from "@libp2p/interface";
import { type DRPConnectionBudget, type DRPConnectionBudgetConfig, type DRPConnectionBudgetRole } from "@ts-drp/types";

const RESERVATION_LIFETIME_MS = 60_000;

const ROLE_PROFILES = Object.freeze({
	browser: Object.freeze({ maxConnections: 48, maxParallelDials: 6 }),
	node: Object.freeze({ maxConnections: 300, maxParallelDials: 100 }),
	relay: Object.freeze({ maxConnections: 2_000, maxParallelDials: 32 }),
	worker: Object.freeze({ maxConnections: 48, maxParallelDials: 6 }),
});

export interface ResolveConnectionBudgetInput {
	readonly configured?: DRPConnectionBudgetConfig;
	readonly relayServiceEnabled: boolean;
	readonly runtime: Exclude<DRPConnectionBudgetRole, "relay">;
}

function positiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Resolve one immutable hard budget from runtime capability and an optional reduction.
 * @param input - Runtime role, relay capability, and optional configured reduction.
 * @returns The closed effective connection budget.
 */
export function resolveConnectionBudget(input: ResolveConnectionBudgetInput): DRPConnectionBudget {
	const role: DRPConnectionBudgetRole = input.relayServiceEnabled ? "relay" : input.runtime;
	const profile = ROLE_PROFILES[role];
	const configured = input.configured;
	if (configured === undefined) return Object.freeze({ ...profile, role });

	if (configured === null || typeof configured !== "object" || Array.isArray(configured)) {
		throw new Error("connection_budget must be an object");
	}
	const keys = Object.keys(configured).sort();
	if (keys.length !== 2 || keys[0] !== "max_connections" || keys[1] !== "max_parallel_dials") {
		throw new Error("connection_budget must contain exactly max_connections and max_parallel_dials");
	}
	const maxConnections = configured.max_connections;
	const maxParallelDials = configured.max_parallel_dials;
	if (!positiveSafeInteger(maxConnections)) {
		throw new Error("connection_budget.max_connections must be a positive safe integer");
	}
	if (!positiveSafeInteger(maxParallelDials)) {
		throw new Error("connection_budget.max_parallel_dials must be a positive safe integer");
	}
	if (maxConnections > profile.maxConnections) {
		throw new Error("connection_budget.max_connections exceeds the resolved role profile");
	}
	if (maxParallelDials > profile.maxParallelDials) {
		throw new Error("connection_budget.max_parallel_dials exceeds the resolved role profile");
	}
	if (maxParallelDials >= maxConnections) {
		throw new Error("connection_budget.max_parallel_dials must be below max_connections");
	}

	return Object.freeze({ maxConnections, maxParallelDials, role });
}

interface Reservation {
	readonly connection: MultiaddrConnection;
	readonly matchKey: string;
	timer?: ReturnType<typeof setTimeout>;
}

/** Owns final-upgrade reservations and the identity-keyed live connection census. */
export interface ConnectionAdmissionController {
	readonly connectionGater: Pick<ConnectionGater, "denyInboundUpgradedConnection" | "denyOutboundUpgradedConnection">;
	attach(host: Libp2p): void;
	stop(): void;
}

function connectionMatchKey(peerId: PeerId): string {
	return peerId.toString();
}

/**
 * Create the single final-upgrade admission owner for one host lifecycle.
 * @param budget - The immutable effective budget installed on the same host.
 * @returns A gater plus its synchronous host attach and cleanup lifecycle.
 */
export function createConnectionAdmissionController(budget: DRPConnectionBudget): ConnectionAdmissionController {
	const liveConnections = new Map<string, Connection>();
	const reservations = new Set<Reservation>();
	const reservationsByConnection = new WeakMap<MultiaddrConnection, Reservation>();
	let attachedHost: Libp2p | undefined;
	let stopped = false;

	const removeReservation = (reservation: Reservation): void => {
		if (!reservations.delete(reservation)) return;
		reservationsByConnection.delete(reservation.connection);
		if (reservation.timer !== undefined) clearTimeout(reservation.timer);
	};

	const startExpiry = (reservation: Reservation): void => {
		if (reservation.timer !== undefined || attachedHost === undefined) return;
		reservation.timer = setTimeout(() => removeReservation(reservation), RESERVATION_LIFETIME_MS);
		(reservation.timer as ReturnType<typeof setTimeout> & { unref?(): void }).unref?.();
	};

	const reserve = (peerId: PeerId, connection: MultiaddrConnection): boolean => {
		if (stopped) return true;
		if (reservationsByConnection.has(connection)) return false;
		if (liveConnections.size + reservations.size >= budget.maxConnections) return true;

		const reservation: Reservation = {
			connection,
			matchKey: connectionMatchKey(peerId),
		};
		reservations.add(reservation);
		reservationsByConnection.set(connection, reservation);
		startExpiry(reservation);
		return false;
	};

	const reconcileOpen = (connection: Connection): void => {
		if (liveConnections.has(connection.id)) return;
		const matchKey = connectionMatchKey(connection.remotePeer);
		const reservation = [...reservations].find((candidate) => candidate.matchKey === matchKey);
		if (reservation !== undefined) removeReservation(reservation);
		liveConnections.set(connection.id, connection);
	};

	const reconcileClose = (connection: Connection): void => {
		liveConnections.delete(connection.id);
	};

	const onConnectionOpen = (event: CustomEvent<Connection>): void => reconcileOpen(event.detail);
	const onConnectionClose = (event: CustomEvent<Connection>): void => reconcileClose(event.detail);

	return {
		connectionGater: {
			denyInboundUpgradedConnection: reserve,
			denyOutboundUpgradedConnection: reserve,
		},
		attach: (host): void => {
			if (stopped) throw new Error("connection admission controller is stopped");
			if (attachedHost !== undefined) throw new Error("connection admission controller is already attached");
			attachedHost = host;
			host.addEventListener("connection:open", onConnectionOpen);
			host.addEventListener("connection:close", onConnectionClose);
			for (const connection of host.getConnections()) reconcileOpen(connection);
			for (const reservation of reservations) startExpiry(reservation);
		},
		stop: (): void => {
			if (stopped) return;
			stopped = true;
			attachedHost?.removeEventListener("connection:open", onConnectionOpen);
			attachedHost?.removeEventListener("connection:close", onConnectionClose);
			for (const reservation of [...reservations]) removeReservation(reservation);
			liveConnections.clear();
			attachedHost = undefined;
		},
	};
}
