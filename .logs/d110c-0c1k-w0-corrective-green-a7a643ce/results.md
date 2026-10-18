# D.110c-0c1k W0 corrective GREEN result

- One production path changed: `packages/protocol-v3/src/latched-acl.ts`.
  Version 1 again validates and sorts with `GROUPS_V1`; the v2 vocabulary and
  exact-four-group exception are deleted.
- Focused W0: 2 files, 10/10 passed. The authoritative 31/64/65 writer-only
  and 41 full-shape boundaries are unchanged.
- Direct legacy ACL compatibility: 1 file, 7/7 passed, including referee-only
  and exact-four-group v1 refusal.
- Retained ACL/settlement/close/adoption: 5 files, 49/49 passed.
- Protocol-v3 build/typecheck, Node build, exact lint/format/diff, signature,
  pushed-ref identity and fresh detached-worktree gates passed.
- Broad Node package run: 387 passed, 27 failed, 2 skipped. Every failing GREEN
  file also failed at the untouched parent; the parent additionally had one
  flaky spawn-scaling failure. Node test-inclusive typecheck likewise retains
  only the known worker-host/WebRTC/compact-history fixture diagnostics.
- The omitted E5-02 retained consumer was run once: its causal owner sentinel
  failed exactly as designed and its nine GREEN-only cases skipped. Source
  inspection confirms its version-1 context substitutes `writer` for the
  referee member, so restored v1 group closure introduces no new failure.
- No limit, profile, fence, share, close, wire/schema/API, dependency or
  cryptographic behavior changed.
