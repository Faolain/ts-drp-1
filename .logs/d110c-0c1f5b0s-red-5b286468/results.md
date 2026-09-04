# D.110c-0c1f5b0s accepted RED result

- The corrected focused matrix was 24 passed / 21 failed across 45 cases. Passing memory cases proved the test oracle; browser and Node failures pinned the absent plan store, CAS/effect, corruption, readback, pruning, and migration behavior.
- Retained exactness corrections failed causally against the old six-method, browser-v1/three-store, and Node-v2/three-table implementation: 12 unit failures plus four browser failures. Unaffected controls stayed green.
- The original helper defect (successful replacement followed by a stale lineage assertion) was corrected before this accepted RED.
- No failure was caused by syntax, module resolution, missing test import, or a raw undefined future method.
