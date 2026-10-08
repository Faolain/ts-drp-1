# D.110c-0b0 executable-correction confirmation

The single permitted confirmation inspected signed and pushed commit
`43290dabd06d796758e8da577a53e0c1bb8b303b` from the clean detached checkout
`/tmp/ts-drp-d110c-confirm.LkksN5/repository`. The checkout was clean, its HEAD
equalled the reviewed commit, the branch's origin ref equalled that commit, and
`git verify-commit` reported a good signature from the expected key. The shared
checkout retained all 27 stashes and the protected `.agents`, `.claude`, and
`.pnpm-store` roots.

## Results

- Grok 4.6/high completed normally after 1,516.153 seconds with exit code zero,
  `stop_reason=end_turn`, and no timeout or cancellation. The runner classified
  the stream as `NO_VERDICT` solely because Grok emitted inspection prose and a
  fenced JSON object rather than a runner terminal marker. The exact extracted
  terminal object is `APPROVED`, with P0=0, P1=0, P2=1. Because the service did
  not cancel, the exact-session resume rule did not apply.
- Standard direct Kimi K3 session
  `session_85497fdc-a3b6-46c6-acba-35bd9cb17fce` ran with
  `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, exited zero, and returned `APPROVED`, with
  P0=0, P1=0, P2=1.
- Opus xhigh session `0cd4ad56-3813-41c8-a421-ae3dc6b65ec8` completed normally
  after 523.590 seconds and 56 turns with `is_error=false`. It returned
  `APPROVED`, with P0=0, P1=0, P2=2.

The union of P0 and P1 findings is empty. D.110c-0b0's correction therefore
closes the material findings from the final implementation review: pending
state dominates before transport/activation, room-ahead and provider-ahead are
classified in the frozen direction, and the real product/provider matrix covers
the promised crash orderings and exact failure vocabulary.

## P2 dispositions

1. Root-level `tests/` owners do not have a dedicated TypeScript project. The
   retained D.93.46 test is semantically covered and this is inherited rather
   than a D.110c-0b0 product defect. D.110c-a/b owns adding or extending an
   exact root-test typecheck gate before its final GREEN review.
2. A hypothetical `ok:true` pending recovery carrying a head unequal to the
   selected pending tuple currently refuses with
   `D110C_FLOOR_RECOVERY_UNAVAILABLE` rather than
   `D110C_FLOOR_PENDING_INVALID`. The current recovery owner cannot produce that
   success shape, and both classifications fail closed before provider commit or
   activation. D.110c-0b1 owns the integrity classification when the generalized
   epoch-N recovery vocabulary makes the state reachable.
3. The browser fixture's exceptional `capturedCase` path calls the unimplemented
   `d110cLastPendingRecovery` helper. The passing 27/27 matrix does not traverse
   this diagnostic-only branch. D.110c-a/b test cleanup owns deleting the stale
   call before extending that matrix; it does not reopen the confirmed 0b0
   behavior and requires no further 0b0 confirmation.

No product source, test source, dependency, wire/schema, threshold, workload,
campaign, or D.110a invocation changed or ran during confirmation.

## Artifact identities

```text
2767f9bf412c05bbc35dd7c91028002324e05c3c6a8a68aa4ef95a57136c9c12  prompt.md
72420ed10203b0765806cf9fa776f9854373b53137aa4522108f8b28fcebb699  preclosure-audit.txt
b8d2fdc498dc9710c6a922b1f47d0a3a46ed3a3e27668b9878b1886ef509922c  grok/status.json
c3f40731a51445424e1747e31d764f7c028abf7197448343618d88ca5ed3ae2e  grok/public.txt
475282e5a3352b7053182a95370c9d704ab3e2eff64efb7ef9c18eda10e52858  grok/events.jsonl
a126a73eaf85c5c472b060151ef5b61fcdd66cb6f8f775253b0b7a3f83144cf2  grok-terminal.json
c46e212017409835bf14ba55a35a0a0863d190f8f43937d30206ad395ec7dd40  kimi.stream.jsonl
14d42298d89f684417c5213583c66e4b936b36207a83249b35cf0fecbe3379c1  kimi-terminal.json
f0b3ce8b2205a74f97e0782c1c93024194b009e5d3a662cd926cc2d7ac422956  opus.stream.jsonl
3ad90fb5f3a37a151968150ffa1915eb3786e9fb362b76eb6e8c01f044eaf55b  opus-terminal.json
```
