# Blueprint numeric determinism v1

Consensus reducers must produce the same canonical state bytes from the same prior state and operation. Host-provided numeric approximations and locale-sensitive behavior are therefore publication errors, even when their differences would be harmless in an ordinary application.

The forward-v3 publisher applies `drp/no-ambient-in-reducer` to both TypeScript source and the exact copied ESM artifact. It rejects ECMA implementation-approximated `Math` members, Number or BigInt exponentiation syntax, locale-sensitive comparison and formatting, and non-literal computed call targets. The rule preserves the profile's specified arithmetic, bitwise operations, retained `Math` members, code-point comparisons, static member calls, and computed data reads and writes.

This supplement changes publisher eligibility only. It does not alter the frozen v1 artifact profile, protocol v2, runtime execution, wire data, registry entries, or blueprint identity. The v1 lint contract remains historical evidence; the additive v2 contract is the toolchain input for source and artifact linting.

No deterministic-math implementation is introduced here. A later 0n-b requires a concrete reducer need and a separate amendment defining input domain, scale, overflow, rounding, negative zero, infinities, NaN, output representation, iteration bounds, and an implementation digest. Any such implementation must be bundled into the self-contained artifact, linted and hashed as exact bytes, and certified across every shipped engine against an independent oracle. Runtime imports or an unpinned library version are insufficient.
