/* eslint-disable import/no-unresolved -- these exact public subpaths are the production RED. */
import type {
	AppendAcceptedVertexInput,
	AppendAcceptedVertexResult,
	DurableLiveJournalStore,
	InstallLiveJournalGenesisInput,
	InstallLiveJournalGenesisResult,
	LiveJournalAcceptedRow,
	LiveJournalFailureKind,
	LiveJournalPageInput,
	LiveJournalPageResult,
	LiveJournalReadinessInput,
	LiveJournalReadinessResult,
	LiveJournalScope,
	LiveJournalSnapshotToken,
} from "@ts-drp/live-journal";
import {
	type BrowserDurableLiveJournalStoreOptions,
	createBrowserDurableLiveJournalStore,
} from "@ts-drp/storage-browser/live-journal";
import {
	createNodeDurableLiveJournalStore,
	type NodeDurableLiveJournalStoreOptions,
} from "@ts-drp/storage-node/live-journal";

declare const browserOptions: BrowserDurableLiveJournalStoreOptions;
declare const nodeOptions: NodeDurableLiveJournalStoreOptions;

// @ts-expect-error -- durable backend authority is adapter-private, never a public journal-root type.
type ForbiddenBackend = import("@ts-drp/live-journal").LiveJournalBackend; // eslint-disable-line @typescript-eslint/consistent-type-imports -- negative type-surface oracle.
// @ts-expect-error -- the public journal root cannot mint a generic strict durable facade.
type ForbiddenFactory = typeof import("@ts-drp/live-journal").createDurableLiveJournalStore; // eslint-disable-line @typescript-eslint/consistent-type-imports -- negative value-surface oracle.

const browser: Promise<DurableLiveJournalStore> = createBrowserDurableLiveJournalStore(browserOptions);
const node: DurableLiveJournalStore = createNodeDurableLiveJournalStore(nodeOptions);

type Pins = readonly [
	AppendAcceptedVertexInput,
	AppendAcceptedVertexResult,
	InstallLiveJournalGenesisInput,
	InstallLiveJournalGenesisResult,
	LiveJournalAcceptedRow,
	LiveJournalFailureKind,
	LiveJournalPageInput,
	LiveJournalPageResult,
	LiveJournalReadinessInput,
	LiveJournalReadinessResult,
	LiveJournalScope,
	LiveJournalSnapshotToken,
];

declare const pins: Pins;
void browser;
void node;
void pins;
void (null as unknown as ForbiddenBackend);
void (null as unknown as ForbiddenFactory);
