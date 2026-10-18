# Call-graph and ownership audit

- `packages/node/src/internal/closed-epoch-cleanup.ts` exports
  `planClosedEpochCleanup`; there is no package/example caller.
- `packages/node/src/internal/runtime-reclamation.ts` exports the internal
  `reclaimInstalledV3Runtime`; there is no package/example caller.
- `packages/node/src/v3-live.ts` currently calls
  `pruneAuthenticatedSettledPrefix` only inside that internal runtime kernel,
  after accepting a supplied issuance receipt. The rejected GREEN additionally
  requires the call to be a replay and maps every thrown store error to
  `D109D_RUNTIME_NOT_READY`.
- Memory, browser and Node each implement one shared backend-local prune owner
  selected by an `authenticatedSettled` flag. In all three, the authenticated
  branch skips the legacy equality check and has no replacement
  `decoded.epoch <= closedEpoch` ceiling.
- `@ts-drp/issuance-store/maintenance` is a published maintenance subpath.
  Its exact-facade WeakMap binding is the intentional trusted-same-realm
  capability boundary for this slice; hostile same-realm preemption is not in
  scope.

The audit establishes that the backend ceiling is independently testable now,
while first genuine close/adopt invocation and recovery-scan behavior depend
on the parent settlement integration. The signed reslice records that boundary.

