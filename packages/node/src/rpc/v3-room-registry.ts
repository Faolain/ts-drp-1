import { randomUUID } from "node:crypto";

import type { V3RetainedHashPage, V3RetainedHashQuery } from "../v3-live.js";
import {
	authenticateV3RoomCreatorInvite,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomApplication,
	type V3RoomProjectionAuthority,
	type V3RoomSession,
} from "../v3-room.js";

/** Untrusted wire data; never a path, executable application or local capability. */
export interface V3RpcRoomOpenRequest {
	readonly applicationId: string;
	readonly creatorInvite: string;
}

type ReplicaInput<Projection extends V3RoomProjectionAuthority> = Omit<
	CreateV3RoomSessionInput<Projection>,
	"application" | "creatorInvite" | "objectId" | "receiveOnly" | "creatorFinalitySigner"
>;

/** The host owns partial-acquisition cleanup until this capability is returned. */
export interface V3RpcRoomAcquisition<Projection extends V3RoomProjectionAuthority> {
	readonly input: ReplicaInput<Projection>;
	/** Release external head/identity custody only after the room's admitted work joins. */
	close(): Promise<void>;
}

export interface V3RpcRoomApplicationRegistration<Projection extends V3RoomProjectionAuthority> {
	/** Exact catalog blueprint identity, registered by the local host. */
	readonly applicationId: string;
	readonly application: V3RoomApplication<Projection>;
	acquire(
		input: Readonly<{
			objectId: string;
			pinnedGenesisAnchorDigest: string;
			signal: AbortSignal;
		}>
	): Promise<V3RpcRoomAcquisition<Projection>>;
}

export interface V3RpcRoomRegistryOptions<Projection extends V3RoomProjectionAuthority> {
	/** Required host policy; opening, active and closing entries all consume capacity. */
	readonly maxActiveEntries: number;
	readonly applications: readonly V3RpcRoomApplicationRegistration<Projection>[];
}

export interface V3RpcRoomOpenReceipt {
	/** Opaque local handle, not portable protocol authority. */
	readonly subscriptionId: string;
	readonly applicationId: string;
	readonly objectId: string;
	readonly receiveOnly: true;
}

export interface V3RpcRoomOpenAttempt {
	readonly subscriptionId: string;
	readonly ready: Promise<V3RpcRoomOpenReceipt>;
}

interface Entry<Projection extends V3RoomProjectionAuthority> {
	readonly subscriptionId: string;
	readonly controller: AbortController;
	objectId?: string;
	acquisition?: V3RpcRoomAcquisition<Projection>;
	session?: V3RoomSession<Projection>;
	opening?: Promise<V3RpcRoomOpenReceipt>;
	disposal?: Promise<void>;
	closeTransport?(): void;
	revocationFailure?: unknown;
	removeAbortListener?(): void;
}

function captureRequest(value: V3RpcRoomOpenRequest): V3RpcRoomOpenRequest {
	if (value === null || typeof value !== "object") throw new TypeError("V3_RPC_INVALID_OPEN_REQUEST");
	const keys = Reflect.ownKeys(value);
	if (keys.length !== 2 || !keys.includes("applicationId") || !keys.includes("creatorInvite"))
		throw new TypeError("V3_RPC_INVALID_OPEN_REQUEST");
	const app = Object.getOwnPropertyDescriptor(value, "applicationId");
	const invite = Object.getOwnPropertyDescriptor(value, "creatorInvite");
	if (
		app === undefined ||
		invite === undefined ||
		!("value" in app) ||
		!("value" in invite) ||
		typeof app.value !== "string" ||
		!/^[0-9a-f]{64}$/u.test(app.value) ||
		typeof invite.value !== "string" ||
		invite.value.length === 0 ||
		invite.value.length > 131_072 ||
		invite.value.length % 2 !== 0 ||
		!/^[0-9a-f]+$/u.test(invite.value)
	)
		throw new TypeError("V3_RPC_INVALID_OPEN_REQUEST");
	return Object.freeze({
		applicationId: app.value as string,
		creatorInvite: invite.value as string,
	});
}

/**
 * Sole local RPC room lifetime registry. Capacity is reserved synchronously before
 * asynchronous authentication/acquisition; each admitted open has its own FIFO
 * promise and cancellation, rather than sharing or coalescing another call.
 */
export class V3RpcRoomRegistry<Projection extends V3RoomProjectionAuthority> {
	readonly #applications = new Map<string, V3RpcRoomApplicationRegistration<Projection>>();
	readonly #entries = new Map<string, Entry<Projection>>();
	readonly #maxActiveEntries: number;
	#tail: Promise<void> = Promise.resolve();
	#closed = false;
	#closing?: Promise<void>;

	/** @param options - Exact host-selected application registrations and active-entry policy. */
	constructor(options: V3RpcRoomRegistryOptions<Projection>) {
		if (
			!Number.isSafeInteger(options.maxActiveEntries) ||
			options.maxActiveEntries < 1 ||
			!Array.isArray(options.applications)
		)
			throw new TypeError("V3_RPC_INVALID_HOST_POLICY");
		this.#maxActiveEntries = options.maxActiveEntries;
		for (const registration of options.applications) {
			if (
				!/^[0-9a-f]{64}$/u.test(registration.applicationId) ||
				this.#applications.has(registration.applicationId) ||
				!registration.application.catalog.blueprintDigests.includes(registration.applicationId) ||
				typeof registration.acquire !== "function"
			)
				throw new TypeError("V3_RPC_INVALID_APPLICATION_REGISTRATION");
			this.#applications.set(
				registration.applicationId,
				Object.freeze({
					applicationId: registration.applicationId,
					application: registration.application,
					acquire: registration.acquire.bind(registration),
				})
			);
		}
	}

	/**
	 * Admit a fresh local subscription attempt; ready never grants write authority.
	 * @param request - Bounded untrusted application identity and signed invite.
	 * @param options - Local per-call cancellation, not portable wire authority.
	 * @returns Exact local subscription identity and this call's independent completion.
	 */
	open(request: V3RpcRoomOpenRequest, options: Readonly<{ signal?: AbortSignal }> = {}): V3RpcRoomOpenAttempt {
		const captured = captureRequest(request);
		if (this.#closed) throw new TypeError("V3_RPC_REGISTRY_CLOSED");
		const registration = this.#applications.get(captured.applicationId);
		if (registration === undefined) throw new TypeError("V3_RPC_APPLICATION_UNAVAILABLE");
		options.signal?.throwIfAborted();
		if (this.#entries.size >= this.#maxActiveEntries) throw new TypeError("V3_RPC_ROOM_CAPACITY");
		const entry: Entry<Projection> = {
			subscriptionId: randomUUID(),
			controller: new AbortController(),
		};
		this.#entries.set(entry.subscriptionId, entry);
		entry.opening = this.#tail.then(async () => {
			try {
				entry.controller.signal.throwIfAborted();
				const verified = authenticateV3RoomCreatorInvite({
					creatorInvite: captured.creatorInvite,
					application: registration.application,
				});
				if (verified.blueprintDigest !== captured.applicationId)
					throw new TypeError("V3_RPC_APPLICATION_IDENTITY_DIFFERS");
				entry.controller.signal.throwIfAborted();
				if ([...this.#entries.values()].some((other) => other !== entry && other.objectId === verified.objectId))
					throw new TypeError("V3_RPC_ROOM_ALREADY_OWNED");
				entry.objectId = verified.objectId;
				entry.acquisition = await registration.acquire(
					Object.freeze({
						objectId: verified.objectId,
						pinnedGenesisAnchorDigest: verified.pinnedGenesisAnchorDigest,
						signal: entry.controller.signal,
					})
				);
				entry.controller.signal.throwIfAborted();
				const input = entry.acquisition.input;
				if (Reflect.get(input, "creatorFinalitySigner") !== undefined)
					throw new TypeError("V3_RPC_REPLICA_SIGNING_CUSTODY_FORBIDDEN");
				entry.session = await createV3RoomSession({
					...input,
					application: registration.application,
					creatorInvite: captured.creatorInvite,
					objectId: verified.objectId,
					receiveOnly: true,
					openTransport: (objectId) => {
						entry.controller.signal.throwIfAborted();
						const transport = input.openTransport(objectId);
						let closed = false;
						const close = (): void => {
							if (closed) return;
							closed = true;
							transport.close();
						};
						entry.closeTransport = close;
						return Object.freeze({
							networkNode: transport.networkNode,
							close,
							openEphemeral: transport.openEphemeral.bind(transport),
							requestRetainedHistory: transport.requestRetainedHistory.bind(transport),
							setIngressHandler: transport.setIngressHandler.bind(transport),
							setRetainedPublisher: transport.setRetainedPublisher.bind(transport),
						});
					},
				});
				entry.controller.signal.throwIfAborted();
				return Object.freeze({
					subscriptionId: entry.subscriptionId,
					applicationId: captured.applicationId,
					objectId: entry.session.objectId,
					receiveOnly: true as const,
				});
			} catch (primary) {
				try {
					await this.#dispose(entry);
				} catch (cleanup) {
					throw new AggregateError([primary, cleanup], "V3_RPC_OPEN_AND_CLEANUP_FAILED");
				}
				throw primary;
			}
		});
		this.#tail = entry.opening.then(
			() => undefined,
			() => undefined
		);
		if (options.signal !== undefined) {
			const signal = options.signal;
			const abort = (): void => {
				void this.unsubscribe(entry.subscriptionId).catch(() => undefined);
			};
			signal.addEventListener("abort", abort, { once: true });
			entry.removeAbortListener = (): void => signal.removeEventListener("abort", abort);
			if (signal.aborted) abort();
		}
		return Object.freeze({
			subscriptionId: entry.subscriptionId,
			ready: entry.opening,
		});
	}

	/**
	 * Immediately revoke this exact handle, then join opening and durable close.
	 * @param subscriptionId - Exact opaque local identity from admission.
	 */
	async unsubscribe(subscriptionId: string): Promise<void> {
		const entry = this.#entries.get(subscriptionId);
		if (entry === undefined) throw new TypeError("V3_RPC_SUBSCRIPTION_UNAVAILABLE");
		this.#revoke(entry);
		await entry.opening?.catch(() => undefined);
		await this.#dispose(entry);
	}

	/**
	 * Query only an already admitted active replica, with explicit bounded coverage.
	 * @param subscriptionId - Exact opaque local handle.
	 * @param query - Bounded page selector, never authority.
	 * @returns Authenticated current retained window page.
	 */
	queryRetainedHashes(subscriptionId: string, query: V3RetainedHashQuery): Promise<V3RetainedHashPage> {
		return this.#activeSession(subscriptionId).queryRetainedHashes(query);
	}

	/**
	 * Actual retained repair scheduling; never a no-op convergence acknowledgement.
	 * @param subscriptionId - Exact opaque local handle.
	 * @param input - Optional connected transport target.
	 * @returns Scheduling acknowledgement, not convergence.
	 */
	requestRetainedRepair(
		subscriptionId: string,
		input: Readonly<{ targetPeerId?: string }> = {}
	): Promise<Readonly<{ kind: "scheduled" }>> {
		return this.#activeSession(subscriptionId).requestRetainedRepair(input);
	}

	#activeSession(subscriptionId: string): V3RoomSession<Projection> {
		const entry = this.#entries.get(subscriptionId);
		if (this.#closed || entry === undefined || entry.controller.signal.aborted || entry.session === undefined)
			throw new TypeError("V3_RPC_SUBSCRIPTION_UNAVAILABLE");
		return entry.session;
	}

	/**
	 * Revoke every entry before waiting for any admitted acquisition or close.
	 * @returns Joined shutdown, retaining failed cleanup custody/capacity.
	 */
	close(): Promise<void> {
		if (this.#closing !== undefined) return this.#closing;
		this.#closed = true;
		const entries = [...this.#entries.values()];
		for (const entry of entries) this.#revoke(entry);
		this.#closing = (async (): Promise<void> => {
			const outcomes = await Promise.allSettled(
				entries.map(async (entry): Promise<void> => {
					await entry.opening?.catch(() => undefined);
					await this.#dispose(entry);
				})
			);
			const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
			if (errors.length > 0) throw new AggregateError(errors, "V3_RPC_REGISTRY_CLOSE_FAILED");
		})();
		return this.#closing;
	}

	#revoke(entry: Entry<Projection>): void {
		entry.controller.abort(new TypeError("V3_RPC_SUBSCRIPTION_CANCELLED"));
		try {
			entry.closeTransport?.();
		} catch (error) {
			entry.revocationFailure ??= error;
		}
	}

	#dispose(entry: Entry<Projection>): Promise<void> {
		if (entry.disposal !== undefined) return entry.disposal;
		entry.removeAbortListener?.();
		entry.disposal = (async (): Promise<void> => {
			const errors: unknown[] = entry.revocationFailure === undefined ? [] : [entry.revocationFailure];
			try {
				await entry.session?.close();
			} catch (error) {
				errors.push(error);
			}
			try {
				await entry.acquisition?.close();
			} catch (error) {
				errors.push(error);
			}
			if (errors.length > 0) throw new AggregateError(errors, "V3_RPC_SUBSCRIPTION_CLOSE_FAILED");
			this.#entries.delete(entry.subscriptionId);
		})();
		return entry.disposal;
	}
}
