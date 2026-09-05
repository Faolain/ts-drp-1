# ts-drp history-at-scale review bundle

This bundle reviews `Faolain/ts-drp-1` at commit
`bf7d3516f6ed4be97a755698b4fb3a404e04dc0f`, including the merged AEC v3.1 design,
and supplies an independent browser-first reference for the recommended **Attested
Hard Epochs (AHE) v4** architecture.

## Start here

1. `report/ts-drp-history-at-scale-review.pdf` - executive and technical review.
2. `report/repo-integration-plan.md` - phased repository integration plan.
3. `reference-implementation/docs/attested-hard-epochs-v4.md` - normative target specification.
4. `reference-implementation/README.md` - reproduction instructions and limits.
5. `evidence/` - test, model, benchmark, browser-audit, and storage outputs.

## Status boundary

The JavaScript/Python code is an executable independent reference and evidence harness,
not a drop-in patch to the upstream monorepo. It demonstrates the proposed safety-critical
formats and state transitions. Production release still requires repository integration,
formal pacemaker/round-change verification, cross-engine IndexedDB crash testing, and
external cryptographic/security review.

The upstream repository was not modified: the available GitHub integration had read access,
but branch creation for this repository returned HTTP 403.

## Reproduction

From `reference-implementation/`:

```bash
npm test
node --experimental-test-coverage --test test/*.test.mjs
npm run model
npm run bench
npm run browser
```

The packaged browser result is `blocked`, because the managed Chromium profile in the
execution environment applies `URLBlocklist=*` and rejects localhost navigation before the
harness loads. Run the same harness in an ordinary secure browser profile.
