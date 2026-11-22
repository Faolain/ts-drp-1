# Source-shape audit

- The shared maintenance interface, memory implementation, IndexedDB
  implementation, SQLite implementation, and runtime call site contain
  `pruneAuthenticatedSettledPrefix`.
- The ordinary issuance types and root index have no diff, preserving the
  eight-method facade.
- The cross-package registry stores its `WeakMap` inside a frozen closure. Its
  bind method rejects an already-bound facade, and the raw map is not installed
  on `globalThis`.
- Memory, browser, and Node bind at facade construction. Browser and Node keep
  their backend-local exact identity maps; clone, proxy, and foreign backend
  resolution is covered by the retained Node test.
- The filtered runtime facade resolves the backing facade's existing
  capability and aliases that capability; it does not construct another
  storage mutation implementation.
- Settlement-plan completeness is checked before deletion and before
  idempotent replay under the authenticated method. The shared predicate
  rejects an absent plan, null fence, manual review, or any unlinked
  non-expiring entry, including entries outside the deletion prefix.
- The runtime source contains one production authenticated-prune invocation in
  the existing verified reclamation owner, and the recovery scan cap is exactly
  `maxEpochVertices * 3`, matching one active plus two rollback generations.
- `source-shape-check.log` contains the exact owner paths and matched lines.
