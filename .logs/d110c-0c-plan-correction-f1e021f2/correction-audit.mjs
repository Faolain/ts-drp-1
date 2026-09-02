import { readFileSync } from "node:fs";

const path = "docs/production-hardening/production-hardening-tdd-plan-v2.md";
const text = readFileSync(path, "utf8");
const start = text.indexOf("##### D.110c-0c durable pending-adoption resume plan");
const end = text.indexOf("##### Retained long-horizon and golden-path acceptance", start);
if (start < 0 || end <= start) throw new TypeError("D.110c-0c plan slice is unavailable");
const slice = text.slice(start, end);

const checks = Object.freeze({
	blockingFindingRecorded: slice.includes("initial plan review found one P1"),
	completedEpochReopenAssigned: slice.includes(
		"D.110c-c explicitly\nowns generalizing and proving that completed epoch-N reopen"
	),
	durableFloorProviderNamed: slice.includes("origin-scoped IndexedDB database"),
	exactRoomFailurePinned: slice.includes("`D110C_FLOOR_RECOVERY_UNAVAILABLE`"),
	freshProviderRequired: slice.includes("creates a fresh provider instance"),
	functionScopedAuditRequired: slice.includes("`authenticatePendingCandidate()` function body"),
	localStoreReopenRequired: slice.includes(
		"opens every AHE, snapshot, journal, and\nissuance store from durable names"
	),
	noPostCrashFloorAuthorship: slice.includes(
		"may construct,\nreplace, normalize, or mutate a stable/pending value after the crash"
	),
	postCommitIdentityRequired: slice.includes("post-commit signature\nstatus and exact pushed-ref identity"),
	projectionBindingRequired:
		slice.includes("projection epoch and object id equal the authenticated predecessor") &&
		slice.includes("blueprint digest equals the independently resolved catalog blueprint"),
	testProviderDoesNotSelectProductionOwner: slice.includes(
		"neither selects\nnor pre-empts D.110c-0b0's production floor owner"
	),
	verbatimFloorRereadRequired: slice.includes("reads the stored\nfloor verbatim"),
});

if (Object.values(checks).some((value) => value !== true)) {
	throw new TypeError(`D.110c-0c correction audit failed: ${JSON.stringify(checks)}`);
}

process.stdout.write(`${JSON.stringify({ checks, ok: true }, null, 2)}\n`);
