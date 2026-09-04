# D.110c-0c1f5b0b explicit legacy-rebase completion RED correction

Signed tests-only commit `6e542c3dd326f772893c30fef5f7b8a1fc1bcd96`
changes the legacy application-visible `causalJoin` completion expectation to
`undefined`. The fixture invokes `completeRebaseSource` only for a source with
zero intents; a surfaced application intent must remain pending for explicit
handling and must not auto-complete.

The Phase-3g retained file ran once on the unchanged production baseline. It
selected 14 tests: 13 passed and exactly the legacy `causalJoin` response
assertion failed because current production returned `intents: []`. The new
completion assertion was not reached on RED, and no unexpected failure was
introduced.

The prior candidate-GREEN reporter
`9332fff25f5f432f7ff4f85a2555b166a2a26e1b05b45eb9a453fcd60be2b520`
is preserved here. It established that the corrected candidate surfaced the
exact canonical intent and returned `completion: undefined`; its only failure
was the now-superseded auto-completion expectation.
