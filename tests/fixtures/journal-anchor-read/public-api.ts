import {
	captureLiveJournalAnchorReadObservation,
	type DurableLiveJournalStore,
	LIVE_JOURNAL_ANCHOR_READ_MAX_BYTES,
	type LiveJournalAnchorReadFailureKind,
	type LiveJournalAnchorReadInput,
	type LiveJournalAnchorReadResult,
	type LiveJournalFailureKind,
	type LiveJournalScope,
} from "../../../packages/live-journal/dist/src/index.js";
import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/dist/src/live-journal.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/dist/src/live-journal.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type ExactInput = Assert<
	Equal<LiveJournalAnchorReadInput, { readonly scope: LiveJournalScope; readonly maxBytes: number }>
>;
type ExactFailure = Assert<Equal<LiveJournalAnchorReadFailureKind, LiveJournalFailureKind | "read-budget-exceeded">>;
type ExactResult = Assert<
	Equal<
		LiveJournalAnchorReadResult,
		| Readonly<{ ok: true; kind: "missing" }>
		| Readonly<{ ok: true; kind: "present"; scope: LiveJournalScope; exactCanonicalAnchorPreimageBytes: Uint8Array }>
		| Readonly<{ ok: false; kind: LiveJournalAnchorReadFailureKind }>
	>
>;
type Cap = Assert<Equal<typeof LIVE_JOURNAL_ANCHOR_READ_MAX_BYTES, 8192>>;
type OrdinaryUnchanged = Assert<Equal<Extract<LiveJournalFailureKind, "read-budget-exceeded">, never>>;
type RequiredMethod = Assert<
	Equal<
		DurableLiveJournalStore["readAnchorPreimage"],
		(input: LiveJournalAnchorReadInput) => Promise<LiveJournalAnchorReadResult>
	>
>;
declare const input: LiveJournalAnchorReadInput;
declare const scope: LiveJournalScope;
const owner: DurableLiveJournalStore = createNodeDurableLiveJournalStore({ primaryFilename: "type-only" });
const browser: Promise<DurableLiveJournalStore> = createBrowserDurableLiveJournalStore({
	primaryDatabaseName: "type-only",
});
const observed: LiveJournalAnchorReadResult = captureLiveJournalAnchorReadObservation(input, {
	exactCanonicalAnchorPreimageBytes: new Uint8Array(),
	scope,
});
const read: Promise<LiveJournalAnchorReadResult> = owner.readAnchorPreimage(input);
void [browser, observed, read, LIVE_JOURNAL_ANCHOR_READ_MAX_BYTES];
export type ApiPins = readonly [ExactInput, ExactFailure, ExactResult, Cap, OrdinaryUnchanged, RequiredMethod];
