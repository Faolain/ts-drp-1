# Inherited nonblocking diagnostics

The separately closed f5b0a corrective test currently reports 3/4, with the
failure in `binds genesis advance to the exported settlement sentinel and
retains settled-v1 digest adjacency`. No f5b0d changed path owns that protocol
advance result. It is retained without reinterpretation in
`inherited-f5b0a-corrective.json` and is not folded into reclamation scope.

The broad package `typecheck` scripts include historical test trees and report
pre-existing rootDir/file-list, missing test alias, and fixture typing errors.
The four affected production build configurations all pass, including in the
fresh isolated checkout.
