You are the one-off Fable 5.1 HIGH architecture adviser requested by the user
when a new API decision arises. This is read-only advice, not implementation
authorization, not a formal final GREEN review, and not permission to spawn
agents or run tests. Use only Read/Grep/Glob on this checkout; do not modify
files, invoke other agents, run a campaign, or inspect secrets. No RepoPrompt
context was used; file-grounded inspection is the available context.

Goal: real long-lived Discord-style rooms and <=64-active-writer MMORPG worlds,
repeated authenticated same-room rollover, restart/cold reopen, exact state and
authority, safe pruning, bounded active control/memory. Do not substitute
distinct-room churn, synthetic epochs, a smaller workload, or a no-op cleanup.

Current branch codex/phase3a1b-p6-golden-path, signed/pushed HEAD57834387
(a stopped evidence-only descendant may arrive while you inspect). The seven
dirty production files are an incomplete preserved GREEN diagnostic. Do not
treat the diff as accepted design. Corrected RED tests97c0836b/evidence88fef442
passed their causal matrix in an isolated source-built checkout:28active,
23expectedfail,5pass,17filtered/45total. Parent f5b GREEN is stopped again,
without additional production edits, after bounded telemetry.

Read these bounded sources, not the entire 100k-line plan:
- docs/production-hardening/production-hardening-tdd-plan-v2.md, Current frontier
  under Sequencing at a glance; current D.110c-0c1f5b status and production-owner
  clarification; inherited f5b0d-to-parent disposition around lines99490–99540.
- Accepted .logs/d110c-0c1f5b0r-design-3a156aca/design.md and pre-review.md.
  This design's three-model design review was waived by user; don't reopen it
  or read superseded f5b0/p/q grammars. Focus its cleanup and stop boundaries.
- packages/node/src/internal/creator-successor-live.ts (authenticated material
  and current private hooks), creator-adoption-intent.ts, and relevant callers
  in creator-adoption.ts / creator-adoption-activate.ts / v3-live.ts.
- packages/node/src/internal/closed-epoch-cleanup.ts.
- packages/storage/src/maintenance.ts and store interfaces;
  packages/storage-browser/src/maintenance.ts and its internal/ahe-reclamation.ts;
  equivalent existing Node/memory maintenance entry points if relevant.
- examples/v3-room/src/index.ts imports, owned stores, activation/cold-reopen
  around2290–2450; packages/node/package.json and storage-browser/package.json.
- tests/phase-6b-d110c-0c1f5b-integration-red.test.ts positiveAuthenticatedPruning,
  assertRetainedRollbackPair; .logs/d110c-0c1f5b-green-57834387 diagnostic results
  or assessment if present. Do not read giant raw previous review logs.

Concrete architecture gap to verify, not assume:
Node's existing private CreatorSuccessorLiveMaterial holds authenticated
successor/predecessor trust, exact closure/checkpoint/snapshot, AheDurableStore
and issuance store. It has no backend-neutral AHE maintenance resolver.
Browser resolves maintenance only for the exact store facade using
resolveBrowserAheReclamationMaintenance, an existing export on
@ts-drp/storage-browser/maintenance. Room already depends on storage-browser
and owns that store; it currently receives structural successor projection
authority, not Node's opaque authenticated checkpoint custody. Node must not
gain a browser dependency. AheDurableStore has no maintenance method. The
existing D109d runtime hook consumes post-delete receipts and cannot establish
first-delete authority; a previous purported GREEN doing that was rejected.

Parent already owns the genuine first production issuance prune after verified
adoption on hot/restart/cold paths, exact authenticated terminalThrough,
closedEpoch comparison, complete linked plans/fences, older eligible pending
and published rows, bounded schedule, and unchanged legacy scan limits. Its
private cleanup gate path is explicitly allowed in plan57834387, but NEW public
APIs, new authority carriers/registries, backend dependencies, durable schemas,
wire fields, thresholds and policy changes are NOT silently authorized.
Cleanup must retain active+two complete physical ancestors with existing QC,
snapshot, local-only availability, expected-head/revision and lineage gates.
First generation cleanup can have no eligible issuance deletion; inventing
rows, published status or a deletion receipt is forbidden. D.110c-c owns later
scope retirement; don't pull all of it forward.

Please determine the smallest sound composition and compatibility boundary.
Compare existing-capability wiring (if truly possible), explicit dependency
injection of existing exact-store maintenance capability, a new backend-neutral
registry, and a new private room/Node bridge. Prefer clarity over hiding a new
API behind brittle relative imports, global hooks or duplicated trust logic.
Name any required new API/export/input/owner, exact affected packages/files,
who authenticates versus who owns deletion, identity binding, hot/restart/cold
order, no-eligible-prefix behavior and how legacy remains byte-for-byte stable.
If a real prerequisite is required, recommend a narrow explicit high-risk
slice with deterministic RED/GREEN/adversarial/retained gates; do not implement
or weaken bounded-state/golden-path acceptance to avoid it.

Secondary finding (brief advice only): segmented test commits prefix then
deliberately fails signed suffix. It next calls room.projection() on the
terminal owner, which correctly rethrows terminalFailure; retained tests pin
that behavior. Existing onProjection callback can capture the last actually
installed accepted projection for crash/restart comparisons without reopening
the failed owner. Confirm this is a test-observation distinction, not reason
to add a broad product getter bypass. No workload/state limit change.

Return a concise recommendation with exact inspected source citations, rejected
alternatives, API/authority impact, minimal prerequisite boundaries and proof
obligations. State uncertainties honestly. Do not request a new campaign or
re-review the already accepted design. End with a compact machine-readable
summary if convenient, but prioritize defensible source-grounded advice.
