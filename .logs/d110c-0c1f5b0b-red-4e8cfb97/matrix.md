# Accepted causal matrix

| Class | Count | Result |
| --- | ---: | --- |
| Selected | 39 | exact original + corrective files |
| Passed | 25 | controls and already-GREEN obligations |
| Product-causal RED failures | 14 | expected |
| Skipped/todo | 0 | none |
| Top-level errors | 0 | none |

The fourteen causal failures are:

1. legacy causalJoin sink delivery and blueprint fold membership;
2. legacy join application-visible displacement;
3. legacy pending ordinary sequence-zero displacement;
4. settlement published ordinary sequence-zero displacement;
5. settlement issued/outbox mismatch corruption refusal;
6. terminal outcome-unknown latching;
7. typed refusal of non-array settlement-plan entries;
8. typed refusal of an accessor-backed settlement plan;
9. typed refusal of a settlement plan with a top-level extra key;
10. ordinary sequence zero before the published settlement source;
11. ordinary sequence zero before the causalJoin source;
12. ordinary sequence zero before the join source while retaining its empty-intent control;
13. ordinary sequence zero before the ACL source; and
14. ordinary sequence zero before the corrective settlement join-control source.

Failures 3, 4, and 10 through 14 expose the current blanket same-store
sequence-zero suppression. The last case retains `control` in its historical
test title, but its failing predicate is the new RED ordering requirement; the
sequence-one empty-intent semantic predicate is unchanged. The independent
genuine activation-identity control passed and surfaced exactly the two later
cross-object source digests while excluding the authenticated activation
digest.
