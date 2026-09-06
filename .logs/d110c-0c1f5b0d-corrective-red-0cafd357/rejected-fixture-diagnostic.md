# Rejected diagnostics

Two exploratory attempts were excluded before the accepted RED:

1. A direct runtime import of the published maintenance subpath did not resolve
   in the source-mode Vitest alias configuration. The accepted RED imports the
   intended source module and contains no module-load failure.
2. Genuine hot and cold `creator-trusted-settlement-v1` close/adopt fixtures
   both stopped before reclamation with `CERTIFIED_VALUE_MISMATCH` in
   `creator-close.ts`. This is the parent f5b integration seam, not evidence
   about backend reclamation. The signed reslice assigns the real every-peer
   invocation to f5b and forbids a source-string or synthetic-receipt
   substitute.

Neither rejected diagnostic is counted in `focused.json` or `browser.json`.

