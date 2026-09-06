# Adoption-fixture strict compiler RED

Signed plan/source custody: `f17a180eef2e8b96dd6d4f6305dd64ba254814f2` (G). This evidence is prepared for root review and signing; this agent made no commit or plan change.

Exactly **one actual TypeScript program** ran with the accepted root, root file, TypeScript 5.8.2, effective options and actual workspace resolutions. It terminated with **exit 1** and these complete diagnostics:

| Fixture | Diagnostic | Count |
| --- | --- | --- |
| creator-adoption-contract.ts | TS7006 | 34 |
| creator-adoption-contract.ts | TS2322 | 1 |
| creator-adoption-contract.ts | TS2739 | 1 |
| creator-successor-product-contract.ts | TS2339 | 5 |

The separate matrix validator exited **0**: all 41 rows match the accepted GREEN root's `typecheck-final.json.current` exactly, including file, code, full message, line, column, length, start and token. Target-test and production diagnostics are zero. Compiler failure is retained independently from matrix success; this is not a typecheck pass or a replay of the old two-program baseline comparison.

Program identity captures 906 loaded source files with in-memory and on-disk hashes, 1,132 compiler-host read inputs, 2,107 module resolutions, 37 type-reference resolutions, effective options, configuration/package hashes, compiler physical paths/hashes and Node identity. Full compiler stdout/stderr, commands, statuses and timestamps are retained. Both fixture before-snapshots are byte-identical copies. No source replacement, emit, fixture edit or production edit occurred.

Before/after custody preserves eight dirty production owners, seven built artifacts, 79 retained/shared file hashes, 27 stashes, 86,522 protected paths and prior immutable evidence. The exact current patch is `6d0fd99cfcb383b82f3becae421b4691bb945639ef9d60b76e9968715df765cb`; room source is `391177c10e5e20568bec216f18b3d26db6345a3bc2f8399409dbca52c5135252`.

## Prospective retained roster correction

The core eight-file/72-title roster is preserved. Root's subsequent evidence audit identified four additional accepted direct consumers (six tests), so `future-combined-roster.json` freezes **12 files / 78 titles** from their exact accepted reporters and current source hashes. This prospective correction awaits root's signed evidence/plan commit; it does not rewrite f17 history. These four consumers must not be labeled superseded merely because they were omitted from the original inventory.

One supplemental literal-only AST title scanner failed because it omitted an existing `it.skipIf(...)(D108D1A_HOT_BEHAVIOR, ...)` call. Its recorder/status is preserved as a diagnostic mistake. Root authorized a distinct reporter-derived roster recorder, which passes. It makes no claim that a static scan equals runtime collection; GREEN's executed reporters must independently confirm the frozen selection. No runtime listing or test was executed.

No package install/build, browser, runtime suite, compiler rerun, reviewer, new agent, fixture/source mutation, staged change or commit was performed. The separate GREEN owner remains gated on root's acceptance/signing.
