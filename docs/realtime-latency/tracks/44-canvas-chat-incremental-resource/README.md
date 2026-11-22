# Track 44: Canvas and Chat offer the incremental resource projection (Track Q's Option B)

Branch `perf/canvas-chat-incremental-resource` (from `perf/integration-7` 4e3c9b41). Decision row 79.

## Problem

Gate m5 (ec4ee372, 100 epochs, app mode): live-admitted receive p95 was Grid 70 ms, Canvas 453 ms and
Chat 477 ms; issue p50 51 / 88 / 128 ms. The gap is the creator's admission, not payload size, codec or the
member side (writer receive 6-12 ms and writer issue 11-21 ms for every app).

Only the Grid's resource-bound reader supplied `createIncrementalProjection`
(examples/grid/src/v3-zone.ts). Without it the creator never prepares its ordinary finishing resource
program (`prepareCreatorOrdinarySourceReadinessForSizing` returns at the missing hook), so for Canvas and
Chat:

- no admission takes the incremental quote (`ordinary-incremental-fallback` on 210 of 210);
- steady admissions take the warm template, about twice the Grid's cost;
- after every adoption the template is refused (`source-or-fixed-shape`) and the cold exact
  maintenance-prefix sizing runs, about half of a 300-600 ms admission. Those first admissions after
  each adoption are the p95 tail.

Track Q deferred the hook ("Option B", tracks/27-track-q-canvas-chat-lull/RESULT.md section 9): it
needed per-move evidence, review of both bounds, and probably a tighter Chat footprint.

## Change

- Canvas (`packages/node/src/applications/canvas.ts`) and the three Chat formats
  (`examples/chat/src/v3-chat-resource-bound.ts`, used by v3 lifetime, v4 window and v5 shares) supply
  the hook. The projection states the same theorem as the complete reader: it checks the bases exactly
  as the reader does (catalog identity and carriers, the material without a candidate, every base this
  composition's own authenticated state), once, and every quote is the approved constant: Canvas's
  widest reachable state (2,944 bytes, 817 items, depth 3 at 10x10), Chat's 32,768 bytes / 16,384 items /
  depth 16. Advancing cannot change it. No wire, profile or protocol change; the bound values are the
  ones approved in row 38.
- Chat's ceiling sits below the encoding limits only because the composition's admission policy
  refuses every reservation whose joined state the capture would refuse. The room takes that policy
  from its host (`createOperationAdmissionPolicy` is a session input), while the reader travels with
  the application. The projection is therefore offered only after the room has built a policy from the
  composition's own factory (`shippingChatCeilingResourceBound(...).admissionPolicy`). A host that
  installs no policy, or a different one, gets no projection, and the creator keeps its complete exact
  fallback. The complete reader is unchanged.

## Evidence

Per move (live-step-cost, product reader, harness rollover, 8 epochs x 6 moves; wall/CPU ms, mean of per-run p50):

| App | Step | Before | After |
|---|---|---|---|
| Canvas | admit@0 (first after adoption) | 320.5 | 46.0 |
| Canvas | steady admit | ~44 | ~24 |
| Chat v5 shares | admit@0 | 545 / 706 | 103 / 134 |
| Chat v5 shares | steady admit | 87-89 / 112-118 | 57 / 70-76 |
| Chat v5 shares | creator issue@1 | 425 / 508 | 63 / 77 |
| Chat v4 window | admit@0 | 467 / 621 | 66 / 95 |
| Chat v4 window | steady admit | 64-74 / 87-96 | 33-42 / 47-52 |

With the hook every admission is `ordinary-incremental-hit`. For reference the Grid is about 43 at
admit@0 and 22 steady.

Quote soundness (tests/canvas-chat-resource-bound.test.ts): after 1, 1, 2, 4, ... 32 real advances
(Canvas paints and splashes through the kernel; Chat messages admitted by each format's own policy
over 24 epochs, folded by the compiled reducer and filling more than 80% of 32 KiB), over a
multi-base input, `quote(next real candidate)` equals the complete reader's value and dominates the
exact footprint of the fullest reachable state. A mutant whose quote shrinks once anything was advanced
passed the previous tests and fails all four new cases.

Liveness: an exhausted incremental proof reserve is rethrown, not a fallback
(creator-close.ts, "creator incremental proof reserve is exhausted"). The capacity derivation declines
before charging when the projected proof does not fit the book (for example
`window-current-book-envelope`), so the throw is a guard. Measured with a probe on every incremental
charge (book 1,310,720 bytes):

| Run | Largest base state | Largest charge | Exhausted | Incremental hits |
|---|---|---|---|---|
| live-step v3 lifetime, texts padded to fill (8 epochs) | 30,028 B | 36% | 0 | 97 of 105 |
| live-step v4 window, padded (16 epochs) | 32,764 B | 39% | 0 | 165 of 209 |
| live-step v5 shares, padded (16 epochs) | 32,744 B | 38% | 0 | 185 of 209 |
| live-step Canvas (8 epochs) | - | 31% | 0 | 105 of 105 |
| chat-rolling-window-native, 120 epochs, window full | - | 28% | 0 | 722 of 722 |
| track-w2-chat-shares-native, 300 epochs | - | 28% | 0 | 1,503 of 1,503 |
| canvas-chat-long-room (shipped bounds) | - | 26% | 0 | 356 of 356 |
| canvas-chat-creator-lull-native | - | 21% | 0 | 43 of 43 |

With unpadded texts every admission hits. With a full state and five or more large moves per role per
epoch, the later moves of some epochs decline the incremental quote (`window-source-unprepared`, or a
numerical miss) and take the existing warm or cold fallback; no run exhausted the reserve. Without the
hook every admission took that fallback.

## Remaining

- Owner review of both bounds now that the warm path consumes them on every admission (G22).
- Why readiness is unprepared for some epochs once a Chat state is full and moves are large
  (`window-source-unprepared` on moves 4+); a performance question, not a safety one.
