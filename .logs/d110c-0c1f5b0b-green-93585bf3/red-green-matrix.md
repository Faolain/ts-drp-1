# RED to GREEN matrix

| Obligation                          | RED                              | GREEN                                                                      |
| ----------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| Exact/plain settlement input shapes | 3 accepted invalid shapes        | 3/3 reject fail closed                                                     |
| Durable plan refusal                | Plan never read in 3 cases       | Missing, manual-review and linked fence refuse before issue                |
| Fence issue/link                    | Generic unknown operation        | Dedicated Node issuer applies atomic fence `planEffect`                    |
| Restart/replay                      | Blocked before issue             | Plan-linked authenticated pending fence survives reopen once               |
| Replacement idempotence             | Blocked at fence                 | Atomic source link rejects duplicate and survives restart                  |
| Ambiguous outcome                   | Generic malformed input          | Admission halts and reopen reads atomic row/link truth                     |
| Completion authority                | Legacy method reachable          | `completeRebaseSource` unavailable under settlement profile                |
| Legacy ingress                      | Fence journaled                  | Rejected before journal/application work                                   |
| Published source                    | Skipped                          | Authenticated displaced row is surfaced                                    |
| Structural source handling          | `join` and ACL absent            | `join`/`causalJoin` have no app intent; ACL remains surfaced               |
| Graph custody                       | Complete graph named application | Complete `close*` maps plus explicit control subset/application projection |
| Older-row boundary                  | No owner                         | Any-anchor authentication requires validated frontier context              |
