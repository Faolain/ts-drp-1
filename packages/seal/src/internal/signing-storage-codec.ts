import { compareBytes, encodeCanonical } from "@ts-drp/canonical";
import { createCanonicalEncodingCapture, type CanonicalEncodingCaptureValue } from "@ts-drp/canonical/encoding-capture";

import {
	compareSigningSummaryRetirementEntries,
	isSigningSummaryRetirementPlan,
	SIGNING_DETAIL_RETIREMENT_BATCH_ROWS,
	type SigningEvidenceRetirementEntry,
	type SigningEvidenceRetirementPlan,
	type SigningRetirementControl,
	type SigningRetirementPreparation,
	type SigningSummaryRetirementEntry,
	type SigningSummaryRetirementPlan,
	type SigningSummaryRetirementSource,
} from "./seal-vote-intent.js";

export interface SigningStorageCodec {
	plainRecord(value: unknown): value is Readonly<Record<string, unknown>>;
	record(value: unknown, keys: readonly string[]): Record<string, unknown>;
	preparation(value: unknown, objectId?: string, allowSummary?: boolean): SigningRetirementPreparation;
	monotone(previous: SigningRetirementPreparation | null, next: SigningRetirementPreparation): boolean;
	control(value: unknown, objectId: string, incarnation: string, allowDrain?: boolean): SigningRetirementControl;
	equal(left: unknown, right: unknown): boolean;
	evidencePlan(value: unknown, objectId: string, incarnation: string): SigningEvidenceRetirementPlan;
	summarySource(value: unknown, objectId: string): SigningSummaryRetirementSource;
	summaryPlan(value: unknown, objectId: string, incarnation: string): SigningSummaryRetirementPlan;
	retirementDrainPlan(
		value: unknown,
		objectId: string,
		incarnation: string
	): SigningEvidenceRetirementPlan | SigningSummaryRetirementPlan;
	idle(objectId: string, incarnation: string): SigningRetirementControl;
	retired(preparation: SigningRetirementPreparation | null, epoch: number): boolean;
	summaryMaintenancePending(current: SigningRetirementControl): boolean;
	readonly digestPattern: RegExp;
	readonly incarnationPattern: RegExp;
	readonly controlLimits: Readonly<{ maxBytes: number; maxItems: number; maxDepth: number }>;
	keyFor(objectId: string): string;
	safe(value: unknown): value is number;
}

/**
 * Original signing-row/control validation, shared by native hosts. No authentication or persistence authority.
 * @param LIMITS - Existing host-selected bounded-read policy; no additional entitlement.
 * @returns Original mechanical validators over that policy.
 */
export function createSigningStorageCodec(
	LIMITS: Readonly<{ maxUnionBytes: number; maxObjectGenerations: number }>
): SigningStorageCodec {
	const digestPattern = /^[0-9a-f]{64}$/u;
	const incarnationPattern = /^[0-9a-f]{32}$/u;
	const controlLimits = { maxBytes: LIMITS.maxUnionBytes, maxItems: 65_536, maxDepth: 16 };
	const keyFor = (objectId: string): string => `signing-retirement:${objectId}`;
	const safe = (value: unknown): value is number =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

	// One synchronous public capture owns only its OWN normalized immutable
	// outputs. Unknown inputs are never enrolled, even if frozen or aliased.
	// Opaque child segments retain the original encoder's limits/depth checks
	// when composed into each original enclosing PRE. Nothing survives return.
	function withEncoding<T>(action: (scope: EncodingScope) => T): T {
		const encoding = createCanonicalEncodingCapture();
		const captured = new WeakMap<object, CanonicalEncodingCaptureValue>();
		const parts = (value: unknown): unknown => {
			if (value === null || typeof value !== "object") return value;
			const prior = captured.get(value);
			if (prior !== undefined) return prior;
			if (Array.isArray(value)) return value.map(parts);
			return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, parts(child)]));
		};
		const scope: EncodingScope = {
			check(value, limits = controlLimits) {
				// A spent remaining-byte allowance must take the original encoder's
				// refusal, not the capture API's stricter limit-configuration error.
				if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1)
					return encodeCanonical(value, limits).byteLength;
				const result = encoding.capture(parts(value), limits);
				captured.set(value, result);
				return result.byteLength;
			},
			equal(left, right) {
				if (!Number.isSafeInteger(controlLimits.maxBytes) || controlLimits.maxBytes < 1) return equal(left, right);
				return compareBytes(encoding.encode(parts(left), controlLimits), encoding.encode(parts(right), controlLimits)) === 0;
			},
		};
		try { return action(scope); } finally { encoding.release(); }
	}
	type EncodingScope = {
		check(value: object, limits?: typeof controlLimits): number;
		equal(left: unknown, right: unknown): boolean;
	};

	function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
		const prototype = Object.getPrototypeOf(value) as object | null;
		return prototype === Object.prototype || prototype === null;
	}

	function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
		if (value === null || typeof value !== "object" || Array.isArray(value))
			throw new TypeError("INVALID_SIGNING_CONTROL");
		const prototype = Object.getPrototypeOf(value) as object | null;
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError("INVALID_SIGNING_CONTROL");
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (
			Reflect.ownKeys(descriptors).length !== keys.length ||
			keys.some(
				(key) => descriptors[key] === undefined || !("value" in descriptors[key]) || !descriptors[key].enumerable
			)
		)
			throw new TypeError("INVALID_SIGNING_CONTROL");
		return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
	}

	function preparation(value: unknown, objectId: string | undefined, allowSummary: boolean, scope: EncodingScope): SigningRetirementPreparation {
		const hasSummary = plainRecord(value) && Object.hasOwn(value, "summarySource");
		if (hasSummary && (!allowSummary || objectId === undefined)) throw new TypeError("INVALID_SIGNING_PREPARATION");
		const row = record(value, [
			"throughEpoch",
			"protectedEpochs",
			"decisionDigest",
			"sourceProofDigest",
			...(hasSummary ? ["summarySource"] : []),
		]);
		if (
			!safe(row.throughEpoch) ||
			typeof row.decisionDigest !== "string" ||
			!digestPattern.test(row.decisionDigest) ||
			typeof row.sourceProofDigest !== "string" ||
			!digestPattern.test(row.sourceProofDigest) ||
			!Array.isArray(row.protectedEpochs)
		)
			throw new TypeError("INVALID_SIGNING_PREPARATION");
		const descriptors = Object.getOwnPropertyDescriptors(row.protectedEpochs as object);
		const length = descriptors.length?.value as unknown;
		if (!safe(length) || length > LIMITS.maxObjectGenerations || Reflect.ownKeys(descriptors).length !== length + 1)
			throw new TypeError("INVALID_SIGNING_PREPARATION");
		const holes: number[] = [];
		for (let index = 0; index < length; index++) {
			const descriptor = descriptors[String(index)];
			const epoch: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
			if (!safe(epoch) || epoch > row.throughEpoch || (index > 0 && epoch <= holes[index - 1]))
				throw new TypeError("INVALID_SIGNING_PREPARATION");
			holes.push(epoch);
		}
		const captured = Object.freeze({
			throughEpoch: row.throughEpoch,
			protectedEpochs: Object.freeze(holes),
			decisionDigest: row.decisionDigest,
			sourceProofDigest: row.sourceProofDigest,
			...(hasSummary && objectId !== undefined ? { summarySource: summarySource(row.summarySource, objectId, scope) } : {}),
		});
		if (
			captured.summarySource !== undefined &&
			(captured.summarySource.entries.some((entry) => !retired(captured, entry.key[1])) ||
				!monotone(captured.summarySource.eligibilityFence, captured))
		)
			throw new TypeError("INVALID_SIGNING_PREPARATION");
		scope.check(captured);
		return captured;
	}

	function monotone(previous: SigningRetirementPreparation | null, next: SigningRetirementPreparation): boolean {
		return (
			previous === null ||
			(next.throughEpoch >= previous.throughEpoch &&
				next.protectedEpochs.every(
					(epoch) => epoch > previous.throughEpoch || previous.protectedEpochs.includes(epoch)
				))
		);
	}

	function control(value: unknown, objectId: string, incarnation: string, allowDrain: boolean, scope: EncodingScope): SigningRetirementControl {
		const hasDrain = plainRecord(value) && Object.hasOwn(value, "drain");
		const row = record(value, [
			"kind",
			"objectId",
			"incarnation",
			"revision",
			"sequence",
			"active",
			"completed",
			...(hasDrain ? ["drain"] : []),
		]);
		if (
			row.kind !== "signing-retirement-control-1" ||
			row.objectId !== objectId ||
			row.incarnation !== incarnation ||
			!incarnationPattern.test(incarnation) ||
			!safe(row.revision) ||
			!safe(row.sequence) ||
			row.revision < row.sequence
		)
			throw new Error("INVALID_SIGNING_CONTROL");
		const completed = row.completed === null ? null : preparation(row.completed, objectId, true, scope);
		if (completed !== null && row.sequence === 0) throw new Error("INVALID_SIGNING_CONTROL");
		let active: SigningRetirementControl["active"] = null;
		if (row.active !== null) {
			const pending = record(row.active, ["sequence", "preparation", "sourceImageDigest"]);
			if (
				!safe(pending.sequence) ||
				pending.sequence !== row.sequence ||
				pending.sequence === 0 ||
				typeof pending.sourceImageDigest !== "string" ||
				!digestPattern.test(pending.sourceImageDigest)
			)
				throw new Error("INVALID_SIGNING_CONTROL");
			const proposed = preparation(pending.preparation, objectId, true, scope);
			if (!monotone(completed, proposed)) throw new Error("INVALID_SIGNING_CONTROL");
			active = Object.freeze({
				sequence: pending.sequence,
				preparation: proposed,
				sourceImageDigest: pending.sourceImageDigest,
			});
		}
		let drain: SigningRetirementControl["drain"];
		if (hasDrain) {
			drain = null;
			if (row.drain !== null) {
				if (!allowDrain) throw new Error("INVALID_SIGNING_DRAIN");
				const state = record(row.drain, ["plan", "cursor", "batches", "remainingDataDigest"]);
				const plan = retirementDrainPlan(state.plan, objectId, incarnation, scope);
				if (
					!safe(state.cursor) ||
					state.cursor > plan.entries.length ||
					!safe(state.batches) ||
					state.batches > state.cursor ||
					(state.cursor === 0) !== (state.batches === 0) ||
					(state.cursor > 0 && state.cursor > state.batches * SIGNING_DETAIL_RETIREMENT_BATCH_ROWS) ||
					typeof state.remainingDataDigest !== "string" ||
					!digestPattern.test(state.remainingDataDigest)
				)
					throw new Error("INVALID_SIGNING_DRAIN");
				if (
					state.cursor < plan.entries.length &&
					(active !== null ||
						row.sequence !== plan.baseControl.sequence ||
						row.revision !== plan.baseControl.revision + 1 + state.batches ||
						!scope.equal(completed, plan.baseControl.completed))
				)
					throw new Error("INVALID_SIGNING_DRAIN");
				drain = Object.freeze({
					plan,
					cursor: state.cursor,
					batches: state.batches,
					remainingDataDigest: state.remainingDataDigest,
				});
			}
		}
		const captured = Object.freeze({
			kind: "signing-retirement-control-1" as const,
			objectId,
			incarnation,
			revision: row.revision,
			sequence: row.sequence,
			active,
			completed,
			...(drain !== undefined ? { drain } : {}),
		});
		scope.check(captured);
		return captured;
	}

	function equal(left: unknown, right: unknown): boolean {
		return compareBytes(encodeCanonical(left, controlLimits), encodeCanonical(right, controlLimits)) === 0;
	}

	function evidencePlan(value: unknown, objectId: string, incarnation: string, scope: EncodingScope): SigningEvidenceRetirementPlan {
		const row = record(value, ["baseControl", "entries", "sourceDataDigest"]);
		const baseControl = control(row.baseControl, objectId, incarnation, false, scope);
		if (
			baseControl.active !== null ||
			baseControl.completed === null ||
			typeof row.sourceDataDigest !== "string" ||
			!digestPattern.test(row.sourceDataDigest) ||
			!Array.isArray(row.entries)
		)
			throw new Error("INVALID_SIGNING_DRAIN_PLAN");
		const descriptors = Object.getOwnPropertyDescriptors(row.entries as object),
			length: unknown = descriptors.length?.value;
		if (!safe(length) || length === 0 || length > 65_536 || Reflect.ownKeys(descriptors).length !== length + 1)
			throw new Error("INVALID_SIGNING_DRAIN_PLAN");
		const entries: SigningEvidenceRetirementEntry[] = [];
		let bytes = scope.check({ baseControl, sourceDataDigest: row.sourceDataDigest });
		for (let index = 0; index < length; index++) {
			const descriptor = descriptors[String(index)];
			if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
				throw new Error("INVALID_SIGNING_DRAIN_PLAN");
			const entry = record(descriptor.value, ["key", "revision", "frameDigest"]);
			if (!Array.isArray(entry.key) || entry.key.length !== 3) throw new Error("INVALID_SIGNING_DRAIN_PLAN");
			const keyDescriptors = Object.getOwnPropertyDescriptors(entry.key as object);
			if (Reflect.ownKeys(keyDescriptors).length !== 4) throw new Error("INVALID_SIGNING_DRAIN_PLAN");
			const key = [0, 1, 2].map((offset) => {
				const part = keyDescriptors[String(offset)];
				if (part === undefined || !("value" in part) || !part.enumerable) throw new Error("INVALID_SIGNING_DRAIN_PLAN");
				return part.value as unknown;
			});
			if (
				key[0] !== objectId ||
				!safe(key[1]) ||
				typeof key[2] !== "string" ||
				!key[2] ||
				key[2].includes("\0") ||
				!retired(baseControl.completed, key[1]) ||
				!safe(entry.revision) ||
				typeof entry.frameDigest !== "string" ||
				!digestPattern.test(entry.frameDigest)
			)
				throw new Error("INVALID_SIGNING_DRAIN_PLAN");
			const prior = entries[index - 1];
			if (prior !== undefined && (key[1] < prior.key[1] || (key[1] === prior.key[1] && key[2] <= prior.key[2])))
				throw new Error("INVALID_SIGNING_DRAIN_PLAN");
			const copied = Object.freeze({
				key: Object.freeze([objectId, key[1], key[2]]) as readonly [string, number, string],
				revision: entry.revision,
				frameDigest: entry.frameDigest,
			});
			bytes += scope.check(copied, { ...controlLimits, maxBytes: controlLimits.maxBytes - bytes });
			entries.push(copied);
		}
		const captured = Object.freeze({
			baseControl,
			entries: Object.freeze(entries),
			sourceDataDigest: row.sourceDataDigest,
		});
		scope.check(captured);
		return captured;
	}

	function summarySource(value: unknown, objectId: string, scope: EncodingScope): SigningSummaryRetirementSource {
		const row = record(value, ["entries", "sourceDataDigest", "resumeBasisDigest", "eligibilityFence"]);
		const eligibilityFence = preparation(row.eligibilityFence, objectId, false, scope);
		if (
			!Array.isArray(row.entries) ||
			typeof row.sourceDataDigest !== "string" ||
			!digestPattern.test(row.sourceDataDigest) ||
			typeof row.resumeBasisDigest !== "string" ||
			!digestPattern.test(row.resumeBasisDigest)
		)
			throw new Error("INVALID_SIGNING_DRAIN_PLAN");
		const descriptors = Object.getOwnPropertyDescriptors(row.entries as object),
			length: unknown = descriptors.length?.value;
		if (!safe(length) || length === 0 || length > 65_536 || Reflect.ownKeys(descriptors).length !== length + 1)
			throw new Error("INVALID_SIGNING_DRAIN_PLAN");
		const entries: SigningSummaryRetirementEntry[] = [];
		let charged = scope.check({ eligibilityFence, sourceDataDigest: row.sourceDataDigest, resumeBasisDigest: row.resumeBasisDigest });
		for (let index = 0; index < length; index++) {
			const descriptor = descriptors[String(index)];
			if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
				throw new Error("INVALID_SIGNING_DRAIN_PLAN");
			const entry = record(descriptor.value, ["store", "key", "frameDigest"]);
			if (
				!Array.isArray(entry.key) ||
				typeof entry.store !== "string" ||
				!["signerState", "voteSlots", "voteOutbox"].includes(entry.store)
			)
				throw new Error("INVALID_SIGNING_DRAIN_PLAN");
			const short = entry.store === "signerState",
				size = short ? 3 : 5;
			const parts = Object.getOwnPropertyDescriptors(entry.key as object);
			if (parts.length?.value !== size || Reflect.ownKeys(parts).length !== size + 1)
				throw new Error("INVALID_SIGNING_DRAIN_PLAN");
			const key: unknown[] = [];
			for (let offset = 0; offset < size; offset++) {
				const part = parts[String(offset)];
				if (part === undefined || !("value" in part) || !part.enumerable) throw new Error("INVALID_SIGNING_DRAIN_PLAN");
				key.push(part.value);
			}
			const signer = key[short ? 2 : 4];
			if (
				key[0] !== objectId ||
				!safe(key[1]) ||
				!retired(eligibilityFence, key[1]) ||
				typeof signer !== "string" ||
				!signer ||
				signer.includes("\0") ||
				(!short &&
					(!safe(key[2]) || typeof key[3] !== "string" || !["prepare", "commit", "round-change"].includes(key[3]))) ||
				typeof entry.frameDigest !== "string" ||
				!digestPattern.test(entry.frameDigest)
			)
				throw new Error("INVALID_SIGNING_DRAIN_PLAN");
			const copied = Object.freeze({
				store: entry.store as SigningSummaryRetirementEntry["store"],
				key: Object.freeze(key) as SigningSummaryRetirementEntry["key"],
				frameDigest: entry.frameDigest,
			});
			const prior = entries[index - 1];
			if (prior !== undefined && compareSigningSummaryRetirementEntries(prior, copied) >= 0)
				throw new Error("INVALID_SIGNING_DRAIN_PLAN");
			charged += scope.check(copied, { ...controlLimits, maxBytes: controlLimits.maxBytes - charged });
			entries.push(copied);
		}
		const captured = Object.freeze({
			entries: Object.freeze(entries),
			sourceDataDigest: row.sourceDataDigest,
			resumeBasisDigest: row.resumeBasisDigest,
			eligibilityFence,
		});
		scope.check(captured);
		return captured;
	}

	function summaryPlan(value: unknown, objectId: string, incarnation: string, scope: EncodingScope): SigningSummaryRetirementPlan {
		const row = record(value, [
			"kind",
			"baseControl",
			"entries",
			"sourceDataDigest",
			"resumeBasisDigest",
			"eligibilityFence",
		]);
		const baseControl = control(row.baseControl, objectId, incarnation, false, scope);
		const source = summarySource(
			{
				entries: row.entries,
				sourceDataDigest: row.sourceDataDigest,
				resumeBasisDigest: row.resumeBasisDigest,
				eligibilityFence: row.eligibilityFence,
			},
			objectId, scope
		);
		if (
			row.kind !== "signing-summary-retirement-plan-2" ||
			baseControl.active !== null ||
			baseControl.completed === null ||
			!scope.equal(baseControl.completed.summarySource, source) ||
			!monotone(source.eligibilityFence, baseControl.completed) ||
			source.entries.some((entry) => !retired(baseControl.completed, entry.key[1]))
		)
			throw new Error("INVALID_SIGNING_DRAIN_PLAN");
		return Object.freeze({ kind: "signing-summary-retirement-plan-2", baseControl, ...source });
	}

	function retirementDrainPlan(
		value: unknown,
		objectId: string,
		incarnation: string,
		scope: EncodingScope
	): SigningEvidenceRetirementPlan | SigningSummaryRetirementPlan {
		const kind = plainRecord(value) ? Object.getOwnPropertyDescriptor(value, "kind") : undefined;
		if (kind !== undefined && !("value" in kind)) throw new TypeError("INVALID_SIGNING_DRAIN_PLAN");
		return kind?.value === "signing-summary-retirement-plan-2"
			? summaryPlan(value, objectId, incarnation, scope)
			: evidencePlan(value, objectId, incarnation, scope);
	}

	function idle(objectId: string, incarnation: string): SigningRetirementControl {
		return Object.freeze({
			kind: "signing-retirement-control-1",
			objectId,
			incarnation,
			revision: 0,
			sequence: 0,
			active: null,
			completed: null,
		});
	}

	function retired(preparation: SigningRetirementPreparation | null, epoch: number): boolean {
		return preparation !== null && epoch <= preparation.throughEpoch && !preparation.protectedEpochs.includes(epoch);
	}

	function summaryMaintenancePending(current: SigningRetirementControl): boolean {
		if (current.active?.preparation.summarySource !== undefined) return true;
		const source = current.completed?.summarySource;
		if (source === undefined) return false;
		const state = current.drain;
		return (
			state == null ||
			!isSigningSummaryRetirementPlan(state.plan) ||
			state.cursor !== state.plan.entries.length ||
			!equal(state.plan.baseControl.completed, current.completed)
		);
	}

	return Object.freeze<SigningStorageCodec>({
		plainRecord,
		record,
		preparation: (value, objectId, allowSummary = true) => withEncoding(scope => preparation(value, objectId, allowSummary, scope)),
		monotone,
		control: (value, objectId, incarnation, allowDrain = true) => withEncoding(scope => control(value, objectId, incarnation, allowDrain, scope)),
		equal,
		evidencePlan: (value, objectId, incarnation) => withEncoding(scope => evidencePlan(value, objectId, incarnation, scope)),
		summarySource: (value, objectId) => withEncoding(scope => summarySource(value, objectId, scope)),
		summaryPlan: (value, objectId, incarnation) => withEncoding(scope => summaryPlan(value, objectId, incarnation, scope)),
		retirementDrainPlan: (value, objectId, incarnation) => withEncoding(scope => retirementDrainPlan(value, objectId, incarnation, scope)),
		idle,
		retired,
		summaryMaintenancePending,
		digestPattern,
		incarnationPattern,
		controlLimits,
		keyFor,
		safe,
	});
}
