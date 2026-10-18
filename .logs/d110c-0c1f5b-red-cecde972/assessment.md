# Accepted bounded pagination-corrective parent RED

Tests-only commit `cecde972f4aac55714626d1af46dae32a1c7350c` (signature `G`)
was pushed from signed/pushed `aea679ba18c12120c80dc4dcf0bc7d08285e7572`
before the single focused invocation. Only the parent integration test changed:
14 insertions, one deletion. No production, plan, API, wire, schema, crypto,
dependency, workload, threshold or campaign change occurred.

The exact focused file ran once: **1 failed, 1 passed**, two selected tests in
one file, zero skipped/todo tests, no import/setup/top-level or additional soft
failure. The sole failure is the full intended message:

`F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED: genuine settlement successor fails CERTIFIED_VALUE_MISMATCH before checkpoint production`

Settlement duration: 417.582917 ms. The five source-attribution assertions
completed before that genuine first close failed. No checkpoint, frontier,
signature, activation result or capability was fabricated. The test did not
physically enter any post-checkpoint settlement continuation.

The complete v1 control passed in 1532.146791 ms. Besides its unchanged real
issue/close/adopt/cold-reopen/issue prefix, it passed the independent noncreator
reopen and subsequent epoch transition. It now reaches the genuine stale-local-
head/newer-floor probe and pins:

`v3 room successor reopen failed: D110C_FLOOR_MISMATCH: creator successor differs from the authenticated room-head floor`

The local durable issuance census and newer committed floor remain exactly
unchanged after refusal. No stale floor or old AHE head was restored.

## Correction and bounded static audit before execution

The earlier page-limit failure was a fixture-contract error. `durable()` now
uses `readOutboxPage({scope, limit:128, afterKey})` until an empty page, not a
single truncated page. Each row must match the exact scope and strictly advance
the previous sequence. The next cursor is exactly `[objectId, author,
lastSequence]`. A full page causes another read and no row count is capped.
The browser parser's closed key roster is `afterKey`, `limit`, `scope`, with
maximum 128; its actual implementation scopes, compound-key sorts, applies an
exclusive cursor, and only then slices. No product ceiling was raised.

The source audit inspected every call family and all reachable continuation
helpers in the test. Beyond pagination it found no demonstrated tests-only
input-contract defect or new product/API/design contradiction:

| Call family / continuation | Source contract checked and disposition |
| --- | --- |
| Store observations | `readLineage`, `readSettlementPlan`, `readIssued` receive exact `{objectId,author}` scopes; sequences are committed slots or derived from real lineage. `durable` opens a separate facade and closes only that facade. Native runtime observers preserve facade/backend identity. |
| Outbox and AHE census | Outbox paging corrected as above. AHE `readGenerationPage` accepts closed `objectId,limit,cursor`; 64 is within the existing maximum 128 and the returned `nextCursor` is used until exhausted. Active-head and generation results are checked before use. |
| Native issue/fault observers | Real `transactIssue` retains its actual build-before-native-transaction order. Uncommitted ambiguity throws before commit; committed ambiguity throws after native return. Readback uses the original readLineage to avoid self-triggering the deliberate recovery-read fault. The exact backend owns every row/link/lineage mutation. |
| Activation / ownership | Both room-facing activate/reopen exports dispatch unchanged inputs to one query-isolated production activation module per physical peer. Different peers assert different function identities; each peer retains its realm across restart. Shared opaque dependencies stay unqueried. No singleton reset, fake owner or extra capability exists. |
| Stop / reopen | `closeSession` returns its memoized close task, so explicit stop followed by helper stop is idempotent. Sessions are stopped before database replacement; every successful create is registered for teardown. Failure cleanup remains product-owned. The fresh same-key installation receives a distinct transport/database/realm and no issuance copy. |
| Availability / floor / AHE transfer | Only genuine creator AHE and snapshot bytes are copied; writer issuance and journal are not copied. The genuine committed creator floor is received after state transfer and before ordinary reopen. The deliberate stale-head case transfers only the newer floor, keeps local state, asserts fail-closed/no mutation, then uses genuine full transfer to recover. |
| Snapshot declarations | Declaration selects the unique verified scope for the closing epoch, requires all declared chunks, sorts by index, and carries stored manifest/scope fields. Reopen arguments 0,1,2,3 correspond to successor epochs 1,2,3,4, respectively. Creator restart retains existing signer+declaration only for settlement; its authenticated composition/rebind remains an intended GREEN seam, not a newly authorized API. Legacy removes the signer. |
| Publication / delayed paths | Transport false maps to the existing `publish-failed` owner result and leaves pending rows; held transport returns true without delivery to model published-but-delayed work. Application-only hold allows fence/join controls. Ordinary received operations wait for creator authenticated callback; controls are acknowledged by a later FIFO dependent issue. Delayed flags are removed before genuine later-epoch recovery. |
| Main partial-progress path | Two concurrently queued messages create the real application batch; oversized transformed messages split the replacement into durable prefix/uncommitted suffix. Exact original source, plan progress, fence order and later checkpoint frontiers remain product-derived. Existing missing successor/checkpoint/open-progress composition remains GREEN work, not fixture authority. |
| Wide 64-writer loop | 64 initial independent sessions; all 64 contribute in epochs 0–3 (256 baseline issues). Three disjoint rotating cohorts of eight stop only after contribution, remain offline across close/adopt and selected creator restart, then reopen before next-epoch contribution. Two selected sources per transition give six original sources and six replacement effects: 268 operation intents and 262 final application messages. Three closes, 63 noncreator reopens per close, exact per-author lineage/publication/state/ACL/authority and checkpoint continuity checks are unchanged. |
| Other parent cases | Delayed fence/replacement, manual-review, same-key removal/regrant, signed adversarial fence/duplicate ingress, stale-head, ambiguity and positive prune helpers use the same real close/adopt/reopen/issue path. Regrant is an actual creator ACL operation; stale envelopes are original signed bytes. Prune observation calls the real backend method only through a product caller and cannot mint a receipt. Two Superseded ancestors are checked against the real active generation chain and existing cleanup planner contract. |
| Error contracts | Both exact stale-floor sites in `creator-adoption-activate.ts`, room error wrapping, and `completeRebaseSource` settlement refusal match the test's full strings. The intended profile-failure wrapper matches the known real actor failure and pins all five protocol codec sites. Deliberate issue refusals that have no frozen single public error string retain their rejection plus durable-state/no-effect oracles rather than inventing an error token. |
| Bounds / deadlines | Existing parameters, 5,000-ms routed-ack guard and 60,000-ms settlement test timeout are unchanged. No source inspection can establish total GREEN wall-clock cost; RED is not a claim that the unexecuted continuation meets that deadline. No long workload was executed. |

This audit is bounded source evidence, not an execution claim for the downstream
64-writer, fault, prune or repeated-epoch continuations. The one observed causal
RED remains a pre-checkpoint failure. The prior review union is still open;
reviewers must determine whether this corrected RED and its continuations close
the coverage findings before any GREEN production edits.

## Gates and custody

Prettier write/check, exact-owner ESLint and diff checks passed. Exact listing
contains two unchanged titles in one file. Export-aware and Vite-alias-aware
read-only TypeScript checking has zero target diagnostics. The same three
inherited `live-snapshot.ts` diagnostics remain (2741, 7006, 2322); this is not
a full-repository typecheck pass. The executable diagnostic and complete result
are retained beside this assessment.

Both prior rejected roots (`1dcff170`, `8fcbc039`) and the accepted `f5b0r`
design manifest verified before edits and remain unchanged. The 27 stashes,
protected untracked paths and unrelated workspace processes were preserved.
No ts-drp test/campaign/profiler was active at launch; fixed ports 4174, 4175,
51000 and 51002 had no listener. The reporter, stdout and empty stderr are
retained completely. Reporter suite counts include describe accounting;
`testResults` is exactly one physical file. Result metadata is empty for both
assertions, with one failure message total. The self-excluding manifest covers
the whole evidence root and all source inputs are hashed.
