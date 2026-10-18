# D.110c-0b1 plan-correction confirmation ledger

- Reviewed commit: `627f98d118fa22e935f31023171d38c6075e3bc0`
- Reviewed tree: `20f41aaf2adccd2029649aaece9d728ef2ff61e9`
- Scope: one permitted material confirmation of the corrected opener output, bounded retirement contract, Node classifier ownership, RED causality, and scope boundary.
- Result: `APPROVED`; P0=0, P1=0, P2=2; blocking union empty; deterministic tests-only RED authorized.

## Grok 4.6/high

- Session: `01a063aa-e998-72d2-a25f-ecc46110cc89`.
- Initial run: normal `end_turn`, no cancellation or timeout; embedded terminal `APPROVED`, P0=0/P1=0/P2=0.
- Strict wrapper classification: honest `NO_VERDICT` because inspection prose preceded the terminal JSON.
- Same-session continuation: one schema-clean re-emission only, no repeated review, tools, or changed verdict.
- Initial event/public/status SHA-256: `adf2b6bf8cbaa75b5b627c3e52c69c6308616c6da47255d8bc0402212a3326e9`, `4b85ab2533bd9f32fa8f4684d861f1423f76bdca69b2dbe2b67bf21b466b8130`, `bdace531f7e46138a74bf533e5145d2913c0a6513dfb9f3be2733175d28d8d35`.
- Resume prompt/event/stderr/public-object SHA-256: `84582f893bf451a9de5b53925d9a0aa1bcc5bbdae48fea70f2ad7bfcec0f36c8`, `63b1cb3c8d156a41ef71c8f0b9ffec1d4d4f4700a24126e135d598909f675d2d`, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, `fd669ea6c8e67fb6a135d03c48f8f1856099a212cc25b7d92eb00481e7032cc3`.

## Kimi K3

- Session: `session_dc7c1710-1504-4134-8d92-980a061aa416`.
- Environment: `KIMI_LOOP_MAX_STEPS_PER_TURN=100`; configured model `kimi-code/k3`.
- Result: schema-clean `APPROVED`, P0=0/P1=0/P2=0.
- Stream/stderr SHA-256: `0a1f646588eb134dee629263ad146b09eb7ba0f6bb722cceeb8deb4f7fa1ff01`, `d706c8d7e11485fc37c89e3f063366d873cfb416fd6ce1a35fa41e5f146432f8`.

## Opus xhigh

- Session: `8cf547ac-e93f-4841-bf6f-d291740e415c`.
- Result: normal `end_turn`, zero subagents, `APPROVED`, P0=0/P1=0/P2=2.
- Raw-result SHA-256: `68d50e305bdfa5da77392135ac68cc9c5ef2e642c34f539cc12ab2d848ceac74`.
- P2 disposition: state prospectively that the five-key bounded input supersedes 0b0b's four-key sentence; corrected in the next plan touch with no executable effect.
- P2 disposition: remove the duplicated conjunction in the eight-item failure roster; corrected in the next plan touch with no contract change.

## Custody and constraints

- Prompt SHA-256: `c56d6d3397b218544776700b66bca585794417eb1d3a3fc467bd1f6bae938eca`.
- The first read-only Prettier check exhausted Node's default approximately 4 GiB heap while parsing the large plan; this was a diagnostic-capacity failure, not a formatting result. The established 12 GiB read-only check is the authoritative formatting gate.
- No production or test files were changed during confirmation.
- No D.110a invocation, preflight, long campaign, Fable run, or collaboration subagent occurred.
- Protected `.agents`, `.claude`, and `.pnpm-store` remain present; all 27 stashes remain untouched.
- Deterministic D.110c-0b1 RED may begin only after this ledger, review evidence, and plan disposition are signed and pushed.
