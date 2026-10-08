# Durable-row expectation disposition

The source audit confirms that case25 compares a transient transaction command
to persisted issued-row contents. The accepted design requires atomic planEffect
application to settlementPlans, not durable command history on issued rows.
Browser commitFromIssued/nativeIssued return/store only the four durable commit
fields. A tests-only projection plus independent exact plan mutation comparison
preserves the intended assertion without changing the store contract.

The stopped GREEN manifest was independently validated: ten entries;
SHA-256 f8104d640f96c23fb6d8c0d3b42aa414bd62bd13b35bd6244bee9d75945b83c2.
Its partial production patch remains uncommitted and is excluded from corrective
RED execution, which will use an isolated signed checkout.

Signed plan disposition: ac7fb4f1. git diff --check for the plan exited zero.
The initial whole-plan `pnpm exec prettier --check
docs/production-hardening/production-hardening-tdd-plan-v2.md` failed with a
default 4-GiB formatter heap OOM (pnpm status 1 / formatter SIGABRT), not a
formatting verdict. This happened before the commit but was observed afterward;
the commit must not be represented as format-verified at creation. The terminal
returned the diagnostic, but no complete raw file was captured for that first
formatter attempt. The recorded follow-up uses the existing 12-GiB
formatter-only allowance for this 100k-line plan; it changes no tested workload
or runtime ceiling. Its result is separately captured, not presumed.

The prior claude-phel workload confirmation's runtime reported claude-opus-5.
The prospective plan correction preserves its findings but retracts the claim
that the alias label proves Fable 5.1 execution. The next required final GREEN
review must explicitly select the requested model and record actual metadata.
No reviewer was invoked for this disposition.

Follow-up results: formatter-only 12-GiB Prettier check passed (status 0).
Custody check passed: ac7fb4f1 signed G and equal to the tracked pushed ref;
the partial production patch is byte-identical to the stopped evidence;
all 27 stash identities and all prior protected untracked paths remain;
the index is empty. These checks are recorded in plan-format.json and
custody.json, including exact commands and timestamps.
