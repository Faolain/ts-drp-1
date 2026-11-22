# Paused incomplete GREEN candidate

Parent-directed freeze after signed/pushed corrective evidence
`e8cbe684b7c2ddb7fb77fa4a4ddd7d82bd74a234`. No production GREEN commit was
made. No reviewers, subagents, campaigns or long workloads were invoked.
All 27 stashes remain. Protected untracked paths and prior evidence are untouched.

The corrected four-file focused GREEN run returned **66 passed / 1 failed**
(67 tests, no skips), 14.21 seconds. Public issue now recovers successfully.
The corrected migration fixture reaches real target creation/import/reopen but
rehearsal rejects; activation then rejects as its dependent operation.

An already-launched diagnostic-only in-memory observer completed after the
parent freeze instruction; it did not edit tracked files. Exact rejection:

```
TypeError: v3 room migration reopened target differs
    at performMigrationRehearsal (examples/v3-room/src/index.ts:3779:12)
    at examples/v3-room/src/index.ts:3847:15
```

The scoped small-state test correction is `686a1cf9de5fbde64b990199e5ba2df9e5dac2e5`.
Its isolated overlay RED and manifest are signed/pushed at `e8cbe684` under
`.logs/d110c-0c1f5b0u-red-correction-686a1cf9/`. That run selected one test
and failed only its three intended fresh-recovery/migration assertions.

The production candidate has implemented strict store batch parsing and child
time/size checks, zero-chunk legacy upgrade, room pre-fence digest validation,
exact attempted room effect comparison, fresh genesis same-store recovery,
recovered projection commit, creator-close rebind/stop, shared startup activation,
single lifetime-tail startup settlement, and the direct constants dependency.
It is **incomplete and not accepted**: successor recovered-delivery replay,
the remaining migration reopen mismatch, backend whole-plan/revision readback
strengthening, cleanup/exception-path audit, formatting, retained/static/Chromium
and clean-isolated GREEN gates remain due. Existing progress-advance type/branches
also require simplification when finishing the recovery implementation.

Successor source audit: `activateCreatorSuccessorLive` obtains the genuine
recovered descriptor privately and does not return or deliver its recovered
vertices to the room. `publishPending` publishes/marks rows but does not replay
them through the room sink. Replaying via `bindings.onAdmittedVertex` requires
retaining exact recovery bytes/signatures privately plus ordering room projection
base/authority validation before commit, and fail-closed deactivation on replay
failure. No such behavior was implemented; the parent requires separate causal
RED before further production edits.

Frozen combined `git diff --binary` SHA-256:
`3115b50bc0a76662194cdc052313ae2390327c6452b2dc3ccf45a3f97dae09da`.

Exact nine changed paths and resulting SHA-256:

```
b7024b1a092796ba921b1b7d04e4cb1034b0a7a383bb098a8dd4ffa4b985bd98  examples/v3-room/package.json
e6590fa660e2c7ed57344bc8fea9caa6d312876505f6d06b1d9ca7caa5c20401  examples/v3-room/src/index.ts
00aa85f56e738686049099ded7ff4d1a12c34d54d7dadd9c6d47751df91a5c9a  packages/issuance-store/src/conformance.ts
bd62232c4f8fc2408d975c77b5e43612ea7ed4b07724d172ea4d02a18eafc55e  packages/issuance-store/src/contract.ts
2100ed2037bfb027d9f6090f843f04d9d448135498fa256e208afdd67ec65b8d  packages/issuance-store/src/types.ts
04057f76969a1286d511f629a3a0a84e60f1a811a0d7a7b0ba131d0a29db0177  packages/node/src/v3-live.ts
692e02f4381872f26b9d1801ef1d17cd760eb30ca6bfb9d8ffb09f4d27c024bd  packages/storage-browser/src/internal/browser-issuance-store.ts
ab4fa2a5f81c5f674a799387d324e2f83db6dddbda6e22bc5611f0818f140110  packages/storage-node/src/internal/node-issuance-store.ts
56e8b9b56d7e76d4651daec66b6ff8c0bc8150ce9fab588b97b1887f417d1251  pnpm-lock.yaml
```
