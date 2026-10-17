import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	createSigningStorageCodec,
	isSigningSummaryRetirementPlan,
	SIGNING_DETAIL_RETIREMENT_BATCH_ROWS,
	type SigningDependencyObservation,
	type SigningEvidenceRetirementPlan,
	type SigningNativeRead,
	type SigningRetirementControl,
	signingRetirementDataDigest,
	signingRetirementDrainFields,
	signingRetirementFrameDigest,
	signingRetirementMetadataFields,
	type SigningRetirementObservation,
	type SigningRetirementPreparation,
	type SigningRetirementResult,
	signingRetirementStorageMetaRow,
	type SigningSummaryRetirementPlan,
} from "@ts-drp/seal/internal/storage-port";
import { AHE_BOUNDED_READ_LIMITS as LIMITS, type NativeReadReservation } from "@ts-drp/storage";

import type { SigningTable, SqliteSigningDatabase } from "./signing-database.js";

const codec = createSigningStorageCodec(LIMITS);
const imageLimits = { maxBytes: LIMITS.maxUnionBytes, maxDepth: 128, maxItems: 65_536 };
const tables: readonly SigningTable[] = ["signerState", "sealEvidence", "voteSlots", "voteOutbox"];
export interface SqliteSigningImage {
	readonly frames: readonly Uint8Array[];
	readonly control: SigningRetirementControl;
	readonly digest: string;
	readonly dataDigest: string;
	readonly logicalBytes: number;
	readonly controlBytes: number;
	readonly pendingEpochs: readonly number[];
}

/**
 * Same control law as the browser owner, under an actual SQLite transaction.
 * @param database
 * @param objectId
 */
import type { LocalSessionLifetime } from "./local-session-lifetime.js";

export function readSqliteSigningControl(database: SqliteSigningDatabase, objectId: string): SigningRetirementControl {
	database.assertCurrency();
	const key = codec.keyFor(objectId),
		value = database.getMeta(key);
	if (value === undefined) return codec.idle(objectId, database.incarnation);
	const row = codec.record(value, ["key", "value"]);
	if (row.key !== key) throw new Error("INVALID_SIGNING_CONTROL");
	return codec.control(row.value, objectId, database.incarnation);
}

/**
 * Epoch/round fences are native mechanics, not authenticated source eligibility.
 * @param database
 * @param objectId
 * @param epoch
 */
export function sqliteSigningMutationRefusal(
	database: SqliteSigningDatabase,
	objectId: string,
	epoch: number
): string | undefined {
	const current = readSqliteSigningControl(database, objectId);
	if (
		codec.summaryMaintenancePending(current) ||
		(current.drain != null && current.drain.cursor < current.drain.plan.entries.length)
	)
		return "SIGNING_MAINTENANCE_DEBT";
	if (codec.retired(current.completed, epoch)) return "SIGNING_RETIRED";
	if (codec.retired(current.active?.preparation ?? null, epoch)) return "RETIREMENT_FENCED";
	return undefined;
}

/**
 *
 * @param database
 * @param scope
 */
export function readSqliteSigningFrontier(
	database: SqliteSigningDatabase,
	scope: Readonly<{ objectId: string; epoch: number; signerId: string }>
): number {
	database.assertCurrency();
	const state = database.get("signerState", [scope.objectId, scope.epoch, scope.signerId]);
	if (state === undefined) return 0;
	if (
		!codec.plainRecord(state) ||
		state.objectId !== scope.objectId ||
		state.epoch !== scope.epoch ||
		state.signerId !== scope.signerId ||
		!codec.safe(state.enteredRound) ||
		!codec.safe(state.revision)
	)
		throw new Error("INVALID_SIGNING_FRONTIER");
	const floor = state.retiredBeforeRound === undefined ? 0 : state.retiredBeforeRound;
	if (!codec.safe(floor) || floor > state.enteredRound) throw new Error("INVALID_SIGNING_FRONTIER");
	return floor;
}

/**
 * Exact original frame order and whole-image charge, not a second signing entitlement.
 * @param database
 * @param objectId
 * @param allowAbsent
 */
export function readSqliteSigningImage(
	database: SqliteSigningDatabase,
	objectId: string,
	allowAbsent = false
): SqliteSigningImage {
	const control = readSqliteSigningControl(database, objectId);
	database.assertImagePayloadBound(objectId);
	const frames: Uint8Array[] = [],
		pendingEpochs: number[] = [];
	let logicalBytes = 0,
		controlBytes = 0,
		count = 0,
		present = false;
	const add = (table: string, key: unknown, value: unknown): void => {
		if (++count > 65_536) throw new Error("SIGNING_IMAGE_COUNT_FULL");
		const bytes = encodeCanonical([table, key, value], {
			...imageLimits,
			maxBytes: LIMITS.maxUnionBytes - logicalBytes,
		});
		logicalBytes += bytes.byteLength;
		frames.push(bytes);
		if (table === "storageMeta" && key === codec.keyFor(objectId)) controlBytes = bytes.byteLength;
	};
	for (const key of ["incarnation", `ahe-retirement:${objectId}`, codec.keyFor(objectId)])
		add("storageMeta", key, database.getMeta(key) ?? null);
	for (const table of tables)
		for (const { key, value } of database.rows(table, objectId)) {
			if (
				!codec.plainRecord(value) ||
				value.objectId !== objectId ||
				value.epoch !== key[1] ||
				value.signerId !== key[key.length - 1]
			)
				throw new Error("INVALID_SIGNING_ADDRESS");
			const short = table === "signerState" || table === "sealEvidence";
			if (
				table === "signerState" &&
				(!codec.safe(value.revision) ||
					!codec.safe(value.enteredRound) ||
					(value.retiredBeforeRound !== undefined &&
						(!codec.safe(value.retiredBeforeRound) || value.retiredBeforeRound > value.enteredRound)))
			)
				throw new Error("INVALID_SIGNING_FRONTIER");
			if (!short && (value.round !== key[2] || value.phase !== key[3])) throw new Error("INVALID_SIGNING_ADDRESS");
			add(table, key, value);
			present = true;
			if (table === "voteOutbox" && value.dispatched !== true) pendingEpochs.push(key[1]);
		}
	if (!present && !allowAbsent) throw new Error("SIGNING_ADDRESS_ABSENT");
	return Object.freeze({
		control,
		frames: Object.freeze(frames),
		logicalBytes,
		controlBytes,
		pendingEpochs: Object.freeze(pendingEpochs),
		digest: Buffer.from(hashDomain("ts-drp/signing-native-image/v1", ...frames)).toString("hex"),
		dataDigest: signingRetirementDataDigest(frames, objectId),
	});
}

/** Owns native custody and joined signing lifetimes, never protocol authentication. */
export class SqliteSigningRetirementOwner {
	readonly #database: SqliteSigningDatabase;
	readonly #operations = new Set<Promise<unknown>>();
	readonly #signingHolds = new Set<Promise<void>>();
	readonly #imageHolds = new Set<NativeReadReservation>();
	readonly #sessionHolds = new Set<Promise<void>>();
	readonly #closeDatabase: () => Promise<void>;
	#holding = false;
	#closed = false;
	#closing?: Promise<void>;
	/**
	 *
	 * @param database
	 */
	constructor(database: SqliteSigningDatabase, closeDatabase: () => Promise<void> = () => database.close(), readonly session?: LocalSessionLifetime) {
		this.#database = database;
		this.#closeDatabase = closeDatabase;
	}

	async #takeNativeRead(): Promise<NativeReadReservation> {
		this.session?.assertCurrent();
		if (this.#closed) throw new Error("STORE_CLOSED");
		if (this.#holding) throw new Error("NATIVE_READ_RESERVATION_BUSY");
		const joined = this.session?.enter();
		let releaseHandle: (() => void) | undefined;
		try { releaseHandle = this.session?.reserveNativeHandle(); }
		catch (primary) { joined?.(); throw primary; }
		this.#holding = true;
		let held: NativeReadReservation;
		try {
			held = await this.#database.acquireNativeRead(this.session);
		} catch (cause) {
			this.#holding = false;
			try { releaseHandle?.(); joined?.(); }
			catch (cleanup) { throw new AggregateError([cause, cleanup], "native signing open and handle release failed", { cause }); }
			throw cause;
		}
		let releaseTask: Promise<void> | undefined;
		let resolveNative!: () => void, rejectNative!: (cause: unknown) => void;
		const nativeJoined = new Promise<void>((resolve, reject) => { resolveNative = resolve; rejectNative = reject; });
		void nativeJoined.catch(() => undefined);
		if (this.session) this.#sessionHolds.add(nativeJoined);
		const view = Object.freeze({
			check: async (): Promise<void> => { this.session?.assertCurrent(); await held.check(); this.session?.assertCurrent(); },
			release: () =>
				(releaseTask ??= held.release().then(() => {
					try { releaseHandle?.(); }
					catch (cause) { this.session?.fail(cause); rejectNative(cause); throw cause; }
					this.#holding = false;
					joined?.();
					this.#sessionHolds.delete(nativeJoined); resolveNative();
				}, (cause: unknown) => {
					this.session?.fail(cause); rejectNative(cause); throw cause;
				})),
		});
		try {
			this.session?.assertCurrent();
			if (this.#closed) throw new Error("STORE_CLOSED");
			return view;
		} catch (primary) {
			try { await view.release(); }
			catch (cleanup) { throw new AggregateError([primary, cleanup], "native signing read delivery and cleanup failed", { cause: primary }); }
			throw primary;
		}
	}

	#object(input: Readonly<{ objectId: string }>): string {
		this.session?.assertCurrent();
		const copied = codec.record(input, ["objectId"]);
		if (typeof copied.objectId !== "string" || !copied.objectId || copied.objectId.includes("\0"))
			throw new TypeError("INVALID_SIGNING_ADDRESS");
		encodeCanonical(copied.objectId, codec.controlLimits);
		if (this.#closed) throw new Error("STORE_CLOSED");
		return copied.objectId;
	}
	#track<T>(operation: Promise<T>): Promise<T> {
		this.#operations.add(operation);
		void operation.then(
			() => this.#operations.delete(operation),
			() => this.#operations.delete(operation)
		);
		return operation;
	}
	async #scope(
		held: NativeReadReservation,
		objectId: string,
		input: Readonly<{ epoch: number; round: number; signerId: string }>
	): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>> {
		const scope = codec.record(input, ["epoch", "round", "signerId"]);
		if (
			!codec.safe(scope.epoch) ||
			!codec.safe(scope.round) ||
			typeof scope.signerId !== "string" ||
			!scope.signerId ||
			scope.signerId.includes("\0")
		)
			throw new TypeError("INVALID_SIGNING_SCOPE");
		encodeCanonical(scope, codec.controlLimits);
		await held.check();
		this.session?.assertCurrent();
		const result = this.#database.transact(false, () => {
			const refusal = sqliteSigningMutationRefusal(this.#database, objectId, scope.epoch as number);
			if (refusal !== undefined) return { ok: false as const, reason: refusal };
			const floor = readSqliteSigningFrontier(this.#database, {
				objectId,
				epoch: scope.epoch as number,
				signerId: scope.signerId as string,
			});
			return (scope.round as number) < floor
				? { ok: false as const, reason: "SIGNING_RETIRED" }
				: { ok: true as const };
		});
		await held.check();
		this.session?.assertCurrent();
		if (this.#closed) return { ok: false, reason: "READ_RELEASED" };
		return Object.freeze(result);
	}

	/**
	 *
	 * @param input
	 */
	async acquireSigningAdmission(input: Readonly<{ objectId: string }>): Promise<SigningNativeRead> {
		const objectId = this.#object(input),
			held = await this.#takeNativeRead();
		try {
			this.#database.transact(false, () => readSqliteSigningImage(this.#database, objectId, true));
			await held.check();
			this.session?.assertCurrent();
			if (this.#closed) throw new Error("STORE_CLOSED");
		} catch (primary) {
			try {
				await held.release();
			} catch (cleanup) {
				throw new AggregateError([primary, cleanup], "signing admission acquisition failed", { cause: primary });
			}
			throw primary;
		}
		let released = false,
			resolveJoin!: () => void,
			rejectJoin!: (cause: unknown) => void,
			releaseTask: Promise<void> | undefined;
		const joined = new Promise<void>((resolve, reject) => {
			resolveJoin = resolve;
			rejectJoin = reject;
		});
		void joined.catch(() => undefined);
		this.#signingHolds.add(joined);
		// The public receiver is the capability; callbacks retain the original native owner.
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const owner = this;
		const admission: SigningNativeRead = Object.freeze({
			incarnation: this.#database.incarnation,
			checkSigningIdentity: async function (input: Readonly<{ publicKey: Uint8Array }>): Promise<void> {
				if (this !== admission) throw new TypeError("FOREIGN_SIGNING_ADMISSION");
				if (released || owner.#closed) throw new Error("READ_RELEASED");
				owner.session?.assertOwnedPublicKey(input.publicKey);
				await held.check(); owner.session?.assertCurrent();
			},
			check: async function () {
				if (this !== admission) throw new TypeError("FOREIGN_SIGNING_ADMISSION");
				if (released || owner.#closed) throw new Error("READ_RELEASED");
				await held.check();
				owner.session?.assertCurrent();
				if (owner.#closed) throw new Error("READ_RELEASED");
			},
			checkSigningScope: async function (scope: Readonly<{ epoch: number; round: number; signerId: string }>) {
				if (this !== admission) throw new TypeError("FOREIGN_SIGNING_ADMISSION");
				if (released || owner.#closed) return { ok: false as const, reason: "READ_RELEASED" };
				return owner.#scope(held, objectId, scope);
			},
			release: function () {
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
	/**
	 *
	 * @param input
	 */
	acquire(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation> {
		return this.#acquire(input, false);
	}
	/**
	 *
	 * @param input
	 */
	acquireRecovery(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation> {
		return this.#acquire(input, true);
	}
	/**
	 *
	 * @param input
	 */
	async acquireDependency(input: Readonly<{ objectId: string }>): Promise<SigningDependencyObservation> {
		const observation = await this.#acquire(input, true);
		try { this.session?.assertCurrent(); }
		catch (primary) {
			try { await observation.release(); }
			catch (cleanup) { throw new AggregateError([primary, cleanup], "signing dependency delivery and cleanup failed", { cause: primary }); }
			throw primary;
		}
		const read: SigningDependencyObservation = Object.freeze({
			control: observation.control,
			imageDigest: observation.imageDigest,
			logicalBytes: observation.logicalBytes,
			readExactCanonicalRows: function () {
				if (this !== read) throw new TypeError("FOREIGN_SIGNING_OBSERVATION");
				return observation.readExactCanonicalRows();
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
	async #acquire(input: Readonly<{ objectId: string }>, allowAbsent: boolean): Promise<SigningRetirementObservation> {
		const objectId = this.#object(input),
			held = await this.#takeNativeRead();
		let captured: SqliteSigningImage;
		try {
			captured = this.#database.transact(false, () => readSqliteSigningImage(this.#database, objectId, allowAbsent));
			await held.check();
			this.session?.assertCurrent();
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
			used = false,
			released: Promise<void> | undefined;
		// The public receiver is the capability; callbacks retain the original native owner.
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const owner = this;
		const release = (): Promise<void> => {
			live = false;
			return (released ??= held.release().finally(() => this.#imageHolds.delete(held)));
		};
		this.#imageHolds.add(held);
		const receiver = (self: unknown): void => {
			if (self !== observation) throw new TypeError("FOREIGN_SIGNING_OBSERVATION");
		};
		const transition = (
			kind: "prepare" | "abort" | "commit",
			value?: SigningRetirementPreparation
		): Promise<SigningRetirementResult> => {
			this.session?.assertCurrent();
			if (!live || used || this.#closed) return Promise.resolve({ ok: false, reason: "READ_RELEASED" });
			if ((kind === "prepare") === (captured.control.active !== null))
				return Promise.resolve({ ok: false, reason: "ILLEGAL_TRANSITION" });
			const drain = captured.control.drain;
			if (
				kind === "prepare" &&
				(codec.summaryMaintenancePending(captured.control) ||
					(drain != null && drain.cursor < drain.plan.entries.length))
			)
				return Promise.resolve({ ok: false, reason: "SIGNING_MAINTENANCE_DEBT" });
			let proposed: SigningRetirementPreparation | undefined;
			if (kind === "prepare") {
				try {
					proposed = codec.preparation(value, objectId);
				} catch {
					return Promise.resolve({ ok: false, reason: "MALFORMED_INPUT" });
				}
				if (!codec.monotone(captured.control.completed, proposed))
					return Promise.resolve({ ok: false, reason: "INVALID_RETIREMENT_FRONTIER" });
			}
			used = true;
			return this.#track(
				(async (): Promise<SigningRetirementResult> => {
					await release();
					this.session?.assertCurrent();
					if (this.#closed) return { ok: false as const, reason: "STORE_CLOSED" };
					return this.#database.transact(true, () => {
						const actual = readSqliteSigningImage(this.#database, objectId, allowAbsent),
							old = actual.control;
						if (actual.digest !== captured.digest) return { ok: false as const, reason: "NATIVE_IMAGE_CHANGED" };
						if (
							old.revision === Number.MAX_SAFE_INTEGER ||
							(kind === "prepare" && old.sequence === Number.MAX_SAFE_INTEGER)
						)
							throw new Error("SIGNING_REVISION_EXHAUSTED");
						if (kind === "prepare" && actual.pendingEpochs.some((epoch) => codec.retired(proposed ?? null, epoch)))
							return { ok: false as const, reason: "SIGNING_DISPATCH_DEBT" };
						const next = codec.control(
							signingRetirementMetadataFields(old, kind, proposed, actual.digest),
							objectId,
							this.#database.incarnation
						);
						this.#writeControl(actual, next, objectId);
						return Object.freeze({ ok: true as const, control: next });
					});
				})()
			);
		};
		const drainTransition = (
			kind: "begin" | "batch",
			value?: SigningEvidenceRetirementPlan | SigningSummaryRetirementPlan
		): Promise<SigningRetirementResult> => {
			this.session?.assertCurrent();
			if (!live || used || this.#closed) return Promise.resolve({ ok: false, reason: "READ_RELEASED" });
			let plan: SigningEvidenceRetirementPlan | SigningSummaryRetirementPlan;
			try {
				plan = codec.retirementDrainPlan(
					kind === "begin" ? value : captured.control.drain?.plan,
					objectId,
					this.#database.incarnation
				);
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
			return this.#track(
				(async (): Promise<SigningRetirementResult> => {
					await release();
					if (this.#closed) return { ok: false as const, reason: "STORE_CLOSED" };
					this.session?.assertCurrent();
					return this.#database.transact(true, () => this.#drain(objectId, captured, kind, plan));
				})()
			);
		};
		const observation: SigningRetirementObservation = Object.freeze({
			control: captured.control,
			imageDigest: captured.digest,
			logicalBytes: captured.logicalBytes,
			readExactCanonicalRows: function () {
				receiver(this);
				owner.session?.assertCurrent();
				if (!live || used || owner.#closed) throw new Error("READ_RELEASED");
				return Object.freeze(captured.frames.map((bytes) => Uint8Array.from(bytes)));
			},
			check: async function () {
				receiver(this);
				if (!live || used || owner.#closed) throw new Error("READ_RELEASED");
				await held.check();
				owner.session?.assertCurrent();
				if (owner.#closed) throw new Error("READ_RELEASED");
			},
			checkSigningScope: async function (scope: Readonly<{ epoch: number; round: number; signerId: string }>) {
				receiver(this);
				if (!live || used || owner.#closed) return { ok: false as const, reason: "READ_RELEASED" };
				return owner.#scope(held, objectId, scope);
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
	#writeControl(actual: SqliteSigningImage, next: SigningRetirementControl, objectId: string, removedBytes = 0): void {
		const row = signingRetirementStorageMetaRow(objectId, next),
			bytes = encodeCanonical(["storageMeta", row.key, row], codec.controlLimits);
		if (actual.logicalBytes - actual.controlBytes - removedBytes + bytes.byteLength > LIMITS.maxUnionBytes)
			throw new Error("SIGNING_IMAGE_BYTES_FULL");
		this.#database.putMeta(row.key, row);
	}
	#drain(
		objectId: string,
		captured: SqliteSigningImage,
		kind: "begin" | "batch",
		plan: SigningEvidenceRetirementPlan | SigningSummaryRetirementPlan
	): SigningRetirementResult {
		const actual = readSqliteSigningImage(this.#database, objectId),
			old = actual.control,
			state = old.drain;
		if (actual.digest !== captured.digest) return { ok: false, reason: "NATIVE_IMAGE_CHANGED" };
		if (kind === "begin") {
			if (!codec.equal(old, plan.baseControl) || actual.dataDigest !== plan.sourceDataDigest)
				return { ok: false, reason: "EVIDENCE_SOURCE_CHANGED" };
		} else if (
			state == null ||
			!codec.equal(state.plan, plan) ||
			old.active !== null ||
			!codec.equal(old.completed, plan.baseControl.completed) ||
			old.sequence !== plan.baseControl.sequence ||
			old.revision !== plan.baseControl.revision + 1 + state.batches ||
			actual.dataDigest !== state.remainingDataDigest
		)
			return { ok: false, reason: "EVIDENCE_SOURCE_CHANGED" };
		if (actual.pendingEpochs.some((epoch) => codec.retired(old.completed, epoch)))
			return { ok: false, reason: "SIGNING_DISPATCH_DEBT" };
		const cursor = state?.cursor ?? 0,
			batches = state?.batches ?? 0;
		if (kind === "batch" && cursor === plan.entries.length) return Object.freeze({ ok: true, control: old });
		if (old.revision === Number.MAX_SAFE_INTEGER || (kind === "batch" && batches === Number.MAX_SAFE_INTEGER))
			throw new Error("SIGNING_REVISION_EXHAUSTED");
		const summary = isSigningSummaryRetirementPlan(plan);
		if (summary) {
			const epochs = new Set(plan.entries.map((entry) => entry.key[1]));
			for (const bytes of actual.frames) {
				const frame = decodeCanonical(bytes, imageLimits) as unknown[];
				if (frame[0] === "storageMeta" || !epochs.has((frame[1] as unknown[])[1] as number)) continue;
				if (
					frame[0] === "sealEvidence" ||
					!plan.entries.slice(cursor).some((entry) => entry.store === frame[0] && codec.equal(entry.key, frame[1]))
				)
					throw new Error("SUMMARY_SOURCE_CHANGED");
			}
		}
		for (const [index, entry] of plan.entries.entries()) {
			const table = "store" in entry ? entry.store : "sealEvidence",
				row = this.#database.get(table, entry.key);
			if (index < cursor) {
				if (row !== undefined) throw new Error("EVIDENCE_SOURCE_CHANGED");
				continue;
			}
			if (
				!codec.retired(old.completed, entry.key[1]) ||
				!codec.plainRecord(row) ||
				(!summary && (row.phase !== "finalized" || row.peerEvidence !== undefined)) ||
				(summary && table === "signerState" && (row.highestPrepareQC == null || row.finalizedCommitQC == null)) ||
				row.objectId !== objectId ||
				row.epoch !== entry.key[1] ||
				row.signerId !== entry.key[table === "voteSlots" || table === "voteOutbox" ? 4 : 2] ||
				(!summary && row.storageIncarnation !== this.#database.incarnation) ||
				("revision" in entry && row.revision !== entry.revision) ||
				signingRetirementFrameDigest(encodeCanonical([table, entry.key, row], imageLimits)) !== entry.frameDigest
			)
				throw new Error("EVIDENCE_SOURCE_CHANGED");
		}
		const nextCursor =
				kind === "begin" ? 0 : Math.min(cursor + SIGNING_DETAIL_RETIREMENT_BATCH_ROWS, plan.entries.length),
			removed = new Set<string>();
		for (let index = cursor; index < nextCursor; index++) {
			const entry = plan.entries[index],
				table = "store" in entry ? entry.store : "sealEvidence";
			if (!this.#database.delete(table, entry.key)) throw new Error("EVIDENCE_SOURCE_CHANGED");
			removed.add(Buffer.from(encodeCanonical([table, entry.key], imageLimits)).toString("hex"));
		}
		let removedBytes = 0;
		const remaining = actual.frames.filter((bytes) => {
			const frame = decodeCanonical(bytes, imageLimits) as unknown[];
			const keep = !removed.has(Buffer.from(encodeCanonical([frame[0], frame[1]], imageLimits)).toString("hex"));
			if (!keep) removedBytes += bytes.byteLength;
			return keep;
		});
		const next = codec.control(
			signingRetirementDrainFields(
				old,
				plan,
				nextCursor,
				kind === "begin" ? 0 : batches + 1,
				signingRetirementDataDigest(remaining, objectId)
			),
			objectId,
			this.#database.incarnation
		);
		this.#writeControl(actual, next, objectId, removedBytes);
		return Object.freeze({ ok: true, control: next });
	}
	/** New admissions revoke immediately; physical custody waits for admitted crypto release. */
	close(): Promise<void> {
		this.#closed = true;
		return (this.#closing ??= (async (): Promise<void> => {
			const signing = await Promise.allSettled([...this.#signingHolds]);
			const outcomes = [
				...signing,
				...(await Promise.allSettled([...this.#operations, ...(this.session ? this.#sessionHolds : [...this.#imageHolds].map((held) => held.release()))])),
			];
			outcomes.push(...(await Promise.allSettled([this.#closeDatabase()])));
			const causes = outcomes.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
			if (causes.length === 1) throw causes[0];
			if (causes.length > 1) throw new AggregateError(causes, "signing owner close failed", { cause: causes[0] });
		})());
	}
}
