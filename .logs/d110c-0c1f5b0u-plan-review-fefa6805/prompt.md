You are one independent formal reviewer of the ts-drp D.110c-0c1f5b0u
high-risk plan checkpoint. Review commit
fefa6805e16066f55d15bb95701b3ced290553b3 only. The checkout is detached and
clean at that commit. Do not modify files, create agents, or run tests.

Primary scope:

- docs/production-hardening/production-hardening-tdd-plan-v2.md, especially
  "Current frontier — author settlement and writer capacity",
  D.110c-0c1f5b0t, new D.110c-0c1f5b0u, and parent D.110c-0c1f5b.
- The exact commit diff fefa6805^..fefa6805.
- Read only the directly relevant existing seams needed to validate feasibility:
  examples/v3-room/src/index.ts; packages/issuance-store/src/{types,contract,conformance}.ts;
  packages/storage-browser/src/internal/browser-issuance-store.ts;
  packages/storage-node/src/internal/node-issuance-store.ts;
  packages/node/src/{v3-live,creator-adoption-activate,creator-close}.ts;
  examples/v3-room/package.json; pnpm-lock.yaml; and the two f5b0t RED tests.

Review question: Is f5b0u a complete, minimal, executable TDD prerequisite for
closing the rejected f5b0t GREEN without silently widening authority, API,
schema, wire, dependency, threshold, or workload semantics? In particular,
verify:

1. The plan can recover a halted settlement-startup handle with existing
   authenticated prepare/recover/activate or successor-reopen seams and
   already-open stores; deactivation, active-owner release, room-head/genesis
   floor validation, publication, projection reconciliation, admission-policy
   reconstruction, and concurrency quiescence are sufficiently specified.
2. The scope boundary for a later hot-adopted successor is honest and leaves
   current snapshot-declaration custody to parent f5b rather than pretending
   f5b0u solves it.
3. Exact ambiguous readback is both implementable and sufficient: prior
   revision/prefix, one appended chunk, sequence, range, digest/count, and
   final scalar; distinguish exact committed outcome from compatible external
   progress without reusing an unclassified old handle.
4. Digest mismatch is rejected before any missing fence/issue/signature;
   legacy-to-progress origination is zero chunks only; logical-time parsing
   accepts only the actual closed applicationBatch grammar and cannot confuse
   ordinary application fields.
5. The direct existing workspace dependency from example-v3-room to
   issuance-store is the smallest honest ownership change and has no hidden
   external/runtime dependency or compatibility effect.
6. RED cases are causal and do not depend on future missing exports, fixture
   shortcuts, separately mocked Node/room paths, or impossible recovery
   authority. GREEN paths and retained/isolated gates cover all owners.
7. The plan preserves legacy creator-trusted-v1 behavior, prior immutable
   evidence, parent f5b's 64-active-writer three-close gate, and the later
   >=100 same-room 64-writer workload.

Classify only concrete findings:

- P0: unsafe/invalid design, lost authority/integrity, or impossible path.
- P1: material missing acceptance, executable seam, compatibility, or
  fail-closed behavior that must be corrected before RED.
- P2: nonblocking clarification or follow-up with an explicit owner.

Return exactly one JSON object and no prose before or after it:

{
  "verdict": "PASS" | "CHANGES_REQUIRED",
  "reviewed_commit": "fefa6805e16066f55d15bb95701b3ced290553b3",
  "summary": "short assessment",
  "findings": [
    {
      "severity": "P0" | "P1" | "P2",
      "title": "concise title",
      "evidence": "specific plan/code evidence",
      "remediation": "smallest exact correction"
    }
  ]
}

PASS requires zero P0/P1 findings. P2 findings may accompany PASS. Do not call
missing hostile-local tamper resistance a finding; the repository/operator is
trusted and local hashes protect against accidental drift.
