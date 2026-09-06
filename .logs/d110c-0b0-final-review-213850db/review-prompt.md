# D.110c-0b0 final plan → RED → GREEN review

Act as a read-only high-risk security/correctness reviewer. Inspect signed commit `213850dbba5e4b3fca350592a3d1193c6d50e7b0` and its diff from `798489fdef5fc3a6d774ecb2ccc075205e00e254`. Do not edit files, run tests, invoke subagents, or rely on another reviewer's output.

Primary question: did GREEN close the accepted D.110c-0b0 causal RED by adding the exact application/account-held monotonic room-head authority and frozen first-transition publication/recovery law without widening protocol semantics or leaving a P0/P1 correctness, security, lifecycle, or evidence gap?

Inspect at minimum:

- `docs/production-hardening/production-hardening-tdd-plan-v2.md`, especially D.110c-0b0, 0b0a, 0b0b, the causal RED, owner-selection review, and new GREEN record;
- `examples/v3-room/src/index.ts` and `examples/v3-chat/src/index.ts`;
- `packages/node/src/creator-adoption-activate.ts`, `packages/node/src/internal/creator-room-head.ts`, and `packages/node/src/internal/creator-successor-live.ts`;
- the full changed test/fixture diff, especially `tests/phase-6b-d110c-0b0-floor-red.test.ts`, `tests/phase-6b-d110c-0b0a-staged-handoff-red.test.ts`, and the browser product test/asset;
- `.logs/d110c-0b0-green-798489fd/green-ledger.md`, reporter JSON, source audit, and validated `SHA256SUMS` when accessible.

Verify these load-bearing points:

1. Missing independently authenticated floor fails before cold activation; wrong floor fails exact equality; correct floor preserves genuine reopen.
2. Hot adoption order is verify → durable stage without AHE publication → provider begin-CAS → AHE publish → provider commit and reread → activation.
3. Pending recovery never derives freshness from hostile room/AHE bytes, activates nothing before exact provider/head convergence, and handles both AHE orderings fail closed.
4. Provider inputs/results are exact-shaped and copied; create versus ordinary reopen/migration semantics, scope binding, no silent absent-floor initialization, and exact error classifications match the accepted design.
5. A provider outage/conflict or ambiguous crash cannot leave the old or new product owner issuing/activating contrary to the selected floor, nor strand a correct room through an unowned recovery state.
6. Node hot/cold activation compares the copied exact `(objectId,epoch,currentAnchorDigest)` to authenticated successor trust before activation.
7. The browser instrumentation fix genuinely removes mixed source/dist process-local custody without masking a product resolution defect.
8. Retained behavior, exact public boundary, no wire/schema/dependency/threshold change, and source/evidence custody are honest.
9. Test coverage is causally sufficient for all P0/P1 provider, crash, concurrency, recovery, lifecycle, and classification risks promised by the accepted 0b0 plan. Missing deterministic coverage of a load-bearing promised row is a finding, not presumed covered by prose.
10. The latest Fable P1s (predicate-based a/b closure tests and predecessor-floor retention while cold open needs it) are correctly prospective and do not require reopening 0b0.

Only P0/P1 block. P2 must be concrete and dispositionable without inventing new scope. Do not request protocol-v3 records, crypto, dependencies, service selection, timing/threshold changes, long campaigns, or D.110a reruns unless the current implementation demonstrably requires them.

Return exactly one JSON object and no leading/trailing prose:

```json
{
  "verdict": "APPROVED or CHANGES_REQUIRED",
  "blocking_union_empty": true,
  "p0": [{"title":"...","evidence":"file:line and concrete behavior","required_fix":"..."}],
  "p1": [{"title":"...","evidence":"file:line and concrete behavior","required_fix":"..."}],
  "p2": [{"title":"...","evidence":"file:line and concrete behavior","disposition":"..."}],
  "summary": "concise causal verdict"
}
```

Use empty arrays when none. `blocking_union_empty` must equal whether both P0 and P1 are empty.
