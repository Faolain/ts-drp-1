# One-off Fable 5.1/high comparative audit provenance

- Express authorization: user request on 2026-09-02 to perform parallel research for the same Hedera/Hiero audit.
- CLI: `claude -p --model fable --effort high --permission-mode plan --safe-mode --output-format stream-json --verbose`.
- Effective model: `claude-fable-5-1`.
- Effort: high.
- Session: `0b68b30f-133f-4078-a9a7-ee7aeeec8953`.
- Terminal subtype: success; `is_error:false`.
- Duration: 542,433 ms.
- Turns: 67.
- Subagents/workflows: zero.
- Permission denials: zero.
- Repository HEAD observed at start: `c1e443fc9676187c4b02dcd23459a23119de8146` with the already in-progress D.110c-0b0a GREEN working tree. The main agent later signed and pushed that independently completed GREEN while this read-only audit was running.
- Repository writes by Fable: none. Its optional plan copy was written outside the repository under the CLI-owned home directory.
- Status: advisory only; not a substitute for Grok/Kimi/Opus review.

SHA-256:

```text
375fbfea67bc3323dd05fb69e58297b543abee43228772d09793d4cb032c4af3  prompt.md
7ddf346a0bc260ba660eee0b2ae6e9ea62d2ae11ee9a4278aaa98387432662fc  raw-stream.jsonl
01ede583b5d0f1022305fa5025349241f6ac7971e56260d12c199daba0b1f979  result.md
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  stderr.log
```
