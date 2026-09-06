# D.110c-0c1f5b0a corrective RED result

- Completed: `2026-09-04T05:49:28Z`.
- Exact selection: two files, fourteen tests. The ten accepted f5b0a controls passed; all four corrective cases failed causally.
- Genuine settlement trust installation failed at `creator-trusted-settlement-v1:install:unsupported-trust-profile`, proving the hard-coded legacy profile owner.
- The closure case preserved its legacy cardinality controls, then failed at genuine settlement-profile installation before it could accept one settlement checkpoint and zero legacy carriers.
- The authorization case preserved legacy 64-author/8,192-byte controls, then failed at genuine settlement-profile installation before its 256/257/65,536 boundary matrix.
- The genesis case demonstrated the actual adjacency defect: an alternate valid-shape 64-hex digest returned `{ ok: true }` rather than requiring the exported sentinel.
- The tests also pin the downstream successor/floor prepare/open path, settlement closure composition, profile-specific author-carrier ceiling, settled-v1 adjacency, and exact sentinel after the trust blocker is removed.
- No missing import/export, fixture fallback, module-resolution, syntax, or mock-only failure occurred. Build, lint, format, strict targeted typecheck, diff, signature, and isolated RED checks passed.
- No accepted-design stop rule was triggered; the four failures are implementation gaps owned by f5b0a.
