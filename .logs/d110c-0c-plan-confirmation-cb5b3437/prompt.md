# D.110c-0c single material plan-correction confirmation

Review signed/pushed commit `cb5b343765b913f557cb30d868f303eba790f83a`
against parent plan commit `f1e021f283048e8e80771fa62347902c94a40227`.
This is the one permitted confirmation of a material plan correction before
RED. Review only; do not edit, run tests, use web search, or spawn subagents.

The initial union contained one P1: a killed browser loses the in-memory test
room-head authority, so a restart could fail before the intended pending
authenticator or recreate the stable/pending pair after restart. The corrected
plan now freezes one test-only origin-scoped IndexedDB-backed
`V3RoomHeadAuthority`. Only the real room's ordinary create/begin/commit calls
write it. A newly launched Chromium process opens a fresh provider and rereads
the exact canonical tuple; neither parent nor fixture constructs or mutates a
floor after the crash. The worker locally re-derives its snapshot declaration
and opens all stores. This provider is causal evidence only and does not select
the unresolved production floor owner.

The same batch also pins deterministic
`D110C_FLOOR_RECOVERY_UNAVAILABLE`/`pending-missing`, binds the current
projection's epoch/object/blueprint, scopes source audits to
`authenticatePendingCandidate()`, records raw-output and commit/ref custody,
and assigns completed pending-null epoch-N reopen to D.110c-c before its
post-adoption restart gate.

Inspect the correction diff, the D.110c-0c subsection, and these owners as
needed:

- `packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts`
- existing persistent-profile process-death fixtures under
  `packages/storage-browser/tests/process/`
- `examples/v3-room/src/index.ts`
- `packages/node/src/creator-adoption.ts`
- `.logs/d110c-0c-plan-correction-f1e021f2/`

Answer these questions:

1. Does the durable test provider close the sole P1 without post-crash
   test-authored positive state?
2. Is that provider implementable entirely in test assets through the existing
   `V3RoomHeadAuthority` contract, without production/API/schema/dependency or
   authority-semantic changes?
3. Does the fresh-process procedure genuinely eliminate pre-crash handles and
   rederive all durable inputs locally?
4. Are the exact RED failure and GREEN projection bindings now deterministic
   and causal?
5. Is completed pending-null epoch-N reopen explicitly and safely deferred as a
   blocker to D.110c-c, without weakening this pending-resume slice?
6. Does the correction preserve 0→1 compatibility, authenticated
   publish→floor-commit→cold-open ordering, and all prior immutable evidence?
7. Is RED authorized now? Identify only concrete P0/P1 blockers; P2 items are
   recorded but cannot trigger another plan round.

Return exactly one JSON object matching `schema.json`, with no markdown or
extra prose. Only P0/P1 may set `CHANGES_REQUIRED`.
