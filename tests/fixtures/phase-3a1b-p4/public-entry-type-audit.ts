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
