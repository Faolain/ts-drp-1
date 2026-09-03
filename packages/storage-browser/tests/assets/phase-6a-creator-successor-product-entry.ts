import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

type PlainRecord = Readonly<Record<string, unknown>>;

interface DirectRoomSession {
	activateMigration(input: Readonly<Record<string, unknown>>): Promise<unknown>;
	adoptCreatorSuccessor(): Promise<void>;
	authority(): PlainRecord | null;
	close(): Promise<void>;
	inspectDurableHead(): Promise<unknown>;
	issue(operation: Readonly<Record<string, unknown>>): Promise<void>;
	previewLatchedAcl(): PlainRecord;
	projection(): unknown;
	rehearseMigration(input: Readonly<Record<string, unknown>>): Promise<unknown>;
	readonly roomId: string;
	sealEpoch(): Promise<unknown>;
	status(): PlainRecord;
}

type DirectRoomHeadFault =
	| "begin-conflict"
	| "begin-malformed"
	| "begin-unavailable"
	| "commit-conflict"
	| "commit-malformed"
	| "commit-unavailable-once"
	| "create-conflict"
	| "create-malformed"
	| "create-unavailable"
	| "none"
	| "read-malformed"
	| "read-unavailable";

interface DirectRoomHeadControl {
	fault: DirectRoomHeadFault;
	initialStable?: PlainRecord;
	readonly operations: string[];
	state: PlainRecord | null;
}

interface DirectRoomOpenOptions {
	readonly control?: DirectRoomHeadControl;
	readonly initialization?: PlainRecord;
	onOpenTransport?(): void;
	readonly roomHeadAuthority?: PlainRecord;
	readonly successorSnapshotDeclaration?: unknown;
	readonly withCreatorSigner?: boolean;
}

interface DirectKeychain {
	readonly localAuthorId: string;
	signWithLocalAuthor(digest: Uint8Array): Promise<Uint8Array>;
	start(): Promise<void>;
}

interface DirectRoomDependencies {
	readonly Keychain: new (input: Readonly<{ readonly private_key_seed: string }>) => DirectKeychain;
	bindV3BlueprintLivePlane(input: Readonly<Record<string, unknown>>): PlainRecord;
	createRecoverableFinalitySigner(
		input: Readonly<{ readonly seed: Uint8Array }>
	): Promise<Readonly<{ readonly publicKey: Uint8Array; readonly signer: unknown }>>;
	createV3ChatApplication(clientId: "alice"): Readonly<{
		readonly catalog: Readonly<{ readonly blueprintDigests: readonly string[] }>;
	}>;
	createV3ZoneApplication(
		members: readonly PlainRecord[],
		creatorPeerId: string,
		creatorAuthor: string
	): Readonly<{
		projectAcceptedOperations(input: Readonly<Record<string, unknown>>): unknown;
	}>;
	createV3RoomCreatorInviteMaterial(input: Readonly<Record<string, unknown>>): Promise<unknown>;
	createV3RoomSession(input: Readonly<Record<string, unknown>>): Promise<DirectRoomSession>;
}

interface RelayPacket {
	readonly channelName: string;
	readonly fingerprint: string;
	readonly realmId: string;
	readonly sequence: number;
	readonly value: unknown;
}

interface RelayMessageObservation {
	readonly data: Uint8Array;
	readonly objectId: string;
	readonly receiverRealmId?: string;
	readonly sender: string;
	readonly sequence: number;
	readonly sourceRealmId: string;
	readonly type: number;
}

interface RelayAudit {
	readonly incoming: number;
	readonly incomingMessages: readonly RelayMessageObservation[];
	readonly mismatch: number;
	readonly outgoing: number;
	readonly outgoingMessages: readonly RelayMessageObservation[];
	readonly realmId: string;
}

interface IndexDump {
	readonly keyPath: string | readonly string[] | null;
	readonly multiEntry: boolean;
	readonly name: string;
	readonly unique: boolean;
}

interface StoreDump {
	readonly autoIncrement: boolean;
	readonly indexes: readonly IndexDump[];
	readonly keyPath: string | readonly string[] | null;
	readonly name: string;
	readonly rows: readonly unknown[];
}

interface DatabaseDump {
	readonly name: string;
	readonly stores: readonly StoreDump[];
	readonly version: number;
}

interface SuccessorCarrier {
	readonly authority: PlainRecord;
	readonly databases: readonly DatabaseDump[];
	readonly snapshotDeclaration: PlainRecord;
}

interface ProductApi {
	activateMigration(receipt: unknown): Promise<unknown>;
	adoptSuccessor?(): Promise<void>;
	close(): Promise<void>;
	create(input: unknown): Promise<string>;
	join(input: unknown): Promise<void>;
	rehearseMigration(): Promise<unknown>;
	sealEpoch(): Promise<PlainRecord>;
	send(text: string): Promise<void>;
	snapshot(): PlainRecord;
}

interface LifetimeInstrumentationSnapshot {
	readonly activationCount: number;
	readonly commitCount: number;
	readonly postActivationPauseCount: number;
	readonly postPredecessorDeactivationPauseCount: number;
	readonly predecessorDeactivateCount: number;
	readonly replacementDeactivateCount: number;
	readonly replacementDeactivateCompletedCount: number;
	readonly verificationCount: number;
}

interface TransitionInstrumentationSnapshot extends LifetimeInstrumentationSnapshot {
	readonly acceptedVertexFailureCount: number;
	readonly independentVerificationCount: number;
	readonly issueThrowCount: number;
	readonly migrationRecordIssueCount: number;
	readonly nestedPredecessorDeactivateCount: number;
	readonly terminalTransitionCount: number;
}

interface LifetimeInstrumentation {
	acceptedVertex(): Promise<void>;
	cleanupReplacements(): Promise<void>;
	d110cColdReopenCount(): number;
	d110c0c1cSetFault(fault: string | null): void;
	d110c0c1SetPhase(phase: string | null): void;
	d110c0c1TraceSnapshot(): readonly PlainRecord[];
	projectionBaseObservations(): readonly PlainRecord[];
	d110c0cRecoverySnapshot(): Readonly<{
		readonly callCount: number;
		readonly resultKind: string | null;
		readonly swapHeadCount: number;
	}>;
	d110cBSnapshot(): Readonly<{
		readonly activationCount: number;
		readonly closeBindCount: number;
		readonly closeBindFailureCount: number;
		readonly predecessorDeactivateCount: number;
	}>;
	configure(
		input: Readonly<{
			readonly failBeforePublication?: boolean;
			readonly injectActivationFailure?: boolean;
			readonly mutateStagedDescriptor?: boolean;
			readonly pauseAcceptedVertexFailure?: boolean;
			readonly pauseAfterActivation?: boolean;
			readonly pauseActivationFailure?: boolean;
			readonly pauseAfterPredecessorDeactivation?: boolean;
			readonly pauseMigrationRecord?: boolean;
			readonly pauseRedirectRecovery?: boolean;
			readonly pauseTerminalTransition?: boolean;
			readonly pauseVerification?: boolean;
			readonly rejectPredecessorDeactivate?: boolean;
			readonly rejectCloseBind?: boolean;
			readonly rejectReplacementDeactivate?: boolean;
			readonly retainTarget?: boolean;
			readonly throwIssueLocal?: boolean;
		}>
	): void;
	releaseAcceptedVertexFailure(): void;
	releaseActivationFailure(): void;
	releaseMigrationRecord(): void;
	releaseRedirectRecovery(): void;
	releasePostActivation(): void;
	releasePostPredecessorDeactivation(): void;
	releaseTerminalTransition(): void;
	releaseVerification(): void;
	snapshot(): LifetimeInstrumentationSnapshot;
	transitionSnapshot(): TransitionInstrumentationSnapshot;
	d108e5Snapshot(): Readonly<{
		readonly redirectRecoveryCount: number;
		readonly verificationCount: number;
	}>;
}

interface ObservedSettlement {
	readonly aggregate?: readonly string[];
	readonly detail?: string;
	readonly lifetime?: LifetimeInstrumentationSnapshot;
	readonly order?: number;
	readonly status: "fulfilled" | "rejected";
}

declare global {
	interface Window {
		__phase6aProductRelayPost?(packet: RelayPacket): Promise<void>;
		phase6aCreatorSuccessorProduct: Readonly<{
			adoptSuccessor(): Promise<void>;
			beginAdoption(): void;
			beginActivation(): void;
			beginClose(): void;
			beginOverlappingRehearsal(): void;
			beginRehearsal(): void;
			beginSend(text: string): void;
			boot(realmId: string): Promise<void>;
			close(): Promise<void>;
			cleanupLifetimeReplacements(): Promise<void>;
			configureLifetime(
				input: Readonly<{
					readonly failBeforePublication?: boolean;
					readonly injectActivationFailure?: boolean;
					readonly mutateStagedDescriptor?: boolean;
					readonly pauseAcceptedVertexFailure?: boolean;
					readonly pauseAfterActivation?: boolean;
					readonly pauseActivationFailure?: boolean;
					readonly pauseAfterPredecessorDeactivation?: boolean;
					readonly pauseMigrationRecord?: boolean;
					readonly pauseRedirectRecovery?: boolean;
					readonly pauseTerminalTransition?: boolean;
					readonly pauseVerification?: boolean;
					readonly rejectCloseBind?: boolean;
					readonly rejectPredecessorDeactivate?: boolean;
					readonly rejectReplacementDeactivate?: boolean;
					readonly retainTarget?: boolean;
					readonly throwIssueLocal?: boolean;
				}>
			): void;
			concurrentAdoption(): Promise<readonly [ObservedSettlement, ObservedSettlement]>;
			beginDirectAdoption(name: string): void;
			beginD108e5DirectOperation(name: string, observation: string, kind: "activation" | "rehearsal"): void;
			beginDirectClose(name: string): void;
			beginDirectRehearsal(name: string): void;
			beginDirectSend(name: string, text: string): void;
			closeDirectCreator(name: string): Promise<void>;
			create(input: unknown): Promise<string>;
			deleteDatabases(prefix: string): Promise<readonly string[]>;
			d110c0c1Differential(name: string): Promise<PlainRecord>;
			d110c0c1eSameAuthorControl(name: string): Promise<PlainRecord>;
			d110c0c1cControl(name: string): Promise<PlainRecord>;
			d110c0c1gGridControl(): PlainRecord;
			d110c0c1cMatrix(name: string): Promise<PlainRecord>;
			d110c0cRecover(name: string): Promise<PlainRecord>;
			d110c0cStage(name: string, ordering: "new-ahe" | "old-ahe"): Promise<PlainRecord>;
			d110cBSnapshot(): Readonly<{
				readonly activationCount: number;
				readonly closeBindCount: number;
				readonly closeBindFailureCount: number;
				readonly predecessorDeactivateCount: number;
			}>;
			d110cFloorMatrix(): Promise<PlainRecord>;
			directAdoptionSettled(name: string): boolean;
			directCreatorState(name: string): PlainRecord;
			d108e5OperationSettled(observation: string): boolean;
			d108e5Snapshot(): Readonly<{ readonly redirectRecoveryCount: number; readonly verificationCount: number }>;
			deliver(packet: RelayPacket): void;
			exportSuccessor(databaseName: string): Promise<SuccessorCarrier>;
			rawAuthorityAtEpoch(databaseName: string, expectedEpoch: number): Promise<PlainRecord>;
			importSuccessor(carrier: SuccessorCarrier, sourceDatabaseName: string, targetDatabaseName: string): Promise<void>;
			join(input: unknown): Promise<void>;
			lifetimeSnapshot(): LifetimeInstrumentationSnapshot &
				Readonly<{ readonly adoptionSettled: boolean; readonly closeSettled: boolean }>;
			openDirectCreator(name: string): Promise<void>;
			relayAudit(): RelayAudit;
			prepareRehearsal(): Promise<void>;
			prepareDirectRehearsal(name: string): Promise<void>;
			migrationBoundObservations(name: string): Promise<Readonly<Record<string, unknown>>>;
			releaseAcceptedVertexFailure(): void;
			releaseActivationFailure(): void;
			releaseMigrationRecord(): void;
			releaseRedirectRecovery(): void;
			releasePostActivation(): void;
			releasePostPredecessorDeactivation(): void;
			releaseTerminalTransition(): void;
			releaseVerification(): void;
			sealEpoch(): Promise<PlainRecord>;
			sealDirectCreator(name: string): Promise<void>;
			send(text: string): Promise<void>;
			snapshot(): PlainRecord;
			transitionSnapshot(): TransitionInstrumentationSnapshot &
				Readonly<{
					readonly activationSettled: boolean;
					readonly adoptionSettled: boolean;
					readonly closeSettled: boolean;
					readonly rehearsalSettled: boolean;
					readonly sendSettled: boolean;
				}>;
			waitForAdoption(): Promise<ObservedSettlement>;
			waitForActivation(): Promise<ObservedSettlement>;
			waitForClose(): Promise<ObservedSettlement>;
			waitForDirectAdoption(name: string): Promise<ObservedSettlement>;
			waitForD108e5DirectOperation(observation: string): Promise<ObservedSettlement>;
			waitForDirectClose(name: string): Promise<ObservedSettlement>;
			waitForDirectRehearsal(name: string): Promise<ObservedSettlement>;
			waitForOverlappingRehearsal(): Promise<ObservedSettlement>;
			waitForRehearsal(): Promise<ObservedSettlement>;
			waitForSend(): Promise<ObservedSettlement>;
		}>;
	}
}

const relayChannels = new Map<string, Set<ProductBroadcastChannel>>();
const incomingMessages: RelayMessageObservation[] = [];
const outgoingMessages: RelayMessageObservation[] = [];
let relayIncoming = 0;
let relayMismatch = 0;
let relayOutgoing = 0;
let relaySequence = 0;
let realmId = "";
let booted = false;
let adoptionSettled = false;
let activationSettled = false;
let closeSettled = false;
let rehearsalSettled = false;
let sendSettled = false;
let settlementSequence = 0;
let pendingAdoption: Promise<ObservedSettlement> | undefined;
let pendingActivation: Promise<ObservedSettlement> | undefined;
let pendingClose: Promise<ObservedSettlement> | undefined;
let pendingOverlappingRehearsal: Promise<ObservedSettlement> | undefined;
let pendingRehearsal: Promise<ObservedSettlement> | undefined;
let pendingSend: Promise<ObservedSettlement> | undefined;
let migrationReceipt: unknown;
const directRooms = new Map<string, DirectRoomSession>();
const directCreatorInvites = new Map<string, unknown>();
const directRoomHeadControls = new Map<string, DirectRoomHeadControl>();
const d108e5OperationSettlements = new Map<string, boolean>();
const pendingD108e5Operations = new Map<string, Promise<ObservedSettlement>>();
const pendingDirectAdoptions = new Map<string, Promise<ObservedSettlement>>();
const pendingDirectCloses = new Map<string, Promise<ObservedSettlement>>();
const pendingDirectRehearsals = new Map<string, Promise<ObservedSettlement>>();
const directAdoptionSettlements = new Map<string, boolean>();
const directRehearsalInputs = new Map<string, Readonly<Record<string, unknown>>>();
const directMigrationReceipts = new Map<string, Readonly<Record<string, unknown>>>();

function instrumentation(): LifetimeInstrumentation {
	const selected = Reflect.get(globalThis, "__d108e2bLifetimeInstrumentation");
	if (selected === null || typeof selected !== "object") {
		throw new TypeError("D.108e2b lifetime instrumentation is unavailable");
	}
	return selected as LifetimeInstrumentation;
}

function observe(task: Promise<void>, settled: () => void, capture = false): Promise<ObservedSettlement> {
	const extras = (): Readonly<{
		readonly lifetime?: LifetimeInstrumentationSnapshot;
		readonly order?: number;
	}> => {
		if (!capture) return Object.freeze({});
		settlementSequence += 1;
		return Object.freeze({ lifetime: instrumentation().snapshot(), order: settlementSequence });
	};
	return task.then(
		() => {
			settled();
			return Object.freeze({ ...extras(), status: "fulfilled" as const });
		},
		(error: unknown) => {
			settled();
			const aggregate =
				error instanceof AggregateError
					? Object.freeze(
							error.errors.map((entry: unknown) => (entry instanceof Error ? entry.message : String(entry)))
						)
					: undefined;
			return Object.freeze({
				...(aggregate === undefined ? {} : { aggregate }),
				detail: error instanceof Error ? error.message : String(error),
				...extras(),
				status: "rejected" as const,
			});
		}
	);
}

function normalize(value: unknown): unknown {
	if (value instanceof Uint8Array) {
		return { bytes: Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("") };
	}
	if (Array.isArray(value)) return value.map(normalize);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, normalize(entry)])
		);
	}
	return value;
}

function fingerprint(value: unknown): string {
	return JSON.stringify(normalize(value));
}

function observeRelayMessage(
	value: unknown,
	sourceRealmId: string,
	sequence: number,
	receiverRealmId?: string
): RelayMessageObservation | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const message = Reflect.get(value, "message") as unknown;
	if (message === null || typeof message !== "object" || Array.isArray(message)) return undefined;
	const data = Reflect.get(message, "data") as unknown;
	const objectId = Reflect.get(message, "objectId") as unknown;
	const sender = Reflect.get(message, "sender") as unknown;
	const type = Reflect.get(message, "type") as unknown;
	if (
		!(data instanceof Uint8Array) ||
		data.byteLength === 0 ||
		typeof objectId !== "string" ||
		typeof sender !== "string" ||
		typeof type !== "number"
	) {
		return undefined;
	}
	return Object.freeze({
		data: Uint8Array.from(data),
		objectId,
		...(receiverRealmId === undefined ? {} : { receiverRealmId }),
		sender,
		sequence,
		sourceRealmId,
		type,
	});
}

class ProductBroadcastChannel extends EventTarget {
	readonly name: string;
	onmessage: ((this: BroadcastChannel, event: MessageEvent) => unknown) | null = null;

	constructor(name: string) {
		super();
		this.name = String(name);
		const selected = relayChannels.get(this.name) ?? new Set<ProductBroadcastChannel>();
		selected.add(this);
		relayChannels.set(this.name, selected);
	}

	close(): void {
		relayChannels.get(this.name)?.delete(this);
	}

	postMessage(value: unknown): void {
		relaySequence += 1;
		const packet = Object.freeze({
			channelName: this.name,
			fingerprint: fingerprint(value),
			realmId,
			sequence: relaySequence,
			value,
		});
		const observation = observeRelayMessage(value, realmId, packet.sequence);
		if (observation !== undefined) {
			relayOutgoing += 1;
			outgoingMessages.push(observation);
		}
		void window.__phase6aProductRelayPost?.(packet);
	}

	deliver(packet: RelayPacket): void {
		if (fingerprint(packet.value) !== packet.fingerprint) relayMismatch += 1;
		const event = new MessageEvent("message", { data: packet.value });
		const observation = observeRelayMessage(event.data, packet.realmId, packet.sequence, realmId);
		if (observation !== undefined) {
			relayIncoming += 1;
			incomingMessages.push(observation);
		}
		this.dispatchEvent(event);
		this.onmessage?.call(this as unknown as BroadcastChannel, event);
	}
}

function request<Result>(selected: IDBRequest<Result>): Promise<Result> {
	return new Promise((resolvePromise, reject) => {
		selected.addEventListener("success", () => resolvePromise(selected.result), { once: true });
		selected.addEventListener("error", () => reject(selected.error ?? new Error("indexeddb request failed")), {
			once: true,
		});
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		transaction.addEventListener("complete", () => resolvePromise(), { once: true });
		transaction.addEventListener(
			"abort",
			() => reject(transaction.error ?? new Error("indexeddb transaction aborted")),
			{
				once: true,
			}
		);
		transaction.addEventListener(
			"error",
			() => reject(transaction.error ?? new Error("indexeddb transaction failed")),
			{
				once: true,
			}
		);
	});
}

function mutableKeyPath(value: string | readonly string[] | null): string | string[] | null {
	return typeof value === "string" || value === null ? value : [...value];
}

function openExistingDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolvePromise, reject) => {
		const selected = indexedDB.open(name);
		selected.addEventListener("success", () => resolvePromise(selected.result), { once: true });
		selected.addEventListener("error", () => reject(selected.error ?? new Error("indexeddb open failed")), {
			once: true,
		});
	});
}

async function dumpDatabase(name: string): Promise<DatabaseDump> {
	const database = await openExistingDatabase(name);
	try {
		const names = [...database.objectStoreNames];
		const transaction = database.transaction(names, "readonly");
		const stores = await Promise.all(
			names.map(async (storeName): Promise<StoreDump> => {
				const store = transaction.objectStore(storeName);
				return Object.freeze({
					autoIncrement: store.autoIncrement,
					indexes: Object.freeze(
						[...store.indexNames].map((indexName) => {
							const index = store.index(indexName);
							return Object.freeze({
								keyPath: index.keyPath,
								multiEntry: index.multiEntry,
								name: index.name,
								unique: index.unique,
							});
						})
					),
					keyPath: store.keyPath,
					name: store.name,
					rows: Object.freeze(await request(store.getAll())),
				});
			})
		);
		await transactionDone(transaction);
		return Object.freeze({ name, stores: Object.freeze(stores), version: database.version });
	} finally {
		database.close();
	}
}

async function portableJournalDump(databaseName: string): Promise<DatabaseDump> {
	const [journal, issuance] = await Promise.all([
		dumpDatabase(`${databaseName}--drp-live-journal-v1`),
		dumpDatabase(`${databaseName}--drp-issuance-v1`),
	]);
	const issuedRows = issuance.stores.find(({ name }) => name === "issuedRecords")?.rows.map(exactRecord) ?? [];
	return Object.freeze({
		...journal,
		stores: Object.freeze(
			journal.stores.map((store) =>
				store.name !== "acceptedEntries"
					? store
					: Object.freeze({
							...store,
							rows: Object.freeze(
								store.rows.map((value) => {
									const row = exactRecord(value);
									if (row.sourceKind !== "local-issued") return row;
									const issued = issuedRows.find(
										(candidate) =>
											candidate.objectId === row.objectId &&
											candidate.author === row.localAuthor &&
											candidate.authorSequence === row.localAuthorSequence &&
											hex(candidate.digest as Uint8Array) === row.vertexDigest
									);
									if (issued === undefined) throw new TypeError("D.108d2 journal carrier is unavailable");
									return Object.freeze({
										anchorDigest: row.anchorDigest,
										detachedSignature: issued.signature,
										epoch: row.epoch,
										exactCanonicalPreimageBytes: issued.canonicalPreimageBytes,
										journalSequence: row.journalSequence,
										objectId: row.objectId,
										sourceKind: "received",
										vertexDigest: row.vertexDigest,
									});
								})
							),
						})
			)
		),
	});
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const selected = indexedDB.deleteDatabase(name);
		selected.addEventListener("success", () => resolvePromise(), { once: true });
		selected.addEventListener("blocked", () => reject(new Error(`indexeddb delete blocked: ${name}`)), { once: true });
		selected.addEventListener("error", () => reject(selected.error ?? new Error("indexeddb delete failed")), {
			once: true,
		});
	});
}

async function restoreDatabase(dump: DatabaseDump, targetName: string): Promise<void> {
	await deleteDatabase(targetName);
	const database = await new Promise<IDBDatabase>((resolvePromise, reject) => {
		const selected = indexedDB.open(targetName, dump.version);
		selected.addEventListener(
			"upgradeneeded",
			() => {
				for (const source of dump.stores) {
					const keyPath = mutableKeyPath(source.keyPath);
					const store = selected.result.createObjectStore(source.name, {
						autoIncrement: source.autoIncrement,
						...(keyPath === null ? {} : { keyPath }),
					});
					for (const index of source.indexes) {
						const indexKeyPath = mutableKeyPath(index.keyPath);
						if (indexKeyPath === null) throw new TypeError("D.108d2 null index keyPath");
						store.createIndex(index.name, indexKeyPath, {
							multiEntry: index.multiEntry,
							unique: index.unique,
						});
					}
				}
			},
			{ once: true }
		);
		selected.addEventListener("success", () => resolvePromise(selected.result), { once: true });
		selected.addEventListener("error", () => reject(selected.error ?? new Error("indexeddb restore open failed")), {
			once: true,
		});
	});
	try {
		const transaction = database.transaction(
			dump.stores.map(({ name }) => name),
			"readwrite",
			{ durability: "strict" }
		);
		for (const source of dump.stores) {
			const store = transaction.objectStore(source.name);
			for (const row of source.rows) store.add(row);
		}
		await transactionDone(transaction);
	} finally {
		database.close();
	}
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactRecord(value: unknown): PlainRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("D.108d2 record invalid");
	return value as PlainRecord;
}

async function rawAuthorityAtEpoch(databaseName: string, expectedEpoch: number): Promise<PlainRecord> {
	if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) {
		throw new TypeError("D110C_B_EXPECTED_EPOCH_INVALID");
	}
	const database = await openExistingDatabase(`${databaseName}--ahe`);
	try {
		const transaction = database.transaction(["blobs", "generations", "objects"], "readonly");
		const [objects, generations, blobs] = await Promise.all([
			request(transaction.objectStore("objects").getAll()),
			request(transaction.objectStore("generations").getAll()),
			request(transaction.objectStore("blobs").getAll()),
		]);
		await transactionDone(transaction);
		if (objects.length !== 1) throw new TypeError("D.108d2 active object is ambiguous");
		const objectRow = exactRecord(objects[0]);
		const headEnvelope = exactRecord(decodeCanonical(objectRow.record as Uint8Array));
		if (headEnvelope.kind !== "head" || headEnvelope.storageSchemaVersion !== 1) {
			throw new TypeError("D.108d2 active head envelope is invalid");
		}
		const head = exactRecord(headEnvelope.body);
		const generationRow = generations
			.map(exactRecord)
			.find((row) => row.objectId === objectRow.objectId && row.generationId === head.generationId);
		if (generationRow === undefined) throw new TypeError("D.108d2 active generation is absent");
		const generationEnvelope = exactRecord(decodeCanonical(generationRow.record as Uint8Array));
		if (generationEnvelope.kind !== "generation" || generationEnvelope.storageSchemaVersion !== 1) {
			throw new TypeError("D.108d2 active generation envelope is invalid");
		}
		const generation = exactRecord(generationEnvelope.body);
		const closure = generation.closure as readonly PlainRecord[];
		const decoded = closure.map((reference) => {
			const row = blobs.map(exactRecord).find((candidate) => candidate.digest === reference.digest);
			if (row === undefined) throw new TypeError("D.108d2 closure blob is absent");
			const bytes = row.bytes as Uint8Array;
			if (hex(hashDomain("ts-drp-storage/blob/v1", bytes)) !== reference.digest) {
				throw new TypeError("D.108d2 closure blob digest differs");
			}
			return exactRecord(decodeCanonical(bytes));
		});
		const projections = decoded.filter((value) => value.kind === "v3-live-generation-2");
		const trusts = decoded.filter(
			(value) => value.kind === "drp-anchor-trust-state" && value.currentEpoch === expectedEpoch
		);
		if (projections.length !== 1 || trusts.length !== 1) {
			throw new TypeError("D.108d2 successor projection is ambiguous");
		}
		const projection = projections[0] as PlainRecord;
		const trust = trusts[0] as PlainRecord;
		const anchorBytes = trust.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array;
		const anchor = exactRecord(decodeCanonical(anchorBytes));
		const anchorDigest = hex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
		if (
			anchorDigest !== trust.currentAnchorDigest ||
			anchorDigest !== projection.anchorDigest ||
			anchor.aclDigest !== projection.aclDigest ||
			anchor.objectId !== projection.objectId
		) {
			throw new TypeError("D.108d2 raw authority differs");
		}
		return Object.freeze({
			aclDigest: anchor.aclDigest,
			anchorDigest,
			epoch: expectedEpoch,
			genesisAnchorDigest: trust.genesisAnchorDigest,
			lifecycle: "active",
			objectId: trust.objectId,
			profileId: "creator-trusted-v1",
		});
	} finally {
		database.close();
	}
}

function rawAuthority(databaseName: string): Promise<PlainRecord> {
	return rawAuthorityAtEpoch(databaseName, 1);
}

async function rawSnapshotDeclaration(databaseName: string): Promise<PlainRecord> {
	return rawSnapshotDeclarationAtEpoch(databaseName);
}

async function rawSnapshotDeclarationAtEpoch(databaseName: string, expectedEpoch?: number): Promise<PlainRecord> {
	const database = await openExistingDatabase(`${databaseName}--drp-snapshot-quarantine-v1`);
	try {
		const transaction = database.transaction(["chunks", "scopes"], "readonly");
		const [scopeRows, chunkRows] = await Promise.all([
			request(transaction.objectStore("scopes").getAll()),
			request(transaction.objectStore("chunks").getAll()),
		]);
		await transactionDone(transaction);
		const scopes = scopeRows
			.map(exactRecord)
			.filter((scope) => scope.state === "verified" && (expectedEpoch === undefined || scope.epoch === expectedEpoch));
		if (scopes.length !== 1) throw new TypeError("D.108d2 snapshot scope is ambiguous");
		const scope = scopes[0] as PlainRecord;
		const chunks = chunkRows
			.map(exactRecord)
			.filter(
				(row) =>
					row.objectId === scope.objectId &&
					row.epoch === scope.epoch &&
					row.anchor === scope.anchor &&
					row.manifestDigest === scope.manifestDigest
			)
			.sort((left, right) => Number(left.index) - Number(right.index));
		if (chunks.length !== scope.chunkCount) throw new TypeError("D.108d2 snapshot chunks are incomplete");
		return Object.freeze({
			chunks: Object.freeze(
				chunks.map((row) => Object.freeze({ byteLength: row.byteLength, digest: row.digest, index: row.index }))
			),
			exactCanonicalManifestBytes: new Uint8Array(scope.exactCanonicalManifestBytes as Uint8Array),
			scope: Object.freeze({
				anchor: scope.anchor,
				epoch: scope.epoch,
				manifestDigest: scope.manifestDigest,
				objectId: scope.objectId,
			}),
			totalBytes: scope.totalBytes,
		});
	} finally {
		database.close();
	}
}

const DIRECT_PARAMETERS = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

function bytesFromHex(value: string): Uint8Array {
	if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
		throw new TypeError("D.108e3 direct-room author is invalid");
	}
	return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

async function localAuthorSeed(configuredSeed: string): Promise<Uint8Array> {
	const encodedSeed = new TextEncoder().encode(configuredSeed);
	const seed = new Uint8Array(await crypto.subtle.digest("SHA-512", encodedSeed));
	const domain = new TextEncoder().encode("ts-drp-keychain/local-author-ed25519/v1");
	const preimage = new Uint8Array(domain.byteLength + 1 + seed.byteLength);
	preimage.set(domain, 0);
	preimage[domain.byteLength] = 0;
	preimage.set(seed, domain.byteLength + 1);
	return new Uint8Array(await crypto.subtle.digest("SHA-256", preimage));
}

function directTransport(peerId: string): unknown {
	const topics = new Set<string>();
	const node = {
		broadcastMessage: (): Promise<void> => Promise.resolve(),
		changeTopicScoreParams: (): void => undefined,
		connect: (): Promise<void> => Promise.resolve(),
		connectToBootstraps: (): Promise<void> => Promise.resolve(),
		disconnect: (): Promise<void> => Promise.resolve(),
		getAllPeers: (): string[] => [],
		getBootstrapNodes: (): [] => [],
		getGroupPeers: (): [] => [],
		getMultiaddrs: (): [] => [],
		getPeerMultiaddrs: (): Promise<[]> => Promise.resolve([]),
		getSubscribedTopics: (): string[] => [...topics],
		gossipTopicFor: (): undefined => undefined,
		isDialable: (): Promise<boolean> => Promise.resolve(true),
		membershipVerifier: undefined,
		peerId,
		publishMessage: (): Promise<true> => Promise.resolve(true),
		removeTopicScoreParams: (): void => undefined,
		restart: (): Promise<void> => Promise.resolve(),
		sendGroupMessageRandomPeer: (): Promise<void> => Promise.resolve(),
		sendMessage: (): Promise<void> => Promise.resolve(),
		start: (): Promise<void> => Promise.resolve(),
		stop: (): Promise<void> => Promise.resolve(),
		subscribe: (topic: string): void => {
			topics.add(topic);
		},
		subscribeToMessageQueue: (): void => undefined,
		unsubscribe: (topic: string): void => {
			topics.delete(topic);
		},
	};
	return Object.freeze({
		close(): void {
			return undefined;
		},
		networkNode: node,
		openEphemeral(): never {
			throw new TypeError("D.108e3 direct-room ephemeral transport is unavailable");
		},
		requestRetainedHistory(): void {
			return undefined;
		},
		setIngressHandler(): void {
			return undefined;
		},
		setRetainedPublisher(): void {
			return undefined;
		},
	});
}

function directDependencies(): DirectRoomDependencies {
	const selected = Reflect.get(globalThis, "__d108e3DirectRoomDependencies");
	if (selected === null || typeof selected !== "object") {
		throw new TypeError("D.108e3 direct-room dependencies are unavailable");
	}
	return selected as DirectRoomDependencies;
}

function createDirectRoomHeadControl(fault: DirectRoomHeadFault = "none"): DirectRoomHeadControl {
	return { fault, operations: [], state: null };
}

function directRoomHeadAuthority(control: DirectRoomHeadControl, initialization: PlainRecord): PlainRecord {
	const same = (left: unknown, right: unknown): boolean => {
		const leftBytes = encodeCanonical(left);
		const rightBytes = encodeCanonical(right);
		return (
			leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index])
		);
	};
	const success = (): PlainRecord => Object.freeze({ ok: true, state: control.state });
	const selectedFailure = (operation: "begin" | "commit" | "create" | "read"): PlainRecord | undefined => {
		if (control.fault === `${operation}-conflict`) return Object.freeze({ ok: false, reason: "conflict" });
		if (control.fault === `${operation}-unavailable`) return Object.freeze({ ok: false, reason: "unavailable" });
		if (control.fault === `${operation}-malformed`) return Object.freeze({ ok: true, state: { malformed: true } });
		if (operation === "commit" && control.fault === "commit-unavailable-once") {
			control.fault = "none";
			return Object.freeze({ ok: false, reason: "unavailable" });
		}
		return undefined;
	};
	return Object.freeze({
		initialization,
		begin: (input: PlainRecord): Promise<PlainRecord> => {
			control.operations.push("begin");
			const failed = selectedFailure("begin");
			if (failed !== undefined) return Promise.resolve(failed);
			if (control.state === null || !same(control.state, input.expected)) {
				return Promise.resolve(Object.freeze({ ok: false, reason: "conflict" }));
			}
			const expected = input.expected as PlainRecord;
			control.state = Object.freeze({
				pending: Object.freeze({ next: input.next, previous: expected.stable }),
				stable: expected.stable,
			});
			return Promise.resolve(success());
		},
		commit: (input: PlainRecord): Promise<PlainRecord> => {
			control.operations.push("commit");
			const failed = selectedFailure("commit");
			if (failed !== undefined) return Promise.resolve(failed);
			if (control.state === null || control.state.pending === null || !same(control.state, input.expected)) {
				return Promise.resolve(Object.freeze({ ok: false, reason: "conflict" }));
			}
			control.state = Object.freeze({ pending: null, stable: (control.state.pending as PlainRecord).next });
			return Promise.resolve(success());
		},
		create: (input: PlainRecord): Promise<PlainRecord> => {
			control.operations.push("create");
			const failed = selectedFailure("create");
			if (failed !== undefined) return Promise.resolve(failed);
			const desired = Object.freeze({ pending: null, stable: input.stable });
			if (control.state === null) {
				control.state = desired;
				control.initialStable = input.stable as PlainRecord;
			} else if (!same(control.state, desired)) {
				return Promise.resolve(Object.freeze({ ok: false, reason: "conflict" }));
			}
			return Promise.resolve(success());
		},
		migrate: (input: PlainRecord): Promise<PlainRecord> => {
			control.operations.push("migrate");
			const desired = Object.freeze({ pending: null, stable: input.stable });
			if (control.state !== null && !same(control.state, desired)) {
				return Promise.resolve(Object.freeze({ ok: false, reason: "conflict" }));
			}
			control.state = desired;
			return Promise.resolve(success());
		},
		read: (): Promise<PlainRecord> => {
			control.operations.push("read");
			const failed = selectedFailure("read");
			return Promise.resolve(failed ?? success());
		},
	});
}

type D110cRoomHeadFault = "commit-unavailable-once" | "none";

function d110cRoomHeadDatabaseName(name: string): string {
	return `d108e3-direct-${name}--d110c-room-head-v1`;
}

function openD110cRoomHeadDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolvePromise, reject) => {
		const selected = indexedDB.open(d110cRoomHeadDatabaseName(name), 1);
		selected.addEventListener(
			"upgradeneeded",
			() => {
				const database = selected.result;
				if (!database.objectStoreNames.contains("floor")) database.createObjectStore("floor", { keyPath: "key" });
				if (!database.objectStoreNames.contains("control")) database.createObjectStore("control", { keyPath: "key" });
				if (!database.objectStoreNames.contains("events"))
					database.createObjectStore("events", { autoIncrement: true });
			},
			{ once: true }
		);
		selected.addEventListener("success", () => resolvePromise(selected.result), { once: true });
		selected.addEventListener(
			"error",
			() => reject(selected.error ?? new Error("D110C_0C room-head database open failed")),
			{ once: true }
		);
	});
}

function sameCanonical(left: unknown, right: unknown): boolean {
	const leftBytes = encodeCanonical(left);
	const rightBytes = encodeCanonical(right);
	return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function d110cRoomHeadResult(state: unknown): PlainRecord {
	return Object.freeze({ ok: true, state: state === null ? null : structuredClone(state) });
}

function d110cRoomHeadAuthority(name: string, initialization: PlainRecord): PlainRecord {
	const read = async (scope: unknown): Promise<PlainRecord> => {
		const database = await openD110cRoomHeadDatabase(name);
		try {
			const transaction = database.transaction("floor", "readonly");
			const store = transaction.objectStore("floor");
			const [scopeRow, stateRow] = await Promise.all([request(store.get("scope")), request(store.get("state"))]);
			await transactionDone(transaction);
			if (scopeRow !== undefined && !sameCanonical(exactRecord(scopeRow).value, scope)) {
				return Object.freeze({ ok: false, reason: "conflict" });
			}
			return d110cRoomHeadResult(stateRow === undefined ? null : exactRecord(stateRow).value);
		} finally {
			database.close();
		}
	};
	return Object.freeze({
		initialization,
		begin: async (input: PlainRecord): Promise<PlainRecord> => {
			const database = await openD110cRoomHeadDatabase(name);
			try {
				const transaction = database.transaction(["events", "floor"], "readwrite", { durability: "strict" });
				const floor = transaction.objectStore("floor");
				const [scopeRow, stateRow] = await Promise.all([request(floor.get("scope")), request(floor.get("state"))]);
				const state = stateRow === undefined ? null : exactRecord(stateRow).value;
				if (
					scopeRow === undefined ||
					!sameCanonical(exactRecord(scopeRow).value, input.scope) ||
					state === null ||
					!sameCanonical(state, input.expected)
				) {
					transaction.abort();
					return Object.freeze({ ok: false, reason: "conflict" });
				}
				const expected = exactRecord(input.expected);
				const desired = Object.freeze({
					pending: Object.freeze({ next: input.next, previous: expected.stable }),
					stable: expected.stable,
				});
				await Promise.all([
					request(floor.put({ key: "state", value: desired })),
					request(transaction.objectStore("events").add({ operation: "begin", state: desired })),
				]);
				await transactionDone(transaction);
				return d110cRoomHeadResult(desired);
			} finally {
				database.close();
			}
		},
		commit: async (input: PlainRecord): Promise<PlainRecord> => {
			const database = await openD110cRoomHeadDatabase(name);
			try {
				const transaction = database.transaction(["control", "events", "floor"], "readwrite", {
					durability: "strict",
				});
				const control = transaction.objectStore("control");
				const floor = transaction.objectStore("floor");
				const [faultRow, scopeRow, stateRow] = await Promise.all([
					request(control.get("fault")),
					request(floor.get("scope")),
					request(floor.get("state")),
				]);
				const fault = faultRow === undefined ? "none" : exactRecord(faultRow).value;
				if (fault === "commit-unavailable-once") {
					await Promise.all([
						request(control.put({ key: "fault", value: "none" })),
						request(transaction.objectStore("events").add({ operation: "commit-fault" })),
					]);
					await transactionDone(transaction);
					return Object.freeze({ ok: false, reason: "unavailable" });
				}
				const state = stateRow === undefined ? null : exactRecord(stateRow).value;
				const captured = state === null ? undefined : exactRecord(state);
				if (
					scopeRow === undefined ||
					!sameCanonical(exactRecord(scopeRow).value, input.scope) ||
					captured === undefined ||
					captured.pending === null ||
					!sameCanonical(captured, input.expected)
				) {
					transaction.abort();
					return Object.freeze({ ok: false, reason: "conflict" });
				}
				const desired = Object.freeze({ pending: null, stable: exactRecord(captured.pending).next });
				await Promise.all([
					request(floor.put({ key: "state", value: desired })),
					request(transaction.objectStore("events").add({ operation: "commit", state: desired })),
				]);
				await transactionDone(transaction);
				return d110cRoomHeadResult(desired);
			} finally {
				database.close();
			}
		},
		create: async (input: PlainRecord): Promise<PlainRecord> => {
			const database = await openD110cRoomHeadDatabase(name);
			try {
				const transaction = database.transaction(["events", "floor"], "readwrite", { durability: "strict" });
				const floor = transaction.objectStore("floor");
				const [scopeRow, stateRow] = await Promise.all([request(floor.get("scope")), request(floor.get("state"))]);
				const desired = Object.freeze({ pending: null, stable: input.stable });
				if (
					(scopeRow !== undefined && !sameCanonical(exactRecord(scopeRow).value, input.scope)) ||
					(stateRow !== undefined && !sameCanonical(exactRecord(stateRow).value, desired))
				) {
					transaction.abort();
					return Object.freeze({ ok: false, reason: "conflict" });
				}
				if (stateRow === undefined) {
					await Promise.all([
						request(floor.put({ key: "scope", value: input.scope })),
						request(floor.put({ key: "state", value: desired })),
						request(transaction.objectStore("events").add({ operation: "create", state: desired })),
					]);
				}
				await transactionDone(transaction);
				return d110cRoomHeadResult(desired);
			} finally {
				database.close();
			}
		},
		migrate: (): Promise<PlainRecord> => Promise.resolve(Object.freeze({ ok: false, reason: "conflict" })),
		read: (input: PlainRecord): Promise<PlainRecord> => read(input.scope),
	});
}

async function configureD110cRoomHeadFault(name: string, fault: D110cRoomHeadFault): Promise<void> {
	const database = await openD110cRoomHeadDatabase(name);
	try {
		const transaction = database.transaction("control", "readwrite", { durability: "strict" });
		await request(transaction.objectStore("control").put({ key: "fault", value: fault }));
		await transactionDone(transaction);
	} finally {
		database.close();
	}
}

async function d110cRoomHeadEvidence(name: string): Promise<PlainRecord> {
	const database = await openD110cRoomHeadDatabase(name);
	try {
		const transaction = database.transaction(["control", "events", "floor"], "readonly");
		const [faultRow, events, scopeRow, stateRow] = await Promise.all([
			request(transaction.objectStore("control").get("fault")),
			request(transaction.objectStore("events").getAll()),
			request(transaction.objectStore("floor").get("scope")),
			request(transaction.objectStore("floor").get("state")),
		]);
		await transactionDone(transaction);
		const state = stateRow === undefined ? null : exactRecord(stateRow).value;
		const canonicalStateBytes = encodeCanonical(state);
		return Object.freeze({
			canonicalStateHex: hex(canonicalStateBytes),
			events: Object.freeze(events.map((event) => normalize(exactRecord(event)))),
			fault: faultRow === undefined ? "none" : exactRecord(faultRow).value,
			scope: scopeRow === undefined ? null : normalize(exactRecord(scopeRow).value),
			state: normalize(state),
			stateDigest: hex(hashDomain("ts-drp/d110c-0c-room-head-state/v1", canonicalStateBytes)),
		});
	} finally {
		database.close();
	}
}

async function overwriteD110cStableRoomHead(name: string, stable: PlainRecord): Promise<void> {
	const database = await openD110cRoomHeadDatabase(name);
	try {
		const transaction = database.transaction("floor", "readwrite", { durability: "strict" });
		await request(
			transaction.objectStore("floor").put({ key: "state", value: Object.freeze({ pending: null, stable }) })
		);
		await transactionDone(transaction);
	} finally {
		database.close();
	}
}

async function d110cAheEvidence(databaseName: string): Promise<PlainRecord> {
	const database = await openExistingDatabase(`${databaseName}--ahe`);
	try {
		const transaction = database.transaction(["blobs", "generations", "objects"], "readonly");
		const [blobRows, generationRows, objectRows] = await Promise.all([
			request(transaction.objectStore("blobs").getAll()),
			request(transaction.objectStore("generations").getAll()),
			request(transaction.objectStore("objects").getAll()),
		]);
		await transactionDone(transaction);
		if (objectRows.length !== 1) throw new TypeError("D110C_0C AHE object inventory is ambiguous");
		const objectRow = exactRecord(objectRows[0]);
		const headEnvelope = exactRecord(decodeCanonical(objectRow.record as Uint8Array));
		const head = exactRecord(headEnvelope.body);
		const blobs = blobRows.map(exactRecord);
		const generations = generationRows
			.map(exactRecord)
			.map((row) => {
				const envelope = exactRecord(decodeCanonical(row.record as Uint8Array));
				const generation = exactRecord(envelope.body);
				const closure = (generation.closure as readonly PlainRecord[]).map((reference) => {
					const blob = blobs.find((candidate) => candidate.digest === reference.digest);
					if (blob === undefined) throw new TypeError("D110C_0C AHE closure blob is absent");
					const bytes = blob.bytes as Uint8Array;
					if (hex(hashDomain("ts-drp-storage/blob/v1", bytes)) !== reference.digest) {
						throw new TypeError("D110C_0C AHE closure blob digest differs");
					}
					const record = exactRecord(decodeCanonical(bytes));
					return Object.freeze({
						anchorDigest: record.anchorDigest,
						currentAnchorDigest: record.currentAnchorDigest,
						currentEpoch: record.currentEpoch,
						digest: reference.digest,
						epoch: record.epoch,
						kind: record.kind,
						objectId: record.objectId,
					});
				});
				return Object.freeze({
					baseExpectedHead: normalize(generation.baseExpectedHead),
					closure: Object.freeze(closure.map(normalize)),
					closureDigest: generation.closureDigest,
					generationId: generation.generationId,
					state: generation.state,
				});
			})
			.sort((left, right) => String(left.generationId).localeCompare(String(right.generationId)));
		return Object.freeze({
			activeHead: normalize(head),
			generations: Object.freeze(generations),
			objectId: objectRow.objectId,
		});
	} finally {
		database.close();
	}
}

async function createDirectRoom(name: string, options: DirectRoomOpenOptions = {}): Promise<DirectRoomSession> {
	if (name.length === 0 || directRooms.has(name)) throw new TypeError("D.108e3 direct room identity is invalid");
	const databaseName = `d108e3-direct-${name}`;
	const objectDigest = hex(hashDomain("ts-drp/d108e3-direct-room/v1", new TextEncoder().encode(databaseName))).slice(
		0,
		32
	);
	const objectId = `creator:${objectDigest}`;
	const dependencies = directDependencies();
	const authorKeychain = new dependencies.Keychain({ private_key_seed: `d108e3-direct-author-${name}` });
	await authorKeychain.start();
	const finalitySeed = `d108e3-direct-finality-${name}`;
	const finalityKeychain = new dependencies.Keychain({ private_key_seed: finalitySeed });
	await finalityKeychain.start();
	const finality = await dependencies.createRecoverableFinalitySigner({ seed: await localAuthorSeed(finalitySeed) });
	if (hex(finality.publicKey) !== finalityKeychain.localAuthorId) {
		throw new TypeError("D.108e3 direct-room finality identity differs");
	}
	const application = dependencies.createV3ChatApplication("alice");
	const blueprintDigest = application.catalog.blueprintDigests[0];
	if (blueprintDigest === undefined) throw new TypeError("D.108e3 direct-room blueprint is absent");
	const signerSet = Object.freeze([Object.freeze({ publicKey: finalityKeychain.localAuthorId, signerId: "creator" })]);
	const createInvite = (selectedObjectId: string): Promise<unknown> =>
		dependencies.createV3RoomCreatorInviteMaterial({
			blueprintDigest,
			exactCanonicalApplicationStateBytes: encodeCanonical([]),
			exactCanonicalLatchedAclBytes: encodeCanonical({
				epoch: 0,
				kind: "drp-v3-latched-acl",
				members: [
					{
						author: authorKeychain.localAuthorId,
						finalityKey: authorKeychain.localAuthorId,
						groups: ["admin", "finality", "writer"],
					},
				],
				objectId: selectedObjectId,
				permissionless: false,
				version: 1,
			}),
			exactCanonicalParametersCarrierBytes: encodeCanonical(DIRECT_PARAMETERS),
			exactCanonicalProfileBytes: encodeCanonical({
				cryptoSuiteId: "ed25519-sha256-v3",
				profileId: "creator-trusted-v1",
				quorum: 1,
				signers: signerSet,
			}),
			exactCanonicalSignerSetBytes: encodeCanonical(signerSet),
			objectId: selectedObjectId,
			signGenesisAnchorDigest: (anchorDigest: Uint8Array) => finalityKeychain.signWithLocalAuthor(anchorDigest),
		});
	let creatorInvite = directCreatorInvites.get(name);
	if (creatorInvite === undefined) {
		creatorInvite = await createInvite(objectId);
		directCreatorInvites.set(name, creatorInvite);
	}
	const rehearsalNonce = hashDomain("ts-drp/d108e3-direct-rehearsal/v1", new TextEncoder().encode(name));
	const separator = objectId.indexOf(":");
	const targetIdentity = hashDomain(
		"ts-drp/v3-room-migration-target-object/v1",
		encodeCanonical({ rehearsalNonce, sourceObjectId: objectId })
	);
	const targetObjectId = `${objectId.slice(0, separator)}:${hex(targetIdentity.subarray(0, 16))}`;
	directRehearsalInputs.set(
		name,
		Object.freeze({ rehearsalNonce, targetCreatorInvite: await createInvite(targetObjectId) })
	);
	const control =
		options.roomHeadAuthority === undefined ? (options.control ?? createDirectRoomHeadControl()) : undefined;
	if (control !== undefined) directRoomHeadControls.set(name, control);
	const roomHeadAuthority =
		options.roomHeadAuthority ??
		directRoomHeadAuthority(
			control as DirectRoomHeadControl,
			options.initialization ?? Object.freeze({ kind: "create" })
		);
	return dependencies.createV3RoomSession({
		application,
		author: authorKeychain.localAuthorId,
		...(options.withCreatorSigner === false ? {} : { creatorFinalitySigner: finality.signer }),
		creatorInvite,
		databaseName,
		initialLogicalTime: 3,
		issuanceDatabaseName: databaseName,
		migrationDatabaseNamespace: databaseName,
		objectId,
		onAcceptedVertex: () => instrumentation().acceptedVertex(),
		onProjection: () => undefined,
		openTransport: () => {
			options.onOpenTransport?.();
			return directTransport(authorKeychain.localAuthorId);
		},
		publicKeyBytes: bytesFromHex(authorKeychain.localAuthorId),
		roomHeadAuthority,
		signRegisteredVertexDigest: (registeredDigest: Uint8Array) => authorKeychain.signWithLocalAuthor(registeredDigest),
		...(options.successorSnapshotDeclaration === undefined
			? {}
			: { successorSnapshotDeclaration: options.successorSnapshotDeclaration }),
	});
}

function creatorInviteEnvelope(material: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical({
		detachedGenesisSignature: material.detachedGenesisSignature,
		exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
		exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
		exactCanonicalParametersCarrierBytes: material.exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
		kind: "ts-drp-example-v3-room-creator-invite",
		pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
		version: 1,
	});
}

function creatorInviteAtExactSize(
	material: Readonly<Record<string, unknown>>,
	targetSize: number
): Readonly<Record<string, unknown>> {
	const selectedField = material.exactCanonicalParametersCarrierBytes;
	if (!(selectedField instanceof Uint8Array)) throw new TypeError("D.108e5 invite fixture is invalid");
	let selectedLength = selectedField.byteLength + targetSize - creatorInviteEnvelope(material).byteLength;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		if (selectedLength < 1) throw new TypeError("D.108e5 invite fixture size is invalid");
		const candidate = Object.freeze({
			...material,
			exactCanonicalParametersCarrierBytes: new Uint8Array(selectedLength),
		});
		const difference = targetSize - creatorInviteEnvelope(candidate).byteLength;
		if (difference === 0) return candidate;
		selectedLength += difference;
	}
	throw new TypeError("D.108e5 invite fixture size differs");
}

async function settlementDetail(task: Promise<unknown>): Promise<string> {
	try {
		await task;
		return "fulfilled";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function removeDirectDatabases(name: string): Promise<void> {
	const prefix = `d108e3-direct-${name}`;
	for (const { name: databaseName } of await indexedDB.databases()) {
		if (databaseName?.startsWith(prefix) === true) await deleteDatabase(databaseName);
	}
}

function directFailureDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function closeDirectForReopen(name: string): Promise<void> {
	const room = directRooms.get(name);
	directRooms.delete(name);
	if (room !== undefined) await room.close().catch(() => undefined);
	abandonDirectRoom(name);
}

function abandonDirectRoom(name: string): void {
	directRooms.delete(name);
	pendingDirectAdoptions.delete(name);
	pendingDirectCloses.delete(name);
	pendingDirectRehearsals.delete(name);
	directAdoptionSettlements.delete(name);
}

async function discardDirectRoom(name: string): Promise<void> {
	await closeDirectForReopen(name);
	directCreatorInvites.delete(name);
	directRoomHeadControls.delete(name);
	directRehearsalInputs.delete(name);
	directMigrationReceipts.delete(name);
	await removeDirectDatabases(name);
}

async function directOpenSettlement(name: string, options: DirectRoomOpenOptions): Promise<string> {
	try {
		const room = await createDirectRoom(name, options);
		directRooms.set(name, room);
		return "fulfilled";
	} catch (error) {
		return directFailureDetail(error);
	} finally {
		await discardDirectRoom(name);
	}
}

async function preparedGenesisControl(name: string): Promise<DirectRoomHeadControl> {
	const control = createDirectRoomHeadControl();
	const room = await createDirectRoom(name, { control });
	directRooms.set(name, room);
	await closeDirectForReopen(name);
	if (control.initialStable === undefined) throw new TypeError("D110C model genesis floor is unavailable");
	return control;
}

async function directAdoptionSettlement(
	name: string,
	input: Readonly<{
		readonly fault?: DirectRoomHeadFault;
		readonly mutateStagedDescriptor?: boolean;
		readonly pendingOther?: boolean;
	}>
): Promise<Readonly<{ readonly detail: string; readonly operations: readonly string[] }>> {
	const control = createDirectRoomHeadControl();
	try {
		const room = await createDirectRoom(name, { control });
		directRooms.set(name, room);
		await room.sealEpoch();
		if (input.pendingOther === true) {
			const stable = control.initialStable;
			if (stable === undefined) throw new TypeError("D110C model stable floor is unavailable");
			control.state = Object.freeze({
				pending: Object.freeze({
					next: Object.freeze({
						currentAnchorDigest: "f".repeat(64),
						epoch: 1,
						objectId: stable.objectId,
					}),
					previous: stable,
				}),
				stable,
			});
		}
		control.fault = input.fault ?? "none";
		instrumentation().configure({ mutateStagedDescriptor: input.mutateStagedDescriptor });
		return Object.freeze({
			detail: await settlementDetail(room.adoptCreatorSuccessor()),
			operations: Object.freeze([...control.operations]),
		});
	} finally {
		await discardDirectRoom(name);
	}
}

async function directPendingRecovery(
	name: string,
	ordering: "old-ahe" | "new-ahe"
): Promise<Readonly<Record<string, unknown>>> {
	const control = createDirectRoomHeadControl();
	const databaseName = `d108e3-direct-${name}`;
	let interruptedRoom: DirectRoomSession | undefined;
	try {
		const room = await createDirectRoom(name, { control });
		interruptedRoom = room;
		directRooms.set(name, room);
		await room.sealEpoch();
		instrumentation().configure({ failBeforePublication: ordering === "old-ahe" });
		if (ordering === "new-ahe") control.fault = "commit-unavailable-once";
		const interrupted = await settlementDetail(room.adoptCreatorSuccessor());
		const snapshotDeclaration = await rawSnapshotDeclaration(databaseName);
		// Model abrupt process loss: graceful close intentionally reclaims an unpublished staged generation.
		// The interrupted session becomes unreachable, while its durable browser stores remain available to the opener.
		abandonDirectRoom(name);
		instrumentation().configure({});
		let transportOpenCount = 0;
		const reopened = await createDirectRoom(name, {
			control,
			initialization: Object.freeze({ kind: "reopen" }),
			onOpenTransport: () => {
				transportOpenCount += 1;
			},
			successorSnapshotDeclaration: snapshotDeclaration,
			withCreatorSigner: false,
		});
		directRooms.set(name, reopened);
		await reopened.issue({ action: "message", clientOperationId: crypto.randomUUID(), text: `recovered-${ordering}` });
		return Object.freeze({
			coldReopenCount: instrumentation().d110cColdReopenCount(),
			interrupted,
			operations: Object.freeze([...control.operations]),
			state: control.state,
			transportOpenCount,
		});
	} finally {
		await closeDirectForReopen(name);
		await interruptedRoom?.close().catch(() => undefined);
		directCreatorInvites.delete(name);
		directRoomHeadControls.delete(name);
		directRehearsalInputs.delete(name);
		directMigrationReceipts.delete(name);
		await removeDirectDatabases(name);
	}
}

async function directPendingWithoutDeclaration(name: string): Promise<Readonly<Record<string, unknown>>> {
	const control = createDirectRoomHeadControl();
	try {
		const room = await createDirectRoom(name, { control });
		directRooms.set(name, room);
		await room.sealEpoch();
		instrumentation().configure({ failBeforePublication: true });
		const interrupted = await settlementDetail(room.adoptCreatorSuccessor());
		await closeDirectForReopen(name);
		instrumentation().configure({});
		let transportOpenCount = 0;
		const detail = await directOpenSettlement(name, {
			control,
			initialization: Object.freeze({ kind: "reopen" }),
			onOpenTransport: () => {
				transportOpenCount += 1;
			},
			withCreatorSigner: false,
		});
		return Object.freeze({
			coldReopenCount: instrumentation().d110cColdReopenCount(),
			detail,
			interrupted,
			transportOpenCount,
		});
	} finally {
		await discardDirectRoom(name);
	}
}

async function directHeadAhead(name: string): Promise<string> {
	const control = createDirectRoomHeadControl();
	const databaseName = `d108e3-direct-${name}`;
	try {
		const room = await createDirectRoom(name, { control });
		directRooms.set(name, room);
		await room.sealEpoch();
		instrumentation().configure({});
		await room.adoptCreatorSuccessor();
		const snapshotDeclaration = await rawSnapshotDeclaration(databaseName);
		await closeDirectForReopen(name);
		if (control.initialStable === undefined) throw new TypeError("D110C model genesis floor is unavailable");
		control.state = Object.freeze({ pending: null, stable: control.initialStable });
		return await directOpenSettlement(name, {
			control,
			initialization: Object.freeze({ kind: "reopen" }),
			successorSnapshotDeclaration: snapshotDeclaration,
			withCreatorSigner: false,
		});
	} finally {
		await discardDirectRoom(name);
	}
}

async function d110c0cRoomSnapshot(room: DirectRoomSession): Promise<PlainRecord> {
	return Object.freeze({
		acl: normalize(room.previewLatchedAcl()),
		authority: normalize(room.authority()),
		durableHead: normalize(await room.inspectDurableHead()),
		projection: normalize(room.projection()),
		roomId: room.roomId,
		status: normalize(room.status()),
	});
}

function d110c0cColdRoomSnapshot(room: DirectRoomSession): PlainRecord {
	return Object.freeze({
		acl: normalize(room.previewLatchedAcl()),
		authority: normalize(room.authority()),
		projection: normalize(room.projection()),
		roomId: room.roomId,
		status: normalize(room.status()),
	});
}

async function d110c0c1IssuanceRows(databaseName: string): Promise<readonly PlainRecord[]> {
	const database = await dumpDatabase(`${databaseName}--drp-issuance-v1`);
	const issued = database.stores.find(({ name }) => name === "issuedRecords")?.rows.map(exactRecord) ?? [];
	const outbox = database.stores.find(({ name }) => name === "issuanceOutbox")?.rows.map(exactRecord) ?? [];
	if (issued.length !== outbox.length) throw new TypeError("D110C_0C1_ISSUANCE_PAIR_COUNT_INVALID");
	return Object.freeze(
		issued
			.map((row) => {
				const authorSequence = Number(row.authorSequence);
				const paired = outbox.filter(
					(candidate) =>
						candidate.objectId === row.objectId &&
						candidate.author === row.author &&
						candidate.authorSequence === authorSequence
				);
				if (
					paired.length !== 1 ||
					!(row.canonicalPreimageBytes instanceof Uint8Array) ||
					!(row.digest instanceof Uint8Array) ||
					!(paired[0]?.digest instanceof Uint8Array) ||
					hex(row.digest) !== hex(paired[0].digest)
				) {
					throw new TypeError("D110C_0C1_ISSUANCE_PAIR_INVALID");
				}
				const vertex = exactRecord(decodeCanonical(row.canonicalPreimageBytes));
				return Object.freeze({
					anchor: vertex.anchor,
					author: row.author,
					authorSequence,
					digest: hex(row.digest),
					epoch: vertex.epoch,
					objectId: row.objectId,
					preimageHex: hex(row.canonicalPreimageBytes),
					publishState: paired[0].publishState,
				});
			})
			.sort((left, right) => Number(left.authorSequence) - Number(right.authorSequence))
	);
}

async function d110c0c1SetPublishState(
	databaseName: string,
	authorSequence: number,
	publishState: "pending" | "published"
): Promise<void> {
	const database = await openExistingDatabase(`${databaseName}--drp-issuance-v1`);
	try {
		const transaction = database.transaction("issuanceOutbox", "readwrite", { durability: "strict" });
		const store = transaction.objectStore("issuanceOutbox");
		const rows = (await request(store.getAll())).map(exactRecord);
		const matches = rows.filter((row) => row.authorSequence === authorSequence);
		if (matches.length !== 1) throw new TypeError("D110C_0C1_PENDING_ROW_INVALID");
		await request(store.put({ ...matches[0], publishState }));
		await transactionDone(transaction);
	} finally {
		database.close();
	}
}

async function d110c0c1PendingCase(name: string, authorSequence: 0 | 2): Promise<PlainRecord> {
	const databaseName = `d108e3-direct-${name}`;
	const roomHeadAuthority = d110cRoomHeadAuthority(name, Object.freeze({ kind: "create" }));
	instrumentation().configure({});
	instrumentation().d110c0c1SetPhase(`pending-${authorSequence}-prefix`);
	let room = await createDirectRoom(name, { roomHeadAuthority });
	directRooms.set(name, room);
	try {
		await room.issue({ action: "message", clientOperationId: `${name}-epoch-zero`, text: `${name}-epoch-zero` });
		await room.sealEpoch();
		await room.adoptCreatorSuccessor();
		await room.issue({ action: "message", clientOperationId: `${name}-epoch-one`, text: `${name}-epoch-one` });
		await room.sealEpoch();
		await room.adoptCreatorSuccessor();
		await room.issue({ action: "message", clientOperationId: `${name}-epoch-two`, text: `${name}-epoch-two` });
		await room.sealEpoch();
		await room.adoptCreatorSuccessor();
		const declaration = await rawSnapshotDeclarationAtEpoch(databaseName, 2);
		await closeDirectForReopen(name);
		await d110c0c1SetPublishState(databaseName, authorSequence, "pending");
		const before = await d110c0c1IssuanceRows(databaseName);
		instrumentation().d110c0c1SetPhase(`pending-${authorSequence}-cold-reopen`);
		room = await createDirectRoom(name, {
			roomHeadAuthority: d110cRoomHeadAuthority(name, Object.freeze({ kind: "reopen" })),
			successorSnapshotDeclaration: declaration,
			withCreatorSigner: false,
		});
		directRooms.set(name, room);
		await room.issue({ action: "message", clientOperationId: `${name}-after`, text: `${name}-after` });
		return Object.freeze({
			after: await d110c0c1IssuanceRows(databaseName),
			authorSequence,
			before,
			reopened: d110c0cColdRoomSnapshot(room),
			trace: instrumentation().d110c0c1TraceSnapshot(),
		});
	} finally {
		instrumentation().d110c0c1SetPhase(null);
		await discardDirectRoom(name);
	}
}

async function d110c0c1eSameAuthorControl(name: string): Promise<PlainRecord> {
	const databaseName = `d108e3-direct-${name}`;
	instrumentation().configure({});
	let room = await createDirectRoom(name, {
		roomHeadAuthority: d110cRoomHeadAuthority(name, Object.freeze({ kind: "create" })),
	});
	directRooms.set(name, room);
	try {
		await room.issue(
			Object.freeze({ action: "message", clientOperationId: `${name}-epoch-zero`, text: `${name}-epoch-zero` })
		);
		await room.sealEpoch();
		await room.adoptCreatorSuccessor();
		await room.issue(
			Object.freeze({ action: "message", clientOperationId: `${name}-successor-era`, text: `${name}-successor-era` })
		);
		const hot = d110c0cColdRoomSnapshot(room);
		const declaration = await rawSnapshotDeclarationAtEpoch(databaseName, 0);
		const before = await d110c0c1IssuanceRows(databaseName);
		await closeDirectForReopen(name);
		room = await createDirectRoom(name, {
			roomHeadAuthority: d110cRoomHeadAuthority(name, Object.freeze({ kind: "reopen" })),
			successorSnapshotDeclaration: declaration,
			withCreatorSigner: false,
		});
		directRooms.set(name, room);
		const reopened = d110c0cColdRoomSnapshot(room);
		await room.issue(Object.freeze({ action: "message", clientOperationId: `${name}-after`, text: `${name}-after` }));
		return Object.freeze({
			after: await d110c0c1IssuanceRows(databaseName),
			before,
			hot,
			reopened,
			trace: instrumentation().d110c0c1TraceSnapshot(),
		});
	} finally {
		await discardDirectRoom(name);
	}
}

async function d110c0c1Case(name: string, kind: "control" | "treatment"): Promise<PlainRecord> {
	const databaseName = `d108e3-direct-${name}`;
	const roomHeadAuthority = d110cRoomHeadAuthority(name, Object.freeze({ kind: "create" }));
	instrumentation().configure({});
	instrumentation().d110c0c1SetPhase("prefix-0-to-1");
	let room = await createDirectRoom(name, { roomHeadAuthority });
	directRooms.set(name, room);
	const issue = (identity: string, text: string): Promise<void> =>
		room.issue(Object.freeze({ action: "message", clientOperationId: identity, text }));
	try {
		await issue("d110c-0c1-epoch-zero", "d110c-0c1-epoch-zero");
		await room.sealEpoch();
		await room.adoptCreatorSuccessor();
		instrumentation().d110c0c1SetPhase("prefix-1-to-2");
		await issue("d110c-0c1-epoch-one", "d110c-0c1-epoch-one");
		await room.sealEpoch();
		await room.adoptCreatorSuccessor();
		const prefixRows = await d110c0c1IssuanceRows(databaseName);
		if (kind === "control") {
			const hot = await d110c0cRoomSnapshot(room);
			const declaration = await rawSnapshotDeclarationAtEpoch(databaseName, 1);
			instrumentation().d110c0c1SetPhase("control-cold-reopen-epoch-2");
			await closeDirectForReopen(name);
			room = await createDirectRoom(name, {
				roomHeadAuthority: d110cRoomHeadAuthority(name, Object.freeze({ kind: "reopen" })),
				successorSnapshotDeclaration: declaration,
				withCreatorSigner: false,
			});
			directRooms.set(name, room);
			const reopened = d110c0cColdRoomSnapshot(room);
			await issue("d110c-0c1-control-after-reopen", "d110c-0c1-control-after-reopen");
			const after = d110c0cColdRoomSnapshot(room);
			const postReopenRows = await d110c0c1IssuanceRows(databaseName);
			const rehearsalInput = directRehearsalInputs.get(name);
			if (rehearsalInput === undefined) throw new TypeError("D110C_0C1G_REHEARSAL_INPUT_ABSENT");
			let successorMigrationDetail = "fulfilled";
			try {
				await room.rehearseMigration(rehearsalInput);
			} catch (error) {
				successorMigrationDetail = directFailureDetail(error);
			}
			await issue("d110c-0c1-after-migration-refusal", "d110c-0c1-after-migration-refusal");
			const afterMigrationRefusal = d110c0cColdRoomSnapshot(room);
			return Object.freeze({
				after,
				afterMigrationRefusal,
				coldReopenCount: instrumentation().d110cColdReopenCount(),
				hot,
				kind,
				postReopenRows,
				prefixRows,
				projectionBases: instrumentation().projectionBaseObservations(),
				reopened,
				successorMigrationDetail,
				trace: instrumentation().d110c0c1TraceSnapshot(),
			});
		}

		instrumentation().d110c0c1SetPhase("hot-adoption-2-to-3");
		await issue("d110c-0c1-epoch-two", "d110c-0c1-epoch-two");
		const close = normalize(await room.sealEpoch());
		await room.adoptCreatorSuccessor();
		const hot = await d110c0cRoomSnapshot(room);
		const treatmentRows = await d110c0c1IssuanceRows(databaseName);
		const declaration = await rawSnapshotDeclarationAtEpoch(databaseName, 2);
		instrumentation().d110c0c1SetPhase("treatment-cold-reopen-epoch-3");
		await closeDirectForReopen(name);
		let detail = "fulfilled";
		let reopened: PlainRecord | null = null;
		try {
			room = await createDirectRoom(name, {
				roomHeadAuthority: d110cRoomHeadAuthority(name, Object.freeze({ kind: "reopen" })),
				successorSnapshotDeclaration: declaration,
				withCreatorSigner: false,
			});
			directRooms.set(name, room);
			reopened = d110c0cColdRoomSnapshot(room);
			await issue("d110c-0c1-treatment-after-reopen", "d110c-0c1-treatment-after-reopen");
			const after = d110c0cColdRoomSnapshot(room);
			const postReopenRows = await d110c0c1IssuanceRows(databaseName);
			return Object.freeze({
				after,
				close,
				detail,
				hot,
				kind,
				postReopenRows,
				prefixRows,
				reopened,
				trace: instrumentation().d110c0c1TraceSnapshot(),
				treatmentRows,
			});
		} catch (error) {
			detail = directFailureDetail(error);
		}
		return Object.freeze({
			close,
			detail,
			hot,
			kind,
			prefixRows,
			reopened,
			trace: instrumentation().d110c0c1TraceSnapshot(),
			treatmentRows,
		});
	} finally {
		instrumentation().d110c0c1SetPhase(null);
		await discardDirectRoom(name);
	}
}

function d110c0c1gGridControl(): PlainRecord {
	const dependencies = directDependencies();
	const application = dependencies.createV3ZoneApplication(Object.freeze([]), "peer:grid", "author:grid");
	let detail = "fulfilled";
	try {
		application.projectAcceptedOperations(
			Object.freeze({
				authenticatedBase: Object.freeze({
					blueprintDigest: "a".repeat(64),
					epoch: 1,
					exactCanonicalApplicationStateBytes: encodeCanonical({ blocks: [], outcomes: [] }),
					objectId: "creator:grid",
					stateDigest: "b".repeat(64),
				}),
				currentEpochOperations: Object.freeze([]),
			})
		);
	} catch (error) {
		detail = directFailureDetail(error);
	}
	const malformedTagged = dependencies.bindV3BlueprintLivePlane(
		Object.freeze({ extra: true, plane: Object.freeze({}), purpose: "projection-base" })
	);
	const noncurrentTagged = dependencies.bindV3BlueprintLivePlane(
		Object.freeze({ plane: Object.freeze({}), purpose: "projection-base" })
	);
	return Object.freeze({ detail, malformedTagged, noncurrentTagged });
}

async function d110c0c1Differential(name: string): Promise<PlainRecord> {
	const run = async (label: string, task: () => Promise<PlainRecord>): Promise<PlainRecord> => {
		try {
			return await task();
		} catch (error) {
			throw new TypeError(`D110C_0C1_CASE_FAILED:${label}:${directFailureDetail(error)}`);
		}
	};
	const control = await run("control", () => d110c0c1Case(name, "control"));
	const treatment = await run("treatment", () => d110c0c1Case(name, "treatment"));
	const pendingHistorical = await run("pending-historical", () => d110c0c1PendingCase(`${name}-pending-historical`, 2));
	const pendingGenesis = await run("pending-genesis", () => d110c0c1PendingCase(`${name}-pending-genesis`, 0));
	return Object.freeze({ control, pendingGenesis, pendingHistorical, treatment });
}

type D110c0c1cFault =
	| "ahe-lineage"
	| "different-anchor"
	| "epoch-zero"
	| "higher-epoch"
	| "lower-epoch"
	| "missing-snapshot"
	| "issuance-lineage"
	| "possession"
	| "snapshot-anchor"
	| "snapshot-epoch"
	| "snapshot-manifest"
	| "snapshot-object"
	| "snapshot-payload"
	| "stable-cross-object";

async function d110c0c1cFailureCase(name: string, fault: D110c0c1cFault): Promise<PlainRecord> {
	const databaseName = `d108e3-direct-${name}`;
	const roomHeadAuthority = d110cRoomHeadAuthority(name, Object.freeze({ kind: "create" }));
	let room = await createDirectRoom(name, { roomHeadAuthority });
	directRooms.set(name, room);
	try {
		await room.issue(Object.freeze({ action: "message", clientOperationId: `${name}-zero`, text: `${name}-zero` }));
		const genesisEvidence = await d110cRoomHeadEvidence(name);
		const genesisStable = exactRecord(exactRecord(genesisEvidence.state).stable);
		await room.sealEpoch();
		await room.adoptCreatorSuccessor();
		await room.issue(Object.freeze({ action: "message", clientOperationId: `${name}-one`, text: `${name}-one` }));
		await room.sealEpoch();
		await room.adoptCreatorSuccessor();
		const declaration = await rawSnapshotDeclarationAtEpoch(databaseName, 1);
		await closeDirectForReopen(name);
		const stableEvidence = await d110cRoomHeadEvidence(name);
		const stable = exactRecord(exactRecord(stableEvidence.state).stable);
		let selectedDeclaration: unknown = declaration;
		if (fault === "missing-snapshot") selectedDeclaration = undefined;
		if (fault === "epoch-zero") await overwriteD110cStableRoomHead(name, genesisStable);
		if (fault === "lower-epoch") {
			await overwriteD110cStableRoomHead(name, Object.freeze({ ...stable, epoch: 1 }));
		}
		if (fault === "higher-epoch") {
			await overwriteD110cStableRoomHead(name, Object.freeze({ ...stable, epoch: 3 }));
		}
		if (fault === "different-anchor") {
			await overwriteD110cStableRoomHead(name, Object.freeze({ ...stable, currentAnchorDigest: "f".repeat(64) }));
		}
		if (fault === "stable-cross-object") {
			await overwriteD110cStableRoomHead(name, Object.freeze({ ...stable, objectId: "creator:foreign" }));
		}
		const scope = exactRecord(declaration.scope);
		if (fault === "snapshot-object") {
			selectedDeclaration = Object.freeze({
				...declaration,
				scope: Object.freeze({ ...scope, objectId: "creator:foreign" }),
			});
		}
		if (fault === "snapshot-epoch") {
			selectedDeclaration = Object.freeze({
				...declaration,
				scope: Object.freeze({ ...scope, epoch: Number(scope.epoch) + 1 }),
			});
		}
		if (fault === "snapshot-anchor") {
			selectedDeclaration = Object.freeze({
				...declaration,
				scope: Object.freeze({ ...scope, anchor: "e".repeat(64) }),
			});
		}
		if (fault === "snapshot-manifest") {
			const manifest = new Uint8Array(declaration.exactCanonicalManifestBytes as Uint8Array);
			manifest[0] = (manifest[0] ?? 0) ^ 1;
			selectedDeclaration = Object.freeze({ ...declaration, exactCanonicalManifestBytes: manifest });
		}
		const attemptBefore = await d110cRoomHeadEvidence(name);
		instrumentation().configure({});
		instrumentation().d110c0c1cSetFault(
			["ahe-lineage", "issuance-lineage", "possession", "snapshot-payload"].includes(fault) ? fault : null
		);
		let detail = "fulfilled";
		try {
			room = await createDirectRoom(name, {
				roomHeadAuthority: d110cRoomHeadAuthority(name, Object.freeze({ kind: "reopen" })),
				...(selectedDeclaration === undefined ? {} : { successorSnapshotDeclaration: selectedDeclaration }),
				withCreatorSigner: false,
			});
			directRooms.set(name, room);
		} catch (error) {
			detail = directFailureDetail(error);
		}
		const after = await d110cRoomHeadEvidence(name);
		return Object.freeze({
			afterDigest: after.stateDigest,
			beforeDigest: attemptBefore.stateDigest,
			coldReopenCount: instrumentation().d110cColdReopenCount(),
			detail,
			fault,
		});
	} finally {
		await discardDirectRoom(name);
	}
}

async function d110c0c1cMatrix(name: string): Promise<PlainRecord> {
	const faults = Object.freeze([
		"ahe-lineage",
		"missing-snapshot",
		"epoch-zero",
		"lower-epoch",
		"higher-epoch",
		"different-anchor",
		"stable-cross-object",
		"snapshot-object",
		"snapshot-epoch",
		"snapshot-anchor",
		"snapshot-manifest",
		"snapshot-payload",
		"possession",
		"issuance-lineage",
	] as const);
	const results: PlainRecord[] = [];
	for (const fault of faults) results.push(await d110c0c1cFailureCase(`${name}-${fault}`, fault));
	return Object.freeze({ results: Object.freeze(results) });
}

async function d110c0cStage(name: string, ordering: "new-ahe" | "old-ahe"): Promise<PlainRecord> {
	const databaseName = `d108e3-direct-${name}`;
	const roomHeadAuthority = d110cRoomHeadAuthority(name, Object.freeze({ kind: "create" }));
	const room = await createDirectRoom(name, { roomHeadAuthority });
	directRooms.set(name, room);
	instrumentation().configure({});
	const issue = (text: string): Promise<void> =>
		room.issue(Object.freeze({ action: "message", clientOperationId: crypto.randomUUID(), text }));
	await issue("d110c-0c-epoch-zero");
	await room.sealEpoch();
	await room.adoptCreatorSuccessor();
	await issue("d110c-0c-epoch-one");
	await room.sealEpoch();
	await room.adoptCreatorSuccessor();
	await issue("d110c-0c-epoch-two");
	const stable = await d110c0cRoomSnapshot(room);
	const close = normalize(await room.sealEpoch());
	if (ordering === "old-ahe") {
		instrumentation().configure({ failBeforePublication: true });
	} else {
		instrumentation().configure({});
		await configureD110cRoomHeadFault(name, "commit-unavailable-once");
	}
	const interrupted = await settlementDetail(room.adoptCreatorSuccessor());
	const expectedInterruption =
		ordering === "old-ahe" ? "D110C controlled pre-publication process death" : "D110C_FLOOR_UNAVAILABLE";
	if (interrupted !== expectedInterruption) {
		throw new TypeError(`D110C_0C_STAGE_CLASSIFICATION_INVALID:${ordering}:${interrupted}`);
	}
	const after = await d110c0cRoomSnapshot(room);
	const floor = await d110cRoomHeadEvidence(name);
	const floorState = exactRecord(floor.state);
	const pending = exactRecord(floorState.pending);
	if (exactRecord(floorState.stable).epoch !== 2 || exactRecord(pending.next).epoch !== 3) {
		throw new TypeError("D110C_0C_DURABLE_PENDING_INVALID");
	}
	if (!sameCanonical(stable.projection, after.projection) || !sameCanonical(stable.acl, after.acl)) {
		throw new TypeError("D110C_0C_INTERRUPTED_STATE_CHANGED");
	}
	return Object.freeze({
		ahe: await d110cAheEvidence(databaseName),
		after,
		close,
		floor,
		interrupted,
		ordering,
		stable,
	});
}

async function d110c0cRecover(name: string): Promise<PlainRecord> {
	const databaseName = `d108e3-direct-${name}`;
	const floorBefore = await d110cRoomHeadEvidence(name);
	const aheBefore = await d110cAheEvidence(databaseName);
	const snapshotDeclaration = await rawSnapshotDeclarationAtEpoch(databaseName, 2);
	instrumentation().configure({});
	let detail = "fulfilled";
	let reopened: DirectRoomSession | undefined;
	let reopenedSnapshot: PlainRecord | null = null;
	try {
		reopened = await createDirectRoom(name, {
			roomHeadAuthority: d110cRoomHeadAuthority(name, Object.freeze({ kind: "reopen" })),
			successorSnapshotDeclaration: snapshotDeclaration,
			withCreatorSigner: false,
		});
		directRooms.set(name, reopened);
		await reopened.issue(
			Object.freeze({
				action: "message",
				clientOperationId: crypto.randomUUID(),
				text: "d110c-0c-post-restart",
			})
		);
		reopenedSnapshot = d110c0cColdRoomSnapshot(reopened);
	} catch (error) {
		detail = directFailureDetail(error);
	}
	const floorAfter = await d110cRoomHeadEvidence(name);
	const aheAfter = await d110cAheEvidence(databaseName);
	const recovery = instrumentation().d110c0cRecoverySnapshot();
	if (detail !== "fulfilled" && recovery.resultKind !== "active-new" && !sameCanonical(floorBefore, floorAfter)) {
		throw new TypeError("D110C_0C_FAILED_RECOVERY_FLOOR_MUTATED");
	}
	if (
		detail !== "fulfilled" &&
		recovery.resultKind !== "active-new" &&
		fingerprint(aheBefore) !== fingerprint(aheAfter)
	) {
		throw new TypeError("D110C_0C_FAILED_RECOVERY_AHE_MUTATED");
	}
	return Object.freeze({
		aheAfter,
		aheBefore,
		detail,
		floorAfter,
		floorBefore,
		recovery,
		reopened: reopenedSnapshot,
		snapshotScope: normalize(snapshotDeclaration.scope),
	});
}

async function d110cFloorMatrix(): Promise<Readonly<Record<string, unknown>>> {
	const capturedCase = async (operation: () => Promise<unknown>): Promise<unknown> => {
		try {
			return await operation();
		} catch (error) {
			return Object.freeze({
				unexpected: directFailureDetail(error),
			});
		}
	};
	const createCase = async (name: string, fault: DirectRoomHeadFault): Promise<string> => {
		const control = createDirectRoomHeadControl(fault);
		return directOpenSettlement(name, { control });
	};
	const readCase = async (name: string, fault: DirectRoomHeadFault): Promise<string> => {
		const control = createDirectRoomHeadControl(fault);
		return directOpenSettlement(name, { control, initialization: Object.freeze({ kind: "reopen" }) });
	};
	const crossGenesisName = "d110c-cross-genesis";
	const crossGenesis = await preparedGenesisControl(crossGenesisName);
	const crossGenesisStable = crossGenesis.initialStable as PlainRecord;
	crossGenesis.state = Object.freeze({
		pending: null,
		stable: Object.freeze({ ...crossGenesisStable, currentAnchorDigest: "f".repeat(64) }),
	});
	const crossGenesisResult = await directOpenSettlement(crossGenesisName, {
		control: crossGenesis,
		initialization: Object.freeze({ kind: "reopen" }),
	});

	const floorAheadName = "d110c-floor-ahead";
	const floorAhead = await preparedGenesisControl(floorAheadName);
	const floorAheadStable = floorAhead.initialStable as PlainRecord;
	floorAhead.state = Object.freeze({
		pending: null,
		stable: Object.freeze({ ...floorAheadStable, currentAnchorDigest: "e".repeat(64), epoch: 1 }),
	});
	const floorAheadResult = await directOpenSettlement(floorAheadName, {
		control: floorAhead,
		initialization: Object.freeze({ kind: "reopen" }),
	});

	return Object.freeze({
		beginConflict: await directAdoptionSettlement("d110c-begin-conflict", { fault: "begin-conflict" }),
		beginMalformed: await directAdoptionSettlement("d110c-begin-malformed", { fault: "begin-malformed" }),
		beginUnavailable: await directAdoptionSettlement("d110c-begin-unavailable", { fault: "begin-unavailable" }),
		commitConflict: await directAdoptionSettlement("d110c-commit-conflict", { fault: "commit-conflict" }),
		commitMalformed: await directAdoptionSettlement("d110c-commit-malformed", { fault: "commit-malformed" }),
		createConflict: await createCase("d110c-create-conflict", "create-conflict"),
		createMalformed: await createCase("d110c-create-malformed", "create-malformed"),
		createUnavailable: await createCase("d110c-create-unavailable", "create-unavailable"),
		crossGenesis: crossGenesisResult,
		floorAhead: floorAheadResult,
		headAhead: await directHeadAhead("d110c-head-ahead"),
		migrateCrossObject: await directOpenSettlement("d110c-migrate-cross-object", {
			control: createDirectRoomHeadControl(),
			initialization: Object.freeze({
				head: Object.freeze({ currentAnchorDigest: "d".repeat(64), epoch: 0, objectId: "foreign:room" }),
				kind: "migrate",
			}),
		}),
		missingReopen: await readCase("d110c-missing-reopen", "none"),
		pendingInvalid: await directAdoptionSettlement("d110c-pending-invalid", { pendingOther: true }),
		pendingNewAhe: await capturedCase(() => directPendingRecovery("d110c-pending-new-ahe", "new-ahe")),
		pendingOldAhe: await capturedCase(() => directPendingRecovery("d110c-pending-old-ahe", "old-ahe")),
		pendingWithoutDeclaration: await directPendingWithoutDeclaration("d110c-pending-no-declaration"),
		readMalformed: await readCase("d110c-read-malformed", "read-malformed"),
		readUnavailable: await readCase("d110c-read-unavailable", "read-unavailable"),
		regression: await directAdoptionSettlement("d110c-regression", { mutateStagedDescriptor: true }),
	});
}

function productApi(): ProductApi {
	const selected = Reflect.get(globalThis, "d9336V3Chat");
	if (selected === null || typeof selected !== "object") throw new TypeError("D.108d2 chat product is unavailable");
	return selected as ProductApi;
}

const api = Object.freeze({
	async adoptSuccessor(): Promise<void> {
		const adopt = productApi().adoptSuccessor;
		if (typeof adopt !== "function") throw new TypeError("D.108d2 chat adoption is unavailable");
		await Reflect.apply(adopt, productApi(), []);
	},
	beginAdoption(): void {
		if (pendingAdoption !== undefined) throw new TypeError("D.108e2b adoption observation is already active");
		adoptionSettled = false;
		pendingAdoption = observe(
			api.adoptSuccessor(),
			() => {
				adoptionSettled = true;
			},
			true
		);
	},
	beginActivation(): void {
		if (pendingActivation !== undefined) throw new TypeError("D.108e3 activation observation is already active");
		if (migrationReceipt === undefined) throw new TypeError("D.108e3 migration receipt is absent");
		activationSettled = false;
		pendingActivation = observe(
			productApi()
				.activateMigration(migrationReceipt)
				.then(() => undefined),
			() => {
				activationSettled = true;
			},
			true
		);
	},
	beginClose(): void {
		if (pendingClose !== undefined) throw new TypeError("D.108e2b close observation is already active");
		closeSettled = false;
		pendingClose = observe(
			productApi().close(),
			() => {
				closeSettled = true;
			},
			true
		);
	},
	beginDirectAdoption(name: string): void {
		const room = directRooms.get(name);
		if (room === undefined || pendingDirectAdoptions.has(name)) {
			throw new TypeError("D.108e3 direct adoption observation is invalid");
		}
		directAdoptionSettlements.set(name, false);
		pendingDirectAdoptions.set(
			name,
			observe(
				room.adoptCreatorSuccessor(),
				() => {
					directAdoptionSettlements.set(name, true);
				},
				true
			)
		);
	},
	beginD108e5DirectOperation(name: string, observation: string, kind: "activation" | "rehearsal"): void {
		const room = directRooms.get(name);
		const input = kind === "activation" ? directMigrationReceipts.get(name) : directRehearsalInputs.get(name);
		if (
			room === undefined ||
			input === undefined ||
			observation.length === 0 ||
			pendingD108e5Operations.has(observation)
		) {
			throw new TypeError("D.108e5 direct operation observation is invalid");
		}
		d108e5OperationSettlements.set(observation, false);
		const task = kind === "activation" ? room.activateMigration(input) : room.rehearseMigration(input);
		pendingD108e5Operations.set(
			observation,
			observe(
				task.then(() => undefined),
				() => {
					d108e5OperationSettlements.set(observation, true);
				},
				true
			)
		);
	},
	beginDirectClose(name: string): void {
		const room = directRooms.get(name);
		if (room === undefined || pendingDirectCloses.has(name)) {
			throw new TypeError("D.108e3 direct close observation is invalid");
		}
		closeSettled = false;
		pendingDirectCloses.set(
			name,
			observe(
				room.close(),
				() => {
					closeSettled = true;
				},
				true
			)
		);
	},
	beginDirectRehearsal(name: string): void {
		const room = directRooms.get(name);
		const rehearsalInput = directRehearsalInputs.get(name);
		if (room === undefined || rehearsalInput === undefined || pendingDirectRehearsals.has(name)) {
			throw new TypeError("D.108e3 direct rehearsal observation is invalid");
		}
		rehearsalSettled = false;
		pendingDirectRehearsals.set(
			name,
			observe(
				room.rehearseMigration(rehearsalInput).then(() => undefined),
				() => {
					rehearsalSettled = true;
				},
				true
			)
		);
	},
	beginDirectSend(name: string, text: string): void {
		const room = directRooms.get(name);
		if (room === undefined || pendingSend !== undefined) {
			throw new TypeError("D.108e3 direct send observation is invalid");
		}
		sendSettled = false;
		pendingSend = observe(
			room.issue({ action: "message", clientOperationId: crypto.randomUUID(), text }),
			() => {
				sendSettled = true;
			},
			true
		);
	},
	beginRehearsal(): void {
		if (pendingRehearsal !== undefined) throw new TypeError("D.108e3 rehearsal observation is already active");
		rehearsalSettled = false;
		pendingRehearsal = observe(
			productApi()
				.rehearseMigration()
				.then((receipt) => {
					migrationReceipt = receipt;
				}),
			() => {
				rehearsalSettled = true;
			},
			true
		);
	},
	beginOverlappingRehearsal(): void {
		if (pendingOverlappingRehearsal !== undefined) {
			throw new TypeError("D.108e3 overlapping rehearsal observation is already active");
		}
		pendingOverlappingRehearsal = observe(
			productApi()
				.rehearseMigration()
				.then(() => undefined),
			() => undefined,
			true
		);
	},
	beginSend(text: string): void {
		if (pendingSend !== undefined) throw new TypeError("D.108e3 send observation is already active");
		sendSettled = false;
		pendingSend = observe(
			api.send(text),
			() => {
				sendSettled = true;
			},
			true
		);
	},
	async boot(selectedRealmId: string): Promise<void> {
		if (booted) return;
		if (typeof selectedRealmId !== "string" || selectedRealmId.length === 0)
			throw new TypeError("D.108d2 realm is invalid");
		realmId = selectedRealmId;
		Object.defineProperty(globalThis, "BroadcastChannel", {
			configurable: true,
			value: ProductBroadcastChannel,
			writable: true,
		});
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		await import("../../../../examples/v3-chat/src/index.js");
		booted = true;
	},
	close(): Promise<void> {
		return productApi().close();
	},
	async closeDirectCreator(name: string): Promise<void> {
		const room = directRooms.get(name);
		if (room !== undefined) {
			directRooms.delete(name);
			await room.close().catch(() => undefined);
		}
		pendingDirectAdoptions.delete(name);
		pendingDirectCloses.delete(name);
		pendingDirectRehearsals.delete(name);
		directAdoptionSettlements.delete(name);
		directCreatorInvites.delete(name);
		directRoomHeadControls.delete(name);
		directRehearsalInputs.delete(name);
		directMigrationReceipts.delete(name);
		await removeDirectDatabases(name);
	},
	cleanupLifetimeReplacements(): Promise<void> {
		return instrumentation().cleanupReplacements();
	},
	configureLifetime(
		input: Readonly<{
			readonly failBeforePublication?: boolean;
			readonly injectActivationFailure?: boolean;
			readonly mutateStagedDescriptor?: boolean;
			readonly pauseAcceptedVertexFailure?: boolean;
			readonly pauseAfterActivation?: boolean;
			readonly pauseActivationFailure?: boolean;
			readonly pauseAfterPredecessorDeactivation?: boolean;
			readonly pauseMigrationRecord?: boolean;
			readonly pauseTerminalTransition?: boolean;
			readonly pauseVerification?: boolean;
			readonly rejectPredecessorDeactivate?: boolean;
			readonly rejectReplacementDeactivate?: boolean;
			readonly retainTarget?: boolean;
			readonly throwIssueLocal?: boolean;
		}>
	): void {
		adoptionSettled = false;
		activationSettled = false;
		closeSettled = false;
		rehearsalSettled = false;
		sendSettled = false;
		pendingAdoption = undefined;
		pendingActivation = undefined;
		pendingClose = undefined;
		pendingOverlappingRehearsal = undefined;
		pendingRehearsal = undefined;
		pendingSend = undefined;
		settlementSequence = 0;
		instrumentation().configure(input);
	},
	async concurrentAdoption(): Promise<readonly [ObservedSettlement, ObservedSettlement]> {
		const [left, right] = await Promise.all([
			observe(api.adoptSuccessor(), () => undefined),
			observe(api.adoptSuccessor(), () => undefined),
		]);
		return Object.freeze([left, right]);
	},
	create(input: unknown): Promise<string> {
		return productApi().create(input);
	},
	async deleteDatabases(prefix: string): Promise<readonly string[]> {
		const names = (await indexedDB.databases())
			.map(({ name }) => name)
			.filter((name): name is string => name?.startsWith(prefix) === true)
			.sort();
		for (const name of names) await deleteDatabase(name);
		return Object.freeze(names);
	},
	d110c0c1Differential(name: string): Promise<PlainRecord> {
		return d110c0c1Differential(name);
	},
	d110c0c1eSameAuthorControl(name: string): Promise<PlainRecord> {
		return d110c0c1eSameAuthorControl(name);
	},
	d110c0c1cControl(name: string): Promise<PlainRecord> {
		return d110c0c1Case(name, "control");
	},
	d110c0c1gGridControl(): PlainRecord {
		return d110c0c1gGridControl();
	},
	d110c0c1cMatrix(name: string): Promise<PlainRecord> {
		return d110c0c1cMatrix(name);
	},
	d110c0cRecover(name: string): Promise<PlainRecord> {
		return d110c0cRecover(name);
	},
	d110c0cStage(name: string, ordering: "new-ahe" | "old-ahe"): Promise<PlainRecord> {
		return d110c0cStage(name, ordering);
	},
	d110cBSnapshot(): Readonly<{
		readonly activationCount: number;
		readonly closeBindCount: number;
		readonly closeBindFailureCount: number;
		readonly predecessorDeactivateCount: number;
	}> {
		return instrumentation().d110cBSnapshot();
	},
	d110cFloorMatrix(): Promise<PlainRecord> {
		return d110cFloorMatrix();
	},
	directAdoptionSettled(name: string): boolean {
		if (!directRooms.has(name) || !directAdoptionSettlements.has(name)) {
			throw new TypeError("D.108e3 direct adoption observation is absent");
		}
		return directAdoptionSettlements.get(name) === true;
	},
	directCreatorState(name: string): PlainRecord {
		const room = directRooms.get(name);
		if (room === undefined) throw new TypeError("D110C_B_DIRECT_ROOM_ABSENT");
		return Object.freeze({ authority: room.authority(), status: room.status() });
	},
	d108e5OperationSettled(observation: string): boolean {
		if (!d108e5OperationSettlements.has(observation)) {
			throw new TypeError("D.108e5 direct operation observation is absent");
		}
		return d108e5OperationSettlements.get(observation) === true;
	},
	d108e5Snapshot(): Readonly<{ readonly redirectRecoveryCount: number; readonly verificationCount: number }> {
		return instrumentation().d108e5Snapshot();
	},
	deliver(packet: RelayPacket): void {
		if (packet.realmId === realmId) return;
		for (const channel of relayChannels.get(packet.channelName) ?? []) channel.deliver(packet);
	},
	async exportSuccessor(databaseName: string): Promise<SuccessorCarrier> {
		return Object.freeze({
			authority: await rawAuthority(databaseName),
			databases: Object.freeze(
				await Promise.all([
					dumpDatabase(`${databaseName}--ahe`),
					portableJournalDump(databaseName),
					dumpDatabase(`${databaseName}--drp-snapshot-quarantine-v1`),
				])
			),
			snapshotDeclaration: await rawSnapshotDeclaration(databaseName),
		});
	},
	rawAuthorityAtEpoch(databaseName: string, expectedEpoch: number): Promise<PlainRecord> {
		return rawAuthorityAtEpoch(databaseName, expectedEpoch);
	},
	async importSuccessor(
		carrier: SuccessorCarrier,
		sourceDatabaseName: string,
		targetDatabaseName: string
	): Promise<void> {
		const targetJournalName = `${targetDatabaseName}--drp-live-journal-v1`;
		const targetHasJournal = (await indexedDB.databases()).some(({ name }) => name === targetJournalName);
		for (const database of carrier.databases) {
			if (!database.name.startsWith(sourceDatabaseName)) throw new TypeError("D.108d2 carrier database differs");
			const targetName = `${targetDatabaseName}${database.name.slice(sourceDatabaseName.length)}`;
			if (targetName === targetJournalName && targetHasJournal) continue;
			await restoreDatabase(database, targetName);
		}
	},
	join(input: unknown): Promise<void> {
		return productApi().join(input);
	},
	lifetimeSnapshot(): LifetimeInstrumentationSnapshot &
		Readonly<{ readonly adoptionSettled: boolean; readonly closeSettled: boolean }> {
		return Object.freeze({ ...instrumentation().snapshot(), adoptionSettled, closeSettled });
	},
	async openDirectCreator(name: string): Promise<void> {
		directRooms.set(name, await createDirectRoom(name));
	},
	async prepareRehearsal(): Promise<void> {
		migrationReceipt = await productApi().rehearseMigration();
	},
	async prepareDirectRehearsal(name: string): Promise<void> {
		const room = directRooms.get(name);
		const input = directRehearsalInputs.get(name);
		if (room === undefined || input === undefined) {
			throw new TypeError("D.108e5 direct rehearsal preparation is invalid");
		}
		const receipt = await room.rehearseMigration(input);
		if (receipt === null || typeof receipt !== "object") {
			throw new TypeError("D.108e5 direct migration receipt is invalid");
		}
		directMigrationReceipts.set(
			name,
			Object.freeze({
				exactCanonicalRecordBytes: Reflect.get(receipt, "exactCanonicalRecordBytes"),
				recordVertexDigest: Reflect.get(receipt, "recordVertexDigest"),
				targetCreatorInvite: input.targetCreatorInvite,
			})
		);
	},
	async migrationBoundObservations(name: string): Promise<Readonly<Record<string, unknown>>> {
		const room = directRooms.get(name);
		const rehearsalInput = directRehearsalInputs.get(name);
		const material = rehearsalInput?.targetCreatorInvite;
		const rehearsalNonce = rehearsalInput?.rehearsalNonce;
		if (
			room === undefined ||
			material === null ||
			typeof material !== "object" ||
			!(rehearsalNonce instanceof Uint8Array)
		) {
			throw new TypeError("D.108e5 migration-bound fixture is invalid");
		}
		const inviteMaterial = material as Readonly<Record<string, unknown>>;
		const exact65536 = creatorInviteAtExactSize(inviteMaterial, 65_536);
		const exact65537 = creatorInviteAtExactSize(inviteMaterial, 65_537);
		const activationInput = (byteLength: number): Readonly<Record<string, unknown>> =>
			Object.freeze({
				exactCanonicalRecordBytes: new Uint8Array(byteLength),
				recordVertexDigest: "0".repeat(64),
				targetCreatorInvite: inviteMaterial,
			});
		const rehearse = (targetCreatorInvite: unknown): Promise<unknown> =>
			room.rehearseMigration(Object.freeze({ rehearsalNonce, targetCreatorInvite }));
		const mutableInvite = { ...inviteMaterial };
		const boundedMutationTask = rehearse(mutableInvite);
		mutableInvite["pinnedGenesisAnchorDigest"] = "mutated-after-call";
		return Object.freeze({
			activation49152: await settlementDetail(room.activateMigration(activationInput(49_152))),
			activation49153: await settlementDetail(room.activateMigration(activationInput(49_153))),
			exact65536: await settlementDetail(rehearse(exact65536)),
			exact65537: await settlementDetail(rehearse(exact65537)),
			nonByteField: await settlementDetail(
				rehearse({ ...inviteMaterial, exactCanonicalParametersCarrierBytes: Array.from({ length: 65_537 }, () => 0) })
			),
			oversizedDigest: await settlementDetail(
				rehearse({ ...inviteMaterial, pinnedGenesisAnchorDigest: "0".repeat(65_537) })
			),
			overLimitHex: await settlementDetail(rehearse("00".repeat(65_537))),
			boundedMutation: await settlementDetail(boundedMutationTask),
		});
	},
	relayAudit(): RelayAudit {
		const copy = (observation: RelayMessageObservation): RelayMessageObservation =>
			Object.freeze({ ...observation, data: Uint8Array.from(observation.data) });
		return Object.freeze({
			incoming: relayIncoming,
			incomingMessages: Object.freeze(incomingMessages.map(copy)),
			mismatch: relayMismatch,
			outgoing: relayOutgoing,
			outgoingMessages: Object.freeze(outgoingMessages.map(copy)),
			realmId,
		});
	},
	releaseAcceptedVertexFailure(): void {
		instrumentation().releaseAcceptedVertexFailure();
	},
	releaseActivationFailure(): void {
		instrumentation().releaseActivationFailure();
	},
	releaseMigrationRecord(): void {
		instrumentation().releaseMigrationRecord();
	},
	releaseRedirectRecovery(): void {
		instrumentation().releaseRedirectRecovery();
	},
	releasePostActivation(): void {
		instrumentation().releasePostActivation();
	},
	releasePostPredecessorDeactivation(): void {
		instrumentation().releasePostPredecessorDeactivation();
	},
	releaseTerminalTransition(): void {
		instrumentation().releaseTerminalTransition();
	},
	releaseVerification(): void {
		instrumentation().releaseVerification();
	},
	sealEpoch(): Promise<PlainRecord> {
		return productApi().sealEpoch();
	},
	async sealDirectCreator(name: string): Promise<void> {
		const room = directRooms.get(name);
		if (room === undefined) throw new TypeError("D.108e3 direct room is absent");
		await room.sealEpoch();
	},
	send(text: string): Promise<void> {
		return productApi().send(text);
	},
	snapshot(): PlainRecord {
		return productApi().snapshot();
	},
	transitionSnapshot(): TransitionInstrumentationSnapshot &
		Readonly<{
			readonly activationSettled: boolean;
			readonly adoptionSettled: boolean;
			readonly closeSettled: boolean;
			readonly rehearsalSettled: boolean;
			readonly sendSettled: boolean;
		}> {
		return Object.freeze({
			...instrumentation().transitionSnapshot(),
			activationSettled,
			adoptionSettled,
			closeSettled,
			rehearsalSettled,
			sendSettled,
		});
	},
	async waitForAdoption(): Promise<ObservedSettlement> {
		if (pendingAdoption === undefined) throw new TypeError("D.108e2b adoption observation is absent");
		const selected = await pendingAdoption;
		pendingAdoption = undefined;
		return selected;
	},
	async waitForActivation(): Promise<ObservedSettlement> {
		if (pendingActivation === undefined) throw new TypeError("D.108e3 activation observation is absent");
		const selected = await pendingActivation;
		pendingActivation = undefined;
		return selected;
	},
	async waitForClose(): Promise<ObservedSettlement> {
		if (pendingClose === undefined) throw new TypeError("D.108e2b close observation is absent");
		const selected = await pendingClose;
		pendingClose = undefined;
		return selected;
	},
	async waitForDirectAdoption(name: string): Promise<ObservedSettlement> {
		const pending = pendingDirectAdoptions.get(name);
		if (pending === undefined) throw new TypeError("D.108e3 direct adoption observation is absent");
		const selected = await pending;
		pendingDirectAdoptions.delete(name);
		return selected;
	},
	async waitForD108e5DirectOperation(observation: string): Promise<ObservedSettlement> {
		const pending = pendingD108e5Operations.get(observation);
		if (pending === undefined) throw new TypeError("D.108e5 direct operation observation is absent");
		const selected = await pending;
		pendingD108e5Operations.delete(observation);
		return selected;
	},
	async waitForDirectClose(name: string): Promise<ObservedSettlement> {
		const pending = pendingDirectCloses.get(name);
		if (pending === undefined) throw new TypeError("D.108e3 direct close observation is absent");
		const selected = await pending;
		pendingDirectCloses.delete(name);
		return selected;
	},
	async waitForDirectRehearsal(name: string): Promise<ObservedSettlement> {
		const pending = pendingDirectRehearsals.get(name);
		if (pending === undefined) throw new TypeError("D.108e3 direct rehearsal observation is absent");
		const selected = await pending;
		pendingDirectRehearsals.delete(name);
		return selected;
	},
	async waitForOverlappingRehearsal(): Promise<ObservedSettlement> {
		if (pendingOverlappingRehearsal === undefined) {
			throw new TypeError("D.108e3 overlapping rehearsal observation is absent");
		}
		const selected = await pendingOverlappingRehearsal;
		pendingOverlappingRehearsal = undefined;
		return selected;
	},
	async waitForRehearsal(): Promise<ObservedSettlement> {
		if (pendingRehearsal === undefined) throw new TypeError("D.108e3 rehearsal observation is absent");
		const selected = await pendingRehearsal;
		pendingRehearsal = undefined;
		return selected;
	},
	async waitForSend(): Promise<ObservedSettlement> {
		if (pendingSend === undefined) throw new TypeError("D.108e3 send observation is absent");
		const selected = await pendingSend;
		pendingSend = undefined;
		return selected;
	},
});

Object.defineProperty(globalThis, "phase6aCreatorSuccessorProduct", {
	configurable: false,
	enumerable: true,
	value: api,
	writable: false,
});
