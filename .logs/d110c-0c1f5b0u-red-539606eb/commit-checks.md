# Evidence commit diff custody

All five roots' self-excluding manifests were validated for complete file
coverage and exact SHA-256 before staging. The unrestricted evidence
`git diff --cached --check` returned 2: captured binary-patch context lines
necessarily contain a leading patch space before source tabs, the preserved
invalid-listing stderr contains rendered whitespace, and the preserved
bb2453d5 runner has an extra final blank line. Those immutable evidence bytes
were not rewritten to satisfy a source-format diagnostic.

The exact authored current-root check returned 0:

`git diff --cached --check -- .logs/d110c-0c1f5b0u-red-539606eb/README.md .logs/d110c-0c1f5b0u-red-539606eb/validate.mjs .logs/d110c-0c1f5b0u-red-539606eb/run-layer.mjs .logs/d110c-0c1f5b0u-red-539606eb/prior-attempt-disposition.md`

Tests-only source diff checks had already passed before each signed test
commit. Raw evidence remains byte-exact; no whitespace policy or production
file was changed. This addendum is part of the current, not-yet-committed
evidence assembly; prior independently manifested roots remain unchanged.
