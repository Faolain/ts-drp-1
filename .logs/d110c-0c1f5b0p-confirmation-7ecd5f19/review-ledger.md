# D.110c-0c1f5b0p combined design confirmation ledger

## Reviewed checkpoint

- signed/pushed commit: `7ecd5f19bea4e6e0350bd307fbf2374c0f5a4970`
- prompt: `prompt.md`
- schema: `schema.json`
- scope: combined f5b0p/f5b0 design, first-review P0/P1 closure, and authority
  for f5b0p-a tests-only RED
- result: `CHANGES_REQUIRED`; RED remained unauthorized and did not run

## Reviewer results

### Grok 4.6/high

The runner completed normally in 586.349 seconds with exit code zero,
`stop_reason=end_turn`, and `timed_out=false`. Its classifier recorded
`NO_VERDICT` because `public.txt` contains inspection prose before the terminal
JSON. The preserved terminal JSON itself says `APPROVED`, authorizes only
f5b0p-a RED, and reports zero P0/P1 plus four P2 findings. This was not a
cancellation, so the exact session was not resumed.

P2 dispositions:

1. Add exact candidate-to-current installation semantics to f5b0p-b. Accepted
   and strengthened by the blocking Kimi lifecycle finding below.
2. Remove the signed settlement checkpoint codec/measurement from f5b0p-a and
   leave it wholly with f5b0a. Accepted and strengthened by Opus P1.
3. Define restored null `admittedThrough` as the genesis zero-start rule.
   Accepted.
4. Bind settlement mode to the genesis profile rather than checkpoint presence.
   Accepted; f5b0p-a's low-level profile widening must leave every product path
   fail-closed until f5b installs the mandatory carrier.

### Direct Kimi K3, 100-step limit

The standard direct run completed with exit code zero and session
`session_c25ee041-96a8-4f04-9d53-3c80ebb9536e`. Its terminal JSON says
`CHANGES_REQUIRED`, with one P1 and four P2 findings. An immediately rejected
earlier CLI spelling combined `--prompt` and `--plan`; that was a launcher
syntax error, not a model verdict, and the standard direct command was then run
once.

Blocking P1 disposition:

- The registry store omitted exact adoption promotion and genuine room-
  rollback reversion. Accepted. The corrected contract now uses opaque
  verifier-produced checkpoint/lifecycle bindings, monotone state revision,
  signed-candidate binding, atomic adoption/rollback installation, explicit
  oldest-rollback eligibility, authenticated candidate discard and exact
  unknown-outcome recovery. f5b0p-b RED owns all state transitions.

P2 dispositions:

1. Pin the exact genesis predecessor digest/domain. Accepted under sole codec
   owner f5b0a.
2. State the permissionless rule. Accepted: application authorization still
   requires ACL membership, so no non-ACL writer bypass exists.
3. Pin deletion rotation tie-breaking. Accepted in f5b0p-a vectors.
4. Enumerate every fixed profile literal. Accepted with explicit widen/reject/
   unchanged dispositions across protocol-v3, Node, v3-room, v3-chat, grid,
   protocol-v2 and historical assets/vectors.

### Opus xhigh

The direct stream completed with exit code zero and session
`60f482da-9092-4b3d-9544-a9a4f97a3710`. Its structured terminal result says
`CHANGES_REQUIRED`, with two P1 and five P2 findings.

Blocking P1 dispositions:

1. AVL deletion rebalancing needs authenticated off-path sibling/inner-child
   nodes. Accepted. The corrected witness has an exact rebalance-node schedule,
   checks it against each evolving intermediate root, retains no-surplus
   validation, and raises the conservative bounds to 24,320 node visits,
   24,903,680 node bytes and a 33,554,432-byte whole-witness cap.
2. The settlement checkpoint codec had two owners and no exact genesis digest.
   Accepted. f5b0p-a now excludes it; f5b0a owns the complete signed codec,
   measurement and domain-separated genesis predecessor.

P2 dispositions:

1. Pin zero-balance deletion rotation. Accepted.
2. Do not sweep an unresolved candidate during reclamation. Accepted: it is in
   the mark set and omission refuses the operation.
3. Name the settlement branch at both creator-transition retirement and
   aggregate checks. Accepted under f5b.
4. Keep all product paths fail-closed between low-level profile parsing and f5b
   integration. Accepted with a retained test owner.
5. Restrict f5b0p-b room construction overlap. Accepted: construction/disposal
   only, with no room policy, issue, rebase-outbox or creator-close behavior.

## Blocking union and custody

The combined union was three P1 findings: lifecycle registration transitions,
AVL deletion rebalance evidence/bounds, and signed-checkpoint codec ownership.
All are material design findings, not bookkeeping. The correction changes only
the plan and design evidence; it does not edit production source, run RED, or
authorize GREEN. The original streams and runner classifications remain
immutable. Mechanical validation of the corrected text cannot be represented
as a reviewer verdict and does not rewrite the recorded blocking union.
