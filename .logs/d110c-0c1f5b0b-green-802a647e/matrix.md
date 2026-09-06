# Final compatibility matrix

| Contract | Final behavior |
| --- | --- |
| Legacy signed/live join and causalJoin | Remain application-visible through profile-gated ingress/recovery/sink/fold |
| Legacy displaced reserved rebase action | Empty intents, preserving pre-f5b0b retirement behavior |
| Settlement join/causalJoin/fence | Control-only through profile-aware `isControlOperation` |
| Settlement generic `ISSUANCE_OUTCOME_UNKNOWN` | `issuance-rejected`, admission halted |
| Terminal ambiguous transaction | Terminal latch and `outcome-unknown` intent take precedence for every profile |
| Legacy nonterminal signer-resolved ambiguity | Exact parent `admission-rejected` classification |

The distinction is intentional: live application visibility and displaced
rebase retirement are different compatibility contracts.
