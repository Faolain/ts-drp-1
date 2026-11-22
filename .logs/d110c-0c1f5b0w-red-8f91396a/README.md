# D.110c-0c1f5b0w rejected tests-only RED checkpoint

Disposition: **STOP — unexpected failure matrix; not an accepted f5b0w RED.**
No test correction, production change, reviewer, campaign, or rerun followed.

Signed and pushed tests-only commit:
`8f91396a77cdd9a1f40fee4f1f0f0be844ca1bb7`, parent
`e9c41096ed82c246bcfdf6c6ea214ae6dc7e8e59`.
The four changed paths are recorded in `source-check.json` and `selection.json`.
The checkout and pushed branch matched before the sole execution.

## Sole focused execution

2026-09-05T13:19:28.712Z–13:19:51.386Z, Node v22.15.0,
exit 1, no signal. `red.status.json` contains the exact command.
No test, hook, or product timeout was changed. The test probe uses 256
microtask turns after the real browser-store durable manual-review write.

| Selected file under tests/ | Total | Passed | Failed |
| --- | ---: | ---: | ---: |
| phase-6b-d110c-0c1f5b0c-room-red.test.ts | 24 | 23 | 1 |
| phase-6b-d110c-0c1f5b0s-settlement-plan-red.test.ts | 45 | 45 | 0 |
| phase-6b-d110c-0c1f5b0t-settlement-progress-red.test.ts | 22 | 22 | 0 |
| phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts | 17 | 10 | 7 |
| phase-6b-d110c-0c1f5b0u-store-red.test.ts | 12 | 12 | 0 |
| phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts | 4 | 4 | 0 |
| phase-6b-d110c-0c1f5b0v-callback-contract.test.ts | 2 | 2 | 0 |
| phase-6b-d110c-0c1f5b0w-store-red.test.ts | 93 | 36 | 57 |
| Total | 219 | 154 | 65 |

Zero skips. Collection also selected exactly these 219 tests/eight files.
`reporter.json`, `red.stdout`, `red.stderr`, and `complete-matrix.json`
preserve every result and failure message. No loader/import/export failure occurred.
`failed-titles.json` gives all 65 exact failing titles, observed tokens, and
causal-versus-rejected classification without abbreviating the backend cases.

## Causal observations versus rejected runtime coverage

The native memory/browser/node store matrix matches the frozen expected
57 failures and 36 passing controls exactly. Retained digest, disposition,
link, legacy-linked, and completed-progress mutations produce
`D110C_F5B0W_RETAINED_ENTRY_MUTATION_ACCEPTED` and exact-byte mutation
failures. Existing empty/in-progress protection, nonempty progress origination
refusal, legacy-linked upgrade refusal, undefined-to-exact-empty initialization,
and owner-CAS removal controls pass. The backend removal test deliberately does
not claim membership authentication; genuine authenticated removal remains the
parent close/adopt continuation.

The superseded f5b0c mock-room expectation fails causally with
`D110C_F5B0W_MANUAL_REVIEW_ISSUE_HANG`.

The real-browser runtime group is **not accepted**:

- Five held cases (issue, creator seal, same-epoch reopen, rehearsal, activation)
  stop at `holdCustody` line 488: `issueTransactions` is 1 rather than 0.
  The observer counter starts before target creation and includes startup,
  rather than measuring only the post-durable-hold operation window. The
  preceding exact durable plan/source/lineage/outbox assertions passed, but the
  required runtime ISSUE/CLOSE/REHEARSAL/ACTIVATION tokens were not reached.
  In particular, the same-epoch case stopped before reopen.
- Changed-policy coverage stops at the existing
  `v3 room displacement policy is invalid`: the fixture supplied an unfrozen
  displacement-policy dictionary. It did not reach retained source merge or
  prove the required `v3 room settlement plan source differs` result.
- A genuine **single-generation** migration source did reach a durable target
  manual-review plan, then the bounded probe emitted
  `D110C_F5B0W_MANUAL_REVIEW_REDIRECT_HANG`. This is not the plan-authorized
  pre-frontier deferral: durable hold was reachable. Its source shutdown then
  hit the existing 10,000ms cleanup-hook timeout. The timeout makes this
  checkpoint invalid under the plan; no resolver, source widening, or timeout
  increase was introduced to conceal it.

The new no-hold real creator control passed and threw the exact unchanged
`TypeError("creator close actor failed: CERTIFIED_VALUE_MISMATCH")` through the
forwarding close-owner observation. All nine preexisting f5b0u runtime cases
passed. No successful settlement close/adopt is claimed.

## Static checks and custody

Exact-path ESLint, 8-GiB Prettier check, collection, source-shape and diff checks
passed. An ad-hoc pre-commit root-test tsc invocation could not correctly resolve
workspace package imports and mixed source/dist nominal types; it was not used
as the gate. The recorded package-export source-mapped TypeScript comparison
has four unchanged preexisting diagnostics and zero added diagnostics. Their
full baseline/current bodies are in `typecheck.json`; this is a delta check,
not a claim of a clean repository-wide typecheck or a new package build.

The checked production/test source hashes, all 27 exact stash identities,
tracked status, and the complete preexisting untracked path inventory are
unchanged across execution. `before.json` and `after.json` preserve custody;
`validation.json` summarizes it. No isolated rerun/build was attempted after
the unexpected matrix triggered the required stop.

The plan/code mismatch requiring a future authorized decision is bounded:
the single-generation redirect reaches the hold, so pre-frontier deferral
cannot excuse its cleanup liveness failure. The other two coverage defects
are fixture bookkeeping/shape errors, not evidence for production changes.
Parent f5b GREEN remains blocked. A further tests-only correction requires
authorization; this checkpoint and its consumed execution identity remain
immutable.

`validate.mjs` verifies the complete observed failed matrix and custody while
classifying the RED as rejected. `manifest.sha256` covers every evidence file
except itself.
