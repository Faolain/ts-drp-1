# D.110c-0c1b initial plan-review disposition

## Terminal state

- Grok session `01a0654d-539e-78f1-83a7-ae17fb3753a9`: runner
  `NO_VERDICT`, zero exit, `end_turn`, with a valid embedded
  `CHANGES_REQUIRED` terminal payload containing one P1 and two P2 findings.
- Kimi session `session_48110e76-fdc0-4553-89d6-f99abe8ba2ff`:
  `CHANGES_REQUIRED`, one P1 and two P2 findings.
- Opus session `82e7242f-c17a-4b61-8dbb-8ea1a8f0f03f`:
  `CHANGES_REQUIRED`, one P1 and two P2 findings.

## Blocking union and corrections

1. The D.110c-0c1b token is a test-owned case id/unexpected-success marker,
   not a product error. Bind-after-failure must retain
   `CREATOR_CLOSE_UNAVAILABLE`; a pre-bound close must retain the existing
   `creator snapshot export failed: not-active` path.
2. The real stores may durably commit and then throw exact
   `ISSUANCE_OUTCOME_UNKNOWN` before `issuer.issue()` returns. The frozen
   correction therefore binds the caught error and marks the existing halt for
   that exact code even without a policy reservation, while preserving
   definitely pre-transaction signer/capacity behavior. A no-policy fault case
   is added.

These P1 corrections materially change executable scope and therefore require
one plan confirmation after the corrected plan is signed and pushed.

## P2 dispositions

- The causal journal-failure witness first admits sequence 0 and fails
  sequence 1, giving the close a genuine non-empty retirement prefix to
  truncate. This prevents an empty-prefix D.110c-0c1a error from masking the
  intended RED.
- Reusing `operationAdmissionHalted` conservatively affects local and received
  admission and permits an uncertain received path to refuse close. This is an
  intentional fail-closed consequence; the no-failure D.110c-a/b close path is
  retained.
- On queued-fold refusal, creator-close's existing abort path clears
  `blueprintClosing`; the recovery-required halt remains. A refused bind does
  not consume the close claim, and the fresh recovered registration must close.

No schema, wire, API, dependency, authority, workload, threshold or campaign
change is accepted.
