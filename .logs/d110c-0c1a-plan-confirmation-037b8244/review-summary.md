# D.110c-0c1a material confirmation summary

Reviewed signed/pushed correction:
`037b82442167ef27b750b2349ec66f1285780e59`, tree
`a0afed6257fb0ba75f0ace792036351fac923126`.

- Grok 4.6/high resumed exact session
  `01a0649a-9cee-7dd1-8241-41f673464078`, exited 0, and returned `APPROVED`
  with zero P0/P1 and one P2. Its terminal object retained the prior session's
  schema fields rather than the confirmation schema; the verdict and complete
  payload are preserved verbatim.
- Kimi K3 resumed exact session
  `session_3047d80e-87b6-4dfb-a756-6f1e351b13f5` with the 100-step cap, exited
  0, and returned `APPROVED` with zero P0/P1 and three P2. Its terminal object
  likewise retained the prior review schema; it is preserved verbatim.
- Opus xhigh resumed exact session
  `5091c63d-4245-41cc-b3e3-d6e6eb194674`, exited 0, and returned a
  schema-valid `APPROVED` with zero P0/P1 and four P2.

All three confirmed that the pending-liveness, cross-epoch pending,
empty/exhausted lineage, and exact-closure-law blockers are closed. The P2
union was dispositioned without another review round:

- recovery admission and offline/rebase custody use separate view policies;
- existing stage-only retiring Cut/QC/ACL filtering remains unchanged, and
  only the opened successor retirement pair is restored to the inner accepted
  proposal;
- graph-freeze/issuance serialization is asserted, with a reslice trigger if a
  permanent admitted-address hole is reachable;
- RED discharges replay membership through sealed replay verification, exact
  row equality, and an independently recomputed close-set commitment;
- refusal subclasses accompany the shared token; and
- stable and pending closures bind their matching authenticated floor heads.

The blocking union is empty. Tests-only RED is authorized; production GREEN is
not yet authorized.
