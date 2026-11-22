// fix/browser-rollover-member-stall, box m45 run rcd5: a creator SIGKILLed between saving an ACTIVE
// AHE closed-retirement preparation and the signing participant staging it reopened to
// "creator snapshot role reconciliation refused: chain-invalid". Every source part re-derived
// byte for byte; only the signing classification changed, so the resumed source proof differed from
// the prepared one.
//
// The model keeps only what the classification reads: the AHE coordinator (completed decision, active
// preparation) and the signing participant (completed decision and its stored summary source, staged
// preparation and its stored summary source). A derivation runs only with no active preparation
// (with one it resumes it) and binds the class it computed into the preparation; preparing keeps the
// coordinator's completed decision (boundPreparedFields). The participant stages the preparation with
// that class, completes it, and the coordinator commits it. A crash may stop the process in any state;
// a reopened pass re-derives the class and must get the prepared one back (resumeMatches*).
//
// classifyPre: the SAME-P comparison reads the coordinator's active labels whenever present
// (p = active ?? completed in classifyClosedSigningSummaries and classifyClosedSigningEvidence).
// classifyFix: until the participant joins the active preparation (staged or completed it), classify on
// the coordinator the preparation was derived on (active cleared), closedSigningClassificationCoordinator.
// 0 is "no summary source" (the fresh path declined); positive values name stored summary sources.
module closedRetirementResumeClassification {
	pure val NONE = -1
	pure val MAX_DECISION = 3

	var coordCompleted: int
	var coordActive: int
	var sigCompleted: int
	var sigCompletedSummary: int
	var sigStaged: int
	var sigStagedSummary: int
	var preparedClass: int

	// The stored-branch comparison on a given coordinator view (active label or NONE).
	def classifyOn(viewActive: int): int = {
		val p = if (viewActive != NONE) viewActive else coordCompleted
		val label = if (sigStaged != NONE) sigStaged else sigCompleted
		val stored = if (sigStaged != NONE) sigStagedSummary else sigCompletedSummary
		if (p == label) stored else 0
	}

	def classifyPre: int = classifyOn(coordActive)

	def joined: bool = coordActive != NONE and (sigStaged == coordActive or sigCompleted == coordActive)

	def classifyFix: int = classifyOn(if (coordActive != NONE and not(joined)) NONE else coordActive)

	action init = all {
		coordCompleted' = 1,
		coordActive' = NONE,
		// The signing store completed the same decision with a summary source the next pass continues.
		sigCompleted' = 1,
		sigCompletedSummary' = 1,
		sigStaged' = NONE,
		sigStagedSummary' = 0,
		preparedClass' = 0,
	}

	// A fresh derivation (no active preparation) prepares the next decision with the class it computed.
	action derive = all {
		coordActive == NONE,
		sigStaged == NONE,
		coordCompleted < MAX_DECISION,
		coordActive' = coordCompleted + 1,
		preparedClass' = classifyOn(NONE),
		coordCompleted' = coordCompleted,
		sigCompleted' = sigCompleted,
		sigCompletedSummary' = sigCompletedSummary,
		sigStaged' = sigStaged,
		sigStagedSummary' = sigStagedSummary,
	}

	// The signing participant stages the active preparation and stores its summary source.
	action stage = all {
		coordActive != NONE,
		sigStaged == NONE,
		sigCompleted != coordActive,
		sigStaged' = coordActive,
		sigStagedSummary' = preparedClass,
		coordCompleted' = coordCompleted,
		coordActive' = coordActive,
		sigCompleted' = sigCompleted,
		sigCompletedSummary' = sigCompletedSummary,
		preparedClass' = preparedClass,
	}

	action completeSigning = all {
		sigStaged != NONE,
		sigCompleted' = sigStaged,
		sigCompletedSummary' = sigStagedSummary,
		sigStaged' = NONE,
		sigStagedSummary' = 0,
		coordCompleted' = coordCompleted,
		coordActive' = coordActive,
		preparedClass' = preparedClass,
	}

	action commit = all {
		coordActive != NONE,
		sigStaged == NONE,
		sigCompleted == coordActive,
		coordCompleted' = coordActive,
		coordActive' = NONE,
		sigCompleted' = sigCompleted,
		sigCompletedSummary' = sigCompletedSummary,
		sigStaged' = sigStaged,
		sigStagedSummary' = sigStagedSummary,
		preparedClass' = preparedClass,
	}

	action stutter = all {
		coordCompleted' = coordCompleted,
		coordActive' = coordActive,
		sigCompleted' = sigCompleted,
		sigCompletedSummary' = sigCompletedSummary,
		sigStaged' = sigStaged,
		sigStagedSummary' = sigStagedSummary,
		preparedClass' = preparedClass,
	}

	action step = any { derive, stage, completeSigning, commit, stutter }

	// A process stopped in any state with an active preparation re-derives the prepared class.
	val resumeMatchesPre = coordActive != NONE implies classifyPre == preparedClass
	val resumeMatchesFix = coordActive != NONE implies classifyFix == preparedClass
	// Live (no crash) derivations are unchanged by the fix: with no active preparation both agree.
	val liveUnchanged = coordActive == NONE implies classifyPre == classifyFix

	// Witnesses: the rcd5 state (prepared, not staged) exists, and the full cycle completes.
	run preparedNotStagedTest = init.then(derive).then(all { assert(coordActive == 2 and sigStaged == NONE), stutter })
	run preFixRefusesRcd5Test = init.then(derive).then(all { assert(classifyPre != preparedClass), stutter })
	run fixResumesRcd5Test = init.then(derive).then(all { assert(classifyFix == preparedClass), stutter })
	run fullCycleTest =
		init.then(derive).then(stage).then(completeSigning).then(commit).then(derive)
			.then(all { assert(coordCompleted == 2 and coordActive == 3 and classifyFix == preparedClass), stutter })
}
