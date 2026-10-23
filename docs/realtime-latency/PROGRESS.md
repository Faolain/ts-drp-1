# Real-time game completion

Updated 2026-10-23. This is the current continuation point; the [decision log](README.md)
and track reports preserve the earlier evidence. The owner has authorized correcting
assumptions and using executable models to find a sound, performant design.

The task is incomplete. Passing a room test that pauses at each rollover does not
establish uninterrupted play. A formal model proves its stated abstraction and bounds,
not native storage or network behavior.

## Next agent prompt

Finish and integrate the active tracks below, then run the combined game path. Preserve
the original Claude worktrees: several contain deliberately reversed source files from
before/after comparisons. Their committed heads and scratchpad progress reports identify
the candidate fixes. Use isolated checkouts, retain failed runs, and compare the actual
tests rather than aggregate pass counts. Update this file at each integration checkpoint.

## Completion contract

- Canvas, Grid and Chat continue through hundreds of real transitions with concurrent
  writers, delayed and lost delivery, bounded overload, and persisted reopen.
- Every accepted operation remains represented by authenticated committed state, durable
  pending work or a policy-authorized disposition. A sent request is not delivery evidence.
- Durable rows, queues, membership evidence and work per epoch plateau. Admission reserves
  the resources needed to finish accepted work before capacity exhaustion.
- Closure membership comes from the authenticated cut, even when a recipient missed
  members. Proofs live until their last consumer; retirement and plan updates are atomic.
- High-rate movement uses the existing unreliable ephemeral plane. Durable gameplay and
  chat retain their safety contract. Measure receiver-observed latency, frame stalls and
  maintenance overlap separately; report hardware, load and delivery conditions.
- Keep [G1–G28](../../specs/bounded-storage-lifecycle/golden-path-guarantees.md).
  Storage claims require both native owners, three browser engines and crash evidence.

## Active work

| Work | State and next gate |
| --- | --- |
| Track X: settlement delivery and migration admission | Recovered; integrate current room defaults, review and finish focused validation. Known partial-cut, expiry and classification-window counterexamples still need the unified completion work. |
| Track AA: creator delivery repair | Recovered; compare baseline, review and fix lost-final-answer handling before integration. |
| Track J: late-arrival model | Recovered; finish bounded checks, investigate the induction counterexample, and distinguish exhaustive results from simulations and unfinished proofs. |
| Authenticated partial-cut membership (F1) | Implement bounded successor membership transfer and verify it against the signed cut before native recording. |
| Durable classification and cleanup (F2, A-1, H2, H5) | Retain signed classification evidence; preserve each store's dependencies; atomically retire issuance and its plan references. |
| Recovery and long-room proof | Resolve rollover/reopen/rejoin failures, integrate the Grid settlement profile, then exercise all shipped apps with continued play and bounded storage. |
| Performance | Measure real receiver progress while maintenance and transitions run, then address measured stalls without weakening authenticity or durability. |

## Evidence recovered

Claude's session evidence is under
`/private/tmp/claude-501/-Users-aristotle-Documents-Projects-ts-drp-1/62160344-dffd-4919-a00c-b5b5da90e416/scratchpad/`.
Each active track has a `PROGRESS.md`; the completion proposal is `track-x/CONTRACT.md`.
The root checkout started at `11552c43`. Its tracked files were clean; existing untracked
logs and the attached conversation are preserved.

Prior results include paused browser long rooms and Chat membership over 300 native
epochs. These remain useful regression evidence, but do not close the continued-play,
loss, crash or performance gates above.
