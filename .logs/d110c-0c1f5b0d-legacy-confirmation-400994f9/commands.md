# Confirmation commands and outcomes

- Grok: `run_grok.py --mode review`, `grok-4.6`, high reasoning,
  1,200-second bound, 64 turns. Normal exit 0/end_turn after 300.12 seconds;
  explicit PASS JSON (0 P0/P1/P2). The strict wrapper records `NO_VERDICT`
  solely because progress prose preceded JSON; no cancel or timeout occurred.
- Kimi: standard direct `kimi -p`, configured `kimi-code/k3`, stream JSON,
  `KIMI_LOOP_MAX_STEPS_PER_TURN=100`; exit 0, PASS (0 P0/P1/P2).
- Opus: direct `claude -p`, `opus`, xhigh, read-only `Read,Grep,Glob`,
  `dontAsk`, JSON schema; exit 0, `is_error=false`, PASS (0 P0/P1, 3 P2).

All three inspected signed/pushed anchor `400994f9`, rejected confirmation
`508d700a`, reslice `721d1c0e`, corrective RED `7d037ed8`/`932db106`, and
GREEN `b384c7d9`/`400994f9` against the same prompt.
