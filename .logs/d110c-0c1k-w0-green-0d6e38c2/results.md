# D.110c-0c1k W0 GREEN result

- Completed: `2026-09-04T05:31:22Z`.
- Focused W0 selection: two files, ten tests; 10/10 passed.
- Retained ACL/admission/settlement/live-close/adoption selection: seven files, 66/66 passed.
- Retained creator-close/adoption-commit selection: two files, 20/20 passed.
- Legacy ACL remains `maxBytes: 8192`; `maxItems: 2048` no longer binds below it. The exact 31/64/65/41 decisions match the authoritative RED. Settlement v3 remains 65,536 bytes, 8,192 items, and 256 members.
- One opened-snapshot membership index provides O(1) lookup; recognized oversized records now reject loudly per kind.
- Authenticated `authorShareMultiplier` defaults to four and is enforced at ingress and local pre/post-sign gates without changing `maxEpochVertices`.
- Signed author fences remain in journal, graph, author-share/global accounting, and close commitment while bypassing application/ACL reduction. Local fence issuance remains owned by f5b0b.
- Protocol-v3, control-plane, and Node builds passed; protocol-v3/control-plane typechecks passed; grid/v3-chat production builds and v3-chat typecheck passed; exact-owner lint, format, diff, signature checks passed.
- The authenticated parameters digest is `c92ee60718d7a593e0809e56ddef0c9d55a3015c27ecba8d54dd16547553044a`.
- Pre-existing broad retained/typecheck failures reproduced unchanged at the RED parent and remain explicitly outside W0: five older phase-3a1b transport assertions, Node worker-host/WebRTC/compact-history fixture type errors, and the grid `roomHeadAuthority` fixture mismatch.
- Remaining P2 coverage ownership: f5b0b must prove restart/replay of the locally issued fence; the centralized loud-rejection source path covers other recognized kinds, whose individual codecs retain their own tests.
