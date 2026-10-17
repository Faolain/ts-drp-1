import { encodeCanonical } from "@ts-drp/canonical";
import {
	type ActiveGenerationSnapshot,
	type AheBoundedReadAcquisition,
	type AheBoundedReadInput,
	type AheBoundedRecoveryRoleRead,
	type AheBoundedRecoveryRoleReadInput,
	type AheBoundedRecoveryRoleStore,
	type AheRetirementAdmissionImage,
	type AheRetirementControl,
	type AheRetirementControlRead,
	aheRetirementGenerationBindingMatches,
	aheRetirementNativeCommands,
	type AheRetirementNativeMutation,
	aheRetirementReclamationMatches,
	type BlobDigest,
	createAheRetirementControlRead,
	decodeAheRetirementControl,
	decodeGenerationRecordV1,
	decodeHeadRecordV1,
	encodeAheRetirementControl,
	type ExpectedHead,
	type GenerationId,
	type GenerationPage,
	type GenerationPageCursor,
	type GenerationRecord,
	type GenerationRef,
	parseGenerationId,
	type PresentHead,
	type StorageObjectId,
	type StoreCapabilities,
	type StoreResult,
} from "@ts-drp/storage";
import {
	boundedActiveReadSteps,
	boundedHeadSteps,
	BoundedReadBudgetError,
	type BoundedReadRequest,
	boundedRecoveryRoleReadSteps,
	classifyPersistedState,
	createBoundedReadAcquisition,
	createBoundedRecoveryRoleRead,
	evaluateStorageAdapterCommand,
	isBoundedReadCorruption,
	PersistedStorageError,
	prepareBoundedRead,
	prepareBoundedRecoveryRoleRead,
	type PreparedStorageAdapterCommand,
	prepareStorageAdapterCommand,
	storageAdapterClosureVerifier,
	type StorageAdapterCommand,
	type StorageAdapterEvaluation,
	type StorageAdapterFact,
	type StorageAdapterWrite,
} from "@ts-drp/storage/adapter";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { SqliteAheDurableStoreOptions, NodeNativeReadPort } from "../index.js";
import { applyNodeBoundedAheReclamation, registerNodeAheReclamationMaintenance } from "./ahe-reclamation.js";
import { loadNodeBoundedReadRequest } from "./bounded-read.js";
import { captureSqliteReadReservationObject, SqliteNativeReadReservationOwner } from "./native-read-reservation.js";
import {
	admitNodeRetirementControl,
	advanceNodeRetirementControl,
	readNodeRetirementControl,
} from "./retirement-control.js";
import { hasExpectedPhysicalSchema, SCHEMA } from "./schema-sqlite.js";
import { sqliteFilename } from "./sqlite-filename.js";
import type { LocalSessionLifetime } from "./local-session-lifetime.js";
import { enforceNativeLocalSessionFile, nativeLocalSessionSchemaExtraRows } from "./local-session-lifetime.js";

export type SqliteMutationOperation = Exclude<
	StorageAdapterCommand["kind"],
	"getBlob" | "readGenerationPage" | "readHead"
>;

export type SqliteMutationFault = (
	checkpoint: Readonly<{ readonly edge: "before-commit"; readonly operation: "beginGeneration" }>
) => void;

export type SqliteMutationStatement =
	| "blob-insert"
	| "generation-insert"
	| "generation-update"
	| "head-upsert"
	| "object-ensure"
	| "promotion-insert";

export type SqliteCrashCheckpoint =
	| Readonly<{
			edge: "after-statement";
			occurrence: number;
			operation: SqliteMutationOperation;
			statement: SqliteMutationStatement;
	  }>
	| Readonly<{ edge: "after-commit" | "before-commit"; operation: SqliteMutationOperation }>;

export type SqliteCrashCheckpointObserver = (checkpoint: SqliteCrashCheckpoint) => void;

export type SqlitePragma = "foreign_keys" | "integrity_check" | "journal_mode" | "synchronous";

export type SqliteScaffoldInstrumentation = Readonly<{
	attemptInvalidForeignKeyInsert(): void;
	readPragma(pragma: SqlitePragma): unknown;
	store: AheBoundedRecoveryRoleStore & NodeNativeReadPort;
}>;

const STRICT_CAPABILITIES: Readonly<StoreCapabilities> = Object.freeze({
	durability: "strict",
	signingEligibility: "backend-capability-required",
});

type DatabaseRow = Record<string, unknown>;

type HeldAheRetirementAdmissionImage = Readonly<{lease: NonNullable<ReturnType<SqliteNativeReadReservationOwner["current"]>>;
	objectId: StorageObjectId; controlBytes: Uint8Array | null; head: ExpectedHead; imageDigest: string; metadataBytes: number}>;

class SqliteAheDurableStore implements AheBoundedRecoveryRoleStore {
	public readonly capabilities = STRICT_CAPABILITIES;
	private locallyClosed = false;
	private get closed(): boolean {
		if (this.locallyClosed) return true;
		this.session?.assertCurrent();
		return false;
	}
	private poisoned = false;
	private boundedReads = 0;
	private boundedClose: Promise<void> | undefined;
	private resolveBoundedClose: (() => void) | undefined;
	private readonly recoveryCertificates = new Map<StorageObjectId, string>();
	private readonly readReservations: SqliteNativeReadReservationOwner;
	#heldRetirementImage?: HeldAheRetirementAdmissionImage;

	public constructor(
		private readonly connection: DatabaseSync,
		filename: string,
		private readonly fault?: SqliteMutationFault,
		private readonly crashObserver?: SqliteCrashCheckpointObserver,
		private readonly session?: LocalSessionLifetime
	) {
		this.readReservations = new SqliteNativeReadReservationOwner(filename, session);
		registerNodeAheReclamationMaintenance(this, connection, {
			isClosed: () => this.closed,
			isPoisoned: () => this.poisoned,
			latchPoison: () => {
				this.poisoned = true;
				this.recoveryCertificates.clear();
			},
		});
	}

	public async acquireNativeReadReservation(
		input: Readonly<{ objectId: string }>
	): ReturnType<SqliteNativeReadReservationOwner["acquire"]> {
		const objectId = captureSqliteReadReservationObject(input);
		const prepared = prepareStorageAdapterCommand({ kind: "readHead", objectId });
		if (!prepared.ok) throw new TypeError("INVALID_ARGUMENT");
		if (this.closed) throw new Error("STORE_CLOSED");
		if (this.poisoned) throw new Error("STORE_POISONED");
		this.#heldRetirementImage = undefined;
		const original = await this.readReservations.acquire();
		return Object.freeze({check: () => original.check(), release: () => {
			this.#heldRetirementImage = undefined;
			return original.release();
		}});
	}

	private detachedHeldRetirementImage(image: HeldAheRetirementAdmissionImage): StoreResult<AheRetirementAdmissionImage> {
		const control = image.controlBytes === null ? null : decodeAheRetirementControl(image.controlBytes);
		if (control !== null && !control.ok) return control;
		return {ok: true, value: Object.freeze({control: control?.value ?? null,
			head: Object.freeze({...image.head}), imageDigest: image.imageDigest, metadataBytes: image.metadataBytes})};
	}

	public readHead(objectId: StorageObjectId): Promise<StoreResult<ExpectedHead>> {
		return this.run(commandWithKind("readHead", { objectId })) as Promise<StoreResult<ExpectedHead>>;
	}

	public readRetirementControl(objectId: StorageObjectId): Promise<StoreResult<AheRetirementControl | null>> {
		const input = prepareStorageAdapterCommand({ kind: "readHead", objectId });
		if (!input.ok) return Promise.resolve(input);
		if (this.closed) return Promise.resolve({ ok: false, reason: "STORE_CLOSED" });
		if (this.poisoned) return Promise.resolve({ ok: false, reason: "STORE_POISONED" });
		let active = false;
		try {
			this.connection.exec("BEGIN");
			active = true;
			const value = this.readControl(objectId);
			this.connection.exec("COMMIT");
			active = false;
			return Promise.resolve({ ok: true, value });
		} catch (cause) {
			if (active)
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					/* preserve failure */
				}
			return Promise.resolve({ ok: false, reason: "SUBSTRATE_FAILURE", cause });
		}
	}

	public readRetirementImage(
		objectId: StorageObjectId
	): Promise<StoreResult<Pick<AheRetirementControlRead, "control" | "head" | "imageDigest" | "metadataBytes">>> {
		return this.readRetirementImagePoint(objectId, false);
	}

	public readRetirementAdmissionImage(objectId: StorageObjectId): Promise<StoreResult<AheRetirementAdmissionImage>> {
		return this.readRetirementImagePoint(objectId, true);
	}

	private readRetirementImagePoint(
		objectId: StorageObjectId,
		allowAbsent: false
	): Promise<StoreResult<Pick<AheRetirementControlRead, "control" | "head" | "imageDigest" | "metadataBytes">>>;
	private readRetirementImagePoint(
		objectId: StorageObjectId,
		allowAbsent: true
	): Promise<StoreResult<AheRetirementAdmissionImage>>;
	private async readRetirementImagePoint(
		objectId: StorageObjectId,
		allowAbsent: boolean
	): Promise<StoreResult<AheRetirementAdmissionImage>> {
		const input = prepareStorageAdapterCommand({ kind: "readHead", objectId });
		if (!input.ok) return Promise.resolve(input);
		if (this.closed) return Promise.resolve({ ok: false, reason: "STORE_CLOSED" });
		if (this.poisoned) return Promise.resolve({ ok: false, reason: "STORE_POISONED" });
		let active = false;
		try {
			const lease = this.readReservations.current();
			if (lease !== undefined) {
				await lease.check();
				if (this.readReservations.current() !== lease) throw new Error("NATIVE_READ_RESERVATION_LOST");
				const prior = this.#heldRetirementImage;
				if (prior?.lease === lease && prior.objectId === objectId) {
					await lease.check();
					if (this.closed) return {ok: false, reason: "STORE_CLOSED"};
					if (this.poisoned) return {ok: false, reason: "STORE_POISONED"};
					if (this.readReservations.current() !== lease) throw new Error("NATIVE_READ_RESERVATION_LOST");
					if (!allowAbsent && prior.controlBytes === null) return {ok: false, reason: "INVALID_ARGUMENT"};
					return this.detachedHeldRetirementImage(prior);
				}
			} else this.#heldRetirementImage = undefined;
			this.connection.exec("BEGIN");
			active = true;
			const control = this.readControl(objectId);
			if (control === null && !allowAbsent) {
				this.connection.exec("COMMIT");
				active = false;
				return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
			}
			const bytes = control === null ? null : encodeAheRetirementControl(control),
				head = this.readHeadWithinTransaction(objectId),
				image = admitNodeRetirementControl(this.connection, objectId, bytes);
			this.connection.exec("COMMIT");
			active = false;
			if (!head.ok) return Promise.resolve(head);
			if (!image.ok) return Promise.resolve(image);
			if (lease !== undefined) {
				await lease.check();
				if (this.closed) return {ok: false, reason: "STORE_CLOSED"};
				if (this.poisoned) return {ok: false, reason: "STORE_POISONED"};
				if (this.readReservations.current() !== lease) throw new Error("NATIVE_READ_RESERVATION_LOST");
				const admitted = Object.freeze({lease, objectId, controlBytes: bytes, head: Object.freeze({...head.value}),
					imageDigest: image.value.imageDigest, metadataBytes: bytes?.byteLength ?? 0});
				this.#heldRetirementImage = admitted;
				return this.detachedHeldRetirementImage(admitted);
			}
			return Promise.resolve({
				ok: true,
				value: Object.freeze({
					control,
					head: head.value,
					imageDigest: image.value.imageDigest,
					metadataBytes: bytes?.byteLength ?? 0,
				}),
			});
		} catch (cause) {
			if (active)
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					/* Preserve original failure. */
				}
			return Promise.resolve({ ok: false, reason: "SUBSTRATE_FAILURE", cause });
		}
	}

	public acquireRetirementControl(objectId: StorageObjectId): Promise<StoreResult<AheRetirementControlRead>> {
		const prepared = prepareStorageAdapterCommand({ kind: "readHead", objectId });
		if (!prepared.ok) return Promise.resolve(prepared);
		if (this.closed) return Promise.resolve({ ok: false, reason: "STORE_CLOSED" });
		if (this.poisoned) return Promise.resolve({ ok: false, reason: "STORE_POISONED" });
		let active = false;
		try {
			this.connection.exec("BEGIN IMMEDIATE");
			active = true;
			const head = this.readHeadWithinTransaction(objectId);
			if (!head.ok) {
				this.connection.exec("ROLLBACK");
				active = false;
				return Promise.resolve(head);
			}
			let control = this.readControl(objectId);
			const absent = control === null;
			if (control === null) {
				control = {
					kind: "ahe-retirement-control-2",
					objectId,
					incarnation: randomBytes(32).toString("hex"),
					revision: 0,
					sequence: 0,
					active: null,
					completed: null,
				};
			}
			const expected = encodeAheRetirementControl(control);
			const admitted = admitNodeRetirementControl(this.connection, objectId, expected);
			if (!admitted.ok) {
				this.connection.exec("ROLLBACK");
				active = false;
				this.latchBoundedFailure(admitted);
				return Promise.resolve(admitted);
			}
			if (absent) {
				const insert = this.connection
					.prepare("INSERT INTO retirement_controls(object_id, record) VALUES (?, ?)")
					.run(objectId, expected);
				requireOneChange(insert.changes, "retirement control initialization");
			}
			const expectedHead = headFingerprint(head.value);
			this.connection.exec("COMMIT");
			active = false;
			return Promise.resolve({
				ok: true,
				value: createAheRetirementControlRead(
					control,
					head.value,
					admitted.value.imageDigest,
					(next, mutation) =>
						Promise.resolve(
							this.compareControl(objectId, expected, expectedHead, admitted.value.imageDigest, next, mutation)
						),
					this
				),
			});
		} catch (cause) {
			if (active) {
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					/* preserve primary */
				}
			}
			if (cause instanceof PersistedStorageError) {
				this.poisoned = true;
				return Promise.resolve({ ok: false, reason: cause.reason });
			}
			return Promise.resolve({ ok: false, reason: "SUBSTRATE_FAILURE", cause });
		}
	}

	private readControl(objectId: StorageObjectId): AheRetirementControl | null {
		return readNodeRetirementControl(this.connection, objectId);
	}

	private compareControl(
		objectId: StorageObjectId,
		expected: Uint8Array,
		expectedHead: string,
		expectedImageDigest: string,
		next: AheRetirementControl,
		mutation?: AheRetirementNativeMutation
	): StoreResult<AheRetirementControl> {
		if (this.closed) return { ok: false, reason: "STORE_CLOSED" };
		if (this.poisoned) return { ok: false, reason: "STORE_POISONED" };
		let active = false;
		let postimage: string | undefined;
		try {
			this.connection.exec("BEGIN IMMEDIATE");
			active = true;
			const current = this.readControl(objectId),
				head = this.readHeadWithinTransaction(objectId);
			if (!head.ok) {
				this.connection.exec("ROLLBACK");
				active = false;
				return head;
			}
			if (
				current === null ||
				!Buffer.from(encodeAheRetirementControl(current)).equals(expected) ||
				headFingerprint(head.value) !== expectedHead
			) {
				this.connection.exec("ROLLBACK");
				active = false;
				return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
			}
			const bytes = encodeAheRetirementControl(next);
			const admitted = admitNodeRetirementControl(this.connection, objectId, bytes);
			if (!admitted.ok) {
				this.connection.exec("ROLLBACK");
				active = false;
				this.latchBoundedFailure(admitted);
				return admitted;
			}
			if (admitted.value.imageDigest !== expectedImageDigest) {
				this.connection.exec("ROLLBACK");
				active = false;
				return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
			}
			const records = admitted.value.generations.map((g) => g.recordDigest);
			if (
				!aheRetirementGenerationBindingMatches(current, admitted.value.generations) ||
				(mutation?.kind !== "reclaim" && !aheRetirementGenerationBindingMatches(next, admitted.value.generations))
			) {
				this.connection.exec("ROLLBACK");
				active = false;
				return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
			}
			if (mutation?.kind === "reclaim") {
				if (
					!aheRetirementReclamationMatches(
						current,
						next,
						mutation.source,
						admitted.value.imageDigest,
						admitted.value.generations
					)
				) {
					this.connection.exec("ROLLBACK");
					active = false;
					return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
				}
				applyNodeBoundedAheReclamation(this.connection, this, mutation.source.reclamation, true);
			} else if (mutation !== undefined) {
				const candidate = admitted.value.generations.find((g) => g.generationId === mutation.material.generationId);
				const resuming = mutation.kind === "stage" && current.nominee != null;
				const existingDigest = mutation.material.existingGenerationRecordDigest;
				const nominatingExisting = mutation.kind === "stage" && !resuming && existingDigest !== undefined;
				if (
					(mutation.kind === "stage" &&
						!resuming &&
						!nominatingExisting &&
						(candidate !== undefined || records.length >= 7)) ||
					(nominatingExisting &&
						(candidate?.recordDigest !== existingDigest ||
							next.nominee?.recordDigest !== existingDigest ||
							mutation.material.blobs.length !== 0)) ||
					(resuming &&
						(candidate?.recordDigest !== current.nominee?.recordDigest ||
							!Buffer.from(encodeCanonical(current.nominee)).equals(encodeCanonical(next.nominee)))) ||
					(mutation.kind === "publish" && candidate?.recordDigest !== current.nominee?.recordDigest)
				) {
					this.connection.exec("ROLLBACK");
					active = false;
					return { ok: false, reason: "RETIREMENT_FENCED" };
				}
				if (nominatingExisting) {
					const prepared = prepareStorageAdapterCommand({
						kind: "completeGeneration",
						objectId,
						generationId: mutation.material.generationId,
					});
					if (!prepared.ok) throw new TypeError("existing native future command is invalid");
					const authorized = this.verifyCandidate(
						objectId,
						mutation.material.generationId,
						this.loadFacts(prepared.value)
					);
					if (!authorized?.ok) {
						this.connection.exec("ROLLBACK");
						active = false;
						return authorized ?? { ok: false, reason: "INVALID_ARGUMENT" };
					}
				}
				for (const command of resuming || nominatingExisting ? [] : aheRetirementNativeCommands(mutation)) {
					const prepared = prepareStorageAdapterCommand(command);
					if (!prepared.ok) {
						this.connection.exec("ROLLBACK");
						active = false;
						return prepared;
					}
					const facts = this.loadFacts(prepared.value);
					let evaluation = evaluateStorageAdapterCommand(prepared.value, facts);
					if (prepared.value.command.kind === "completeGeneration" || prepared.value.command.kind === "swapHead") {
						const authorized = this.verifyCandidate(objectId, mutation.material.generationId, facts);
						if (!authorized?.ok) {
							this.connection.exec("ROLLBACK");
							active = false;
							return authorized ?? { ok: false, reason: "INVALID_ARGUMENT" };
						}
						evaluation = evaluateStorageAdapterCommand(prepared.value, facts, authorized.value);
					}
					if (!evaluation.result.ok) {
						this.connection.exec("ROLLBACK");
						active = false;
						return evaluation.result;
					}
					this.applyWrites(evaluation, prepared.value.command.kind as SqliteMutationOperation);
				}
			}
			const after = admitNodeRetirementControl(this.connection, objectId, bytes);
			if (!after.ok) {
				this.connection.exec("ROLLBACK");
				active = false;
				this.latchBoundedFailure(after);
				return after;
			}
			if (!aheRetirementGenerationBindingMatches({ ...next, binding: null }, after.value.generations)) {
				this.connection.exec("ROLLBACK");
				active = false;
				return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
			}
			if (
				mutation?.kind === "stage" &&
				after.value.generations.find((g) => g.generationId === mutation.material.generationId)?.recordDigest !==
					next.nominee?.recordDigest
			) {
				this.connection.exec("ROLLBACK");
				active = false;
				return { ok: false, reason: "NON_CANONICAL_RECORD" };
			}
			if (mutation?.kind === "reclaim" && after.value.imageDigest !== mutation.source.postImageDigest) {
				this.connection.exec("ROLLBACK");
				active = false;
				return { ok: false, reason: "READ_STALE_ROLE_VIEW" };
			}
			postimage = after.value.imageDigest;
			const write = this.connection
				.prepare("UPDATE retirement_controls SET record = ? WHERE object_id = ?")
				.run(bytes, objectId);
			requireOneChange(write.changes, "retirement control write");
			this.connection.exec("COMMIT");
			active = false;
			return this.readControlPostimage(objectId, next, postimage);
		} catch (cause) {
			if (active) {
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					/* preserve primary */
				}
			}
			if (cause instanceof PersistedStorageError) {
				this.poisoned = true;
				return { ok: false, reason: cause.reason };
			}
			if (postimage !== undefined) {
				const recovered = this.readControlPostimage(objectId, next, postimage);
				if (recovered.ok) return recovered;
			}
			return { ok: false, reason: "SUBSTRATE_FAILURE", cause };
		}
	}

	private readControlPostimage(
		objectId: StorageObjectId,
		next: AheRetirementControl,
		imageDigest: string
	): StoreResult<AheRetirementControl> {
		let active = false;
		try {
			this.connection.exec("BEGIN");
			active = true;
			const current = this.readControl(objectId),
				image = admitNodeRetirementControl(this.connection, objectId, encodeAheRetirementControl(next));
			const matches =
				current !== null &&
				Buffer.from(encodeAheRetirementControl(current)).equals(encodeAheRetirementControl(next)) &&
				image.ok &&
				image.value.imageDigest === imageDigest;
			this.connection.exec("COMMIT");
			active = false;
			return matches ? { ok: true, value: next } : { ok: false, reason: "READ_STALE_ROLE_VIEW" };
		} catch (cause) {
			if (active)
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					/* preserve failure */
				}
			return { ok: false, reason: "SUBSTRATE_FAILURE", cause };
		}
	}

	public acquireBoundedActiveRead(input: AheBoundedReadInput): Promise<StoreResult<AheBoundedReadAcquisition>> {
		const prepared = prepareBoundedRead(input);
		if (!prepared.ok) return Promise.resolve(prepared);
		const result = this.runBoundedSteps(boundedActiveReadSteps(prepared.value));
		if (!result.ok) return Promise.resolve(result);
		return Promise.resolve({
			ok: true,
			value: createBoundedReadAcquisition(result.value, (head, released) =>
				Promise.resolve(this.runBoundedSteps(boundedHeadSteps(head.objectId), released))
			),
		});
	}

	public acquireBoundedRecoveryRoleRead(
		input: AheBoundedRecoveryRoleReadInput
	): Promise<StoreResult<AheBoundedRecoveryRoleRead>> {
		const prepared = prepareBoundedRecoveryRoleRead(input);
		if (!prepared.ok) return Promise.resolve(prepared);
		const result = this.runBoundedSteps(boundedRecoveryRoleReadSteps(prepared.value));
		return Promise.resolve(
			!result.ok
				? result
				: {
						ok: true,
						value: createBoundedRecoveryRoleRead(result.value, (steps, released) =>
							Promise.resolve(this.runBoundedSteps(steps, released))
						),
					}
		);
	}

	private runBoundedSteps<T>(
		steps: Generator<BoundedReadRequest, StoreResult<T>, unknown>,
		released?: () => boolean
	): StoreResult<T> {
		if (this.closed) return { ok: false, reason: "STORE_CLOSED" };
		if (this.poisoned) return { ok: false, reason: "STORE_POISONED" };
		if (released?.()) return { ok: false, reason: "READ_RELEASED" };
		this.boundedReads++;
		let active = false;
		try {
			this.connection.exec("BEGIN");
			active = true;
			let step = steps.next();
			while (!step.done) step = steps.next(loadNodeBoundedReadRequest(this.connection, step.value));
			this.connection.exec("COMMIT");
			active = false;
			this.latchBoundedFailure(step.value);
			return step.value;
		} catch (cause) {
			if (active)
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					/* Preserve primary native failure. */
				}
			const result: StoreResult<T> =
				cause instanceof BoundedReadBudgetError
					? { ok: false, reason: "READ_BUDGET_EXCEEDED" }
					: cause instanceof PersistedStorageError
						? { ok: false, reason: cause.reason }
						: { ok: false, reason: "SUBSTRATE_FAILURE", cause };
			this.latchBoundedFailure(result);
			return result;
		} finally {
			this.boundedReads--;
			if (this.locallyClosed && this.boundedReads === 0 && this.boundedClose !== undefined) {
				this.connection.close();
				this.resolveBoundedClose?.();
				this.resolveBoundedClose = undefined;
			}
		}
	}

	private latchBoundedFailure(result: StoreResult<unknown>): void {
		if (isBoundedReadCorruption(result)) {
			this.poisoned = true;
			this.recoveryCertificates.clear();
		}
	}

	public readGenerationPage(input: {
		readonly objectId: StorageObjectId;
		readonly cursor?: GenerationPageCursor;
		readonly limit: number;
	}): Promise<StoreResult<GenerationPage>> {
		return this.run(commandWithKind("readGenerationPage", input)) as Promise<StoreResult<GenerationPage>>;
	}

	public getBlob(digest: BlobDigest): Promise<StoreResult<Uint8Array | null>> {
		return this.run(commandWithKind("getBlob", { digest })) as Promise<StoreResult<Uint8Array | null>>;
	}
	public recoverActiveGeneration(objectId: StorageObjectId): Promise<StoreResult<ActiveGenerationSnapshot>> {
		const prepared = prepareStorageAdapterCommand({ kind: "readHead", objectId });
		if (!prepared.ok) return Promise.resolve(prepared);
		if (this.closed) return Promise.resolve({ ok: false, reason: "STORE_CLOSED" });
		if (this.poisoned) return Promise.resolve({ ok: false, reason: "STORE_POISONED" });
		return Promise.resolve(this.recoverTransaction(objectId));
	}

	public beginGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		baseExpectedHead: ExpectedHead;
		closure: readonly GenerationRef[];
	}): Promise<StoreResult<GenerationRecord>> {
		return this.run(commandWithKind("beginGeneration", input)) as Promise<StoreResult<GenerationRecord>>;
	}

	public putCachedBlob(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
		bytes: Uint8Array;
	}): Promise<StoreResult<{ inserted: boolean }>> {
		return this.run(commandWithKind("putCachedBlob", input)) as Promise<StoreResult<{ inserted: boolean }>>;
	}

	public promoteReference(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		digest: BlobDigest;
	}): Promise<StoreResult<undefined>> {
		return this.run(commandWithKind("promoteReference", input)) as Promise<StoreResult<undefined>>;
	}

	public completeGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>> {
		return this.run(commandWithKind("completeGeneration", input)) as Promise<StoreResult<GenerationRecord>>;
	}

	public swapHead(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
		expectedHead: ExpectedHead;
	}): Promise<StoreResult<{ head: PresentHead; supersededGenerationId: GenerationId | null }>> {
		return this.run(commandWithKind("swapHead", input)) as Promise<
			StoreResult<{ head: PresentHead; supersededGenerationId: GenerationId | null }>
		>;
	}

	public discardGeneration(input: {
		objectId: StorageObjectId;
		generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>> {
		return this.run(commandWithKind("discardGeneration", input)) as Promise<StoreResult<GenerationRecord>>;
	}

	public close(): Promise<void> {
		if (!this.locallyClosed) {
			this.locallyClosed = true;
			this.#heldRetirementImage = undefined;
			this.readReservations.revoke();
			this.recoveryCertificates.clear();
			if (this.boundedReads === 0) this.connection.close();
			else
				this.boundedClose = new Promise((resolve) => {
					this.resolveBoundedClose = resolve;
				});
		}
		return (this.boundedClose ?? Promise.resolve()).then(() => this.readReservations.close()).then(() => this.session?.closedOwner(this));
	}

	private run(command: unknown): Promise<StoreResult<unknown>> {
		const prepared = prepareStorageAdapterCommand(command);
		if (!prepared.ok) return Promise.resolve(prepared);
		if (this.closed) {
			return Promise.resolve(evaluateStorageAdapterCommand(prepared.value, [{ kind: "store-closed" }]).result);
		}
		if (this.poisoned) return Promise.resolve({ ok: false, reason: "STORE_POISONED" });
		return Promise.resolve(this.execute(prepared.value));
	}

	private execute(prepared: PreparedStorageAdapterCommand): StoreResult<unknown> {
		const operation = prepared.command.kind;
		const mutation = isMutation(operation);
		let transactionActive = false;
		let result: StoreResult<unknown>;
		try {
			if (mutation) {
				this.connection.exec("BEGIN IMMEDIATE");
				transactionActive = true;
				if (!("objectId" in prepared.command)) throw new Error("mutation command lacks object scope");
				const control = this.readControl(prepared.command.objectId);
				if (control !== null && (control.active !== null || control.completed !== null)) {
					this.connection.exec("ROLLBACK");
					transactionActive = false;
					return { ok: false, reason: "RETIREMENT_FENCED" };
				}
				if (control?.revision === Number.MAX_SAFE_INTEGER) {
					this.connection.exec("ROLLBACK");
					transactionActive = false;
					return { ok: false, reason: "REVISION_EXHAUSTED" };
				}
				if (control !== null) {
					const admitted = admitNodeRetirementControl(
						this.connection,
						control.objectId,
						encodeAheRetirementControl(control)
					);
					if (!admitted.ok) {
						this.connection.exec("ROLLBACK");
						transactionActive = false;
						this.latchBoundedFailure(admitted);
						return admitted;
					}
				}
				const recovered = this.ensureCertificate(
					prepared.command.objectId,
					operation === "completeGeneration" || operation === "swapHead"
				);
				if (!recovered.ok) {
					this.poisoned = true;
					this.connection.exec("ROLLBACK");
					transactionActive = false;
					return recovered;
				}
			}
			const facts = this.loadFacts(prepared);
			let evaluation = evaluateStorageAdapterCommand(prepared, facts);
			if (prepared.command.kind === "completeGeneration" || prepared.command.kind === "swapHead") {
				if (!evaluation.result.ok && evaluation.result.reason !== "INVALID_ARGUMENT") {
					this.connection.exec("ROLLBACK");
					transactionActive = false;
					return evaluation.result;
				}
				const authorization = this.verifyCandidate(prepared.command.objectId, prepared.command.generationId, facts);
				if (authorization === undefined || !authorization.ok) {
					this.connection.exec("ROLLBACK");
					transactionActive = false;
					return authorization ?? { ok: false, reason: "INVALID_ARGUMENT" };
				}
				evaluation = evaluateStorageAdapterCommand(prepared, facts, authorization.value);
			}
			if (!evaluation.result.ok) {
				if (transactionActive) {
					this.connection.exec("ROLLBACK");
					transactionActive = false;
				}
				return evaluation.result;
			}
			if (mutation) {
				this.applyWrites(evaluation, operation);
				if (!("objectId" in prepared.command)) throw new Error("mutation command lacks object scope");
				const control = this.readControl(prepared.command.objectId);
				const advanced = advanceNodeRetirementControl(this.connection, control);
				if (!advanced.ok) {
					this.connection.exec("ROLLBACK");
					transactionActive = false;
					this.latchBoundedFailure(advanced);
					return advanced;
				}
				if (this.crashObserver === undefined) {
					if (operation === "beginGeneration") this.fault?.({ operation, edge: "before-commit" });
				} else {
					this.crashObserver({ operation, edge: "before-commit" });
				}
			}
			if (transactionActive) {
				this.connection.exec("COMMIT");
				transactionActive = false;
			}
			result = evaluation.result;
			if (mutation && operation === "swapHead" && result.ok) {
				const swap = result.value as Readonly<{ head: PresentHead }>;
				this.recoveryCertificates.set(prepared.command.objectId, headFingerprint(swap.head));
			}
		} catch (cause) {
			this.recoveryCertificates.clear();
			const persistedReason = cause instanceof PersistedStorageError ? cause.reason : undefined;
			if (persistedReason !== undefined) this.poisoned = true;
			if (transactionActive) {
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					// The primary substrate failure remains the public cause.
				}
			}
			return persistedReason === undefined
				? { ok: false, reason: "SUBSTRATE_FAILURE", cause }
				: { ok: false, reason: persistedReason };
		}
		if (mutation) this.crashObserver?.({ operation, edge: "after-commit" });
		return result;
	}

	private loadFacts(prepared: PreparedStorageAdapterCommand): readonly StorageAdapterFact[] {
		const facts: StorageAdapterFact[] = [];
		const loadedBlobs = new Set<BlobDigest>();
		const loadedPromotions = new Set<string>();
		for (const requirement of prepared.requirements) {
			switch (requirement.kind) {
				case "head": {
					const row = this.connection
						.prepare("SELECT head_record FROM objects WHERE object_id = ?")
						.get(requirement.objectId) as DatabaseRow | undefined;
					const classified = classifyPersistedState({
						kind: "head",
						objectId: requirement.objectId,
						row: row === undefined ? null : { objectId: requirement.objectId, record: row.head_record },
					});
					if (!classified.ok) throw new PersistedStorageError(classified.reason);
					if (classified.value.kind !== "head") throw new Error("persisted classifier returned the wrong fact kind");
					facts.push({
						headRecord: classified.value.record,
						kind: "head",
						objectId: requirement.objectId,
					});
					break;
				}
				case "generation-page": {
					const rows = (
						requirement.afterGenerationId === null
							? this.connection
									.prepare(
										"SELECT generation_id, record FROM generations WHERE object_id = ? ORDER BY generation_id LIMIT ?"
									)
									.all(requirement.objectId, requirement.limitPlusOne)
							: this.connection
									.prepare(
										"SELECT generation_id, record FROM generations WHERE object_id = ? AND generation_id > ? ORDER BY generation_id LIMIT ?"
									)
									.all(requirement.objectId, requirement.afterGenerationId, requirement.limitPlusOne)
					) as DatabaseRow[];
					facts.push({
						afterGenerationId: requirement.afterGenerationId,
						generationRecords: rows.map((row) => boundGenerationRecord(row, requirement.objectId)),
						kind: "generation-page",
						objectId: requirement.objectId,
					});
					break;
				}
				case "generation":
					this.loadGeneration(requirement.objectId, requirement.generationId, facts);
					break;
				case "blob":
					this.loadBlob(requirement.digest, facts, loadedBlobs);
					break;
				case "promotion":
					this.loadPromotion(requirement, facts, loadedPromotions);
					break;
			}
		}
		if (prepared.command.kind === "swapHead") {
			const headFact = facts.find(
				(fact): fact is Extract<StorageAdapterFact, { kind: "head" }> => fact.kind === "head"
			);
			const decoded =
				headFact?.headRecord === null || headFact === undefined ? undefined : decodeHeadRecordV1(headFact.headRecord);
			if (
				decoded?.ok === true &&
				decoded.value.kind === "present" &&
				decoded.value.generationId !== prepared.command.generationId
			)
				this.loadGeneration(prepared.command.objectId, decoded.value.generationId, facts);
		}
		return facts;
	}
	private loadGeneration(objectId: StorageObjectId, generationId: GenerationId, facts: StorageAdapterFact[]): void {
		const row = this.connection
			.prepare("SELECT record FROM generations WHERE object_id = ? AND generation_id = ?")
			.get(objectId, generationId) as DatabaseRow | undefined;
		if (row === undefined) {
			facts.push({ kind: "generation", objectId, generationId, generationRecord: null });
			return;
		}
		const classified = classifyPersistedState({
			kind: "generation",
			objectId,
			row: { objectId, generationId, record: row.record },
		});
		if (!classified.ok) throw new PersistedStorageError(classified.reason);
		if (classified.value.kind !== "generation") throw new Error("persisted classifier returned wrong kind");
		facts.push({ kind: "generation", objectId, generationId, generationRecord: classified.value.record });
	}

	private loadBlob(digest: BlobDigest, facts: StorageAdapterFact[], loaded: Set<BlobDigest>): void {
		if (loaded.has(digest)) return;
		const row = this.connection.prepare("SELECT bytes FROM blobs WHERE digest = ?").get(digest) as
			| DatabaseRow
			| undefined;
		facts.push({ kind: "blob", digest, bytes: row === undefined ? null : databaseBytes(row.bytes) });
		loaded.add(digest);
	}

	private loadPromotion(
		scope: Readonly<{ objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }>,
		facts: StorageAdapterFact[],
		loaded: Set<string>
	): void {
		const key = `${scope.objectId}\0${scope.generationId}\0${scope.digest}`;
		if (loaded.has(key)) return;
		const row = this.connection
			.prepare("SELECT 1 FROM promotions WHERE object_id = ? AND generation_id = ? AND digest = ?")
			.get(scope.objectId, scope.generationId, scope.digest);
		if (row !== undefined) facts.push({ kind: "promotion", ...scope });
		loaded.add(key);
	}

	private recoverTransaction(objectId: StorageObjectId): StoreResult<ActiveGenerationSnapshot> {
		let active = false;
		try {
			this.connection.exec("BEGIN IMMEDIATE");
			active = true;
			const result = this.recoverWithinTransaction(objectId);
			if (!result.ok) {
				this.poisoned = true;
				this.connection.exec("ROLLBACK");
				active = false;
				return result;
			}
			this.connection.exec("COMMIT");
			active = false;
			const snapshot = freezeRecoverySnapshot(result.value);
			this.recoveryCertificates.set(objectId, headFingerprint(snapshot.head));
			return { ok: true, value: snapshot };
		} catch (cause) {
			this.recoveryCertificates.clear();
			if (active)
				try {
					this.connection.exec("ROLLBACK");
				} catch {
					/* preserve cause */
				}
			return { ok: false, reason: "SUBSTRATE_FAILURE", cause };
		}
	}

	private ensureCertificate(objectId: StorageObjectId, required: boolean): StoreResult<undefined> {
		const head = this.readHeadWithinTransaction(objectId);
		if (!head.ok) return head;
		if (this.recoveryCertificates.get(objectId) === headFingerprint(head.value)) return { ok: true, value: undefined };
		if (!required && !this.recoveryCertificates.has(objectId)) return { ok: true, value: undefined };
		const recovered = this.recoverWithinTransaction(objectId);
		if (!recovered.ok) return recovered;
		this.recoveryCertificates.set(objectId, headFingerprint(recovered.value.head));
		return { ok: true, value: undefined };
	}

	private readHeadWithinTransaction(objectId: StorageObjectId): StoreResult<ExpectedHead> {
		const row = this.connection.prepare("SELECT head_record FROM objects WHERE object_id = ?").get(objectId) as
			| DatabaseRow
			| undefined;
		const classified = classifyPersistedState({
			kind: "head",
			objectId,
			row: row === undefined ? null : { objectId, record: row.head_record },
		});
		return classified.ok && classified.value.kind === "head"
			? { ok: true, value: classified.value.head }
			: (classified as StoreResult<ExpectedHead>);
	}

	private recoverWithinTransaction(objectId: StorageObjectId): StoreResult<ActiveGenerationSnapshot> {
		const headResult = this.readHeadWithinTransaction(objectId);
		if (!headResult.ok) return headResult;
		let after: string | null = null;
		let adopted: GenerationRecord | null = null;
		let adoptedCount = 0;
		let failure: "NON_CANONICAL_RECORD" | "UNSUPPORTED_STORAGE_SCHEMA" | undefined;
		for (;;) {
			const rows = (
				after === null
					? this.connection
							.prepare(
								"SELECT generation_id, record FROM generations WHERE object_id = ? ORDER BY generation_id LIMIT ?"
							)
							.all(objectId, 129)
					: this.connection
							.prepare(
								"SELECT generation_id, record FROM generations WHERE object_id = ? AND generation_id > ? ORDER BY generation_id LIMIT ?"
							)
							.all(objectId, after, 129)
			) as DatabaseRow[];
			for (const row of rows) {
				const classified = classifyPersistedState({
					kind: "generation",
					objectId,
					row: { objectId, generationId: row.generation_id, record: row.record },
				});
				if (!classified.ok)
					failure =
						failure === "UNSUPPORTED_STORAGE_SCHEMA" || classified.reason === "UNSUPPORTED_STORAGE_SCHEMA"
							? "UNSUPPORTED_STORAGE_SCHEMA"
							: "NON_CANONICAL_RECORD";
				else if (classified.value.kind === "generation" && classified.value.generation.state === "Adopted") {
					adoptedCount++;
					adopted ??= classified.value.generation;
				}
			}
			if (rows.length < 129) break;
			const cursor = rows.at(-1)?.generation_id;
			if (typeof cursor !== "string") return { ok: false, reason: "NON_CANONICAL_RECORD" };
			const parsedCursor = parseGenerationId(cursor);
			if (!parsedCursor.ok) return { ok: false, reason: "NON_CANONICAL_RECORD" };
			after = parsedCursor.value;
		}
		if (failure !== undefined) return { ok: false, reason: failure };
		const head = headResult.value;
		if (head.kind === "none")
			return adoptedCount === 0
				? {
						ok: true,
						value: { kind: "empty", head, adoptedGeneration: null, recomputedClosureDigest: null, references: [] },
					}
				: { ok: false, reason: "NON_CANONICAL_RECORD" };
		if (
			adoptedCount !== 1 ||
			adopted === null ||
			adopted.generationId !== head.generationId ||
			adopted.closureDigest !== head.closureDigest
		)
			return { ok: false, reason: "NON_CANONICAL_RECORD" };
		const verified = this.verifyClosure(objectId, adopted, "adopted");
		if (!verified.ok) return verified;
		return {
			ok: true,
			value: {
				kind: "active",
				head: { ...head },
				adoptedGeneration: {
					...adopted,
					baseExpectedHead: { ...adopted.baseExpectedHead },
					closure: adopted.closure.map((r) => ({ ...r })),
				},
				recomputedClosureDigest: adopted.closureDigest,
				references: adopted.closure.map((r) => ({ ...r })),
			},
		};
	}

	private verifyCandidate(
		objectId: StorageObjectId,
		generationId: GenerationId,
		facts: readonly StorageAdapterFact[]
	): StoreResult<unknown> | undefined {
		const fact = facts.find(
			(value): value is Extract<StorageAdapterFact, { kind: "generation" }> =>
				value.kind === "generation" && value.objectId === objectId && value.generationId === generationId
		);
		if (fact?.generationRecord === null || fact === undefined) return undefined;
		const decoded = decodeGenerationRecordV1(fact.generationRecord);
		if (!decoded.ok) return { ok: false, reason: "NON_CANONICAL_RECORD" };
		return this.verifyClosure(objectId, decoded.value, "candidate");
	}

	private verifyClosure(
		objectId: StorageObjectId,
		generation: GenerationRecord,
		mode: "adopted" | "candidate"
	): StoreResult<unknown> {
		const session = storageAdapterClosureVerifier.start(generation, mode);
		for (
			let request = storageAdapterClosureVerifier.next(session);
			request !== null;
			request = storageAdapterClosureVerifier.next(session)
		) {
			if (request.kind === "promotion") {
				const present =
					this.connection
						.prepare("SELECT 1 FROM promotions WHERE object_id = ? AND generation_id = ? AND digest = ?")
						.get(objectId, generation.generationId, request.reference.digest) !== undefined;
				storageAdapterClosureVerifier.acceptPromotion(session, present);
			} else {
				const row = this.connection
					.prepare("SELECT bytes FROM blobs WHERE digest = ?")
					.get(request.reference.digest) as DatabaseRow | undefined;
				storageAdapterClosureVerifier.acceptBlob(session, row === undefined ? null : row.bytes);
			}
		}
		return storageAdapterClosureVerifier.finish(session);
	}

	private applyWrites(evaluation: StorageAdapterEvaluation, operation: SqliteMutationOperation): void {
		const occurrences = new Map<SqliteMutationStatement, number>();
		const observe = (statement: SqliteMutationStatement): void => {
			if (this.crashObserver === undefined) return;
			const occurrence = (occurrences.get(statement) ?? 0) + 1;
			occurrences.set(statement, occurrence);
			this.crashObserver({ edge: "after-statement", occurrence, operation, statement });
		};
		for (const write of evaluation.writes) this.applyWrite(write, observe);
	}

	private applyWrite(write: StorageAdapterWrite, observe: (statement: SqliteMutationStatement) => void): void {
		switch (write.kind) {
			case "replace-generation": {
				const decoded = decodeGenerationRecordV1(write.record);
				if (
					!decoded.ok ||
					decoded.value.objectId !== write.objectId ||
					decoded.value.generationId !== write.generationId
				) {
					throw new Error("adapter emitted an invalid generation write");
				}
				this.connection
					.prepare("INSERT OR IGNORE INTO objects(object_id, head_record) VALUES (?, NULL)")
					.run(write.objectId);
				observe("object-ensure");
				const exists = this.connection
					.prepare("SELECT 1 FROM generations WHERE object_id = ? AND generation_id = ?")
					.get(write.objectId, write.generationId);
				const statement =
					exists === undefined
						? this.connection.prepare("INSERT INTO generations(object_id, generation_id, record) VALUES (?, ?, ?)")
						: this.connection.prepare("UPDATE generations SET record = ? WHERE object_id = ? AND generation_id = ?");
				const result =
					exists === undefined
						? statement.run(write.objectId, write.generationId, new Uint8Array(write.record))
						: statement.run(new Uint8Array(write.record), write.objectId, write.generationId);
				observe(exists === undefined ? "generation-insert" : "generation-update");
				requireOneChange(result.changes, "generation write");
				return;
			}
			case "replace-head": {
				const decoded = decodeHeadRecordV1(write.record);
				if (!decoded.ok || decoded.value.kind !== "present" || decoded.value.objectId !== write.objectId) {
					throw new Error("adapter emitted an invalid head write");
				}
				const result = this.connection
					.prepare(
						"INSERT INTO objects(object_id, head_record) VALUES (?, ?) " +
							"ON CONFLICT(object_id) DO UPDATE SET head_record = excluded.head_record"
					)
					.run(write.objectId, new Uint8Array(write.record));
				observe("head-upsert");
				requireOneChange(result.changes, "head write");
				return;
			}
			case "insert-blob": {
				const result = this.connection
					.prepare("INSERT INTO blobs(digest, bytes) VALUES (?, ?)")
					.run(write.digest, new Uint8Array(write.bytes));
				observe("blob-insert");
				requireOneChange(result.changes, "blob insert");
				return;
			}
			case "insert-promotion": {
				const result = this.connection
					.prepare("INSERT INTO promotions(object_id, generation_id, digest) VALUES (?, ?, ?)")
					.run(write.objectId, write.generationId, write.digest);
				observe("promotion-insert");
				requireOneChange(result.changes, "promotion insert");
			}
		}
	}
}

function isMutation(kind: StorageAdapterCommand["kind"]): kind is SqliteMutationOperation {
	return kind !== "readHead" && kind !== "readGenerationPage" && kind !== "getBlob";
}

function headFingerprint(head: ExpectedHead): string {
	return head.kind === "none"
		? `none\0${head.objectId}`
		: `present\0${head.objectId}\0${head.generationId}\0${head.revision}\0${head.closureDigest}`;
}

function commandWithKind(kind: StorageAdapterCommand["kind"], input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return { kind, invalidInput: input };
	const descriptors = Object.getOwnPropertyDescriptors(input);
	if (Object.prototype.hasOwnProperty.call(descriptors, "kind")) return { kind, invalidInput: true };
	const command = { kind } as Record<PropertyKey, unknown>;
	Object.defineProperties(command, descriptors);
	return command;
}

function databaseBytes(value: unknown): Uint8Array {
	if (!(value instanceof Uint8Array)) throw new Error("SQLite returned a non-BLOB value");
	return new Uint8Array(value);
}

function boundGenerationRecord(row: DatabaseRow, objectId: StorageObjectId): Uint8Array {
	const classified = classifyPersistedState({
		kind: "generation",
		objectId,
		row: { generationId: row.generation_id, objectId, record: row.record },
	});
	if (!classified.ok) throw new PersistedStorageError(classified.reason);
	if (classified.value.kind !== "generation") throw new Error("persisted classifier returned the wrong fact kind");
	return classified.value.record;
}

function requireOneChange(changes: number | bigint, label: string): void {
	if (Number(changes) !== 1) throw new Error(`${label} did not affect exactly one row`);
}

function configureConnection(connection: DatabaseSync, initialization: "create" | "reopen" = "create"): void {
	connection.exec("PRAGMA busy_timeout = 1000");
	connection.exec("PRAGMA foreign_keys = ON");
	if (initialization === "reopen") {
		if (
			Number(Object.values(connection.prepare("PRAGMA user_version").get() ?? {})[0]) !== 2 ||
			!hasExpectedPhysicalSchema(connection) ||
			String(Object.values(connection.prepare("PRAGMA journal_mode").get() ?? {})[0]).toLowerCase() !== "wal"
		)
			throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
		connection.exec("PRAGMA synchronous = FULL");
		return;
	}
	const tableCount = (
		connection
			.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.get() as DatabaseRow
	).count;
	if (Number(tableCount) - nativeLocalSessionSchemaExtraRows(connection) === 0) {
		if (Number(Object.values(connection.prepare("PRAGMA user_version").get() ?? {})[0]) !== 0)
			throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
		connection.exec("BEGIN IMMEDIATE");
		try {
			const nativeTableCount = connection
				.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.get() as DatabaseRow;
			if (
				Number(nativeTableCount.count) - nativeLocalSessionSchemaExtraRows(connection) !== 0 ||
				Number(Object.values(connection.prepare("PRAGMA user_version").get() ?? {})[0]) !== 0
			)
				throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
			connection.exec(SCHEMA);
			connection.exec("PRAGMA user_version = 2");
			if (!hasExpectedPhysicalSchema(connection)) throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
			connection.exec("COMMIT");
		} catch (error) {
			try {
				connection.exec("ROLLBACK");
			} catch {
				// Preserve the primary schema-creation failure.
			}
			throw error;
		}
	}
	const version = Number(Object.values(connection.prepare("PRAGMA user_version").get() ?? {})[0]);
	if (version === 0 && hasExpectedPhysicalSchema(connection, 0)) {
		connection.exec("BEGIN IMMEDIATE");
		try {
			if (
				!hasExpectedPhysicalSchema(connection, 0) ||
				Number(Object.values(connection.prepare("PRAGMA user_version").get() ?? {})[0]) !== 0
			)
				throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
			connection.exec(
				"CREATE TABLE retirement_controls(object_id TEXT PRIMARY KEY, record BLOB NOT NULL) WITHOUT ROWID"
			);
			connection.exec("PRAGMA user_version = 2");
			if (!hasExpectedPhysicalSchema(connection)) throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
			connection.exec("COMMIT");
		} catch (cause) {
			try {
				connection.exec("ROLLBACK");
			} catch {
				/* preserve primary */
			}
			throw cause;
		}
	}
	if (version === 1) {
		connection.exec("BEGIN IMMEDIATE");
		try {
			if (
				!hasExpectedPhysicalSchema(connection, 1) ||
				connection.prepare("SELECT 1 FROM retirement_controls LIMIT 1").get() !== undefined
			)
				throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
			connection.exec("PRAGMA user_version = 2");
			if (!hasExpectedPhysicalSchema(connection)) throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
			connection.exec("COMMIT");
		} catch (cause) {
			try {
				connection.exec("ROLLBACK");
			} catch {
				/* preserve primary */
			}
			throw cause;
		}
	}
	if (Number(Object.values(connection.prepare("PRAGMA user_version").get() ?? {})[0]) !== 2)
		throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
	if (!hasExpectedPhysicalSchema(connection)) throw new PersistedStorageError("UNSUPPORTED_STORAGE_SCHEMA");
	connection.exec("PRAGMA journal_mode = WAL");
	connection.exec("PRAGMA synchronous = FULL");
}

function freezeRecoverySnapshot(snapshot: ActiveGenerationSnapshot): ActiveGenerationSnapshot {
	if (snapshot.kind === "empty")
		return Object.freeze({
			...snapshot,
			head: Object.freeze({ ...snapshot.head }),
			references: Object.freeze([] as []),
		});
	return Object.freeze({
		...snapshot,
		head: Object.freeze({ ...snapshot.head }),
		adoptedGeneration: Object.freeze({
			...snapshot.adoptedGeneration,
			baseExpectedHead: Object.freeze({ ...snapshot.adoptedGeneration.baseExpectedHead }),
			closure: Object.freeze(snapshot.adoptedGeneration.closure.map((reference) => Object.freeze({ ...reference }))),
		}),
		references: Object.freeze(snapshot.references.map((reference) => Object.freeze({ ...reference }))),
	});
}

/**
 * Creates the production SQLite store.
 * @param options - File-backed SQLite options.
 * @param fault - Optional bounded test-only fault callback.
 * @returns A strict store over one configured connection.
 * @internal
 */
export function createSqliteScaffold(
	options: SqliteAheDurableStoreOptions,
	fault?: SqliteMutationFault,
	session?: LocalSessionLifetime
): AheBoundedRecoveryRoleStore & NodeNativeReadPort {
	return createInstrumentedSqliteScaffold(options, fault, undefined, session).store;
}

/**
 * Creates the store and exact live-connection probes used by the package-local RED.
 * @param options - File-backed SQLite options.
 * @param fault - Optional bounded test-only fault callback.
 * @param crashObserver - Optional expanded process-death checkpoint observer.
 * @returns Store and non-exported connection instrumentation.
 * @internal
 */
export function createInstrumentedSqliteScaffold(
	options: SqliteAheDurableStoreOptions,
	fault?: SqliteMutationFault,
	crashObserver?: SqliteCrashCheckpointObserver,
	session?: LocalSessionLifetime
): SqliteScaffoldInstrumentation {
	session?.assertCurrent();
	const connection = new DatabaseSync(sqliteFilename(options.filename, options.initialization));
	try {
		enforceNativeLocalSessionFile(connection, options.filename, session, options.initialization !== "reopen");
		configureConnection(connection, options.initialization);
	} catch (error) {
		connection.close();
		throw error;
	}
	return {
		attemptInvalidForeignKeyInsert: (): void => {
			connection.exec(
				"CREATE TEMP TABLE phase_2c_parent(id INTEGER PRIMARY KEY);" +
					"CREATE TEMP TABLE phase_2c_child(parent_id INTEGER REFERENCES phase_2c_parent(id));"
			);
			try {
				connection.prepare("INSERT INTO phase_2c_child(parent_id) VALUES (?)").run(1);
			} finally {
				connection.exec("DROP TABLE phase_2c_child;DROP TABLE phase_2c_parent;");
			}
		},
		readPragma: (pragma): unknown => {
			const row = connection.prepare(`PRAGMA ${pragma}`).get();
			return row === undefined ? undefined : Object.values(row)[0];
		},
		store: new SqliteAheDurableStore(connection, options.filename, fault, crashObserver, session),
	};
}
