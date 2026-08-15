import { encodeCanonical, hashDomain } from "@ts-drp/canonical";

// eslint-disable-next-line import/no-unresolved -- resolved by the private p4 RED bundler.
import { createBrowserDurableLiveJournalStore } from "#phase-3a1b-p4-browser-candidate";
// eslint-disable-next-line import/no-unresolved -- resolved by the private p4 RED bundler.
import { armPhase3a1bP4BrowserTrace } from "#phase-3a1b-p4-browser-test-control";

interface DeathInput {
	readonly databaseName: string;
	readonly mode: "mutate" | "recover";
	readonly tuple: { readonly edge: string; readonly scenario: string; readonly scopeScenario: string };
}

interface JournalStore {
	appendAccepted(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	close(): Promise<void>;
	installGenesis(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	readiness(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("transaction aborted")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new Error("transaction failed")), {
			once: true,
		});
	});
}

async function rawClosure(databaseName: string): Promise<unknown> {
	const database = await requestResult(indexedDB.open(`${databaseName}--drp-live-journal-v1`));
	try {
		const transaction = database.transaction(["acceptedEntries", "scopes"], "readonly");
		const rows = (await requestResult(transaction.objectStore("acceptedEntries").getAll())).map(normalizeRecord);
		const scopes = (await requestResult(transaction.objectStore("scopes").getAll())).map(normalizeRecord);
		await transactionComplete(transaction);
		return { rows, scopes };
	} finally {
		database.close();
	}
}

function lowerHex(bytes: Uint8Array): string {
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeRecord(value: unknown): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) throw new TypeError("raw IDB record must be an object");
	return Object.freeze(
		Object.fromEntries(
			Object.entries(value).map(([key, field]) => [key, field instanceof Uint8Array ? lowerHex(field) : field])
		)
	);
}

function field(value: Readonly<Record<string, unknown>>, key: string): unknown {
	return Reflect.get(value, key);
}

function expectedScope(
	values: Readonly<Record<string, unknown>>,
	nextJournalSequence: number
): Readonly<Record<string, unknown>> {
	const install = field(values, "install") as Readonly<Record<string, unknown>>;
	const scope = field(values, "scope") as Readonly<Record<string, unknown>>;
	const parameters = field(install, "exactCanonicalParametersCarrierBytes") as Uint8Array;
	return Object.freeze({
		anchorDigest: field(scope, "anchorDigest"),
		detachedAnchorSignature: lowerHex(field(install, "detachedAnchorSignature") as Uint8Array),
		epoch: field(scope, "epoch"),
		exactCanonicalAnchorPreimageBytes: lowerHex(field(install, "exactCanonicalAnchorPreimageBytes") as Uint8Array),
		exactCanonicalParametersCarrierBytes: lowerHex(parameters),
		nextJournalSequence,
		objectId: field(scope, "objectId"),
		parametersDigest: lowerHex(hashDomain("ts-drp/parameters/v3", parameters)),
	});
}

function expectedRow(
	values: Readonly<Record<string, unknown>>,
	sourceKind: "local-issued" | "received"
): Readonly<Record<string, unknown>> {
	const input = field(values, sourceKind === "received" ? "received" : "local") as Readonly<Record<string, unknown>>;
	const scope = field(input, "scope") as Readonly<Record<string, unknown>>;
	return Object.freeze(
		sourceKind === "received"
			? {
					anchorDigest: field(scope, "anchorDigest"),
					detachedSignature: lowerHex(field(input, "detachedSignature") as Uint8Array),
					epoch: field(scope, "epoch"),
					exactCanonicalPreimageBytes: lowerHex(field(input, "exactCanonicalPreimageBytes") as Uint8Array),
					journalSequence: 0,
					objectId: field(scope, "objectId"),
					sourceKind,
					vertexDigest: field(input, "vertexDigest"),
				}
			: {
					anchorDigest: field(scope, "anchorDigest"),
					epoch: field(scope, "epoch"),
					journalSequence: 0,
					localAuthor: field(input, "author"),
					localAuthorSequence: field(input, "authorSequence"),
					objectId: field(scope, "objectId"),
					sourceKind,
					vertexDigest: field(input, "vertexDigest"),
				}
	);
}

function expectedClosure(
	input: DeathInput,
	primary: Readonly<Record<string, unknown>>,
	unaddressed: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
	const noWriteSource =
		input.tuple.scenario === "received-repeat" || input.tuple.scenario === "cross-kind-race"
			? "received"
			: input.tuple.scenario === "local-repeat" || input.tuple.scenario === "local-ref-race"
				? "local-issued"
				: null;
	const committedNew = input.tuple.edge === "transaction-complete" || input.tuple.edge === "during-readback";
	const sourceKind =
		noWriteSource ??
		(input.tuple.scenario === "append-received" && committedNew
			? "received"
			: input.tuple.scenario === "append-local" && committedNew
				? "local-issued"
				: null);
	const primaryInstalled = input.tuple.scenario !== "install-genesis" || committedNew;
	const rows = sourceKind === null ? [] : [expectedRow(primary, sourceKind)];
	const scopes = [
		...(primaryInstalled ? [expectedScope(primary, rows.length)] : []),
		...(input.tuple.scopeScenario === "two-scopes" ? [expectedScope(unaddressed, 0)] : []),
	].sort((left, right) => String(left.objectId).localeCompare(String(right.objectId)));
	return Object.freeze({ rows, scopes });
}

function material(seed: string): Readonly<Record<string, unknown>> {
	const zero = "0".repeat(64);
	const objectId = `creator:${seed.repeat(32)}`;
	const parameters = encodeCanonical({
		maxEpochVertices: 64,
		maxEpochBytes: 1_048_576,
		maxDependencies: 8,
		snapshotChunkBytes: 65_536,
		maxSnapshotBytes: 1_048_576,
		maxPendingEntries: 64,
		maxPendingBytes: 1_048_576,
	});
	const parametersDigest = lowerHex(hashDomain("ts-drp/parameters/v3", parameters));
	const anchor = encodeCanonical({
		kind: "drp-epoch-anchor",
		protocolMajor: 3,
		objectId,
		epoch: 0,
		previousAnchor: zero,
		cutDigest: zero,
		stateDigest: zero,
		aclDigest: zero,
		historyRoot: zero,
		historySize: 0,
		archiveIndexRoot: zero,
		blueprintDigest: "2".repeat(64),
		signerSetDigest: "3".repeat(64),
		parametersDigest,
		profileDigest: "4".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
	});
	const anchorDigest = lowerHex(hashDomain("ts-drp/epoch-anchor/v3", anchor));
	const vertex = encodeCanonical({
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId,
		epoch: 0,
		anchor: anchorDigest,
		author: `creator-${seed}`,
		authorSequence: 0,
		logicalTime: 1,
		dependencies: ["5".repeat(64)],
		operation: { arguments: { value: 1 }, type: "append" },
	});
	const signature = new Uint8Array(64).fill(Number(seed));
	const scope = Object.freeze({ anchorDigest, epoch: 0, objectId });
	return Object.freeze({
		install: Object.freeze({
			detachedAnchorSignature: signature,
			exactCanonicalAnchorPreimageBytes: anchor,
			exactCanonicalParametersCarrierBytes: parameters,
			objectId,
		}),
		local: Object.freeze({
			author: `creator-${seed}`,
			authorSequence: 0,
			scope,
			sourceKind: "local-issued",
			vertexDigest: lowerHex(hashDomain("ts-drp/vertex/v3", vertex)),
		}),
		received: Object.freeze({
			detachedSignature: signature,
			exactCanonicalPreimageBytes: vertex,
			scope,
			sourceKind: "received",
			vertexDigest: lowerHex(hashDomain("ts-drp/vertex/v3", vertex)),
		}),
		scope,
	});
}

function checkpoint(edge: string): void {
	postMessage({ edge, kind: "checkpoint" });
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

async function mutate(input: DeathInput, store: JournalStore): Promise<void> {
	const primary = material("1");
	const unaddressed = material("2");
	if (input.tuple.scenario === "idempotent-genesis")
		await store.installGenesis(primary.install as Readonly<Record<string, unknown>>);
	else if (input.tuple.scenario === "received-repeat" || input.tuple.scenario === "cross-kind-race") {
		await store.installGenesis(primary.install as Readonly<Record<string, unknown>>);
		await store.appendAccepted(primary.received as Readonly<Record<string, unknown>>);
	} else if (input.tuple.scenario === "local-repeat" || input.tuple.scenario === "local-ref-race") {
		await store.installGenesis(primary.install as Readonly<Record<string, unknown>>);
		await store.appendAccepted(primary.local as Readonly<Record<string, unknown>>);
	}
	if (input.tuple.scopeScenario === "two-scopes") {
		await store.installGenesis(unaddressed.install as Readonly<Record<string, unknown>>);
	}
	if (
		input.tuple.scenario !== "install-genesis" &&
		!["idempotent-genesis", "received-repeat", "local-repeat", "cross-kind-race", "local-ref-race"].includes(
			input.tuple.scenario
		)
	) {
		await store.installGenesis(primary.install as Readonly<Record<string, unknown>>);
	}
	if (input.tuple.scenario === "cross-kind-race" || input.tuple.scenario === "local-ref-race") {
		const competingStore = (await createBrowserDurableLiveJournalStore({
			primaryDatabaseName: input.databaseName,
		})) as JournalStore;
		armPhase3a1bP4BrowserTrace(input.tuple, checkpoint);
		const first =
			input.tuple.scenario === "cross-kind-race"
				? store.appendAccepted(primary.local as Readonly<Record<string, unknown>>)
				: store.appendAccepted({
						...(primary.local as Readonly<Record<string, unknown>>),
						vertexDigest: "6".repeat(64),
					});
		const second = competingStore.appendAccepted(
			(input.tuple.scenario === "cross-kind-race" ? primary.received : primary.local) as Readonly<
				Record<string, unknown>
			>
		);
		postMessage({ kind: "race-writers-invoked" });
		await Promise.all([first, second]);
		postMessage({ kind: "unexpected-result" });
		await competingStore.close();
		return;
	}
	if (input.tuple.edge === "before-transaction") checkpoint(input.tuple.edge);
	armPhase3a1bP4BrowserTrace(input.tuple, checkpoint);
	if (input.tuple.scenario === "install-genesis" || input.tuple.scenario === "idempotent-genesis") {
		await store.installGenesis(primary.install as Readonly<Record<string, unknown>>);
	} else if (input.tuple.scenario === "append-received") {
		await store.appendAccepted(primary.received as Readonly<Record<string, unknown>>);
	} else if (input.tuple.scenario === "received-repeat") {
		await store.appendAccepted(primary.received as Readonly<Record<string, unknown>>);
	} else {
		await store.appendAccepted(primary.local as Readonly<Record<string, unknown>>);
	}
	postMessage({ kind: "unexpected-result" });
}

async function recover(input: DeathInput, store: JournalStore): Promise<void> {
	const primary = material("1");
	const unaddressed = material("2");
	const primaryResult = await store.readiness({ scope: primary.scope });
	const unaddressedResult =
		input.tuple.scopeScenario === "two-scopes" ? await store.readiness({ scope: unaddressed.scope }) : null;
	await store.close();
	postMessage({
		expectedRaw: expectedClosure(input, primary, unaddressed),
		kind: "recovery",
		primary: primaryResult,
		raw: await rawClosure(input.databaseName),
		unaddressed: unaddressedResult,
	});
}

self.addEventListener("message", (event: MessageEvent<DeathInput>): void => {
	void (async (): Promise<void> => {
		const input = event.data;
		const store = (await createBrowserDurableLiveJournalStore({
			primaryDatabaseName: input.databaseName,
		})) as JournalStore;
		try {
			if (input.mode === "mutate") await mutate(input, store);
			else await recover(input, store);
		} finally {
			await store.close();
		}
	})().catch((error: unknown) => {
		postMessage({ kind: "worker-error", message: error instanceof Error ? error.message : String(error) });
	});
});
