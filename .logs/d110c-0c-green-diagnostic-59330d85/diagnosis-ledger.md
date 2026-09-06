# D.110c-0c first GREEN diagnosis

- RED anchor: signed/pushed `59330d8567fbee9516b0408e0cf0df744c7ecbcb`.
- First focused GREEN reporter SHA-256: `7de8a9feffd5d3bd5e163027c54135709aeb5f0e4194037fa894a075fbb0f22b`. It was rejected because the diagnostic fixture treated every post-recovery failure as pre-commit and masked the downstream error with `D110C_0C_FAILED_RECOVERY_FLOOR_MUTATED`.
- Corrected diagnostic reporter SHA-256: `f455ec74441d3ddfebb5884c719ddfeff37e143eb2dd9af6a820eca2f05b2982`.
- Demonstrated success: pending recovery ran once, returned `active-new`, swapped the AHE head once for old-AHE ordering, and atomically advanced the room floor from stable epoch 2/pending epoch 3 to stable epoch 3/no pending.
- Demonstrated downstream blocker: the immediate cold reopen failed with `v3 room successor reopen failed: recovery-rejected: creator predecessor recovery failed: admission-rejected`.
- Source candidate: the predecessor issuance wrapper authenticates/skips genesis and successor-relative rows but does not yet prove how arbitrary authenticated intermediate-epoch rows are retired or excluded. The fixture created genuine local rows in epochs 0, 1, and 2.
- Disposition: do not widen D.110c-0c into `v3-live.ts`. Freeze a narrow causal prerequisite RED for intermediate-epoch issuance recovery. Only that RED may establish the exact rejected row and authorize a reviewed filter/retirement repair.
