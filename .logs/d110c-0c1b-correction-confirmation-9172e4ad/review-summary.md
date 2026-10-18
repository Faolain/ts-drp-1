# D.110c-0c1b P1-correction confirmation

Reviewed signed/pushed commit
`9172e4adf60108b4c195c20ce61a7c67d2d8266d` (tree
`0de18a80fbd21967621ef05f39ee43f829e6d466`) relative to accepted GREEN
`7e3be150bdfd75683aa4473c947758f79c1b1fce`.

- Grok 4.6/high: `APPROVED`, P0 0, P1 0, P2 0. The review ended normally
  with substantive approval plus JSON after progress prose. The exact session
  `01a065b7-2ea2-70f3-9124-d02ab6d97547` then re-emitted schema-only JSON; it
  was neither canceled nor relaunched.
- Direct Kimi K3 with `KIMI_LOOP_MAX_STEPS_PER_TURN=100`: `APPROVED`, P0 0,
  P1 0, P2 0. Session
  `session_ad65b43e-0c4c-41d1-8396-b053c9c8e542`.
- Opus xhigh: `APPROVED`, P0 0, P1 0, P2 1. Session
  `80e7def3-4cd0-45ea-a762-85b111d1cc4c`.

The blocking union is empty. Opus's P2 notes that the non-terminal capacity
arm is executed while the terminal capacity arm is proved by source ordering.
Disposition: accept the existing invariant. In the terminal arm,
`commitOutsideTransaction(expectedSequence)` completes before
`terminalTransactionStarted = true` and before `transactIssue`; a capacity
throw is therefore necessarily pre-durable. No extra test or slice is added.

No Fable or collaboration subagent ran.
