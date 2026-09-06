# D.110c-0c corrected-scope rejected result

- Plan/source anchor: `7d5624aa445c1c131d23607110bb5a970b06ae2a`.
- Selection: exactly one Chromium test in one file.
- Playwright status: `1`; reporter totals were expected `0`, skipped `0`, unexpected `1`, flaky `0`, with zero top-level errors.
- Reporter SHA-256: `eefd5b546531b2395a23869e542ed803985deae383bb88c64db603a97abec54d`.
- Observed failure: `undefined is outside the canonical domain` after the genuine recovery call began; the frozen RED token was absent.
- Disposition: rejected as non-causal fixture evidence. The diagnostic AHE inventory intentionally represents absent optional fields as `undefined`, so it is outside the canonical wire domain and cannot be compared with the strict canonical encoder.
- Narrow correction: compare only that diagnostic inventory with the asset's existing sorted normalized fingerprint. Exact canonical equality remains in force for the durable floor and all production carriers.
- Product source, workload, ordering, authority, recovery input, and acceptance token are unchanged.
