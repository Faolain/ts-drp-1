# Consolidated fixture-exit compiler RED: stopped on two additional rows

The one actual combined strict TypeScript program terminated with exit 1
and ten complete diagnostics. The separate frozen-matrix validator also
terminated with exit 1: all seven known fixture rows and the separate grid
row match, but two additional diagnostics require scope disposition.
This is a preserved stopped RED, not an accepted eight-row matrix or any
whole-program static pass. No source edit, compiler rerun or runtime occurred.

The full matrix is:
- examples/grid/src/v3-zone.ts:638 TS2345 x1, missing roomHeadAuthority.
- tests/genesis-profile.test.ts:124 TS2345 x1, string public key passed to
  noble's byte-only verification argument (additional).
- tests/phase-3g-v3-room-rebase-red.test.ts:1199 x2 and1258 x1 TS2345,
  operation erased to unknown by two callback row annotations (known).
- tests/phase-5a-c-seal-safety-red.test.ts:300,355,488,532 TS2345 x4,
  five-field installation shape erased by helper return annotation (known).
- tests/phase-5d-pacemaker-red.test.ts:377 TS2542 x1, assignment through
  cloned trace's readonly states array (additional).

Additional attribution is read-only and source-backed. Installed noble
curves2.2.0 invokes abytes on publicKey before signature verification; the
actual physical pnpm hashes2.2.0 owner rejects strings. Therefore a cast-only
fix would conceal a real fixture representation mismatch. A prospective
single-argument hex-to-byte conversion could preserve the independent
key/signature/message/zip215:false oracle, but is outside this batch's
frozen three type annotations and was not implemented. No new runtime
failure is claimed as measured.

The trace error is the static readonly type retained by structuredClone.
The clone deliberately receives durableRevision:-1 and must continue to
fail TRACE_STATE_MISMATCH. A localized mutable array type view could preserve
that exact mutation without changing shared trace types, checked traces,
hashes or parsers. Neither added correction is authorized by this evidence.

The accepted-option derivation is unchanged; only the explicit historical
checkout prefix is relocated to the real current workspace. Actual sources
and resolutions are not replaced. Program identity contains 1,309 source
files, 1,771 read inputs, 3,083 module resolutions, 37 type references and
physical/compiler/configuration hashes, with TypeScript5.8.2. Complete raw
compiler streams and full diagnostic positions/tokens/owners are retained.
The original comparator evidence has only file/code/line/message fields;
matrix matching preserves all those available fields, including duplicates,
without inventing historical columns or tokens.

The frozen roster is four files and49 historically accepted cases:
genesis9, seal7, pacemaker13, room20. Three exact accepted reporters are
hash-bound to their signed commits. Genesis uses unchanged source plus the
signed57e125cd closure paragraph; no missing raw reporter is invented.
Six source snapshots and their hashes preserve the two owners and all
direct/intermediate consumers. The three authorized annotation spans and
outside-span hashes remain frozen for prospective GREEN. Assertion-statement
trees are captured separately per file; no runtime or Vitest listing was run.

Custody preserves all eight pending production owners, patch
6d0fd99cfcb383b82f3becae421b4691bb945639ef9d60b76e9968715df765cb,
seven built owners and the effective81 retained map. Supplemental six-file
consumer hashes are recorded separately without changing that prior map.
All27 stashes,86,522 protected paths and immutable manifest entries remain.

Two read-only diagnostic mistakes were corrected without a compiler repeat:
a custody-key node-e inspection had an extra brace; an initial dependency
source resolver used a logical symlink importer and reached a parent path.
The recorded authoritative dependency attribution instead resolves from the
physical repository package path. Neither mistake changed source or executed
a dependency function.

Root must inspect the complete ten-row result and decide the smallest
compatible extension of this same consolidated batch before source edits.
The separate grid-authority obligation and four previously recorded runtime
failures remain open. Evidence is unstaged and uncommitted for root signing.
