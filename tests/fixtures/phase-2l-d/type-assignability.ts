import type {
	DurableBuildAndSign,
	DurableIssueCommit,
	DurableIssueScope,
	DurableTransactIssue,
} from "@ts-drp/issuance-store";
import type { BuildAndSign, IssueCommit, IssueScope, TransactIssue } from "@ts-drp/protocol-v3";
import {
	type BrowserDurableIssuanceStoreOptions,
	createBrowserDurableIssuanceStore,
	// eslint-disable-next-line import/no-unresolved -- compile fixture resolves the exact public subpath.
} from "@ts-drp/storage-browser/issuance";
// eslint-disable-next-line import/no-unresolved -- compile fixture resolves the exact public subpath.
import { createNodeDurableIssuanceStore, type NodeDurableIssuanceStoreOptions } from "@ts-drp/storage-node/issuance";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
			? true
			: false
		: false;
type Assert<Value extends true> = Value;

type _Scope = Assert<Equal<DurableIssueScope, IssueScope>>;
type _Commit = Assert<Equal<DurableIssueCommit, IssueCommit>>;
type _Builder = Assert<Equal<DurableBuildAndSign, BuildAndSign>>;
type _Transaction = Assert<Equal<DurableTransactIssue, TransactIssue>>;

const browserOptions: BrowserDurableIssuanceStoreOptions = { primaryDatabaseName: "phase-2l-d" };
const nodeOptions: NodeDurableIssuanceStoreOptions = { primaryFilename: "phase-2l-d" };

void createBrowserDurableIssuanceStore;
void createNodeDurableIssuanceStore;
void browserOptions;
void nodeOptions;

export {};
