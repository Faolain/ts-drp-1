import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	createSigningStorageCodec,
	captureSigningRetirementDataImage,
	releaseCapturedSigningRetirementDataImage,
	isSigningSummaryRetirementPlan,
	SIGNING_DETAIL_RETIREMENT_BATCH_ROWS,
	type SigningDependencyObservation,
	type SigningEvidenceRetirementPlan,
	type SigningRetirementControl,
	signingRetirementDrainFields,
	signingRetirementFrameDigest,
	signingRetirementMetadataFields,
	type SigningRetirementObservation,
	type SigningRetirementPreparation,
	type SigningRetirementResult,
	signingRetirementStorageMetaRow,
	type SigningSummaryRetirementPlan,
} from "@ts-drp/seal/internal/storage-port";
import { AHE_BOUNDED_READ_LIMITS as LIMITS } from "@ts-drp/storage";

import { NativeReadReservationOwner } from "./native-read-reservation.js";
import { assertCurrentBrowserSchema, SIGNING_PARTICIPANT_SCHEMA_AUTHORITY } from "./schema-idb.js";

const {
	plainRecord,
	record,
	preparation,
	monotone,
	control,
	equal,
	retirementDrainPlan,
	idle,
	retired,
	summaryMaintenancePending,
	incarnationPattern,
	controlLimits,
	keyFor,
	safe,
} = createSigningStorageCodec(LIMITS);

export interface SigningFrontierScope {
	readonly objectId: string;
	readonly epoch: number;
	readonly signerId: string;
}

/**
 * Checks original catalog/incarnation in the admitted native transaction.
 * @param transaction - Same-database native transaction.
 * @param expectedIncarnation - Captured original incarnation.
 */
export async function assertSigningCurrency(transaction: IDBTransaction, expectedIncarnation: string): Promise<void> {
	assertCurrentBrowserSchema(transaction);
	const meta: unknown = await request(transaction.objectStore("storageMeta").get("incarnation"));
	if (!plainRecord(meta) || meta.key !== "incarnation" || meta.value !== expectedIncarnation)
		throw new Error("STORAGE_LOSS");
}

/**
 * Original signer-row round law, shared by normal mutations and held admission.
 * @param transaction - Original native read or mutation transaction.
 * @param scope - Exact original signer-row address.
 * @param expectedIncarnation - Captured native incarnation.
 * @returns Original monotone round floor, zero for an absent signer row.
 */
export async function readSigningFrontier(
	transaction: IDBTransaction,
	scope: SigningFrontierScope,
	expectedIncarnation: string
): Promise<number> {
	const completion = terminal(transaction);
	try {
		await assertSigningCurrency(transaction, expectedIncarnation);
		const state: unknown = await request(
			transaction.objectStore("signerState").get([scope.objectId, scope.epoch, scope.signerId])
		);
		if (state === undefined) return 0;
		if (
			!plainRecord(state) ||
			state.objectId !== scope.objectId ||
			state.epoch !== scope.epoch ||
			state.signerId !== scope.signerId ||
			!safe(state.enteredRound) ||
			!safe(state.revision)
		)
			throw new Error("INVALID_SIGNING_FRONTIER");
		const floor = state.retiredBeforeRound === undefined ? 0 : state.retiredBeforeRound;
		if (!safe(floor) || floor > state.enteredRound) throw new Error("INVALID_SIGNING_FRONTIER");
		return floor;
	} catch (cause) {
		try {
			transaction.abort();
		} catch {
			/* Already terminal. */
		}
		try {
			await completion;
		} catch {
			/* Preserve the native/source failure. */
		}
		throw cause;
	}
}

const stores = SIGNING_PARTICIPANT_SCHEMA_AUTHORITY.stores.map((store) => store.name);
const signingStores = ["signerState", "sealEvidence", "voteSlots", "voteOutbox"] as const;
// The addressed capture spends the existing U entitlement, not an additional
// signing entitlement. A native poisoned structured clone precedes this check.
const imageLimits = { maxBytes: LIMITS.maxUnionBytes, maxItems: 65_536, maxDepth: 128 };

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.addEventListener("success", () => resolve(value.result), { once: true });
		value.addEventListener("error", () => reject(value.error ?? new Error("NATIVE_REQUEST_FAILED")), { once: true });
	});
}

/**
 * Joins the actual native transaction terminal, never an earlier request-error
 * event bubbling through a still-aborting transaction.
 * @param transaction - Original same-database native transaction.
 * @returns Complete or the original abort outcome.
 */
function terminal(transaction: IDBTransaction): Promise<void> {
	const completion = new Promise<void>((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("NATIVE_ABORT")), { once: true });
	});
	void completion.catch(() => undefined);
	return completion;
}

async function nativeControl(
	transaction: IDBTransaction,
	objectId: string,
	incarnation: string
): Promise<Readonly<{
	control: SigningRetirementControl;
	incarnationRow: Record<string, unknown>;
	controlRow: unknown;
}>> {
	assertCurrentBrowserSchema(transaction);
	if (!incarnationPattern.test(incarnation)) throw new Error("STORAGE_LOSS");
	const meta = record(await request(transaction.objectStore("storageMeta").get("incarnation")), ["key", "value"]);
	if (meta.key !== "incarnation" || meta.value !== incarnation) throw new Error("STORAGE_LOSS");
	const value: unknown = await request(transaction.objectStore("storageMeta").get(keyFor(objectId)));
	if (value === undefined) return { control: idle(objectId, incarnation), incarnationRow: meta, controlRow: value };
	const row = record(value, ["key", "value"]);
	if (row.key !== keyFor(objectId)) throw new Error("INVALID_SIGNING_CONTROL");
	return { control: control(row.value, objectId, incarnation), incarnationRow: meta, controlRow: value };
}

/**
 * Same-native-transaction mechanical admission; not authenticated source eligibility.
 * @param transaction - Original same-database transaction.
 * @param objectId - Exact addressed original object.
 * @param epoch - Original admitted epoch scope.
 * @param incarnation - Original native incarnation.
 * @returns Typed mechanical epoch refusal, or no epoch fence.
 */
export async function signingMutationRefusal(
	transaction: IDBTransaction,
	objectId: string,
	epoch: number,
	incarnation: string
): Promise<string | undefined> {
	const { control: current } = await nativeControl(transaction, objectId, incarnation);
	if (summaryMaintenancePending(current)) return "SIGNING_MAINTENANCE_DEBT";
	if (current.drain !== undefined && current.drain !== null && current.drain.cursor < current.drain.plan.entries.length)
		return "SIGNING_MAINTENANCE_DEBT";
	if (retired(current.completed, epoch)) return "SIGNING_RETIRED";
	if (retired(current.active?.preparation ?? null, epoch)) return "RETIREMENT_FENCED";
	return undefined;
}

interface Image {
	readonly frames: readonly Uint8Array[];
	readonly control: SigningRetirementControl;
	readonly digest: string;
	readonly logicalBytes: number;
	readonly controlBytes: number;
	readonly pendingEpochs: readonly number[];
	readonly dataDigest: string;
	readonly data: ReturnType<typeof captureSigningRetirementDataImage>;
}

/**
 * Captures the original addressed signing image within its existing union-byte
 * entitlement. The commitment provides native currency, not source authority.
 * @param transaction - Same native reservation or strict writer transaction.
 * @param objectId - Exact original addressed object.
 * @param incarnation - Original expected storage incarnation.
 * @param allowAbsent - Permit pristine authentic enrollment without row birth.
 * @returns Bounded exact frames and their original native commitment.
 */
async function image(
	transaction: IDBTransaction,
	objectId: string,
	incarnation: string,
	allowAbsent = false
): Promise<Image> {
	const captured = await nativeControl(transaction, objectId, incarnation);
	const frames: Uint8Array[] = [];
	let logicalBytes = 0,
		count = 0,
		present = false,
		controlBytes = 0;
	const pendingEpochs: number[] = [];
	const add = (store: string, key: IDBValidKey, value: unknown): void => {
		if (++count > 65_536) throw new Error("SIGNING_IMAGE_COUNT_FULL");
		const bytes = encodeCanonical([store, key, value], {
			...imageLimits,
			maxBytes: LIMITS.maxUnionBytes - logicalBytes,
		});
		logicalBytes += bytes.byteLength;
		frames.push(bytes);
		if (store === "storageMeta" && key === keyFor(objectId)) controlBytes = bytes.byteLength;
	};
	for (const key of ["incarnation", `ahe-retirement:${objectId}`, keyFor(objectId)]) {
		// These rows were just captured and validated in this SAME native
		// transaction. Reuse their exact values, not a previous transaction's
		// currency or admission decision. Nothing escapes before image creation.
		const value: unknown = key === "incarnation" ? captured.incarnationRow :
			key === keyFor(objectId) ? captured.controlRow :
			await request(transaction.objectStore("storageMeta").get(key));
		// Absence is committed too, without granting a missing metadata row authority.
		add("storageMeta", key, value === undefined ? null : value);
	}
	for (const name of signingStores) {
		await new Promise<void>((resolve, reject) => {
			const native = transaction.objectStore(name);
			const cursorRequest = native.openKeyCursor(IDBKeyRange.bound([objectId], [objectId, []]));
			cursorRequest.onerror = (): void => reject(cursorRequest.error);
			cursorRequest.onsuccess = (): void => {
				const cursor = cursorRequest.result;
				if (cursor === null) {
					resolve();
					return;
				}
				void (async (): Promise<void> => {
					const key = cursor.key;
					if (!Array.isArray(key) || key[0] !== objectId || !safe(key[1])) throw new Error("INVALID_SIGNING_ADDRESS");
					const short = name === "signerState" || name === "sealEvidence";
					if (
						key.length !== (short ? 3 : 5) ||
						typeof key[key.length - 1] !== "string" ||
						(!short && (!safe(key[2]) || !["prepare", "commit", "round-change"].includes(key[3] as string)))
					)
						throw new Error("INVALID_SIGNING_ADDRESS");
					// Key/count/minimum canonical frame admission precedes the native
					// value clone. An oversized poisoned row itself remains an IDB
					// structured-clone substrate limitation, not a JS preallocation proof.
					if (
						count >= 65_536 ||
						logicalBytes + encodeCanonical([name, key, null], imageLimits).byteLength > LIMITS.maxUnionBytes
					)
						throw new Error("SIGNING_IMAGE_FULL");
					const value = (await request(native.get(cursor.primaryKey))) as Record<string, unknown>;
					if (
						value === null ||
						typeof value !== "object" ||
						value.objectId !== objectId ||
						value.epoch !== key[1] ||
						value.signerId !== key[key.length - 1]
					)
						throw new Error("INVALID_SIGNING_ADDRESS");
					if (
						name === "signerState" &&
						(!safe(value.revision) ||
							!safe(value.enteredRound) ||
							(value.retiredBeforeRound !== undefined &&
								(!safe(value.retiredBeforeRound) || value.retiredBeforeRound > value.enteredRound)))
					)
						throw new Error("INVALID_SIGNING_FRONTIER");
					if (!short && (value.round !== key[2] || value.phase !== key[3])) throw new Error("INVALID_SIGNING_ADDRESS");
					add(name, key, value);
					present = true;
					if (name === "voteOutbox" && value.dispatched !== true) pendingEpochs.push(key[1]);
					cursor.continue();
				})().catch(reject);
			};
		});
	}
	if (!present && !allowAbsent) throw new Error("SIGNING_ADDRESS_ABSENT");
	const digest = Array.from(hashDomain("ts-drp/signing-native-image/v1", ...frames), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	// Preserve the original full decoder's byte/item/depth validation once for
	// this freshly encoded image. Its private parsed rows serve later projections
	// in this same native transaction, never another transaction's currency.
	const data = captureSigningRetirementDataImage(frames, objectId);
	frames.length = 0; // Drop encoded inputs: the parser owns the sole retained inventory.
	return {
		control: captured.control,
		digest,
		logicalBytes,
		controlBytes,
		pendingEpochs,
		// The parser is the sole retained byte inventory. Encoded inputs above
		// can now drop; callers receive the original detached mutable byte view.
		get frames() { return data.readExactCanonicalRows(); },
		dataDigest: data.digest(),
		data,
	};
}

// The original native writer reuses this exact bounded census/parser for its
// whole-image CAS; no second authority or collector owns row eligibility.
export { image as readSigningNativeImage, terminal as signingNativeTransactionComplete };

/** Child custody of the original signing/evidence connection, not another authority owner. */
interface SharedSigningGroup {
	readonly objectId: string;
	readonly kind: "dependency" | "retirement" | "recovery";
	readonly roles: Set<"vote" | "evidence">;
	capture: Promise<SigningRetirementObservation> | undefined;
	open: boolean;
	remaining: number;
	release?: Promise<void>;
}

export class SigningRetirementOwner {
	readonly #database: IDBDatabase;
	readonly #incarnation: string;
	readonly #reads: NativeReadReservationOwner;
	readonly #operations = new Set<Promise<unknown>>();
	readonly #signingHolds = new Set<Promise<void>>();
	#closed = false;
	#closing?: Promise<void>;
	#sharedGroup?: SharedSigningGroup;

	/**
	 * Uses only the original connection and native read-lifetime owner.
	 * @param database - Original signing/evidence database connection.
	 * @param incarnation - Captured original native incarnation.
	 */
	constructor(database: IDBDatabase, incarnation: string) {
		this.#database = database;
		this.#incarnation = incarnation;
		this.#reads = new NativeReadReservationOwner(database);
	}

	/** Signing-only RO: authentic enrollment may legitimately have no initial row. */
	async acquireSigningAdmission(
		input: Readonly<{ objectId: string }>
	): Promise<import("@ts-drp/seal/internal/storage-port").SigningNativeRead> {
		const copied = record(input, ["objectId"]);
		if (typeof copied.objectId !== "string" || !copied.objectId || copied.objectId.includes("\0"))
			throw new TypeError("INVALID_SIGNING_ADDRESS");
		const objectId = copied.objectId;
		encodeCanonical(objectId, controlLimits);
		if (this.#closed) throw new Error("STORE_CLOSED");
		const held = await this.#reads.acquire({ objectId });
		try {
			// Same bounded parser/census, but read-only authentic enrollment may
			// be pristine. It never admits retirement-control metadata birth.
			await this.#reads.runRead(() => image(this.#reads.readTransaction(stores), objectId, this.#incarnation, true));
			await held.check();
			if (this.#closed) throw new Error("STORE_CLOSED");
		} catch (primary) {
			try {
				await held.release();
			} catch (cleanup) {
				throw new AggregateError([primary, cleanup], "signing admission acquisition failed", { cause: primary });
			}
			throw primary;
		}
		const owner = this;
		let released = false;
		let resolveJoin!: () => void, rejectJoin!: (cause: unknown) => void;
		const joined = new Promise<void>((resolve, reject) => {
			resolveJoin = resolve;
			rejectJoin = reject;
		});
		void joined.catch(() => undefined);
		this.#signingHolds.add(joined);
		let releaseTask: Promise<void> | undefined;
		const admission: import("@ts-drp/seal/internal/storage-port").SigningNativeRead = Object.freeze({
			incarnation: this.#incarnation,
			async check() {
				if (this !== admission) throw new TypeError("FOREIGN_SIGNING_ADMISSION");
				if (released || owner.#closed) throw new Error("READ_RELEASED");
				await held.check();
			},
			async checkSigningScope(input: Readonly<{ epoch: number; round: number; signerId: string }>) {
				if (this !== admission) throw new TypeError("FOREIGN_SIGNING_ADMISSION");
				if (released || owner.#closed) return { ok: false as const, reason: "READ_RELEASED" };
				return owner.#checkSigningScope(held, objectId, input);
			},
			release() {
				if (this !== admission) return Promise.reject(new TypeError("FOREIGN_SIGNING_ADMISSION"));
				released = true;
				return (releaseTask ??= held.release().then(
					() => {
						owner.#signingHolds.delete(joined);
						resolveJoin();
					},
					(cause) => {
						owner.#signingHolds.delete(joined);
						rejectJoin(cause);
						throw cause;
					}
				));
			},
		});
		return admission;
	}

	async #checkSigningScope(
		held: Awaited<ReturnType<NativeReadReservationOwner["acquire"]>>,
		objectId: string,
		input: Readonly<{ epoch: number; round: number; signerId: string }>
	): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>> {
		const scope = record(input, ["epoch", "round", "signerId"]);
		if (
			!safe(scope.epoch) ||
			!safe(scope.round) ||
			typeof scope.signerId !== "string" ||
			!scope.signerId ||
			scope.signerId.includes("\0")
		)
			throw new TypeError("INVALID_SIGNING_SCOPE");
		encodeCanonical(scope, controlLimits);
		await held.check();
		const result = await this.#reads.runRead(async () => {
			const transaction = this.#reads.readTransaction(stores);
			let refusal: string | undefined;
			try {
				refusal = await signingMutationRefusal(transaction, objectId, scope.epoch as number, this.#incarnation);
			} catch (cause) {
				if (cause instanceof Error && cause.message === "STORAGE_LOSS")
					return { ok: false as const, reason: "STORAGE_LOSS" };
				throw cause;
			}
			if (refusal !== undefined) return { ok: false as const, reason: refusal };
			const floor = await readSigningFrontier(
				transaction,
				{ objectId, epoch: scope.epoch as number, signerId: scope.signerId as string },
				this.#incarnation
			);
			return (scope.round as number) < floor
				? { ok: false as const, reason: "SIGNING_RETIRED" }
				: { ok: true as const };
		});
		await held.check();
		return Object.freeze(result);
	}

	/**
	 * Acquires addressed bounded native custody, not source eligibility.
	 * @param input - Exact existing object address.
	 * @returns Identity-bound captured native observation.
	 */
	async acquire(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation> {
		return this.#acquireImage(input, false);
	}

	/** Received recovery may own a never-signing native address. Capture actual
	 * absence and all safety metadata under the same reservation/CAS; the semantic
	 * recovery owner still authenticates eligibility before any metadata write.
	 * Ordinary creator capture and every detail-drain prerequisite are unchanged. */
	async acquireRecovery(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation> {
		return this.#acquireImage(input, true);
	}

	/**
	 * Captures even an empty native domain without control birth or mutation capability.
	 * @param input - Exact existing object address.
	 * @returns Identity-bound native read observation without retirement authority.
	 */
	async acquireDependency(input: Readonly<{ objectId: string }>): Promise<SigningDependencyObservation> {
		const observation = await this.#acquireImage(input, true);
		const read: SigningDependencyObservation = Object.freeze({
			control: observation.control,
			imageDigest: observation.imageDigest,
			logicalBytes: observation.logicalBytes,
			readExactCanonicalRows: function () {
				if (this !== read) throw new TypeError("FOREIGN_SIGNING_OBSERVATION");
				return observation.readExactCanonicalRows();
			},
			readRetirementDataImage: function () {
				if (this !== read) throw new TypeError("FOREIGN_SIGNING_OBSERVATION");
				return observation.readRetirementDataImage!();
			},
			check: function () {
				if (this !== read) return Promise.reject(new TypeError("FOREIGN_SIGNING_OBSERVATION"));
				return observation.check();
			},
			release: function () {
				if (this !== read) return Promise.reject(new TypeError("FOREIGN_SIGNING_OBSERVATION"));
				return observation.release();
			},
		});
		return read;
	}

	/** Only the paired native factory calls this role-addressed dependency seam.
	 * Validity is exact backend/owner/object/open capture, not actor or epoch
	 * authority. Each caller independently authenticates and pays its full rows.
	 * One group has at most one child per facet; no retirement methods escape. */
	acquireSharedDependency(input: Readonly<{objectId: string}>, role: "vote" | "evidence"): Promise<SigningDependencyObservation> {
		return this.#trackSharedAcquisition(input, role, "dependency");
	}

	/** Paired facets share one physical image, not two competing reservations.
	 * Mutation is available only after all sibling custody and admitted reads join.
	 * The original image owner still performs its full fresh native RW/CAS. */
	acquireSharedRetirement(input: Readonly<{objectId: string}>, role: "vote" | "evidence",
		recovery = false): Promise<SigningRetirementObservation> {
		return this.#trackSharedAcquisition(input, role, recovery ? "recovery" : "retirement") as Promise<SigningRetirementObservation>;
	}

	#trackSharedAcquisition(input: Readonly<{objectId: string}>, role: "vote" | "evidence",
		kind: SharedSigningGroup["kind"]): Promise<SigningDependencyObservation | SigningRetirementObservation> {
		const task = this.#acquireSharedObservation(input, role, kind);
		this.#operations.add(task);
		void task.then(() => this.#operations.delete(task), () => this.#operations.delete(task));
		return task;
	}

	async #acquireSharedObservation(input: Readonly<{objectId: string}>, role: "vote" | "evidence",
		kind: SharedSigningGroup["kind"]): Promise<SigningDependencyObservation | SigningRetirementObservation> {
		const copied = record(input, ["objectId"]);
		if (typeof copied.objectId !== "string" || !copied.objectId || copied.objectId.includes("\0") ||
			(role !== "vote" && role !== "evidence")) throw new TypeError("INVALID_SIGNING_ADDRESS");
		const objectId = copied.objectId;
		encodeCanonical(objectId, controlLimits);
		if (this.#closed) throw new Error("STORE_CLOSED");
		let group = this.#sharedGroup;
		if (group === undefined) {
			group = {objectId, kind, roles: new Set(), open: true, remaining: 0,
				capture: this.#acquireImage({objectId}, kind !== "retirement")};
			this.#sharedGroup = group;
		}
		if (!group.open || group.objectId !== objectId || group.kind !== kind || group.roles.has(role))
			throw new Error("SIGNING_DEPENDENCY_ADMISSION_REFUSED");
		group.roles.add(role); group.remaining++;
		const owner = this, admitted = group;
		const releaseSlot = (): Promise<void> => {
			admitted.open = false;
			admitted.remaining--;
			if (admitted.remaining !== 0) return Promise.resolve();
			return admitted.release ??= admitted.capture!.then(observation => observation.release(), () => undefined).finally(() => {
				admitted.capture = undefined;
				if (owner.#sharedGroup === admitted) owner.#sharedGroup = undefined;
			});
		};
		let observation: SigningRetirementObservation | undefined, rows: readonly Uint8Array[], childControl: SigningRetirementControl;
		try {
			observation = await admitted.capture!;
			await observation.check();
			if (this.#closed) throw new Error("STORE_CLOSED");
			rows = observation.readExactCanonicalRows();
			childControl = control(observation.control, objectId, this.#incarnation);
		} catch (primary) {
			try { await releaseSlot(); }
			catch (cleanup) { throw new AggregateError([primary, cleanup], "shared signing acquisition and release failed", {cause: primary}); }
			throw primary;
		}
		let live = true, releaseTask: Promise<void> | undefined;
		const pending = new Set<Promise<unknown>>();
		const track = <T>(task: Promise<T>): Promise<T> => {
			pending.add(task); owner.#operations.add(task);
			void task.then(() => {pending.delete(task); owner.#operations.delete(task);},
				() => {pending.delete(task); owner.#operations.delete(task);});
			return task;
		};
		const mutate = (self: unknown, action: () => Promise<SigningRetirementResult>): Promise<SigningRetirementResult> => {
			if (self !== child) return Promise.reject(new TypeError("FOREIGN_SIGNING_OBSERVATION"));
			if (!live || owner.#closed) return Promise.resolve({ok: false, reason: "READ_RELEASED"});
			if (admitted.remaining !== 1 || pending.size !== 0)
				return Promise.resolve({ok: false, reason: "READ_JOIN_REQUIRED"});
			// Synchronous revocation prevents a sibling or new check from racing
			// the original transition's release-and-CAS boundary. Arguments are
			// captured synchronously by that original transition, before any await.
			live = false; admitted.open = false;
			return track(action());
		};
		const child: SigningDependencyObservation | SigningRetirementObservation = Object.freeze({
			control: childControl,
			imageDigest: observation.imageDigest, logicalBytes: observation.logicalBytes,
			readExactCanonicalRows: function() {
				if (this !== child) throw new TypeError("FOREIGN_SIGNING_OBSERVATION");
				if (!live || owner.#closed) throw new Error("READ_RELEASED");
				return Object.freeze(rows.map(bytes => bytes.slice()));
			},
			readRetirementDataImage: function() {
				if (this !== child) throw new TypeError("FOREIGN_SIGNING_OBSERVATION");
				if (!live || owner.#closed) throw new Error("READ_RELEASED");
				return observation!.readRetirementDataImage!();
			},
			check: function() {
				if (this !== child) return Promise.reject(new TypeError("FOREIGN_SIGNING_OBSERVATION"));
				if (!live || owner.#closed) return Promise.reject(new Error("READ_RELEASED"));
				const task = Promise.resolve().then(async () => {
					if (!live || owner.#closed) throw new Error("READ_RELEASED");
					await observation!.check();
					if (!live || owner.#closed) throw new Error("READ_RELEASED");
				});
				return track(task);
			},
			release: function() {
				if (this !== child) return Promise.reject(new TypeError("FOREIGN_SIGNING_OBSERVATION"));
				if (releaseTask !== undefined) return releaseTask;
				live = false; admitted.open = false;
				return releaseTask = Promise.allSettled([...pending]).then(() => {
					rows = Object.freeze([]);
					observation = undefined;
					return releaseSlot();
				});
			},
			...(kind === "dependency" ? {} : {
				checkSigningScope: function(input: Readonly<{epoch: number; round: number; signerId: string}>) {
					if (this !== child) return Promise.reject(new TypeError("FOREIGN_SIGNING_OBSERVATION"));
					if (!live || owner.#closed) return Promise.resolve({ok: false as const, reason: "READ_RELEASED"});
					return track(observation!.checkSigningScope(input));
				},
				prepareFence: function(value: SigningRetirementPreparation) {
					return mutate(this, () => observation!.prepareFence(value));
				},
				abortPrepared: function() { return mutate(this, () => observation!.abortPrepared()); },
				commitPrepared: function() { return mutate(this, () => observation!.commitPrepared()); },
				beginEvidenceDrain: function(value: SigningEvidenceRetirementPlan) {
					return mutate(this, () => observation!.beginEvidenceDrain(value));
				},
				beginSummaryDrain: function(value: SigningSummaryRetirementPlan) {
					return mutate(this, () => observation!.beginSummaryDrain(value));
				},
				drainEvidenceBatch: function() { return mutate(this, () => observation!.drainEvidenceBatch()); },
			}),
		});
		return child;
	}

	async #acquireImage(
		input: Readonly<{ objectId: string }>,
		allowAbsent: boolean
	): Promise<SigningRetirementObservation> {
		const copied = record(input, ["objectId"]);
		if (typeof copied.objectId !== "string" || copied.objectId.length === 0 || copied.objectId.includes("\0"))
			throw new TypeError("INVALID_SIGNING_ADDRESS");
		const objectId = copied.objectId;
		encodeCanonical(objectId, controlLimits);
		if (this.#closed) throw new Error("STORE_CLOSED");
		const held = await this.#reads.acquire({ objectId });
		let captured: Image;
		try {
			captured = await this.#reads.runRead(() =>
				image(this.#reads.readTransaction(stores), objectId, this.#incarnation, allowAbsent)
			);
			await held.check();
			if (this.#closed) throw new Error("STORE_CLOSED");
		} catch (primary) {
			try {
				await held.release();
			} catch (cleanup) {
				throw new AggregateError([primary, cleanup], "signing capture failed", { cause: primary });
			}
			throw primary;
		}
		let live = true,
			used = false;
		const owner = this;
		let released: Promise<void> | undefined;
		const release = (): Promise<void> => {
			live = false;
			releaseCapturedSigningRetirementDataImage(captured.data);
			return (released ??= held.release());
		};
		const receiver = (self: unknown): void => {
			if (self !== observation) throw new TypeError("FOREIGN_SIGNING_OBSERVATION");
		};
		const transition = (
			kind: "prepare" | "abort" | "commit",
			value?: SigningRetirementPreparation
		): Promise<SigningRetirementResult> => {
			if (!live || used || this.#closed) return Promise.resolve({ ok: false, reason: "READ_RELEASED" });
			if ((kind === "prepare") === (captured.control.active !== null))
				return Promise.resolve({ ok: false, reason: "ILLEGAL_TRANSITION" });
			const drain = captured.control.drain;
			if (kind === "prepare" && summaryMaintenancePending(captured.control))
				return Promise.resolve({ ok: false, reason: "SIGNING_MAINTENANCE_DEBT" });
			if (kind === "prepare" && drain !== undefined && drain !== null && drain.cursor < drain.plan.entries.length)
				return Promise.resolve({ ok: false, reason: "SIGNING_MAINTENANCE_DEBT" });
			let proposed: SigningRetirementPreparation | undefined;
			if (kind === "prepare") {
				try {
					proposed = preparation(value, objectId);
				} catch {
					return Promise.resolve({ ok: false, reason: "MALFORMED_INPUT" });
				}
				if (!monotone(captured.control.completed, proposed))
					return Promise.resolve({ ok: false, reason: "RETIRED_HOLE_REINTRODUCED" });
			}
			used = true;
			const operation = (async (): Promise<SigningRetirementResult> => {
				await release(); // Revoke and join the physical RO before entering RW.
				if (this.#closed) return { ok: false, reason: "STORE_CLOSED" };
				const transaction = this.#database.transaction(stores, "readwrite", { durability: "strict" });
				const completion = terminal(transaction);
				try {
					if (transaction.durability !== "strict") throw new Error("STRICT_DURABILITY_UNAVAILABLE");
					const actual = await image(transaction, objectId, this.#incarnation, allowAbsent);
					if (actual.digest !== captured.digest) {
						await completion;
						return { ok: false, reason: "NATIVE_IMAGE_CHANGED" };
					}
					const old = actual.control;
					if (
						old.revision === Number.MAX_SAFE_INTEGER ||
						(kind === "prepare" && old.sequence === Number.MAX_SAFE_INTEGER)
					)
						throw new Error("SIGNING_REVISION_EXHAUSTED");
					if (kind === "prepare" && actual.pendingEpochs.some((epoch) => retired(proposed ?? null, epoch))) {
						await completion;
						return { ok: false, reason: "SIGNING_DISPATCH_DEBT" };
					}
					const next = control(
						signingRetirementMetadataFields(old, kind, proposed, actual.digest),
						objectId,
						this.#incarnation
					);
					const row = signingRetirementStorageMetaRow(objectId, next);
					const bytes = encodeCanonical(["storageMeta", row.key, row], controlLimits);
					if (actual.logicalBytes - actual.controlBytes + bytes.byteLength > LIMITS.maxUnionBytes)
						throw new Error("SIGNING_IMAGE_BYTES_FULL");
					await request(transaction.objectStore("storageMeta").put(row));
					await completion;
					return Object.freeze({ ok: true, control: next });
				} catch (primary) {
					try {
						transaction.abort();
					} catch {
						/* Already terminal. */
					}
					try {
						await completion;
					} catch {
						/* Preserve original failure. */
					}
					throw primary;
				}
			})();
			this.#operations.add(operation);
			void operation.then(
				() => this.#operations.delete(operation),
				() => this.#operations.delete(operation)
			);
			return operation;
		};
		const drainTransition = (
			kind: "begin" | "batch",
			value?: SigningEvidenceRetirementPlan | SigningSummaryRetirementPlan
		): Promise<SigningRetirementResult> => {
			if (!live || used || this.#closed) return Promise.resolve({ ok: false, reason: "READ_RELEASED" });
			let plan: SigningEvidenceRetirementPlan | SigningSummaryRetirementPlan;
			try {
				plan =
					kind === "begin"
						? retirementDrainPlan(value, objectId, this.#incarnation)
						: retirementDrainPlan(captured.control.drain?.plan, objectId, this.#incarnation);
			} catch {
				return Promise.resolve({ ok: false, reason: "MALFORMED_INPUT" });
			}
			if (
				captured.control.active !== null ||
				captured.control.completed === null ||
				(captured.control.completed.summarySource !== undefined && !isSigningSummaryRetirementPlan(plan)) ||
				(kind === "begin" && captured.control.drain != null)
			)
				return Promise.resolve({ ok: false, reason: "ILLEGAL_TRANSITION" });
			used = true;
			const operation = (async (): Promise<SigningRetirementResult> => {
				await release();
				if (this.#closed) return { ok: false, reason: "STORE_CLOSED" };
				const transaction = this.#database.transaction(stores, "readwrite", { durability: "strict" });
				const completion = terminal(transaction);
				try {
					if (transaction.durability !== "strict") throw new Error("STRICT_DURABILITY_UNAVAILABLE");
					const actual = await image(transaction, objectId, this.#incarnation),
						old = actual.control;
					if (actual.digest !== captured.digest) {
						await completion;
						return { ok: false, reason: "NATIVE_IMAGE_CHANGED" };
					}
					const state = old.drain;
					if (kind === "begin") {
						if (!equal(old, plan.baseControl) || actual.dataDigest !== plan.sourceDataDigest) {
							await completion;
							return { ok: false, reason: "EVIDENCE_SOURCE_CHANGED" };
						}
					} else if (
						state == null ||
						!equal(state.plan, plan) ||
						old.active !== null ||
						!equal(old.completed, plan.baseControl.completed) ||
						old.sequence !== plan.baseControl.sequence ||
						old.revision !== plan.baseControl.revision + 1 + state.batches ||
						actual.dataDigest !== state.remainingDataDigest
					) {
						await completion;
						return { ok: false, reason: "EVIDENCE_SOURCE_CHANGED" };
					}
					if (actual.pendingEpochs.some((epoch) => retired(old.completed, epoch))) {
						await completion;
						return { ok: false, reason: "SIGNING_DISPATCH_DEBT" };
					}
					const cursor = state?.cursor ?? 0,
						batches = state?.batches ?? 0;
					if (kind === "batch" && cursor === plan.entries.length) {
						await completion;
						return Object.freeze({ ok: true, control: old });
					}
					if (old.revision === Number.MAX_SAFE_INTEGER || (kind === "batch" && batches === Number.MAX_SAFE_INTEGER))
						throw new Error("SIGNING_REVISION_EXHAUSTED");
					const summary = isSigningSummaryRetirementPlan(plan);
					const removed = new Set<string>();
					const selectedSummary = isSigningSummaryRetirementPlan(plan) ? plan : undefined;
					if (selectedSummary !== undefined) {
						const epochs = new Set(selectedSummary.entries.map((entry) => entry.key[1]));
						for (const frame of actual.data.frames) {
							if (frame.store === "storageMeta" || !epochs.has(frame.epoch as number)) continue;
							if (
								frame.store === "sealEvidence" ||
								!selectedSummary.entries
									.slice(cursor)
									.some((entry) => entry.store === frame.store &&
										Array.from(encodeCanonical([entry.store, entry.key], imageLimits)).join(",") === frame.addressKey)
							)
								throw new Error("SUMMARY_SOURCE_CHANGED");
						}
					}
					// Every remaining descriptor is mechanically checked before any DELETE;
					// the original private caller must have authenticated eligibility.
					for (const [index, entry] of plan.entries.entries()) {
						const store = "store" in entry ? entry.store : "sealEvidence";
						const row: unknown = await request(transaction.objectStore(store).get([...entry.key]));
						if (index < cursor) {
							if (row !== undefined) throw new Error("EVIDENCE_SOURCE_CHANGED");
							continue;
						}
						if (
							!retired(old.completed, entry.key[1]) ||
							!plainRecord(row) ||
							(!summary && (row.phase !== "finalized" || row.peerEvidence !== undefined)) ||
							(summary && store === "signerState" && (row.highestPrepareQC == null || row.finalizedCommitQC == null)) ||
							row.objectId !== objectId ||
							row.epoch !== entry.key[1] ||
							row.signerId !== entry.key[store === "voteSlots" || store === "voteOutbox" ? 4 : 2] ||
							(!summary && row.storageIncarnation !== this.#incarnation) ||
							("revision" in entry && row.revision !== entry.revision) ||
							signingRetirementFrameDigest(encodeCanonical([store, entry.key, row], imageLimits)) !== entry.frameDigest
						)
							throw new Error("EVIDENCE_SOURCE_CHANGED");
					}
					const nextCursor =
						kind === "begin" ? 0 : Math.min(cursor + SIGNING_DETAIL_RETIREMENT_BATCH_ROWS, plan.entries.length);
					for (let index = cursor; index < nextCursor; index++) {
						const entry = plan.entries[index];
						const store = "store" in entry ? entry.store : "sealEvidence";
						await request(transaction.objectStore(store).delete([...entry.key]));
						removed.add(Array.from(encodeCanonical([store, entry.key], imageLimits)).join(","));
					}
					let removedBytes = 0;
					const excluded = new Set<number>();
					for (const frame of actual.data.frames) {
						if (frame.addressKey !== undefined && removed.has(frame.addressKey)) {
							removedBytes += frame.byteLength;
							excluded.add(frame.index);
						}
					}
					const next = control(
						signingRetirementDrainFields(
							old,
							plan,
							nextCursor,
							kind === "begin" ? 0 : batches + 1,
							actual.data.digest(excluded)
						),
						objectId,
						this.#incarnation
					);
					const row = signingRetirementStorageMetaRow(objectId, next),
						bytes = encodeCanonical(["storageMeta", row.key, row], controlLimits);
					if (actual.logicalBytes - actual.controlBytes - removedBytes + bytes.byteLength > LIMITS.maxUnionBytes)
						throw new Error("SIGNING_IMAGE_BYTES_FULL");
					await request(transaction.objectStore("storageMeta").put(row));
					await completion;
					return Object.freeze({ ok: true, control: next });
				} catch (primary) {
					try {
						transaction.abort();
					} catch {
						/* Already terminal. */
					}
					try {
						await completion;
					} catch {
						/* Preserve the original native failure. */
					}
					throw primary;
				}
			})();
			this.#operations.add(operation);
			void operation.then(
				() => this.#operations.delete(operation),
				() => this.#operations.delete(operation)
			);
			return operation;
		};
		const observation: SigningRetirementObservation = Object.freeze({
			readRetirementDataImage: function () {
				receiver(this);
				if (!live || used || owner.#closed) throw new Error("READ_RELEASED");
				return captured.data;
			},
			readExactCanonicalRows: function () {
				receiver(this);
				if (!live || used || owner.#closed) throw new Error("READ_RELEASED");
				return captured.frames;
			},
			control: captured.control,
			imageDigest: captured.digest,
			logicalBytes: captured.logicalBytes,
			check: async function () {
				receiver(this);
				if (!live || used) throw new Error("READ_RELEASED");
				await held.check();
			},
			checkSigningScope: async function (
				this: SigningRetirementObservation,
				input: Readonly<{ epoch: number; round: number; signerId: string }>
			): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>> {
				receiver(this);
				if (!live || used) return Object.freeze({ ok: false as const, reason: "READ_RELEASED" });
				return owner.#checkSigningScope(held, objectId, input);
			},
			release: function () {
				receiver(this);
				return release();
			},
			prepareFence: function (value: SigningRetirementPreparation) {
				receiver(this);
				return transition("prepare", value);
			},
			abortPrepared: function () {
				receiver(this);
				return transition("abort");
			},
			commitPrepared: function () {
				receiver(this);
				return transition("commit");
			},
			beginEvidenceDrain: function (value: SigningEvidenceRetirementPlan) {
				receiver(this);
				return drainTransition("begin", value);
			},
			beginSummaryDrain: function (value: SigningSummaryRetirementPlan) {
				receiver(this);
				return drainTransition("begin", value);
			},
			drainEvidenceBatch: function () {
				receiver(this);
				return drainTransition("batch");
			},
		});
		return observation;
	}

	/**
	 * Makes the connection close-pending and revokes signing admissions, but
	 * retains their physical RO until the crypto owner joins and releases them.
	 * Ordinary admitted mutation promises remain caller-owned.
	 * @returns Joined original owner cleanup.
	 */
	close(): Promise<void> {
		this.#closed = true;
		// Close-pending rejects new original transactions synchronously while
		// already admitted IDB work retains its own native completion/cause.
		this.#database.close();
		return (this.#closing ??= (async (): Promise<void> => {
			const signing = await Promise.allSettled([...this.#signingHolds]);
			const outcomes = [...signing, ...(await Promise.allSettled([this.#reads.close(), ...this.#operations]))];
			const causes = outcomes.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
			if (causes.length === 1) throw causes[0];
			if (causes.length > 1) throw new AggregateError(causes, "signing owner close failed", { cause: causes[0] });
		})());
	}
}
