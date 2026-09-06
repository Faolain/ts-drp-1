# Corrected design review disposition

The phase remains FAIL and is not released for RED/GREEN. Sol and Fable return
FAIL; Grok returns schema-valid PASS with findings. All findings below are
accepted for correction. Grok's PASS does not waive the other required reviews
or its own preservation finding. No implementation failure is claimed here.

| Finding | Root disposition and source check |
| --- | --- |
| Sol P1; Grok P2: missing successor fixtures | Confirmed: the owner map section 6 names the contract, type/context, controlled checker, repository harness and analyzer fixtures, and the successor suite imports them. Add their complete bounded historical closure and prohibit restamping its currentBlob/currentSha256 records. |
| Sol P2: role classification | Confirmed: preserved-input conflates current semantic sources and historical evidence. Separate role, preservation during this amendment, and prospective custody mode in the inventory. |
| Sol P2: RED ordering | Confirmed: selected roots include not-yet-authored RED files. Compiler baseline errors block RED acceptance/GREEN handoff, not release of the RED author to create those files. |
| Fable P1: exhaustion consumer | Confirmed at issuance-exhaustion test lines 338–339 and its paired contract's correctedC2Test pin. Add the test as an editable affected owner and gate; preserve the paired oracle and historical fixture attestation while moving the current c2-byte assertion to current custody. |
| Fable P1: byte versus semantic boundary | Confirmed ambiguity. Explicitly distinguish semantic-only lifecycle/CODEOWNERS sources from byte-protected artifact inventory. Ordinary alias/config changes must not become implicit registry amendments. Name and justify any newly byte-protected test evidence rather than relying on a generic input classification. |
| Fable P2: historical tuple records | Confirmed: walk() misses freezePolicyPath/freezePolicySha256/protectedPathStatesSha256 and scans only test JSON. Extend the historical-record census to the actual selected profile/docs/vector records, including compound historical state identity. Preserve their payloads. |
| Fable P2: unsupported ceilings | Confirmed: successor cases currently declare 600-second limits; 240 seconds for every whole file is not supported by the inspected code. Freeze differentiated limits and an explicit bounded readiness experiment after implementation, with no automatic retry or campaign-based discovery. |
| Grok P3: schema order | Confirmed registry declares multiplier first and the bijection compares key order. State insertion at that exact position, not merely addition of a property. |
| Fable P3: required-bump claim | Confirmed current transition rule rejects protected-byte changes. Future registry edits require a separately reviewed amendment; the registry's bump metadata is not an implemented in-band exception. |
| Fable P3: candidate mode source | Confirmed contract omits capture mechanics. Specify base Git-tree entries, worktree lstat entries, index/worktree disagreement rejection, and untracked-entry treatment. |
| Fable P3: compiler provenance/transient write | Accept. Distinguish decoded compiler text hashes from on-disk byte hashes. Vite config loading must explicitly account for its bounded transient bundle and before/after custody; no claim of a write-free compiler collector. |
| Fable P3: derivation reproducibility | Confirmed encoded URL pathname and one-use regeneration guard. Use fileURLToPath and a non-mutating reproducibility/verification mode that works after RED without silently changing frozen baseline evidence. |
| Fable P3: child evaluator disposition | Confirmed README and owner-map wording can diverge. The corrected current contract must explicitly retire the Ed25519/blueprint transition evaluators and move their live assertions to root; historical analyzer data is not a second current evaluator. |

These are design corrections, not new runtime authority requests. The explicit
greenfield authorization, unchanged registry and runtime profile bytes, sole
current transition owner, historical evidence preservation and no old-policy
approval claim remain fixed. The nine reviewed spec files are copied into this
public packet before any revision. A corrected confirmation must cover the
changed inventory, semantic/byte boundary, coverage and execution gates before
RED authoring begins.
