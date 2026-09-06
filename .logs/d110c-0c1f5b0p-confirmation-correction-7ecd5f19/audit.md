# D.110c-0c1f5b0p confirmation-correction audit

## Scope and result

The combined confirmation of signed/pushed design checkpoint
`7ecd5f19bea4e6e0350bd307fbf2374c0f5a4970` completed with three blocking P1
findings. This bounded correction changes only the plan and design/review
evidence. It does not change production source, run RED, or reinterpret the
immutable reviewer streams.

The correction closes the identified design gaps mechanically:

- deletion witnesses now authenticate ordered off-path sibling/inner-child
  rebalance nodes against each evolving root;
- the conservative maximum is exactly 24,320 visits and 24,903,680 node bytes,
  with a 33,554,432-byte whole-witness cap and 8,650,752-byte structural margin;
- f5b0a alone owns the signed checkpoint codec, its 7,064-byte maximum and the
  exact domain-separated genesis predecessor digest;
- registry custody now has exact signed-candidate binding, atomic authenticated
  adoption promotion, genuine room-rollback reversion, candidate discard,
  oldest-rollback eligibility, reclamation and unknown-outcome semantics;
- null-boundary re-entry, permissionless-member continuity, rotation tie-breaks,
  product-path fail-closed staging, fixed-profile literal dispositions and
  construction-only store plumbing are explicit.

## Commands and evidence

- `node -e` recomputation returned
  `{"visits":24320,"bytes":24903680,"cap":33554432,"margin":8650752}`.
- Exact source-shape counts for `rebalanceNodes`, `installLifecycle`,
  `discardCandidate`, `CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL` and the room-
  rollback matrix row passed.
- A repository-wide fixed-string search found no implemented
  `creator-trusted-settlement-v1` under `packages/` or `examples/` and enumerated
  every current `creator-trusted-v1` literal for later widen/reject custody.
- Both amended design manifests and the fourteen-entry confirmation manifest
  pass `shasum -a 256 -c manifest.sha256`.
- `git diff --check` over the authored plan, audits, designs, ledgers and
  manifests exits zero. Raw Grok/Kimi/Opus streams, stderr and the Grok-captured
  input diff are excluded from that cosmetic check because their original
  externally emitted bytes are immutable evidence and include whitespace that
  must not be rewritten.
- The first combined Prettier invocation exhausted Node's default 4 GiB heap
  while parsing the large plan. This was a formatter-process OOM, not a content
  failure. The exact read-only check rerun with
  `NODE_OPTIONS=--max-old-space-size=8192` completed at exit zero with `All
matched files use Prettier code style!`.
- The targeted diff contains only the plan, the two design roots and the two
  confirmation/correction evidence roots; `git diff ... -- packages examples`
  is empty.
- Protected `.agents`, `.claude` and `.pnpm-store` remain present; stash count
  is 27; ports 4174, 4175, 51000 and 51002 are clear.

## Gate disposition

The review result remains honestly `CHANGES_REQUIRED`; deterministic correction
does not manufacture an empty reviewer union. f5b0p-a RED and every production
edit remain unauthorized until the governing high-risk design-review rule is
satisfied by an accepted exact corrected design. No Fable or collaboration
subagent was launched, resumed or retried.
