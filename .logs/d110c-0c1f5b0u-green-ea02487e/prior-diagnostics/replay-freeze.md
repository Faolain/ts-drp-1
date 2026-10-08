# Incomplete replay GREEN freeze

Signed/pushed baseline: `7f8cdcaf56bd1f97a325644b6afb4f7ddae6773c` (G).
No additional commit was made. Parent froze production/test work pending a
separate tests-only projection-oracle correction. All 27 stashes and protected
paths remain preserved.

Implemented only in Node v3-live and room index beyond the prior frozen candidate:
successor-only weak-map custody retains exact authenticated recovery bytes and
signatures, consumes them in recovery order through the existing supplied sink,
and deactivates the fresh handle on sink exception before predecessor
terminalization. Room buffers deliveries until successor authority, projection
base and canonical state validation succeed, then commits once before resume.
No exported shape or authority carrier changed.

Node build and room build passed. Focused replay command:

```
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts --coverage.enabled=false
```

2026-09-05 01:33:47 local: exit 1, three tests selected, two passed, one failed,
no skips; 15.37 seconds total, 10.614 seconds tests. Both sink-failure and
commit-failure cleanup tests passed. The success test passed every exact
replay order, canonical-byte/signature, exactly-once commit, authority/base
ordering, resume and one-owner assertion. Its sole failure was
`REPLAY_RECOVERS_PROJECTION`: an old message in the authenticated snapshot
correctly has `provenance: authenticated-snapshot`, not the pre-close live
author/sequence/digest/logical-time metadata which snapshot wire does not carry.
No provenance was manufactured and no assertion was edited.

The already-started diagnostic-only migration observer then hit the unchanged
10-second timeout on the busy host; teardown closed the session and its caught
reason was `v3 room session is closed`. This is not causal evidence for the
earlier `migration reopened target differs` mismatch. No threshold was changed
and no further run was started. Read-only source tracing suggests recovery may
include settlement control vertices omitted by the live sink; that hypothesis
still requires the exact before/after row diagnostic before implementation.

Frozen `git diff --binary` SHA-256:
`23c859208425b2e93fc5f8d15b77eb1b1e7ec4b63619bf7f62b9afdd49a5bb46`.

```
b7024b1a092796ba921b1b7d04e4cb1034b0a7a383bb098a8dd4ffa4b985bd98  examples/v3-room/package.json
e79043942c787d5a15e1bf2a9a8c3c2945e386c9191c1c84ab099fdde3c6d077  examples/v3-room/src/index.ts
00aa85f56e738686049099ded7ff4d1a12c34d54d7dadd9c6d47751df91a5c9a  packages/issuance-store/src/conformance.ts
bd62232c4f8fc2408d975c77b5e43612ea7ed4b07724d172ea4d02a18eafc55e  packages/issuance-store/src/contract.ts
2100ed2037bfb027d9f6090f843f04d9d448135498fa256e208afdd67ec65b8d  packages/issuance-store/src/types.ts
5e8823aecc6b0b06e354e7e97ecd316556aaeb2c275da68c0ef46a6f0110169d  packages/node/src/v3-live.ts
692e02f4381872f26b9d1801ef1d17cd760eb30ca6bfb9d8ffb09f4d27c024bd  packages/storage-browser/src/internal/browser-issuance-store.ts
ab4fa2a5f81c5f674a799387d324e2f83db6dddbda6e22bc5611f0818f140110  packages/storage-node/src/internal/node-issuance-store.ts
56e8b9b56d7e76d4651daec66b6ff8c0bc8150ce9fab588b97b1887f417d1251  pnpm-lock.yaml
```

Earlier incomplete work in `frozen-handoff.md` remains due: backend exact
whole-plan/revision readback, terminal/exception-path audit and all final
static/Chromium/retained/clean-isolated gates. No final GREEN acceptance is claimed.
