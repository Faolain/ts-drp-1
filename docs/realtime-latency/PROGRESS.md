# Real-time game completion

Updated 2026-10-23. This is the current continuation point; the [decision log](README.md)
and track reports preserve the earlier evidence. The owner has authorized correcting
assumptions and using executable models to find a sound, performant design.

The task is incomplete. Passing a room test that pauses at each rollover does not
establish uninterrupted play. A formal model proves its stated abstraction and bounds,
not native storage or network behavior.

## Next agent prompt

Root native production includes the composed `a847900d` checkpoint, the first reviewed
responsiveness slice, and the separate pending-floor model. Genuine recipient SIGKILL
evidence is integrated at `cc4a9908`. The full `613ab647` to recovery composition review,
full-removal completion/local-author expiry work, and finer responsiveness slice remain
separate open gates. Do not describe the whole rejoin composition as fully reviewed.

Finish those gates and their affected composed checks before starting the final campaign.
The continued-play harness uses a 1,000 ms coarse starvation alarm with per-receiver
baselines after convergence. Passing it does not establish smooth play or close the
performance goal. Run Grid continued play and separate Canvas/Chat conservation for
300 epochs, reopening at 30; preserve the remaining uninterrupted WAL interval without
manual checkpoint or vacuum. Then run the remaining browser/capacity gates below. Preserve
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
| [Track AA: creator delivery repair](tracks/39-track-aa-creator-delivery-repair/RESULT.md) | Integrated quiet-room retries and the reviewed replay lifetime/resource fix. Combined replay/H5 validation passed 51 checks, including held successor sends and native rewrite crash recovery. Real localhost libp2p repair also recovers a lost final copy and first answer without another move. Final quiet timings remain open. |
| [Track J: late-arrival model](tracks/38-track-j-late-arrival-retirement-model/REJOIN-CONTRACT.md) | The reviewed rejoin adjunct is integrated: 58 checks, 54 declarations, seven exhaustive graphs, six scoped Apalache checks and 38 negative controls; the largest graph has 2,335,818 states. Its exact model and implementation hashes match integration `77e641a3`. The explicit expiry producer is proposed, not implemented; full-contract arbitrary-state induction and native refinement remain **open**. Earlier replay/custody and A5 receipts retain their separate source scopes. |
| Authenticated partial-cut membership (F1) | Integrated signed successor membership transfer with native point reads. The endurance harness exports the complete v2 membership carrier. |
| [Durable classification and cleanup (F2, A-1, H2, H5)](tracks/40-track-x-native-retirement/RESULT.md) | Integrated durable terminal authority and atomic issuance/settlement-plan retirement. Native storage crash evidence is separate from application endurance. |
| [Recovery and long-room proof](tracks/41-active-application-endurance/RESULT.md) | PRE-PERF300-02 completed 300 epochs and 3,000 accepted operations in each of Canvas, Grid and Chat, with both peers reopening at epoch 150. This source predates the replay fix and remaining capacity/rejoin changes. The final integrated campaign is pending. |
| Arbitrary-gap rejoin and same-key readmission | **Open completion/review gates.** The native gap/custody checkpoint is composed into root. [Real recipient process-death evidence](tracks/42-native-continued-play/evidence/rejoin-process-death/RESULT.md) passes receipt-commit and floor-commit recovery of captured A despite newer B, preserving unknown signed work through another install/reopen. The complete `613ab647` to recovery review, durable full-removal completion and local-author expiry remain open. The separate physical census retains the distinction between an extra source-floor header and the oldest usable recovery base. |
| [Larger work per epoch](../../specs/bounded-storage-lifecycle/capacity-finishability.md) | Common currency, exact-intent and startup-recovery fixes are integrated, together with authenticated pending-bootstrap retention. Isolated shipped-profile campaigns finished 412 serial records across four cycles and 4,208 batched edits across six cycles. Common integration passes 22 focused controls and both real SQLite SIGKILL/recovery edges; final rejoin/performance composition remains open. Historical 357/489-record legacy creator-trusted/NONE failures are not shipped-app G2 regressions. |
| [Native continued play](tracks/42-native-continued-play/RESULT.md) | **Performance completion remains open.** The first reviewed cooperative-work slice is integrated; its matched native pair reduces the observed maximum timer gap from 2,146 to 174 ms without a CPU-efficiency claim. The current bounded harness preserves raw phase observations and checks a separately labeled coarse starvation alarm plus each receiver after convergence. Its integrated short smoke and behavioral negatives are distinct from the pending final 300-epoch campaign and finer responsiveness work. |
| Browser parity | Actual three-engine browser launch remains **blocked** on macOS permission. Native libp2p plus controlled raw datagrams supplies no real browser WebRTC or rendering/FPS result. |

The new application harness uses the shipped compositions, two concurrent durable
writers, deliberately lost first copies, explicit durable replay, settlement-plan
conservation checks and persisted native reopen. Every epoch compares exact application
state; Chat also uses an independent whole-window retention oracle. The current load is
two initial writes per writer, four writes overlapping rollover, and writes overlapping
maintenance. It does not establish sustained high-rate play, unreliable ephemeral
traffic, automatic libp2p repair or arbitrary offline gaps.

The separate [native transport probe](tracks/42-native-continued-play/RESULT.md)
establishes automatic quiet repair and retains source-specific transition measurements.
Earlier profiles and the matched responsiveness pair preserve their original sources.
Per-phase raw observations remain available even when a short phase has no callback or
usable overlapping authority. Baselines compare public room/genesis/ACL scope and count
only codec-accepted deliveries; local channel observations are compared only with that
channel's starting observation. A coarse alarm or finite conservation receipt cannot
substitute for uninterrupted smooth play or browser rendering evidence.

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
