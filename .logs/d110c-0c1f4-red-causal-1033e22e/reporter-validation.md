# Accepted reporter validation

Automated `jq -e` validation passed for:

- expected `1`, unexpected `1`, skipped `0`, flaky `0`;
- zero top-level errors;
- exact two-title ordering;
- 0c1f4 status `passed` and exact stdout token
  `D110C_0C1F4_EXACT_BOOTSTRAP_AUTHORITY_REQUIRED`;
- 0c1f2 status `failed` and exact contained token
  `D110C_0C1F1_MULTI_AUTHOR_FRONTIER_CARRIER_REQUIRED`;
- one pending sequence-zero epoch-zero bootstrap row in each Bob database;
- distinct canonical A/B bootstrap bytes;
- exact sequence-zero `pinned-genesis`, `predecessor-validation`, payload-epoch
  three trace entries for both control and treatment;
- equal later `issuance-rejected` details for A and B;
- no Bob sequence-zero row in Alice's accepted journal before Bob sequence one;
  and
- exactly one Bob sequence-one row and still no Bob sequence-zero row in
  Alice's accepted journal afterward.

Result: `FINAL_REPORTER_VALIDATION=PASS`.
