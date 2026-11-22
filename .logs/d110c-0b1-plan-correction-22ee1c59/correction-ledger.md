# D.110c-0b1 plan-review correction ledger

- Reviewed commit: `22ee1c59b3163e4f5b23c5cb299570cdeda08a03`
- Reviewed tree: `dbe24f09507aa59c4f6e9d46829ad53f3500aaf9`
- Review root: `.logs/d110c-0b1-plan-review-22ee1c59/`
- Scope: plan correction only; no RED, production/test edit, D.110a invocation, campaign, Fable, or collaboration subagent.

## First review

- Grok 4.6/high session `01a0639a-57a5-7c41-b048-bbbe265cc1df`: normal `end_turn`; strict runner `NO_VERDICT` because inspection prose preceded the terminal JSON; embedded terminal `CHANGES_REQUIRED`, P0=0/P1=1/P2=3.
- Direct Kimi K3 session `session_427fa052-3c94-4fda-9d8f-784e03bc7c53` with `KIMI_LOOP_MAX_STEPS_PER_TURN=100`: `APPROVED`, P0=0/P1=0/P2=2.
- Opus xhigh session `f6bb7cfd-ac15-491d-9da1-91e819a6f608`: normal completion, zero subagents, `CHANGES_REQUIRED`, P0=0/P1=2/P2=3.
- Prompt SHA-256: `cc60165ab248ef116b700004c88ef22136dfec3d34728459ba8baaa6a2b1b211`.
- Grok event/public/status SHA-256: `63a497775892d995b520a1393a1df5dffeeb3fedfe05df7f8e60fd9577f0b3d9`, `468c4177732a8d10554e3836292e54e5bb296ed0f481482bf06bdd3df9c1b8e5`, `39b0369eaba277284ce20874eab7c4d58dbfdb00db2378cc84cd44bbf547a68e`.
- Kimi stream/stderr SHA-256: `645b6b8467dcf4646d3fc728ddd14ad9f0034568aef2345bac831c5982e1e344`, `dd61ac99b20dcf6091345b05451cb77c69db4c43b0ee6b5d11705be5613a0dbb`.
- Opus raw SHA-256: `2f2031592ef05ca662fb18f8dfca84e20562967319f0960d8187b0e0c9cae38f`.

## Accepted material union

1. Every epoch-N staged-pair classifier must use bounded classification, not only close staging.
2. The stale epoch-tagged predecessor ACL must retire with the stale Cut/QC pair; otherwise active closure still grows by one ref per epoch.
3. The checkpoint opener must return both genuine predecessor and current opaque trust capabilities because `v3-live.ts` authenticates both generations.

## Correction

- Names one Node-private `inspectCreatorTransitionAdvance` owner for close, hot verify, commit, and active cold reopen; 0→1 remains on the existing unbounded predicate.
- Adds exact `retiringPredecessorAclRef`, epoch laws, `RETIRING_PREDECESSOR_ACL_INVALID`, and a five-kind post-adoption closure census.
- Freezes the opener success object as `{currentTrust,ok,predecessorTrust}` and names sole-caller private `mintCreatorAnchorTrustCheckpointPredecessor`.
- Requires the new subpath to initialize `anchor-trust-singleton.js` directly and adds `custody-unavailable` to the exact failure roster.
- Adds behavioral epoch-1/2 current-opener refusal before the RED missing-seam token.
- Replaces open-ended total-byte equality with exact ref-count/kind equality plus per-kind byte/delta enumeration and fixed-schema ceilings.
- Leaves epoch>=2 pending recovery unimplemented in 0b1; D.110c-0c's first RED owns that exact branch.

## Mechanical audit

- Tracked correction diff before checkpoint: plan only, plus this ignored evidence root when force-added.
- Required contract-token counts: private minter 1; shared classifier 2; retiring ACL input 1; retiring ACL error 1; predecessor/current success fields 1 each; all three RED tokens 1 each.
- Forbidden stale phrases (`returns only the current`, shared cold/pending generalization, total byte equality): absent from the corrected 0b1 section.
- Source audit reconfirmed the per-epoch ACL insertion and the genuine predecessor capability consumer.
- `git diff --check`: pass.
- 12 GiB Prettier check of the full plan: pass.
- Protected `.agents`, `.claude`, `.pnpm-store`: present.
- Stashes: 27.
- Conflicting ts-drp review/test/profiler processes: none.
- Ports 4174, 4175, 51000, 51002: clear.

Because the success output and retirement contract changed materially, the signed/pushed correction receives exactly one confirmation. The completed first sessions are not relaunched.
