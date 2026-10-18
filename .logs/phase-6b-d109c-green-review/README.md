# D.109c final GREEN review evidence

The sole final review inspected signed and pushed GREEN
`3d21264f4477fb5ff586047826ebd49e15d20bde`, immutable causal RED
`84cff9ceaa6620c2ed8d1baa3a358ad9b018bb94`, RED evidence closure
`1e68ebb7824477a763b01603a2872eff362c0260`, and accepted plan anchors
`e2c18898033744eb64723ea901a906af3845b112`,
`dad2b20279d4d31f942da42691ffdb5745136cc8`, and
`7113f762daad7392878fea529c01dc9a6729ab04`.

All three independent reviewers returned `VERDICT: APPROVED`,
`P0_P1_UNION: none`, and `D109C_MAY_CLOSE: yes`:

- Grok 4.6/high session `01a05a8e-66d1-73e3-9403-69c3d07f5995`
  completed normally after 570.373 seconds, with `end_turn`, no timeout, no
  cancellation, and no resume.
- The user-authorized standard Kimi CLI v0.39.1 ran model `kimi-code/k3` with
  configured thinking effort `high` and
  `KIMI_LOOP_MAX_STEPS_PER_TURN=100`. Session
  `session_926cdc44-4a34-474e-b63d-bcf0a9ab6ab8` completed normally. Kimi,
  not Codex `gpt-5.6-sol`, occupied the middle review slot.
- Opus 5/xhigh session `50126d08-0132-4491-9200-ae4a077455f5`
  completed successfully in 67 turns.

The first legacy `kimi-cli` launch reached no model because its legacy OAuth
store returned HTTP 401. That controller failure and resumable session id are
preserved under `kimi/legacy-cli-auth-failure.*`. The first standard-CLI
command also reached no model because `--auto` cannot be combined with prompt
mode; that local argument error is preserved under
`kimi/standard-cli-auto-conflict.*`. The successful standard Kimi run removed
only that unsupported flag and reviewed the unchanged prompt. Neither failed
launch is represented as a verdict or reviewer run.

## Finding disposition

There is no blocking finding. Kimi and Opus independently found the same P2:
an empty deletion list paired with a present expected floor parent is not
rejected during input capture, so it can produce retry/replay rather than exact
`AHE_RECLAMATION_INVALID_ARGUMENT`. This is zero-write, non-poisoning, and
cannot authorize unsafe deletion. D.109f owns the exact invalid-input mutant
and polarity correction before Phase-6b exit.

Opus recorded two additional evidence-strength P2s. Node's same-process
two-handle `Promise.all` control proves replay but cannot force a synchronous
SQLite interleaving; D.109f's required Node crash/reopen/concurrency matrix
owns a genuine second-process form. The browser fixture computes
`facadeKeys` without asserting it; D.109f's complete enumerated-structure and
surface census owns that exact assertion. Kimi also noted, without classifying
it as a finding, that poisoned-store refusal is implemented but only exercised
indirectly; the D.109f parity census may make it direct while closing the other
three items.

None of these observations changes the reviewed GREEN commit, product safety,
scope, or causal acceptance. Under the accepted policy, P2 findings receive an
owner and disposition but do not trigger a confirmation or recursive prose
review.

## Commands and identities

Grok used the committed `grok/command.json`. The successful Kimi controller
command was:

```text
KIMI_LOOP_MAX_STEPS_PER_TURN=100 /Users/aristotle/.kimi-code/bin/kimi --model kimi-code/k3 --output-format stream-json --prompt <review-prompt.md bytes>
```

Opus used Claude Code v2.1.252 with `--model opus --effort xhigh`, read-only
tools, `dontAsk`, and streamed JSON. The common prompt SHA-256 is
`eef33c1e614ac339be18e02b2a678076619f949c5cb26e4f455cff024b32570b`.
Result SHA-256 values are:

```text
5686c634d2a91275e7aec517869bae70e8acfe0ec86bf83b72bba9ea1d8849c5  grok/public.txt
fdce906a23945aacc4318f57d192c561839650a6c0f8c340ae936d248075bd71  kimi/raw-stream.jsonl
f1df6cfb15989c6f2ec573fcd514768046a00390726cbb40024f84d18a516100  kimi/public.txt
80adcd5192cfb07c72aec77d2c09b0c2deae6505fc3156c72313c1095ac516b0  opus/raw-stream.jsonl
83cc2266bd3490b6b65d1c2ee50247513fc8604678795e818bc6b73532c7e879  opus/public.txt
```

One combined read-only Prettier check exhausted Node's default 4 GiB heap
while parsing the 88k-line master plan with the smaller closure files. The
corrected deterministic checks ran the plan alone with the established 8 GiB
allowance and the four smaller Markdown files separately; both passed. The OOM
is retained as a diagnostic error and is not treated as a formatting failure.

Reviewers performed no test, build, product edit, campaign, Fable, Sol, or
collaboration-subagent work. The reviewed commit retained a good RSA signature
from key `55E22F154FBAF8C84F378304761B99CEA81C6289` and remained contained by the
pushed branch. Protected untracked paths and all 26 stashes remain preserved.
