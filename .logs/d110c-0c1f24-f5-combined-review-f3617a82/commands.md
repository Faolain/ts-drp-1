# Review commands

## Grok 4.6/high

```sh
python3 /Users/aristotle/.codex/skills/grok/scripts/run_grok.py \
  --mode review \
  --cwd "$PWD" \
  --prompt-file "$PWD/.logs/d110c-0c1f24-f5-combined-review-f3617a82/prompt.md" \
  --output-dir "$PWD/.logs/d110c-0c1f24-f5-combined-review-f3617a82/grok" \
  --model grok-4.6 \
  --reasoning-effort high \
  --timeout-seconds 1200 \
  --max-turns 128
```

The runner reached its local timeout while Grok was streaming its terminal
object, so the runner correctly recorded `NO_VERDICT_TIMEOUT`. Exact session
`01a068df-7056-7e70-92bc-4bbfc0b86be0` was then resumed once with the same
schema and a tool-free instruction to re-emit the already reached judgment.
That exact continuation completed with `stopReason=end_turn` and exit zero.

## Kimi K3/100-step

```sh
KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi \
  --model kimi-code/k3 \
  --prompt "$review_prompt" \
  --output-format stream-json
```

Exact session: `session_e2d5e95e-311a-4a67-a092-1350cfa7ac58`. Exit zero.
The first terminal message prefixed the complete JSON object with inspection
prose. The same exact session was resumed once with `kimi -r` only to re-emit
the already reached judgment under the exact schema. The re-emission contains
no prefix/suffix prose and exits zero.

## Opus xhigh

```sh
claude -p \
  --model opus \
  --effort xhigh \
  --permission-mode plan \
  --allowedTools Read,Glob,Grep \
  --output-format json \
  --json-schema "$review_schema" \
  --name d110c-0c1f24-f5-combined-opus-xhigh \
  "$review_prompt"
```

Exact session: `b72eb02d-92e5-42fc-978b-47b029ce8562`. Exit zero. External
transcript SHA-256:
`a524d28d4b327ab9d2f1a4b7b7e844e7f00654e39814b37686d9fb3cce7fb182`;
bytes: `1107958`.

No reviewer edited files, ran tests/workloads, or spawned subagents. No Fable
or collaboration subagent was invoked.
