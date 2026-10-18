# Protocol v3 blueprint artifact profile

This additive supplement defines `ts-drp-blueprint-artifact-profile-v1`. It does not amend the frozen
protocol-v3 registry or the separately governed Ed25519 acceptance supplement.

## Exact artifact identity

The artifact digest is:

```text
hashDomain("ts-drp/blueprint-artifact/v3", exactArtifactBytes)
```

`exactArtifactBytes` is the copied, self-contained deployable ESM byte sequence. It is hashed without
text, newline, Unicode, source-map, path, URL, or bundler normalization. The same copied bytes are the
source evaluated by the package-owned loader. A leading UTF-8 BOM and malformed UTF-8 are rejected.
Static imports, re-exports, dynamic imports, source-phase imports, and `import.meta` are outside this
closed profile; the loader admits no module-resolution seam.

## Runtime profile

The sole supported runtime profile is `ecmascript-2024-sync-v1`. It defines export schema 1: the module
exports only `blueprint`, a closed own-data envelope containing `exportSchemaVersion`, `artifactId`,
`runtimeProfile`, and `reducers`. The reducer table exactly matches the canonical package operation
names and contains synchronous, non-generator own-data functions. Runtime preparation validates and
freezes the table but does not invoke a reducer.

This capability proves exact package/artifact identity, supported local profile, and package-owned
export provenance. It does not prove arbitrary JavaScript deterministic or isolate hostile code.
Publisher lint, conformance, trusted-catalog binding, and later intrinsic-drift checks own those
separate claims.

## Pure ambient allowlist

The closed identifier allowlist is: `Infinity`, `NaN`, `undefined`.

The closed `Math` member allowlist is:

`E`, `LN10`, `LN2`, `LOG10E`, `LOG2E`, `PI`, `SQRT1_2`, `SQRT2`, `abs`, `acos`, `acosh`, `asin`,
`asinh`, `atan`, `atan2`, `atanh`, `cbrt`, `ceil`, `clz32`, `cos`, `cosh`, `exp`, `expm1`, `floor`,
`fround`, `hypot`, `imul`, `log`, `log10`, `log1p`, `log2`, `max`, `min`, `pow`, `round`, `sign`,
`sin`, `sinh`, `sqrt`, `tan`, `tanh`, `trunc`.

This allowlist is publisher-side authoring policy, not a claim that every listed transcendental is
cross-engine deterministic. Phase 0n and the Phase-4a exact-emitted-artifact prerequisite retain the
transcendental and locale-sensitive restrictions.

## Frozen lineage

The supplement pins checkpoint `907fae437e558145f63614cd6b5de925ea4bd8c2`, base policy
`packages/protocol-v3/conformance/freeze-policy-v3.json` with SHA-256
`fa2a69d4113f73bbd657d4490189b472a2ae04b5bdc88d35d2de5c87e572ccc3`, 47 protected base paths,
and protected-state digest `023e7b50c11eff2d5fd4d0d8c5ea6da8d54ad095d73d24b7d3badea2e3769637`.
