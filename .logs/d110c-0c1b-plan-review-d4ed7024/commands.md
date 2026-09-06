# D.110c-0c1b plan review commands

Review target: signed/pushed plan commit
`d4ed70242c9f21cfb24e1d5c6b1c9c6216096616`, tree
`b48d37e683b51441de39aeeec57c27a0c19f82f8`.

- Grok 4.6/high: the complete argv is retained in `grok/command.json`; input,
  streaming events, public output, stderr and runner status are retained under
  `grok/`.
- Kimi K3 direct: standard `kimi` CLI with
  `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, the frozen `prompt.md`, and streamed JSONL
  captured in `kimi/stream.jsonl`; stderr and normalized terminal verdict are
  retained beside it.
- Opus xhigh: direct `claude -p` bridge invocation with the frozen `prompt.md`;
  the complete CLI result envelope, stderr and normalized terminal verdict are
  retained under `opus/`.
- Normalization: `jq` extracted the exact terminal schema payloads into each
  `verdict.json`; no finding was changed during extraction.
- Validation: `jq -e` checked all three normalized verdicts against
  `schema.json`; `shasum -a 256 -c manifest.sha256` validates this self-excluding
  evidence root after manifest creation.

All review processes exited zero. Grok's wrapper classified the session
`NO_VERDICT` because its public stream included inspection prose before the
valid terminal schema, despite `stop_reason=end_turn`; that classification is
preserved in `grok/status.json`. Its terminal `CHANGES_REQUIRED` findings are
retained and adopted, but the corrected plan will receive the one permitted
material confirmation rather than claiming this wrapper result as approval.
