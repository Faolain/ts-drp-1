# D.110c-0c1f5b0t/f5b0u/f5b0v final review and confirmation

The reviewed implementation ends at signed JSDoc-only GREEN
`3f47ced3099134d4b0c7f1bd2b11aee2a652ae7a`; its signed evidence is
`5f03da91ad83d3bf2ee98fb069740864af4b90a0`. The exact 21-path binary diff
from `acec5c3fe03c83add9cd2c992dcdae88786c48cf` through `3f47ced3` has
SHA-256 `0a215e343c56138ca46a514ad828a72645aa0fff03e85d28b9f7cd711ece4204`.

## Initial combined final review

- Grok session `01a07098-5740-7763-b215-c0cdd6bafc8e` reached substantive
  PASS P0=0/P1=0/P2=0, but progress prose preceded its JSON. The strict runner
  correctly classified the response `NO_VERDICT`. Raw packet, events, public
  text, stderr and status are under `grok/`.
- Codex `gpt-5.6-sol` high returned CHANGES_REQUIRED with one P1: the exported
  Node sink JSDoc falsely promised fail-closed rejection on ordinary ingress
  and local issue, whose existing runtime catches/logs and continues. The exact
  result is `sol-initial.json`.
- Fable 5.1 xhigh session
  `72e49389-f0c5-4450-8ec2-ad9f5341329f`, invoked only through the
  `claude-phel` alias, reached substantive PASS with two P2s but could not
  read the prompt outside its sandbox and returned a nonconforming schema. It
  is therefore honestly `NO_VERDICT`. The raw session and extracted
  substantive result are under `fable/`.

The Sol P1 received a causal tests-only RED
`e8e7b027629a647a068d51395f88b51e8391c2eb`, evidence
`b5d94193aa34819f1f8706b4ee4f0ac966baffb9`. It failed only
`NODE_CALLBACK_REJECTION_GUIDANCE_IS_SURFACE_SPECIFIC`. Exact comment-only
GREEN `3f47ced3`, evidence `5f03da91`, makes the Node contract
surface-specific without changing runtime tokens or comment-free AST.

## Single permitted confirmation

The confirmation used a clean detached checkout at `5f03da91` and
`final-confirmation-prompt.md`.

- Grok session `01a070b7-7c16-7721-be1a-3a87cfe13ba2` first reached
  substantive PASS P0=0/P1=0/P2=2 but again prepended progress prose, so the
  strict wrapper preserved `NO_VERDICT`. The exact same session was resumed,
  without tools or reinspection, solely to re-emit the already reached object.
  `grok-confirmation/resume-public.json` is valid terminal-only PASS with
  P0=0/P1=0/P2=2 and `parent_f5b_ready=true`.
- Codex `gpt-5.6-sol` high returned PASS P0=0/P1=0/P2=3 and
  `parent_f5b_ready=true`; see `sol-confirmation.json`.
- Fable 5.1 xhigh session
  `e57364e1-8dbb-46f4-80b4-fbe1719afcd6`, invoked through the interactive
  `claude-phel` alias in the clean checkout, returned schema-valid PASS
  P0=0/P1=0/P2=3 and `parent_f5b_ready=true`; see
  `fable/confirmation-structured.json`. Per the bridge parse contract,
  `structured_output` is authoritative. Two prior exit-127 files are
  preserved as shell-alias launcher diagnostics; neither reached Claude or
  created a model session.

The final blocking union is empty. Canonical projection and durable issuance
remain exact-once. External callbacks are replayable authenticated
notifications keyed by vertex digest. Room-owned/successor-recovery rejection
fails closed; ordinary Node ingress/local issue retains legacy
log-and-continue. No shipped consumer needs durable exactly-once external
effects, so no new API, schema or receipt mechanism is justified in this
slice.

## P2 ownership and disposition

1. The historical f5b0u first-round packet was only partly retained at the
   time. This root now preserves the available prompt/Grok artifacts under
   `historical-f5b0u-first-round/`, and `union.md` records the complete
   known union and why unavailable raw Sol/Fable outputs cannot be recreated.
   Closed as evidence bookkeeping; immutable findings are not relabeled.
2. Parent f5b must causal-RED the dormant `openProgressSources` path through
   a genuine checkpoint-derived frontier, or delete the dormant branch before
   authenticated frontier threading. This is a blocking parent acceptance
   obligation, not an f5b0v production change.
3. The newly observed Phase-3 live-plane `publishPending()` failure at line
   1223 reproduces identically at untouched pre-comment `c66e09c2`, before
   the rejecting sink. It is outside the accepted retained matrix and is not
   called green. The Phase-3 harness owner must diagnose it before parent f5b
   rebaselines its retained matrix; no product workaround is authorized.
4. The initial-progress-origin and AST-oracle limitations from the older
   f5b0u round are closed respectively by exact signed progress-store
   ownership evidence and `4521f03f`/`22e909b91`. The two Sol P1s from
   that round are closed by the AST correction and genuine callback
   `d1,d1,d2` RED-to-contract reslice.

No additional model round reviews this closure prose. The plan status and
Current frontier are updated in the same signed closure commit as this
self-excluding review manifest.

The first closure-prose Prettier check exhausted Node's default heap while
reading the approximately 100,000-line plan; it emitted no formatting verdict.
The corrected read-only invocation used
`node --max-old-space-size=8192 node_modules/prettier/bin/prettier.cjs --check`
on the same file and passed. This is a formatter-process diagnostic, not a
plan/code failure or a threshold change.
