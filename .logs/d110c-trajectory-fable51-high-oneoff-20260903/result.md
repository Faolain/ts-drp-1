# D.110c trajectory — one-off Fable 5.1/high review

- Session: `8323a0e9-296a-4f5f-b981-cf2c034725b6`
- Model: `claude-fable-5-1`
- Effort: `high`
- Terminal state: completed successfully; no nested subagents
- External transcript:
  `/Users/aristotle/.claude/projects/-Users-aristotle-Documents-Projects-ts-drp-1/8323a0e9-296a-4f5f-b981-cf2c034725b6.jsonl`
- Transcript SHA-256:
  `b0f317390e0b023063b344a282383c08ee3a880e1f67db907677c8461bdc2b8e`
- Transcript bytes: `871355`
- Verdict: `CORRECT_NARROWLY`
- Trajectory sound: `true`
- Counts: P0=0, P1=1, P2=5

## Blocking finding

The existing f5 audit correctly identifies the numeric-boundary silent-stall
case, but it omits related reachable close-wide failures in
`packages/node/src/creator-close.ts`: duplicate author/sequence slots throw at
line 489; an offline noncreator first observed above a null prior boundary
throws at lines 513–525; and an admitted sequence at or below the previous
boundary throws at line 528. Because ingress does not enforce a per-author
sequence prefix and rebase reissues displaced operations at fresh sequences,
an honest offline noncreator can leave a persistent vertex that makes each
later creator close fail. This blocks the repeated same-room golden path.

The narrow required correction is docs/tests planning only before production
work: add null-boundary, regression, and duplicate-slot cases to f5's causal RED
matrix and freeze a close-liveness invariant under which a foreign author's
sequence anomaly may stall/refuse that author's frontier but cannot prevent the
creator from closing the room.

## Nonblocking findings

1. State the actual authority of a covered-historical row before selecting the
   f5 proof family; the current consumer authorizes a reissue candidate, not
   application state directly, so do not select a needlessly heavy proof from a
   stronger threat claim.
2. Prefer one combined governing review for signed f2/f4 checkpoint acceptance
   and f5 exact-design selection because f5 changes the same aggregate carrier.
3. The null-boundary branch emits `LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED`
   where the plan assigns `AUTHOR_REENTRY_PROOF_REQUIRED`; cover and correct it
   during f5 GREEN rather than as a separate slice.
4. The cross-object displaced-source branch stores a target-derived bootstrap
   policy in an unused field, while the asserted same-room transport handoff
   correctly uses the source registration's policy. Narrow the plan wording or
   remove/fix the dead field during the relevant owned change.
5. Describe aggregate writer-set equality as creator-attested rather than
   independently verifier-derived. The removed transition-side successor-ACL
   check remains correctly rejected because no detached successor ACL candidate
   exists and the creator already owns the transition signature.

## Recommended order

1. Amend f5's plan and RED matrix with the close-wide liveness cases.
2. Run one Grok/Kimi/Opus review covering f2/f4 checkpoint acceptance and f5
   exact-design selection.
3. Produce genuine-product-path f5 REDs for null- and numeric-boundary rebase,
   plus no-gap controls, restart, later closes, reopen, and publish.
4. Implement only the accepted f5 construction and rerun its focused, retained,
   browser, static, and isolated-checkout gates.
5. Continue through D.110c-c restart/pruning/census, D.110c-d's at-least-100
   same-room transitions and memory gate, then Phase 7 archive/cold join.

This advisory review authorizes neither production edits nor a campaign. No
further Fable invocation is authorized without a new express user request.
