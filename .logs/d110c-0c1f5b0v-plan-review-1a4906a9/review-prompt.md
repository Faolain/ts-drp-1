# D.110c-0c1f5b0v bounded plan review

Review signed/pushed commit `1a4906a940014e263e13a9088b7761ca7477a0c8`
on `codex/phase3a1b-p6-golden-path`. This is a read-only architecture and
acceptance review. Do not edit files or run tests.

Read only the directly relevant material:

- `docs/production-hardening/production-hardening-tdd-plan-v2.md`:
  “Current frontier — author settlement and writer capacity”,
  `D.110c-0c1f5b0u`, new `D.110c-0c1f5b0v`, and the opening status/boundary of
  parent `D.110c-0c1f5b`;
- `git show 1a4906a9^..1a4906a9 --
  docs/production-hardening/production-hardening-tdd-plan-v2.md` from the
  supplied review packet/diff;
- `tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts`, especially the
  two-row second-callback failure/cold-reopen RED added by `488a22a6`;
- `.logs/d110c-0c1f5b0u-second-delivery-red-488a22a6/` and its validated
  self-excluding manifest;
- `examples/v3-room/src/index.ts` at `CreateV3RoomSessionInput`, `commit`,
  `startupReplay`, successor reopen, v3-chat/grid and internal migration
  callback consumers;
- `packages/node/src/v3-live.ts` at `V3AdmittedVertexSink`, recovery delivery
  collection and `activateCreatorSuccessorLive` delivery;
- `packages/live-journal/src/types.ts` and
  `packages/issuance-store/src/types.ts` only as needed to verify whether a
  durable application-delivery acknowledgement/transaction already exists.

Established evidence that must not be reopened or relabeled:

- f5b0t/f5b0u production candidate `ea02487e`, evidence `60548549`, passed its
  focused, Chromium, build, retained-baseline and clean-isolated gates.
- AST review P1 is closed by `4521f03f`/`22e909b91`.
- Causal RED `488a22a6`/`692b4add` has exactly two intended soft failures:
  after callback 2 rejects, one external callback effect remains; a later
  same-room cold reopen yields callback observer sequence `d1,d1,d2` rather
  than `d1,d2`. Canonical projection, durable operation accounting, authority,
  owner cleanup and transport cleanup all pass.
- No current private store/API atomically couples an arbitrary external
  callback effect to a durable delivery receipt. A pre-callback receipt risks
  omission; a post-callback receipt risks duplication.

Review the selected narrow contract, not the already-closed implementation:

1. Is it correct and honest to define deterministic canonical projection as
   the authoritative exact-once application state, while defining
   `onAcceptedVertex` as a replayable authenticated notification attempt whose
   persistent consumers must idempotently key effects on the existing vertex
   digest?
2. Does this preserve fail-closed behavior when the callback throws, recovery
   before public issue, authenticated ordering, state/operation exactness and
   owner cleanup without pretending to provide transactional external effects?
3. Do any current production consumers in the named source require durable
   exactly-once callback effects, contradicting the selected contract?
4. Are the rejected alternatives and the stop boundary correct? In
   particular, if durable exactly-once external effects are required, must the
   work reslice into an application-owned atomic effect/idempotency port with
   explicit API/schema/restart/prune ownership rather than a local receipt?
5. Are the tests-only GREEN criteria causal and sufficient, including the
   retained hard exact-once checks for canonical projection/state and the
   explicit replayable `d1,d1,d2` callback observation?
6. Does any P0/P1 flaw make this contract unsafe for parent f5b? P2 findings
   must be concrete and include an owner/disposition; prose preference alone
   is not blocking.

Constraints: no production behavior change, no callback shape/return/order
change, no schema, wire/protobuf, authority, checkpoint, ACL, cryptography,
dependency, threshold, timeout or workload change in f5b0v. Preserve all
immutable evidence. Parent f5b remains blocked until this contract and the
final combined review close.

Return exactly one JSON object, with no prose before or after it:

```json
{
  "verdict": "PASS or CHANGES_REQUIRED",
  "p0_count": 0,
  "p1_count": 0,
  "p2_count": 0,
  "findings": [
    {
      "severity": "P0 or P1 or P2",
      "title": "short title",
      "evidence": "exact file/line or causal fact",
      "impact": "concrete impact",
      "required_action": "smallest required correction and owner"
    }
  ],
  "contract_assessment": "concise assessment",
  "consumer_assessment": "concise assessment",
  "red_green_assessment": "concise assessment",
  "parent_f5b_ready_after_green": true
}
```

`PASS` requires zero P0 and zero P1. Set `parent_f5b_ready_after_green` false
if a P0/P1 remains or a transactional-port reslice is required.
