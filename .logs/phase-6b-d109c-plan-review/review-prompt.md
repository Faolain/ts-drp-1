# D.109c bounded AHE-reclamation plan review

Review signed/pushed commit `e2c18898033744eb64723ea901a906af3845b112`
independently and strictly read-only. Its parent
`2afadbe682261bdb311a5cb64f6f42d86ed7330b` is the accepted D.109b closure.
D.109a and D.109b are immutable inherited evidence; do not reopen them.

Do not edit, stage, commit, generate, format, install, build, test, or invoke
another model/reviewer. Do not inspect any other D.109c reviewer output. This is
the sole bounded plan review before deterministic tests-only RED. No campaign,
product implementation, or schema change is authorized by this review.

Inspect:

- `specs/phase-6b-bounded-pruning/README.md`;
- `specs/phase-6b-bounded-pruning/slices/00-eligibility.md`;
- `specs/phase-6b-bounded-pruning/slices/02-ahe-reclamation.md`;
- the D.109c checkpoint at the end of
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`;
- current storage, storage-node, storage-browser, D.109a planner, and creator-
  adoption sources needed to verify the asserted seams and feasibility.

Adjudicate the frozen plan against these requirements:

1. The existing `AheDurableStore` remains exactly its current 12-key facade.
   Maintenance is isolated to `./maintenance` package subpaths and exact-object-
   identity registries; roots, factory modules, copies, proxies, structural
   fakes, and cross-backend facades do not expose or mint deletion authority.
2. One shared owner captures/detaches the exact D.109a AHE subset, defines the
   closed error/receipt contract, validates canonical generation records,
   follows ancestry rather than generation-ID order, classifies the complete
   graph, and calculates remaining references. Each backend alone owns its one
   atomic physical transaction; the plan must not create duplicate lineage
   walkers or generic adapter commands.
3. The request revalidates exact head/revision, active adopted generation, the
   two immediate superseded rollback ancestors, exact oldest-retained floor,
   expected former parent, no-head replacement, and the complete older prefix.
   Empty-prefix and lost-receipt replay semantics must be safe and decidable.
4. The transaction verifies retained and selected closure/promotion/blob facts,
   globally decodes every generation and promotion across all objects before
   candidate blob deletion, preserves shared references, normalizes only the
   retained floor, checks exact delete/update counts, and verifies post-state.
   `Staged` and `Discarded` may have partial promotion sets; only `Complete`,
   `Adopted`, and `Superseded` require complete promotion sets.
5. The error partition is deterministic: malformed caller input is invalid;
   changed valid planning observations are retryable; malformed/corrupt durable
   facts or impossible partial replay poison; closed/poisoned precedence is
   exact; substrate failure cannot publish success. All backend calls reject
   asynchronously and do not expose persisted bytes.
6. Memory serialization, SQLite `BEGIN IMMEDIATE`, and one strict IndexedDB
   transaction are viable with the current owners. Node SIGKILL and Chromium
   worker termination/IDB abort at each named mutation/commit edge can prove old
   XOR complete-new without changing production configuration, dependencies,
   schemas, or runtime behavior.
7. The exact nine-path RED can be tests/fixtures/config only, controls can run
   while semantics skip solely behind the three readiness tokens, and its
   semantic/mutant/crash roster is sufficient to make RED genuinely causal.
   Identify any infeasible fixture assumption or missing causal mutant.
8. GREEN's two diagnostic batches, retained gates, source pins, evidence
   custody, and stop/reslice conditions are enough to prevent accidental scope
   growth. D.109c must not authorize runtime reclamation, D.109d, or a retained
   campaign.
9. Judge whether the plan is implementable without a schema/reverse index,
   mandatory facade change, product/runtime API, dependency, threshold,
   workload, protocol/wire/digest/QC/adoption/availability change, or cross-
   database authority. A demonstrated need for one is a blocking scope defect.

Classify only demonstrated findings. P0 is catastrophic. P1 blocks plan
acceptance or would make RED/GREEN unsafe, non-causal, or infeasible. P2 is
bounded and nonblocking. `CHANGES_REQUIRED` requires at least one P0/P1. Cite
exact files/symbols/lines and the smallest correction. Do not request recursive
review ceremony or speculative later-slice work.

End with exactly these terminal lines:

`VERDICT: APPROVED` or `VERDICT: CHANGES_REQUIRED`

`P0_P1_UNION: none` or a comma-separated finding-title list

`D109C_RED_MAY_START: yes` or `D109C_RED_MAY_START: no`
