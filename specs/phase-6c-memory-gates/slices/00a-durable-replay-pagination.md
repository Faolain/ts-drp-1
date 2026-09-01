# D.110a-p — Creator Durable-Replay Pagination Prerequisite

## Contract unlocked

Creator close must seal and later verify every authenticated durable live-
journal row when a valid epoch contains more than one public journal page.
The live-journal API accepts page limits from 1 through 128; valid v3 epochs may
contain up to the independently authenticated `maxEpochVertices` bound. The
current `readCreatorReplayRows` asks for `limit = readiness.rowCount`, so a
129-row journal fails closed before the first page is returned.

This is the only demonstrated product blocker behind D.110a. The accepted
D.110a workload, limits, package-resolution proof, memory arithmetic, and
single full-worker authority remain unchanged.

## Scope and ownership

GREEN may change only `packages/node/src/v3-live.ts`, at the private
`readCreatorReplayRows` owner. RED may add one focused Phase-6c file and commit
only a minimal `beforeCreatorClose` fixture hook that exposes the live plane and
its registered-vertex signer long enough to create 129 genuine ordered rows.
It must not absorb D.110a's uncommitted batch artifact, public-import migration,
helper extraction, package script, memory worker, or other harness edits. RED
is executed and validated from the clean tree of its signed commit; the rest of
the D.110a working diff remains uncommitted and resumes on top after D.110a-p.
No public API, export map, dependency, wire format, digest domain, journal
limit, epoch limit, close/adoption authority, snapshot semantics, memory
threshold, workload, or workflow may change.

The repaired owner pages against the one readiness snapshot. The loop has at
most `rowCount` iterations. Every request uses the maximum permitted page size
clamped to the remaining rows, `Math.min(128, rowCount - consumed)`, starts
after the exact prior nonterminal `nextSequence`, makes strict forward
progress, validates each row against its global expected journal sequence,
rejects empty/non-progress/overrun/early-terminal pages, requires a nonterminal
cursor to equal the last row sequence, and requires `nextSequence === null`
exactly when all `rowCount` rows are consumed.
The existing authentication, issued-row lookup, byte-charge, digest, graph,
and replay-verification comparisons remain the sole semantic checks.

## Deterministic RED

Add one genuine 129-row creator-close test: the inherited received `add(1)`,
the local `add(2)`, and 127 additional signed, admitted, journaled, published
vertices. It requests successful close and exact 129-row custody. A
deterministic source audit reports desired-state predicates without changing
polarity between RED and GREEN: the 128-row public bound must be present, the
private owner must not contain `limit: readiness.rowCount`, and it must contain
the frozen bounded-pagination/progress/terminal guards. Against the plan anchor
the public-bound control passes while the genuine close and owner-pagination
predicate fail: the close ends in `creator close durable replay seal failed`
and no other test changes status. The same assertions pass unchanged in GREEN.
No memory worker, D.110a preflight, browser test, or retained campaign runs in
RED.

## Narrow GREEN and verification

Replace the single oversized read with one bounded loop at the existing
private owner. Run the focused 129-row test, creator-close/adoption/activation
retained tests, D.109d/D.109f reclamation tests, node build and source
typecheck, exact-owner lint/format/diff/source-shape checks, and protected
state/evidence-manifest checks. The genuine 129-row case executes continuation
and final-page behavior, the structurally bounded loop prevents an empty-page
hang, the unchanged global-sequence and map-size checks reject cursor drift,
and existing store tests retain store conformance. No synthetic malformed-store
fixture or parallel journal reader is required.

Sign and push RED and GREEN separately. After GREEN, run one formal
Grok/Kimi/Opus review over the signed plan-to-RED-to-GREEN history. Only an
empty P0/P1 union closes D.110a-p. Kimi uses the standard direct CLI with K3
and `KIMI_LOOP_MAX_STEPS_PER_TURN=100`; Grok cancellation resumes the exact
session. No Fable or collaboration subagent is authorized.

## Resume boundary

After D.110a-p closes, rebuild affected packages and resume D.110a at its
corrected two-object non-verdict preflight. Preserve both failed preflight
attempts as causal diagnostics. The 64-object full worker is still unspent and
may run exactly once only after the corrected preflight passes.
