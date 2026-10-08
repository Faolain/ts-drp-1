# D.110c-0c1f5b0b final RED evidence

Signed commit `f7f693b7ec3eddcc68694ad093e807067b9333a7` is the final
tests-only RED input to GREEN.

It preserves the prior restart-contract correction while removing accidental
imports of intentionally private protocol-v3 root symbols. The fixture uses
the existing Noble test dependency for strict Ed25519 verification and checks
the decoded fence as an exact plain own-data object. The protocol-v3 root
public export set is unchanged.

The focused run and detached clean built-package reproduction both selected 27
tests: 6 controls passed, 21 causal product obligations failed, 0 skipped, and
no import/export/module/fixture/setup error occurred. Prior RED roots remain
immutable and document the two expectation/portability corrections honestly.
