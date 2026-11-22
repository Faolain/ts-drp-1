Continue this exact review session. The prior foreground turn was interrupted
only after it stopped emitting progress while waiting for two delegated
workstreams. Do not delegate or inspect further. Synthesize the complete
findings already available in the session, including any completed worker
results, and return exactly one JSON object with no prose or markdown fence.

Required keys: `verdict` (`PASS` or `BLOCK`), `p0`, `p1`, `p2`, `red_causal`,
`green_closes_red`, `scope_preserved`, `evidence_valid`, and `summary`.
Each P0/P1 item must contain `title`, `evidence`, `impact`, and `repair`; each
P2 item must contain `title`, `evidence`, `owner`, and `disposition`.
