# 2a-1 — Preserve manifest failure provenance

Status: contract accepted for separate corrective RED after focused reviews and
[root disposition](../../../.logs/bounded-storage-lifecycle/declaration-discovery-provenance-contract-reviews-04/root-disposition.md).
This is not GREEN authorization. All reviewed packets remain immutable.
This is one dependency seam within [2a](02a-declaration-discovery.md), whose
normative results, limits, ownership and frozen tests remain unchanged.

## Why this seam exists

Discovery must reject invalid durable metadata as `poisoned` and operational
processing failures as `storage-failed`. The [native counterexample](../../../.logs/bounded-storage-lifecycle/declaration-discovery-allocation-probe-01/root-disposition.md)
shows that passing discovery gates do not establish that distinction. Wrapping
every decoder exception as corruption loses evidence at the dependency boundary;
recognizing `RangeError`, `TypeError`, message text or nested causes later cannot
recover it reliably.

Canonical decoding owns canonical validity. The snapshot protocol owns manifest
validity and its detached output. Storage owns durable metadata binding and maps
those outcomes to its existing failures. Keep those owners; do not add a second
manifest parser, discovery-only codec, public injection option or fallback path.

The [ECMAScript ParseJSON contract](https://tc39.es/ecma262/multipage/structured-data.html#sec-ParseJSON)
specifies `SyntaxError` for invalid JSON text. The
[Encoding Standard](https://encoding.spec.whatwg.org/#interface-textdecoder)
specifies replacement-mode decoding and the first-BOM handling used below.
These native contracts support the boundary decisions; they do not guarantee
recoverability after engine termination or actual memory exhaustion.

## Contract

Deterministic invalid carrier, canonical representation, protocol schema, limit,
digest and persisted-binding failures retain their existing invalid-data
classification. A failure while copying, converting, hashing, re-encoding or
constructing an otherwise processable value is operational, not evidence of
corruption. A failed operation need not finish validating the input to report
operational failure. Do not claim that a failed conversion proves valid bytes.
This clarifies the parent's exact-row phrase "Any failure in either stage":
failed data-validation predicates reject `poisoned`; operational processing
failures follow its earlier explicit `storage-failed` requirement. Neither
resolves `missing` or becomes `conflict`. Unsafe persisted numeric values remain
deterministic corruption, never operational failures. This distinction governs
the overlapping prose without changing the frozen parent's required outcomes.

Positive recognition of the canonical owner's exported `CanonicalDecodingError`
and `CanonicalEncodingError` is authorized; both are deterministic domain errors,
including an encoding error raised inside decoding. This is not recognition of
arbitrary `TypeError` ancestry. The protocol imports those existing classes from
the same module as the codec functions. No new export, including a new exported
type, is needed or authorized.
This is a dependency-edge identity requirement, not a prohibition on other
canonical realizations elsewhere in a bundle. RED must demonstrate that the
protocol recognizes errors from the exact codec instance it invokes. A foreign
instance is not that owner; do not replace recognition with a public interned
brand or code-shaped object. Record the resolved codec/class binding in each gate.

The protocol's existing private `SnapshotManifestError` owns its finite codes.
At the manifest decoder boundary, preserve that owner's deterministic errors and
wrap every other processing exception with `manifest-processing-failed`. Storage
may discriminate the finite protocol `code` values in the catch immediately
around its direct decoder call. A code-shaped exception from input processing
must first have been normalized by the protocol's private-owner check; do not
duck-type arbitrary input exceptions as deterministic protocol errors. Unknown
processing exceptions are operational, except the explicitly frozen historical
consumer boundaries below.
The private protocol code union is exactly `manifest-digest-mismatch`,
`manifest-invalid`, `manifest-noncanonical`, `manifest-too-large`, and the new
`manifest-processing-failed`. The two-argument shared validator's catch around
the direct `decodeSnapshotManifest` call maps the first four to `poisoned` and
the fifth or any unknown processing exception to `storage-failed`. Keep that
switch local to the direct dependency boundary, not a general error utility.

| Boundary                                                | Deterministic outcome                                                          | Operational outcome                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Canonical decode/encode                                 | Existing owner error classes and codes                                         | Unknown exceptions propagate; no generic class/message/cause remap          |
| Protocol carrier validation                             | `manifest-invalid`; oversized manifest pre-copy length is `manifest-too-large` | Subsequent owned allocation/set failures reach `manifest-processing-failed` |
| Protocol `decodeRecord`: canonical decoding             | Either canonical owner error class becomes `manifest-noncanonical`             | `manifest-processing-failed`                                                |
| Protocol `decodeRecord`: canonical re-encoding          | Either canonical owner error class becomes `manifest-invalid`                  | `manifest-processing-failed`                                                |
| Protocol canonical byte comparison                      | Unequal bytes become `manifest-noncanonical`                                   | `manifest-processing-failed`                                                |
| Protocol schema, limits, digest                         | Existing `manifest-invalid`, `manifest-too-large`, `manifest-digest-mismatch`  | Unknown processing failure becomes `manifest-processing-failed`             |
| Discovery metadata binding and direct decoder call      | Explicit bad metadata and all deterministic protocol codes become `poisoned`   | Processing code or unknown processing exception becomes `storage-failed`    |
| SQLite descriptor parse, after JS primitive-string gate | Non-string is `poisoned`; native parse `SyntaxError` is `poisoned`             | Other parse exceptions become `storage-failed`                              |
| Shared incarnation encoding                             | Encoded length exceeding the existing bound is `poisoned`                      | Constructor/encoding failure becomes `storage-failed`                       |

In protocol `copyExactCarrier`, separate explicit intrinsic carrier validation
from the subsequent owned allocation/set. All existing carrier restrictions
remain. Complete those shape predicates in their guarded region, then allocate
and set outside that region so operational exceptions reach the decoder's
normalizer unchanged. Do not use exception message text to distinguish those
stages. Intrinsic carrier getters remain shape predicates, not successful
conversion claims. The manifest decoder consumes the raw metadata carrier directly; it
must not first call shared `captureExactBytes`/`captureDeclaration`. Consequently
an oversized raw manifest reaches the protocol's `manifest-too-large` gate
(SQLite may reject it earlier in preflight); discovery still reports `poisoned`.
There is one discovery capture copy, owned by the protocol decoder, rather than
an initial shared copy followed by protocol copy and final declaration capture.
Canonical's own defensive copy and the canonical re-encode buffer still exist;
this is not an assertion of one total manifest-sized allocation.

### Bounded UTF-8 validity work

The original whole-string [round-trip probe](../../../.logs/bounded-storage-lifecycle/declaration-discovery-utf8-probe-01/report.json)
establishes Node feasibility, but its full-input temporary re-encoding is not
accepted. Canonical's larger default budget makes that resource regression
material. Instead, validate using native replacement-mode UTF-8 decoding in
fixed chunks of at most 4096 input bytes. Use a fresh decoder per string, created
inside the operation from a captured native constructor. Encode each returned
piece, compare immediately against the original input at a running byte offset,
and discard the piece without accumulating decoded text. Discount exactly one
initial `EF BB BF` at that offset; this applies only to the STRING-tag payload,
not to whole-manifest bytes. Flush at end and require all input bytes matched.
Reject on the first mismatch. Multibyte sequences spanning chunks must remain
the native decoder's responsibility, not a handwritten Unicode parser.

Replacement mode is essential to provenance: fatal native decoding uses a
native exception for malformed UTF-8, which cannot reliably be distinguished
from an operational exception by class. The explicit byte/length comparison
therefore owns invalid UTF-8 rejection with the existing canonical decoding
error; native constructor/decode/encode exceptions are operational. Keep the
separate existing well-formed-string predicate and its owner error unchanged.
Preserve canonical deterministic error messages as well as their classes/codes.
In particular malformed UTF-8 and a STRING payload truncated at `Reader.take`
retain `invalid UTF-8 string`; the STRING length-varint errors remain outside
that historical mapping. Catch only the canonical owner's deterministic
reader error at that narrow reader boundary, never arbitrary conversion throws.
The general protocol owner's `decodeExact` classifies some canonical messages
by regex. Preserve its implementation and outcomes: these STRING failures stay
in its `decode` branch, not `noncanonical`.

Only after successful validity checking, decode the complete original string
payload non-streaming to produce its final text. The flushed decoder must reset
for that call; a failed validation must not leave state used by another string.
This final call uses the same replacement-mode decoder after successful flush;
validation ordering is mandatory. Replace the existing module-level decoder
instance with the captured constructor, not a second retained shared decoder.
Reuse canonical's existing module-level encoder for the validation pieces;
do not add per-string encoder construction. RED must target its captured
instance's method, with constructor-capture controls in isolated contexts.
All construction, conversion and encoding exceptions remain operational. Native
replacement characters that re-encode identically remain valid. Reader bounds
remain canonical validation. Preserve default BOM behavior, accepted text and
protocol re-encoding checks; do not introduce `ignoreBOM: true`.
In particular, current canonical decoding already strips one leading BOM and
current protocol re-encoding already refuses such manifest representations as
`manifest-noncanonical`. Preserving that refusal is not a new rejection. The
[product BOM baseline](../../../.logs/bounded-storage-lifecycle/declaration-discovery-bom-baseline-01/report.json)
demonstrates the distinction. The
[native decode algorithm](https://encoding.spec.whatwg.org/#dom-textdecoder-decode)
sets its streaming flag false on flush; the next call resets decoder, queue and
BOM-seen state before processing input. Reuse after successful flush therefore
does not rely on a Node-only sticky-state behavior. Browser controls remain
required independently of this specified behavior.

For validation chunk length `c <= 4096`, native UTF-8 carry is at most three input
bytes; each temporary piece is bounded by `c + 3` code units and its re-encoding
by `3 * (c + 3)` bytes. RED must fail on a larger submitted chunk or piece,
accumulation of pieces, an unbounded full-input validation re-encoding, continued conversion
after mismatch, or a final whole-string decode before validity succeeds. These
are explicit content/work bounds, not a promise about allocator overhead or
garbage-collection timing. Existing input ownership and the eventual accepted
output string still cost O(input); validation must not add another O(input)
retained representation. A decisive mismatch in the first chunk must reject
before feeding another chunk or making the final decode call; an incomplete
sequence may legitimately require more bytes or the final flush. Valid input
uses one linear validation pass plus the existing whole-string output conversion.

The [streaming feasibility probe](../../../.logs/bounded-storage-lifecycle/declaration-discovery-utf8-stream-probe-01/report.json)
is Node-only diagnostic evidence, not product RED or browser acceptance. Verify
boundary cases and scaled inputs in Node, Chromium, Firefox and WebKit; record
manifest-envelope timings without introducing a flaky wall-clock gate. Preserve
canonical and manifest admission limits. Do not deliberately allocate a
default-budget worst case or claim measured full-default-budget peak memory.
Native IndexedDB pre-clone limitations remain unchanged.
The [consumer audit and cost evidence](../../../.logs/bounded-storage-lifecycle/declaration-discovery-provenance-consumer-audit-01/report.md)
distinguish ordinary live profiles from generic large-string exposure. Record
actual product timings for descriptor-scale small strings and bounded larger
scale points as well as manifest inputs before GREEN acceptance. Accepting the
extra linear validity pass does not claim a measured worst-case slowdown or
authorize a new profile cap.
Include the live operation consumers: blueprint fold `apply`, prepared blueprint
operation application, and the existing live batch profile, plus package
admission/runtime preparation. Their repeated clone/decode work is not represented
by a single-string codec timing. Do not invent a slowdown threshold absent a
workload requirement; record before/after work and timings for review.

Discovery must reuse the manifest decoder's detached bytes and frozen descriptor
vector after binding them to the durable metadata. Remove redundant discovery
capture/copy paths; do not create another validated representation. Freeze the
returned declaration and records while preserving fresh-byte isolation between
calls. Deterministic metadata checks must explicitly produce the invalid-data
outcome; unknown processing exceptions map to `storage-failed`. The historical
one-argument recovery validator deliberately keeps its catch-all `poisoned`
mapping for the existing Node `retainForRecovery` closure and Browser
`validateRecoveryClosure` caller. This bounded compatibility exception preserves
the accepted retention oracle; it does not supply discovery's mapping or add a
second parser. Shared `captureExactBytes` remains unchanged: both invalid shape
and its historical copy failure still report `invalid-carrier` to declaration
capture and chunk callers. Discovery no longer calls it. `validateRecoveryChunk`
and protocol `intrinsicReadableView`/chunk-digest behavior remain out of scope.
That operational/corruption conflation remains a deferred limitation of those
chunk paths, not a problem this discovery seam claims to solve.

Protocol `encodeSnapshotTransfer` keeps its existing payload-copy catch, mapping
all failures there to `manifest-invalid` even after the shared private copy
helper separates provenance. Its existing final manifest self-check calls the
same decoder and therefore inherits the newly explicit `manifest-processing-failed`
for operational failures at that self-check only. This direct downstream effect
is authorized explicitly; do not claim its former corruption code is preserved
there, or alter other encoder/chunk failure boundaries. Pin both the payload-copy
compatibility case and self-check processing case in corrective RED.

Existing downstream error rosters also stay unchanged. In compaction's snapshot
stream, an unbranded operational manifest failure now reaches the existing
`source-failed` fallback after successful discard; failed discard still yields
`quarantine-failed`. In the node pull owner's receipt-completion path, that
failure reaches the existing `quarantine-failed` fallback when no recognized
nested code exists. Its initial manifest-decoder catch still reports
`manifest-invalid`. Direct callers without a normalizing catch inherit the
protocol processing error. These consequences are authorized without extending
stream/pull unions, runtime lists or frozen fixtures. Corrective RED must reach
the named actual consumer boundaries and pin their fallback behavior; GREEN
must not edit those consumers to add the fifth code.

## Scope and preservation

This narrowly extends the 2a implementation surface to the existing canonical
and snapshot-protocol owners, in addition to the shared storage contract and
native snapshot owners. No schema, wire format, package export map, runtime
roster, caller parameter envelope, authenticated authority, acquisition behavior,
retention mutation or payload scan may change. Frozen 2a and accepted historical
oracles remain byte-identical and must still pass, apart from separately
attributed pre-existing failures. The existing runtime contract roster is frozen:
add or rename no member. Keep overload-specific handling in the existing member
or a module-private helper, not another exposed contract operation. Any additional exact-surface conflict requires
separate disposition before implementation.

## Independent RED and acceptance

After focused Grok, Kimi (100-step cap) and Opus xhigh contract review and root
disposition, the separate RED author adds a corrective suite without editing the
frozen suites. Archive the candidate sources and oracle hashes before GREEN.
Test real dependency and native owner boundaries, not a local model of the
proposed mapper. Use controlled failures, never deliberate machine exhaustion.

- Prove causal failures on the held candidate at essential manifest copying,
  canonical copying/re-encoding, UTF-8 conversion, shared incarnation encoding
  and SQLite descriptor JSON parsing boundaries. Include
  `RangeError`, misleading `TypeError` and non-Error sentinels; verify the reached
  boundary and retain a no-fault valid control. Do not replace these with an
  adapter stub that bypasses the dependency which loses provenance.
  Inject before module capture in isolated processes/pages when the dependency
  captures an intrinsic. A post-import replacement that the owner never invokes
  is not a fault test. Keep frozen suites' intrinsic identity untouched and
  assert the intended binding was reached; pre-capture injection does not add
  a production injection API or require post-load mutability.
- Prove invalid UTF-8, malformed carriers, noncanonical representation, unsafe
  numeric fields, manifest limits, digest and metadata-binding failures remain
  invalid data. Demonstrate both dependency classification and native discovery's
  `poisoned` versus `storage-failed` mapping, with durable state unchanged.
- Compare canonical string acceptance and accepted text against native fatal
  decoding in Node, Chromium, Firefox and WebKit. Include empty strings,
  valid replacement characters, malformed/truncated/overlong sequences,
  surrogate encodings, Unicode boundaries and leading/interior/repeated BOMs.
  Exercise the product canonical parser as well as the independent codec oracle,
  including sequences split across streaming boundaries and the resource/work
  bounds above. Standalone feasibility is not this product RED.
- Preserve protocol invalid-data codes and old one-argument helper behavior;
  verify other affected manifest/canonical consumers and fresh detached discovery
  outputs. Record which operational injections are controlled method boundaries,
  not actual native out-of-memory events.

For SQLite descriptor parsing, narrowly catch the native `JSON.parse` invocation
on the already-validated bounded primitive string, without a reviver or caller
coercion. Its native `SyntaxError` means malformed JSON and maps to `poisoned`;
other thrown values remain operational. This is a specified native grammar
failure at its source, not a class heuristic over arbitrary manifest-processing
exceptions. Capture the native parser/error constructor consistently with the
owner's intrinsic policy at module initialization; no externally supplied parser
is part of the API. Require an explicit `typeof row.descriptors === "string"`
gate before invocation, rejecting non-string as `poisoned`. SQL preflight and a
TypeScript cast do not replace that JavaScript gate.
Preserve all previously valid descriptor JSON representations. Do not silently
replace parsing with exact writer-text equality or add a second JSON grammar.
RED must prove real native syntax rejection, reordered/whitespace-valid controls
and controlled non-syntax operational throws at that invocation. A replacement
parser throwing a forged `SyntaxError` is not evidence of a native operational
failure; do not claim arbitrary compromised-intrinsic resilience. Focused contract
review must explicitly disposition this native-boundary choice before RED.
Keep the existing foreign-writer asymmetry: discovery can accept equivalent
whitespace/numeric JSON variants while `recorded()`'s exact writer-text comparison
rejects them. Do not treat that as a current-writer round-trip regression.

Freeze and obtain separate requested RED reviews before the separate GREEN
author implements the correction. Then run corrective and original discovery
gates, canonical/protocol tests, affected accepted suites, focused strict
typecheck, lint and formatting with logs and hashes. Attribute existing broader
compiler failures separately. Package exports resolve built artifacts: rebuild
the affected canonical/protocol/shared-storage outputs from source, hash the
resolved dependency graph, and exercise the same package resolution in RED and
GREEN. Source-only tests cannot establish shipped-consumer preservation.
The [consumer audit](../../../.logs/bounded-storage-lifecycle/declaration-discovery-provenance-consumer-audit-01/report.md)
owns the selected existing affected suites and known baseline qualifications.
Do not count assertions after a failing count guard as executed coverage. In
the canonical package baseline, the golden byte/digest loop is dormant in its
failing test; the separate negative-corpus assertions do execute. The existing
standalone vector-loop diagnostic is separately qualified evidence, not a pass
for the historical test. Corrective RED must supply executing canonical
acceptance/message controls without changing that frozen assertion.
The bounded-work tests deliberately pin this algorithm's resource shape; a
future algorithm change requires separate oracle review, not relaxed bounds.
Obtain current-candidate Grok, Kimi and Opus GREEN
reviews and a Codex second opinion before accepting 2a. Historical approvals of
the earlier dependency bytes do not approve this correction. No visual artifact
or endurance run is required for this seam; later recovery and production
boundedness obligations remain open.
