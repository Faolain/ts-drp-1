You are one of the three required independent final implementation reviewers for ts-drp D.110c-0b0a. Work strictly read-only in the supplied clean detached checkout. Do not edit/create repository files, run tests or workloads, invoke another model/agent/subagent, use network/web/MCP, or inspect another reviewer's output.

Authenticate and review signed/pushed GREEN commit `2b3080d6562881ecd2a129dc3d896e9e9a86650d` on branch `codex/phase3a1b-p6-golden-path`, compared with causal RED commit `c1e443fc9676187c4b02dcd23459a23119de8146`, accepted plan commit `c47927f515f1182b6bc6a711e85fb696d3effe1b`, and corrected public-contract plan commit `4f893654e6456ca94384277054ac51fb2df4413d`.

Read the D.110c-0b0a plan/RED/GREEN history in `docs/production-hardening/production-hardening-tdd-plan-v2.md`, the exact HEAD diff supplied by the runner, all changed production/test paths, and `.logs/d110c-0b0a-green-c1e443fc/{green-ledger.md,manifest.sha256,focused.json,retained.json}`. Independently validate the implementation against source; do not trust prose or another reviewer.

Review these hard requirements:

1. The causal RED genuinely failed because there was no durable-complete/no-head-swap stage and no non-activating pending recovery owner; GREEN closes exactly that seam.
2. `@ts-drp/node/creator-adoption-stage` exports exactly `stageCreatorSuccessorAdoption` and `publishStagedCreatorSuccessorAdoption`; recovery exports exactly `recoverPendingCreatorSuccessorAdoption`; existing commit export roster/input/result and retained direct-call/fault semantics remain compatible.
3. Stage writes and authenticates Complete state while preserving the exact old AHE head and performs no provider I/O or activation. Its opaque capability is distinct, owner-bound, one-use, non-clonable/non-forgeable, and rejected cross-owner/cross-handle/replay/mutation.
4. Publish performs one exact old-to-new CAS and authenticates/rereads ambiguous outcomes rather than assuming success. It cannot derive freshness, call a provider, or activate a successor.
5. Pending recovery receives copied exact previous/next room-head tuples from outside hostile room storage; authenticates genesis, predecessor/current successor trust, cut/QC, snapshot/manifest/catalog/projection/ACL; never derives the expected tuple from AHE/local candidate bytes; and never activates.
6. Equivalent authenticated Complete retry candidates with the same closure are harmless and deterministically select the lexicographically smallest exact encoded generation ID while old; two matching candidates with different authenticated closures fail closed as true fork; already-new equality is based on authenticated successor trust, not generation locator.
7. Missing/incomplete/foreign/malformed/wrong previous-next/ambiguous cases fail closed. No public product/provider orchestration, activation authority, protocol/wire schema, dependency, threshold, rollback/availability rule, or root package API was changed.
8. Focused 3/3 and retained 86/86 reports, exact package exports, build/type/static/lint/format/diff gates, hashes, manifest, protected paths, and 27 stashes are represented honestly. A faulty broad provider regex and wrong-cwd package probe are diagnostics, not disguised code failures. The inherited broad Node package-typecheck debt is not incorrectly called green.
9. Test quality is causal and adversarial: it must exercise genuine stored Complete generations, exact head-swap counts, ambiguous commit-then-throw reread, both old/new recovery orderings, equivalent retries, true fork, and non-activation—not satisfy acceptance through tests-only fabricated authority.
10. Determine whether any implementation bug, public-contract mismatch, capability leak, authentication omission, retained semantic regression, evidence inconsistency, or silent scope expansion is P0/P1. Only P0/P1 blocks closure; P2 gets a concise owner/disposition and does not trigger recursive prose review.

Return exactly one terminal JSON object with no markdown fence and no prose before or after it:

{
  "verdict": "PASS" | "BLOCKED",
  "summary": "concise evidence-based summary",
  "findings": [
    {
      "severity": "P0" | "P1" | "P2",
      "title": "short title",
      "evidence": "specific source/test/evidence location",
      "required_action": "minimal correction or disposition"
    }
  ],
  "counts": { "P0": 0, "P1": 0, "P2": 0 },
  "next_state": "D110C_0B0A_CLOSED" | "D110C_0B0A_GREEN_CORRECTION_REQUIRED"
}

PASS requires P0=0, P1=0, and `next_state` equal to `D110C_0B0A_CLOSED`. If inspection is incomplete, return BLOCKED with an explicit finding rather than guessing.
