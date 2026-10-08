# D.110c-0c1f5b0b Node GREEN evidence

This root records signed GREEN commit
`93585bf3ba62ae662c2963fd13be2ee051451fa2`, descended from final
tests-only RED/evidence `504ca351653701af9dd45ad99f725307994c8e1f`.

The focused test moved from 6 pass / 21 causal fail to 27/27 pass. The retained
codec/store/recovery/close/rebase/terminal set passed 87/87. Protocol-v3
build, typecheck and frozen root public-export smoke passed; Node build passed;
exact lint, formatting and diff checks passed; and a detached clean worktree
reproduced the focused and built-package gates.

One implementation seam differed from the design's assumption: the existing
authentication-only verifier was implementation-internal and unavailable to
Node through a legal package path. GREEN adds one internal-only package subpath
that re-exports the unchanged verifier. It does not export it from the root,
change cryptography, or add a dependency. The matching Vite alias resolves
only that exact internal subpath in the monorepo.

The verified frontier is not fabricated. Any-anchor older-row classification
requires a validated internal `{currentEpoch, admissionEpoch,
terminalThrough}` context. Current public callers cannot supply it; f5b0c/f5b
owns threading the authenticated checkpoint frontier. Without that context,
the partial Node path makes no terminal/old-incarnation claim.
