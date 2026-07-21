# Phase 04 Review: Signed Short-TTL Rendezvous Record

Phase 04 implements the canonical signed-record seam and the `/record`
evidence workbench described by
[closed decision record](../README.md). A successful validation
proves control of the record's Peer ID and compliance with the record contract.
It does not prove DRP authorization, namespace membership, or permission to
join an object.

## Contract and cryptography

`SignedDrpRecordV1`, `RecordSigner`, and `RecordValidator` live in
`packages/network-spike/src/record/index.ts`. The signed payload binds the
versioned opaque namespace, Peer ID and protobuf public key, sorted/deduplicated
multiaddrs and capabilities, monotonic sequence, issue time, and expiry. The
signer accepts only Ed25519 and secp256k1 identities from the exact installed
`@libp2p/crypto` package.

Canonical bytes use UTF-8 JSON with a fixed key order. Arrays are sorted and
deduplicated before signing. Validation rejects non-canonical base64url,
non-canonical multiaddrs, extra or missing keys, unsupported algorithms,
public-key/Peer-ID mismatches, and invalid signatures. Deterministic tests prove
that equivalent input order produces identical signed records.

Validation deliberately orders cheap structural and bounded checks before
cryptography. It then checks identity binding and signature, replay state,
address policy, and the explicit external admission decision. Replay state is
committed only after every validation and admission check passes, so a rejected
record cannot burn a publisher's sequence.

## Freshness, replay, and resource bounds

The default contract permits 10–300 second TTLs, 30 seconds of clock skew,
8 addresses, 3 capabilities, 8 KiB per record, and 64 records per response.
The per-validator replay ledger is capped at 4,096 identities (configurable up
to 65,536). At capacity, a new identity receives the stable
`replay-capacity-exceeded` result. Live replay state is never evicted. Once its
signed record is expired under the validator clock, the entry is reclaimed;
this is safe because the prior signed value is thereafter rejected as expired.
Existing live identities can still advance their sequence. The focused suite
covers the capacity boundary, continued replay rejection, and expiry-only
reclamation. Expiry reclamation was added as the Phase 05 registry lifecycle
was implemented; it strengthens the original accepted fail-closed cap without
weakening any live-record invariant.

Every validation and DNS resolution composes with the caller-owned
`AbortSignal`; Phase 05 owns the enclosing registry operation deadline.
`validateResponse` applies its 64-record cap before beginning per-record work
and validates sequentially, making the maximum work explicit rather than
creating unbounded concurrency.

## Address safety and dial-time rebinding defense

The shared `AddressPolicy` rejects private, loopback, unspecified, link-local,
and otherwise non-dialable addresses for both browser and Node policy. DNS
multiaddrs are resolved during validation. `RecordValidator.recheckAddressesAtDial`
is the mandatory final dial seam: it re-runs the same address and DNS policy
immediately before a caller dials a validated record. A deterministic test
first resolves a public address, changes the resolver to a private address, and
proves the dial-time recheck rejects the record as `unsafe-address`. A separate
clock-advance test proves the same seam rejects a record that expires after
validation but before the actual dial.

Phase 05's registry may store validated records, but every Phase 05/07 dialer
must call this seam immediately before dialing. Stored validation alone is not
a rebinding defense.

## Admission and redaction

Admission is an explicit validator input, not a signed record field. Missing or
rejected admission produces a typed rejection and never mutates replay state.
The workbench places the admission decision outside the signed-record pipeline
and displays `NOT MEMBERSHIP / NOT DRP-AUTHORIZED` beside the accepted
validation verdict.

The deterministic fixture exposes only `namespace-A` and `publisher-A`,
stable rejection codes, a sanitized trace ID, and a digest computed from the
sanitized fixture facts. `privateKeyFields` is calculated by scanning emitted
record keys rather than asserted as a constant. The CLI verify output omits the
record; the browser disclosure is likewise sanitized and its e2e test rejects
serialized `peerId` or `signature` fields. Raw screenshots and Chrome traces
remain under ignored `.network-spike-raw/`.

## Runnable and browser evidence

`record sign --fixture` emits a deterministic signed record without a private
key. `record verify --fixture` reports seven matched oracles: accepted,
invalid-signature, expired, unsafe-address, admission-required,
replayed-sequence, and response-cap-exceeded. The final verify output reports
571 canonical bytes, 6 resolver checks, 0 private-key fields, and a sanitized
SHA-256 digest.

The `/record` workbench makes expected and actual outcomes visible for every
fixture. Chrome inspection found no console errors, issues, horizontal
overflow, or public request. The visible page used only the intended
`http://127.0.0.1:4174` origin. Its instrumented first render was about 28.1 ms.

The durable Chrome Performance flame-chart source is
`.network-spike-raw/phase-04/chrome-record-load-trace.json.json.gz`. The reload
recorded 302 ms LCP, 0.01 CLS, 12 ms TTFB, and 290 ms render delay.

The final full screenshot is
`.network-spike-raw/phase-04/record-desktop-v2.png`, with tight crops:

- `.network-spike-raw/phase-04/record-verdict-crop-v2.png`
- `.network-spike-raw/phase-04/record-fixtures-crop-v2.png`
- `.network-spike-raw/phase-04/record-security-crop-v2.png`

A fresh unprimed visual review initially rejected ambiguous `ACCEPTED` and
`MATCH` labels, the apparent placement of admission inside the signed pipeline,
and missing visible trace/digest evidence. The revised view puts the
non-membership/non-authorization qualifier beside the verdict, labels admission
as an external policy boundary, shows expected and actual rejection codes, and
adds the sanitized trace ID and digest. The final review returned `ACCEPT` with
no blocking or high-severity finding. Its medium notes about verdict emphasis
and muted secondary text do not obscure the security boundary or any value.

## Adversarial review

Both required reviewers ran read-only with a maximum budget of 100 turns or
steps.

Kimi session `5581a559-b285-406d-b266-0c5f4285b1c6` initially rejected an
unbounded replay map, validation-time-only DNS protection, the missing review
record/gates, and a self-attested private-key count. The implementation now has
a hard replay-state capacity with a flood-boundary test, exposes and tests the
mandatory literal dial-time recheck, computes the private-key count, and records
the completed gates here. Its resolver-deadline and sequential-response notes
are addressed by the caller-owned abort contract and explicit response cap.
Its stable-tree rerun returned `VERDICT: ACCEPT`. A non-blocking observation
about expiry at dial time was already overtaken by the final source change: the
pre-dial seam now checks expiry itself and its clock-advance test passes.

Grok's initial review found that the pre-dial seam rechecked DNS safety but not
expiry at the literal dial instant. It also observed the then-in-progress
browser/review gates. The seam now checks expiry before DNS work and has a
clock-advance regression test; the browser evidence, visual dispositions, and
full gates are complete. Its stable-tree follow-up returned `VERDICT: ACCEPT`
with no remaining precise blocker.

No blocking finding remains.

## Verification

- Focused package suite: 8 files and 72 tests passed.
- Signed-record suite: 12/12 passed; the record core has 90.7% statement,
  76.42% branch, and 100% function coverage.
- CLI sign and verify fixtures passed; all seven expected/actual outcomes
  matched.
- Vite production build: 521 modules, 749.65 kB JavaScript (239.18 kB gzip)
  and 31.16 kB CSS (6.72 kB gzip). The aggregate multi-workbench chunk warning
  is non-blocking.
- Repository `pnpm typecheck`: passed across all workspace projects.
- Repository `pnpm lint`: passed with the 71 pre-existing warnings and no
  errors.
- Complete Playwright project: 54/54 passed across Chromium, Firefox, and
  WebKit with one worker.
- Final post-fix serial `CI=1 pnpm test --run --reporter=dot`: 89 files passed,
  655 tests passed, 2 skipped, and 86.99% statement coverage.
- No public-network request was made.
