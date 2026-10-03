// Native-contract material only: no creator authority or historical-custody claim.
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "../../../packages/canonical/dist/src/index.js";
import {
	captureLiveJournalHistoricalAnchorImportInput,
	captureLiveJournalInput,
	captureLiveJournalSignedAnchorReadInput,
	type DurableLiveJournalStore,
} from "../../../packages/live-journal/dist/src/index.js";

export const operations = ["readSignedAnchorEnvelope", "importHistoricalAnchor", "readAnchorPreimage"] as const;
export type Operation = (typeof operations)[number];
export const closed = { kind: "store-closed", ok: false };
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const zero = "0".repeat(64);
const objectId = "native-capture-close:" + "1".repeat(32);
const parameters = encodeCanonical({
	maxDependencies: 1,
	maxEpochBytes: 65536,
	maxEpochVertices: 32,
	maxPendingBytes: 65536,
	maxPendingEntries: 1,
	maxSnapshotBytes: 1048576,
	snapshotChunkBytes: 16384,
});
const anchor = encodeCanonical({
	aclDigest: zero,
	archiveIndexRoot: zero,
	blueprintDigest: zero,
	cryptoSuiteId: "ed25519-sha256-v3",
	cutDigest: zero,
	epoch: 1,
	historyRoot: zero,
	historySize: 1,
	kind: "drp-epoch-anchor",
	objectId,
	parametersDigest: hex(hashDomain("ts-drp/parameters/v3", parameters)),
	previousAnchor: zero,
	profileDigest: zero,
	protocolMajor: 3,
	signerSetDigest: zero,
	stateDigest: zero,
});
const digest = hashDomain("ts-drp/epoch-anchor/v3", anchor);
const key = new Uint8Array(32);
key[0] = 1;
export const envelope = {
	objectId,
	exactCanonicalAnchorPreimageBytes: anchor,
	detachedAnchorSignature: ed25519.sign(digest, key),
	exactCanonicalParametersCarrierBytes: parameters,
};
export const scope = { objectId, epoch: 1, anchorDigest: hex(digest) };
export const maxBytes = 8192 + 64 + 65536;

function input(operation: Operation) {
	return operation === "importHistoricalAnchor"
		? { envelope, maxBytes }
		: { scope, maxBytes: operation === "readAnchorPreimage" ? 8192 : maxBytes };
}
function capture(operation: Operation, value: unknown) {
	if (operation === "importHistoricalAnchor") return captureLiveJournalHistoricalAnchorImportInput(value);
	if (operation === "readSignedAnchorEnvelope") return captureLiveJournalSignedAnchorReadInput(value);
	return captureLiveJournalInput("anchorRead", value);
}

export async function causal(store: DurableLiveJournalStore, operation: Operation) {
	// Same closed shape, same introspection hook, but without shutdown: proves
	// this is an admissible native input rather than a malformed proxy fixture.
	let controlTrapCount = 0;
	const control = capture(
		operation,
		new Proxy(input(operation), {
			getPrototypeOf(target) {
				controlTrapCount++;
				return Reflect.getPrototypeOf(target);
			},
		})
	);
	if (!control.ok || controlTrapCount === 0) throw new Error("NATIVE_CLOSED_INPUT_CONTROL_UNREACHED");
	let trapCount = 0;
	let closePromise: Promise<void> | undefined;
	const value = new Proxy(input(operation), {
		getPrototypeOf(target) {
			trapCount++;
			closePromise ??= store.close();
			return Reflect.getPrototypeOf(target);
		},
	});
	// Do not wrap any method, receiver, promise or native transaction.
	const pending = store[operation](value as never);
	const nativePromise = pending instanceof Promise;
	const result = await pending;
	if (!closePromise || trapCount === 0) throw new Error("CAPTURE_CLOSE_CALLBACK_UNREACHED");
	await closePromise;
	const afterCloseRead = await store.readSignedAnchorEnvelope({ scope, maxBytes });
	const afterCloseImport = await store.importHistoricalAnchor({ envelope, maxBytes });
	return {
		controlCaptureOk: control.ok,
		controlTrapCount,
		trapCount,
		nativePromise,
		closeJoined: true,
		result,
		afterCloseRead,
		afterCloseImport,
	};
}

export async function positive(store: DurableLiveJournalStore) {
	const captured = captureLiveJournalHistoricalAnchorImportInput({ envelope, maxBytes });
	if (!captured.ok) throw new Error("NATIVE_IMPORT_INPUT_NOT_ADMITTED");
	const imported = await store.importHistoricalAnchor({ envelope, maxBytes });
	const read = await store.readSignedAnchorEnvelope({ scope, maxBytes });
	return {
		captureOk: captured.ok,
		importOk: imported.ok,
		readOk: read.ok,
		kind: read.kind,
		exactAnchor:
			read.ok && read.kind === "present" && hex(read.envelope.exactCanonicalAnchorPreimageBytes) === hex(anchor),
	};
}

export function expected(receipt: Awaited<ReturnType<typeof causal>>) {
	return {
		...receipt,
		nativePromise: true,
		closeJoined: true,
		result: closed,
		afterCloseRead: closed,
		afterCloseImport: closed,
		rows: [],
	};
}
