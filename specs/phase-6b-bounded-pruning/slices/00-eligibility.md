# D.109a — Closed-Epoch Cleanup Eligibility

## Question

Can one package-internal owner deterministically refuse unsafe cleanup before
any physical store is allowed to mutate?

## Seam

Add one package-internal `@ts-drp/node` cleanup-planning module. It accepts
already verified, detached facts from the existing close/adoption owners and
returns either an immutable stage plan or one closed refusal code. It exposes
no package export and performs no I/O or deletion.

The plan identifies, by exact value rather than ordering inference:

- object and closed epoch;
- verified commit-QC and adopted-head bindings;
- expected current head/revision;
- active generation and exactly the two complete rollback generations reached
  by following `baseExpectedHead` twice from that active adopted generation;
- adopted local snapshot plus the adopted CutValue’s exact
  `availabilityPolicyDigest`;
- the issuance scope and upper epoch boundary to classify; and
- exact durable identities later stages must recheck.

## RED

One tests-only owner drives the genuine Phase-6a close/adoption material into
the missing module and requires:

- a complete local-only positive control with the active generation plus both
  immediate `baseExpectedHead` rollback ancestors and all three closures;
- refusal for missing/unverified QC, non-adopted or mismatched head, fewer than
  two distinct usable rollbacks, a wrong-but-countable pair of non-ancestor
  superseded generations, either missing ancestor row or incomplete ancestor
  closure, missing local snapshot, mismatched policy, incomplete outbox
  classification, malformed/duplicate identities, and stale expected revision;
- permutation invariance of unordered facts;
- detached immutable output;
- exact refusal precedence; and
- source guards proving zero calls to delete/clear/discard and no exported API.

The RED must fail only because the package-internal planner and its exact
closed result union do not yet exist. Existing Phase-6a retained tests stay
green.

## GREEN

Implement only validation, canonical ordering, copying, and immutable planning.
Reuse existing canonical bytes/digests and Phase-6a fact owners. The only
accepted availability policy is exact equality with literal digest
`53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b`,
independently derived as `hashDomain("ts-drp/availability-policy/v3", bytes)`
over canonical bytes
`080405046d6f6465050a6c6f63616c2d6f6e6c79050e6d696e4c6f63616c436f70696573030205116d696e4d6972726f725265636569707473030005166d696e526f6c6c6261636b47656e65726174696f6e730304`.
The planner never accepts or decodes policy bytes; any other digest receives a
closed refusal and retains data for Phase 7b. Do not verify signatures again,
open a store, add schema, schedule work, or reclaim memory.

## Acceptance

- Focused RED/GREEN executes once per color with an exact test count and exact
  failure token at RED.
- Node/object/storage affected typechecks, exact-owner lint/format/diff, and
  retained Phase-6a semantic tests pass.
- The changed production path set is the one internal planner only; the tests
  and plan/evidence paths are enumerated separately.
- A source-shape check proves no delete-like operation and no package export.

## Handoff

D.109b may consume the immutable plan only after its own store-local
transaction revalidates the issuance facts. This slice authorizes no deletion.
