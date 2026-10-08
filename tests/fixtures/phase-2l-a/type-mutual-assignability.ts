import type {
	DurableBuildAndSign,
	DurableIssuanceOutboxEntry,
	DurableIssueCommit,
	DurableIssuedRecord,
	DurableIssueScope,
	DurableSignedEnvelope,
	DurableTransactIssue,
} from "@ts-drp/issuance-store";
import type {
	BuildAndSign,
	IssuanceOutboxEntry,
	IssueCommit,
	IssuedVertexRecord,
	IssueScope,
	SignedVertexEnvelope,
	TransactIssue,
} from "@ts-drp/protocol-v3";

type Extends<Left, Right> = [Left] extends [Right] ? true : false;
type Equal<Left, Right> =
	Extends<Left, Right> extends true ? (Extends<Right, Left> extends true ? true : false) : false;

const scope: Equal<DurableIssueScope, IssueScope> = true;
const envelope: Equal<DurableSignedEnvelope, SignedVertexEnvelope> = true;
const issued: Equal<DurableIssuedRecord, IssuedVertexRecord> = true;
const outbox: Equal<DurableIssuanceOutboxEntry, IssuanceOutboxEntry> = true;
const commit: Equal<DurableIssueCommit, IssueCommit> = true;
const build: Equal<DurableBuildAndSign, BuildAndSign> = true;
const transact: Equal<DurableTransactIssue, TransactIssue> = true;

void [scope, envelope, issued, outbox, commit, build, transact];
