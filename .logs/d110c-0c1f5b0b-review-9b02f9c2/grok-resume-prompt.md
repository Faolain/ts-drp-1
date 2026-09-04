Your completed review already reached and emitted a substantive verdict, but you
placed explanatory prose before the JSON object. Re-emit the same final verdict
and findings now as exactly one JSON object, with no prose, markdown fence, or
additional inspection. Do not reconsider the review and do not use tools.

Required keys: `verdict` (`PASS` or `BLOCK`), `p0`, `p1`, `p2`, `red_causal`,
`green_closes_red`, `scope_preserved`, `evidence_valid`, and `summary`.
