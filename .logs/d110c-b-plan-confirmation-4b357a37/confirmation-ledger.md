# D.110c-b material plan-correction confirmation ledger

Confirmed signed/pushed correction:
`4b357a37d13f809ed67f9ba7ad5f0f658188c89a`.

The reviewers inspected the exact `aa002e78..4b357a37` correction and the
actual owners from the same clean detached checkout. No test, product edit,
campaign, profile, D.110a invocation, Fable run, or collaboration subagent ran.

## Terminal results

- Grok 4.6/high completed normally after 600.103 seconds with
  `stop_reason=end_turn`. Its wrapper recorded `NO_VERDICT` only because the
  response included inspection prose before its fenced terminal JSON; the
  extracted terminal is `APPROVED`, P0=0/P1=0/P2=2. It was not canceled and was
  not resumed.
- Standard direct Kimi K3 session
  `session_08de3c58-417d-4914-a7fb-aa4a771ecd96`, with
  `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, returned `APPROVED`, P0=0/P1=0/P2=0.
- Opus xhigh session `4e589f16-a28f-447b-a5c6-91296cd55e41` returned
  `APPROVED`, P0=0/P1=0/P2=2.

The blocking union is empty. Both nonblocking reviewer unions identify the same
two precision points. The immutable base audit remains byte-frozen even though
its old consumption/alias-retention sentence is superseded by the reviewed
plan's pre-transfer-retain/post-transfer-stall rule. The genuine second
same-head capability is obtained from
`commitCreatorSuccessorAdoption()`'s authenticated `active-new` path before
first activation; the plan now names that producer accurately and continues to
forbid replay or fixture minting. These P2 dispositions do not change scope,
authority, or executable acceptance and receive no further review.

D.110c-b RED may proceed. Production changes remain forbidden until the signed
tests-only RED matches the frozen causal matrix.

## Raw evidence hashes

- `prompt.md`:
  `3f32afb29bc7f7626ede4ad032b886378baff7c47ba4d8842c5e4e997b1b5aaf`
- `grok/events.jsonl`:
  `e7c660261514022bdb454d04966ed8c926f422ad400b5698ae6de3528a932aae`
- `grok/public.txt`:
  `ebf48cdf747172a4a63d372d1fd8600bf388c2bf59f17056d1e21efb0451731f`
- `grok/status.json`:
  `7b91ae2a269ab8f0bca2dd2fa23af4f03a1d9d46198e5a80ee3d0cfbe44e4056`
- `grok.terminal.json`:
  `8e311af8268b9212166d000cd2430839c5b1ee1f85f8b03e1da6340b5db3b460`
- `kimi.stream.jsonl`:
  `7770296ac11333570f967737b93b30e31d8848fef622e0053ff302dbf84d877d`
- `kimi.terminal.json`:
  `05697586f6332b51bdeb1f2940e17389c93fe2b2982f51bd48135e2039e8eac3`
- `opus.json`:
  `3a78001f6192cc94fc47143a0b57c4e2b826e00618c866553a78c28b910f7361`
- `opus.terminal.json`:
  `1fc0c83be34fd295755606d547dcef1a1d45151f00a7698ff1b2ff9f8d33a083`
