Perform the governing read-only plan review for the high-risk D.110c-0c1f3
noncreator genesis-issuance bootstrap authority reslice at signed/pushed commit
`50b281e3dd9732a2dd7403992ec5336dcd96a0ce`. Return only one JSON object
matching `schema.json`. Do not edit files, run tests, delegate, or spawn
subagents.

Inspect:

- D.110c-0c, D.110c-0c1, D.110c-0c1f/f1/f2/f3, D.110c-c, and D.110c-d in
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`;
- `.logs/d110c-0c1f3-plan-review-50b281e3/trace.md`;
- signed RED commit `c584b76bb7376fe2cbf4664dfdebacab8c153568` and its evidence root
  `.logs/d110c-0c1f2-red-f488f1f6/`;
- current working-tree diff only as a diagnostic prototype, not as accepted
  GREEN;
- `packages/node/src/{creator-close.ts,creator-adoption.ts,v3-live.ts}`;
- `packages/node/src/internal/{creator-transition-advance.ts,creator-issuance-retirement-boundary.ts}`;
- `packages/protocol-v3/src/{creator-author-issuance-frontiers.ts,creator-issuance-retirement.ts,latched-acl.ts}`;
- `examples/v3-room/src/index.ts`; and
- issuance/live-journal interfaces and relevant D.110c-0c1 tests.

The contradiction to resolve is exact. The accepted aggregate design says a
new noncreator starts null and advances only through a creator-authenticated
current-graph prefix beginning at sequence zero. The signed product RED has a
continuously authorized genesis writer Bob whose sequence-zero `join` remains
pending in Bob's local outbox and never enters Alice's close graph; Alice later
genuinely admits Bob's sequence-one epoch-one application row. Therefore the
strict rule leaves Bob null forever and the signed RED cannot turn green.

Choose or constrain the narrowest safe candidate:

1. Keep strict graph-only null semantics, which means the signed RED is not
   implementable without changing join publication/orchestration.
2. Reuse existing pinned-genesis row authority plus an exact complete local
   issuance-chain proof to bridge only the sequence-zero bootstrap row, while
   preserving graph admission for later rows.
3. Add an explicit bounded proof-class/base fact to the aggregate carrier,
   requiring a new schema/migration reslice.
4. Make the zero-intent join reach the creator before first close without a
   synthetic setup write, if the existing product lifecycle can do this
   deterministically without changing public behavior.
5. State that none is safe/sufficient and require a narrower architecture
   prerequisite.

Review these proof obligations:

- A valid author signature, ACL membership, local lineage, or untrusted outbox
  row alone must not become creator-observed application admission.
- If pinned-genesis authority is reused, define exactly what it already
  authenticates, why only sequence zero is special, whether a valid but never
  creator-observed epoch-zero application row could be replayed, and how
  missing/substituted/forked/noncontiguous local rows fail before activation or
  rebase.
- The selected rule must distinguish a continuously authorized genesis writer
  from a later addition and same-key re-entry without O(epoch) state. If the
  current tuple `[author,boundary]` cannot encode that distinction, say so.
- The original signed RED must pass without an extra bootstrap message or
  tests-only carrier. The fully observed prefix remains a control, not the
  treatment.
- Preserve exact permissionless writer derivation, legacy/aggregate equality,
  removal/re-entry rules, 8,192-byte ceiling, current wire/authority contracts
  unless explicitly resliced, bounded scan/census/reclamation, rollback,
  pruning, pending/published custody, and Phase-7 cold-join requirements.
- Explain whether the draft's historical-only recovery empty-chain adjustment
  is necessary and sufficient, and what exact accounting/mutants it needs.
- No product edit, dependency, threshold, D.110a rerun, long campaign, Fable,
  or collaboration subagent is authorized by this review.

Only P0/P1 blocks. Use `CHANGES_REQUIRED` iff a P0/P1 exists. Set
`plan_sufficient=true` only if one deterministic implementable authority rule,
its compatibility boundary, RED/GREEN criteria, and adversarial gates are
fully frozen. Set `red_causal=true` only if the signed original RED remains the
right causal test. Set `scope_preserved=true` only if the proposal does not
smuggle new schema, join semantics, or trust assumptions into 0c1f2.
