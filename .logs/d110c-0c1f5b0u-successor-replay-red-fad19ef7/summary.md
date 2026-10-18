# Corrective RED: application state versus snapshot provenance

Status: **CAUSAL CORRECTIVE RED, NOT GREEN.** Signed/pushed tests-only
commit `fad19ef785d75e0f5231e1ddc1f8c78e6da0d31d` replaces the invalid
whole-projection equality with canonical application-state equality and a
separate exact authenticated-snapshot provenance control.

The prior equality mixed two representations: a live message retains
author/sequence/digest metadata, while a cold-reopened authenticated snapshot
message deliberately contains `clientOperationId`, `text` and
`provenance: "authenticated-snapshot"`. Their application content can be equal
without their whole JavaScript objects being equal. The corrected assertion
uses the existing production chat `migration.canonicalStateBytes` owner.
Existing recovered-row digest, exact byte/signature, order, exactly-once,
validation-before-commit, resumed-issue, active-owner and injected-failure
assertions are unchanged. No authority, product behavior or provenance rule
was weakened. All prior evidence, including `7f8cdcaf` and the earlier
noncausal diagnostic roots, remains unchanged; this evidence prospectively
corrects that one expectation.

## Exact isolated proof

Fresh detached checkout:
`/tmp/d110c-f5b0u-successor-replay-red-KC0tfQ/checkout`, at the exact signed
tests-only commit above. The checkout overlays the pre-replay nine-path
candidate preserved in
`.logs/d110c-0c1f5b0u-successor-replay-red-8af5561c/rejected-candidate.patch`.
Its combined binary patch hash is
`3115b50bc0a76662194cdc052313ae2390327c6452b2dc3ccf45a3f97dae09da`.
This is intentionally not the current main-worktree candidate.

The newer incomplete main GREEN candidate is preserved separately at
`23c859208425b2e93fc5f8d15b77eb1b1e7ec4b63619bf7f62b9afdd49a5bb46`.
`identity.json` records both distinct sets of per-file hashes and every
one of the 27 stash identities. Pre/post audits verify the isolated historical
overlay and main candidate independently; neither was edited by this task.
This remains a corrective RED against a rejected candidate, not a clean
GREEN proof. Final GREEN must pass without an overlay.

The exact command ledger, timestamps, exit statuses and complete separate
stdout/stderr are retained. Fresh offline frozen-lockfile install, all package
builds and exact three-test/one-file listing passed. The focused command ran
exactly once on this corrected source, from 05:38:50.887 to 05:38:56.053 UTC
on 2026-09-05, exiting 1 without a signal.

The complete result set contains three failed tests, no passed/skipped/pending
test and precisely 18 intended soft failures: ten in the replay/order/state/
resume case and four in each absent sink-failure/commit-failure replay case.
`validate.mjs` mechanically verifies the full ordered token matrix, selected
counts, statuses, invocation count and both source-custody predicates.
The application-state assertion now demonstrates missing messages, not
metadata differences. `REPLAY_AUTHENTICATED_SNAPSHOT_PROVENANCE` passes;
there is no projection-representation false failure, setup/floor/authority
refusal, missing import/export or timeout.

The real room create, close, authenticated adoption, epoch-1 issuance and cold
reopen all succeed. The historical candidate still sends no recovered replay
deliveries, omits both above-snapshot operations from current application
state, and accepts resumed issue before replay. The fault cases still do not
reach their injected failures because the replay seam is absent; GREEN must
reach those faults and prove fail-closed cleanup. This result does not itself
claim a reached-fault cleanup defect.

Exact-owner lint, formatting and diff checks pass; initial line wrapping was
corrected mechanically and was not treated as RED. All workspace builds pass
in the fresh isolated checkout. No production source, dependency, manifest,
lockfile, runtime configuration, threshold, workload, authority or API was
edited. Protected paths, all stashes, prior evidence and signed refs remain
intact. No reviewer, Fable, subagent, campaign or long workload was invoked.
