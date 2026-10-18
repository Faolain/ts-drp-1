# Review commands and outcomes

- Grok: run_grok.py review, grok-4.6/high, timeout 1200, max turns 64. Underlying exit 0/end_turn; strict wrapper exit 2 only for leading progress prose plus valid JSON.
- Kimi: direct kimi-code/k3 stream-json with KIMI_LOOP_MAX_STEPS_PER_TURN=100; exit 0.
- Opus: claude print, model opus, effort xhigh, dontAsk, JSON output; exit 0/end_turn.

All reviewers inspected the same signed/pushed anchor 52d1819f.
