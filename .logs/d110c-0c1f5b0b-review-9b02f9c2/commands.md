# Review commands and outcomes

- Grok: `run_grok.py --mode review --model grok-4.6 --reasoning-effort high`
  over `prompt.md`; exit 2 from strict wrapper classification, underlying CLI
  exit 0, `stop_reason=end_turn`, substantive PASS JSON present in
  `grok/public.txt`. Exact-session schema-only resume emitted the same PASS.
- Kimi: direct `kimi --model kimi-code/k3 --output-format stream-json` with
  `KIMI_LOOP_MAX_STEPS_PER_TURN=100`; original output retained in
  `kimi/raw.jsonl`. After more than five minutes without output while two
  internal workstreams remained pending, the foreground turn was interrupted
  and the exact session resumed with `kimi --session ...`; synthesis PASS is in
  `kimi/resume.raw.jsonl`.
- Opus: `claude -p --model opus --effort xhigh --permission-mode dontAsk`
  with read-only tools; exit 0 and BLOCK result in `opus/raw.json`.
- The first mechanical Grok/Kimi normalization attempt failed because Grok's
  prose and JSON occupied one line and Kimi's JSON content was multiline. Raw
  outputs were unchanged. Corrected extraction used whole-file prefix removal
  for Grok and `jq -s ... fromjson` for Kimi; all three normalized verdicts pass
  the required-key check.

Result: blocking union = 1 P0 + 3 P1. No slice closure and no f5b0c start are
authorized until a causal tests-only corrective RED and separate GREEN close
the union and the confirmation review has no P0/P1.
