# D.110c-0c1f5b0a corrective GREEN result

- Completed: `2026-09-04T06:16:07Z`.
- Focused existing/corrective selection: two files, fourteen tests; 14/14 passed both in the agent worktree and after integration on the primary branch.
- Genuine `creator-trusted-settlement-v1` trust now installs/reopens through the real protocol-v3 custody path and preserves the authenticated profile id through successor minting. Settlement prepare signs with successor material and open verifies with floor trust; no current-key equality or new authority model was introduced.
- Authenticated settlement closure validation accepts exactly one settlement checkpoint and zero legacy retirement/aggregate carriers. Legacy `creator-trusted-v1` cardinalities remain unchanged. The exact current ACL digest is derived from the authenticated current-anchor carrier rather than trusted from an unbound caller field.
- Settlement author authorization uses a 65,536-byte profile-specific ceiling and the existing 256-author cap; 256 accepts, 257 rejects by cap, and ceiling+1 rejects. Legacy remains exactly 8,192 bytes/64 authors.
- Genesis adjacency requires the exported sentinel `ab5e3a215840aed1a4306b2a72505ff63d5ef7950d0e13052647249b8cae2a3a`; settled-v1 predecessor adjacency remains exact.
- All package builds, protocol-v3/protocol-v2/control-plane typechecks, protocol-v3 public-package smoke, exact lint/format/diff/signature, and detached-worktree gates passed.
- Retained trust/authorization/ACL/equivocation batch: 117 passed, four inherited failures, nine skipped. Retained closure batch: 26 passed with three inherited D.110c-0b1 failures; D.110c-5e 8/8, Phase-6a 13/13, and 0c1a 3/3 passed.
- The inherited failures are outside the two changed sources: stale registry-v3 hash, packed-consumer missing `@ts-drp/errors`, Noble 2.2 `ExtendedPoint.BASE` fixture failures, and the existing 0b1 bounded-advance/cold-reopen failures. Standalone Node test-inclusive typecheck retains its documented worker-host/WebRTC/compact-history fixture errors; Node source build passes.
- Deferred P2 ownership remains unchanged: full ACL/frontier transition integration belongs to f5b0b; history/control normalization beyond these four blockers stays with the later integration slice.
