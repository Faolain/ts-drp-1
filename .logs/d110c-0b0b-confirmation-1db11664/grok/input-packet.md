You are one of three independent confirmation reviewers for the corrected
D.110c-0b0b high-risk authority-contract design in ts-drp. Work strictly
read-only. Do not edit/create files, run tests or workloads, invoke another
model/agent, browse the web, or inspect another reviewer's output.

Authenticate and review this exact signed/pushed correction in the supplied
clean detached checkout:

- correction commit: 1db116646c764065084b6eb57a1949d369d14055
- correction tree: e1eb953668bcba47c9bdceb46a84279893c2960f
- parent plan checkpoint: 2291725250ff60ae5784ef53acf761e494f57409
- primary file: docs/production-hardening/production-hardening-tdd-plan-v2.md
- exact section: D.110c-0b0b epoch-N checkpoint-opener and bounded-advance
  contract prerequisite

The first review is immutable evidence in
`.logs/d110c-0b0b-design-review-22917252/`. Grok's terminal result had
P0=0/P1=0/P2=1; Kimi had P0=0/P1=0/P2=0; Opus had P0=0/P1=1/P2=3. Confirm only
that the one correction batch closes that union without widening scope. Do not
reopen accepted D.110c-0b0/0b0a, D.110a, the comparative audit, or unrelated
plan prose.

The blocking defect was that the original opener required an epoch-0
`genesisTrust` capability even though the active-plus-two-Superseded retention
window could reclaim the epoch-0 generation/blob. The correction now freezes:

1. `openCreatorCheckpointTrust` receives the already existing caller-held
   genesis invite shape: pinned genesis digest, expected object ID, exact
   canonical genesis-anchor preimage, and detached genesis signature. Node maps
   the existing `CreatorSuccessorReopenInput` anchor/signature fields to this
   fixed genesis meaning for repeated reopen, so no product-input field is
   added.
2. The opener hashes and structurally verifies the epoch-0 genesis preimage
   against the pin; derives a creator public key only from current-record
   profile/signer-set carriers whose hashes equal the pinned genesis anchor's
   fields; verifies the genesis signature; requires both predecessor/current
   records to match genesis objectId and genesisAnchorDigest and to carry
   byte-identical profile/signer-set bytes; verifies their signatures,
   adjacency, previousAnchor, current CutValue/QC, successor derivation, and
   caller-copied latest floor before minting only current trust.
3. Active closure contains exactly one current trust record and one current
   transition Cut/QC pair. The fixed caller-held genesis invite carrier is one
   separately counted O(1) bootstrap-control item, never a closure trust-state
   member. Phase 7 separately owns delivery to a brand-new client.
4. Under an explicit two-head-advances-per-transition invariant, active epoch-N
   successor-live points to the newer epoch-N adoption Superseded generation,
   which points to the older/floor epoch-(N-1) live Superseded generation that
   holds predecessor trust. Any additional head advance forces 0b1 to stop and
   reslice the rollback window before reclamation.
5. `retiringProofRefs` must derive from the decoded, authenticated prior
   CutValue and commit-QC candidates in the current closure. Caller-declared
   refs alone are not retirement authority; wrong kind/epoch/currentness and
   every set-algebra mismatch fail closed.
6. The earlier umbrella sketch is reconciled to the one-trust closure law. The
   correction adds no record/wire field, dependency, crypto/setup, authority,
   threshold, provider operation, migration format, product-input field, or
   production source.

Inspect the exact diff and relevant local sources. Confirm especially:

- The existing `CreatorSuccessorReopenInput` really has the named digest,
  object scope through snapshot declaration, preimage, and signature fields;
  preserving their shape while freezing genesis semantics is coherent with
  first-transition compatibility.
- A pinned genesis preimage plus carrier hashes and signature securely binds
  the fixed creator key without an epoch-0 trust capability or attacker-chosen
  self-signature.
- The active + two-Superseded mapping is correct for the current
  current/proposed/active lineage and does not evict the predecessor under the
  explicitly frozen composition.
- The retirement derivation is executable from closure candidates and cannot
  delete arbitrary refs.
- The corrected design remains O(1), fail closed, causal, and compatible; its
  D.110c-0b1 RED/GREEN and D.110c-c/d census can enforce every stated
  obligation.

Only P0/P1 blocks. P2 must be a concrete residual issue with an explicit owner;
do not request recursive prose review. If the correction actually needs a new
product field, wire/schema change, authority, dependency, threshold, provider
operation, or migration, return a blocking finding and require a new reslice.

Return exactly one terminal JSON object with no markdown fence or prose before
or after it:

{
  "verdict": "APPROVED" | "CHANGES_REQUIRED",
  "summary": "concise evidence-based summary",
  "findings": [
    {
      "severity": "P0" | "P1" | "P2",
      "title": "short title",
      "evidence": "specific source/plan location",
      "required_action": "minimal action or disposition"
    }
  ],
  "counts": { "P0": 0, "P1": 0, "P2": 0 },
  "next_slice": "D110C_0B0B_ACCEPTED" | "D110C_0B0B_CORRECTION_REQUIRED"
}

APPROVED requires P0=0, P1=0, and next_slice=D110C_0B0B_ACCEPTED. Do not claim
a verdict if inspection is incomplete.

<runner_git_packet>
HEAD: 1db116646c764065084b6eb57a1949d369d14055
Status:
(clean)
Staged paths:
(none)
Unstaged tracked paths:
(none)
Exact HEAD commit SHA-256: c95df07cd2d561a85e725b2d9e15e869bbc14946e1fd210407ac528e9d45dfc2
Exact HEAD commit file: /Users/aristotle/Documents/Projects/ts-drp-1/.logs/d110c-0b0b-confirmation-1db11664/grok/review.diff
Use the supplied packet and read-only file tools. Do not invoke a shell or write review notes to disk. Return the requested terminal response directly.
</runner_git_packet>
