# D.109f post-correction confirmation union

Reviewed signed correction:
`ca25ea23df36d571beef4d01afe533437520ed79`.

All three required reviewers returned `APPROVED`, `P0_P1_UNION: none`, and
`PHASE6B_READY: yes`:

- Grok 4.6/high `01a05c57-6ef8-7f32-aede-cca3117b5bf8`;
- standard Kimi CLI K3/high/100
  `session_fcd6dd11-dbfd-49f4-bda0-c6e7e339bf72`;
- Opus xhigh `18b50593-19b7-4564-93bc-1e7ceb38787c`.

The P0/P1 union is empty. The bounded P2 union is dispositioned without code or
another review round:

1. Redundant `Object.values(projection)` membership assertions remain
   nonblocking because independent accepted-operation, canonical-preimage,
   owner-sink, digest, and durable-journal assertions carry the proof.
2. `runtime.anchor` intentionally has no D.109d `ownerKey`; durable-head and
   anchor-keyed journal behavior discharge it without inventing a census API.
3. Page scans classify rows that actually exist after lookup; null-returning
   blob/issued-record point reads are the missing-data evasion path and are
   classified before lookup. Receipt identities and native censuses prove
   physical deletion.
4. No product caller is demonstrated to swallow the tests-only hook failure;
   the hypothesis does not establish a Phase-6b defect. No executable debt is
   carried from it.
5. Package-local source imports use one source tree and the genuine shared
   lifecycle uses one `dist` tree. Neither crosses a WeakMap identity realm.
6. Vitest's suite count is not its selected-file count; the authoritative
   `testResults` arrays contain exactly two focused and eight retained files.

D.109f and Phase 6b are therefore closable. No campaign ran.
