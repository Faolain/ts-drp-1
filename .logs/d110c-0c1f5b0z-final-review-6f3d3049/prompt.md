<task>
Perform the single bounded formal GREEN review of f5b0z backend-neutral discovery
of the EXISTING AHE maintenance capability. Independently judge complete
accepted plan → signed causal RED → signed GREEN history, not just current code.
Read-only: do not edit, install, build, run tests, invoke reviewers/subagents or
perform network research. Use available file-read tools; Codex may use read-only
shell/Git for inspection. Grok/Fable have file tools only; do not request shell
or write permissions. Return findings directly, not a file.
</task>

<grounding>
Clean detached review checkout: /private/tmp/d110c-f5b0z-review-Kg6cuq/checkout
HEAD: 5e7099dfbfb56cc06de75eab6c6d616cf871a4ea, signed G and pushed.
This checkout has NO seven-file partial parent implementation; do not inspect
the main workspace's parent code as though it belongs to this slice.

Read the exact design and amendment completely:
.logs/d110c-0c1f5b0z-plan-609ee4ba/design.md
.logs/d110c-0c1f5b0z-plan-correction-7eb2a8df/amendment.md
The plan gate already completed. Do not reopen it or recursively review prose.
Original plan7eb2a8df; amendment6ac0b5be; accepted gate5c44a7dc. Prior review
findings/dispositions inform verification, not a prescribed final verdict.

RED tests: 1eba4f9065d220afb0d77d90aac4a05b250a05bb.
RED evidence: 5ab259fedeea24a102d1e3309d7282da81a3b224.
RED acceptance: b2594cc7734d4e61c1cc3bff49f6996c4bbddc77.
Read .logs/d110c-0c1f5b0z-red-1eba4f90/assessment.md, matrix.json,
result.json, validation.json, and relevant raw evidence if a claim is doubtful.
Manifest81entries SHA9e56180ab6f58e05a0b443629fbe9acc066614ca84ad56755b28643ea53864ef.
Inspect tests/phase-6b-d110c-0c1f5b0z-maintenance-discovery-red.test.ts and its
tests/fixtures/phase-6b-d110c-0c1f5b0z/native-registry-child.mjs and source-custody.json.
One isolatedRED:16tests,14exactfailures (11discovery/3registryrefusal),2controls,
0skips/toperrors. Verify causality from premises and executable continuations;
do not infer that later lifecycle assertions passed merely because RED failed.

GREEN production: 6f3d3049942c29f547f5cefdda628a3a01078077.
GREEN evidence: review HEAD above.
Read .logs/d110c-0c1f5b0z-green-b2594cc7/assessment.md, production.patch,
validation.json, suite.mjs, source-check.mjs, type-delta.mjs and targeted
reporters/native streams/isolation records as needed.
Manifest243entries SHA43de3f011b6ba54120fbff0b2e1cefba7bd7bf34a6b4d2444f0ba566a861afbd.
Root independently revalidated both exact manifest inventories/hashes, signed
refs, complete focused assertion names/statuses against RED, retained125/7files,
issuance12, Chromium4, native4, signed-source/runtime identity and parent custody.
Treat these as audit results to inspect, not a requirement to agree.

Grok's automatic HEAD diff is evidence-only and large. production.patch above
is the exact small implementation diff; use it plus the signed test source,
not an exhaustive read of the evidence-only HEAD patch. Do not read the entire
100k-line roadmap; only Current frontier and D.110c-0c1f5b0z record if needed.
</grounding>

<primary_sources>
- packages/storage/src/maintenance.ts (only type import plus new registry/API).
- packages/storage-browser/src/internal/ahe-reclamation.ts (import + registration).
- packages/storage-node/src/internal/ahe-reclamation.ts (import + registration).
- Existing facade constructors: browser src/internal/idb-adapter.ts and node
  src/internal/create-scaffold.ts; existing public backend maintenance.ts files.
- Existing issuance-store/src/maintenance.ts registry is retained precedent,
  not an owner to change. Ordinary storage types/roots/package manifests stay exact.
- Retained seven test filenames and Chromium command are in the amendment/design;
  the additional existing issuance-registry test is
  tests/phase-6b-d110c-0c1f5b0d-corrective-red.test.ts.
</primary_sources>

<acceptance_questions>
1. Does RED genuinely establish the missing neutral lookup/refusal behavior
   after real backend construction, legacy lookup and ordinary reads, rather
   than missing exports/imports or no-op mocks? Are the unchanged GREEN
   continuations sufficient and genuinely exercised by both16-pass runs?
2. Does the exact-facade WeakMap, shared versioned global descriptor, first-bind
   retention and incompatible-record refusal satisfy the design without getter
   execution or duplicate backend mutation ownership? Are duplicate registration
   and legacy backend-specific identities preserved?
3. Are existing mutation/transaction/lifecycle/error/receipt bodies, facade keys,
   API inputs, dependency/root exports and source custody preserved? Is discovery
   free of storage I/O and reclamation, including initial registration?
4. Does the signed GREEN evidence establish focused, retained, Chromium, static
   delta and fresh source-built native-import gates without hidden parent overlays,
   stale dist, test changes, skips, filters or false pass classification?
5. Identify concrete P0/P1 correctness, causal, compatibility or evidence defects.
   P2 gets an owner/disposition, not a new review-only slice or prose loop.
</acceptance_questions>

<boundaries_and_honest_debt>
The binder is trusted backend plumbing, NOT authentication against malicious
same-process JS. A compatible forged registry is outside that threat model.
Do not demand hostile-local cryptographic custody or new authority primitives.
Positive backend ownership/lifecycle tests use real browser/SQLite capabilities;
case4/14 artificial memory bindings test only the registry primitive and never
invoke a foreign capability. They do not authorize memory-backend reclamation.

Tests/helpers are byte-identical to signedRED. Initial GREEN uses a separately
installed clean b2594cc7 checkout with ONLY the recorded3-owner patch, then
source build; second uses signed6f3d3049 with no overlay and its own install/build.
Focused16pass twice; retained125; issuance12; Chromium4 without skips/flakes;
four native helper modes directly capture stdout/stderr and status.
Storage typecheck passes; clean browser74 and Node144 diagnostics exactly match
baseline. Zero target diagnostics and one unchanged external TS2322 at
tests/fixtures/phase-6b/ahe-reclamation-contract.ts:234 are disclosed, not an
overall typecheck pass. Inspect the delta, don't require unrelated repairs.

RED's JSON reporter intercepted child console lines; source-enforced native
premises and runtime identities remain, with direct raw streams captured GREEN.
No RED rerun. The initial GREEN validator mistook an omitted optional JSON field
for failure; the same stored successful reporter was revalidated, not rerun.
Raw stdout/patch whitespace has explicit evidence-only dispositions; executable
source whitespace passes. One unrelated credential-bearing process diagnostic
was privately quarantined and published sanitized BEFORE evidence was committed;
its provenance is disclosed, with test/native/build/typecheck streams unchanged.
Do not retrieve private quarantine data or request credentials.

Parent cleanup is not implemented here. Seven dirty parent files,27stashes and
86522protected paths remain preserved; no campaign, wire/schema/authority,
dependency, threshold, timing or lifecycle policy change is authorized.
This can close only f5b0z. It cannot claim64-writer/three-transition integration,
>=100-transition memory/census, Discord state safety or Phase7 cold join.
</boundaries_and_honest_debt>

<output_contract>
Return one JSON object, no Markdown fence:
{"terminal":"VERDICT: PASS or VERDICT: CHANGES_REQUIRED","verdict":"PASS or CHANGES_REQUIRED","p0_count":0,"p1_count":0,"p2_count":0,"findings":[{"severity":"P0 or P1 or P2","title":"short","evidence":"exact source/evidence seam","impact":"concrete","required_action":"smallest correction and owner"}],"red_causality":"assessment","green_closure":"assessment","compatibility":"assessment","evidence_and_static_debt":"assessment","scope_and_remaining_work":"assessment","ready_to_close_f5b0z":true}
PASS/ready_to_close_f5b0z=true requires zeroP0/P1. HonestNO_VERDICT on service
failure or inability to inspect; do not infer approval from missing findings.
</output_contract>
