# Sync-state heap characterization

This harness measures the production `@ts-drp/node` sync-state lifecycle from
fresh, isolated Node processes. It does not expose private state or add a test or
production seam. Authoritative constants are hard-coded; `--smoke` is a separate
non-acceptance schedule.

The two required sweeps are all pairs on one object and round-robin placement
across 20 objects. A separate N=280 cell proves the exact 20-object × 14-pair
demand point. Each sample seed completely determines its framed corpus: one
genuine creator identity, creator-bound object IDs with 16-byte lowercase-hex
salts, unique canonical 64-hex hashes, and unique 53-character base58-valid
peer-key strings. Per-pair peer keys are deliberately production-shaped strings,
not cryptographic identities, because sync-state retains only their JSON key
text. No legacy/plain object-ID path is generated, measured, or supported. The
worker asserts the retained composite JSON tuple key is exactly 146 UTF-16 code
units and verifies branch cuts and final advertised/shared projections through
public read seams.

For a bounded host smoke run (never acceptable evidence):

```sh
node scripts/production-hardening/sync-state-heap-controller.mjs \
  --smoke \
  --output .logs/phase-1o-f-sync-state-heap-smoke
```

The authoritative wrapper verifies the pinned base index → Linux/arm64 manifest
→ config chain, exports clean `HEAD` with `git archive`, and builds that isolated
context with BuildKit. Consequently an uncommitted harness can run smoke checks
but cannot produce authoritative evidence. BuildKit loads the single-platform
image with provenance attestations disabled and writes its immutable config ID.
The wrapper saves that exact ID as an OCI-layout-capable archive, hashes the
archive's manifest blob, follows and hashes its declared config blob, requires
it to equal BuildKit's config ID, validates the source-revision image label,
reloads that verified archive, and runs the immutable inspected config ID with
networking disabled. It does not treat BuildKit's exporter-dependent metadata
fields as a manifest proof.
Protected untracked files, `.git`, host dependencies, logs, and host build
artifacts never enter the context.

The image installs the exact frozen lockfile with lifecycle scripts disabled,
limited to the root production build toolchain and `@ts-drp/node`'s production
workspace dependency closure. This deliberately excludes the unrelated
development-only `pprof` native addon; the build fails closed if it appears or
if the pinned TypeScript/esbuild tools are unusable. Importing the real DRPNode
does require the production `node-datachannel` addon, so only its pinned
prebuild fetch is run (without the package's mutable source-build fallback) and
the Linux/arm64 binary must match the hard-coded SHA-256 before the image is
accepted. The controller then builds fresh production JavaScript inside the
pinned Linux image immediately before measurement.

```sh
node scripts/production-hardening/run-sync-state-heap-oci.mjs \
  --output .logs/phase-1o-f-sync-state-heap
```

To exercise the complete OCI provenance and isolated-runtime path with the
bounded, non-acceptance schedule, add `--smoke` and use a separate output path.

The wrapper is the authoritative entry point because it binds source, base-chain,
output-manifest, and output-config provenance end to end. To inspect its worker
logic without collecting measurements, run the deterministic analyzer checks:

```sh
node scripts/production-hardening/sync-state-heap-analyzer.mjs --self-check
```

The controller records metadata, every warmup and measured process in raw
JSONL, and the derived statistics/rejection report. Any worker error, unstable
heap, dirty tracked worktree, missing/non-finite/non-positive fixed-activation evidence,
runtime/provenance mismatch, or acceptance-threshold miss fails the authoritative
run. Fixed activation uses one joint bootstrap across both placement curves. In
each iteration it resamples the shared demand cell once, resamples each
placement's N0 and curve, computes `demand20x14 - N0 - 280 × marginalSlope` for
each placement, and takes that iteration's maximum. The accepted bound is q99
of those maxima. On identical draws, the population quantity
`q99(max(X_A, X_B))` is at least `max(q99(X_A), q99(X_B))`; this analyzer uses
independently seeded finite 10,000-iteration estimators and a structurally
different shared demand draw, so their estimates can invert. The normative
fixed bound is therefore the maximum of the joint estimate and every disclosed
per-placement estimate, not only
`marginalEnvelope.fixedOwnerContainerOneSided99UpperBytes`. A non-positive bound
from either placement, or from the joint result, rejects the characterization
instead of enlarging a later capacity calculation.
