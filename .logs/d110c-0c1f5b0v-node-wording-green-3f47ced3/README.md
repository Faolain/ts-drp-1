# D.110c-0c1f5b0v Node callback wording corrective GREEN

Signed and pushed GREEN: `3f47ced3099134d4b0c7f1bd2b11aee2a652ae7a`
(`G`). Causal tests-only RED: `e8e7b027629a647a068d51395f88b51e8391c2eb`;
RED evidence: `b5d94193aa34819f1f8706b4ee4f0ac966baffb9`.

The sole tracked change replaces one inaccurate sentence in the exported Node
`V3AdmittedVertexSink` JSDoc. It now distinguishes successor-recovery callback
rejection, which rejects and deactivates that activation, from ordinary
authenticated ingress and local issue, which retain their legacy
log-and-continue behavior. The room-owned session JSDoc is unchanged. No
runtime token, comment-free AST, callback type, export, API, wire/schema,
authority, dependency, threshold, timeout or workload changed.

## Gates

- Focused callback contract: local 2/2 and clean-isolated 2/2.
- Relevant successor/recovery/activation/handle/epoch/hot-adoption retained
  set: local 33/33 and clean-isolated 33/33.
- Sensitive-return source governance: local and clean-isolated 4/4 selected;
  eight tests are intentionally skipped by the exact selector.
- Exact comment replacement, unchanged runtime tokens/comment-free AST, room
  source, callback tests and lockfile: local and clean-isolated pass.
- Affected Node and room builds pass. Room typecheck passes; Node typecheck
  retains its exact previously recorded 13 baseline diagnostics. ESLint,
  Prettier and diff checks pass.

The clean-isolated commands ran in the existing genuine checkout
`/tmp/d110c-f5b0v-green-LLxy4p/checkout`, detached at exact signed GREEN. That
checkout was originally created and dependency-built without source, fixture,
`dist`, or `node_modules` overlay for the accepted f5b0v GREEN; switching from
`c66e09c2` to `3f47ced3` changes only this JSDoc sentence set.

## Retained diagnostic

The agent additionally ran the old Phase-3 live-plane test named `reaches
genuine recovered activation, binding conflict, ingress queueing, egress and
deactivation`. It failed at line 1223 while checking an earlier
`publishPending()` result, before the rejecting sink was installed or invoked.
The newline-separated driver then committed and pushed despite that diagnostic
failure; this execution-order mistake is preserved, and the test is not called
green.

The primary failure is retained under `legacy-ingress/`. The root owner then
ran the same single test exactly once in the untouched clean checkout at
pre-comment commit `c66e09c2`. It failed at the identical line and assertion;
that reporter is retained under `diagnostic-pre-comment/`. Production runtime,
the test, and their tokens/AST are byte-identical between these commits. The
failure is therefore inherited and independent of this comment-only GREEN. It
was not part of the accepted 123-test retained matrix, is not used as evidence
that ordinary rejection passes, and remains an honest newly observed retained
test defect for its owning Phase-3 harness. The focused source contract pins
the two existing catch/log-and-continue call sites reviewed by Sol; no runtime
behavior is newly claimed.

The raw command records predate the final evidence-root name and therefore
honestly retain the original `...-working-b5d94193` output paths. No command or
result was rewritten after execution.

The first manifest-validation loop accidentally used zsh's special `path`
variable as a record-field name, which removed command lookup after its first
iteration. The manifest itself was already generated correctly. The corrected
read-only validation uses `rel_file` and validates every listed hash.
