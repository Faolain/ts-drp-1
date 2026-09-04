# Causal matrix

| Owner / case | Expected | RED result |
| --- | --- | --- |
| Exact-store maintenance identity | exact facade resolves; copy/proxy denied; rebinding denied | pass |
| Memory plan gate: absent/null fence/manual review/unlinked anywhere | `ISSUANCE_RETRY_REQUIRED`; rows retained; watermark null | pass |
| Browser plan gate: same four states | same | pass |
| Node plan gate: same four states | same | pass |
| Memory mixed epochs 5/6/7, pending and published | delete 0–2; replay null range | pass |
| Browser mixed epochs 5/6/7, pending and published | delete 0–2; replay null range | pass |
| Node mixed epochs 5/6/7, pending and published | delete 0–2; replay null range | pass |
| Memory contains epoch 8 under closed epoch 7 | `ISSUANCE_INVALID_ARGUMENT`; all rows retained; watermark null | **fail:** success/deletion/watermark 2 |
| Browser contains epoch 8 under closed epoch 7 | same | **fail:** success/deletion/watermark 2 |
| Node contains epoch 8 under closed epoch 7 | same | **fail:** success/deletion/watermark 2 |
| Node injected partial outbox delete | `ISSUANCE_RECOVERY_CORRUPT`; rollback both tables and watermark | pass |
| Permanently poisoned store | `ISSUANCE_RECOVERY_CORRUPT`, never retryable | pass |
| Real Chromium IndexedDB combined control | refusal + mixed delete + replay pass; future epoch refused intact | **fail only on future epoch:** code absent, rows gone, watermark 2 |

The Vitest parameter expansion is twelve selected tests. Each plan-gate test
runs all four named plan states in a fresh backend instance.

