# Accepted causal matrix

| Case | Result | Observed causal seam |
| --- | --- | --- |
| Durable plan before fence; rebase/transform links; expire no issue | FAIL | Startup issued legacy replacements without a settlement fence or durable plan effect. |
| Manual-review durability and startup barrier | FAIL | No settlement plan was written; `probe.plan` remained `null`. |
| Same-epoch linked retention; displaced linked replacement as new source | FAIL | No replacement issue carried a plan effect for the newly displaced source. |
| Displaced fence clearing; terminal row removal; larger fence | FAIL | No author-fence issue was emitted. |
| Published displaced source without target-map presence | FAIL | Existing room code threw `v3 room published displaced operation is absent from target`. |
| ACL source surfaces before fence | FAIL | Policy classification occurred, but no plan-write event preceded it. |
| Reserved empty-intent source covered by fence | FAIL | Only the public message was issued; no settlement fence was issued. |
| Ambiguous atomic link readback and no reissue | FAIL | No settlement plan existed after the attempted replacement. |
| `creator-trusted-v1` retained completion path | PASS | Legacy completion remained active with no settlement plan or fence. |

Aggregate: one selected file, nine tests, eight expected failures, one control
pass, zero skips, zero unexpected fixture/import/export failures.

