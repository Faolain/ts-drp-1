# Real-time game completion

Updated 2026-10-23. This is the current continuation point; the [decision log](README.md)
and track reports preserve the earlier evidence. The owner has authorized correcting
assumptions and using executable models to find a sound, performant design.

The task is incomplete. Passing a room test that pauses at each rollover does not
establish uninterrupted play. A formal model proves its stated abstraction and bounds,
not native storage or network behavior.

## Next agent prompt

Finish the remaining gates below, then run the combined game path. Preserve
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
| [Track X: settlement delivery and migration admission](tracks/34-track-x-settlement-fence-delivery/RESULT.md) | Integrated. The combined application campaign and the larger-capacity admission gate remain open. |
| [Track AA: creator delivery repair](tracks/39-track-aa-creator-delivery-repair/RESULT.md) | Integrated quiet-room retries and the reviewed replay lifetime/resource fix. Combined H5 validation is next. Final quiet timings wait for the remaining reviewed production fixes. |
| [Track J: late-arrival model](tracks/38-track-j-late-arrival-retirement-model/REPLAY-CUSTODY.md) | The replay/custody adjunct passed 59 checks and 74 test declarations, including projected Apalache base/preservation proofs. Earlier finite A5 progress exhausted 2,174,196 states. Full-contract arbitrary-state induction and refinement remain **open**. |
| Authenticated partial-cut membership (F1) | Integrated signed successor membership transfer with native point reads. The endurance harness exports the complete v2 membership carrier. |
| [Durable classification and cleanup (F2, A-1, H2, H5)](tracks/40-track-x-native-retirement/RESULT.md) | Integrated durable terminal authority and atomic issuance/settlement-plan retirement. Native storage crash evidence is separate from application endurance. |
| [Recovery and long-room proof](tracks/41-active-application-endurance/RESULT.md) | PRE-PERF300-02 completed 300 epochs and 3,000 accepted operations in each of Canvas, Grid and Chat, with both peers reopening at epoch 150. This source predates the replay fix and remaining capacity/rejoin changes. The final integrated campaign is pending. |
| Arbitrary-gap rejoin and same-key readmission | **Open.** The isolated shipped-Chat implementation passes six public SQLite cold/fault cases. Repeated gaps, actual-head G18 retention and expiry/last-consumer work remain in progress; no incomplete rejoin chain is integrated. |
| Larger work per epoch | **Open for shipped settlement profiles.** The 357/489-record diagnostic failures used legacy creator-trusted/NONE, whose growing retention is intentionally preserved under the owner's ledger row 28. They are not shipped-app G2 regressions. The larger campaign now exercises the shipped settlement profile; shared currency, intent and crash-recovery defects exposed by those diagnostics are being corrected. |
| Continued play and browser parity | Automatic room/network repair, receiver-observed progress during rollover/maintenance, and high-rate ephemeral ticks remain separate gates. The signed-byte endurance driver supplies none of those transport claims. Actual three-engine browser validation remains **blocked** on macOS launch permission. |

The new application harness uses the shipped compositions, two concurrent durable
writers, deliberately lost first copies, explicit durable replay, settlement-plan
conservation checks and persisted native reopen. Every epoch compares exact application
state; Chat also uses an independent whole-window retention oracle. The current load is
two initial writes per writer, four writes overlapping rollover, and writes overlapping
maintenance. It does not establish sustained high-rate play, unreliable ephemeral
traffic, automatic libp2p repair or arbitrary offline gaps.

The [completed campaign](tracks/41-active-application-endurance/RESULT.md) records
source `6f414a25` and exact patch hash `25f03f5a…3187449`. Logical rows and primary
files stabilize under its declared load, but whole-directory WAL bytes still grow
at epoch 300 because reopen at 150 resets the slowest owners before their ordinary
checkpoint threshold. The final campaign will reopen earlier and preserve a longer
uninterrupted segment. No checkpoint or vacuum will be injected to manufacture a
plateau. Epoch count, per-epoch work and dependency depth remain separate axes.

Earlier smoke and interrupted-run evidence remains identified in that report.
The harness now joins concurrent work before reporting a failure; failure injection
reproduces the old unhandled-rejection/early-cleanup behavior and passes after the fix.

## Evidence recovered

Claude's session evidence is under
`/private/tmp/claude-501/-Users-aristotle-Documents-Projects-ts-drp-1/62160344-dffd-4919-a00c-b5b5da90e416/scratchpad/`.
Each active track has a `PROGRESS.md`; the completion proposal is `track-x/CONTRACT.md`.
The root checkout started at `11552c43`. Its tracked files were clean; existing untracked
logs and the attached conversation are preserved.

Prior results include paused browser long rooms and Chat membership over 300 native
epochs. These remain useful regression evidence, but do not close the continued-play,
loss, crash or performance gates above.
