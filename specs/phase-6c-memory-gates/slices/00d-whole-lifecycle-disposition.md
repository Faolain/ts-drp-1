# D.110a-v — Whole-Lifecycle Profile Disposition

## Demonstrated decision gap

D.110a-u closed the tests-only clock-custody defect and produced one valid,
durable 252.422167-second CPU profile for the exact one-object lifecycle. Its
named workload window covers 32.331750 seconds and returns mixed attribution:
canonical is largest at 47.8533096832 percent, below the unchanged 50 percent
half of the dominance rule. That result proves neither a product defect nor a
tests-only optimization owner.

The durable phase record also shows that the interval from workload completion
through creator-close completion consumes most of the lifecycle. D.110a-v
answers which lifecycle phase and leaf-self owners account for the complete
capture before deciding whether the blocked 64-object gate needs a product
optimization, a tests-only fixture optimization, or a separately reviewed
workload/watchdog feasibility correction.

## Scope and immutable inputs

D.110a-v is evidence-only and read-only over:

- `.logs/phase-6c-d110au-green/profile-ImBAT6/d110au-main.cpuprofile`, exact
  SHA-256
  `394c1b2326fface0ee3e9f81d074a92c5c638112fedfe7046ae31ac10880b0c3`;
- `.logs/phase-6c-d110au-green/capture-records.json`, exact SHA-256
  `8561e43e59203219f329bb09ccef7828462ba61d3a794e8e4c3757a05b95307f`;
- `.logs/phase-6c-d110au-green-result/profile-parent.json`, exact SHA-256
  `252a2fbeecc4da4720af6051c15a72726fc9fb5dc96fff8a1775da37e64af47c`;
- the validating D.110a-u evidence and final-review manifests; and
- source commits `330ccdb6361e5da2e3e86aef23d61bc992e71100` and
  `8b20ba4462830ea4ad03fafb35a05c3b5cb3cc5b`.

It may write only new `.logs/phase-6c-d110av-plan-review/`,
`.logs/phase-6c-d110av-disposition/`, and
`.logs/phase-6c-d110av-final-review/` evidence roots, this specification, and
the production-hardening plan ledger. It may not edit test or product source,
run a Node child or test, start a profiler, consume the two-object preflight or
64-object worker, change a dependency, or alter any workload, threshold,
watchdog, memory, wire, digest, activation, or API contract. A missing,
changed, malformed, or internally inconsistent input closes the disposition
unavailable; it does not authorize a replacement capture.

## Deterministic clock mapping and attribution

Reconstruct each CPU sample timestamp as `profile.startTime` plus cumulative
`timeDeltas`, retaining original sample order and the existing leaf owner
classification `callFrame.url || "[runtime] " + functionName`. Validate all
D.110a-u custody predicates again before analysis.

The phase clock and profiler clock use microseconds and have distinct absolute
origins. D.110a-v uses the four durable inspector brackets to evaluate five
predeclared diagnostic mappings from an hrtime phase value `h` to profiler
time; it does not select a favorable mapping after seeing results:

1. start-before translation: `profile.startTime + h - hrtimeBeforeStart`;
2. start-after translation: `profile.startTime + h - hrtimeAfterStart`;
3. stop-before translation: `profile.endTime - (hrtimeBeforeStop - h)`;
4. stop-after translation: `profile.endTime - (hrtimeAfterStop - h)`; and
5. affine interior mapping from `[hrtimeAfterStart, hrtimeBeforeStop]` onto
   `[profile.startTime, profile.endTime]`, evaluated as
   `Math.round(profile.startTime + (h - hrtimeAfterStart) *
(profile.endTime - profile.startTime) /
(hrtimeBeforeStop - hrtimeAfterStart))`.

Record the exact spread among mapped values for every phase boundary. No
mapped boundary may fall outside the profile. Revalidate the exact seven-name
phase order and strictly increasing hrtime phase values. Partition every
sample exactly once into these half-open intervals, with the last interval
closed:

- `capture-start := profile.startTime` -> `fixture-open` (`startup`);
- `fixture-open` -> `workload-complete` (`application-workload`);
- `workload-complete` -> `creator-close-complete` (`creator-close`);
- `creator-close-complete` -> `reclamation-complete` (`reclamation`);
- `reclamation-complete` -> `successor-published` (`successor-publish`);
- `successor-published` -> `sample-complete` (`post-gc-sample`);
- `sample-complete` -> `teardown-complete` (`teardown`); and
- `teardown-complete` -> `capture-end := profile.endTime` (`inspector-tail`).

`application-workload` is the complete phase interval and is intentionally
wider than D.110a-u's named-function ancestry interval; its owner percentages
need not reproduce the narrower 47.8533096832-percent result.

For every mapping and interval, record sample count, attributed
microseconds, share of the full capture, every owner bucket, ranked owner
shares, and the top-to-second ratio. Also record whole-profile owners. Validate
that interval sample counts equal the profile sample count and interval
microseconds equal the profile's attributed `timeDeltas` total for each
mapping. The output is deterministic JSON plus a self-excluding SHA-256
manifest; no prose-only arithmetic is accepted.

## Closed decision matrix

Use the unchanged owner rule: at least 50 percent and at least twice the next
owner. A result is stable only when all five mappings select the same
classification.

Evaluate the following mutually exclusive cascade in order and select the
first matching branch:

1. **Unavailable or mapping-sensitive.** Select this branch if input
   validation fails, or if the five mappings disagree on dominant phase
   identity, whether any phase reaches 50 percent, in-phase owner identity, or
   whether the owner rule passes. Close the offline attribution unavailable
   and create one high-risk D.110a feasibility-contract slice. No new capture
   or mapping-infrastructure slice is authorized.
2. **Stable dominant phase and classifiable first-party owner.** The same
   lifecycle interval accounts for at least 50 percent of full attributed time
   under all mappings, and the same owner meets the unchanged owner rule inside
   that interval under all mappings. A repository `tests/` file URL yields one
   narrow reviewed fixture-optimization slice. A first-party repository
   `packages/` file URL yields one narrow reviewed product-optimization slice.
   D.110a-v itself makes no edit.
3. **Stable dominant phase without a classifiable owner.** The same interval
   accounts for at least 50 percent under all mappings, but every mapping's
   in-phase owner result is mixed, or its stable dominant owner is a
   `[runtime]` pseudo-frame, `node:` URL, third-party `node_modules` URL, or any
   other non-repository `tests/`/`packages/` owner. Create one phase-level
   feasibility slice. If the interval is required genuine product semantics,
   that slice must decide explicitly between a reviewed product performance
   investigation and a high-risk workload/watchdog contract correction; it may
   not call the fixture, runtime, or dependency a product bug or tune the gate
   silently.
4. **Stable absence of a dominant phase.** All five mappings agree that no
   interval accounts for at least 50 percent. Treat the cost as whole-lifecycle
   mixed and create one high-risk D.110a feasibility-contract slice that
   reviews the fixed 64-object workload and 45-minute watchdog together using
   the measured one-object runtime. It must not change either contract without
   the required high-risk review.

In every branch, include the observed one-object duration and the projected
64-object serial duration as evidence, without treating linear projection as
a measured full-run result. The output must choose exactly one branch and one
next slice; it may not end in another profiling loop.

## Review and closure

Sign and push this bounded plan, then run one Grok, standard direct Kimi
K3/100-step, and Opus xhigh plan review. Correct only material P0/P1 findings
that affect mapping validity, accounting, or the closed decision matrix. After
an empty blocking union, execute the offline analysis exactly once, validate
its deterministic JSON and self-excluding manifest, record/sign/push the
result, and run the single final three-model evidence review. P2 prose or
bookkeeping findings do not trigger recursion. Grok transport cancellation
resumes the exact session. Kimi uses the direct local CLI, not a Codex model.
Fable and collaboration subagents are not authorized.

## Closure

The single offline analysis ran once and selected branch 3,
`stable-phase-mixed-owners`. Across all five mappings, `creator-close` accounts
for 85.9331986744 through 85.9429708230 percent of attributed time. Canonical
is the largest owner inside that phase at only 46.6071877514 through
46.6087051482 percent, so no owner satisfies the unchanged at-least-50-percent
and at-least-two-times rule. All mappings conserve exactly 167,687 samples and
252,421,458 microseconds across the eight disjoint intervals.

The measured one-object profile lasts 252.422167 seconds. Multiplying that
duration by 64 gives a non-measured serial projection of 16,155.018688 seconds,
or 4.4875051911 hours, about 5.9833 times the frozen watchdog. This establishes
a feasibility gap, not a product correctness or memory defect.

The final Grok/Kimi/Opus evidence review returned an empty P0/P1 union and
agreed with branch 3 and the bounded next step. D.110a-v is closed. Its sole
successor is one separately planned creator-close phase-level feasibility
slice over the existing immutable evidence; no new profile, preflight, full
worker, product edit, or acceptance-contract change is authorized here.
