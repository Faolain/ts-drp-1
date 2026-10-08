# D.109b final GREEN implementation review

Review signed/pushed commit `529367b154ffd3fb66bf31a6cfedb4a0d9b73746`
independently and strictly read-only. Its parent
`db84a1addf28e655f7b5850fd540c4b9b6f5ca48` is the immutable causal RED.
The accepted D.109b plan anchors are
`fe934eae3a781b70ef666e5827317cf231e5d078`,
`433f11afe22b2357563d0953c6634829ff344ab1`, and
`5bd4fe84cc3d2279afeb590700ad1c7a63cdccd1`.

Do not edit, stage, commit, generate, format, install, build, test, or invoke
another model/reviewer. Do not inspect any other final-review output. D.109a,
Phase 6a, and earlier evidence are accepted inherited facts and must not be
reopened. This slice authorizes no retained campaign and no D.109c work.

Inspect the accepted D.109/Phase-6b plan and issuance-retention slice, the RED
commit and evidence under `.logs/phase-6b-d109b-red/`, the complete GREEN
commit/diff, relevant issuance/planner/storage contracts, and the GREEN
evidence under `.logs/phase-6b-d109b-green/`.

Adjudicate all of the following:

1. RED was genuinely causal for the missing shared/Node/browser maintenance
   owners, pruning-aware terminal semantics, schema migration, and frozen
   result/error contracts; GREEN closes that reason without relabeling fixture
   or build failures.
2. The ordinary `DurableIssuanceStore` remains exactly six methods. Shared,
   Node, and browser maintenance are isolated subpaths. Capabilities are
   resolved only by exact object identity for facades created by their owner;
   copies, proxies, structural fakes, and cross-backend facades cannot mint or
   borrow pruning authority. Package roots and existing issuance factory
   modules do not leak the maintenance capability.
3. In-memory, Node SQLite, and browser IndexedDB implementations validate and
   detach the complete input, transactionally reread lineage and inclusive
   watermark, require exact expected state, decode canonical v3 issuance rows,
   prove paired equal digests, exact scope/ordinal, complete consumed lineage,
   non-regressing epoch order ending at the selected closed epoch, and
   `published` state before deleting only the bounded selected prefix and
   advancing the watermark atomically. Any stale, malformed, one-sided,
   pending, gapped, count-mismatched, changed, or foreign fact must roll back
   with zero writes; later epochs and unrelated scopes remain untouched.
4. Null and numeric watermark semantics are correct, including idempotence,
   later-epoch progress, and the exact 64-row bound for 64/65/128/129 cases.
   Receipts/errors are detached and deeply frozen with no deleted digest or
   bytes exposed.
5. Node schema-v1 migration preserves the existing physical database identity,
   runs under the native write transaction, accepts exactly the frozen v1
   catalog, creates schema v2 in place, rereads/verifies the resulting catalog,
   and rolls back cleanly on catalog/version/race/fault divergence. Review the
   stale-handle, two-process barrier, exact catalog, and six hard-kill cases.
6. Browser retains its database name and IDB version 1, accepts both legacy
   four-member and current five-member lineage rows, writes a watermark only
   when pruning, preserves numeric watermarks on later issuance, and performs
   its classification/deletion/update in one genuine IDB transaction. Review
   the eleven genuine IDB mutants and identity/refusal cases.
7. Pruning-aware reads, acknowledgements, and terminal classification preserve
   the frozen polarity: consumed absence at/below watermark is pruned;
   `readIssued` returns null; acknowledgement yields exact non-poisoning
   `ISSUANCE_RECORD_PRUNED`; wrong-digest late acknowledgement cannot reveal or
   claim a deleted digest; consumed absence above watermark and rows surviving
   at/below it remain corruption; zero-owner/never-issued behavior is retained.
8. The D.109a planner extension accepts exactly the remaining suffix
   `W+1..through` (or empty only when `W === through`), copies lineage and
   watermark, and preserves all earlier eligibility/refusal behavior.
9. The evidence is internally consistent: focused Vitest is 45/45, focused
   Chromium is 4/4, retained Vitest is 183/183 across 22 files, retained
   Phase-2l browser lifecycle/death is 8/8, retained browser parity is 3/3,
   affected builds and source-only typechecks pass, exact-owner lint/format/
   diff/source-shape gates pass, and the self-excluding manifest validates.
   Treat the documented initial stale v1/hash expectations and corrected
   read-only zsh-variable diagnostic honestly, not as product failures.
10. Scope stays within the accepted narrow D.109b deletion/schema/error/
    terminal exceptions. Identify any concrete invariant gap only if it can
    authorize unsafe deletion, misclassify durable state, expose authority, or
    falsify RED-to-GREEN causality. Do not request speculative redesign or
    later-slice work.

Classify only demonstrated findings. P0 is catastrophic. P1 blocks D.109b
closure. P2 is bounded and nonblocking. `CHANGES_REQUIRED` requires at least
one P0/P1. Cite exact files/symbols/lines and the smallest correction. Do not
request recursive review ceremony.

End with exactly these terminal lines:

`VERDICT: APPROVED` or `VERDICT: CHANGES_REQUIRED`

`P0_P1_UNION: none` or a comma-separated finding-title list

`D109B_MAY_CLOSE: yes` or `D109B_MAY_CLOSE: no`
