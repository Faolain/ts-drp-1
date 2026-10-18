<task>
Review signed/pushed commit f50a4637381399e579d8d7a3313576df5a42dd9b as
the single bounded plan review for the parent D.110c-0c1f5b fixture-workload
correction. This is a read-only review. Inspect the commit diff and the exact
repo sources named below. Decide whether the correction preserves the accepted
settlement design and the Discord/MMORPG golden-path obligations without
weakening a product limit or manufacturing settlement state.
</task>

<grounding>
- docs/production-hardening/production-hardening-tdd-plan-v2.md: "Current
  frontier — author settlement and writer capacity" and record
  D.110c-0c1f5b.
- .logs/d110c-0c1f5b-green-79743f98/assessment.md and
  bounds-corrected.json.
- .logs/d110c-0c1f5b0r-design-3a156aca/design.md: implementation item 6,
  deterministic RED cases 3 and 14, and acceptance/stop rules.
- tests/phase-6b-d110c-0c1f5b-integration-red.test.ts: openRoom,
  checkpoint-terminal progress, and sixtyFourWriterGoldenPath.
- packages/compaction/src/blueprint-fold.ts APPLICATION_LIMITS.
- packages/node/src/v3-live.ts APPLICATION_BATCH_LIMITS and split logic.
- tests/fixtures/phase-3f-b/frontier-reduction-fixture.ts existing
  BATCH_BOUNDARY_ARTIFACT_SOURCE pattern.
</grounding>

<facts_to_check>
The current chat transform stores every transformed byte in append-only state.
Two transformed operations must exceed the 65,536-byte batch limit to produce
case 3's required multiple chunks, but their exact state must remain under the
32,768-byte application-state ceiling; those conditions cannot both hold for
the chat reducer. The independent 64-writer/four-epoch test has 256 ordinary
messages plus six displaced transforms and measures about 210,773 bytes with
33,000-character transforms; 256-character transforms model at 14,303 bytes.
The amendment therefore keeps case 3 genuine by using a tests-only
transient-payload blueprint whose operation bytes force the real Node split
while its reducer keeps bounded exact state, and separately uses the bounded
256-character transform in the real 64-writer chat test. It preserves the real
plan, fence, issue, publication, close/adopt, crash, restart, cold-reopen,
lineage, exact-state and operation-accounting paths. It changes no production
API, source, schema, cryptography, dependency, limit, timeout or prior evidence.
</facts_to_check>

<review_questions>

1. Does this plan still make case 3 causally prove a real committed-prefix
   replacement crash and cross-close recovery, rather than a tests-only plan or
   checkpoint shortcut?
2. Are the transient-payload blueprint constraints sufficient to prove each
   operation is individually valid, the pair really exceeds the unchanged
   batch budget, action/identity stay stable, and exact application state stays
   under the unchanged state ceiling?
3. Does lowering only the independent wide chat transform to 256 preserve the
   required 64 active writers, every-writer/every-epoch contribution, three
   real transitions, offline/rejoin, restart/cold-reopen and exact accounting?
4. Is any P0/P1 correction needed before a tests-only RED agent may implement
   this plan? Do not demand an API, product threshold change, long campaign or
   reopening of immutable f5b0u evidence.
   </review_questions>

<severity>
P0 means the amendment can invalidate trust/safety or cannot produce truthful
causal evidence. P1 means a concrete material gap can make RED/GREEN pass while
missing a required settlement or golden-path obligation. P2 is useful but
nonblocking hardening/bookkeeping. Only P0/P1 blocks.
</severity>

<output_contract>
Return exactly one JSON object and no surrounding prose or markdown:
{"verdict":"PASS|BLOCK","p0_count":0,"p1_count":0,"p2_count":0,"findings":[{"severity":"P0|P1|P2","title":"...","evidence":"file:line and concrete reasoning","required_action":"..."}],"summary":"..."}
Counts must exactly match findings. PASS requires p0_count=0 and p1_count=0.
</output_contract>
