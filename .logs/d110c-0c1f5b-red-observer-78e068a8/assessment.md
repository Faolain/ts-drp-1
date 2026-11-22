# Parent f5b emitted-projection observer corrective RED

`ACCEPTED_CAUSAL_OBSERVER_RED`. Signed/pushed tests-only commit
`78e068a8992a6a4fa7402e24eeca50609aebff64` follows root's signed disposition
`b2f79baf0697c0a77dabdb10bf049f5289583580`. Only the parent integration test
changed: 60 insertions and four deletions. No runtime preceded the signed and
pushed test commit; no production or plan edit occurred.

## Correction and its contract

The immutable resumed GREEN diagnostic at
`.logs/d110c-0c1f5b-green-57834387/` attributes the prior stop to a terminal
room getter: genuine prefix issuance succeeded, the deliberately armed suffix
fault terminated its owner, and the test called `productState(writer)`, which
calls the public throwing `projection()` getter. It did not establish a new
operation/state-size rejection. Its fourteen-entry manifest remains verified
at `e4b4f46f11ead95618a8a3c46fe62353c6e5473254de55cbcaf5b25a47aa603e`.

Case 3 alone now records the existing public `onProjection` callback. Every
initial open and reopen allocates a fresh generation cell before room creation;
the callback closes over that exact cell. It invokes that open's migration
encoder with the exact callback value, preserving its identity/brand, then
copies only the resulting bytes. It does not clone or mutate the projection,
catch/swallow callback errors, call a getter, or change admission. Valid
projections return normally from the observer.

The returned real session is bound to the new cell. Every open requires a
positive fresh emission count and present bytes. Reads require the current
peer's exact room identity. Reopen overrides the spread prior callback with a
new closure and encoder; late old-owner emissions can change only their old
cell, never the new generation. There is no previous-generation byte fallback.
All non-case-3 consumers retain the no-op callback and its existing reopen
identity, including the frozen 64-writer sibling; they incur no projection
encoding work.

Both obsolete failed-owner `productState(writer)` reads are removed. The
before/after comparison now uses fresh emitted canonical bytes, requires a
different real owner and exactly the next generation, and explicitly asserts
that both failed owners' public `projection()` getters still throw. Existing
exact durable prefix, plan, progress, issue and publication assertions remain
paired with the emitted-state comparison.

Source inspection confirms room's `commit` calls `onProjection` before its
final synchronous accepted-vertex/projection assignments. These observations
are therefore **emitted projection evidence, not independent commit receipts**.
No read-after-failure product behavior or private getter bypass was introduced.

## Sole isolated result

The fresh detached checkout at
`/private/tmp/d110c-f5b-observer-red-zKIwWG/checkout` independently installed
from the frozen lockfile offline and built all packages from the signed commit.
No partial GREEN overlay, copied dist, diagnostic Vite transform, or
main-checkout runtime was used. The previously accepted sparse isolation and
runner machinery was reused.

The matrix and commands were frozen before execution. Matrix SHA-256:
`6fdf3b01c2b996b4e0a2d21633f2ab6e1ae9a0dc2f752d93d6fcfced8caf6c60`.
All 28 entries match the accepted prior oracle RED exactly. The sole result is
**45 total / 28 active / 23 failed / 5 passed / 17 filtered**, zero violations:

- Nineteen `F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED` failures.
- One exact `canonical value exceeds item limit` failure owned by
  `migrationInviteAuthority` in the genuine 64-writer case.
- Three expected P2 tokens: `F5B_P2_PRIVATE_HOLD_PROVENANCE_REQUIRED`,
  `F5B_P2_CLOSED_PRECEDENCE_REHEARSE_REQUIRED`, and
  `F5B_P2_CLOSED_PRECEDENCE_ACTIVATE_REQUIRED`.
- Five controls pass: complete genuine v1, legacy reentry guard, closed issue
  precedence, and the two independent snapshot-oracle known-answer controls.

There are no missing import/export, loader, malformed blueprint/invite,
application-state ceiling, top-level, timeout, changed-control or count/token
anomalies. Initial case-3 observer wiring runs successfully before the expected
codec failure. This pre-codec RED does not physically reach or claim the
post-prefix/restart continuation. Full GREEN must exercise those assertions
and the retained terminal-getter controls. No rerun or post-run test edit
occurred. The complete command/timing, raw reporter and exact failure messages
are in `execution-start.json`, `focused.json` and `result.json`.

## Static and retained-source gates

Main changed-file lint/format and isolated lint/format, complete/selected
collection, full source build and exact tests-only diff checks pass. Target
source-mapped typechecking has zero diagnostics. The only external items are
the same three inherited `live-snapshot.ts` diagnostics (TS2741 line 85,
TS7006 line 277, TS2322 line 284); no repository-wide typecheck pass is claimed.
No authoring or diagnostic execution failed in this batch.

Mechanical custody proves zero obsolete getter reads, two explicit terminal
throw controls, direct branded-value encoding before byte copying, fresh
per-open closure cells, exact session/generation binding and no fallback.
Twenty-five other named functions remain byte-identical, including case 25,
the 64-writer test and its accounting. The segmented workload outside the
observer block, 33,000-character inputs, real split, committed prefix,
intentional suffix faults, all three closes/reopens, both pure controls, both
test helpers and the complete retained runtime file remain unchanged. The
retained source specifically still requires terminal getters to throw.

Before/after checks preserve all seven dirty production hashes and all 27
stashes, and verify isolated source/runtime hashes and a clean isolated tracked
checkout. Protected untracked paths and old immutable evidence are untouched.
No product/API/wire/schema/dependency/crypto/limit/timeout edits, reviewers,
Fable, subagents, campaigns or long workloads occurred. The proposed f5b0z API
prerequisite and parent production pause remain root-owned; no API or cleanup
implementation is authorized or claimed by this correction. No new observer
or causal contradiction was found.
