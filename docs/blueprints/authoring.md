# Blueprint authoring

Blueprint publishing is a reproducible build and review process, not a runtime
extension mechanism. An author supplies a closed manifest and reducer source;
the private `@ts-drp/blueprint-toolchain` turns that input into exact bytes and
conformance evidence. Those bytes, rather than a mutable source directory, are
the object that reviewers approve.

## Trust boundary

Only a reviewed local catalog is trusted. `@ts-drp/blueprint-catalog` opens that
catalog and returns detached bytes for an exact digest. Fetching blueprints from
the network is unsupported: transport provenance cannot replace byte identity,
catalog review, or conformance evidence.

Controlled conformance executes reducers only inside the evidence harness.
The catalog does not execute reducers or fold application state. It retains no
admission or runtime capability and only returns copied bytes. This keeps
publisher evidence, trusted-local selection, and live application authority in
separate owners.

## Determinism and evidence

Review the exact bytes produced from a clean checkout. Source, artifact,
package, lint evidence, and conformance receipt are bound together; rebuilding
must reproduce the committed bundle rather than merely produce equivalent
JavaScript. The toolchain package owns the build and validation rules, while
the catalog package owns admission of already reviewed bundles. Consult those
packages for the current executable contract instead of copying their schemas
or command flags into documentation.

PR evidence is the bounded iteration tier. Nightly evidence is its strict
superset and includes the broader engine corpus. Neither tier turns a passing
bundle into live authority.

## Application handoff

Phase 3a executes zero reducers and completes preparation before any live effect.
It authenticates the current signed anchor, resolves only the proven
blueprint digest through the injected catalog, checks the returned digest, and
completes admission and runtime preparation before constructing an index. The
authoring and catalog packages do not authenticate anchors, subscribe, append,
issue, or dispatch application operations.

This separation is deliberate: publishing proves deterministic identity and
local review; the application proves that the selected identity is authorized
for the current object and epoch.
