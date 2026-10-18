# Commands and classifications

All three reviewers used the shared `prompt.md` and inspected only clean
detached commit `c35fae7e09983183649c524e71e17cb01c2fff4f`.

1. Grok used model `grok-4.6`, reasoning `high`, no web, no memory, no
   subagents, read-only tools, and a 16-turn cap. The first run reached the cap
   without a terminal verdict. A noninteractive exact-session resume first hit
   local CLI error `Device not configured`; a PTY exact-session resume then
   completed. `grok export 01a06f8b-9697-76d0-9206-f2c03e09f8e2` recovered
   the terminal `PASS` JSON.
2. Kimi used standard direct prompt mode with
   `KIMI_LOOP_MAX_STEPS_PER_TURN=100` and completed `PASS`.
3. Opus used `claude -p --model opus --effort xhigh --permission-mode dontAsk
--allowedTools Read Grep Glob --output-format json` and completed
   `CHANGES_REQUIRED`.

The deterministic source audit used `rg` and bounded `sed` reads over only the
room lifetime/recovery owners, issuance-store derivation, and Node batch
grammar. No tests or production writes were performed during review.
