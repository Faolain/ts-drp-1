import type { Effects, Trace } from "./types.js";
import { hashDomain } from "../../../packages/canonical/dist/src/index.js";
import type { SnapshotQuarantineScopeKey } from "../../../packages/storage/dist/src/snapshot-transfer.js";
let active: { effects: Effects; candidate: string | null } | undefined;
/**
 * Account at the real native synchronous lookup resolution, returning its same object.
 * @param scope - The real native captured key, never changed.
 * @param value - The native outcome; no promise or returned object is replaced.
 * @returns The identical original native value.
 */
export function lookupOutcome<T extends { kind: string; state?: string; retention?: string }>(
	scope: SnapshotQuarantineScopeKey,
	value: T
): T {
	trace({
		site: "native-lookup-outcome",
		scope: { ...scope },
		kind: value.kind,
		...(value.state === undefined ? {} : { state: value.state }),
		...(value.retention === undefined ? {} : { retention: value.retention }),
	});
	return value;
}
/**
 * Observe the actual thrown native conflict object without catching or remapping it.
 * @param scope - The real native captured key.
 * @param value - The identical original native thrown error.
 * @returns That same native error object.
 */
export function lookupRefusal<T>(scope: SnapshotQuarantineScopeKey, value: T): T {
	const code = value !== null && typeof value === "object" ? (Reflect.get(value, "code") as unknown) : undefined;
	trace({ site: "native-lookup-refusal", scope: { ...scope }, ...(typeof code === "string" ? { code } : {}) });
	return value;
}
/**
 * Observe the native owner's actual migration refusal creation without replacing its error.
 * @param value - Original native error object from the unique mutable-owner guard.
 * @returns The identical original error.
 */
export function mutationRefusal<T>(value: T): T {
	const code = value !== null && typeof value === "object" ? (Reflect.get(value, "code") as unknown) : undefined;
	trace({ site: "native-mutation-refusal", ...(typeof code === "string" ? { code } : {}) });
	return value;
}
/**
 * Observe detached primitives from the real shared verifier's local return value.
 * No result, native bytes, quarantine, or receipt is replaced or retained.
 * @param value - The original verified snapshot, untouched.
 */
export function snapshot(value: unknown): void {
	if (active === undefined || value === undefined) return;
	if (value === null || typeof value !== "object") throw new Error("PENDING_SNAPSHOT_OBSERVATION_SHAPE");
	const { exactCanonicalPayloadBytes, payload, manifest } = value as {
		exactCanonicalPayloadBytes?: unknown;
		payload?: unknown;
		manifest?: unknown;
	};
	if (
		!(exactCanonicalPayloadBytes instanceof Uint8Array) ||
		payload === null ||
		typeof payload !== "object" ||
		manifest === null ||
		typeof manifest !== "object"
	)
		throw new Error("PENDING_SNAPSHOT_OBSERVATION_SHAPE");
	const application = Reflect.get(payload, "application") as unknown;
	const stateDigest = Reflect.get(manifest, "stateDigest") as unknown;
	if (typeof application !== "number" || !Number.isSafeInteger(application) || typeof stateDigest !== "string")
		throw new Error("PENDING_SNAPSHOT_OBSERVATION_STATE");
	const payloadDigest = Array.from(hashDomain("ts-drp/snapshot-payload/v3", exactCanonicalPayloadBytes), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	trace({
		site: "snapshot-payload",
		ok: payloadDigest === Reflect.get(manifest, "payloadDigest"),
		application,
		stateDigest,
		payloadDigest,
		payloadBytes: exactCanonicalPayloadBytes.byteLength,
	});
}
/**
 * Account inside the exact native owner invocation without replacing its value or promise.
 * @param site - Exact native method entry.
 * @param input - Original method carrier, never mutated.
 */
export function nativeOwner(site: "native-lookup" | "native-acquire" | "complete", input: unknown): void {
	if (active === undefined) return;
	if (site === "native-lookup") active.effects.nativeLookups++;
	else if (site === "native-acquire") active.effects.nativeAcquisitions++;
	else active.effects.completes++;
	const scope =
		site === "native-acquire" && input !== null && typeof input === "object"
			? (Object.getOwnPropertyDescriptor(input, "scope")?.value as unknown)
			: input;
	trace({
		site,
		...(scope !== null && typeof scope === "object" ? { scope: { ...scope } as SnapshotQuarantineScopeKey } : {}),
	});
}
/**
 * Run the named pending-only fixture seam.
 * @returns Original production values or isolated fixture evidence.
 */
export function freshEffects(): Effects {
	return {
		traces: [],
		lookups: 0,
		nativeLookups: 0,
		accesses: 0,
		acquisitions: 0,
		nativeAcquisitions: 0,
		reads: 0,
		completes: 0,
		swaps: [],
		rereads: 0,
		mutations: 0,
	};
}
/**
 * Run the named pending-only fixture seam.
 * @param id - Explicit fixture-owned input for this isolated control.
 */
export function candidate(id: string): void {
	if (active !== undefined) {
		active.candidate = id;
		event("candidate");
	}
}
/**
 * Run the named pending-only fixture seam.
 * @param site - Explicit fixture-owned input for this isolated control.
 * @param result - Explicit fixture-owned input for this isolated control.
 * @param result.ok - Explicit fixture-owned input for this isolated control.
 * @param result.reason - Explicit fixture-owned input for this isolated control.
 */
export function event(site: string, result?: { ok?: boolean; reason?: string }): void {
	if (active === undefined) return;
	const trace: Trace = {
		candidate: active.candidate,
		site,
		...(typeof result?.ok === "boolean" ? { ok: result.ok } : {}),
		...(typeof result?.reason === "string" ? { reason: result.reason } : {}),
	};
	active.effects.traces.push(trace);
}
/**
 * Run the named pending-only fixture seam.
 * @param value - Explicit fixture-owned input for this isolated control.
 * @param candidateId - Explicit native CAS owner attribution or current authenticated candidate.
 */
export function trace(value: Omit<Trace, "candidate">, candidateId: string | null = active?.candidate ?? null): void {
	if (active !== undefined) active.effects.traces.push({ ...value, candidate: candidateId });
}
/**
 * Run the named pending-only fixture seam.
 * @param site - Explicit fixture-owned input for this isolated control.
 * @param value - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export function result<T extends { ok?: boolean; reason?: string }>(site: string, value: T): T {
	event(site, value);
	return value;
}
/**
 * Run the named pending-only fixture seam.
 * @param site - Explicit fixture-owned input for this isolated control.
 * @param value - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export function condition(site: string, value: boolean): boolean {
	event(site, { ok: !value });
	return value;
}
/**
 * Run the named pending-only fixture seam.
 * @param effects - Explicit fixture-owned input for this isolated control.
 * @param action - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function observe<T>(effects: Effects, action: () => Promise<T>): Promise<T> {
	if (active !== undefined) throw new Error("PENDING_OBSERVER_REENTRY");
	active = { effects, candidate: null };
	try {
		return await action();
	} finally {
		active = undefined;
	}
}
