# D.110c-0a final GREEN implementation review

Review the complete accepted plan -> causal RED -> GREEN history for the
security-authority slice **D.110c-0a epoch-relative creator seal custody** in
the ts-drp repository. Work read-only. Do not edit, commit, push, run a long
campaign, run D.110a, or propose unrelated redesign.

## Exact custody

- Accepted corrected plan anchor: `5388f64d`.
- Signed deterministic RED anchor: `0b7a1cf6e01f3554363c4138b14eec779c05bc33`.
- Signed/pushed GREEN anchor under review:
  `93fe946a` (`feat: close D.110c-0a epoch seal custody GREEN`).
- Plan: `docs/production-hardening/production-hardening-tdd-plan-v2.md`, section
  `D.110c-0a bounded epoch-relative seal-custody plan`.
- RED evidence: `.logs/d110c-0a-red-5388f64d/`.
- GREEN evidence: `.logs/d110c-0a-green-0b7a1cf6/`.
- GREEN ledger SHA-256:
  `5104f9ef54fee70df1733a9aae2669bce45f8e366e1aed712a7b7ea12ad378a5`.
- GREEN self-excluding manifest SHA-256:
  `c2bf2e48d907042e76da6548ab5f6a852f23b4f769c78e212f1fde4bb008d85e`.

Inspect the actual commits/diffs and evidence, not merely this summary. Verify
the GREEN commit signature/ref/custody if your tool access permits it. The
manifest intentionally excludes the plan so the plan can record the manifest
hash without a circular hash; it covers the implementation, tests, reports,
ledger, and unchanged control files.

## Frozen scope and intended closure

The RED showed two exact product gaps:

1. A genuine adopted epoch-1 creator trust returned `untrusted-context` solely
   because creator seal authority was restricted to epoch 0.
2. Existing schema-v3 browser vote/evidence owners and peer selection narrowed
   explicit epoch-1 custody to epoch 0, producing the frozen seven-item soft
   failure set.

GREEN may only generalize authenticated epoch custody across the existing
protocol seal, seal actor/pacemaker/intent, and browser vote/evidence owners.
It must preserve:

- certified/BFT authority as epoch-0-only;
- caller inability to mint/retarget authority by supplying an epoch;
- exact carrier/object/epoch/anchor/value/round/signer binding and existing
  replay/error owners;
- the unchanged canonical registry, schema-v3 layout/version, Node
  creator-close first-transition result, and lockfile;
- the public evidence selector compatibility rule: legacy two-field shape is
  exact epoch 0; explicit three-field shape is a closed data-property object
  with a safe nonnegative epoch and exact asynchronous TypeError on malformed
  shape before I/O;
- foreign epoch/anchor evidence ignored for current actor resume, but
  same-current-scope duplicates fail closed;
- no deletion/pruning, checkpoint/freshness-floor work, wire/API/dependency/
  threshold/timing/workload change, campaign, or D.110a rerun.

The accepted GREEN test must derive epoch-1 prepare/commit/finality evidence
through the real adopted successor trust and real creator actor/browser ports;
tests-only canonical carriers or raw IndexedDB rows may remain negative
discriminators but cannot be the success proof.

## Evidence to check

- Accepted focused reports each pass one selected test in one file:
  `batch1-corrected-vitest.json` and
  `batch2-genuine-actor-matrix-vitest.json`.
- Retained Vitest: 18 files, 40 suites, 148/148 passed, zero skipped/failed.
- Retained Playwright: nine configurations, 133 expected passed, two
  pre-existing skips, zero unexpected/flaky.
- Exact-owner format/lint/diff, four affected builds, protocol-v3/seal
  typechecks, and the storage-browser production build-tsconfig typecheck pass.
- The ledger honestly records the fixture/setup attempts and the unrelated
  inherited full-package typecheck debt.
- Unchanged SHA-256 controls:
  - registry `2fd6f51286e06f2c3c634c244a0242a55da186258664ec54a371f19b814a11d9`
  - schema owner `166634277bc38dd4919300e2fa3f3509d10cfe51ab3cda22fd7dc52f1c42609e`
  - Node creator-close `dc509821d77523fda5afa71c6f6eea2de9a694ac8ad59c0bb56428fed18e1c90`
  - lockfile `73c7c0660fa32c7380d0fe5a026897a7ad85a40edf1f169730c2d8e44e613a99`

## Required review questions

1. Did the signed RED fail for the intended causal reasons?
2. Does signed GREEN close those reasons through the real product path?
3. Are authority provenance, cross-epoch isolation/replay refusal, selector
   compatibility, actor resume filtering, restart, dispatch, and retained
   behavior correct and fail closed?
4. Is any source/API/wire/schema/dependency/threshold/timing/campaign scope
   widened beyond the accepted plan?
5. Do the focused/static/retained evidence and manifest support closure?
6. Is there any concrete P0/P1 defect that must block D.110c-0a closure?

Only concrete P0/P1 findings block. P2 observations should be precise and
receive a proposed disposition, but do not request recursive prose ceremony.
Do not review later D.110c-0b0/0b implementation as if it belonged to 0a.

Return one terminal JSON object and no text outside it:

```json
{
  "verdict": "APPROVE or REQUEST_CHANGES",
  "red_causality_verified": true,
  "green_closure_verified": true,
  "scope_preserved": true,
  "evidence_verified": true,
  "findings": [
    {
      "severity": "P0 or P1 or P2",
      "title": "short title",
      "owner": "exact path or evidence owner",
      "evidence": "specific code/evidence fact",
      "required_action": "minimal correction or disposition"
    }
  ],
  "blocking_union": {"p0": 0, "p1": 0},
  "summary": "concise terminal rationale"
}
```
