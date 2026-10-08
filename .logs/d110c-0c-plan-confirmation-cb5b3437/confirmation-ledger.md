# D.110c-0c plan-correction confirmation ledger

- Reviewed commit: `cb5b343765b913f557cb30d868f303eba790f83a`
- Reviewed tree: `a559c5b09cecd8c1a944589e72cdc42f17e9124e`
- Reviewed parent: `f1e021f283048e8e80771fa62347902c94a40227`
- Scope: the sole permitted material confirmation of the durable-floor correction, fresh-process RED causality, epoch-relative GREEN seam, and unchanged compatibility boundary.
- Result: all three reviewers `APPROVED`; P0=0, P1=0; blocking union empty; deterministic tests-only RED authorized.

## Grok 4.6/high

- Exact session: `01a0642c-d006-7963-871a-6f66b7bd9f39`.
- The original run completed normally but its wrapper classified the inspection prose plus valid terminal JSON as `NO_VERDICT`. That original classification is preserved honestly.
- One exact-session schema re-emission returned `APPROVED`, P0=0/P1=0/P2=1; request `6f3eaa04-5742-43cf-9ee4-d2dae05d129b`.
- Original status/public SHA-256: `2cb2a978780d2b2efd3b577d393404c682f978b5669c4e16329844a626e5cb3e`, `d6fa4a6a0f8131a64be376ddeced6ec370a1a294f101073f8e718b1434cb55a6`.
- Resume raw/stderr SHA-256: `27e5d144ae571720640a4dbf6916bdd615c747e8fe22a26b8a81b5bd459ca136`, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- P2 disposition: post-crash construction uses `initialization: {kind: "reopen"}` and forbids create/migrate. This is a RED harness precision requirement within the accepted scope.

## Kimi K3

- Exact session: `session_39586ca5-3b3c-42d3-84a4-e0acf8444bcc`.
- Environment: direct standard Kimi K3 with `KIMI_LOOP_MAX_STEPS_PER_TURN=100`.
- Result: `APPROVED`, P0=0/P1=0/P2=0.
- Stream/stderr SHA-256: `2f46d5c313d9eb563e55c59a2a8426830cc9cf4757f4ed39303325a795993778`, `613207d9c69abc0934cd0b6b8295759b6fd7ec915da1f8e546702ff91f515f8f`.

## Opus xhigh

- Exact session: `50d4644a-2a5a-4b53-921c-33b59cb18c13`.
- Result: normal completion, zero subagents, `APPROVED`, P0=0/P1=0/P2=3.
- Raw/stderr SHA-256: `f53a03c7ae557f570ad9e2a25470ecfedf741be18ee81929306bdab07d73c288`, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- P2 disposition: serialize the durable head, lineage, closure inventory, and zero recovery-CAS count so `D110C_FLOOR_RECOVERY_UNAVAILABLE` positively identifies `pending-missing` rather than a storage or age error.
- P2 disposition: select the locally rederived epoch-3 snapshot scope instead of assuming a unique verified scope.
- P2 disposition: configure and consume the durable new-AHE commit fault before process death; do not carry or reset an in-memory one-shot fault across the restart.

## Custody and constraints

- Prompt/schema SHA-256: `cbb495333be7bf76bf64692ea291eb0e9005181b0f6fcef02a2bfca36dc6acc8`, `515f771cd4008241e79e87cabaacb896c315f6183db9186f6a1038b43d2dadb0`.
- Reviewed commit signature is good (`G`) and the remote branch exactly equals the reviewed commit.
- The exact authored plan/audit diff check passes. The whole staged check reports trailing whitespace only inside immutable Grok `review.diff` and Kimi `stderr.txt` captures; those raw bytes are preserved and pinned rather than rewritten.
- No production or test file changed during confirmation. No RED, D.110a invocation, preflight, long campaign, Fable run, or collaboration subagent occurred.
- Protected `.agents`, `.claude`, and `.pnpm-store` remain present; all 27 stashes remain untouched; fixed ports 4174, 4175, 51000, and 51002 were clear.
- No ts-drp reviewer, test, or profiler was active. Unrelated processes in other workspaces were left untouched.
- The confirmation closes the plan gate. No further plan review or confirmation is authorized.
