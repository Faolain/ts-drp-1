import { decodeCanonical, hashDomain } from "@ts-drp/canonical";

type PlainRecord = Readonly<Record<string, unknown>>;

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
	adoptSuccessor?(): Promise<void>;
	close(): Promise<void>;
	create(input: unknown): Promise<string>;
	join(input: unknown): Promise<void>;
	sealEpoch(): Promise<PlainRecord>;
	send(text: string): Promise<void>;
	snapshot(): PlainRecord;
}

interface LifetimeInstrumentationSnapshot {
	readonly activationCount: number;
	readonly commitCount: number;
	readonly predecessorDeactivateCount: number;
	readonly replacementDeactivateCount: number;
	readonly replacementDeactivateCompletedCount: number;
	readonly verificationCount: number;
}

interface LifetimeInstrumentation {
	cleanupReplacements(): Promise<void>;
	configure(
		input: Readonly<{ readonly pauseVerification?: boolean; readonly rejectPredecessorDeactivate?: boolean }>
	): void;
	releaseVerification(): void;
	snapshot(): LifetimeInstrumentationSnapshot;
}

interface ObservedSettlement {
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
			beginClose(): void;
			boot(realmId: string): Promise<void>;
			close(): Promise<void>;
			cleanupLifetimeReplacements(): Promise<void>;
			configureLifetime(
				input: Readonly<{ readonly pauseVerification?: boolean; readonly rejectPredecessorDeactivate?: boolean }>
			): void;
			concurrentAdoption(): Promise<readonly [ObservedSettlement, ObservedSettlement]>;
			create(input: unknown): Promise<string>;
			deliver(packet: RelayPacket): void;
			exportSuccessor(databaseName: string): Promise<SuccessorCarrier>;
			importSuccessor(carrier: SuccessorCarrier, sourceDatabaseName: string, targetDatabaseName: string): Promise<void>;
			join(input: unknown): Promise<void>;
			lifetimeSnapshot(): LifetimeInstrumentationSnapshot &
				Readonly<{ readonly adoptionSettled: boolean; readonly closeSettled: boolean }>;
			relayAudit(): RelayAudit;
			releaseVerification(): void;
			sealEpoch(): Promise<PlainRecord>;
			send(text: string): Promise<void>;
			snapshot(): PlainRecord;
			waitForAdoption(): Promise<ObservedSettlement>;
			waitForClose(): Promise<ObservedSettlement>;
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
let closeSettled = false;
let settlementSequence = 0;
let pendingAdoption: Promise<ObservedSettlement> | undefined;
let pendingClose: Promise<ObservedSettlement> | undefined;

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
			return Object.freeze({
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

async function rawAuthority(databaseName: string): Promise<PlainRecord> {
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
		const trusts = decoded.filter((value) => value.kind === "drp-anchor-trust-state" && value.currentEpoch === 1);
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
			epoch: 1,
			genesisAnchorDigest: trust.genesisAnchorDigest,
			lifecycle: "active",
			objectId: trust.objectId,
			profileId: "creator-trusted-v1",
		});
	} finally {
		database.close();
	}
}

async function rawSnapshotDeclaration(databaseName: string): Promise<PlainRecord> {
	const database = await openExistingDatabase(`${databaseName}--drp-snapshot-quarantine-v1`);
	try {
		const transaction = database.transaction(["chunks", "scopes"], "readonly");
		const [scopeRows, chunkRows] = await Promise.all([
			request(transaction.objectStore("scopes").getAll()),
			request(transaction.objectStore("chunks").getAll()),
		]);
		await transactionDone(transaction);
		const scopes = scopeRows.map(exactRecord).filter((scope) => scope.state === "verified");
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
	cleanupLifetimeReplacements(): Promise<void> {
		return instrumentation().cleanupReplacements();
	},
	configureLifetime(
		input: Readonly<{ readonly pauseVerification?: boolean; readonly rejectPredecessorDeactivate?: boolean }>
	): void {
		adoptionSettled = false;
		closeSettled = false;
		pendingAdoption = undefined;
		pendingClose = undefined;
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
	releaseVerification(): void {
		instrumentation().releaseVerification();
	},
	sealEpoch(): Promise<PlainRecord> {
		return productApi().sealEpoch();
	},
	send(text: string): Promise<void> {
		return productApi().send(text);
	},
	snapshot(): PlainRecord {
		return productApi().snapshot();
	},
	async waitForAdoption(): Promise<ObservedSettlement> {
		if (pendingAdoption === undefined) throw new TypeError("D.108e2b adoption observation is absent");
		const selected = await pendingAdoption;
		pendingAdoption = undefined;
		return selected;
	},
	async waitForClose(): Promise<ObservedSettlement> {
		if (pendingClose === undefined) throw new TypeError("D.108e2b close observation is absent");
		const selected = await pendingClose;
		pendingClose = undefined;
		return selected;
	},
});

Object.defineProperty(globalThis, "phase6aCreatorSuccessorProduct", {
	configurable: false,
	enumerable: true,
	value: api,
	writable: false,
});
