# Causal failure matrix

| Owner | Current observation | Required GREEN behavior |
| --- | --- | --- |
| issuance-store codec | exact progress entry/effect returns `undefined`; closed commit throws `ISSUANCE_COMMIT_INVALID` | accept and deeply detach only the frozen exact grammar |
| 16/17 bound | valid count 16 is rejected; invalid 17 remains rejected | accept 16, continue rejecting 17 |
| memory store | plan installation rejects `ISSUANCE_INVALID_ARGUMENT` | atomic partial/final chunk linkage and exact refusal taxonomy |
| browser store | plan installation rejects `ISSUANCE_INVALID_ARGUMENT` | structured-clone persistence, restart, atomic linkage |
| Node store | plan installation rejects `ISSUANCE_INVALID_ARGUMENT` | JSON persistence, restart, atomic linkage |
| Node issue | progress effects are classified `malformed-input`; wrong digest/stale prefix are not distinguished | validate before reservation as frozen and accept the exact current prefix |
| Node batching control | genuine byte growth returns nonmutating `split-required`, zero signer calls, zero journal appends | preserve exactly |
| room split | first `split-required` terminates settlement; no sequence is consumed | CAS-upgrade, issue exact prefix, continue remaining suffix |
| room restart | durable partial prefix is ignored and all source intents are reissued through the legacy effect | resume only the remaining suffix above durable logical time |
| room digest | mismatched durable intent digest is ignored and replacement issues | fail closed without issue, downgrade, or rewrite |
| cross-close | original partial prefix is replayed instead of remaining monotonic while displaced chunk is re-sourced | original suffix only plus a separate displaced-chunk source entry |
| Chromium | exact progress plan rejected and no native row retained | accept and round-trip the exact nested value under schema version 2 |

All positive failures reach an existing runtime validator, store transaction,
Node issue path, or room orchestration path. Future type exports are not
imported or referenced by test annotations.
