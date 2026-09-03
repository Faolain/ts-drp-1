# D.110c-0c1f3/0c1f4 material confirmation

Reviewed signed/pushed commit: `a3bd4e07bce71876fd98ed4e6ded30c1aef49cd3`

This is the single material plan confirmation authorized for the corrected
authority/public-compatibility boundary. The later plan correction dispositions
are validated mechanically and are not sent through a recursive review round;
the combined final GREEN review must inspect them with the complete RED/GREEN
history.

## Terminal results

- Grok 4.6/high, exact session
  `01a06843-5bb3-7102-8434-e3d6282eafce`: `CHANGES_REQUIRED`, P0/P1/P2
  `0/2/4`. The bounded wrapper wrote `NO_VERDICT` because progress prose
  preceded the valid terminal JSON. The same session, without reinspection,
  subsequently re-emitted the already-reached verdict under the exact schema.
- Kimi K3/high with `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, exact session
  `session_2fd7efbd-c126-42d5-8bef-835bb338fe37`: `APPROVED`, P0/P1/P2
  `0/0/3`. The same session subsequently re-emitted the verdict under the exact
  schema after its first terminal object included an extra field.
- Opus xhigh, exact session `0ce5164c-a3ef-4e88-8c95-8395ecd424e0`:
  `CHANGES_REQUIRED`, P0/P1/P2 `0/1/5`.

## Blocking-union disposition

1. The hard-coded `action === "join"` condition is removed. Exact canonical
   equality with the application-configured bootstrap operation is the product
   authority and supports a valid custom bootstrap action.
2. The public cold-reopen compatibility surface is explicitly owned:
   `reopenCreatorSuccessorAdoption()` accepts its exact existing 17-key record or
   that record plus the optional bootstrap-policy key; unknown extras still
   fail. `CreatorSuccessorReopenInput` mirrors the optional value.
3. The public `recoverV3LiveReplica()` exact-record surface accepts only the
   four frozen base/operation-policy/bootstrap-policy combinations. Unknown
   extras still fail.
4. Hot adoption adds no public key. The source registration carries a detached
   policy copy through sealed close facts and private successor live material.
5. Pending adoption recovery adds no key because it performs no live historical
   row classification; the subsequent public cold reopen supplies the policy.

Those corrections close every P0/P1 finding without a wire field, product
behavior change, dependency, new authority, or migration protocol.

## P2 disposition

- Cross-process canonical bootstrap stability is an explicit invariant. A
  value/version mismatch fails closed and requires a separate migration slice;
  the grid-shaped reconstructed-application case is a positive retained gate.
- The null-frontier post-bootstrap refusal is historical-row-only; current
  epoch admission remains unchanged.
- The divergent RED is frozen as a genuine epoch-zero open with value `A`, a
  real transition to epoch `N > 0`, and a same-author/object/database reopen
  with blueprint-valid value `B`; the paired control reuses `A`.
- The displaced-source filtered-store branch must use the matching source
  registration's genesis anchor and bootstrap policy, never the target values
  or `undefined`; a stale-publication mutant is mandatory.
- Signed 0c1f2 RED commit/evidence remain immutable. A supplemental 0c1f4
  tests-only precondition proves Bob sequence zero pending and absent before
  sequence one and then reaches the same frozen 0c1f2 token.
- The held diagnostic GREEN draft remains in the main workspace. The 0c1f4 RED
  is authored and run from a temporary clean worktree rooted at the signed plan
  checkpoint.
- Per-model custody is recorded below and by the self-excluding manifest; no
  missing transcript is represented as present.
