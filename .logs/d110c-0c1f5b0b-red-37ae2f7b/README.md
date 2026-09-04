# D.110c-0c1f5b0b corrected tests-only RED

Signed tests-only commit `37ae2f7b4bc55af0c502ea186fa3deb9f22245d8`
corrects three demonstrated expectation defects without changing production:

1. the displaced `join` vectors now use the genuine v3-chat catalog, reducer,
   and closed ABI, including its required `clientId`;
2. the legacy non-creator sequence-zero row remains pending, while the
   settlement variant remains published, and a separate creator-bootstrap
   control proves that sequence zero is not categorically application-visible;
3. the settlement completion assertion compares `readIssued` call count before
   and after completion, excluding recovery-owned corruption cross-check reads.

The accepted combined RED selected exactly 39 tests across the original and
corrective files: 30 passed, 9 product-causal obligations failed, and 0 were
skipped. There were no missing imports/exports/modules, fixture exceptions,
setup failures, or top-level errors.

`structural-diagnostic-31-of-39.json` is retained honestly: its 31/8 count was
caused by grouping two independently failing sequence-zero profiles in one
test, so the first failure prevented the second assertion from executing. The
mechanical correction restored separate cases and combined two already-passing
ABI controls, leaving the corrective suite at exactly 12 tests.

`prior-green-focused-31-of-39.json` is the requested preserved diagnostic from
the pending corrective GREEN work. It is diagnostic only and does not replace
the accepted RED result.
