// fix/browser-rollover-member-stall, box m46 (creator-retirement-crash-native, edges 4 and 5, at the
// RED base and with the cold-reopen fix, in all three runs): a creator SIGKILLed after its snapshot
// participant's prepareFence (the snapshot retirement control holds the coordinator's own ACTIVE
// preparation) reopened to "creator snapshot role reconciliation refused: snapshot-unavailable" on every
// pass and never closed an epoch again.
//
// The model keeps what the reconciliation pass reads before it reaches the install: the AHE coordinator
// (completed decision, active preparation) and the snapshot participant's retirement control (completed
// decision, active fence). The install prepares the coordinator, fences the snapshot participant with
// that preparation, commits the participant, and completes the coordinator. A crash may stop the process
// in any state; a reopened pass first runs the turnover selection (scheduling only) and only then the
// install, which resumes a prepared participant against the coordinator's durable commitment.
// orphan abstracts any path that leaves a fence the coordinator no longer owns.
//
// Pre (selectCurrentSnapshotTurnoverInventory): any active snapshot fence makes the selection undefined,
// so the pass refuses snapshot-unavailable before the install.
// Fix: a fence equal to the coordinator's own active preparation is joined: keep the whole pool and
// retire nothing until the install completes it. An unowned fence still refuses.
module closedRetirementSnapshotFenceResume {
	pure val NONE = -1
	pure val MAX_DECISION = 3

	var coordCompleted: int
	var coordActive: int
	var snapCompleted: int
	var snapActive: int

	def refusesPre: bool = snapActive != NONE
	def joined: bool = snapActive != NONE and snapActive == coordActive
	def refusesFix: bool = snapActive != NONE and not(joined)
	// Whether the selection may hand the authenticated (retiring) selection on, rather than keep the pool.
	def turnsOverFix: bool = snapActive == NONE

	action init = all {
		coordCompleted' = 1,
		coordActive' = NONE,
		snapCompleted' = 1,
		snapActive' = NONE,
	}

	action prepare = all {
		coordActive == NONE,
		snapActive == NONE,
		coordCompleted < MAX_DECISION,
		coordActive' = coordCompleted + 1,
		coordCompleted' = coordCompleted,
		snapCompleted' = snapCompleted,
		snapActive' = snapActive,
	}

	action fence = all {
		coordActive != NONE,
		snapActive == NONE,
		snapCompleted != coordActive,
		snapActive' = coordActive,
		coordCompleted' = coordCompleted,
		coordActive' = coordActive,
		snapCompleted' = snapCompleted,
	}

	action commitSnapshot = all {
		snapActive != NONE,
		snapActive == coordActive,
		snapCompleted' = snapActive,
		snapActive' = NONE,
		coordCompleted' = coordCompleted,
		coordActive' = coordActive,
	}

	action complete = all {
		coordActive != NONE,
		snapActive == NONE,
		snapCompleted == coordActive,
		coordCompleted' = coordActive,
		coordActive' = NONE,
		snapCompleted' = snapCompleted,
		snapActive' = snapActive,
	}

	action orphan = all {
		coordActive != NONE,
		snapActive == coordActive,
		coordActive' = NONE,
		coordCompleted' = coordCompleted,
		snapCompleted' = snapCompleted,
		snapActive' = snapActive,
	}

	action stutter = all {
		coordCompleted' = coordCompleted,
		coordActive' = coordActive,
		snapCompleted' = snapCompleted,
		snapActive' = snapActive,
	}

	action step = any { prepare, fence, commitSnapshot, complete, orphan, stutter }

	// A process stopped with an active coordinator preparation reaches its install on reopen.
	val reopenResumesPre = coordActive != NONE implies not(refusesPre)
	val reopenResumesFix = coordActive != NONE implies not(refusesFix)
	// The fix never turns over under any fence, and still refuses one the coordinator does not own.
	val fenceKeepsPoolFix = snapActive != NONE implies not(turnsOverFix)
	val unownedRefusesFix = (snapActive != NONE and snapActive != coordActive) implies refusesFix
	// With no fence in flight the selection is unchanged.
	val idleUnchanged = snapActive == NONE implies (refusesPre == refusesFix)

	// Witnesses: the m46 edge-4 state exists, pre refuses it, the fix resumes it, the cycle completes.
	run fencedTest = init.then(prepare).then(fence).then(all { assert(coordActive == 2 and snapActive == 2), stutter })
	run preRefusesFencedTest = init.then(prepare).then(fence).then(all { assert(refusesPre), stutter })
	run fixResumesFencedTest = init.then(prepare).then(fence).then(all { assert(not(refusesFix) and not(turnsOverFix)), stutter })
	run orphanRefusesTest = init.then(prepare).then(fence).then(orphan).then(all { assert(refusesFix), stutter })
	run fullCycleTest =
		init.then(prepare).then(fence).then(commitSnapshot).then(complete).then(prepare)
			.then(all { assert(coordCompleted == 2 and coordActive == 3 and snapCompleted == 2 and not(refusesFix)), stutter })
}
