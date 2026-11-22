# Track G: optimistic move presentation

**Outcome:** Landed in 719e4732 (opt-in presentation overlay; moves visible in 1-9 ms during lulls).

### Brief (plan given to the agent) (2026-10-19 15:43 UTC)

You are Track G. Goal: in a real-time game, a move must be visible to the mover and to peers within milliseconds. That should hold even while durable admission is slowed by maintenance, seals or installs, and it must not weaken what the durable path guarantees.

Context:
- **Today:**
  - `V3RoomSession.issue()` resolves only after durable admission and publication.
  - During maintenance the creator's own moves wait 3.1–4.9 s.
  - Peers see moves only after the receiver's durable admission. Moves that arrive during maintenance are queued, so they are seen up to about 4.8 s late.
- **Prior art:** client-side prediction and server reconciliation (Quake/Source netcode, Gabriel Gambetta's articles), optimistic UI, CRDT local-first apps, rollback netcode (GGPO).
- **Overlap:** Track F is separately trying to make durable admission run concurrently with maintenance. You are the complementary layer, so don't touch admission or census code.

Setup:
- Your worktree starts at 4c4f192c. Apply `git apply <evidence>/track-e/base-int.patch` first, rebuild the canonical, storage and storage-browser dists, and build a base bench bundle.
- Use the `op-` prefix and scratch dir `<evidence>/track-g/`.
- Do not commit.
- The machine is loaded: use paired runs.
- You have about 200 turns.

Work:
1. **Design an opt-in presentation API** on V3RoomSession, for example:
   - a speculative projection, i.e. a pending overlay;
   - `issue()` returning a handle with `visible` (immediate), `durable` and `published` stages.
   Locally:
   - apply the move to a pending overlay at once;
   - sign and send it to peers as early as safely possible. Can the signed envelope be gossiped before the local durable append, or only after? Decide this from the protocol's safety rules and justify it.
   - reconcile when durable admission accepts it, and roll back with a reason when it refuses.
   On receivers:
   - verify the signature and ACL, which is cheap and memoized;
   - show an authenticated move as pending immediately, even while durable admission is queued behind maintenance;
   - confirm or roll back when admission finishes.
   Define the ordering and conflict semantics of the overlay: which DAG and logical-time order is used and how the overlay re-bases. Keep the existing durable projection API unchanged and authoritative.
2. **Prove it:**
   - tests showing the overlay converges to the durable projection in all cases: accept, refuse, reorder, epoch transition and crash/reopen. The overlay is memory-only.
   - tests showing that nothing in the overlay can reach durable state or authority;
   - the affected node test suites run against your base, with the test delta reported.
3. **Measure:**
   - Add to the Grid fixture an opt-in time-to-visible metric, measured on mover and peers, in both normal play and STARTUP_HEALTHY_GRID_POOL_LULL=concurrent.
   - Run paired runs, base vs yours, at least 2 pairs.
   - Report time-to-visible p50/p95/max during normal play and during maintenance, next to the existing time-to-durable.

Deliverables: a patch file in your scratch dir, against base-int.patch applied, and a concise final report in your reply. Subagents can't write REPORT.md. The report needs the API, its semantics, the soundness argument, numbers and the test delta.

### Follow-up instruction — Resume Track G with tight brief (2026-10-19 16:33 UTC)

Resume Track G (optimistic move presentation): you hit the 200-turn limit while restoring your library sources after building the base bundle. Finish in at most ~60 more turns:
1. Restore your library changes in the worktree and make sure they typecheck (`tsc -p tsconfig.build.json --noEmit` for each touched package).
2. Make sure focused tests prove the optimistic path is sound: a locally presented move is confirmed or rolled back exactly once, never duplicated after admission, and ordering stays consistent with the admitted log.
3. Run ONE paired bench, base vs yours, in concurrent mode. Report time-to-visible for the creator's own moves and peers' moves during maintenance, against base.
Do NOT commit. Don't write REPORT.md. Write the patch with `git diff > <evidence>/track-g/patch.diff`. Reply with: (a) the design and its API surface; (b) the patch path; (c) test results, with before/after failure sets; (d) bench numbers; (e) risks and semantics the app must handle, e.g. rollback UX.

### Report returned by the agent

Track G: I added an opt-in, memory-only presentation layer to `V3RoomSession`. It makes moves visible to the mover and to peers within milliseconds while durable admission stalls behind maintenance, and it leaves the durable path untouched.

During maintenance the creator now sees its own moves at p50 1.2 ms and max 1.6 ms, against 3.5 s max on base. Peers see moves at p50 4.4 ms and max 9.7 ms, against 3.6 s max. Durable admission still takes about 3.5–4.2 s in maintenance; that part is Track F's job. The new suite passes, and nothing that passed on base now fails because of this change.

#### (a) Design and API
- **Turning it on:** `createV3RoomSession({ …, presentation?: { maxPendingEntries=256, remotePendingTimeoutMilliseconds=15000, speculate?(op), onSpeculativeProjection?, onPresentationEvent? } })`.
- **New session methods:**
  - `issueWithReceipt(op)` returns `{ visible, durable, published }`.
    - `visible` settles when the move enters the speculative view.
    - `durable` settles together with the durable projection that contains the move, carrying `{vertexDigest, authorSequence}`.
    - `published` settles exactly when `issue()` would.
    - Moves that aren't speculated settle with `undefined` when `published` settles.
  - `speculativeProjection()`, `pendingOperations()`, and `bindPresentationIntents(ephemeralChannel, {key?})`.
  - `issue()` and `projection()` are unchanged and remain authoritative.
- **Three sources of pending moves:**
  - **Local:** shown the moment `issue()` starts, before any wait at the maintenance barrier.
  - **Remote signed:** a received envelope gets a read-only check (`speculateV3IngressVertex` in `v3-live.ts`: envelope, signature, scope, ACL, current writer, not yet admitted, application operation only). It runs in its own task after the durable ingress step has been queued, and is then shown while admission waits.
  - **Remote intent:** an unsigned, display-only record of a local pending move, sent over the room's authenticated ephemeral channel. Peers show it at once. It gives way to the signed move or the durable one, is withdrawn if the move rolls back, and expires after 15 s.
- **Ordering:** the view is a pure fold of all durable rows, in the existing min-hash topological order, followed by pending rows sorted by (logicalTime, author, seq). Re-basing means recomputing that fold. A pending move that the fold refuses is hidden, the same way the durable contained fold drops it.
- **Lifecycle:**
  - Each entry emits pending, at most one visible, then exactly one terminal event: either confirmed (stage durable or signed), or rolled back with a reason.
  - Rollback reasons are `refused`, `projection-refused`, `epoch-changed`, `unconfirmed`, `withdrawn` and `closed`.
  - A local move is confirmed inside the same synchronous step as the durable commit (matched on bound logical time plus the operation's canonical bytes), so it never appears twice.
- **Why it can't weaken durable guarantees:**
  - The overlay module imports only the canonical codec plus type-only ephemeral declarations.
  - Every hook into it is wrapped so a failure can't propagate, and it holds no store, signer, outbox or authority.
  - Tests pin every place in `v3-room` that touches it. A test also runs `speculateV3IngressVertex` against a registration that throws on any write.
- **Gossip timing:** a signed envelope cannot leave before `transactIssue` durably commits its author sequence. Sending it earlier would let a crash re-sign the same sequence with different content, which is equivocation. The earliest safe point is right after that commit; that is a recommendation for Track F, since it changes the issue path. While the maintenance barrier holds, no signed vertex exists yet, so peers can only learn of the creator's moves through intents.

#### (b) Patches
- **Full diff from the worktree (base-int + Track G, against 4c4f192c):** `<evidence>/track-g/patch.diff`
- **Track G only, against base-int applied (6 files):** `<evidence>/track-g/track-g.patch`

Both pass `git apply --check -R`. The two new files are marked intent-to-add (`git add -N`) so they show up in `git diff`; nothing is committed.

#### (c) Tests
- **Typecheck:** `packages/node` `tsc -p tsconfig.build.json --noEmit` reports 0 errors. No other package is touched.
- **New `presentation-overlay.test.ts` (16 tests, all pass)** covers:
  - accept, refuse and projection-refused;
  - remote dedupe and rollback;
  - reorder and re-base, and an epoch transition;
  - close and reopen, which leaves the overlay empty because it is memory-only;
  - intents: superseded, withdrawn, and arriving late;
  - the isolation and AST tests;
  - a model check of 200 seeds × 40 steps. After every step it asserts:
    - the view equals fold(durable rows ++ visible pending rows);
    - pending rows are sorted;
    - per-entry lifecycle: one pending, at most one visible, exactly one terminal event, nothing after it;
    - local hooks: an admitted move gets exactly one durable call and no rollback;
    - after draining, the view is the durable projection itself.

**Affected suites, base vs mine:**

| Suite | Base: failed / total | Mine: failed / total |
|---|---|---|
| 22 node tests | 28 / 697 | 30 / 713 (+16 new tests, all passing) |
| 22 root tests | 93 / 250 | 94 / 250 |

- **The +2 node failures** are 10 s timeouts in `creator-closed-rollback-proof-accounting` on a machine with load average around 80–100. Both pass when rerun on my build.
- **The +1 root failure** is the d110c "bounded advance predicate" test. It fails 3 out of 3 on my build, but the same test also fails when base `v3-live.ts` gets only a comment block of the same size. So it's a race in the test: it loads four modules concurrently, and protocol-v3 has a circular import between `index`, `public` and `anchor-trust-singleton`. My code's behavior doesn't cause it.
- **The v3-live export-list pins** (phase-3a1b-p3, phase-4b) already fail on base, because about 25 existing exports aren't in their pinned lists. I add two more names; no new test fails.

#### (d) Bench numbers
8 rollovers, 4 clients, all runs passed. `g3` is the final build; `g2` is the same build without the deferred display verification. Values are p50 / p95 / max in ms.

**Maintenance window (`STARTUP_HEALTHY_GRID_POOL_LULL=concurrent`):**

| Metric | Base (3 runs) | Mine (g2 ×2, g3) |
|---|---|---|
| Creator's own move, time-to-visible | 111–123 / 3148–3970 / 3148–3970 | **1.2–1.3 / 1.5–1.6 / 1.6** |
| Creator's own move, time-to-durable | same as time-to-visible | 125–154 / 3490–4212 (unchanged) |
| Other movers' own move, time-to-visible | 37–42 / 64–82 / 81–108 | **1.3–1.4 / 1.7 / 1.8** |
| Receivers, time-to-visible | 119–136 / 3069–3973 / 3240–4069 | **4.3–4.6 / 7.3–8.0 / 9.2–9.7** |
| Receivers, time-to-durable | same as time-to-visible | 124–154 / 3414–4083 (unchanged) |

**Normal play, final pair (p4):**

| Metric | Base | Mine (g3) |
|---|---|---|
| Mover time-to-visible | 26.5 / 92 / 107 | **1.5 / 3.7 / 6.1** |
| Peer time-to-visible | 56.5 / 124 / 221 | **4.2 / 11.4 / 22.1** |
| Mover time-to-durable | 26.5 / 92 / 107 | 28.7 / 85 / 165 |
| Peer time-to-durable | 56.5 / 124 / 221 | 67.5 / 125 / 195 |

- **Cost to the durable path:** p50 time-to-durable rises by about 2–7 ms for the mover and 11–15 ms for receivers; p95 is within noise. Before I deferred the display verification, the receiver increase was 12–21 ms.
- **Signed-vertex check only, no intents:** maintenance-window peer time-to-visible stays at p95 3.6 s. That confirms intents are what make peers see moves during maintenance.
- **Event counts:** pending, visible and confirmed counts balance on every client, no rollbacks occurred, and the convergence check `speculativeProjection() === projection()` passed in every run.

#### (e) Risks and what the app must handle
- **Rollback UX:** a shown move can snap back. Draw pending moves differently, and handle the `rolled-back` reason: refused, projection-refused, epoch-changed, unconfirmed (no confirmation within 15 s), withdrawn, or closed.
- **Conflicts reorder:** pending moves sit after all durable rows in (logicalTime, author) order, but the final durable order is a min-hash topological sort. Two players claiming the same cell will both see their own claim first, and one flips when the moves become durable.
- **Intents are unsigned:** a current writer can show a fake move for up to 15 s, limited to 256 entries. It can never reach durable state, ACL, seal or authority.
- **Scope of speculation:** by default only batchable actions are speculated; other actions just wait for the durable path.
- **No crash recovery for pending moves:** they are lost on a crash or reopen, so after reopen the app sees only durable state.
- **Display verification repeats the signature check.** Caching it would mean touching admission, which belongs to Track F.
- **Creator time-to-durable in maintenance is unchanged** at about 3.5–4.2 s; Track F is working on that.
- **Pre-existing, on both builds:** a 4-rollover run with the concurrent lull fails at persisted reopen with "creator snapshot role reconciliation refused: floor-stale".
