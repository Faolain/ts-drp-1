# D.110c-0c1f5b0w plan review

Reviewed signed/pushed plan commit
`e9b2956852a916cdf60c4de29dbe913532c284a3`.

- Grok 4.6/high reached its 16-turn cap after active inspection and was
  classified `NO_VERDICT`. Per the user's standing rule, exact session
  `01a07189-5776-77e2-a047-e60b61899a6c` was resumed once for terminal schema
  emission only. It returned FAIL with one emitted P1 and a reported P2 count
  of four whose bodies were not emitted. The emitted P1 is preserved; no
  missing P2 body is invented.
- Codex `gpt-5.6-sol` high returned FAIL, P0/P1/P2 `0/2/1`.
- Fable 5.1 xhigh ran through `claude-phel`, session
  `7f191cbf-c0a6-4ea9-9021-354dac36b128`, and returned FAIL, P0/P1/P2
  `0/1/4`.

The P1 union has two bounded families: remove the circular dependency on the
parent settlement successor codec, and close the store validator's legacy-
linked/completed-progress mutation fall-through. The corrected plan uses the
already-closed f5b0u rebase-pair path to create a genuine durable hold, proves
that seal reaches the unchanged close owner and existing parent terminus, and
leaves successful close/adopt/re-admission to parent f5b after its codec and
frontier repair. Store entries are immutable while retained; this slice adds
no resolution transition.

P2 dispositions are folded into the same correction: supersede the f5b0c hang
expectation in tests-only RED; defer any plan-level fence rule for resolution
to future f5b0x; freeze exact rehearsal/activation/redirect behavior; and state
that creator-owned or migration-forced holds are indefinite here. Because the
P1 correction changes executable sequencing and the store acceptance matrix,
one material confirmation is required. No production source or test changed
during this review.
