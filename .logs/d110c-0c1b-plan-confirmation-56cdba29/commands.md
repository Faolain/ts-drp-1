# D.110c-0c1b material plan-confirmation commands

Target: signed/pushed correction commit
`56cdba29056d493dd95a98a80cb0f5e3c77260c5`, tree
`ebe75e12c92b197d63ae04bdf80732174fe5e57e`, reviewed against parent
`d4ed70242c9f21cfb24e1d5c6b1c9c6216096616`.

- Grok: direct `grok` CLI, model `grok-4.6`, reasoning `high`, web/memory/
  subagents/plan disabled, 48-turn cap, read-only `read_file,grep,list_dir`,
  `dontAsk`, streaming JSON, and `prompt.md`. The first terminal answer prefixed
  inspection updates before its valid JSON. The same session was resumed once
  with no tools and a four-turn cap to re-emit the unchanged schema only.
- Kimi: `KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi --output-format stream-json
-p "$(<prompt.md)"`. An initial launcher attempt combined prompt mode with
  unsupported `--auto`; the CLI rejected it before a session or model request,
  so the corrected command above started the sole Kimi review.
- Opus: `claude -p --model opus --effort xhigh --output-format json
--permission-mode dontAsk --permission-prompts none`, bounded read-only
  tools, and `schema.json`, with `prompt.md` on stdin.
- `jq` extracted each terminal object without changing findings. A canonical
  sorted comparison proves Grok's exact-session re-emission is semantically
  identical to the first terminal JSON.
- `jq -e` validates all three verdicts as `APPROVED`, with zero P0/P1 and
  `red_causal`, `green_closes_red`, and `scope_preserved` all true.
- `shasum -a 256 -c manifest.sha256` validates the completed self-excluding
  evidence root.

All three actual review processes and Grok's same-session re-emission exited
zero. No Fable, collaboration subagent, test, campaign, D.110a invocation, or
production edit ran in this checkpoint.
