# D.110c-0c1f5b0a corrected RED result

- Completed: `2026-09-04T04:12:57Z`.
- Exact selection: one file, ten tests; all ten failed for the intended missing fence, settlement checkpoint, profile, binding, size-limit, and same-anchor behavior.
- The wrong-signer helper now reaches and asserts `SIGNATURE_INVALID` instead of failing its own success assertion.
- The valid successor-ACL fixtures now use the exact proposed frontier authors.
- No missing import, missing export, module-resolution, syntax, or fixture-self-failure occurred.
- Stop rules: no evidence contradicted checkpoint-carried `admissionEpoch`, contiguity, device-local plan authority, or anchor fencing.
