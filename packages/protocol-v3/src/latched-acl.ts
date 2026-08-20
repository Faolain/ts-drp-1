import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

const AUTHOR = /^[0-9a-f]{64}$/u;
const OBJECT_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const GROUPS = ["admin", "finality", "writer"] as const;
const SNAPSHOT_KEYS = ["epoch", "kind", "members", "objectId", "permissionless", "version"] as const;
const MEMBER_KEYS = ["author", "finalityKey", "groups"] as const;
const AUTHORITY_INPUT_KEYS = ["author", "snapshot"] as const;
const STAGE_INPUT_KEYS = ["operations", "snapshot"] as const;
const SIGNER_INPUT_KEYS = ["snapshot"] as const;
const GRANT_REVOKE_KEYS = ["actor", "group", "kind", "target"] as const;
const SET_KEY_KEYS = ["actor", "finalityKey", "kind"] as const;
const OPEN_KEYS = ["exactCanonicalLatchedAclBytes", "expectedAclDigest", "expectedEpoch", "expectedObjectId"] as const;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_CANONICAL_BYTES = 8192;

export type LatchedAclGroup = (typeof GROUPS)[number];

export type LatchedAclMember = Readonly<{
	readonly author: string;
	readonly finalityKey: string | null;
	readonly groups: readonly LatchedAclGroup[];
}>;

export type LatchedAclSnapshot = Readonly<{
	readonly epoch: number;
	readonly kind: "drp-v3-latched-acl";
	readonly members: readonly LatchedAclMember[];
	readonly objectId: string;
	readonly permissionless: boolean;
	readonly version: 1;
}>;

export type LatchedAclOperation =
	| Readonly<{
			actor: string;
			group: LatchedAclGroup;
			kind: "grant" | "revoke";
			target: string;
	  }>
	| Readonly<{
			actor: string;
			finalityKey: string;
			kind: "set-finality-key";
	  }>;

export type LatchedAclAuthorityResult =
	| Readonly<{ ok: false; reason: "malformed-input" }>
	| Readonly<{ authorized: boolean; ok: true }>;

export type StageLatchedAclResult =
	| Readonly<{
			index: number;
			ok: false;
			reason: "last-admin" | "malformed-input" | "operation-invalid" | "operation-not-authorized";
	  }>
	| Readonly<{ next: LatchedAclSnapshot; ok: true }>;

export type DeriveLatchedSignerSetResult =
	| Readonly<{ ok: false; reason: "malformed-input" }>
	| Readonly<{
			ok: true;
			signers: readonly Readonly<{ publicKey: string; signerId: string }>[];
	  }>;

export type OpenCanonicalLatchedAclResult =
	| Readonly<{ ok: false; reason: "malformed-input" | "snapshot-mismatch" }>
	| Readonly<{ ok: true; snapshot: LatchedAclSnapshot }>;

interface MutableMember {
	readonly author: string;
	finalityKey: string | null;
	readonly groups: Set<LatchedAclGroup>;
}

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const actualKeys = Reflect.ownKeys(value);
	if (actualKeys.length !== keys.length || actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
		return undefined;
	}
	const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
			return undefined;
		}
		output[key] = descriptor.value;
	}
	return output;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function groupIndex(group: LatchedAclGroup): number {
	return GROUPS.indexOf(group);
}

function isGroup(value: unknown): value is LatchedAclGroup {
	return typeof value === "string" && GROUPS.includes(value as LatchedAclGroup);
}

function copySnapshot(value: unknown): LatchedAclSnapshot | undefined {
	const record = exactDataRecord(value, SNAPSHOT_KEYS);
	if (
		record === undefined ||
		record.kind !== "drp-v3-latched-acl" ||
		record.version !== 1 ||
		typeof record.epoch !== "number" ||
		!Number.isSafeInteger(record.epoch) ||
		record.epoch < 0 ||
		typeof record.objectId !== "string" ||
		!OBJECT_ID.test(record.objectId) ||
		typeof record.permissionless !== "boolean" ||
		!Array.isArray(record.members) ||
		record.members.length === 0 ||
		record.members.length > 64
	) {
		return undefined;
	}
	const members: LatchedAclMember[] = [];
	let previousAuthor = "";
	for (const valueMember of record.members) {
		const selected = exactDataRecord(valueMember, MEMBER_KEYS);
		if (
			selected === undefined ||
			typeof selected.author !== "string" ||
			!AUTHOR.test(selected.author) ||
			selected.author <= previousAuthor ||
			!Array.isArray(selected.groups) ||
			selected.groups.length === 0 ||
			selected.groups.length > GROUPS.length ||
			(selected.finalityKey !== null &&
				(typeof selected.finalityKey !== "string" || !AUTHOR.test(selected.finalityKey)))
		) {
			return undefined;
		}
		const groups: LatchedAclGroup[] = [];
		let previousGroup = -1;
		for (const valueGroup of selected.groups) {
			if (!isGroup(valueGroup)) return undefined;
			const index = groupIndex(valueGroup);
			if (index <= previousGroup) return undefined;
			previousGroup = index;
			groups.push(valueGroup);
		}
		if (selected.finalityKey !== null && !groups.includes("finality")) return undefined;
		previousAuthor = selected.author;
		members.push(
			Object.freeze({
				author: selected.author,
				finalityKey: selected.finalityKey,
				groups: Object.freeze(groups),
			})
		);
	}
	if (!members.some(({ groups }) => groups.includes("admin"))) return undefined;
	return Object.freeze({
		epoch: record.epoch,
		kind: "drp-v3-latched-acl",
		members: Object.freeze(members),
		objectId: record.objectId,
		permissionless: record.permissionless,
		version: 1,
	});
}

/**
 * Opens one canonical current-epoch ACL snapshot against anchor-bound identity.
 * @param input - Exact carrier bytes and the authenticated anchor expectations.
 * @returns A detached snapshot or a closed fail-closed result.
 */
export function openCanonicalLatchedAclSnapshot(
	input: Readonly<{
		readonly exactCanonicalLatchedAclBytes: Uint8Array;
		readonly expectedAclDigest: string;
		readonly expectedEpoch: number;
		readonly expectedObjectId: string;
	}>
): OpenCanonicalLatchedAclResult {
	try {
		const record = exactDataRecord(input, OPEN_KEYS);
		if (
			record === undefined ||
			!(record.exactCanonicalLatchedAclBytes instanceof Uint8Array) ||
			record.exactCanonicalLatchedAclBytes.byteLength === 0 ||
			record.exactCanonicalLatchedAclBytes.byteLength > MAX_CANONICAL_BYTES ||
			typeof record.expectedAclDigest !== "string" ||
			!DIGEST.test(record.expectedAclDigest) ||
			typeof record.expectedEpoch !== "number" ||
			!Number.isSafeInteger(record.expectedEpoch) ||
			record.expectedEpoch < 0 ||
			typeof record.expectedObjectId !== "string" ||
			!OBJECT_ID.test(record.expectedObjectId)
		) {
			return Object.freeze({ ok: false, reason: "malformed-input" });
		}
		const exactBytes = new Uint8Array(record.exactCanonicalLatchedAclBytes);
		const decoded = decodeCanonical(exactBytes, { maxBytes: MAX_CANONICAL_BYTES, maxDepth: 4, maxItems: 512 });
		if (!sameBytes(encodeCanonical(decoded), exactBytes)) {
			return Object.freeze({ ok: false, reason: "malformed-input" });
		}
		const snapshot = copySnapshot(decoded);
		if (
			snapshot === undefined ||
			snapshot.epoch !== record.expectedEpoch ||
			snapshot.objectId !== record.expectedObjectId ||
			lowerHex(hashDomain("ts-drp/latched-acl/v3", exactBytes)) !== record.expectedAclDigest
		) {
			return Object.freeze({ ok: false, reason: "snapshot-mismatch" });
		}
		return Object.freeze({ ok: true, snapshot });
	} catch {
		return Object.freeze({ ok: false, reason: "malformed-input" });
	}
}

function mutableMembers(snapshot: LatchedAclSnapshot): Map<string, MutableMember> {
	return new Map(
		snapshot.members.map(({ author, finalityKey, groups }) => [
			author,
			{ author, finalityKey, groups: new Set(groups) },
		])
	);
}

function copyOperation(value: unknown): LatchedAclOperation | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
	if (kindDescriptor === undefined || !("value" in kindDescriptor)) return undefined;
	if (kindDescriptor.value === "set-finality-key") {
		const record = exactDataRecord(value, SET_KEY_KEYS);
		if (
			record === undefined ||
			record.kind !== "set-finality-key" ||
			typeof record.actor !== "string" ||
			!AUTHOR.test(record.actor) ||
			typeof record.finalityKey !== "string" ||
			!AUTHOR.test(record.finalityKey)
		) {
			return undefined;
		}
		return Object.freeze({ actor: record.actor, finalityKey: record.finalityKey, kind: "set-finality-key" });
	}
	const record = exactDataRecord(value, GRANT_REVOKE_KEYS);
	if (
		record === undefined ||
		(record.kind !== "grant" && record.kind !== "revoke") ||
		typeof record.actor !== "string" ||
		!AUTHOR.test(record.actor) ||
		typeof record.target !== "string" ||
		!AUTHOR.test(record.target) ||
		!isGroup(record.group)
	) {
		return undefined;
	}
	return Object.freeze({ actor: record.actor, group: record.group, kind: record.kind, target: record.target });
}

function authorityInput(value: unknown): Readonly<{ author: string; snapshot: LatchedAclSnapshot }> | undefined {
	const record = exactDataRecord(value, AUTHORITY_INPUT_KEYS);
	const snapshot = record === undefined ? undefined : copySnapshot(record.snapshot);
	if (
		record === undefined ||
		snapshot === undefined ||
		typeof record.author !== "string" ||
		!AUTHOR.test(record.author)
	) {
		return undefined;
	}
	return Object.freeze({ author: record.author, snapshot });
}

function authorityFailure(): LatchedAclAuthorityResult {
	return Object.freeze({ ok: false, reason: "malformed-input" });
}

/**
 * Determines whether an already-authenticated author belongs to the latched epoch ACL.
 * @param input - Candidate author and validated current-epoch snapshot.
 * @returns A fail-closed authority decision.
 */
export function authorizeLatchedEnvelopeAuthor(
	input: Readonly<{
		readonly author: string;
		readonly snapshot: LatchedAclSnapshot;
	}>
): LatchedAclAuthorityResult {
	try {
		const selected = authorityInput(input);
		if (selected === undefined) return authorityFailure();
		return Object.freeze({
			authorized: selected.snapshot.members.some(({ author }) => author === selected.author),
			ok: true,
		});
	} catch {
		return authorityFailure();
	}
}

/**
 * Determines whether an admitted author may execute an application write in the latched epoch.
 * @param input - Candidate author and validated current-epoch snapshot.
 * @returns A fail-closed application-writer decision.
 */
export function authorizeLatchedApplicationWrite(
	input: Readonly<{
		readonly author: string;
		readonly snapshot: LatchedAclSnapshot;
	}>
): LatchedAclAuthorityResult {
	try {
		const selected = authorityInput(input);
		if (selected === undefined) return authorityFailure();
		const member = selected.snapshot.members.find(({ author }) => author === selected.author);
		return Object.freeze({
			authorized: member !== undefined && (selected.snapshot.permissionless || member.groups.includes("writer")),
			ok: true,
		});
	} catch {
		return authorityFailure();
	}
}

function failedStage(
	index: number,
	reason: "last-admin" | "malformed-input" | "operation-invalid" | "operation-not-authorized"
): StageLatchedAclResult {
	return Object.freeze({ index, ok: false, reason });
}

function freezeMembers(members: Map<string, MutableMember>): readonly LatchedAclMember[] {
	return Object.freeze(
		[...members.values()]
			.filter(({ finalityKey, groups }) => groups.size > 0 || finalityKey !== null)
			.sort((left, right) => compareText(left.author, right.author))
			.map(({ author, finalityKey, groups }) =>
				Object.freeze({
					author,
					finalityKey,
					groups: Object.freeze([...groups].sort((left, right) => groupIndex(left) - groupIndex(right))),
				})
			)
	);
}

/**
 * Applies authorized ACL operations to an isolated next-epoch snapshot.
 * @param input - Latched snapshot and canonically ordered candidate operations.
 * @returns The detached next snapshot or the first fail-closed rejection.
 */
export function stageLatchedAclOperations(
	input: Readonly<{
		readonly operations: readonly LatchedAclOperation[];
		readonly snapshot: LatchedAclSnapshot;
	}>
): StageLatchedAclResult {
	try {
		const record = exactDataRecord(input, STAGE_INPUT_KEYS);
		const snapshot = record === undefined ? undefined : copySnapshot(record.snapshot);
		if (record === undefined || snapshot === undefined || !Array.isArray(record.operations)) {
			return failedStage(0, "malformed-input");
		}
		const operations: LatchedAclOperation[] = [];
		for (const [index, value] of record.operations.entries()) {
			const operation = copyOperation(value);
			if (operation === undefined) return failedStage(index, "malformed-input");
			operations.push(operation);
		}
		const latched = mutableMembers(snapshot);
		for (const [index, operation] of operations.entries()) {
			const actor = latched.get(operation.actor);
			if (operation.kind === "set-finality-key") {
				if (!actor?.groups.has("finality")) return failedStage(index, "operation-not-authorized");
			} else {
				if (!actor?.groups.has("admin")) return failedStage(index, "operation-not-authorized");
				if (snapshot.permissionless && operation.group === "writer") {
					return failedStage(index, "operation-invalid");
				}
			}
		}

		const next = mutableMembers(snapshot);
		for (const operation of operations) {
			if (operation.kind !== "grant") continue;
			const target = next.get(operation.target) ?? {
				author: operation.target,
				finalityKey: null,
				groups: new Set<LatchedAclGroup>(),
			};
			target.groups.add(operation.group);
			next.set(operation.target, target);
		}
		for (const operation of operations) {
			if (operation.kind !== "set-finality-key") continue;
			const actor = next.get(operation.actor);
			if (actor === undefined) return failedStage(0, "operation-invalid");
			actor.finalityKey = operation.finalityKey;
		}
		for (const operation of operations) {
			if (operation.kind !== "revoke") continue;
			const target = next.get(operation.target);
			target?.groups.delete(operation.group);
			if (target !== undefined && operation.group === "finality") target.finalityKey = null;
		}
		const frozenMembers = freezeMembers(next);
		if (!frozenMembers.some(({ groups }) => groups.includes("admin"))) {
			const index = operations.findIndex((operation) => operation.kind === "revoke" && operation.group === "admin");
			return failedStage(Math.max(0, index), "last-admin");
		}
		if (snapshot.epoch === Number.MAX_SAFE_INTEGER) {
			return failedStage(0, "operation-invalid");
		}
		return Object.freeze({
			next: Object.freeze({
				epoch: snapshot.epoch + 1,
				kind: "drp-v3-latched-acl",
				members: frozenMembers,
				objectId: snapshot.objectId,
				permissionless: snapshot.permissionless,
				version: 1,
			}),
			ok: true,
		});
	} catch {
		return failedStage(0, "malformed-input");
	}
}

/**
 * Derives the ordered next-epoch seal signer set from a validated ACL snapshot.
 * @param input - Candidate next-epoch ACL snapshot.
 * @returns The sorted signer set or a malformed-input rejection.
 */
export function deriveNextLatchedSignerSet(
	input: Readonly<{
		readonly snapshot: LatchedAclSnapshot;
	}>
): DeriveLatchedSignerSetResult {
	try {
		const record = exactDataRecord(input, SIGNER_INPUT_KEYS);
		const snapshot = record === undefined ? undefined : copySnapshot(record.snapshot);
		if (snapshot === undefined) return Object.freeze({ ok: false, reason: "malformed-input" });
		return Object.freeze({
			ok: true,
			signers: Object.freeze(
				snapshot.members.flatMap(({ author, finalityKey, groups }) =>
					groups.includes("finality") && finalityKey !== null
						? [Object.freeze({ publicKey: finalityKey, signerId: author })]
						: []
				)
			),
		});
	} catch {
		return Object.freeze({ ok: false, reason: "malformed-input" });
	}
}
