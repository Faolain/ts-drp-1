# Node suite before/after (packages/node/tests, --exclude .claude/**)

- before (4c4f192c): total 1037 passed 988 failed 49
- after  (Track A):  total 1049 passed 998 failed 51

## Newly failing after (2)

- `tests/creator-closed-rollback-proof-accounting.test.ts` :: same sizing owner eliminates repeated canonical primitive and evidence-selection passes preserves codec/refusal/node-depth-item rules and uses bounded overflow fallback without byte credit
  - before: passed 8602 ms; after: 10030 ms — Error: Test timed out in 10000ms. If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".     at 
- `tests/creator-finishing-width-program.test.ts` :: source finishing numerical field program (no proof authority) retains the original issuer/journal control and complete seven-field membership codecs
  - before: passed 6700 ms; after: 12374 ms — Error: Test timed out in 10000ms. If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".     at 

## Fixed (0)


## Added tests (12)

- `tests/creator-recovery-pool-gameplay.test.ts` :: ingress during a quiescent pool boundary queues arrivals behind an entered pool boundary instead of dropping them — passed
- `tests/creator-recovery-pool-gameplay.test.ts` :: ingress during a quiescent pool boundary keeps dropping arrivals at a real close or after a failed boundary — passed
- `tests/creator-recovery-pool-gameplay.test.ts` :: pool boundary queue slot marks only an entered opt-in pool boundary as queueing, then clears it — passed
- `tests/creator-recovery-pool-gameplay.test.ts` :: pool boundary queue slot runs the post-boundary capture after release but inside the same slot — passed
- `tests/creator-recovery-pool-gameplay.test.ts` :: pool boundary queue slot never runs the post-boundary capture for a deferred or failed boundary — passed
- `tests/creator-recovery-pool-gameplay.test.ts` :: pool boundary queue slot propagates a failed post-boundary capture to the caller — passed
- `tests/creator-recovery-pool-gameplay.test.ts` :: automatic idle recovery-pool maintenance runs once per epoch after an idle period — passed
- `tests/creator-recovery-pool-gameplay.test.ts` :: automatic idle recovery-pool maintenance waits while the room is active or busy — passed
- `tests/creator-recovery-pool-gameplay.test.ts` :: automatic idle recovery-pool maintenance backs off exponentially on busy results, capped, and settles afterwards — passed
- `tests/creator-recovery-pool-gameplay.test.ts` :: automatic idle recovery-pool maintenance does not retry an unsupported epoch and stops after a failure — passed
- `tests/creator-recovery-pool-gameplay.test.ts` :: automatic idle recovery-pool maintenance ignores a throwing observer and stops on close or stop() — passed
- `tests/creator-recovery-pool-gameplay.test.ts` :: automatic idle recovery-pool maintenance rejects invalid bounds — passed

## Failing in both (pre-existing)

- `tests/creator-closed-rollback-proof-accounting.test.ts`: 21
- `tests/creator-ordinary-readiness-producer.test.ts`: 1
- `tests/creator-ordinary-settlement-capacity.test.ts`: 2
- `tests/creator-ordinary-suffix-preflight.test.ts`: 5
- `tests/creator-replay-seal-native.test.ts`: 3
- `tests/ephemeral-webrtc-e3-02-red.test.ts`: 11
- `tests/network-start-bootstrap-retry.test.ts`: 1
- `tests/queue-isolation.test.ts`: 2
- `tests/sync-state-heap-recharacterization-1o-f-ii-red.test.ts`: 3

## Note on the two newly failing tests

Both are 10 s default-timeout expiries under a loaded machine (the parent's three
background agents were running suites concurrently), not assertion failures. Neither
test touches the changed code paths (ingress gate, readiness slot, pool scheduler).
Re-run in isolation with `--testTimeout=60000`: the proof-accounting test took 10.7 s on
Track A vs 9.5 s on 4c4f192c at similar load (noise); the finishing-width test passed in
3.3 s. The one readiness-producer failure ("uses the genuine same-head pair ...") fails
identically on 4c4f192c. `creator-ordinary-readiness-producer.test.ts` otherwise needed
only the new `resumePendingIngress` stub (it asserts the resume runs after the job leaves
`maintenanceJobs`).
