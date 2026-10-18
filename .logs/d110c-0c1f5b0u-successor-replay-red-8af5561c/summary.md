# Causal successor recovered-delivery RED

Status: **CAUSAL RED, NOT GREEN.** The frozen incomplete GREEN candidate
does not replay authenticated current-epoch application vertices above the
successor snapshot through the existing admitted sink when reopening.

Signed/pushed tests-only history:

- `7e322ff2`: introduced the three genuine-room tests.
- `23ddf204`: selected the genuine predecessor epoch-0 snapshot imported by
  the epoch-1 successor. Its run was noncausal: all three tests stopped at
  `sealed-live-unavailable` before replay.
- `caacfd81`: corrected exactly four mock target paths to the freshly built
  package-export files. Its run was noncausal: all three tests stopped at
  `D110C_FLOOR_CONFLICT` before replay.
- `87c3c836`: corrected only the two fixture room-head comparisons to compare
  canonical bytes rather than JSON insertion order.

The executable source pin is signed/pushed policy-only descendant
`8af5561c48f8b8d2d3767c33d613c2e1ec33c2f3`. Neither prior invalid result is
reinterpreted as causal. The initial `7e322ff2` setup was stopped before a
focused invocation; `23ddf204` and `caacfd81` each consumed one diagnostic
focused invocation. Their existing roots and manifests remain untouched.

The module-custody correction is tests-only. Read-only Vite resolution showed
that the four bare adoption mock targets resolved to null from the root test
file, while the room resolved them to `packages/node/dist/src/*.js`. The
existing root Vite aliases resolve creator-close and v3-live to source.
Consequently the missed mocks let built adoption consult a separate private
`sealedFacts` WeakMap. Explicit resolved mock targets now delegate to the
existing source implementations, matching the retained product fixture's
single-source lifecycle graph. No private fact, capability, checkpoint,
declaration or authority was manufactured.

## Exact clean-environment proof

Detached checkout:
`/tmp/d110c-f5b0u-successor-replay-red-ae3zI1/checkout`.
It starts at the signed source pin and overlays exactly the parent's
pre-existing nine-path incomplete GREEN patch. Patch SHA-256:
`3115b50bc0a76662194cdc052313ae2390327c6452b2dc3ccf45a3f97dae09da`.
`identity.json` pins all nine resulting file hashes, Node identity and every
stash identity. Both isolated and main-worktree hashes were checked before
and after execution. This overlay is explicitly not accepted GREEN; final
GREEN must pass a clean checkout without any overlay.

Exact commands and all statuses/timestamps are in `commands.json`, with
complete separate stdout/stderr. Offline frozen-lockfile installation,
fresh `pnpm build:packages`, and listing all passed. The listing selected
exactly three tests in one file, with no campaign. The focused command was
executed once and exited 1 with no signal: three failed tests, zero passes,
zero skipped/pending tests and no unexpected runtime failure.

`validate.mjs` validates every selected result and the exact complete
18-soft-failure token matrix in `validation.json`:

| Case | Expected RED failures | Causal observation |
| --- | --- | --- |
| Exact replay/order/projection/resume | 10 | Two genuine epoch-1 operations are durable, but cold reopen delivers neither; only the later public issue is applied. |
| Injected replay-sink failure | 4 | No replay delivery reaches the sink; reopen incorrectly succeeds and keeps an active owner/transport. |
| Injected recovered commit failure | 4 | No replay reaches commit; reopen incorrectly succeeds and keeps an active owner/transport. |

The real room create, issue, seal, authenticated adoption, epoch-1 issue,
close and cold reopen all completed. The expected two deliveries were
captured from genuine issuance with exact canonical bytes/signatures before
closing. Successor authority equality, authenticated projection-base binding,
application-state validation, continued public issue and the success-path
one-active-owner control passed. No missing export/import, floor rejection,
seal/adoption refusal, timeout or authority shortcut is counted as RED.

The failure-injection cases fail because the replay seam is absent; they do
not claim a demonstrated cleanup failure after a reached sink/commit fault.
GREEN must reach each injected fault and then prove refusal and cleanup.
The real recovery owner remains responsible for refusing missing, malformed
or out-of-order authenticated journal evidence under retained recovery
tests; no new public replay count or API was introduced.

Exact-owner lint and formatting passed. The test-file TypeScript audit used
actual workspace export paths plus existing source aliases; no future API
or import is needed. All workspace builds passed in the isolated checkout.
The final static/retained/Chromium/clean-GREEN and formal review gates remain
the parent's responsibility; this evidence does not close f5b0t/f5b0u.

No production source, manifest, lockfile, runtime config, workload, timeout,
threshold or authority was edited by this task. The nine-path incomplete
candidate, protected paths and all 27 stashes remain intact. No reviewer,
Fable, collaboration subagent, campaign or long workload was invoked.
