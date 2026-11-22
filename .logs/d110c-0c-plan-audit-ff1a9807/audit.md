# D.110c-0c bounded source audit

Base: signed/pushed D.110c-0b1 closure
`ff1a9807528b1f29c8d1f381f0c093baf5a5d506`.

The existing public subpath is sufficient. It captures exactly eleven existing
inputs and delegates to one private owner. The room product already supplies
the authenticated stable/pending room-head pair, pinned-genesis carriers,
snapshot owners, and AHE store; it publishes the AHE candidate before committing
the pending room-head floor and invokes active cold reopen only afterward.

The source-pinned defect is internal to
`authenticatePendingCandidate()` in `packages/node/src/creator-adoption.ts`:

- lines 1305-1306 hard-code the current/successor projection kinds;
- lines 1319-1324 use the genesis-only current-trust opener;
- lines 1343-1347 use the additive first-transition closure predicate;
- lines 1357-1361 require the supplied genesis carrier to equal the current
  trust record; and
- lines 1370, 1378, and 1383 hard-code epochs/projection to 0→1.

The surrounding candidate state, exact generation lineage, closure digest,
fork classification, deterministic selection, CAS, and authenticated reread
are already epoch-neutral. D.110c-0b1 supplies the N≥1 checkpoint opener and
shared bounded verification classifier. The existing expected previous/next
room heads supply the independent authenticated floor. No new API, root export,
wire/schema, dependency, or authority carrier is indicated.

The existing browser product harness already owns deterministic old-AHE and
new-AHE failure seams (`failBeforePublication` and one-shot room-head commit
failure). D.110c-0c must exercise them only after genuine 0→1→2 product work and
must replace the older same-realm unreachable-object approximation with a
persistent-profile browser-process restart for its new epoch-2→3 cases.

The final-review P2 audit also confirms that
`creatorFilteredIssuanceStore()` currently declares both counters outside
`readOutboxPage()` and permits each class its own `maxEpochVertices` allowance.
D.110c-0c records that exact fail-closed debt without mixing it into the pending
resume repair. D.110c-c owns the narrow per-scan/combined-bound correction and
general retirement of arbitrary intermediate issuance rows before D.110c-d.

The executable audit is retained verbatim as `source-audit.mjs`; its output is
`source-audit.json`. Production edits remain prohibited until the signed plan's
Grok/Kimi/Opus blocking union is empty.
