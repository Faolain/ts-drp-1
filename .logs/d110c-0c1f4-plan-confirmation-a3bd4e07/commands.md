# Commands and custody

## Grok

```sh
python3 /Users/aristotle/.codex/skills/grok/scripts/run_grok.py \
  --mode review \
  --cwd "$PWD" \
  --prompt-file "$PWD/.logs/d110c-0c1f4-plan-confirmation-a3bd4e07/prompt.md" \
  --output-dir "$PWD/.logs/d110c-0c1f4-plan-confirmation-a3bd4e07/grok" \
  --model grok-4.6 \
  --reasoning-effort high \
  --timeout-seconds 1200 \
  --max-turns 96
```

The schema-only correction used `grok --resume
01a06843-5bb3-7102-8434-e3d6282eafce` and requested only re-emission of the
existing verdict; it did not ask for reinspection.

## Kimi

The original direct review used standard Kimi K3 with
`KIMI_LOOP_MAX_STEPS_PER_TURN=100` and the frozen prompt/schema. The schema-only
correction used:

```sh
KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi \
  -r session_2fd7efbd-c126-42d5-8bef-835bb338fe37 \
  --prompt 'Re-emit the already reached verdict under the exact frozen schema; do not reinspect.' \
  --output-format stream-json
```

## Opus

The direct xhigh review used the repository Claude bridge and the frozen prompt
and schema. Its exact durable transcript path and hash are recorded in
`external-transcript-hashes.txt`.
