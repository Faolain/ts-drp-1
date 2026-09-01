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
`readCreatorReplayRows` owner. Tests may add one focused Phase-6c file and the
smallest tests-only fixture seam needed to create 129 genuine ordered rows.
No public API, export map, dependency, wire format, digest domain, journal
limit, epoch limit, close/adoption authority, snapshot semantics, memory
threshold, workload, or workflow may change.

The repaired owner pages against the one readiness snapshot. Every request
uses `limit <= 128`, starts after the exact prior terminal sequence, makes
strict forward progress, validates each row against its global expected
journal sequence, rejects empty/non-progress/overrun/early-terminal pages, and
requires `nextSequence === null` exactly when all `rowCount` rows are consumed.
The existing authentication, issued-row lookup, byte-charge, digest, graph,
and replay-verification comparisons remain the sole semantic checks.

## Deterministic RED

Add one genuine 129-row creator-close test: the inherited received `add(1)`,
the local `add(2)`, and 127 additional signed, admitted, journaled, published
vertices. It requests successful close and exact 129-row custody. Against the
plan anchor it must fail only because durable replay asks the public journal
for an oversized page, ending in `creator close durable replay seal failed`.
A deterministic source audit must simultaneously prove the 128-row public
limit and the current `limit: readiness.rowCount` call. No memory worker,
D.110a preflight, browser test, or retained campaign runs in RED.

## Narrow GREEN and verification

Replace the single oversized read with one bounded loop at the existing
private owner. Run the focused 129-row test, creator-close/adoption/activation
retained tests, D.109d/D.109f reclamation tests, node build and source
typecheck, exact-owner lint/format/diff/source-shape checks, and protected
state/evidence-manifest checks. Add focused malformed-page controls only if
the existing store-contract tests do not already make the new progress and
terminal predicates executable; do not create a parallel journal reader.

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
