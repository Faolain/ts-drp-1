# D.110c-a single confirmation ledger

Reviewed correction: signed/pushed `cd665103dc178d4b6428eebd405f7b7d000285de`, parent GREEN `a923c7d2b8d2d2a5c58725a467d8e33f43db7c73`.

## Terminal results

- Grok 4.6/high: the initial runner cancelled after 360.266 seconds; exact session `01a0628d-80f1-7463-9ce6-0c3108f010c5` was resumed as required and returned `APPROVED`, P0=0/P1=0/P2=2, `D110C_A_GREEN_ACCEPTED`.
- Standard direct Kimi K3/high, `KIMI_LOOP_MAX_STEPS_PER_TURN=100`: session `session_95ab9cd1-6226-4607-8c83-76a2bd562d25` completed normally and returned `APPROVED`, P0=0/P1=0/P2=2, `D110C_A_GREEN_ACCEPTED`.
- Opus xhigh: session `8191d762-1501-4a0c-ac76-f31163dbdad1` returned `APPROVED`, P0=0/P1=0/P2=4, `D110C_A_GREEN_ACCEPTED`.

The blocking union is empty. This is the single permitted executable confirmation of the tests-only correction; no further confirmation or documentation review follows.

## Bounded P2 dispositions

- At epoch 1, reset and earlier-epoch substitution are byte-identical because the only same-room earlier compact-history prefix is epoch 0's empty accumulator. Cross-anchor/foreign-history rejection reduces to the same authenticated root/size mismatch already exercised by the cross-room carrier. Accept for D.110c-a; D.110c-c owns any later non-empty prefix distinction.
- Canonical decoding cannot preserve a JavaScript alias. The copied-snapshot assertion and retained accumulator hostile/alias tests remain the ownership proof. No impossible on-wire alias mutant is added.
- Add a construction-identical unmutated positive control only when the focused fixture is next edited. The one-use adoption intent makes literal reuse of the same plane impossible; no new test run is justified for this P2.
- Correct the closure prose prospectively: retained skipped successor trust returns exact `EPOCH_GAP`; substituted same-epoch trust returns exact `EPOCH_EQUIVOCATION`. The tests already assert those codes correctly, so no executable correction is needed and immutable prior evidence is not rewritten.
- `openCreatorSuccessorTrust` already enforces genesis digest, object identity, and exact next epoch at protocol-v3 lines 597, 610, and 619 before the Node post-open assertion. That branch is redundant defense and provably unreachable after a successful open; do not mock around the upstream verifier merely to execute it.
- Occurrence-based source-shape counts and the absence of a focused successor-trust injection are accepted because exact owner predicates and the retained Phase-5e trust suite are green. No product or fixture expansion follows.

## Evidence identities

- Grok resumed event stream: `c22e43872d53817f500dc40e90b2f45b9a54f90d7483e26cb40df193f9c0811c`.
- Kimi exported session ZIP: `2288724d4900517a1d87a2be06ba286a0f43899213ffa20b7a7c771db2bc72cb`.
- Opus raw result: `121a4bd951c3ee9c1bc655349057fe04085f2f00000d3e7cee7ba4d74038e687`.

The complete Kimi session is retained in `kimi/session_95ab9cd1-6226-4607-8c83-76a2bd562d25.zip`; its normalized terminal result is `kimi/terminal.json`. Existing correction reporters, source gates, and the 15-entry manifest remain immutable.
