/* eslint-disable jsdoc/require-jsdoc -- Phase 3h fixture exports are named directly by their RED contracts. */
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import type { V3RoomAcceptedOperation, V3RoomCreatorInviteMaterial } from "../../../examples/v3-room/src/index.js";
import { PHASE_3H_MIGRATION_ACTIVATION_DECISION_KEYS } from "../phase-3a1b-p3/seam3-contract.js";

export interface ExpectedMigrationProjection {
	readonly exactCanonicalApplicationStateBytes: Uint8Array;
	readonly importOperations: readonly Readonly<Record<string, unknown>>[];
}

export interface ExpectedMigrationReceipt {
	readonly activated: false;
	readonly applicationStateDigest: string;
	readonly exactCanonicalRecordBytes: Uint8Array;
	readonly importedOperationCount: number;
	readonly recordDigest: string;
	readonly recordVertexDigest: string;
	readonly targetAnchorDigest: string;
}

export interface ExpectedMigrationActivationDecision {
	readonly activationAuthority: "creator-ed25519-registered-vertex-v1";
	readonly applicationStateDigest: string;
	readonly exactCanonicalTargetCreatorInviteBytes: Uint8Array;
	readonly kind: "ts-drp-v3-room-migration-activation";
	readonly migrationRecordDigest: string;
	readonly migrationRecordVertexDigest: string;
	readonly rehearsalNonce: Uint8Array;
	readonly sourceAcceptedOperationCount: number;
	readonly sourceAcceptedOperationsDigest: string;
	readonly sourceAnchorDigest: string;
	readonly sourceBlueprintDigest: string;
	readonly sourceCreatorAuthor: string;
	readonly sourceObjectId: string;
	readonly targetAnchorDigest: string;
	readonly targetBlueprintDigest: string;
	readonly targetCreatorAuthor: string;
	readonly targetImportOperationCount: number;
	readonly targetImportOperationsDigest: string;
	readonly targetObjectId: string;
	readonly version: 1;
}

export const MIGRATION_ACTIVATION_DECISION_KEYS = PHASE_3H_MIGRATION_ACTIVATION_DECISION_KEYS;

export interface MigrationApplication {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly migration?: Readonly<{
		prepare(accepted: readonly V3RoomAcceptedOperation[]): ExpectedMigrationProjection;
	}>;
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function exactPrefix(sourceObjectId: string): string {
	const separator = sourceObjectId.indexOf(":");
	if (separator <= 0 || separator === sourceObjectId.length - 1) {
		throw new TypeError("migration source object id is invalid");
	}
	return sourceObjectId.slice(0, separator);
}

export function expectedTargetObjectId(sourceObjectId: string, rehearsalNonce: Uint8Array): string {
	if (rehearsalNonce.byteLength !== 32) throw new TypeError("migration nonce is invalid");
	const digest = hashDomain(
		"ts-drp/v3-room-migration-target-object/v1",
		encodeCanonical({ rehearsalNonce: new Uint8Array(rehearsalNonce), sourceObjectId })
	);
	return `${exactPrefix(sourceObjectId)}:${hex(digest.subarray(0, 16))}`;
}

export function exactCanonicalCreatorInviteBytes(material: V3RoomCreatorInviteMaterial): Uint8Array {
	return encodeCanonical({
		detachedGenesisSignature: new Uint8Array(material.detachedGenesisSignature),
		exactCanonicalGenesisAnchorPreimageBytes: new Uint8Array(material.exactCanonicalGenesisAnchorPreimageBytes),
		exactCanonicalLatchedAclBytes: new Uint8Array(material.exactCanonicalLatchedAclBytes),
		exactCanonicalParametersCarrierBytes: new Uint8Array(material.exactCanonicalParametersCarrierBytes),
		exactCanonicalProfileBytes: new Uint8Array(material.exactCanonicalProfileBytes),
		exactCanonicalSignerSetBytes: new Uint8Array(material.exactCanonicalSignerSetBytes),
		kind: "ts-drp-example-v3-room-creator-invite",
		pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
		version: 1,
	});
}

export function expectedMigrationActivationDecision(
	exactCanonicalRecordBytes: Uint8Array,
	recordVertexDigest: string,
	targetCreatorInvite: V3RoomCreatorInviteMaterial
): ExpectedMigrationActivationDecision {
	const record = decodeCanonical(exactCanonicalRecordBytes);
	if (record === null || typeof record !== "object" || Array.isArray(record)) {
		throw new TypeError("migration activation record is invalid");
	}
	const value = record as Readonly<Record<string, unknown>>;
	const requiredString = (key: string): string => {
		const selected = Reflect.get(value, key);
		if (typeof selected !== "string") throw new TypeError(`migration activation ${key} is invalid`);
		return selected;
	};
	const requiredCount = (key: string): number => {
		const selected = Reflect.get(value, key);
		if (!Number.isSafeInteger(selected) || (selected as number) < 0) {
			throw new TypeError(`migration activation ${key} is invalid`);
		}
		return selected as number;
	};
	const rehearsalNonce = Reflect.get(value, "rehearsalNonce");
	if (!(rehearsalNonce instanceof Uint8Array) || rehearsalNonce.byteLength !== 32) {
		throw new TypeError("migration activation rehearsal nonce is invalid");
	}
	const targetAnchorDigest = requiredString("targetAnchorDigest");
	if (targetCreatorInvite.pinnedGenesisAnchorDigest !== targetAnchorDigest) {
		throw new TypeError("migration activation target invite anchor differs");
	}
	return Object.freeze({
		activationAuthority: "creator-ed25519-registered-vertex-v1",
		applicationStateDigest: requiredString("applicationStateDigest"),
		exactCanonicalTargetCreatorInviteBytes: exactCanonicalCreatorInviteBytes(targetCreatorInvite),
		kind: "ts-drp-v3-room-migration-activation",
		migrationRecordDigest: hex(hashDomain("ts-drp/v3-room-migration-record/v1", exactCanonicalRecordBytes)),
		migrationRecordVertexDigest: recordVertexDigest,
		rehearsalNonce: new Uint8Array(rehearsalNonce),
		sourceAcceptedOperationCount: requiredCount("sourceAcceptedOperationCount"),
		sourceAcceptedOperationsDigest: requiredString("sourceAcceptedOperationsDigest"),
		sourceAnchorDigest: requiredString("sourceAnchorDigest"),
		sourceBlueprintDigest: requiredString("sourceBlueprintDigest"),
		sourceCreatorAuthor: requiredString("sourceCreatorAuthor"),
		sourceObjectId: requiredString("sourceObjectId"),
		targetAnchorDigest,
		targetBlueprintDigest: requiredString("targetBlueprintDigest"),
		targetCreatorAuthor: requiredString("targetCreatorAuthor"),
		targetImportOperationCount: requiredCount("targetImportOperationCount"),
		targetImportOperationsDigest: requiredString("targetImportOperationsDigest"),
		targetObjectId: requiredString("targetObjectId"),
		version: 1,
	});
}

export function expectedMigrationActivationDecisionDigest(decision: ExpectedMigrationActivationDecision): string {
	return hex(hashDomain("ts-drp/v3-room-migration-activation/v1", encodeCanonical(decision)));
}

export function operationNames(application: MigrationApplication): readonly string[] {
	const decoded = decodeCanonical(application.canonicalBlueprintPackageBytes);
	if (decoded === null || typeof decoded !== "object") throw new TypeError("migration blueprint is invalid");
	const manifest = Reflect.get(decoded, "manifest");
	const operations =
		manifest !== null && typeof manifest === "object" ? Reflect.get(manifest, "operations") : undefined;
	if (!Array.isArray(operations)) throw new TypeError("migration operation catalog is invalid");
	return Object.freeze(operations.map((operation) => String(Reflect.get(operation, "name"))));
}

export function migrationDescriptor(
	application: MigrationApplication,
	name = "migrationRecord"
): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(application.canonicalBlueprintPackageBytes);
	if (decoded === null || typeof decoded !== "object") throw new TypeError("migration blueprint is invalid");
	const manifest = Reflect.get(decoded, "manifest");
	const operations =
		manifest !== null && typeof manifest === "object" ? Reflect.get(manifest, "operations") : undefined;
	if (!Array.isArray(operations)) throw new TypeError("migration operation catalog is invalid");
	const descriptor = operations.find((operation) => Reflect.get(operation, "name") === name);
	if (descriptor === null || typeof descriptor !== "object")
		throw new TypeError("migration record descriptor is absent");
	return descriptor as Readonly<Record<string, unknown>>;
}

export function prepareChatMigration(accepted: readonly V3RoomAcceptedOperation[]): ExpectedMigrationProjection {
	const identities = new Set<string>();
	const values = accepted
		.flatMap((row) => {
			if (Reflect.get(row.operation, "action") !== "message") return [];
			const clientOperationId = Reflect.get(row.operation, "clientOperationId");
			const text = Reflect.get(row.operation, "text");
			if (typeof clientOperationId !== "string" || clientOperationId.length === 0 || typeof text !== "string") {
				throw new TypeError("migration chat operation is invalid");
			}
			if (identities.has(clientOperationId)) throw new TypeError("migration chat identity conflicts");
			identities.add(clientOperationId);
			return [Object.freeze({ clientOperationId, row, text })];
		})
		.sort(
			(left, right) =>
				left.row.logicalTime - right.row.logicalTime ||
				compareText(left.row.author, right.row.author) ||
				left.row.authorSequence - right.row.authorSequence ||
				compareText(left.row.vertexDigest, right.row.vertexDigest) ||
				left.row.operationIndex - right.row.operationIndex
		);
	const state = Object.freeze(values.map(({ clientOperationId, text }) => Object.freeze({ clientOperationId, text })));
	return Object.freeze({
		exactCanonicalApplicationStateBytes: encodeCanonical(state),
		importOperations: Object.freeze(
			state.map(({ clientOperationId, text }) => Object.freeze({ action: "message", clientOperationId, text }))
		),
	});
}

export function prepareZoneMigration(accepted: readonly V3RoomAcceptedOperation[]): ExpectedMigrationProjection {
	const blocks = new Map<
		string,
		Readonly<{ readonly id: string; readonly kind: string; readonly x: number; readonly y: number }>
	>();
	for (const row of accepted) {
		if (Reflect.get(row.operation, "action") !== "placeBlock") continue;
		const id = Reflect.get(row.operation, "id");
		const kind = Reflect.get(row.operation, "kind");
		const x = Reflect.get(row.operation, "x");
		const y = Reflect.get(row.operation, "y");
		if (
			typeof id !== "string" ||
			id.length === 0 ||
			typeof kind !== "string" ||
			kind.length === 0 ||
			!Number.isSafeInteger(x) ||
			!Number.isSafeInteger(y)
		) {
			throw new TypeError("migration zone operation is invalid");
		}
		if (blocks.has(id)) throw new TypeError("migration zone identity conflicts");
		blocks.set(id, Object.freeze({ id, kind, x: x as number, y: y as number }));
	}
	const state = Object.freeze([...blocks.values()].sort((left, right) => compareText(left.id, right.id)));
	return Object.freeze({
		exactCanonicalApplicationStateBytes: encodeCanonical(state),
		importOperations: Object.freeze(state.map((block) => Object.freeze({ action: "placeBlock", ...block }))),
	});
}

export function acceptedOperation(
	operation: Readonly<Record<string, unknown>>,
	input: Readonly<{
		readonly author?: string;
		readonly authorSequence?: number;
		readonly logicalTime?: number;
		readonly operationCount?: number;
		readonly operationIndex?: number;
		readonly vertexDigest?: string;
	}> = {}
): V3RoomAcceptedOperation {
	return Object.freeze({
		author: input.author ?? "a".repeat(64),
		authorSequence: input.authorSequence ?? 1,
		logicalTime: input.logicalTime ?? 1,
		operation,
		operationCount: input.operationCount ?? 1,
		operationIndex: input.operationIndex ?? 0,
		vertexDigest: input.vertexDigest ?? "1".repeat(64),
	});
}

export function migrationCapability(application: MigrationApplication): NonNullable<MigrationApplication["migration"]> {
	if (application.migration === undefined) throw new TypeError("PHASE_3H_MIGRATION_CAPABILITY_ABSENT");
	return application.migration;
}
