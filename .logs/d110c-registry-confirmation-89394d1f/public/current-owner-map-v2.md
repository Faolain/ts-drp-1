# Current registry owner map v2 — preparation only

This map consumes the terminal findings in `.logs/d110c-registry-current-contract-design-review-8d81c8f4/sol-continuation/final.txt` and `grok/public.txt`, plus root's supplied Fable findings. No private thought stream was inspected. It supplements, and does not modify, the sealed first design/proposal. Only source inspection and this artifact write occurred; no test, checker, model, compiler, build or Git mutation ran. Separate RED/GREEN remains unreleased.

Scope is the omitted profile/reference/author/lifecycle consumers and the prior registry/seal/pacemaker/journal/anchor/budget/successor roster. These are source dependencies, not new runtime failure observations. The three consumed retained-30/40 failures and three non-passing seal readiness cases keep their original meaning and evidence.

## 1. Acyclic ownership recommendation

Use the prospective reviewed **root base policy** as the only current transition authority. Its protected inventory authenticates current checker/validator sources, current registry/schema, active workflow sources, RED evidence, subordinate policy bytes and semantic payloads. Child policies may retain local integrity pins, but they neither authorize the root nor set its current inventory. Compare root policy bytes to the independent base rather than putting the root policy's own digest in its content manifest.

The dependency direction must be:

```text
independently selected signed base
  -> base root checker + base root policy
       -> current-root inventory / sources / workflows
       -> child integrity policies
            -> child checker / test / fixture / profile / vectors / documentation
```

No child that is hashed by the root may embed a hash of the **current** root policy or a current state digest containing itself. In particular, do not update either old `frozenTuple.freezePolicySha256` to the new root hash: that creates a cryptographic fixed-point requirement when the root protects the child. No child-root-child execution recursion either. Current root status comes from the unique merge-base checker, not a child reading and trusting candidate root policy.

Preserve the old `frozenTuple` payloads as **historical provenance**, with their original checkpoint, 47-path count and hashes. Stop dereferencing those historical paths/hashes against live root bytes. Current tests instead verify (a) the preserved historical record's identity and (b) current ownership through the independent root contract. A path string inside preserved historical provenance is not an active current-policy dependency. This is neither a second registry nor a historical-tree projection.

This distinction is required to avoid runtime broadening: `packages/protocol-v3/src/index.ts:2300–2359` imports and validates the blueprint profile's existing `frozenTuple` five-key shape and specifically requires `protectedPathCount === 47` at `:2352`. Preserve that production source and `packages/protocol-v3/supplements/blueprint-artifact-profile-v1/profile.json:54–60`; do not remove the tuple, change its count or add a new runtime metadata shape. Root has confirmed this preservation direction.

Current source-bearing semantic validation must be hash-bound to the same base-controlled file map; a stale-hash refusal is not proof a schema/routing mutant reached semantic validation. Root must freeze the exact source-reader/snapshot seam and current manifest before RED, as Sol requested. No new public/runtime API is implied by this map.

## 2. Active invocation map

All paths below are literal. Status identities, subsystem commands and v2 behavior remain; replacing current authority does not authorize dropping a subsystem.

| Active workflow | Existing invocation and exact coupled owners | Current disposition |
| --- | --- | --- |
| `.github/workflows/protocol-v3-registry.yml:35–54` | Base/candidate bootstrap dispatch to `packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs`; policy `packages/protocol-v3/conformance/freeze-policy-v3.json`. | Sole prospective current root; unique merge-base, base checker only, explicit root, no missing/obsolete-base fallback. Keep v2 step `:36–38`. |
| `.github/workflows/protocol-v3-seal-digest-identity.yml:40–58` | Base supplement, absent-base candidate bootstrap, then candidate checker. `packages/protocol-v3/supplements/seal-digest-identity-v1/check-freeze.mjs` / `freeze-policy.json`. | Root-governed transition; supplement semantics/integrity remain. Replace current tuple/bootstrap predicates, not seal laws. |
| `.github/workflows/protocol-v3-pacemaker-profile.yml:46–64` | Same base/bootstrap/candidate pattern for `packages/protocol-v3/supplements/pacemaker-profile-v1/check-freeze.mjs` / `freeze-policy.json`. | Same prospective rule as seal. Keep conditional formal gate `:65–74`, including its no-success-without-model wording. |
| `.github/workflows/protocol-v3-ed25519-profile.yml:25–44` | Live `packages/protocol-v3/scripts/check-ed25519-profile-freeze.mjs`, base extraction and absent-base candidate bootstrap. | Current checker/workflow and policy reconciliation required; old tuple becomes provenance-only, never a live-root hash gate. Strict Ed25519 semantics stay. |
| `.github/workflows/protocol-v3-blueprint-artifact-profile.yml:25–55` | Live `packages/protocol-v3/scripts/check-blueprint-artifact-profile-freeze.mjs`, base extraction, candidate bootstrap and final candidate call. | Same one-root rule; preserve runtime profile bytes and artifact/runtime rules. |
| `.github/workflows/protocol-v3-author-authorization.yml:27–31` | Candidate author checker with PR-base/push-before at `:27`; focused suites `:29`; candidate root checker with **no base/root bind** `:30`; v2 `:31`. | `:30` is not already compliant. Root route must use the unique merge-base checker with explicit base/root. Reconcile author checker/policy/analyzer and bootstrap test below. Preserve PR and push event semantics explicitly; do not silently choose HEAD as a push transition base. |
| `.github/workflows/protocol-v3-blueprint-operation-budget.yml:30–45` | Base successor plus candidate successor at `:38–42`; successor suite `:45`; controlled/live operation suite `:50–52`. | Retire successor as current authority; keep operation suite and its control/live distinction. No current invocation of old operation-budget checker is present here. |
| `.github/workflows/protocol-v3-blueprint-work-budget.yml:30–48` | Base/candidate successor `:38–42`; controlled/live work suite `:46–48`. | Retire successor as current authority; keep work suite. No current invocation of old work-budget checker is present here. |
| `.github/workflows/protocol-v3-equivocation-author-projection.yml:31–56` | Digest/evidence checkers `:33–34`; base/candidate successor `:39–43`; controlled/live author-projection suite `:47–49`; public/built type audits and export contract `:54–56`. | Replace successor route only; retain all listed subsystem checks. |
| `.github/workflows/protocol-v3-equivocation-gossip-budget.yml:31–56` | Digest/evidence checkers `:33–34`; base/candidate successor; controlled/live gossip suite `:47–49`; public/built/export audits `:54–56`. | Replace successor route only; current gossip routing analyzer must change with it. |
| `.github/workflows/protocol-v3-equivocation-acl-reputation.yml:29–51` | Digest/evidence checkers `:31–32`; base/candidate successor `:37–41`; controlled/live ACL suite `:44–45`; public/built/export audits `:49–51`. | Replace successor route only; retain pair-unit/no-ACL-authority semantics and audits. |

The digest/evidence subsystem checker paths retained above are `packages/protocol-v3/supplements/equivocation-digest-identity-v1/check-freeze.mjs` and `packages/protocol-v3/supplements/equivocation-evidence-projection-v1/check-freeze.mjs`; their own policies, profiles, schemas/specifications and vectors do not become alternate registry authorities. Their dedicated workflows are not a license to drop the direct calls above.

Ordinary root test execution is also an active consumer: `.github/workflows/test.yml:30` runs `pnpm test`; `vite.config.mts:118–126` selects the current root suite with eight exclusions. Current conformance suites are not historical-only merely because their titles describe old phases.

## 3. Newly omitted profile dependency chains

### Ed25519

`packages/protocol-v3/scripts/check-ed25519-profile-freeze.mjs:38–43` embeds the old root tuple. `validateFrozenTuple` at `:159–176` hashes live root-policy bytes, then hashes the root-policy path-state rows; this is the active reverse edge to remove. Its workflow parser at `:180–197` and CLI bootstrap at `:384–421` are current acceptance owners. Its protected eight-artifact roster is `:26–35`.

Tuple copies / integrity dependencies are:

- `packages/protocol-v3/conformance/freeze-policy-ed25519-profile-v1.json:4–9` (tuple), `:11–19` (roster), `:21–29` (checker/artifact pins).
- `docs/protocol/ed25519-acceptance-profile-v3.json:26` (historical tuple); checker `:276–280` verifies its addendum and vector hashes.
- `docs/protocol/ed25519-acceptance-profile-v3.md:14–22` (historical checkpoint/root-policy description). Preserve original historical claims or explicitly qualify prospective ownership, never restamp them as a new review.
- `packages/protocol-v3/supplements/ed25519-acceptance-profile-v1/vectors.json:6–14` (historical tuple and fixture hash). Preserve actual live/independent signature vectors, strict `zip215:false`, raw registered digest, small-order rejection and mixed-order acceptance.
- `tests/fixtures/phase-0g2s/ed25519-acceptance-profile-contract.json:3–16` (paths/tuple), `:129` onward (protected roster); its payload contains the permanent signature cases. Preserve payload and historical tuple identity; if any current fixture metadata is changed, vector fixture hash and amendment vector hash are downstream dependencies, not independent review evidence.
- Checker also hardcodes fixture and RED-source digests at `:78–79`, verifies them at `:244–249`, and binds vector fixture identity at `:292–293`. Editing the RED test without reconciling this integrity owner cannot succeed.

Literal current test owners in `tests/protocol-v3-ed25519-acceptance-profile-0g2s.test.ts`:

| Line/title | Required disposition |
| --- | --- |
| `:157` — `authenticates every protected Phase -1-prime path before evaluating the additive supplement` | Replace live old root-state calculation in helper `:127–136`; retitle as current root ownership plus preserved historical provenance. |
| `:165` — `binds a normative and machine-readable profile to the untouched frozen tuple` | Keep historical tuple comparisons and crypto rules, distinguish them from current authorization; preserve amendment/vector/fixture hashes `:193–228` under the selected integrity owner. |
| `:418` — `freezes supplement, vectors, policy, and checker while allowing unrelated additive work` | Existing pure `evaluateEd25519ProfileFreeze` import at `:424–438` is real. Retain semantic scope/drift controls; current transition authority comes from the root, not a candidate-made exact map. |
| `:456` — `keeps scratch overrides unset in ordinary production and CI` | Retain unchanged. |

Do not alter the crypto cases `:235`, `:254`, `:271`, `:301`, `:324`, `:375` to accommodate governance. There is no separate JSON Schema file in this eight-owner profile; the checker owns its machine-record shape validation.

### Blueprint artifact/runtime profile

`packages/protocol-v3/scripts/check-blueprint-artifact-profile-freeze.mjs:43–48` embeds the same old tuple. `validateFrozenTuple` at `:136–155` is its live-root reverse edge. `:158–175` validates old workflow dispatch; `:338–377` has bootstrap authority. The eleven-artifact roster at `:29–41` includes both docs, runtime profile, policy, checker, workflow, RED test, contract, actual chat artifact and its two type-audit files.

Exact dependencies: `packages/protocol-v3/conformance/freeze-policy-blueprint-artifact-profile-v1.json:4–9,11–35`; `docs/protocol/blueprint-artifact-profile-v3.json:54` (tuple) and addendum/profile hashes checked at checker `:245–253`; `docs/protocol/blueprint-artifact-profile-v3.md:50–54`; `packages/protocol-v3/supplements/blueprint-artifact-profile-v1/profile.json:54–60` (preserve for runtime); `tests/fixtures/phase-0j-b-v3/blueprint-runtime-contract.json:56–83` (roster, tuple, and immutable hash map).

That last map pins **root policy/root checker plus Ed25519 policy/checker/vectors/RED source** (`:77–82`), so Ed25519 reconciliation affects this test even when blueprint runtime semantics do not change. Checker `:56–61` additionally pins the RED test/contract/chat artifact/type-audit source/config; policy pins every non-policy artifact at `:266–278`. Preserve `tests/fixtures/phase-0j-b-v3/chat-blueprint.mjs`, `public-entry-type-audit.ts` and `tsconfig.public-entry-audit.json` as unchanged semantic/type inputs, not new repair owners.

Literal tests in `tests/protocol-v3-blueprint-runtime-0j-b.test.ts`:

- `:643` — `requires a closed additive supplement without modifying either existing frozen surface`: remove the conflation between `governance.immutableArtifactSha256` / live root state (`:669–691`) and historical provenance. Its Ed25519 integrity walk at `:694–705` is an active downstream edge.
- `:711` — `binds profile, policy, documentation, workflow, and hashes as one exact additive closure`: preserve domain/runtime/allowlist and historical profile identity, retarget only current ownership and old runner requirements `:781–789`.
- `:798` — `provides a pure exact-map evaluator and a current-tree CLI that fail closed`: retains the real `evaluateBlueprintArtifactProfileFreeze` seam and invokes the real checker at `:826`; update explicit base expectations for the prospective rule, never substitute an import/CLI-shape failure.

All runtime preparation/opaque capability/artifact-byte/import-denial cases remain. Production `index.ts:2300–2359` is read-only evidence, **not** a change target.

## 4. Author-authorization, seal and pacemaker readiness

Author authorization has more than a workflow string dependency. `packages/protocol-v3/supplements/author-authorization-v1/check-freeze.mjs:29–38` protects six supplement files plus the workflow; `:92–96` pins checker/workflow bytes, `:149–162` validates workflow fragments. `freeze-policy.json:6–21` is its exact policy counterpart. Preserve `profile.json`, `schema.json`, `spec.md`, `vectors.json` and the author-carrier rules in checker `:97–148`; current root authority does not modify those rules.

`tests/fixtures/phase-3a1b-p6/author-authorization-governance-analyzer.ts:51–84` (`auditAuthorizationWorkflow`) only detects root invocation by substring at `:75`; it needs current route/root/base/fail-closed mutation coverage. Its `auditAuthorizationFreezePolicy` at `:87–100` owns the seven-artifact integrity shape. The caller `tests/protocol-v3-current-epoch-author-authorization-p6-red.test.ts:267` is literally `self-tests parsed manifest, workflow and freeze-policy governance analyzers`.

There is also an active bootstrap-positive case at `:295`, `executes the bootstrap-atomic checker against complete, partial and drifted histories`, which requires absent-base success at `:296–297`. Its actual owner is `tests/fixtures/phase-3a1b-p6/author-authorization-freeze-harness.ts:55–85`; candidate checker execution is `:43–48`. Retitle/reconcile this current transition predicate to reject absent/partial/obsolete base and preserve known-good current-base/drift controls. Do not silently leave it as alternate bootstrap authorization. The source stub at harness `:34–40` is not a production authority oracle.

Seal and pacemaker each protect the same-shaped nine-artifact closure: local `check-freeze.mjs`, `freeze-policy.json`, `profile.json`, `schema.json`, `spec.md`, `vectors.json`, workflow, RED test and RED contract (each local `freeze-policy.json:6–25`). These are the policy/schema/profile/vector/analyzer owners to move coherently, not just one test hash. Their test-local `auditWorkflow`, semantic-law parser and controlled repository helpers are active analyzer dependencies.

| Test file and literal cases | Exact predicate to supersede; preserved obligation |
| --- | --- |
| `tests/phase-5a-seal-digest-law-red.test.ts:398` — `keeps the frozen v3 tuple byte-identical and proves the identities independently`; `:532` — `has the complete checker-authenticated seven-file PH-P5-D01 owner` | Consumed causal failures. Contract `tests/fixtures/phase-5-v3/seal-digest-law-contract.json:29`; checker stale pin `:62` / validation `:244–250`. Keep cut-value domain/round independence, proposal hash distinction, vote/QC valueDigest binding and all semantic negatives `:406–529`. |
| Same seal file `:538` — `binds the exact profile, vectors, and normative law`; `:548` — `pins its closed schema, protected owners, checker, and bootstrap workflow`; `:626` — `passes the real supplement checker` | Three consumed **non-passing** readiness-blocked cases at skip gate `:537`. Require execution after repair. Absent-base success `:583–585` becomes rejection; retitle bootstrap case. Keep protected-owner, policy/coedit, schema and no-op-checker negatives. |
| `tests/phase-5d-pacemaker-law-red.test.ts:760` — `keeps the inherited v3 tuple byte-identical and proves the composition law independently`; `:897` — `has the complete checker-authenticated seven-file PH-P5-D02 owner` | Contract `tests/fixtures/phase-5d-v3/pacemaker-law-contract.json:33`; checker `packages/protocol-v3/supplements/pacemaker-profile-v1/check-freeze.mjs:271–274`. Replace live old tuple, preserve composition law. No fresh failure count claimed. |
| Same pacemaker file `:903` — `binds the exact profile, vectors, normative decision, and workflow`; `:912` — `pins the closed schema, protected owners, checker, and single-use bootstrap`; `:979` — `passes the real supplement checker` | Readiness `:564–581` and skip gate `:902` must not hide acceptance. Absent-base success `:941–943` becomes rejection, bootstrap title/mutant identifiers `:966–976` get explicit current meaning. Require all cases execute, just as seal. Preserve formal gate `protocol-v3-pacemaker-profile.yml:65–74`. |

## 5. Historical conformance assertions that are still live consumers

Do not rewrite original references, their provenance/locks, old vector provenance or formal sign-offs to claim a new review. Do not skip c2/d/d2/b2b or silently remove their semantic controls. Move only **current-byte ownership** to the current root contract, and preserve historical assertions against their historical evidence meaning. No synthetic historical tree or second registry is needed.

| Active file / literal title | Live-hash / schema dependency; precise supersession |
| --- | --- |
| `tests/protocol-v3-registry-spec-n1prime-b.test.ts:1580` — `enforces the registry/model/schema/spec bijection and v2-v3 separation over the future artifacts` | Reads live registry/schema `:1582–1583`; schema bijection `:1605`; historical sign-off hashes `:1612`. Current schema property addition must match registry declaration order and keep seven required names (`:472–499`). Keep type/constraint/domain/wire/model semantic negatives; split historical sign-off identity from current reviewed schema identity. Fixture: `tests/fixtures/phase-n1prime-b/registry-spec-contract.json`. |
| `tests/protocol-v3-codec-grammar-decision-n1prime-b2b.test.ts:503` — `pins accepted a/b/b2a tuples, the blocked c RED, and frozen v2 core artifacts byte-for-byte` | `contract.protectedArtifacts` loop `:504–505` includes current schema and the now-retargeted b test. Contract `tests/fixtures/phase-n1prime-b2b/codec-grammar-decision-contract.json:94–114`. Preserve a/b2a/blocked-c/v2 historic evidence; no old current schema/test hash demand. |
| Same b2b file `:512` — `requires the exact codec-grammar decision triple and outward sign-off refresh` | `actualReviewedHashes()` hashes current files at `:169–170`; `validateD07Tuple` compares historical sign-off at `:295–315`. Contract `:69–85` names current registry/schema paths and old schema hash. Preserve D07 grammar/framing/endianness law and its coherent/mutant control at `:398`; explicitly retire the requirement that old sign-off outward hashes certify current registry/schema. |
| `tests/protocol-v3-independent-reference-vectors-n1prime-c2.test.ts:1178` — `pins the accepted seven-decision tuple, grammar and preserved historical RED pair` | `acceptedInputs` live hashes at `:1187–1195`; fixture `tests/fixtures/phase-n1prime-c2/independent-reference-vector-contract.json:25–44` pins old registry/schema and historical sign-off. Do not repin that provenance to pretend the original author reviewed current inputs. Retitle the current ownership component. |
| Same c2 file `:1570` — `requires an independently fixed reference and separately minted registry-built vectors to reproduce the oracle` | Reads live registry at `:1580`, checks original/vector provenance at `:1587–1596`, then evaluates vectors `:1603–1605`. Preserve seven-field absent corpus semantics, grammar/opaque-v2 controls `:1216`, context/exhaustion/crypto/anti-copy controls `:1285`, and provenance firewall controls `:1494`. Do not claim old reference/vector provenance covers present4; only the new independent current oracle does. |
| `tests/protocol-v3-regenerated-reference-n1prime-d.test.ts:497` — `proves the neutral comparator is satisfiable and kills semantic, framing, state, metadata and chronology mutants` | Live `acceptedInputs` hash loop `:571–574`; fixture `tests/fixtures/phase-n1prime-d/regenerated-reference-contract.json:184–238` binds old registry/schema and original/vector inputs. Preserve neutral comparator/metadata/chronology rules and second case `:718`, `fails narrowly until the regenerated source and provenance are fixed`; historical metadata identity is not current schema identity. |
| `tests/protocol-v3-regenerated-reference-remediation-n1prime-d2.test.ts:595` — `derives a GREEN-satisfiable semantic comparator and kills blocker-preserving mutants` | `immutableArtifacts` hashes live files at `:602–604`; fixture `tests/fixtures/phase-n1prime-d2/blocker-remediation-inputs.json:12–27` pins old registry **and d test/fixture**, so changing d propagates here. Retire only that live historical-hash conflation; keep semantic probes and `:719`, `requires the frozen regenerated peer to satisfy the independently derived remediation`. |

Original references remain seven-field implementations (`original-reference/reference.mjs:70–78,963–971`; `regenerated-reference/reference.mjs:39–50,599–606`). Their old registry/schema hashes in `conformance/reference.lock.json`, `reference-regen.lock.json`, both `provenance.json` files, `conformance/vectors/registry-v1.json` and `formal/registry-model-signoff.json` remain historical provenance, not mutation targets or live-current acceptance gates.

## 6. Lifecycle, old governance and successor routing

`vite.config.mts:118–126` now contains eight exclusions, including `**/.logs/**` at `:120`. The old root checker `check-protocol-v3-freeze.mjs:37–46` permits seven (six infrastructure plus historical-c), and `tests/fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json:5–13` records those old six-plus-one. The current root lifecycle contract must preserve the actual eight, not remove `.logs` or broaden to exclude governance suites. Keep workspace projects, ordinary `pnpm test`, and CODEOWNERS protection/shadow-file rejection (`check-protocol-v3-freeze.mjs:575–590`). Current affected tests remain selected in lifecycle fixture `:44–56`, including b2b/c2/d/d2.

Exact legacy live predicates needing explicit current replacement:

- `tests/protocol-v3-freeze-governance-n1prime-e.test.ts:999`: `closes the live v3 tuple with base-pinned, single-use governance rather than passing on absence`; preserve coherent/mutation/v2 controls at `:991`.
- `tests/protocol-v3-freeze-governance-n1prime-e2.test.ts:315`: `requires the live checker itself to reject both weakened bootstrap policies and their later byte drift`; its `:304` controlled baseline must no longer be mistaken for current bootstrap permission.
- `tests/protocol-v3-freeze-governance-n1prime-e3.test.ts:470`: `retains unchanged post-freeze and evidence-drift controls`; `:518`: `exposes only the live one-shot, content-prelanding, over-freeze, and evidence-closure gaps`. Replace current old-bootstrap expectations, retain exclusion/evidence/drift rejection.
- `tests/protocol-v3-freeze-governance-n1prime-e4.test.ts:366`: `proves the existing six exclusions, root workspace project, and ordinary CI command are satisfiable`; `:378`: `freezes the exact future lifecycle and governance boundary against every required mutant`; `:423`: `exposes only historical-c collection and the bounded lifecycle-governance omissions`. Retitle current lifecycle to eight exclusions and retain no-extra-test-exclusion negatives. Common fixture dependencies: `tests/fixtures/phase-n1prime-e/freeze-governance-contract.json`, plus the e4 lifecycle contract above. Preserve signed historical copies.
- `tests/protocol-v3-freeze-successor-v1-red.test.ts:621`: `fails RED only at the current provenance-owner readiness gate`; `:673`: `accepts a candidate-opaque passthrough root-child preload`; `:681`: `proves both current root closures through the successor boundary`; `:698`: `rejects the fixed ordinary Class B provenance subset with the genuine checker`. These live current-tree obligations cannot continue to run through the retired successor. Also map current workflow/blob assertions `:599–613`. Historical controlled topology evidence is not current root authority.

The successor owners `packages/protocol-v3/conformance/freeze-successor-v1/{check-freeze.mjs,freeze-policy.json,profile.json,spec.md}` and `tests/fixtures/phase-3a1b-freeze-successor-v1/successor-contract.json`, `successor-contract-type.ts`, `successor-test-context.ts`, `temporary-repository-harness.mjs`, `controlled-freeze-successor.mjs` remain historical evidence. Do not extend their bootstrap/provenance chain. The old routing analyzer at `tests/fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/routing-analyzer.ts:9–16` hardcodes successor and old upstream-root rules; preserve its old self-test fixtures as historical controls, but remove current consumers' reliance on that rule. New current routing tests must cover equivalent formatting, root binding, absence/ambiguity, candidate fallback, disabled/comment-only invocation and missing subsystem commands against the root-defined rule.

## 7. Budget/checker distinction and remaining prior consumers

The old budget checkers are executable files but **not current-workflow transition owners** after the successor routing already present:

- `packages/protocol-v3/supplements/blueprint-work-budget-v1/check-freeze.mjs:151–167` checks old live hashes and seven fields; `:178` requires the old seven-field phrase.
- `packages/protocol-v3/conformance/blueprint-operation-budget-v1/check-freeze.mjs:145–162` does the equivalent.

Their current workflow paths invoke successor instead (section 2). The actual successor checker only executes the two root checkers at `packages/protocol-v3/conformance/freeze-successor-v1/check-freeze.mjs:268–300`; it does **not** invoke those budget checkers on the live tree. The budget checker/policy bytes are inventoried by successor policy `freeze-policy.json:17,25,80,88`. Historical executions exist in `tests/fixtures/phase-3a1b-freeze-successor-v1/temporary-repository-harness.mjs:198–213`: `runHistoricalBaselines` checks out each exact predecessor baseline before invoking its checker. Predecessor identities are in `successor-contract.json:160–215`, including author-projection/gossip/ACL as well as both budgets.

Recommendation: preserve those five old predecessor checkers/policies as historical, never reroute the new current CI through them, and do not rerun historical baseline probes as evidence for current repair. Current subsystem runtime tests remain active; current root owns their protected leaves and changed workflow/source contracts. This avoids a needless rewrite of old seven-field checkers while making their non-current status explicit.

| Current test owner / literal title | Coupled current dependency and preservation |
| --- | --- |
| `tests/protocol-v3-blueprint-work-budget-0p0.test.ts:118` — `[governance] freezes an additive schema-only v3 supplement and explicit non-enforcement boundary`; `:280` — `[protected-predecessors] preserves parameters, registries, vectors and regenerated references byte-for-byte` | Retarget successor analyzer call `:170–179`, old current seven-field phrase `:157`, hash loop `:281–282` and seven-name/count assertion `:289–298`. Fixture `tests/fixtures/phase-0p0-v3/blueprint-work-budget-contract.json:12–19` owns old pins. Preserve supplement profile/spec semantic rules and all budget/manifest/digest cases. |
| `tests/protocol-v3-blueprint-operation-budget-0p2.test.ts:383` — `[governance] freezes the exact meter/order contract and bounded CI predecessor set`; `:453` — `[protected-predecessors] preserves v3/v2 registries, vectors, references and freeze policies` | Retarget explicit successor-suite requirement `:407`, analyzer `:416`, and old-hash loop `:454–458`. Fixture `tests/fixtures/phase-0p2-v3/blueprint-operation-budget-contract.json:19–29` pins root/work policies as well as registry. Preserve exact byte meter, local/remote ordering, manifest cases and v2. |
| `tests/protocol-v3-equivocation-gossip-budget-0o-b2.test.ts:162` — `[governance] freezes a pure projection-only budget and explicit negative authority boundary` | Retarget `auditSuccessorWorkflowRouting` `:218–225` and `LEGACY_FREEZE_CHECKERS` `:11` to the current authority classification. Keep digest/evidence/subsystem commands and all pure selection/boundary semantics. |
| `tests/protocol-v3-equivocation-author-projection-0o-b1b.test.ts:356` — `[governance] freezes an additive recovery-enumerated, zero-copy and at-least-once-handoff contract` | Workflow requirements `:397–407` preserve digest/evidence checker and public export/type audits; no new author-projection authority. |
| `tests/protocol-v3-equivocation-acl-reputation-0o-b3.test.ts:69` — `[governance] freezes projection-only pair-unit reputation and no ACL authority` | Workflow checks `:101–108` and existing pair-unit/closed-boundary semantics remain; do not introduce ACL/admission authority. |
| `tests/phase-3a1b-p4-live-journal-parity-governance-red.test.ts:649` — `keeps local journal domains out of both protocol registries and freezes registry bytes` | Consumed retained-40 failure at `:660–662`; replace only current registry-byte ownership. Preserve three domain exclusions and journal accounting. |
| `tests/protocol-v3-anchor-trust-3a0.test.ts:284` — `[control-3] keeps the local trust-state domain absent from both consensus registries` | Replace old v3 hash `:287`; keep both domain exclusions, v2 hash `:288`, independently hashed/signed anchor control `:275`, sixteen-field/suite control `:291`. Not the control-plane anchor-trust-store test. |

The current optional-field schema owner remains `packages/protocol-v3/registry/registry-v1.schema.json:26–41`: add only the existing optional safe-integer property with bounds/native metadata, keep seven required fields, no const/default injection and closed objects. The signed W0 `registry-v1.json` itself is unchanged. Supported Node profile digests/default4 and live-journal's separate seven-key boundary remain production constraints, not repair targets.

## 8. Freeze handoff

The exact prospective amendment must list every selected current checker/policy/workflow/RED/analyzer above, with explicit retained-historical-only dispositions for old tuple payloads, provenance/locks/sign-off, successor and predecessor checkers. Do not update an omitted child by opportunistic repinning after RED starts. Root must freeze the source-bound semantic seam, test titles/selection and manifest together; this map supplies dependencies, not implementation authorization or acceptance. First-review FAIL findings remain preserved; no claim that a corrected plan has passed review is made here.

Root's subsequently communicated direction is a hash-bound `sources` map on the complete snapshot, retaining `evaluateProtocolV3Freeze({base,current})` as the sole callable API and existing fields as derived/bound views. This resolves the missing-content issue if both snapshots require the exact semantic-source roster, source hashes match `files`, and parsed policy/workflow/locks/lifecycle/identity cannot disagree with their source. Separate ordinary base-to-candidate custody mutants from internally consistent **invalid-base semantic** mutants; each family starts with its own proven-good baseline. Semantic mutants update source/hash/policy/derived views together and must reach the exact semantic diagnostic, not a stale-hash short circuit. Do not embed the root policy's own hash inside its content manifest. This is a design constraint only; no seam implementation is released here.
