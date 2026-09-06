# REJECTED correction RED: runtime-realm collision

Tests commit `1dcff1709d040a4a37d3c73ecaef4fb2309451de` was signed and
pushed from exact signed/pushed `62f71f4dccaf66da49d4af32f6afaf60394de7ee`.
Only `tests/phase-6b-d110c-0c1f5b-integration-red.test.ts` changed. No production,
package, lock, API, wire, schema, dependency, threshold or plan edit was made.
The 27 stashes and unrelated files were preserved.

The exact focused file ran **once**, in a fresh Vitest process with deterministic
identity seeds and fresh fake IndexedDB state. It returned **2 failed, 0 passed**.
This does not match the frozen required matrix of one settlement failure and a
passing v1 control. It is rejected evidence, not accepted RED or GREEN authority.

## Actual causal failures

1. Settlement, 390.632791 ms: `F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED:
   genuine settlement successor fails CERTIFIED_VALUE_MISMATCH before checkpoint
   production`, at test line 655, first close at line 1628. This is the expected
   real production failure. All five source-attribution assertions completed:
   creator-close preparation, completion and opening; creator-checkpoint current
   record rejection and reconstructed genesis profile. No checkpoint bytes or
   authority were injected.
2. v1, 1021.4505 ms: `v3 room successor reopen failed: authority-unavailable:
   creator successor already has a conflicting active owner`, at room index.ts
   line 2362, test reopen line 598, new floor-probe call line 1728. The original
   v1 issue/close/adopt/creator-cold-reopen/issue assertions at lines 1708–1720
   completed. The added two-peer v1 probe failed on its **first noncreator
   reopen**, before its intended stale-local-head/newer-floor rejection.

No test case passed as a whole. Collection succeeded; there was no missing
import/export, setup or top-level failure. The anticipated stale-head token
`D110C_FLOOR_MISMATCH` was **not runtime-observed** by this run.

## Exact topology contradiction

`packages/node/src/creator-adoption-activate.ts:73` owns one module-global
`activeOwners` map. `activateMaterial` derives the stable object/genesis topic at
line 360 and looks up that topic at line 361. At lines 362–364, an already active
owner with different runtime bindings is refused. `sameBindings` at lines
115–121 compares the network node, message queue and admission sink identities.
The creator's successful adoption installs its topic owner; the second peer has
different bindings but executes in the **same module realm**, despite distinct
identity, database and transport names.

The probe has not reached the later floor rejection it was meant to measure.
`reopenCreatorSuccessorAdoption:501–502` separately compares recovered authority
with the independent room-head floor. This evidence does not weaken or reinterpret
that floor contract. It also demonstrates that the draft same-realm multi-peer
post-adoption/cold-reopen continuations, including the 64-writer loop, need a
bounded fixture-topology correction before they can be considered executable
acceptance for independent clients. Clearing the owner map, substituting bindings,
returning fake activation success, or mutating production ownership is not a fix.
Independent client runtime realms are a possible existing-deployment-shaped route,
but no such correction was implemented or executed here. No new product API is
justified by this result.

## Preserved clarifications and review union

The case-24 plan clarification at `62f71f4d` remains authoritative: committed
floors never regress and Superseded generations are not readopted. Draft 24a
uses only a genuine newer floor with untransferred local state; 24c checks
monotonic authority/floor/head and two retained rollback generations. Its linked
settlement-plan continuation remains unexecuted.

The parent adjudicated case 25 during authoring: the ambiguous owner must halt,
but existing private authenticated recovery may rebind and retry within the
same public call. The draft captures native row/link/lineage truth at ambiguity,
requires a different genuine active handle before subsequent issue/publication,
pins one retry at most, and retains a recovery-read-failure refusal path. This is
a design/code clarification for later review, not a new API or a passing result.

The old review union is preserved, not discharged: Sol high FAIL with two P1s
(missing parent composition cases; inadequate 64-writer product oracles), Fable
xhigh PASS with three P2s (two further profile sites, coverage caution, existing-
input settlement rebind guidance), and Grok `NO_VERDICT_TIMEOUT` before any
event/session from a 7.8 MB packet. Grok's timeout is not a finding or approval.
`inputs.json` hashes the exact retained review artifacts.

`case-map.json` describes draft source ownership, not runtime coverage. The real
settlement failure occurs before any checkpoint-derived frontier exists, so RED
does not physically enter `openProgressSources`. Downstream checks, the 64-writer
workload, positive pruning and the later >=100-transition campaign were not run.
The draft wide gate has 256 baseline application issues across epochs 0–3 plus
six selected pending/published sources and six replacements, with an eight-peer
rotating offline cohort. No long workload or campaign was executed.

After the mismatch, edits and focused runs stopped. Only bounded read-only
diagnosis and this separately signed immutable rejected evidence were produced.

