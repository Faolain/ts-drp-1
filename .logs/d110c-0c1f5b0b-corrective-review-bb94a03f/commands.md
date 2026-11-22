# Review commands

- Grok: run_grok.py in review mode, grok-4.6/high, timeout 1200, max turns 64. Underlying exit 0/end_turn; strict wrapper exit 2 due leading prose plus valid JSON.
- Kimi: direct kimi-code/k3 stream-json with KIMI_LOOP_MAX_STEPS_PER_TURN=100; exit 0.
- Opus: claude print, model opus, effort xhigh, permission mode dontAsk, JSON output; exit 0/end_turn.
