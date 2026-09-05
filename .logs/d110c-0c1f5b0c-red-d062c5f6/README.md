# D.110c-0c1f5b0c room RED evidence

This packet records the tests-only room-orchestration RED at signed commit
`d062c5f64ad7255f67eb91d0eb1c8441acc147c1` on
`codex/phase3a1b-p6-golden-path`.

The accepted focused result selected exactly one test file and nine tests. Eight
tests failed at the existing room orchestration seam; the retained
`creator-trusted-v1` control passed. The four `diagnostic-*` reporters are
preserved only to document fixture/mock corrections. They are not accepted RED
evidence and none of their failures is classified as a product failure.

No production, plan, dependency, or lockfile path is part of the RED commit.
The only changed path is
`tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts`.

