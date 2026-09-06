# D.110c-0c1f2/f4 combined GREEN validation

## Reporter results

- `focused-vitest.json`: `success=true`, 41 total, 41 passed, 0 failed, 0 pending. Vitest's Jest-compatible aggregate reports 12 suite counters for the six selected files; the per-file result set contains exactly the six requested paths.
- `retained-vitest.json`: `success=true`, 195 total, 195 passed, 0 failed, 0 pending. The per-file result set contains exactly the frozen 20 paths.
- `playwright.json`: stats expected/skipped/unexpected/flaky = `2/0/0/0`, two passed result records, zero top-level errors.

## Reporter hashes

- `focused-vitest.json`: `b60aa8882ad766470fa3f1d409a791c7fa5b6fd8e51d2c8b8704920806087991`
- `retained-vitest.json`: `90a0084aebf817dca6f49879aa286e71e977d8bdb1fe91e1581961d8e93bbfb9`
- `playwright.json`: `20674c31bb09dc3244b5b2f33146f1dca4effd5f9a255b5c81e8c204db18f69f`

## Causal and source-shape conclusions

- The aggregate carrier maximum-shape, genuine signing/opening, canonical tuple/vector rejection, empty-writer vector, authenticated field substitutions, prior-sentinel, multi-author close, creator/aggregate equality, first-observed sequence-one, recovery selection, re-entry, bootstrap-policy, hot/cold custody, and legacy compatibility assertions all pass.
- `authenticatedPinnedGenesisOutboxRow()` is the single exact bootstrap predicate used by both recovery consumers. It requires sequence 0, epoch 0, pinned anchor, exact object/author, exact one dependency, logical time 1, signature/digest admission, and exact configured canonical operation bytes.
- `authenticatedCoveredHistoricalOutboxRow()` rejects sequence 0 unconditionally.
- The public recovery key unions retain exactly the four reviewed optional-key combinations; cold reopen retains its two exact key sets; hot and pending input surfaces remain unchanged. These shapes are asserted directly by the focused tests.
- The aggregate close algorithm permits a genuinely first-observed sequence 1 and retains the frozen `>1` gap/re-entry refusal. An exact empty successor writer set is valid.
- The retained same-boundary test now replaces both mutually authenticated legacy and aggregate carriers. It proves the unchanged legacy close behavior remains valid and forked predecessor linkage still fails closed.
- An attempted transition-side writer-set rederivation was rejected because the proposed closure does not contain detached successor ACL bytes. It was removed after reproducing genuine `TRUST_CLOSURE_INVALID`; no wire/API/authority workaround was introduced. Close-time exact writer derivation and the creator-signed current/successor ACL digests remain.

## Remaining blocking debt

D.110c-0c1f5 is a distinct authenticated rebase-supersession problem. Genuine rebase replacements receive fresh author sequences, and the current adjacent-prefix aggregate cannot cross missing source sequence slots. A bare maximum would unsafely authenticate unseen rows. The bounded audit selects no repair and requires high-risk Grok/Kimi/Opus design review before any f5 production edit. Therefore this evidence supports the combined f2/f4 implementation checkpoint but does not claim general historical-rebase safety, parent D.110c-0c1/0c closure, the ≥100-transition golden path, Phase-6 exit, or Phase-7 multi-author cold join.
