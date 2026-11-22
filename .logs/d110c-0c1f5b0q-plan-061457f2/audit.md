# D.110c-0c1f5b0q material-reslice plan audit

## Inherited evidence

- base correction checkpoint:
  `061457f2dad3ed5590832c8968061654bd8bf4ff`, signed and pushed with HEAD equal
  to upstream before this plan-only edit;
- original f5b0p confirmation: immutable three-P1 union under
  `.logs/d110c-0c1f5b0p-confirmation-7ecd5f19/`, manifest SHA-256
  `cc51d7f05569d74de919c8e7e79f15e99ac384b6035963400ec76e7e0ac3805b`;
- corrected f5b0p design: manifest SHA-256
  `bbe10989220332019dad9e9d9a5c66d567241944ca28578a2db091e88643aff7`;
  and
- deterministic correction audit: manifest SHA-256
  `869653e23f2659f0ad28040ed7d7973a58e58c7bb007df98941c178a0638e40b`.

All three inherited manifests validate. The rejected confirmation remains
rejected; no reviewer result or prior evidence byte is reopened.

## Why this is a reslice

The one permitted f5b0p confirmation found three material executable defects:
the deletion witness could not reconstruct rotations, its internal resource
bound was consequently wrong, the signed checkpoint codec had two owners, and
the registry contract lacked adoption/rollback state transitions. Because those
findings change witness grammar, an internal hard cap, codec ownership and the
durable lifecycle state machine, local prose correction cannot authorize RED
and another f5b0p confirmation would violate the consumed cap. f5b0q is the
narrow prospective owner of only those review-demonstrated changes.

## Mechanical plan checks

- The plan contains exactly one f5b0q heading and seven numbered acceptance
  rows.
- The slice contains exactly one explicit no-RED/no-production status, one
  direct Kimi 100-step requirement and one Fable/collaboration prohibition.
- It preserves the selected creator-authenticated Merkle AVL family, fixed
  creator authority, public/wire compatibility boundary, existing 8,192-byte
  signed-checkpoint ceiling and all prior D.110c evidence.
- It authorizes only one bounded Grok/Kimi/Opus plan review. An empty P0/P1
  union may authorize only f5b0p-a tests-only RED; it cannot authorize storage
  RED, GREEN, product edits, campaigns or long workloads.
- `git diff --name-only` before this audit contained only the production-
  hardening plan; the package/example diff was empty and `git diff --check`
  exited zero.
- Protected `.agents`, `.claude` and `.pnpm-store` remain present; stash count
  is 27; ports 4174, 4175, 51000 and 51002 are clear.
- No Fable or collaboration subagent was launched, resumed or retried.
