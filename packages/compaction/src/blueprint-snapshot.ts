import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createDomainHashStream, type DomainHashStream } from "@ts-drp/canonical/domain-hash-stream";
import type { PreparedBlueprintRuntime } from "@ts-drp/protocol-v3/blueprint-application";

import { BlueprintStateMachine } from "./blueprint-fold.js";
import { copyExactByteCarrier, copyTrustedBytes } from "./exact-byte-carrier.js";

const PAYLOAD_DOMAIN = "ts-drp/snapshot-payload/v3";
const STATE_DOMAIN = "ts-drp/state/v3";
const PAYLOAD_FIELDS = Object.freeze([
	"acl",
	"anchor",
	"application",
	"archiveIndexRoot",
	"blueprintDigest",
	"epoch",
	"kind",
	"objectId",
	"protocolMajor",
	"schemaVersion",
] as const);
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicObjectPrototype = Object.prototype;
const intrinsicReflectApply = Reflect.apply;
const intrinsicReflectOwnKeys = Reflect.ownKeys;
const blueprintStateMachineSnapshot = BlueprintStateMachine.prototype.snapshot;

export interface BlueprintSnapshotMetadata {
	readonly anchor: string;
	readonly archiveIndexRoot: string;
	readonly epoch: number;
	readonly objectId: string;
	readonly schemaVersion: number;
}

export interface ExportBlueprintSnapshotPayloadInput extends BlueprintSnapshotMetadata {
	readonly exactCanonicalAclBytes: Uint8Array;
	readonly machine: BlueprintStateMachine;
	readonly maxSnapshotBytes: number;
}

export interface ExportedBlueprintSnapshotPayload {
	readonly applicationStateDigest: string;
	readonly exactCanonicalPayloadBytes: Uint8Array;
	readonly payloadDigest: string;
}

export interface ImportBlueprintSnapshotPayloadInput {
	readonly exactCanonicalPayloadBytes: Uint8Array;
	readonly expectedAnchor: string;
	readonly expectedApplicationStateDigest: string;
	readonly expectedArchiveIndexRoot: string;
	readonly expectedBlueprintDigest: string;
	readonly expectedEpoch: number;
	readonly expectedExactCanonicalAclBytes: Uint8Array;
	readonly expectedObjectId: string;
	readonly expectedPayloadDigest: string;
	readonly expectedSchemaVersion: number;
	readonly maxSnapshotBytes: number;
	readonly preparedBlueprintRuntime: PreparedBlueprintRuntime;
}

export interface ImportedBlueprintSnapshotPayload extends ExportedBlueprintSnapshotPayload, BlueprintSnapshotMetadata {
	readonly acl: unknown;
	readonly blueprintDigest: string;
	readonly exactCanonicalAclBytes: Uint8Array;
	readonly machine: BlueprintStateMachine;
}

function hex(bytes: Uint8Array): string {
	let output = "";
	for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
	return output;
}

function digest(domain: string, bytes: Uint8Array): string {
	return hex(hashDomain(domain, bytes));
}

/** Creates the shared running D.99 snapshot-payload digest owner. */
export function createBlueprintSnapshotPayloadHashStream(exactByteLength: number): DomainHashStream {
	return createDomainHashStream(PAYLOAD_DOMAIN, exactByteLength);
}

function snapshotPayloadDigest(bytes: Uint8Array): string {
	const stream = createBlueprintSnapshotPayloadHashStream(bytes.byteLength);
	stream.update(bytes);
	return hex(stream.digest());
}

function assertDigest(value: string, name: string): void {
	if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${name} must be a lowercase 32-byte digest`);
}

function assertSafeInteger(value: number, minimum: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} is invalid`);
}

function assertMetadata(value: BlueprintSnapshotMetadata): void {
	assertDigest(value.anchor, "anchor");
	assertDigest(value.archiveIndexRoot, "archiveIndexRoot");
	assertSafeInteger(value.epoch, 0, "epoch");
	assertSafeInteger(value.schemaVersion, 1, "schemaVersion");
	if (typeof value.objectId !== "string" || value.objectId.length === 0 || value.objectId.length > 1024) {
		throw new TypeError("objectId is invalid");
	}
}

function assertMaximum(value: number): void {
	assertSafeInteger(value, 1, "maxSnapshotBytes");
}

function exactPayloadRecord(value: unknown): Record<(typeof PAYLOAD_FIELDS)[number], unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("snapshot payload must be an ordinary record");
	}
	const prototype = intrinsicObjectGetPrototypeOf(value);
	if (prototype !== null && prototype !== intrinsicObjectPrototype) {
		throw new TypeError("snapshot payload must be an ordinary record");
	}
	const ownKeys = intrinsicReflectOwnKeys(value);
	if (
		ownKeys.length !== PAYLOAD_FIELDS.length ||
		ownKeys.some((key) => typeof key !== "string" || !PAYLOAD_FIELDS.includes(key as (typeof PAYLOAD_FIELDS)[number]))
	) {
		throw new TypeError("snapshot payload fields are invalid");
	}
	const output = {} as Record<(typeof PAYLOAD_FIELDS)[number], unknown>;
	for (const key of PAYLOAD_FIELDS) {
		const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
			throw new TypeError(`snapshot payload.${key} must be an own enumerable data property`);
		}
		output[key] = descriptor.value;
	}
	return output;
}

function decodeExactCanonical(bytes: Uint8Array, name: string, maxBytes?: number): unknown {
	const limits = maxBytes === undefined ? undefined : { maxBytes };
	const decoded = decodeCanonical(bytes, limits);
	if (compareBytes(bytes, encodeCanonical(decoded, limits)) !== 0) {
		throw new TypeError(`${name} must use canonical encoding`);
	}
	return decoded;
}

function sameValue(actual: unknown, expected: unknown, name: string): void {
	if (actual !== expected) throw new TypeError(`${name} does not match the expected value`);
}

function checkedPayloadBytes(payload: Readonly<Record<string, unknown>>, maximum: number): Uint8Array {
	const bytes = encodeCanonical(payload, { maxBytes: maximum });
	if (bytes.byteLength > maximum) throw new RangeError("snapshot payload exceeds maxSnapshotBytes");
	return bytes;
}

/** Exports one exact, bounded v3 snapshot payload without mutating the live machine. */
export function exportBlueprintSnapshotPayload(
	input: ExportBlueprintSnapshotPayloadInput
): ExportedBlueprintSnapshotPayload {
	assertMaximum(input.maxSnapshotBytes);
	assertMetadata(input);
	const aclBytes = copyExactByteCarrier(input.exactCanonicalAclBytes, "exactCanonicalAclBytes", {
		maxBytes: input.maxSnapshotBytes,
	});
	const acl = decodeExactCanonical(aclBytes, "ACL bytes", input.maxSnapshotBytes);
	if (intrinsicObjectGetPrototypeOf(input.machine) !== BlueprintStateMachine.prototype) {
		throw new TypeError("machine must be a genuine BlueprintStateMachine");
	}
	const snapshot = intrinsicReflectApply(blueprintStateMachineSnapshot, input.machine, []);
	assertDigest(snapshot.blueprintDigest, "blueprintDigest");
	assertDigest(snapshot.stateDigest, "applicationStateDigest");
	const application = decodeExactCanonical(snapshot.exactCanonicalStateBytes, "application state bytes");
	const payload = {
		acl,
		anchor: input.anchor,
		application,
		archiveIndexRoot: input.archiveIndexRoot,
		blueprintDigest: snapshot.blueprintDigest,
		epoch: input.epoch,
		kind: "drp-snapshot-payload",
		objectId: input.objectId,
		protocolMajor: 3,
		schemaVersion: input.schemaVersion,
	};
	const exactCanonicalPayloadBytes = checkedPayloadBytes(payload, input.maxSnapshotBytes);
	return Object.freeze({
		applicationStateDigest: snapshot.stateDigest,
		exactCanonicalPayloadBytes,
		payloadDigest: snapshotPayloadDigest(exactCanonicalPayloadBytes),
	});
}

/** Imports an exact payload into a fresh isolated v3 blueprint state machine. */
export function importBlueprintSnapshotPayload(
	input: ImportBlueprintSnapshotPayloadInput
): ImportedBlueprintSnapshotPayload {
	assertMaximum(input.maxSnapshotBytes);
	assertDigest(input.expectedPayloadDigest, "expectedPayloadDigest");
	assertDigest(input.expectedApplicationStateDigest, "expectedApplicationStateDigest");
	assertDigest(input.expectedBlueprintDigest, "expectedBlueprintDigest");
	const payloadBytes = copyExactByteCarrier(input.exactCanonicalPayloadBytes, "exactCanonicalPayloadBytes", {
		maxBytes: input.maxSnapshotBytes,
	});
	if (snapshotPayloadDigest(payloadBytes) !== input.expectedPayloadDigest) {
		throw new TypeError("snapshot payload digest does not match exact bytes");
	}
	const payload = exactPayloadRecord(
		decodeExactCanonical(payloadBytes, "snapshot payload bytes", input.maxSnapshotBytes)
	);
	sameValue(payload.kind, "drp-snapshot-payload", "kind");
	sameValue(payload.protocolMajor, 3, "protocolMajor");
	sameValue(payload.objectId, input.expectedObjectId, "objectId");
	sameValue(payload.epoch, input.expectedEpoch, "epoch");
	sameValue(payload.anchor, input.expectedAnchor, "anchor");
	sameValue(payload.schemaVersion, input.expectedSchemaVersion, "schemaVersion");
	sameValue(payload.blueprintDigest, input.expectedBlueprintDigest, "blueprintDigest");
	sameValue(payload.archiveIndexRoot, input.expectedArchiveIndexRoot, "archiveIndexRoot");
	assertMetadata({
		anchor: input.expectedAnchor,
		archiveIndexRoot: input.expectedArchiveIndexRoot,
		epoch: input.expectedEpoch,
		objectId: input.expectedObjectId,
		schemaVersion: input.expectedSchemaVersion,
	});
	if (input.preparedBlueprintRuntime.blueprintDigest !== input.expectedBlueprintDigest) {
		throw new TypeError("prepared runtime does not match the snapshot blueprint");
	}

	const expectedAclBytes = copyExactByteCarrier(
		input.expectedExactCanonicalAclBytes,
		"expectedExactCanonicalAclBytes",
		{
			maxBytes: input.maxSnapshotBytes,
		}
	);
	decodeExactCanonical(expectedAclBytes, "expected ACL bytes", input.maxSnapshotBytes);
	const embeddedAclBytes = encodeCanonical(payload.acl, { maxBytes: input.maxSnapshotBytes });
	if (compareBytes(embeddedAclBytes, expectedAclBytes) !== 0) {
		throw new TypeError("snapshot ACL does not match the expected exact bytes");
	}
	const exactCanonicalStateBytes = encodeCanonical(payload.application);
	if (digest(STATE_DOMAIN, exactCanonicalStateBytes) !== input.expectedApplicationStateDigest) {
		throw new TypeError("snapshot application state digest does not match");
	}
	const machine = new BlueprintStateMachine({
		exactCanonicalInitialStateBytes: exactCanonicalStateBytes,
		expectedBlueprintDigest: input.expectedBlueprintDigest,
		expectedInitialStateDigest: input.expectedApplicationStateDigest,
		preparedBlueprintRuntime: input.preparedBlueprintRuntime,
	});
	return Object.freeze({
		acl: decodeCanonical(expectedAclBytes),
		anchor: input.expectedAnchor,
		applicationStateDigest: input.expectedApplicationStateDigest,
		archiveIndexRoot: input.expectedArchiveIndexRoot,
		blueprintDigest: input.expectedBlueprintDigest,
		epoch: input.expectedEpoch,
		exactCanonicalAclBytes: copyTrustedBytes(expectedAclBytes),
		exactCanonicalPayloadBytes: copyTrustedBytes(payloadBytes),
		machine,
		objectId: input.expectedObjectId,
		payloadDigest: input.expectedPayloadDigest,
		schemaVersion: input.expectedSchemaVersion,
	});
}
