import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { parseStorageObjectId } from "@ts-drp/storage";

import { LIVE_JOURNAL_DOMAINS } from "./types.js";
import type {
	LiveJournalAcceptedRow,
	LiveJournalFailureKind,
	LiveJournalScope,
	LiveJournalSnapshotToken,
} from "./types.js";

const ownKeys = Reflect.ownKeys.bind(Reflect);
const getPrototypeOf = Object.getPrototypeOf.bind(Object);
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const arrayIsArray = Array.isArray.bind(Array);
const numberIsSafeInteger = Number.isSafeInteger.bind(Number);
const objectFreeze = Object.freeze.bind(Object);

const SCOPE_KEYS = ["anchorDigest", "epoch", "objectId"] as const;
const INSTALL_KEYS = [
	"detachedAnchorSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"objectId",
] as const;
const RECEIVED_KEYS = [
	"detachedSignature",
	"exactCanonicalPreimageBytes",
	"scope",
	"sourceKind",
	"vertexDigest",
] as const;
const LOCAL_KEYS = ["author", "authorSequence", "scope", "sourceKind", "vertexDigest"] as const;
const READINESS_KEYS = ["scope"] as const;
const TOKEN_KEYS = [
	"genesisDigest",
	"highWatermark",
	"kind",
	"orderedRowDigest",
	"parametersDigest",
	"scope",
	"snapshotDigest",
] as const;
const STORED_SCOPE_KEYS = [
	"detachedAnchorSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"nextJournalSequence",
	"parametersDigest",
	"scope",
] as const;
const STORED_RECEIVED_KEYS = [
	"detachedSignature",
	"exactCanonicalPreimageBytes",
	"journalSequence",
	"scope",
	"sourceKind",
	"vertexDigest",
] as const;
const STORED_LOCAL_KEYS = [
	"author",
	"authorSequence",
	"journalSequence",
	"scope",
	"sourceKind",
	"vertexDigest",
] as const;
const DURABLE_SNAPSHOT_KEYS = ["rows", "scope"] as const;
const ADDRESSED_OBSERVATION_KEYS = ["kind", "row", "scope"] as const;
const APPEND_TARGET_KEYS = ["kind", "row"] as const;
const ANCHOR_KEYS = [
	"aclDigest",
	"archiveIndexRoot",
	"blueprintDigest",
	"cryptoSuiteId",
	"cutDigest",
	"epoch",
	"historyRoot",
	"historySize",
	"kind",
	"objectId",
	"parametersDigest",
	"previousAnchor",
	"profileDigest",
	"protocolMajor",
	"signerSetDigest",
	"stateDigest",
] as const;
const PARAMETER_KEYS = [
	"maxDependencies",
	"maxEpochBytes",
	"maxEpochVertices",
	"maxPendingBytes",
	"maxPendingEntries",
	"maxSnapshotBytes",
	"snapshotChunkBytes",
] as const;
const VERTEX_KEYS = [
	"anchor",
	"author",
	"authorSequence",
	"dependencies",
	"epoch",
	"kind",
	"logicalTime",
	"objectId",
	"operation",
	"protocolMajor",
] as const;

interface LiveJournalStoredScope {
	readonly scope: LiveJournalScope;
	readonly nextJournalSequence: number;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly detachedAnchorSignature: Uint8Array;
	readonly parametersDigest: string;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
}

type LiveJournalStoredRow = LiveJournalAcceptedRow;
type LiveJournalPendingRow =
	| Omit<Extract<LiveJournalStoredRow, { readonly sourceKind: "received" }>, "journalSequence">
	| Omit<Extract<LiveJournalStoredRow, { readonly sourceKind: "local-issued" }>, "journalSequence">;

interface LiveJournalDurableSnapshot {
	readonly scope: LiveJournalStoredScope;
	readonly rows: readonly LiveJournalStoredRow[];
}

type CapturedInstall = Readonly<{
	readonly stored: LiveJournalStoredScope;
	readonly parametersDigest: string;
}>;

type CapturedPage = Readonly<{
	readonly afterSequence: number;
	readonly limit: number;
	readonly scope: LiveJournalScope;
	readonly snapshot: LiveJournalSnapshotToken;
}>;

type Captured<T> =
	| Readonly<{ readonly ok: true; readonly value: T }>
	| Readonly<{ readonly ok: false; readonly kind: LiveJournalFailureKind }>;

type ExistingRowProbe = Readonly<{
	readonly sourceKind: "received" | "local-issued";
	readonly vertexDigest: string;
	readonly journalSequence: number;
	readonly author?: string;
	readonly authorSequence?: number;
	readonly exactCanonicalPreimageBytes?: Uint8Array;
	readonly detachedSignature?: Uint8Array;
}>;

type DuplicateProbe = Readonly<{
	readonly candidate: LiveJournalPendingRow;
	readonly digestRow: ExistingRowProbe | null;
	readonly referenceRow: ExistingRowProbe | null;
}>;

type DuplicateDecision =
	| Readonly<{ readonly action: "append" }>
	| Readonly<{ readonly action: "conflict" }>
	| Readonly<{
			readonly action: "idempotent";
			readonly journalSequence: number;
			readonly sourceKind: "received" | "local-issued";
	  }>;

type MutationTarget =
	| Readonly<{ readonly kind: "install"; readonly scope: LiveJournalStoredScope }>
	| Readonly<{ readonly kind: "append"; readonly row: LiveJournalStoredRow }>;

type MutationObservationInput = Readonly<{
	readonly actual: LiveJournalDurableSnapshot | null | undefined;
	readonly before: LiveJournalDurableSnapshot | null;
	readonly target: MutationTarget;
}>;

type MutationDecision = "exact-new" | "exact-old" | "mixed" | "unreadable";

function failure(kind: LiveJournalFailureKind): Captured<never> {
	return objectFreeze({ kind, ok: false });
}

function snapshotRecord(
	value: unknown,
	keys: readonly string[],
	requireOrdinaryPrototype = false
): Readonly<Record<string, unknown>> | undefined {
	try {
		if (typeof value !== "object" || value === null || arrayIsArray(value)) return undefined;
		const prototype = getPrototypeOf(value);
		if (prototype !== Object.prototype && (requireOrdinaryPrototype || prototype !== null)) return undefined;
		const actual = ownKeys(value);
		if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
			return undefined;
		}
		const captured: Record<string, unknown> = {};
		for (const key of keys) {
			const descriptor = getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
			captured[key] = descriptor.value;
		}
		return captured;
	} catch {
		return undefined;
	}
}

function copyBytes(value: unknown, exactLength?: number): Uint8Array | undefined {
	try {
		if (!(value instanceof Uint8Array) || value.byteLength === 0) return undefined;
		if (exactLength !== undefined && value.byteLength !== exactLength) return undefined;
		if (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) return undefined;
		return new Uint8Array(value);
	} catch {
		return undefined;
	}
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
	return true;
}

function lowerHex(bytes: Uint8Array): string {
	let output = "";
	for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
	return output;
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function validText(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}

function isSafeIntegerBetween(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
	return numberIsSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function exactDecoded(bytes: Uint8Array, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(bytes);
		if (typeof decoded !== "object" || decoded === null || arrayIsArray(decoded)) return undefined;
		const decodedKeys = Object.keys(decoded);
		if (decodedKeys.length !== keys.length || decodedKeys.some((key) => !keys.includes(key))) return undefined;
		if (!bytesEqual(encodeCanonical(decoded), bytes)) return undefined;
		return decoded as Readonly<Record<string, unknown>>;
	} catch {
		return undefined;
	}
}

function copyScope(value: unknown, requireOrdinaryPrototype = false): LiveJournalScope | undefined {
	const record = snapshotRecord(value, SCOPE_KEYS, requireOrdinaryPrototype);
	if (record === undefined) return undefined;
	const { anchorDigest, epoch, objectId } = record;
	if (typeof objectId !== "string" || !parseStorageObjectId(objectId).ok || epoch !== 0 || !isDigest(anchorDigest)) {
		return undefined;
	}
	return objectFreeze({ anchorDigest, epoch: 0, objectId });
}

function cloneScope(scope: LiveJournalScope): LiveJournalScope {
	return objectFreeze({ anchorDigest: scope.anchorDigest, epoch: 0, objectId: scope.objectId });
}

function sameScope(left: LiveJournalScope, right: LiveJournalScope): boolean {
	return left.objectId === right.objectId && left.epoch === right.epoch && left.anchorDigest === right.anchorDigest;
}

function validateAnchor(anchor: Readonly<Record<string, unknown>>): boolean {
	if (
		anchor.kind !== "drp-epoch-anchor" ||
		anchor.protocolMajor !== 3 ||
		typeof anchor.objectId !== "string" ||
		anchor.objectId.length < 1 ||
		anchor.objectId.length > 1024 ||
		!isSafeIntegerBetween(anchor.epoch, 0) ||
		!isSafeIntegerBetween(anchor.historySize, 0) ||
		(anchor.cryptoSuiteId !== "ed25519-sha256-v3" && anchor.cryptoSuiteId !== "ed25519-seal-v3")
	) {
		return false;
	}
	for (const key of [
		"previousAnchor",
		"cutDigest",
		"stateDigest",
		"aclDigest",
		"historyRoot",
		"archiveIndexRoot",
		"blueprintDigest",
		"signerSetDigest",
		"parametersDigest",
		"profileDigest",
	] as const) {
		if (!isDigest(anchor[key])) return false;
	}
	return true;
}

function validateParameters(parameters: Readonly<Record<string, unknown>>): boolean {
	for (const [key, minimum, maximum] of [
		["maxEpochVertices", 32, 1_000_000],
		["maxEpochBytes", 65_536, 1_073_741_824],
		["maxDependencies", 1, 256],
		["snapshotChunkBytes", 16_384, 1_048_576],
		["maxSnapshotBytes", 1_048_576, 4_294_967_296],
		["maxPendingEntries", 1, 1_000_000],
		["maxPendingBytes", 65_536, 1_073_741_824],
	] as const) {
		if (!isSafeIntegerBetween(parameters[key], minimum, maximum)) return false;
	}
	return true;
}

function validateVertex(vertex: Readonly<Record<string, unknown>>): boolean {
	let operationIsCanonicalObject = false;
	try {
		const operation = vertex.operation;
		if (typeof operation === "object" && operation !== null && !arrayIsArray(operation)) {
			const prototype = getPrototypeOf(operation);
			operationIsCanonicalObject = prototype === Object.prototype || prototype === null;
		}
	} catch {
		return false;
	}
	if (
		vertex.kind !== "drp-vertex" ||
		vertex.protocolMajor !== 3 ||
		typeof vertex.objectId !== "string" ||
		vertex.objectId.length < 1 ||
		vertex.objectId.length > 1024 ||
		!isSafeIntegerBetween(vertex.epoch, 0) ||
		!isDigest(vertex.anchor) ||
		typeof vertex.author !== "string" ||
		vertex.author.length < 1 ||
		vertex.author.length > 1024 ||
		!isSafeIntegerBetween(vertex.authorSequence, 0) ||
		!isSafeIntegerBetween(vertex.logicalTime, 1) ||
		!arrayIsArray(vertex.dependencies) ||
		vertex.dependencies.length < 1 ||
		!operationIsCanonicalObject
	) {
		return false;
	}
	let previous: string | undefined;
	for (const dependency of vertex.dependencies) {
		if (!isDigest(dependency) || (previous !== undefined && previous >= dependency)) return false;
		previous = dependency;
	}
	return true;
}

function captureInstall(input: unknown): Captured<CapturedInstall> {
	const record = snapshotRecord(input, INSTALL_KEYS);
	if (record === undefined) return failure("malformed-input");
	const objectId = record.objectId;
	const anchorBytes = copyBytes(record.exactCanonicalAnchorPreimageBytes);
	const signature = copyBytes(record.detachedAnchorSignature, 64);
	const parametersBytes = copyBytes(record.exactCanonicalParametersCarrierBytes);
	if (
		typeof objectId !== "string" ||
		!parseStorageObjectId(objectId).ok ||
		anchorBytes === undefined ||
		signature === undefined ||
		parametersBytes === undefined
	) {
		return failure("malformed-input");
	}
	const anchor = exactDecoded(anchorBytes, ANCHOR_KEYS);
	const parameters = exactDecoded(parametersBytes, PARAMETER_KEYS);
	if (anchor === undefined || parameters === undefined || !validateAnchor(anchor) || !validateParameters(parameters)) {
		return failure("noncanonical-preimage");
	}
	if (anchor.objectId !== objectId) return failure("wrong-scope");
	const zero = "0".repeat(64);
	if (anchor.epoch !== 0 || anchor.historySize !== 0 || anchor.previousAnchor !== zero || anchor.cutDigest !== zero) {
		return failure("noncanonical-preimage");
	}
	const parametersDigest = lowerHex(hashDomain("ts-drp/parameters/v3", parametersBytes));
	if (anchor.parametersDigest !== parametersDigest) return failure("digest-mismatch");
	const anchorDigest = lowerHex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
	const scope = objectFreeze({ anchorDigest, epoch: 0 as const, objectId });
	return objectFreeze({
		ok: true,
		value: objectFreeze({
			parametersDigest,
			stored: objectFreeze({
				detachedAnchorSignature: signature,
				exactCanonicalAnchorPreimageBytes: anchorBytes,
				exactCanonicalParametersCarrierBytes: parametersBytes,
				nextJournalSequence: 0,
				parametersDigest,
				scope,
			}),
		}),
	});
}

function captureAppend(input: unknown): Captured<LiveJournalPendingRow> {
	try {
		if (typeof input !== "object" || input === null) return failure("malformed-input");
		const sourceDescriptor = getOwnPropertyDescriptor(input, "sourceKind");
		if (sourceDescriptor === undefined || !("value" in sourceDescriptor)) return failure("malformed-input");
		const sourceKind = sourceDescriptor.value;
		const keys = sourceKind === "received" ? RECEIVED_KEYS : sourceKind === "local-issued" ? LOCAL_KEYS : undefined;
		if (keys === undefined) return failure("malformed-input");
		const record = snapshotRecord(input, keys);
		if (record === undefined) return failure("malformed-input");
		const scope = copyScope(record.scope);
		const vertexDigest = record.vertexDigest;
		if (scope === undefined || !isDigest(vertexDigest)) return failure("malformed-input");
		if (sourceKind === "received") {
			const exactCanonicalPreimageBytes = copyBytes(record.exactCanonicalPreimageBytes);
			const detachedSignature = copyBytes(record.detachedSignature, 64);
			if (exactCanonicalPreimageBytes === undefined || detachedSignature === undefined) {
				return failure("malformed-input");
			}
			return objectFreeze({
				ok: true,
				value: objectFreeze({
					detachedSignature,
					exactCanonicalPreimageBytes,
					scope,
					sourceKind: "received" as const,
					vertexDigest,
				}),
			});
		}
		const author = record.author;
		const authorSequence = record.authorSequence;
		if (!validText(author) || !isSafeIntegerBetween(authorSequence, 0)) return failure("malformed-input");
		return objectFreeze({
			ok: true,
			value: objectFreeze({
				author,
				authorSequence,
				scope,
				sourceKind: "local-issued" as const,
				vertexDigest,
			}),
		});
	} catch {
		return failure("malformed-input");
	}
}

function validateReceived(candidate: LiveJournalPendingRow): Captured<LiveJournalPendingRow> {
	if (candidate.sourceKind !== "received") return objectFreeze({ ok: true, value: candidate });
	const vertex = exactDecoded(candidate.exactCanonicalPreimageBytes, VERTEX_KEYS);
	if (vertex === undefined || !validateVertex(vertex)) return failure("noncanonical-preimage");
	if (
		vertex.objectId !== candidate.scope.objectId ||
		vertex.epoch !== candidate.scope.epoch ||
		vertex.anchor !== candidate.scope.anchorDigest
	) {
		return failure("wrong-scope");
	}
	if (lowerHex(hashDomain("ts-drp/vertex/v3", candidate.exactCanonicalPreimageBytes)) !== candidate.vertexDigest) {
		return failure("digest-mismatch");
	}
	return objectFreeze({ ok: true, value: candidate });
}

function captureReadiness(input: unknown): Captured<LiveJournalScope> {
	const record = snapshotRecord(input, READINESS_KEYS);
	if (record === undefined) return failure("malformed-input");
	const scope = copyScope(record.scope);
	return scope === undefined ? failure("malformed-input") : objectFreeze({ ok: true, value: scope });
}

function copyToken(value: unknown): LiveJournalSnapshotToken | undefined {
	const record = snapshotRecord(value, TOKEN_KEYS);
	if (record === undefined) return undefined;
	const scope = copyScope(record.scope);
	if (
		scope === undefined ||
		record.kind !== "v3-live-journal-snapshot-token-1" ||
		!isSafeIntegerBetween(record.highWatermark, 0) ||
		!isDigest(record.genesisDigest) ||
		!isDigest(record.parametersDigest) ||
		!isDigest(record.orderedRowDigest) ||
		!isDigest(record.snapshotDigest)
	) {
		return undefined;
	}
	return objectFreeze({
		genesisDigest: record.genesisDigest,
		highWatermark: record.highWatermark,
		kind: "v3-live-journal-snapshot-token-1",
		orderedRowDigest: record.orderedRowDigest,
		parametersDigest: record.parametersDigest,
		scope,
		snapshotDigest: record.snapshotDigest,
	});
}

function capturePage(input: unknown): Captured<CapturedPage> {
	try {
		if (typeof input !== "object" || input === null || arrayIsArray(input)) return failure("malformed-input");
		const prototype = getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) return failure("malformed-input");
		const keys = ownKeys(input);
		if (
			keys.some((key) => typeof key !== "string" || !["afterSequence", "limit", "scope", "snapshot"].includes(key)) ||
			!keys.includes("scope") ||
			!keys.includes("snapshot")
		) {
			return failure("malformed-input");
		}
		const record: Record<string, unknown> = {};
		for (const key of keys as string[]) {
			const descriptor = getOwnPropertyDescriptor(input, key);
			if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
				return failure("malformed-input");
			record[key] = descriptor.value;
		}
		const scope = copyScope(record.scope);
		const snapshot = copyToken(record.snapshot);
		if (scope === undefined || snapshot === undefined) return failure("malformed-input");
		if (!sameScope(scope, snapshot.scope)) return failure("wrong-scope");
		const limit = record.limit === undefined ? 64 : record.limit;
		const startsBeforeZero = record.afterSequence === undefined || record.afterSequence === null;
		const afterSequence = startsBeforeZero ? -1 : record.afterSequence;
		if (!isSafeIntegerBetween(limit, 1, 128) || (!startsBeforeZero && !isSafeIntegerBetween(afterSequence, 0))) {
			return failure("malformed-input");
		}
		return objectFreeze({
			ok: true,
			value: objectFreeze({ afterSequence: afterSequence as number, limit, scope, snapshot }),
		});
	} catch {
		return failure("malformed-input");
	}
}

/**
 * Captures one closed public input using only descriptor snapshots and detached byte copies.
 * @param operation - Closed operation discriminator selecting the input contract.
 * @param input - Untrusted public input to capture.
 * @returns A detached immutable value or a closed failure.
 */
export function captureLiveJournalInput(
	operation: "append" | "install" | "page" | "readiness" | "received",
	input: unknown
): Captured<CapturedInstall | CapturedPage | LiveJournalPendingRow | LiveJournalScope> {
	if (operation === "install") return captureInstall(input);
	if (operation === "append") return captureAppend(input);
	if (operation === "readiness") return captureReadiness(input);
	if (operation === "page") return capturePage(input);
	return validateReceived(input as LiveJournalPendingRow);
}

function sameBytesOptional(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
	return left !== undefined && right !== undefined && bytesEqual(left, right);
}

/**
 * Applies the sole digest/local-reference duplicate and conflict precedence table.
 * @param probe - Captured candidate and existing durable rows.
 * @returns The append, idempotent, or conflict decision.
 */
export function decideLiveJournalDuplicate(probe: DuplicateProbe): DuplicateDecision {
	const { candidate, digestRow, referenceRow } = probe;
	if (candidate.sourceKind === "received") {
		if (digestRow === null) return objectFreeze({ action: "append" });
		if (
			digestRow.sourceKind === "received" &&
			(!sameBytesOptional(digestRow.exactCanonicalPreimageBytes, candidate.exactCanonicalPreimageBytes) ||
				!sameBytesOptional(digestRow.detachedSignature, candidate.detachedSignature))
		) {
			return objectFreeze({ action: "conflict" });
		}
		return objectFreeze({
			action: "idempotent",
			journalSequence: digestRow.journalSequence,
			sourceKind: digestRow.sourceKind,
		});
	}
	if (referenceRow !== null && referenceRow.vertexDigest !== candidate.vertexDigest) {
		return objectFreeze({ action: "conflict" });
	}
	if (digestRow !== null && referenceRow !== null && digestRow.journalSequence !== referenceRow.journalSequence) {
		return objectFreeze({ action: "conflict" });
	}
	if (digestRow === null && referenceRow === null) return objectFreeze({ action: "append" });
	if (digestRow === null) return objectFreeze({ action: "conflict" });
	if (
		digestRow.sourceKind === "local-issued" &&
		(digestRow.author !== candidate.author || digestRow.authorSequence !== candidate.authorSequence)
	) {
		return objectFreeze({ action: "conflict" });
	}
	return objectFreeze({
		action: "idempotent",
		journalSequence: digestRow.journalSequence,
		sourceKind: digestRow.sourceKind,
	});
}

function sameInstalledGenesis(left: LiveJournalStoredScope, right: LiveJournalStoredScope): boolean {
	return (
		sameScope(left.scope, right.scope) &&
		left.parametersDigest === right.parametersDigest &&
		bytesEqual(left.exactCanonicalAnchorPreimageBytes, right.exactCanonicalAnchorPreimageBytes) &&
		bytesEqual(left.detachedAnchorSignature, right.detachedAnchorSignature) &&
		bytesEqual(left.exactCanonicalParametersCarrierBytes, right.exactCanonicalParametersCarrierBytes)
	);
}

function sameStoredRow(left: LiveJournalStoredRow, right: LiveJournalStoredRow): boolean {
	if (
		left.sourceKind !== right.sourceKind ||
		!sameScope(left.scope, right.scope) ||
		left.journalSequence !== right.journalSequence ||
		left.vertexDigest !== right.vertexDigest
	) {
		return false;
	}
	return left.sourceKind === "received" && right.sourceKind === "received"
		? bytesEqual(left.exactCanonicalPreimageBytes, right.exactCanonicalPreimageBytes) &&
				bytesEqual(left.detachedSignature, right.detachedSignature)
		: left.sourceKind === "local-issued" &&
				right.sourceKind === "local-issued" &&
				left.author === right.author &&
				left.authorSequence === right.authorSequence;
}

function targetIsPresent(snapshot: LiveJournalDurableSnapshot | null, target: MutationTarget): boolean {
	if (snapshot === null) return false;
	if (target.kind === "install") {
		return sameInstalledGenesis(snapshot.scope, target.scope);
	}
	const row = snapshot.rows.find(({ journalSequence }) => journalSequence === target.row.journalSequence);
	return (
		row !== undefined &&
		sameStoredRow(row, target.row) &&
		snapshot.scope.nextJournalSequence > target.row.journalSequence
	);
}

function exactBefore(
	snapshot: LiveJournalDurableSnapshot | null,
	before: LiveJournalDurableSnapshot | null,
	target: MutationTarget
): boolean {
	if (target.kind === "install") return snapshot === null && before === null;
	if (snapshot === null || before === null) return false;
	return (
		sameInstalledGenesis(snapshot.scope, before.scope) &&
		before.scope.nextJournalSequence === target.row.journalSequence &&
		snapshot.scope.nextJournalSequence === target.row.journalSequence &&
		!snapshot.rows.some(({ journalSequence }) => journalSequence === target.row.journalSequence)
	);
}

/**
 * Classifies one postcommit target closure while permitting unrelated later appends.
 * @param input - Before, actual, and mutation-target closure.
 * @returns The exact-new, exact-old, mixed, or unreadable classification.
 */
export function classifyLiveJournalMutationObservation(input: MutationObservationInput): MutationDecision {
	try {
		if (input.actual === undefined) return "unreadable";
		const addressedBefore = captureAddressedObservation(input.before);
		const addressedActual = captureAddressedObservation(input.actual);
		if (addressedBefore !== undefined || addressedActual !== undefined) {
			const target = captureAppendTarget(input.target);
			if (addressedBefore === undefined || addressedActual === undefined || target === undefined) return "mixed";
			if (
				addressedBefore.row !== null ||
				!sameScope(addressedBefore.scope.scope, target.row.scope) ||
				addressedBefore.scope.nextJournalSequence !== target.row.journalSequence
			) {
				return "mixed";
			}
			if (
				addressedActual.row !== null &&
				sameInstalledGenesis(addressedActual.scope, addressedBefore.scope) &&
				sameStoredRow(addressedActual.row, target.row) &&
				addressedActual.scope.nextJournalSequence === target.row.journalSequence + 1
			) {
				return "exact-new";
			}
			if (
				addressedActual.row === null &&
				sameInstalledGenesis(addressedActual.scope, addressedBefore.scope) &&
				addressedActual.scope.nextJournalSequence === target.row.journalSequence
			) {
				return "exact-old";
			}
			return "mixed";
		}
		const actual = input.actual === null ? null : captureDurableSnapshot(input.actual);
		if (actual === undefined) return "mixed";
		let before: LiveJournalDurableSnapshot | null = null;
		if (input.before !== null) {
			const beforeScope = captureStoredScope(input.before.scope);
			if (beforeScope === undefined) return "mixed";
			before = { rows: [], scope: beforeScope };
		}
		let target: MutationTarget | undefined;
		if (input.target.kind === "install") {
			const scope = captureStoredScope(input.target.scope);
			target = scope === undefined ? undefined : { kind: "install", scope };
		} else {
			const row = captureStoredRow(input.target.row);
			target = row === undefined ? undefined : { kind: "append", row };
		}
		if (target === undefined) return "mixed";
		if (targetIsPresent(actual, target)) return "exact-new";
		if (exactBefore(actual, before, target)) return "exact-old";
		return "mixed";
	} catch {
		return "mixed";
	}
}

function captureAddressedObservation(
	value: unknown
): Readonly<{ readonly row: LiveJournalStoredRow | null; readonly scope: LiveJournalStoredScope }> | undefined {
	const record = snapshotRecord(value, ADDRESSED_OBSERVATION_KEYS, true);
	if (record === undefined || record.kind !== "append-addressed") return undefined;
	const scope = captureStoredScope(record.scope, true);
	const row = record.row === null ? null : captureStoredRow(record.row, true);
	return scope === undefined || row === undefined ? undefined : { row, scope };
}

function captureAppendTarget(value: unknown): Extract<MutationTarget, { readonly kind: "append" }> | undefined {
	const record = snapshotRecord(value, APPEND_TARGET_KEYS, true);
	if (record === undefined || record.kind !== "append") return undefined;
	const row = captureStoredRow(record.row, true);
	return row === undefined ? undefined : { kind: "append", row };
}

function captureStoredScope(value: unknown, requireOrdinaryPrototype = false): LiveJournalStoredScope | undefined {
	const record = snapshotRecord(value, STORED_SCOPE_KEYS, requireOrdinaryPrototype);
	if (record === undefined) return undefined;
	const scope = copyScope(record.scope, requireOrdinaryPrototype);
	const anchor = copyBytes(record.exactCanonicalAnchorPreimageBytes);
	const signature = copyBytes(record.detachedAnchorSignature, 64);
	const parameters = copyBytes(record.exactCanonicalParametersCarrierBytes);
	if (
		scope === undefined ||
		anchor === undefined ||
		signature === undefined ||
		parameters === undefined ||
		!isDigest(record.parametersDigest) ||
		!isSafeIntegerBetween(record.nextJournalSequence, 0)
	) {
		return undefined;
	}
	return {
		detachedAnchorSignature: signature,
		exactCanonicalAnchorPreimageBytes: anchor,
		exactCanonicalParametersCarrierBytes: parameters,
		nextJournalSequence: record.nextJournalSequence,
		parametersDigest: record.parametersDigest,
		scope,
	};
}

function captureStoredRow(value: unknown, requireOrdinaryPrototype = false): LiveJournalStoredRow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	let sourceKind: unknown;
	try {
		const descriptor = getOwnPropertyDescriptor(value, "sourceKind");
		if (descriptor === undefined || !("value" in descriptor)) return undefined;
		sourceKind = descriptor.value;
	} catch {
		return undefined;
	}
	const keys =
		sourceKind === "received" ? STORED_RECEIVED_KEYS : sourceKind === "local-issued" ? STORED_LOCAL_KEYS : undefined;
	if (keys === undefined) return undefined;
	const record = snapshotRecord(value, keys, requireOrdinaryPrototype);
	if (record === undefined) return undefined;
	const scope = copyScope(record.scope, requireOrdinaryPrototype);
	if (scope === undefined || !isDigest(record.vertexDigest) || !isSafeIntegerBetween(record.journalSequence, 0)) {
		return undefined;
	}
	if (sourceKind === "received") {
		const bytes = copyBytes(record.exactCanonicalPreimageBytes);
		const signature = copyBytes(record.detachedSignature, 64);
		if (bytes === undefined || signature === undefined) return undefined;
		return {
			detachedSignature: signature,
			exactCanonicalPreimageBytes: bytes,
			journalSequence: record.journalSequence,
			scope,
			sourceKind: "received",
			vertexDigest: record.vertexDigest,
		};
	}
	if (!validText(record.author) || !isSafeIntegerBetween(record.authorSequence, 0)) return undefined;
	return {
		author: record.author,
		authorSequence: record.authorSequence,
		journalSequence: record.journalSequence,
		scope,
		sourceKind: "local-issued",
		vertexDigest: record.vertexDigest,
	};
}

function captureDurableSnapshot(value: unknown): LiveJournalDurableSnapshot | undefined {
	const record = snapshotRecord(value, DURABLE_SNAPSHOT_KEYS);
	if (record === undefined || !arrayIsArray(record.rows)) return undefined;
	const scope = captureStoredScope(record.scope);
	if (scope === undefined || record.rows.length !== scope.nextJournalSequence) return undefined;
	try {
		const rows = record.rows.map((row) => captureStoredRow(row));
		if (rows.some((row) => row === undefined)) return undefined;
		return { rows: rows as LiveJournalStoredRow[], scope };
	} catch {
		return undefined;
	}
}

function cloneRow(row: LiveJournalStoredRow): LiveJournalAcceptedRow {
	const scope = cloneScope(row.scope);
	return objectFreeze(
		row.sourceKind === "received"
			? {
					detachedSignature: new Uint8Array(row.detachedSignature),
					exactCanonicalPreimageBytes: new Uint8Array(row.exactCanonicalPreimageBytes),
					journalSequence: row.journalSequence,
					scope,
					sourceKind: "received" as const,
					vertexDigest: row.vertexDigest,
				}
			: {
					author: row.author,
					authorSequence: row.authorSequence,
					journalSequence: row.journalSequence,
					scope,
					sourceKind: "local-issued" as const,
					vertexDigest: row.vertexDigest,
				}
	);
}

function rowCommitment(row: LiveJournalStoredRow): string {
	const preimage =
		row.sourceKind === "received"
			? {
					kind: "v3-live-journal-received-row-1",
					objectId: row.scope.objectId,
					epoch: row.scope.epoch,
					anchorDigest: row.scope.anchorDigest,
					journalSequence: row.journalSequence,
					sourceKind: row.sourceKind,
					vertexDigest: row.vertexDigest,
					exactCanonicalPreimageBytes: row.exactCanonicalPreimageBytes,
					detachedSignature: row.detachedSignature,
				}
			: {
					kind: "v3-live-journal-local-row-1",
					objectId: row.scope.objectId,
					epoch: row.scope.epoch,
					anchorDigest: row.scope.anchorDigest,
					journalSequence: row.journalSequence,
					sourceKind: row.sourceKind,
					vertexDigest: row.vertexDigest,
					author: row.author,
					authorSequence: row.authorSequence,
				};
	return lowerHex(hashDomain(LIVE_JOURNAL_DOMAINS.row, encodeCanonical(preimage)));
}

function deriveToken(snapshot: LiveJournalDurableSnapshot): LiveJournalSnapshotToken | undefined {
	const captured = captureDurableSnapshot(snapshot);
	if (captured === undefined) return undefined;
	const stored = captured.scope;
	const exactRows = captured.rows;
	const digests = new Set<string>();
	const references = new Set<string>();
	for (let index = 0; index < exactRows.length; index++) {
		const row = exactRows[index];
		if (row === undefined || row.journalSequence !== index || !sameScope(row.scope, stored.scope)) return undefined;
		if (digests.has(row.vertexDigest)) return undefined;
		digests.add(row.vertexDigest);
		if (row.sourceKind === "local-issued") {
			const reference = `${row.author.length}:${row.author}:${row.authorSequence}`;
			if (references.has(reference)) return undefined;
			references.add(reference);
		} else {
			const captured = validateReceived(row);
			if (!captured.ok) return undefined;
		}
	}
	const capturedInstall = captureInstall({
		detachedAnchorSignature: stored.detachedAnchorSignature,
		exactCanonicalAnchorPreimageBytes: stored.exactCanonicalAnchorPreimageBytes,
		exactCanonicalParametersCarrierBytes: stored.exactCanonicalParametersCarrierBytes,
		objectId: stored.scope.objectId,
	});
	if (
		!capturedInstall.ok ||
		capturedInstall.value.parametersDigest !== stored.parametersDigest ||
		!sameScope(capturedInstall.value.stored.scope, stored.scope)
	) {
		return undefined;
	}
	const rowCommitmentDigests = exactRows.map(rowCommitment);
	const highWatermark = stored.nextJournalSequence;
	const orderedRowDigest = lowerHex(
		hashDomain(
			LIVE_JOURNAL_DOMAINS.order,
			encodeCanonical({
				kind: "v3-live-journal-order-1",
				objectId: stored.scope.objectId,
				epoch: stored.scope.epoch,
				anchorDigest: stored.scope.anchorDigest,
				highWatermark,
				rowCommitmentDigests,
			})
		)
	);
	const genesisDigest = stored.scope.anchorDigest;
	const snapshotDigest = lowerHex(
		hashDomain(
			LIVE_JOURNAL_DOMAINS.snapshot,
			encodeCanonical({
				kind: "v3-live-journal-snapshot-1",
				objectId: stored.scope.objectId,
				epoch: stored.scope.epoch,
				anchorDigest: stored.scope.anchorDigest,
				highWatermark,
				genesisDigest,
				parametersDigest: stored.parametersDigest,
				orderedRowDigest,
			})
		)
	);
	return objectFreeze({
		genesisDigest,
		highWatermark,
		kind: "v3-live-journal-snapshot-token-1",
		orderedRowDigest,
		parametersDigest: stored.parametersDigest,
		scope: cloneScope(stored.scope),
		snapshotDigest,
	});
}

function tokenEqual(left: LiveJournalSnapshotToken, right: LiveJournalSnapshotToken): boolean {
	return (
		left.kind === right.kind &&
		sameScope(left.scope, right.scope) &&
		left.highWatermark === right.highWatermark &&
		left.genesisDigest === right.genesisDigest &&
		left.parametersDigest === right.parametersDigest &&
		left.orderedRowDigest === right.orderedRowDigest &&
		left.snapshotDigest === right.snapshotDigest
	);
}

type SnapshotDerivationInput = Readonly<{
	readonly durable: LiveJournalDurableSnapshot;
	readonly highWatermark?: number;
	readonly supplied?: LiveJournalSnapshotToken;
}>;

type SnapshotDerivation =
	| Readonly<{
			readonly ok: true;
			readonly rows: readonly LiveJournalAcceptedRow[];
			readonly token: LiveJournalSnapshotToken;
	  }>
	| Readonly<{ readonly ok: false; readonly kind: "digest-mismatch" | "stale-snapshot" | "store-poisoned" }>;

/**
 * Validates one durable prefix and derives its exact immutable replay commitment.
 * @param input - Durable closure and optional page/snapshot constraints.
 * @returns The exact immutable replay prefix and token, or a closed failure.
 */
export function deriveLiveJournalSnapshot(input: SnapshotDerivationInput): SnapshotDerivation {
	try {
		const complete = captureDurableSnapshot(input.durable);
		if (complete === undefined) return objectFreeze({ kind: "store-poisoned", ok: false });
		const completeToken = deriveToken(complete);
		if (completeToken === undefined) return objectFreeze({ kind: "store-poisoned", ok: false });
		const available = complete.scope.nextJournalSequence;
		const highWatermark = input.highWatermark ?? available;
		if (!isSafeIntegerBetween(highWatermark, 0)) return objectFreeze({ kind: "store-poisoned", ok: false });
		if (highWatermark > available) return objectFreeze({ kind: "stale-snapshot", ok: false });
		const durable: LiveJournalDurableSnapshot =
			highWatermark === available
				? complete
				: {
						rows: complete.rows.filter((row) => row.journalSequence < highWatermark),
						scope: { ...complete.scope, nextJournalSequence: highWatermark },
					};
		const token = highWatermark === available ? completeToken : deriveToken(durable);
		if (token === undefined) return objectFreeze({ kind: "store-poisoned", ok: false });
		if (input.supplied !== undefined && !tokenEqual(input.supplied, token)) {
			return objectFreeze({ kind: "digest-mismatch", ok: false });
		}
		return objectFreeze({ ok: true, rows: objectFreeze(durable.rows.map(cloneRow)), token });
	} catch {
		return objectFreeze({ kind: "store-poisoned", ok: false });
	}
}
