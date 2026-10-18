# D.110c-0c1a correction confirmation commands

- Grok: `python3 /Users/aristotle/.codex/skills/grok/scripts/run_grok.py --mode review --cwd /Users/aristotle/Documents/Projects/ts-drp-1 --prompt-file .../prompt.md --output-dir .../grok --model grok-4.6 --reasoning-effort high --timeout-seconds 720 --max-turns 48`
- Grok schema-only re-emission: exact session `01a0653e-29e9-7761-8377-e2041e09c668`, `--resume`, unchanged model/permissions, `reemit-prompt.md`; no reinspection requested.
- Kimi: `KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi --model kimi-code/k3 --prompt <prompt.md> --output-format stream-json`
- Opus: `CLAUDE_CONFIG_DIR=/Users/aristotle/.claude-phel claude -p --model opus --effort xhigh --permission-mode dontAsk --allowedTools Read,Grep,Glob --disallowedTools Bash,Write,Edit,NotebookEdit,Agent,WebFetch,WebSearch --output-format json --json-schema <schema.json> < prompt.md`
- Verdict validation: each normalized verdict must be `APPROVED` and contain zero P0/P1 findings.
- Evidence validation: self-excluding SHA-256 manifest generated after all artifacts were complete and checked with `shasum -a 256 -c manifest.sha256`.
