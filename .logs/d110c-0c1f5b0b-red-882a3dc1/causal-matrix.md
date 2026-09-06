# Causal RED matrix

| Result | Test obligation                                           | Observed RED reason                                                                                                                |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| PASS   | settlement v3 ACL and legacy v1 ACL compatibility control | Existing codec/profile behavior is retained.                                                                                       |
| PASS   | epoch-greater-than-zero adjacent settled predecessor      | Existing advance adjacency control is retained.                                                                                    |
| FAIL   | three strict settlement input shapes                      | Extra/accessor-backed shapes currently return `ok: true`.                                                                          |
| FAIL   | missing/manual-review/already-linked plan refusal         | Local issue does not consult `readSettlementPlan`.                                                                                 |
| FAIL   | complete-plan fence issue and atomic link                 | No dedicated fence issuer or fence `planEffect`.                                                                                   |
| FAIL   | SQLite fence restart/replay                               | Blocked at the missing dedicated fence issuer.                                                                                     |
| FAIL   | replacement link, retry and restart                       | Blocked at the missing fence prerequisite.                                                                                         |
| FAIL   | ambiguous transaction halt/reopen                         | Generic unknown-operation rejection occurs before the injected transaction.                                                        |
| FAIL   | settlement completion gate                                | `completeRebaseSource` remains reachable and returns generic record rejection.                                                     |
| PASS   | legacy local unknown-operation control                    | Existing local issue result remains unchanged.                                                                                     |
| FAIL   | genuine legacy fence ingress                              | The fence is journaled under `creator-trusted-v1`.                                                                                 |
| PASS   | huge valid fence, `m > f`, sink/fold exclusion            | Existing settlement ingress grammar/control filtering is retained.                                                                 |
| PASS   | stale same-key old-anchor ingress                         | Current anchor rejects it.                                                                                                         |
| FAIL   | published displaced own row                               | Current reader returns empty because it skips published rows.                                                                      |
| PASS   | displaced `causalJoin`                                    | It classifies with no application intents.                                                                                         |
| FAIL   | displaced `join`                                          | No source is surfaced.                                                                                                             |
| FAIL   | displaced ACL row                                         | No source is surfaced.                                                                                                             |
| FAIL   | six Node owner/source-shape predicates                    | Dedicated issuer, any-old-epoch reader, publication-independent reader, completion gate, graph split, and legacy guard are absent. |

The Node primitives cover design cases 2-10, 12, 19-21 and 25 to the extent
callable before room/creator integration. Literal close-between, two-or-more
close, fresh-device post-checkpoint, and after-close replacement journeys stay
with f5b0c/f5b because they require a genuine authenticated settlement
checkpoint handoff. No tests-only product state substitutes for those paths.
