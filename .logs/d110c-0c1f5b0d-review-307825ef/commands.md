# Review commands and outcomes

- Grok: `run_grok.py --mode review`, `grok-4.6` high, 1,200-second bound,
  64 turns. Exit 0 / `end_turn` after 450.167 seconds. The wrapper records
  `NO_VERDICT` because progress prose preceded fenced JSON; `public.txt`
  preserves the stream and `verdict.json` contains the explicit BLOCK. No
  cancellation or timeout occurred, so no resume was applicable.
- Kimi: standard direct `kimi -p`, configured `kimi-code/k3`, stream JSON,
  `KIMI_LOOP_MAX_STEPS_PER_TURN=100`; exit 0 with explicit BLOCK.
- Opus: direct `claude -p`, model `opus`, xhigh effort, read-only
  `Read,Grep,Glob`, `dontAsk`, JSON schema; exit 0, `is_error=false`, structured
  BLOCK present.

All reviewers inspected signed/pushed anchor `307825ef` and the same accepted
design, RED/GREEN commits, evidence roots, production-path question, and output
contract.
