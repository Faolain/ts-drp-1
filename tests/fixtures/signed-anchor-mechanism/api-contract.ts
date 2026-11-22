// Deliberately fails until the accepted prospective APIs are genuinely wired.
import type {
	DurableLiveJournalStore,
	LiveJournalHistoricalAnchorImportInput,
	LiveJournalHistoricalAnchorImportResult,
	LiveJournalSignedAnchorReadInput,
	LiveJournalSignedAnchorReadResult,
} from "@ts-drp/live-journal";
import { inspectCreatorHistoricalAnchorEnvelope } from "@ts-drp/protocol-v3/creator-close";

import {
	type CreatorClosedRollbackAnchorImportInput,
	type CreatorClosedRollbackAnchorImportResult,
	importCreatorClosedRollbackAnchor,
} from "../../../packages/node/src/internal/creator-closed-rollback-data.js";
declare const journal: DurableLiveJournalStore;
declare const read: LiveJournalSignedAnchorReadInput;
declare const install: LiveJournalHistoricalAnchorImportInput;
declare const privateInput: CreatorClosedRollbackAnchorImportInput;
const reader: Promise<LiveJournalSignedAnchorReadResult> = journal.readSignedAnchorEnvelope(read);
const importer: Promise<LiveJournalHistoricalAnchorImportResult> = journal.importHistoricalAnchor(install);
const privateImporter: Promise<CreatorClosedRollbackAnchorImportResult> =
	importCreatorClosedRollbackAnchor(privateInput);
void [reader, importer, privateImporter, inspectCreatorHistoricalAnchorEnvelope];
