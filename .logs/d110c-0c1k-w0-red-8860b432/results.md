# D.110c-0c1k W0 authoritative RED result

- Completed: `2026-09-04T04:55:12Z`.
- Exact selection: two files, ten tests; all ten failed causally in 34.62 seconds with no fixture, import, export, module-resolution, or syntax error.
- Boundary measurements and expected lifecycle decisions were pinned as: 31 writer-only = 3,450 bytes, accept; 64 writer-only = 7,014 bytes, accept; 65 writer-only = 7,122 bytes, reject by member cap; 41 full-shape = 8,261 bytes, reject by the unchanged 8,192-byte ceiling.
- Current stage/open divergence caused the 31/64 failures and the 65 stage-side failure; 41 proved the byte ceiling remains authoritative.
- A recognized oversized record was silently omitted, membership authorization performed 16,384 linear iterations rather than using an opened-snapshot index, and the authenticated default-4 per-author capacity owner was absent.
- The genuine runtime case admitted an offender at 1,493 vertices instead of stopping at its 1,492 share, did not retain/count the signed fence correctly, and lacked the other-writer/global-close proof.
- No `maxEpochVertices` increase, W1/W2 behavior, or settlement-profile shortcut was required by RED.
