# D.110c-0c1a GREEN closure ledger

Base RED commit: `7e2f2694cdd1b3a2feb0265dd0a73fa52dcb52dc`

## Implemented contract

- Added the canonical creator-signed `drp-creator-issuance-retirement-state`
  record, its 8,192-byte bound, opener, opaque verified capability, frozen
  genesis sentinel, and destructively one-use signing preparation.
- Added the matching keychain dispatch without exposing arbitrary-digest
  signing.
- Creator close now derives one dense per-author admitted frontier from exact
  issued/outbox pairs, authenticated graph membership, durable replay, and the
  complete non-exhausted lineage. The scan is bounded by `maxEpochVertices`,
  requires exact lineage/suffix equality, allows a pending admitted row, and
  carries an unchanged admitted boundary across a nonempty later Cut.
- The Node-private transition owner authenticates exactly zero-to-one carrier
  initialization or one-to-one adjacent replacement, normalizes only that
  pair around the unchanged control-plane predicates, and is used by one stage
  and all four verify consumers.
- No `v3-live.ts`, registry, wire table, product dependency, threshold, or
  public root-export change was made.

## Deterministic results

- Focused final: 2/2 passed, including genuine epoch-0 initialization,
  authenticated epoch-1 replacement with an unchanged admitted boundary,
  one-use/cross-request signing, exact closure occurrence, and a valid signed
  same-room stale-prior fork refusal. Root:
  `.logs/d110c-0c1a-green-adversarial-final-7e2f2694`; manifest SHA-256
  `9ebd55702fc02f46ecfd6f972b9afe839c754e5a45a7eac0dca65a3335e9db72`.
- Retained unit/static behavior: 230/230 tests passed across 24 affected files,
  zero skipped/todo. Root:
  `.logs/d110c-0c1a-green-retained-post-refactor-7e2f2694`; manifest SHA-256
  `8a3ba7c69c15d70c3ec7580bbf5daca5b4ddae52cba5af82d2bdca98c3af6c8e`.
- Retained browser: live close 9/9, adoption commit 6/6, successor activation
  24/24, successor product 30/30 with only the separately preserved downstream
  D.110c-0c causal RED excluded, successor epoch 3/3, AHE reclamation 4/4, and
  issuance retention 4/4. Stdout/status manifest SHA-256
  `3eb2fba5e6d2c2d4ed6961c86771ae8b8d7fe35db96c8de6c988a846b33b3a1a`;
  reporter-JSON manifest SHA-256
  `7a09bc9d7fa06721b9244d915407e185a3570a292a9970555c4c85219269ad04`.
- After the final fail-closed scan tightening, live close repeated 9/9 and the
  genuine D.110c-b 0→1→2 hot loop repeated 3/3. Stdout/status manifest SHA-256
  `b6f7ce68ad3aa375ed3f3dfa62d7a2845d1bfa8db97ce8ba2683538f93d284ee`;
  reporter-JSON manifest SHA-256
  `e13a26535d1c89c38fefaf1ce136dc8379a179046d4548e29c99e1f449a9055a`.
- Protocol-v3 typecheck/build/public-entry audit, keychain typecheck/build,
  Node production-source no-emit typecheck/build, storage-browser build,
  actual Node-consumer built-subpath import, exact-owner ESLint, 8-GiB Prettier,
  diff check, and source-shape checks passed. Static-root manifest SHA-256
  `e8e24b3de4b9a979e76f10c1df0a1e305a9ed9206b36aa594e346cde4faa7072`.
- Source shape proves five wrapper consumers (one stage/four verify), the fixed
  `[objectId, author, sequence]` cursor order, exact dense lineage equality,
  the 8,192-byte record bound, zero registry diff, and zero `v3-live.ts` diff.

## Preserved diagnostic corrections

- The first same-boundary probe incorrectly attempted a completely empty Cut
  and reached the pre-existing `CUT_VALUE_MISMATCH` nonempty-Cut rule. The
  accepted control instead keeps a genuine nonempty Cut while holding the
  tracked author frontier constant.
- A test selector initially read `epoch` instead of the carrier's documented
  `closedEpoch`; this was a test diagnostic error.
- The first browser retention run passed product close but had a stale exact
  closure expectation that omitted the new carrier; the corrected assertion
  requires exactly one bounded additional ref and the focused opener proves
  its authenticated kind and identity.
- A built-subpath smoke launched from the monorepo root failed because the root
  intentionally has no bare workspace-package link. The same smoke passed from
  the actual `packages/node` consumer.
- The first exact-owner lint found only import order and a missing explicit
  test-helper return type; the final lint is clean.
- The first protected-process counter used macOS `pgrep -a` as if it printed
  command lines and therefore counted its own shell PIDs. The corrected
  `ps`-based predicate records zero ts-drp test/reviewer/profiler processes,
  zero protected-port listeners, and all 27 stashes.

## Remaining debt and exclusions

- `tests/protocol-v3-canonical-grammar-n1prime-b2a.test.ts` retains an inherited
  source-hash assertion for canonical source hash `25ca...`, while the signed
  repository has long contained `49b585...`. It is preserved as inherited
  N1-prime test-contract debt and was not repinned or relabelled. The current
  protocol-v3 registry/public/canonical behavior gates passed.
- The D.110c-0c epoch-3 same-process cold-reopen failure remains the signed
  downstream causal RED owned by D.110c-0c1. It was not rerun or weakened here.
- D.110a full/preflight identities and every retained campaign remain excluded.
