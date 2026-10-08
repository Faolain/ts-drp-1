# Historical f5b0u first-round review union

The raw Grok packet was recoverable and is retained beside this file. The
historical Sol and Fable raw response files were not retained in the worktree
when that round completed, so they are not reconstructed or presented as raw
evidence. This is the complete finding union recorded at the time:

- Grok 4.6/high: PASS, P0=0/P1=0/P2=0. The strict initial response contained
  prose and was NO_VERDICT until exact session
  `01a0705a-f6a8-7941-808d-dd2f3cba3554` resumed and emitted terminal PASS.
- Sol high P1 A: the sensitive-return source oracle could miss assignment,
  comma, logical-assignment and nested authority-return forms. Tests-only
  correction `4521f03f` and evidence `22e909b91` close it without
  production change.
- Sol high P1 B: arbitrary callback effect 1 could survive callback 2
  rejection and replay after cold reopen. Genuine RED
  `488a22a6`/`692b4add` proves `d1,d1,d2` while canonical state,
  issuance, authority and cleanup remain exact. The reviewed f5b0v replayable
  notification contract and its surface-specific correction close the
  overclaim without a receipt patch.
- Fable xhigh P2: initial settlement-progress origin required explicit owner
  evidence. The exact settlement-plan/store transition and GREEN evidence
  supply it.
- Fable xhigh P2: the first AST oracle was limited. The causal correction above
  closes it.
- Fable xhigh P2: dormant `openProgressSources` existed without causal RED.
  Parent f5b owns a genuine checkpoint-frontier RED or deletion before
  authenticated frontier threading.

No historical verdict is relabeled, and unavailable raw responses are not
invented. The current combined final confirmation independently re-reviewed
the whole signed candidate and returned an empty P0/P1 union.

