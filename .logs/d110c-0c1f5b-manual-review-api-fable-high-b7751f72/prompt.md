# D.110c-0c1f5b manual-review resolution API decision

Provide a bounded, read-only architecture recommendation at signed/pushed HEAD
`b7751f722336caf359c3a3db4abc0d9870ff9f3d`. This consultation exists because
the accepted f5b0r design's RED case 11 says a durable `manual-review` hold is
later resolved and completes the plan, while review of the current parent RED
found no demonstrated resolver. Do not edit files or propose implementation
outside a clearly named prerequisite slice.

Read:

- `.logs/d110c-0c1f5b0r-design-3a156aca/design.md`, especially plan merge,
  manual-review, case 11, and stop rules; verify its manifest and read
  `pre-review.md`.
- `examples/v3-room/src/index.ts`: `V3RoomApplication`,
  `CreateV3RoomSessionInput`, `V3RoomSession`, displacement-policy validation,
  `settlementDisposition`, `writeMergedSettlementPlan`, plan/fence/replacement
  execution, recovery, shutdown, and public session construction.
- `packages/issuance-store/src/types.ts`, `contract.ts`, and the memory/browser/
  node plan writers: plan CAS, entry immutability, atomic effects, corruption
  checks, and prune gate.
- `tests/phase-6b-d110c-0c1f5b-integration-red.test.ts` manualReviewHold and
  displacedControls, plus closed f5b0s/f5b0u store/room tests.
- Current frontier and f5b plan record in
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`.
- The Sol RED finding supplied in this prompt: current `manualReviewHold`
  proves only persistent hold; `writeMergedSettlementPlan` rejects a changed
  disposition; the public session exposes no resolver.

Independently answer:

1. Is there an existing genuine, authorized product path that lets the author
   resolve one held source after human/application review and then complete the
   plan, without direct test-store mutation, forged authority, or new API?
2. If not, should f5b:
   A. introduce a new explicit per-source public session/application API;
   B. use a narrowly specified one-way `manual-review -> final disposition`
      transition driven only by already-existing application policy on a later
      authenticated reopen; or
   C. preserve `manual-review` as an indefinite fail-closed hold and move
      resolution to a named later prerequisite, amending case 11 honestly?
3. Compare each option for Discord/MMORPG golden paths: operator UX, per-source
   decisions, restart durability, replay/idempotence, authority, ACL changes,
   same-key devices, offline recovery, bounded custody/pruning, compatibility,
   API/schema/wire impact, and risk of redisposition/double apply.
4. If a new API is justified, define only its minimum semantic boundary:
   input identity, authority, allowable transitions, CAS/idempotence, when it
   may run, error behavior, interaction with fence/replacement/prune, restart
   and multi-device semantics. State whether it must be a separately reviewed
   high-risk prerequisite before parent f5b GREEN.
5. If no API is justified, state the exact tests-only/design clarification that
   closes the contradiction without weakening fail-closed semantics.

Non-negotiable constraints: no wire/protobuf/cryptography/dependency/threshold
change; never change a linked entry; no fence while any manual-review entry
remains; no test-only direct store mutation as authority; no silent scope
expansion in parent GREEN; creator-trusted-v1 byte-identical. Return only JSON.
