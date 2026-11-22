# Mixed-cohort expiry

Question: does actual IndexedDB maintenance remove exactly eligible persisted scopes and chunks?

Extend the existing quarantine expiry fixture and browser test. Use verified/released and interrupted cohorts, real chunks, refreshed and duplicate writes, and younger survivors. Check expiry-minus-one and exact equality, time passage without maintenance, explicit sweep and openScope-triggered sweep. Reopen before expiry and prove exact survivor bytes and resumability. Restore Date.now and close resources in finally.

Verification: execute the existing browser quarantine config across its supported engines, preserving receipt, schema and crash controls. Assert exact row conservation and survivor data rather than physical file shrinkage. Production quota remains native outside the existing deliberately mocked admission contract.
