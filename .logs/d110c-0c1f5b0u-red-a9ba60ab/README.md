# Invalid pre-run fixture diagnostic — not causal RED

Signed/pushed tests-only commit: `a9ba60abd22bc182c85afbd6755b3a79d2448d22`.

The clean isolated checkout was `/tmp/d110c-f5b0u-red-QjViix/checkout`.
Its offline frozen install and fresh package builds passed. Test listing
failed before any focused test ran because the tests-only creator-close
observer dropped `bindCreatorLiveClose`'s existing non-enumerable,
receiver-bound `installV3CreatorCloseRegistrationResolver` property.
`v3-live.ts` correctly rejected initialization with
`v3 creator close registration resolver is unavailable`.

This is a harness defect, not a product failure or accepted RED. Focused
invocations: zero. Overlay applications: zero. The agent stopped and reported
the cause. The parent authorized a separately signed tests-only correction
that preserves the installer descriptor and invokes its original function
with the original `bindCreatorLiveClose` receiver; production stays unchanged.

`clean/commands.json` records exact commands, working directories, statuses,
and timestamps. Complete stdout/stderr accompany every command. Main-worktree
before/after evidence verifies all seven frozen file hashes, binary patch hash
`1239cf2d5fbbc6e40eebdae4365ba7b8843af1d22586851548a1f995025684c9`,
and the unchanged 27-stash identity set. No campaign or long workload ran.
