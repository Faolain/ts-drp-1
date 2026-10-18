# D.110c-0c1f5b0b corrective GREEN review ledger

Reviewed signed/pushed anchor: bb94a03ff81dfedb9d7ae1865c6adaed6c05fc58; production e07f8a94d5e2449289bebd7aa89f1dcdbd4d9536.

- Grok 4.6/high: PASS, 0 P0 / 0 P1 / 4 P2. The strict runner reported NO_VERDICT only because progress prose preceded the valid terminal JSON; underlying CLI exited 0 with stop_reason=end_turn. No cancellation, timeout, or resume.
- Kimi K3 with KIMI_LOOP_MAX_STEPS_PER_TURN=100: PASS, 0 P0 / 0 P1 / 2 P2; direct session completed exit 0.
- Opus xhigh: BLOCK, 0 P0 / 1 P1 / 2 P2; exit 0, stop_reason=end_turn.

Blocking union: one P1. The candidate rebaseIntents exception changes the frozen legacy displaced join/causalJoin contract from empty intents plus completion to application reissue. Parent 504ca351 and the retained Phase-3g assertion prove the old behavior. Restore that rebase-only legacy behavior while retaining profile-gated application visibility in ingress/sink/fold and every other corrective repair. Correct the tests that blessed the regression under a new causal tests-only RED.

P2 dispositions:

- Authenticated settlement frontier threading/classifier-local terminal suppression: f5b0c/f5b, retained.
- Replacement planEffect authority/validation: f5b0c, retained.
- Payload-seeded settlement control-set handling: f5b, retained.
- Same-store activation-digest runtime coverage: f5b0c when activation/frontier threading is available; static safety accepted here.
- Inherited Node typecheck exit 2: inherited owner; byte-identical normalized output, nonblocking.
- Legacy nonterminal ambiguous-outcome result-kind compatibility: f5b0b closure must restore the parent kind or explicitly pin and disposition it before closure.
- Misleading historical [control] title names: immutable evidence; no edit, naming caveat recorded.

The candidate GREEN is rejected. f5b0c remains blocked.
