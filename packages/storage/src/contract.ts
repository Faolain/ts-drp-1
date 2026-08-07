import { bytesEqual, copyGenerationRecord, isClosedArray, isClosedRecord } from "./internal/validation.js";
import type { AheDurableStore, GenerationRecord, ParseResult, StoreCapabilities } from "./types.js";
import { digestBlob, digestClosure, parseGenerationId, parseStorageObjectId } from "./values.js";

export type StoreContractFactory = () => AheDurableStore | Promise<AheDurableStore>;

export const STORE_CONTRACT_SCENARIOS = Object.freeze([
	Object.freeze({ id: "ephemeral-capability", branch: "common" }),
	Object.freeze({ id: "begin-cache-read-discard", branch: "common" }),
	Object.freeze({ id: "strict-transition-closure", branch: "strict" }),
] as const);

function contractViolation(step: string, detail: string): never {
	throw new Error(`AheDurableStore contract violation at ${step}: ${detail}`);
}

function parsed<T>(result: ParseResult<T>, label: string): T {
	if (!result.ok) return contractViolation("fixture", `${label} was not canonical`);
	return result.value;
}

function successfulValue(result: unknown, step: string): unknown {
	if (!isClosedRecord(result, ["ok", "value"]) || result.ok !== true) {
		return contractViolation(step, "expected an exact successful StoreResult");
	}
	return result.value;
}

function assertEphemeralCapabilities(value: unknown): asserts value is Readonly<StoreCapabilities> {
	if (
		!isClosedRecord(value, ["durability", "signingEligibility"]) ||
		value.durability !== "ephemeral" ||
		value.signingEligibility !== "never" ||
		!Object.isFrozen(value)
	) {
		contractViolation("ephemeral-capability", "expected frozen ephemeral/never capabilities");
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

async function runEphemeralLifecycle(store: AheDurableStore): Promise<void> {
	const objectId = parsed(parseStorageObjectId(`contract-runner:${"c".repeat(32)}`), "object ID");
	const generationId = parsed(parseGenerationId("c".repeat(64)), "generation ID");
	const expectedBytes = Uint8Array.of(0x74, 0x73, 0x2d, 0x64, 0x72, 0x70);
	const inputBytes = new Uint8Array(expectedBytes);
	const digest = parsed(digestBlob(expectedBytes), "blob digest");
	const closure = [{ digest, byteLength: expectedBytes.byteLength }] as const;
	const closureDigest = parsed(digestClosure(closure), "closure digest");
	const baseExpectedHead = { kind: "none", objectId } as const;
	const expectedGeneration = { objectId, generationId, baseExpectedHead, closureDigest, closure };

	const begun = successfulValue(
		await store.beginGeneration({ objectId, generationId, baseExpectedHead, closure }),
		"beginGeneration"
	);
	assertGeneration(begun, { ...expectedGeneration, state: "Staged" }, "beginGeneration");

	const cached = successfulValue(
		await store.putCachedBlob({ objectId, generationId, digest, bytes: inputBytes }),
		"putCachedBlob"
	);
	if (!isClosedRecord(cached, ["inserted"]) || cached.inserted !== true) {
		contractViolation("putCachedBlob", "expected the first cache insert to report inserted: true");
	}
	inputBytes.fill(0);

	const blob = successfulValue(await store.getBlob(digest), "getBlob");
	if (!(blob instanceof Uint8Array) || blob === inputBytes || !bytesEqual(blob, expectedBytes)) {
		contractViolation("getBlob", "expected detached bytes matching the cached payload");
	}

	const state = successfulValue(await store.readObjectState(objectId), "readObjectState");
	if (
		!isClosedRecord(state, ["head", "generations"]) ||
		!isClosedRecord(state.head, ["kind", "objectId"]) ||
		state.head.kind !== "none" ||
		state.head.objectId !== objectId ||
		!isClosedArray(state.generations) ||
		state.generations.length !== 1
	) {
		contractViolation("readObjectState", "expected one staged generation under an unchanged no-head");
	}
	assertGeneration(state.generations[0], { ...expectedGeneration, state: "Staged" }, "readObjectState");

	const discarded = successfulValue(await store.discardGeneration({ objectId, generationId }), "discardGeneration");
	assertGeneration(discarded, { ...expectedGeneration, state: "Discarded" }, "discardGeneration");
}

/**
 * Runs the 2a common branch without pretending that an ephemeral factory can
 * satisfy the frozen strict branch.
 * @param factory - Store factory under contract.
 * @returns The store's immutable capabilities.
 */
export async function runStoreContract(
	factory: StoreContractFactory
): Promise<Readonly<AheDurableStore["capabilities"]>> {
	const store = await factory();
	let capabilities: Readonly<StoreCapabilities> | undefined;
	try {
		for (const scenario of STORE_CONTRACT_SCENARIOS) {
			if (scenario.id === "ephemeral-capability") {
				const observedCapabilities: unknown = store.capabilities;
				assertEphemeralCapabilities(observedCapabilities);
				capabilities = observedCapabilities;
			} else if (scenario.id === "begin-cache-read-discard") {
				await runEphemeralLifecycle(store);
			}
		}
		if (capabilities === undefined) contractViolation("runner", "the capability scenario did not run");
	} catch (error) {
		try {
			await store.close();
		} catch {
			// Preserve the primary conformance failure.
		}
		throw error;
	}
	await store.close();
	return capabilities;
}
