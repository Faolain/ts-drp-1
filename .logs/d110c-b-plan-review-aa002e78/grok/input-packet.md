# D.110c-b high-risk hot multi-epoch adoption plan review

Act as an independent read-only security/correctness plan reviewer. Inspect
signed and pushed commit `aa002e78` and the actual source owners in this clean
detached checkout. Do not edit files, invoke subagents, run tests, or rely on
another reviewer's verdict. Return exactly one terminal JSON object.

The completed D.110c-a slice is accepted inherited evidence: one genuine
epoch-1 plane can issue/publish and close to a genuine authenticated pending
epoch-2 head. Do not reopen D.110c-a, D.110a, or immutable evidence. D.110c-b
must close only the general hot verification/adoption/activation and product
close-custody loop. Arbitrary epoch-N cold reopen, bounded control proof,
pruning, restart, >=100 transitions, and Phase-7 archive/cold join remain later
slices.

Read the section headed `D.110c-b bounded general hot adoption, activation, and
product-custody plan` in
`docs/production-hardening/production-hardening-tdd-plan-v2.md`, plus at least:

- `packages/node/src/creator-adoption.ts`;
- `packages/node/src/creator-adoption-commit.ts`;
- `packages/node/src/creator-adoption-activate.ts`;
- `packages/node/src/internal/creator-successor-live.ts`;
- `packages/node/src/v3-live.ts`, especially preparation and installed live
  activation;
- `packages/node/src/creator-close.ts`;
- `examples/v3-room/src/index.ts`;
- the D.110c-a and Phase-6a fixtures/tests named by the plan; and
- the room-head/floor helpers and retained product browser configuration.

The bounded audit at base `3118da762c17785a4a34a1f1d6b173370dc33a4a`
found:

1. `creator-adoption.ts` selects only `v3-live-generation-1` at current
   projection/predecessor lines 373/610/666 and emits graph/descriptor epoch 1
   at lines 545/565, although a genuine epoch-1 predecessor is generation-2.
2. `creator-adoption-commit.ts` keeps generation-2 as the successor kind but
   requires generation-1 predecessor at terminal/staged lines 434/491.
3. `creator-adoption-activate.ts` maps stable topic to only bindings+wrapper;
   same bindings return the old wrapper without head comparison, and wrapper
   deactivate unconditionally deletes the topic/releases its lock.
4. `examples/v3-room/src/index.ts` has literal successor epoch 1, binds close
   only at initial setup, permanently returns after first authority exists, and
   installs the replacement live wrapper without replacing the terminal close
   handle.
5. `v3-live.ts` already validates generation-1 only at epoch zero and
   generation-2 for positive epochs and activates from authenticated material.

Decide concretely:

1. Is the proposed RED executable and genuinely causal without fixture-minting
   epoch-2 control state: genuine D.110c-a close then exact `chain-invalid` at
   the epoch-pinned Node verifier, plus genuine browser 0->1 followed by the
   first real post-adoption seal failing through the stale terminal close
   handle?
2. Is deriving projection kind/epoch solely from authenticated current and
   successor trust sufficient, with exact safe-integer next-epoch checks and
   byte-identical 0->1 behavior?
3. Is the same-lock replacement design safe: active entry includes current
   trust/head and ownership token; exact-next only; same-head idempotence;
   consume/alias before swap; failed replacement retains the old owner/lock;
   stale deactivation cannot delete/release the replacement?
4. Does the plan account for the actual terminalization order in
   `activateCreatorSuccessorLive`, browser lock custody, handle aliasing, and
   cleanup races? Identify any impossible ordering or missing owner precisely.
5. Is product rebinding to the existing singular vote/evidence/snapshot stores
   feasible after each activation without a new store/API? Is the specified
   post-activation close-bind failure state honest and implementable, or does
   it violate current lifecycle/floor semantics?
6. Is widening only existing `V3RoomSuccessorAuthority.epoch` from literal 1 to
   validated positive `number` the smallest compatible public change? Flag any
   real consumer/type/build gate omitted by the plan.
7. Do GREEN gates prove the required real 0->1, issue/publish, 1->2 adoption,
   issue/publish, then genuine 2->3 close without pretending this is cold
   reopen or bounded long-horizon proof?
8. Are refusal codes, floor cases, duplicate/idempotent behavior, failed
   replacement retention, delayed stale cleanup, close/shutdown races, exact
   state/ACL/history/accounting, retained suites, and evidence gates complete
   and attributable? Flag any mutant that cannot be produced without private
   production hooks or scope widening.
9. Would any planned GREEN silently require a new public key/method, wire or
   schema field, dependency, cryptographic/authority assumption, threshold,
   workload, or cold-reopen change? If yes, name the exact stop/reslice point.

Only P0/P1 blocks. P2 must be concrete and include a prospective disposition;
do not request recursive review for bookkeeping or prose. Return exactly one
JSON object with no leading/trailing prose:

```json
{
  "verdict": "APPROVED or CHANGES_REQUIRED",
  "blocking_union_empty": true,
  "p0": [{"title":"...","evidence":"file:line and concrete behavior","required_fix":"..."}],
  "p1": [{"title":"...","evidence":"file:line and concrete behavior","required_fix":"..."}],
  "p2": [{"title":"...","evidence":"file:line and concrete behavior","disposition":"..."}],
  "summary": "concise causal verdict"
}
```

Use empty arrays when none. `blocking_union_empty` must equal whether both P0
and P1 are empty.

<runner_git_packet>
HEAD: aa002e78463b3a56377fd26b7bdaa04ecc587396
Status:
(clean)
Staged paths:
(none)
Unstaged tracked paths:
(none)
Exact HEAD commit SHA-256: e6b2b7d7c265a31ec7582c5414e4a983d2cceb99eddc2c89fb35247aec3981b7
Exact HEAD commit file: /Users/aristotle/Documents/Projects/ts-drp-1/.logs/d110c-b-plan-review-aa002e78/grok/review.diff
Use the supplied packet and read-only file tools. Do not invoke a shell or write review notes to disk. Return the requested terminal response directly.
</runner_git_packet>
