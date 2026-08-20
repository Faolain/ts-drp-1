import {
	type Connection,
	type ConnectionGater,
	type Libp2p,
	type MultiaddrConnection,
	type PeerId,
} from "@libp2p/interface";
import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import {
	type DRPConnectionBudget,
	type DRPConnectionBudgetConfig,
	type DRPConnectionBudgetRole,
	type DRPPeerSelectionSnapshot,
} from "@ts-drp/types";

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

interface Authorization {
	readonly key: string;
	charged: boolean;
	discoveryPermit: boolean;
	kind: "explicit" | "selected";
	reusable: boolean;
	readonly tickets: Set<symbol>;
	timer?: ReturnType<typeof setTimeout>;
}

const explicitDialClaim = Symbol("drp-explicit-dial-claim");

interface IssuedTicket {
	readonly authorization: Authorization;
	claimed: boolean;
	readonly token: symbol;
}

interface ExplicitDialClaim {
	readonly issued: readonly IssuedTicket[];
	readonly nestedKeys: ReadonlySet<string>;
	readonly nestedUsed: Set<string>;
	outerUsed: boolean;
	readonly routeKeys: readonly string[];
}

interface PrequeueAdmission {
	readonly claim?: ExplicitDialClaim;
	readonly nestedKey?: string;
}

interface TransportPermit {
	readonly claim?: ExplicitDialClaim;
	readonly progressCallbacks: Set<(...arguments_: unknown[]) => unknown>;
	readonly targets: Set<object>;
}

interface ReconnectLease {
	readonly key: string;
	timer: ReturnType<typeof setTimeout>;
}

export interface ExplicitDialTicket {
	bindOptions<T extends object>(target: ConnectionManagerTarget, options: T): T;
	release(): void;
}

type ConnectionManagerTarget = Multiaddr | readonly Multiaddr[] | PeerId | string | readonly string[];

function isMultiaddr(value: unknown): value is Multiaddr {
	return typeof value === "object" && value !== null && "getComponents" in value;
}

function routePeerIds(address: Multiaddr): string[] {
	return address
		.getComponents()
		.filter(({ name, value }) => name === "p2p" && value !== undefined)
		.map(({ value }) => value as string);
}

function terminalPeerId(address: Multiaddr): string | undefined {
	return routePeerIds(address).at(-1);
}

function targetKeys(target: unknown): string[] {
	const candidates = Array.isArray(target) ? target : [target];
	const keys = new Set<string>();
	for (const candidate of candidates) {
		if (typeof candidate === "string") {
			if (!candidate.includes("/")) {
				if (candidate.length > 0) keys.add(`peer:${candidate}`);
				continue;
			}
			try {
				const address = multiaddr(candidate);
				const peerIds = routePeerIds(address);
				if (peerIds.length === 0) keys.add(`address:${address}`);
				for (const peerId of peerIds) keys.add(`peer:${peerId}`);
			} catch {
				// Invalid targets are rejected by the empty authorization result.
			}
			continue;
		}
		if (isMultiaddr(candidate)) {
			const peerIds = routePeerIds(candidate);
			if (peerIds.length === 0) keys.add(`address:${candidate.toString()}`);
			for (const peerId of peerIds) keys.add(`peer:${peerId}`);
			continue;
		}
		if (candidate !== undefined && candidate !== null && typeof candidate === "object" && "toString" in candidate) {
			const peerId = candidate.toString();
			if (peerId.length > 0) keys.add(`peer:${peerId}`);
		}
	}
	return [...keys];
}

function nestedTargetKeys(target: unknown): string[] {
	const candidates = Array.isArray(target) ? target : [target];
	return [...new Set(candidates.flatMap((candidate) => targetKeys(candidate).slice(0, -1)))];
}

function prequeueKeys(target: unknown): string[] {
	const candidates = Array.isArray(target) ? target : [target];
	const keys = new Set<string>();
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.includes("/")) {
			try {
				const address = multiaddr(candidate);
				const peerId = terminalPeerId(address);
				keys.add(peerId === undefined ? `address:${address}` : `peer:${peerId}`);
			} catch {
				// Invalid targets are rejected by the empty authorization result.
			}
			continue;
		}
		if (isMultiaddr(candidate)) {
			const peerId = terminalPeerId(candidate);
			keys.add(peerId === undefined ? `address:${candidate}` : `peer:${peerId}`);
			continue;
		}
		for (const key of targetKeys(candidate)) keys.add(key);
	}
	return [...keys];
}

/** Owns final-upgrade reservations and the identity-keyed live connection census. */
export interface ConnectionAdmissionController {
	readonly connectionGater: Pick<
		ConnectionGater,
		"denyDialPeer" | "denyInboundUpgradedConnection" | "denyOutboundUpgradedConnection"
	>;
	addLifecycleTarget(target: ConnectionManagerTarget): void;
	admitDiscoveredPeers(peerIds: readonly PeerId[], addresses: readonly Multiaddr[]): boolean;
	admitDiscoveredPeer(peerId: PeerId, addresses: readonly Multiaddr[]): boolean;
	attach(host: Libp2p): void;
	createExplicitTicket(target: ConnectionManagerTarget): ExplicitDialTicket | undefined;
	getSnapshot(
		dependencyDialQueue: number,
		expectedReplicas: number | undefined,
		globalDiscovery: boolean
	): DRPPeerSelectionSnapshot;
	recordDenied(): void;
	revokeDiscoveredPeer(peerId: PeerId): void;
	stop(): void;
	wrapConnectionManager<T extends object>(manager: T): T;
	wrapTransportManager<T extends object>(manager: T): T;
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
	const authorizations = new Map<string, Authorization>();
	const lifecycleTargets = new Set<string>();
	const reconnectTargets = new Map<string, ReconnectLease>();
	const transportPermits = new WeakMap<object, TransportPermit>();
	const progressPermits = new WeakMap<(...arguments_: unknown[]) => unknown, TransportPermit>();
	const nestedPeerPermits = new Map<string, number>();
	const wrappedManagers = new WeakMap<object, object>();
	let attachedHost: Libp2p | undefined;
	let stopped = false;
	let denied = 0;

	const occupancy = (): number => authorizations.size + reservations.size + liveConnections.size;
	const selectionOccupancy = (): number =>
		[...authorizations.values()].filter(({ kind }) => kind === "selected").length;
	const selectedCount = (): number =>
		[...authorizations.values()].filter(({ charged, kind }) => kind === "selected" && !charged).length;
	const chargedCount = (): number => [...authorizations.values()].filter(({ charged }) => charged).length;

	const removeAuthorization = (authorization: Authorization): void => {
		if (authorizations.get(authorization.key) !== authorization) return;
		authorizations.delete(authorization.key);
		if (authorization.timer !== undefined) clearTimeout(authorization.timer);
	};

	const scheduleAuthorizationExpiry = (authorization: Authorization): void => {
		if (authorization.timer !== undefined) clearTimeout(authorization.timer);
		authorization.timer = setTimeout(() => removeAuthorization(authorization), RESERVATION_LIFETIME_MS);
		(authorization.timer as ReturnType<typeof setTimeout> & { unref?(): void }).unref?.();
	};

	const chargeAuthorization = (authorization: Authorization): void => {
		authorization.charged = true;
		scheduleAuthorizationExpiry(authorization);
	};

	const createAuthorization = (
		key: string,
		kind: Authorization["kind"],
		discoveryPermit = false,
		reusable = false
	): Authorization => ({ charged: false, discoveryPermit, key, kind, reusable, tickets: new Set() });

	const findAuthorization = (keys: readonly string[]): Authorization | undefined => {
		for (const key of keys) {
			const authorization = authorizations.get(key);
			if (authorization !== undefined) return authorization;
		}
		return undefined;
	};

	const hasLivePeer = (keys: readonly string[]): boolean =>
		keys.some((key) =>
			key.startsWith("peer:")
				? [...liveConnections.values()].some(({ remotePeer }) => `peer:${remotePeer}` === key)
				: false
		);

	const removeReconnectLease = (lease: ReconnectLease): void => {
		if (reconnectTargets.get(lease.key) !== lease) return;
		reconnectTargets.delete(lease.key);
		clearTimeout(lease.timer);
	};

	const addReconnectLease = (key: string): void => {
		const existing = reconnectTargets.get(key);
		if (existing !== undefined) removeReconnectLease(existing);
		while (reconnectTargets.size >= budget.maxConnections) {
			const oldest = reconnectTargets.values().next().value as ReconnectLease | undefined;
			if (oldest === undefined) break;
			removeReconnectLease(oldest);
		}
		const lease: ReconnectLease = {
			key,
			timer: setTimeout(() => removeReconnectLease(lease), RESERVATION_LIFETIME_MS),
		};
		(lease.timer as ReturnType<typeof setTimeout> & { unref?(): void }).unref?.();
		reconnectTargets.set(key, lease);
	};

	const consumeDiscoveryPermit = (authorization: Authorization): boolean => {
		if (!authorization.discoveryPermit) return false;
		authorization.discoveryPermit = false;
		chargeAuthorization(authorization);
		return true;
	};

	const consumeExplicitClaim = (claim: ExplicitDialClaim, target: unknown): PrequeueAdmission | undefined => {
		const keys = targetKeys(target);
		const isOuterRoute =
			!claim.outerUsed &&
			keys.length === claim.routeKeys.length &&
			keys.every((key, index) => key === claim.routeKeys[index]);
		if (isOuterRoute) {
			for (const { authorization, token } of claim.issued) {
				if (!keys.includes(authorization.key) || !authorization.tickets.has(token)) return undefined;
			}
			claim.outerUsed = true;
			for (const { authorization, token } of claim.issued) {
				authorization.tickets.delete(token);
				chargeAuthorization(authorization);
			}
			return { claim };
		}
		if (!claim.outerUsed || keys.length !== 1) return undefined;
		const [key] = keys;
		if (key === undefined) return undefined;
		if (!claim.nestedKeys.has(key) || claim.nestedUsed.has(key)) return undefined;
		claim.nestedUsed.add(key);
		return { claim, nestedKey: key };
	};

	const authorizePrequeue = (target: unknown, options: unknown): PrequeueAdmission | undefined => {
		if (stopped) return undefined;
		const claim =
			typeof options === "object" && options !== null
				? (options as { [explicitDialClaim]?: ExplicitDialClaim })[explicitDialClaim]
				: undefined;
		if (claim !== undefined) return consumeExplicitClaim(claim, target);
		const keys = prequeueKeys(target);
		if (keys.length === 0) return undefined;
		const routeKeys = targetKeys(target);
		const nestedRouteKeys = nestedTargetKeys(target);
		if (
			nestedRouteKeys.some(
				(key) =>
					!hasLivePeer([key]) && !authorizations.has(key) && !lifecycleTargets.has(key) && !reconnectTargets.has(key)
			)
		) {
			return undefined;
		}
		const pending: Array<{ authorization: Authorization; reconnect?: ReconnectLease }> = [];
		let newAuthorizations = 0;
		for (const key of keys) {
			if (hasLivePeer([key])) continue;
			const authorization = authorizations.get(key);
			if (authorization?.discoveryPermit === true) {
				pending.push({ authorization });
				continue;
			}
			if (authorization?.reusable === true) {
				pending.push({ authorization });
				continue;
			}
			const lifecycle = lifecycleTargets.has(key);
			const reconnect = reconnectTargets.get(key);
			if (!lifecycle && reconnect === undefined) return undefined;
			if (occupancy() + newAuthorizations >= budget.maxConnections) return undefined;
			const lifecycleAuthorization = createAuthorization(key, "explicit", false, true);
			pending.push({ authorization: lifecycleAuthorization, reconnect });
			newAuthorizations++;
		}
		for (const { authorization, reconnect } of pending) {
			if (!authorizations.has(authorization.key)) authorizations.set(authorization.key, authorization);
			if (reconnect !== undefined) removeReconnectLease(reconnect);
			if (authorization.discoveryPermit) {
				if (!consumeDiscoveryPermit(authorization)) return undefined;
			} else {
				chargeAuthorization(authorization);
			}
		}
		return nestedRouteKeys.length === 0
			? {}
			: {
					claim: {
						issued: [],
						nestedKeys: new Set(nestedRouteKeys),
						nestedUsed: new Set<string>(),
						outerUsed: true,
						routeKeys,
					},
				};
	};

	const incrementNestedPermit = (key: string): void => {
		nestedPeerPermits.set(key, (nestedPeerPermits.get(key) ?? 0) + 1);
	};

	const decrementNestedPermit = (key: string): void => {
		const remaining = (nestedPeerPermits.get(key) ?? 0) - 1;
		if (remaining > 0) nestedPeerPermits.set(key, remaining);
		else nestedPeerPermits.delete(key);
	};

	const clearTransportPermit = (permit: TransportPermit): void => {
		for (const target of permit.targets) {
			if (transportPermits.get(target) === permit) transportPermits.delete(target);
		}
		permit.targets.clear();
		for (const callback of permit.progressCallbacks) {
			if (progressPermits.get(callback) === permit) progressPermits.delete(callback);
		}
		permit.progressCallbacks.clear();
	};

	const bindTransportPermit = (options: unknown, permit: TransportPermit): object => {
		const source = typeof options === "object" && options !== null ? options : {};
		const onProgress =
			"onProgress" in source && typeof source.onProgress === "function"
				? (source.onProgress as (...arguments_: unknown[]) => unknown)
				: undefined;
		const wrappedProgress = (...arguments_: unknown[]): unknown => {
			const event = arguments_[0];
			if (
				typeof event === "object" &&
				event !== null &&
				"type" in event &&
				event.type === "dial-queue:calculated-addresses" &&
				"detail" in event &&
				Array.isArray(event.detail)
			) {
				for (const address of event.detail) {
					if (
						typeof address !== "object" ||
						address === null ||
						!("multiaddr" in address) ||
						typeof address.multiaddr !== "object" ||
						address.multiaddr === null
					)
						continue;
					const current = transportPermits.get(address.multiaddr);
					if (current === undefined || (current.claim === undefined && permit.claim !== undefined)) {
						transportPermits.set(address.multiaddr, permit);
						permit.targets.add(address.multiaddr);
					}
				}
			}
			return onProgress?.(...arguments_);
		};
		return Object.assign({}, source, { onProgress: wrappedProgress });
	};

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

	const reserve = (peerId: PeerId, connection: MultiaddrConnection, consumeAuthorization: boolean): boolean => {
		if (stopped) return true;
		if (reservationsByConnection.has(connection)) return false;
		const keys = [`peer:${peerId}`, `address:${connection.remoteAddr}`];
		const authorization = consumeAuthorization ? findAuthorization(keys) : undefined;
		if (authorization !== undefined) removeAuthorization(authorization);
		if (occupancy() >= budget.maxConnections) {
			if (consumeAuthorization) return true;
			const newestSelected = [...authorizations.values()].findLast(
				(candidate) => candidate.kind === "selected" && !candidate.charged
			);
			if (newestSelected === undefined) return true;
			removeAuthorization(newestSelected);
		}

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
		const authorization =
			authorizations.get(`peer:${matchKey}`) ?? authorizations.get(`address:${connection.remoteAddr}`);
		if (authorization !== undefined) removeAuthorization(authorization);
		const reconnectLease = reconnectTargets.get(`peer:${matchKey}`);
		if (reconnectLease !== undefined) removeReconnectLease(reconnectLease);
		liveConnections.set(connection.id, connection);
	};

	const reconcileClose = (connection: Connection): void => {
		liveConnections.delete(connection.id);
		addReconnectLease(`peer:${connection.remotePeer}`);
	};

	const admitDiscoveredPeers = (peerIds: readonly PeerId[], addresses: readonly Multiaddr[]): boolean => {
		if (stopped || addresses.length === 0 || peerIds.length === 0) {
			denied++;
			return false;
		}
		const keys = [...new Set(peerIds.map((peerId) => `peer:${peerId}`))];
		if (keys.some((key) => attachedHost?.peerId.toString() === key.slice(5))) return false;
		const missing = keys.filter((key) => !hasLivePeer([key]) && !authorizations.has(key));
		if (missing.length === 0) {
			return keys.some((key) => {
				const authorization = authorizations.get(key);
				return (
					!hasLivePeer([key]) &&
					authorization?.kind === "selected" &&
					authorization.discoveryPermit &&
					!authorization.charged
				);
			});
		}
		const discoveryCeiling = budget.maxConnections - budget.maxParallelDials;
		if (
			selectionOccupancy() + missing.length > discoveryCeiling ||
			occupancy() + missing.length > budget.maxConnections
		) {
			denied++;
			return false;
		}
		for (const key of missing) {
			const authorization = createAuthorization(key, "selected", true);
			authorizations.set(key, authorization);
			scheduleAuthorizationExpiry(authorization);
		}
		return true;
	};

	const onConnectionOpen = (event: CustomEvent<Connection>): void => reconcileOpen(event.detail);
	const onConnectionClose = (event: CustomEvent<Connection>): void => reconcileClose(event.detail);

	return {
		connectionGater: {
			denyDialPeer: (peerId): boolean => {
				const key = `peer:${peerId}`;
				return (
					!hasLivePeer([key]) && authorizations.get(key)?.charged !== true && (nestedPeerPermits.get(key) ?? 0) === 0
				);
			},
			denyInboundUpgradedConnection: (peerId, connection): boolean => reserve(peerId, connection, false),
			denyOutboundUpgradedConnection: (peerId, connection): boolean => reserve(peerId, connection, true),
		},
		addLifecycleTarget: (target): void => {
			for (const key of targetKeys(target)) lifecycleTargets.add(key);
		},
		admitDiscoveredPeers,
		admitDiscoveredPeer: (peerId, addresses): boolean => admitDiscoveredPeers([peerId], addresses),
		attach: (host): void => {
			if (stopped) throw new Error("connection admission controller is stopped");
			if (attachedHost !== undefined) throw new Error("connection admission controller is already attached");
			attachedHost = host;
			host.addEventListener("connection:open", onConnectionOpen);
			host.addEventListener("connection:close", onConnectionClose);
			for (const connection of host.getConnections()) reconcileOpen(connection);
			for (const reservation of reservations) startExpiry(reservation);
		},
		createExplicitTicket: (target): ExplicitDialTicket | undefined => {
			const keys = targetKeys(target);
			if (stopped || keys.length === 0) {
				denied++;
				return undefined;
			}
			const nestedKeys = new Set(nestedTargetKeys(target));
			const terminalKeys = new Set(prequeueKeys(target));
			const exemptRelay = (key: string): boolean =>
				nestedKeys.has(key) && !terminalKeys.has(key) && (lifecycleTargets.has(key) || reconnectTargets.has(key));
			const missing = keys.filter((key) => !hasLivePeer([key]) && !exemptRelay(key) && !authorizations.has(key));
			if (occupancy() + missing.length > budget.maxConnections) {
				denied++;
				return undefined;
			}
			const issued: IssuedTicket[] = [];
			const claims = new Set<ExplicitDialClaim>();
			for (const key of keys) {
				if (hasLivePeer([key]) || exemptRelay(key)) continue;
				let authorization = authorizations.get(key);
				if (authorization === undefined) {
					authorization = createAuthorization(key, "explicit");
					authorizations.set(key, authorization);
				} else if (authorization.kind === "selected") {
					authorization.kind = "explicit";
					authorization.discoveryPermit = false;
					if (!authorization.charged && authorization.timer !== undefined) {
						clearTimeout(authorization.timer);
						authorization.timer = undefined;
					}
				}
				const token = Symbol(key);
				authorization.tickets.add(token);
				issued.push({ authorization, claimed: false, token });
			}
			return {
				bindOptions: <T extends object>(dialTarget: ConnectionManagerTarget, options: T): T => {
					const routeKeys = targetKeys(dialTarget);
					const nestedKeys = new Set(nestedTargetKeys(dialTarget));
					const claimed = issued.filter((entry) => !entry.claimed && routeKeys.includes(entry.authorization.key));
					for (const entry of claimed) entry.claimed = true;
					const claim: ExplicitDialClaim = {
						issued: claimed,
						nestedKeys,
						nestedUsed: new Set<string>(),
						outerUsed: false,
						routeKeys,
					};
					claims.add(claim);
					return Object.assign({}, options, {
						[explicitDialClaim]: claim,
					});
				},
				release: (): void => {
					claims.clear();
					for (const { authorization, token } of issued) {
						authorization.tickets.delete(token);
						if (!authorization.charged && !authorization.discoveryPermit && authorization.tickets.size === 0) {
							removeAuthorization(authorization);
						}
					}
				},
			};
		},
		getSnapshot: (dependencyDialQueue, expectedReplicas, globalDiscovery) =>
			Object.freeze({
				budget: budget.maxConnections,
				charged: chargedCount(),
				denied,
				dependencyDialQueue,
				expectedReplicas,
				globalDiscovery,
				live: liveConnections.size,
				queued: 0,
				selected: selectedCount(),
				upgrade: reservations.size,
			}),
		recordDenied: (): void => {
			denied++;
		},
		revokeDiscoveredPeer: (peerId): void => {
			const key = `peer:${peerId}`;
			const authorization = authorizations.get(key);
			if (authorization?.kind === "selected" && !authorization.charged) {
				removeAuthorization(authorization);
			}
		},
		stop: (): void => {
			if (stopped) return;
			stopped = true;
			attachedHost?.removeEventListener("connection:open", onConnectionOpen);
			attachedHost?.removeEventListener("connection:close", onConnectionClose);
			for (const reservation of [...reservations]) removeReservation(reservation);
			for (const authorization of [...authorizations.values()]) removeAuthorization(authorization);
			lifecycleTargets.clear();
			for (const lease of [...reconnectTargets.values()]) removeReconnectLease(lease);
			nestedPeerPermits.clear();
			liveConnections.clear();
			attachedHost = undefined;
		},
		wrapConnectionManager: <T extends object>(manager: T): T => {
			const existing = wrappedManagers.get(manager);
			if (existing !== undefined) return existing as T;
			const target = manager as T & { openConnection?(...arguments_: unknown[]): Promise<unknown> };
			const original = target.openConnection;
			if (typeof original !== "function") return manager;
			Object.defineProperty(target, "openConnection", {
				configurable: true,
				value: async (...arguments_: unknown[]): Promise<unknown> => {
					const admission = authorizePrequeue(arguments_[0], arguments_[1]);
					if (admission === undefined) {
						denied++;
						const error = new Error("peer selection denied before dial queue insertion");
						error.name = "DialDeniedError";
						throw error;
					}
					const permit: TransportPermit = {
						...(admission.claim === undefined ? {} : { claim: admission.claim }),
						progressCallbacks: new Set(),
						targets: new Set(),
					};
					arguments_[1] = bindTransportPermit(arguments_[1], permit);
					if (admission.nestedKey !== undefined) incrementNestedPermit(admission.nestedKey);
					try {
						return (await Reflect.apply(original, target, arguments_)) as unknown;
					} finally {
						if (admission.nestedKey !== undefined) decrementNestedPermit(admission.nestedKey);
						clearTransportPermit(permit);
					}
				},
				writable: true,
			});
			wrappedManagers.set(manager, manager);
			return manager;
		},
		wrapTransportManager: <T extends object>(manager: T): T => {
			const existing = wrappedManagers.get(manager);
			if (existing !== undefined) return existing as T;
			const target = manager as T & { dial?(...arguments_: unknown[]): Promise<unknown> };
			const original = target.dial;
			if (typeof original !== "function") return manager;
			Object.defineProperty(target, "dial", {
				configurable: true,
				value: async (...arguments_: unknown[]): Promise<unknown> => {
					if (stopped) {
						denied++;
						const error = new Error("peer selection denied after admission shutdown");
						error.name = "DialDeniedError";
						throw error;
					}
					const targetObject = typeof arguments_[0] === "object" && arguments_[0] !== null ? arguments_[0] : undefined;
					const options = typeof arguments_[1] === "object" && arguments_[1] !== null ? arguments_[1] : undefined;
					const onProgress =
						options !== undefined && "onProgress" in options && typeof options.onProgress === "function"
							? (options.onProgress as (...arguments_: unknown[]) => unknown)
							: undefined;
					const permit =
						(targetObject === undefined ? undefined : transportPermits.get(targetObject)) ??
						(onProgress === undefined ? undefined : progressPermits.get(onProgress));
					if (permit === undefined) {
						denied++;
						const error = new Error("peer selection denied at transport boundary");
						error.name = "DialDeniedError";
						throw error;
					}
					if (targetObject !== undefined) {
						transportPermits.delete(targetObject);
						permit.targets.delete(targetObject);
					}
					if (onProgress !== undefined) {
						progressPermits.set(onProgress, permit);
						permit.progressCallbacks.add(onProgress);
					}
					arguments_[1] = Object.assign({}, options, {
						...(permit.claim === undefined ? {} : { [explicitDialClaim]: permit.claim }),
					});
					return (await Reflect.apply(original, target, arguments_)) as unknown;
				},
				writable: true,
			});
			wrappedManagers.set(manager, manager);
			return manager;
		},
	};
}
