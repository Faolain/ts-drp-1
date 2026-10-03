/* eslint-disable jsdoc/require-jsdoc -- Unit-composition observation, not authority or an alternate accounting owner. */
import type { LiveJournalAnchorReadInput, LiveJournalAnchorReadResult } from "@ts-drp/live-journal";
import { AHE_BOUNDED_READ_LIMITS, type AheBoundedActiveRead } from "@ts-drp/storage";

import type { AccountingFactory, CompositionMode, ProofAccounting } from "./contract.js";

const U = AHE_BOUNDED_READ_LIMITS.maxUnionBytes;
interface Plan {
	readonly mode: CompositionMode;
	readonly actualUnion: readonly { readonly digest: string; readonly byteLength: number }[];
	readonly anchorBytes: Uint8Array;
}
let plan: Plan | undefined;
export const owners: ProofAccounting[] = [];
export const events: unknown[] = [];
export const dispatches: { input: LiveJournalAnchorReadInput; chargedBytes: number }[] = [];
export const results: LiveJournalAnchorReadResult[] = [];
export function configure(value: Plan): void {
	plan = value;
	owners.length = 0;
	events.length = 0;
	dispatches.length = 0;
	results.length = 0;
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
export function created(factory: AccountingFactory, initial: AheBoundedActiveRead["blobs"]): ProofAccounting {
	const owner = Reflect.apply(factory, undefined, [initial]) as ProofAccounting;
	if (!plan) throw new Error("COMPOSITION_PLAN_MISSING");
	if (owners.length !== 0) throw new Error("PRODUCTION_OWNER_RESET_OR_PARALLEL_OWNER");
	const actualKeys = plan.actualUnion.map((ref) => ref.digest + ":" + ref.byteLength).sort();
	const initialKeys = initial.map((blob) => blob.ref.digest + ":" + blob.bytes.length).sort();
	if (
		actualKeys.join("\n") !== initialKeys.join("\n") ||
		initial.some((blob) => blob.bytes.length !== blob.ref.byteLength)
	)
		throw new Error("COMPLETE_ACTUAL_AHE_UNION_NOT_USED");
	const actualSubtotal = initial.reduce((total, blob) => total + blob.bytes.length, 0);
	if (owner.chargedBytes !== actualSubtotal) throw new Error("RECOGNIZED_ONLY_OR_UNBILLED_INITIAL_UNION");
	owners.push(owner);
	events.push({ event: "owner-created", actualSubtotal, completeActualUnion: true });
	const anchor = plan.anchorBytes;
	if (plan.mode === "equal-bytes" || plan.mode === "unequal-same-length") {
		const bytes = Uint8Array.from(anchor);
		if (plan.mode === "unequal-same-length") bytes[bytes.length - 1] ^= 1;
		if (!owner.charge(bytes)) throw new Error("SYNTHETIC_UNIT_PRECHARGE_REFUSED");
		events.push({ event: "synthetic-anchor-sized-precharge", bytes: bytes.length, actualEqual: equal(bytes, anchor) });
	}
	const remainder =
		plan.mode === "below"
			? anchor.length - 1
			: plan.mode === "equal"
				? anchor.length
				: plan.mode === "above"
					? anchor.length + 1
					: 8193;
	const fillLength = U - remainder - owner.chargedBytes;
	if (fillLength <= 0) throw new Error("SYNTHETIC_FILL_NOT_POSITIVE");
	const fill = new Uint8Array(fillLength).fill(0xa7);
	if (!owner.charge(fill) || owner.chargedBytes !== U - remainder)
		throw new Error("REAL_OWNER_PRECHARGE_NOT_EFFECTIVE");
	events.push({
		event: "synthetic-unit-fill",
		fillLength,
		chargedBytes: owner.chargedBytes,
		remainder,
		allowance: Math.min(8192, remainder),
	});
	return owner;
}
export function charged(owner: ProofAccounting, bytes: Uint8Array): boolean {
	if (!owners.includes(owner)) throw new Error("OBSERVER_BYPASSED_OPERATION_OWNER");
	const before = owner.chargedBytes;
	const accepted = Reflect.apply(owner.charge, owner, [bytes]) as boolean;
	events.push({ event: "production-charge", bytes: bytes.length, before, after: owner.chargedBytes, accepted });
	return accepted;
}
export function journalDispatch(input: LiveJournalAnchorReadInput): void {
	if (!plan) return; // Original genuine prerequisite reads are not synthetic composition.
	const owner = owners[0];
	if (!owner || owners.length !== 1) throw new Error("NATIVE_DISPATCH_BYPASSED_REAL_OPERATION_OWNER");
	dispatches.push({ input, chargedBytes: owner.chargedBytes });
}
export function journalResult(result: LiveJournalAnchorReadResult): void {
	if (plan) results.push(result); // Observe the genuine result object; never replace it.
}
