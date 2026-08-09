import { bytesEqual, copyGenerationRecord, isClosedArray, isClosedRecord } from "./internal/validation.js";
import type {
	AheDurableStore,
	ExpectedHead,
	GenerationPageCursor,
	GenerationRecord,
	GenerationRef,
	ParseResult,
	StorageObjectId,
	StoreCapabilities,
	StoreResult,
} from "./types.js";
import { digestBlob, digestClosure, parseGenerationId, parseStorageObjectId } from "./values.js";

export type StoreContractFactory = () => AheDurableStore | Promise<AheDurableStore>;

export const STORE_CONTRACT_SCENARIOS = Object.freeze([
	Object.freeze({ id: "ephemeral-capability", branch: "common" }),
	Object.freeze({ id: "begin-cache-read-discard", branch: "common" }),
	Object.freeze({ id: "strict-transition-closure", branch: "strict" }),
] as const);

type StoreContractScenario = (typeof STORE_CONTRACT_SCENARIOS)[number];

type ContractContext = {
	readonly store: AheDurableStore;
	capabilities?: Readonly<StoreCapabilities>;
};

type QuiescentContractView = Readonly<{
	head: ExpectedHead;
	generations: readonly GenerationRecord[];
}>;

function contractViolation(step: string, detail: string): never {
	throw new Error(`AheDurableStore contract violation at ${step}: ${detail}`);
}

function parsed<T>(result: ParseResult<T>, label: string): T {
	if (!result.ok) return contractViolation("fixture", `${label} was not canonical`);
	return result.value;
}

function successfulValue(result: unknown, step: string): unknown {
	if (typeof result !== "object" || result === null || Array.isArray(result)) {
		return contractViolation(step, "expected an exact successful StoreResult");
	}
	const prototype = Object.getPrototypeOf(result);
	const ok = Object.getOwnPropertyDescriptor(result, "ok");
	const value = Object.getOwnPropertyDescriptor(result, "value");
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		Reflect.ownKeys(result).length !== 2 ||
		ok === undefined ||
		!("value" in ok) ||
		!ok.enumerable ||
		ok.value !== true ||
		value === undefined ||
		!("value" in value) ||
		!value.enumerable
	) {
		return contractViolation(step, "expected an exact successful StoreResult");
	}
	return value.value;
}

function assertRejection(result: unknown, reason: string, step: string): void {
	if (!isClosedRecord(result, ["ok", "reason"]) || result.ok !== false || result.reason !== reason) {
		contractViolation(step, `expected the exact ${reason} rejection`);
	}
}

function assertCapabilities(value: unknown): asserts value is Readonly<StoreCapabilities> {
	if (!isClosedRecord(value, ["durability", "signingEligibility"]) || !Object.isFrozen(value)) {
		contractViolation("ephemeral-capability", "expected exact frozen capabilities");
	}
	const honestEphemeral = value.durability === "ephemeral" && value.signingEligibility === "never";
	const honestStrict = value.durability === "strict" && value.signingEligibility === "backend-capability-required";
	if (!honestEphemeral && !honestStrict) {
		contractViolation("ephemeral-capability", "expected an honest durability/signing capability pair");
	}
}

function assertGeneration(
	value: unknown,
	expected: Omit<GenerationRecord, "state"> & { readonly state: GenerationRecord["state"] },
	step: string
): void {
	const copied = copyGenerationRecord(value);
	if (
		copied === undefined ||
		copied.objectId !== expected.objectId ||
		copied.generationId !== expected.generationId ||
		copied.baseExpectedHead.kind !== "none" ||
		copied.baseExpectedHead.objectId !== expected.objectId ||
		copied.closureDigest !== expected.closureDigest ||
		copied.state !== expected.state ||
		copied.closure.length !== 1 ||
		copied.closure[0]?.digest !== expected.closure[0]?.digest ||
		copied.closure[0]?.byteLength !== expected.closure[0]?.byteLength
	) {
		contractViolation(step, `expected the exact ${expected.state} generation record`);
	}
}

function assertObjectState(
	value: unknown,
	expected: Omit<GenerationRecord, "state"> & { readonly state: GenerationRecord["state"] },
	step: string
): asserts value is QuiescentContractView {
	if (
		!isClosedRecord(value, ["head", "generations"]) ||
		!isClosedRecord(value.head, ["kind", "objectId"]) ||
		value.head.kind !== "none" ||
		value.head.objectId !== expected.objectId ||
		!isClosedArray(value.generations) ||
		value.generations.length !== 1
	) {
		contractViolation(step, `expected one ${expected.state} generation under an unchanged no-head`);
	}
	assertGeneration(value.generations[0], expected, step);
}

function assertFreshState(value: unknown, objectId: GenerationRecord["objectId"], step: string): void {
	if (
		!isClosedRecord(value, ["head", "generations"]) ||
		!isClosedRecord(value.head, ["kind", "objectId"]) ||
		value.head.kind !== "none" ||
		value.head.objectId !== objectId ||
		!isClosedArray(value.generations) ||
		value.generations.length !== 0
	) {
		contractViolation(step, "expected a fresh no-head object with an empty journal");
	}
}

function assertBlob(
	value: unknown,
	expected: Uint8Array,
	forbiddenAlias: Uint8Array | undefined,
	step: string
): asserts value is Uint8Array {
	if (!(value instanceof Uint8Array) || value === forbiddenAlias || !bytesEqual(value, expected)) {
		contractViolation(step, "expected detached bytes matching the cached payload");
	}
}

function mutateStateOutput(value: QuiescentContractView): void {
	Reflect.set(value.head, "objectId", "mutated-output");
	const generation = value.generations[0];
	if (generation === undefined) return;
	Reflect.set(generation, "state", "Discarded");
	const reference = generation.closure[0];
	if (reference !== undefined) Reflect.set(reference, "byteLength", 0);
}

// Contract assertions call this only while their own writes are quiescent. The
// two public APIs remain independently consistent; this internal helper does not
// present their aggregate as an adapter snapshot.
async function readQuiescentContractView(
	store: AheDurableStore,
	objectId: StorageObjectId
): Promise<StoreResult<QuiescentContractView>> {
	const head = await store.readHead(objectId);
	if (!head.ok) return head;
	const generations: GenerationRecord[] = [];
	let cursor: GenerationPageCursor | undefined;
	let complete = false;
	while (!complete) {
		const page = await store.readGenerationPage({ objectId, ...(cursor === undefined ? {} : { cursor }), limit: 128 });
		if (!page.ok) return page;
		generations.push(...page.value.generations);
		cursor = page.value.nextCursor ?? undefined;
		complete = page.value.nextCursor === null;
	}
	return { ok: true, value: { head: head.value, generations } };
}

async function runCommonLifecycle(store: AheDurableStore): Promise<void> {
	const objectId = parsed(parseStorageObjectId(`contract-runner:${"c".repeat(32)}`), "object ID");
	const generationId = parsed(parseGenerationId("c".repeat(64)), "generation ID");
	const expectedBytes = Uint8Array.of(0x74, 0x73, 0x2d, 0x64, 0x72, 0x70);
	const undeclaredBytes = Uint8Array.of(0x75, 0x6e, 0x64, 0x65, 0x63, 0x6c, 0x61, 0x72, 0x65, 0x64);
	const digest = parsed(digestBlob(expectedBytes), "blob digest");
	const undeclaredDigest = parsed(digestBlob(undeclaredBytes), "undeclared blob digest");
	const expectedReference: GenerationRef = { digest, byteLength: expectedBytes.byteLength };
	const expectedClosure = [expectedReference] as const;
	const closureDigest = parsed(digestClosure(expectedClosure), "closure digest");
	const baseExpectedHead = { kind: "none", objectId } as const;
	const expectedGeneration = {
		objectId,
		generationId,
		baseExpectedHead,
		closureDigest,
		closure: expectedClosure,
	};

	const initialState = successfulValue(await readQuiescentContractView(store, objectId), "initial split read");
	assertFreshState(initialState, objectId, "initial split read");

	const inputReference = { ...expectedReference };
	const inputClosure: GenerationRef[] = [inputReference];
	const beginPending = store.beginGeneration({ objectId, generationId, baseExpectedHead, closure: inputClosure });
	inputReference.digest = undeclaredDigest;
	inputReference.byteLength = undeclaredBytes.byteLength;
	inputClosure.push({ digest, byteLength: expectedBytes.byteLength + 1 });
	const begun = successfulValue(await beginPending, "beginGeneration");
	assertGeneration(begun, { ...expectedGeneration, state: "Staged" }, "beginGeneration");

	const inputBytes = new Uint8Array(expectedBytes);
	const cachePending = store.putCachedBlob({ objectId, generationId, digest, bytes: inputBytes });
	inputBytes.fill(0);
	const cached = successfulValue(await cachePending, "putCachedBlob");
	if (!isClosedRecord(cached, ["inserted"]) || cached.inserted !== true) {
		contractViolation("putCachedBlob", "expected the first cache insert to report inserted: true");
	}

	const firstBlob = successfulValue(await store.getBlob(digest), "getBlob");
	assertBlob(firstBlob, expectedBytes, inputBytes, "getBlob");
	firstBlob.fill(0);
	const secondBlob = successfulValue(await store.getBlob(digest), "getBlob reread");
	assertBlob(secondBlob, expectedBytes, firstBlob, "getBlob reread");

	const firstState = successfulValue(await readQuiescentContractView(store, objectId), "split read");
	assertObjectState(firstState, { ...expectedGeneration, state: "Staged" }, "split read");
	mutateStateOutput(firstState);
	const secondState = successfulValue(await readQuiescentContractView(store, objectId), "split reread");
	assertObjectState(secondState, { ...expectedGeneration, state: "Staged" }, "split reread");

	const repeatedBegin = await store.beginGeneration({
		objectId,
		generationId,
		baseExpectedHead,
		closure: expectedClosure,
	});
	assertRejection(repeatedBegin, "GENERATION_EXISTS", "repeated beginGeneration");
	const afterRepeatedBegin = successfulValue(
		await readQuiescentContractView(store, objectId),
		"split read after repeated begin"
	);
	assertObjectState(afterRepeatedBegin, { ...expectedGeneration, state: "Staged" }, "split read after repeated begin");
	assertBlob(
		successfulValue(await store.getBlob(digest), "getBlob after repeated begin"),
		expectedBytes,
		undefined,
		"getBlob after repeated begin"
	);

	const undeclaredPut = await store.putCachedBlob({
		objectId,
		generationId,
		digest: undeclaredDigest,
		bytes: new Uint8Array(undeclaredBytes),
	});
	assertRejection(undeclaredPut, "BLOB_NOT_REFERENCED", "undeclared putCachedBlob");
	const afterUndeclaredPut = successfulValue(
		await readQuiescentContractView(store, objectId),
		"split read after undeclared put"
	);
	assertObjectState(afterUndeclaredPut, { ...expectedGeneration, state: "Staged" }, "split read after undeclared put");
	const absentBlob = successfulValue(await store.getBlob(undeclaredDigest), "undeclared getBlob");
	if (absentBlob !== null) contractViolation("undeclared getBlob", "expected no globally published blob");
	assertBlob(
		successfulValue(await store.getBlob(digest), "declared getBlob after undeclared put"),
		expectedBytes,
		undefined,
		"declared getBlob after undeclared put"
	);

	const discarded = successfulValue(await store.discardGeneration({ objectId, generationId }), "discardGeneration");
	assertGeneration(discarded, { ...expectedGeneration, state: "Discarded" }, "discardGeneration");
	const persistedDiscard = successfulValue(
		await readQuiescentContractView(store, objectId),
		"split read after discard"
	);
	assertObjectState(persistedDiscard, { ...expectedGeneration, state: "Discarded" }, "split read after discard");
}

function assertStrictGeneration(
	value: unknown,
	expected: Omit<GenerationRecord, "state"> & { readonly state: GenerationRecord["state"] },
	step: string
): asserts value is GenerationRecord {
	const copied = copyGenerationRecord(value);
	if (
		copied === undefined ||
		copied.objectId !== expected.objectId ||
		copied.generationId !== expected.generationId ||
		copied.baseExpectedHead.kind !== "none" ||
		copied.baseExpectedHead.objectId !== expected.objectId ||
		copied.closureDigest !== expected.closureDigest ||
		copied.state !== expected.state ||
		copied.closure.length !== expected.closure.length
	) {
		return contractViolation(step, `expected the exact ${expected.state} strict generation`);
	}
	for (let index = 0; index < expected.closure.length; index++) {
		if (
			copied.closure[index]?.digest !== expected.closure[index]?.digest ||
			copied.closure[index]?.byteLength !== expected.closure[index]?.byteLength
		) {
			return contractViolation(step, "expected the exact sorted strict closure");
		}
	}
}

async function runStrictLifecycle(store: AheDurableStore): Promise<void> {
	const objectId = parsed(parseStorageObjectId(`strict-contract:${"d".repeat(32)}`), "strict object ID");
	const generationId = parsed(parseGenerationId("d".repeat(64)), "strict generation ID");
	const payloads = [Uint8Array.of(0x73, 0x74, 0x72, 0x69, 0x63, 0x74), Uint8Array.of(0, 1, 2, 3)] as const;
	const closure = payloads
		.map(
			(bytes): GenerationRef => ({
				digest: parsed(digestBlob(bytes), "strict blob digest"),
				byteLength: bytes.byteLength,
			})
		)
		.sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0));
	const closureDigest = parsed(digestClosure(closure), "strict closure digest");
	const baseExpectedHead = { kind: "none", objectId } as const;
	const expectedGeneration = { objectId, generationId, baseExpectedHead, closureDigest, closure };

	const begun = successfulValue(
		await store.beginGeneration({ objectId, generationId, baseExpectedHead, closure }),
		"strict beginGeneration"
	);
	assertStrictGeneration(begun, { ...expectedGeneration, state: "Staged" }, "strict beginGeneration");
	for (const payload of payloads) {
		const digest = parsed(digestBlob(payload), "strict cache digest");
		const cached = successfulValue(
			await store.putCachedBlob({ objectId, generationId, digest, bytes: new Uint8Array(payload) }),
			"strict putCachedBlob"
		);
		if (!isClosedRecord(cached, ["inserted"]) || cached.inserted !== true) {
			contractViolation("strict putCachedBlob", "expected a new immutable blob insert");
		}
		const promoted = successfulValue(
			await store.promoteReference({ objectId, generationId, digest }),
			"strict promoteReference"
		);
		if (promoted !== undefined) {
			contractViolation("strict promoteReference", "expected exact successful undefined promotion value");
		}
	}

	const completed = successfulValue(
		await store.completeGeneration({ objectId, generationId }),
		"strict completeGeneration"
	);
	assertStrictGeneration(completed, { ...expectedGeneration, state: "Complete" }, "strict completeGeneration");
	Reflect.set(completed, "state", "Discarded");
	const beforeSwap = successfulValue(await readQuiescentContractView(store, objectId), "strict split read before swap");
	if (!isClosedRecord(beforeSwap, ["head", "generations"]) || !isClosedArray(beforeSwap.generations)) {
		return contractViolation("strict read before swap", "expected an exact detached object state");
	}
	assertStrictGeneration(
		beforeSwap.generations[0],
		{ ...expectedGeneration, state: "Complete" },
		"strict read before swap"
	);

	const swapped = successfulValue(
		await store.swapHead({ objectId, generationId, expectedHead: baseExpectedHead }),
		"strict swapHead"
	);
	if (
		!isClosedRecord(swapped, ["head", "supersededGenerationId"]) ||
		swapped.supersededGenerationId !== null ||
		!isClosedRecord(swapped.head, ["kind", "objectId", "generationId", "revision", "closureDigest"]) ||
		swapped.head.kind !== "present" ||
		swapped.head.objectId !== objectId ||
		swapped.head.generationId !== generationId ||
		swapped.head.revision !== 1 ||
		swapped.head.closureDigest !== closureDigest
	) {
		return contractViolation("strict swapHead", "expected the exact first adopted head");
	}
	Reflect.set(swapped.head, "objectId", "mutated-output");
	const adopted = successfulValue(await readQuiescentContractView(store, objectId), "strict adopted split reread");
	if (
		!isClosedRecord(adopted, ["head", "generations"]) ||
		!isClosedRecord(adopted.head, ["kind", "objectId", "generationId", "revision", "closureDigest"]) ||
		adopted.head.objectId !== objectId ||
		!isClosedArray(adopted.generations)
	) {
		return contractViolation("strict adopted reread", "returned mutations changed persisted state");
	}
	assertStrictGeneration(adopted.generations[0], { ...expectedGeneration, state: "Adopted" }, "strict adopted reread");
}

async function executeScenario(scenario: StoreContractScenario, context: ContractContext): Promise<void> {
	switch (scenario.id) {
		case "ephemeral-capability": {
			const capabilities: unknown = context.store.capabilities;
			assertCapabilities(capabilities);
			context.capabilities = capabilities;
			return;
		}
		case "begin-cache-read-discard":
			await runCommonLifecycle(context.store);
			return;
		case "strict-transition-closure":
			if (context.capabilities === undefined) {
				return contractViolation(scenario.id, "the capability scenario did not run first");
			}
			if (context.capabilities.durability === "ephemeral") return;
			await runStrictLifecycle(context.store);
			return;
		default: {
			const exhaustiveScenario: never = scenario;
			return exhaustiveScenario;
		}
	}
}

/**
 * Runs every frozen scenario applicable to one honest store capability pair.
 * @param factory - Store factory under contract.
 * @returns The store's immutable capabilities.
 */
export async function runStoreContract(
	factory: StoreContractFactory
): Promise<Readonly<AheDurableStore["capabilities"]>> {
	const store = await factory();
	const context: ContractContext = { store };
	try {
		for (const scenario of STORE_CONTRACT_SCENARIOS) await executeScenario(scenario, context);
		if (context.capabilities === undefined) {
			return contractViolation("runner", "the capability scenario did not run");
		}
	} catch (error) {
		try {
			await store.close();
		} catch {
			// Preserve the primary conformance failure.
		}
		throw error;
	}
	await store.close();
	return context.capabilities;
}
