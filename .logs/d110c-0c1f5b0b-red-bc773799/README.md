# D.110c-0c1f5b0b rejected-GREEN corrective RED

Signed tests-only commit `bc773799c1a994a3b8a920d9f79ea080d3fc6447`
captures the rejected GREEN review's reachable compatibility regressions and
the actionable malformed-plan P2 without changing production.

The final focused result is the accepted evidence-backed matrix: 12 selected,
3 compatibility controls passed, 9 causal product obligations failed, and 0
skipped. All nine failures are assertion-level differences in current product
behavior. There is no missing import/export/module, fixture exception, setup
failure, or source-shape/regex failure in the final run.

The first two runs remain here intentionally. `diagnostic-initial.json` records
the initial fixture-contaminated attempt. `corrected-11.json` records the first
fixture-clean result and the discovery that local generation already rejects a
bad causalJoin ABI. `final-12.json` adds the genuine signed-ingress control and
proves that authenticated extraction/catalog admission rejects the bad ABI
before the changed `isControlOperation` predicate. This narrows Opus's separate
reservation-bypass subclaim as unproven/redundantly guarded; it does not erase
the causal legacy sink/fold regression.

