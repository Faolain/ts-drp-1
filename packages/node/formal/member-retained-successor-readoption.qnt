// fix/browser-rollover-member-stall, box m49/m52/m55: a member killed after its snapshot store retained a
// received successor (E -> E+1) and before its native head moved reopened to "creator retained recovery
// authenticated adoption failed": verifyCreatorSuccessorAdoption refused chain-invalid.
//
// The model keeps the closures the adoption compares, as sets of candidate tags. The member's native
// closure at epoch E holds its trust T(E), the retiring predecessor proofs C(E-1), Q(E-1), A(E-1), and the
// rest R. The received proof adds C(E), Q(E), T(E+1) and the history H. The live receive STAGES the
// proposal (inspectCreatorTransitionAdvance mode "stage": drop the retiring predecessor proofs), retains
// the certificate, and later installs (the native head moves to E+1). A crash may stop the process in any state.
// A reopened member with retained custody and native head E re-adopts; the verify predicate
// (inspectBoundedCreatorTrustAdvance) requires exactly current - T(E) - retiring + {T(E+1), C(E), Q(E)} (+ H).
//
// Pre (selectRetainedCreatorSuccessorAdoption): the proposal is current - T(E) - settlement companions +
// proof, never staged, so the retiring predecessor proofs stay and verify refuses.
// Fix: stage the rebuilt proposal exactly as the live receive and the occupied-custody path do.
module memberRetainedSuccessorReadoption {
	pure val MAX_EPOCH = 4

	var nativeEpoch: int
	var retained: bool
	var receivedStaged: Set[(str, int)]

	pure def tag(kind: str, epoch: int): (str, int) = (kind, epoch)
	pure def current(e: int): Set[(str, int)] = Set(tag("T", e), tag("C", e - 1), tag("Q", e - 1), tag("A", e - 1), ("R", 0))
	pure def retiring(e: int): Set[(str, int)] = Set(tag("C", e - 1), tag("Q", e - 1), tag("A", e - 1))
	pure def proof(e: int): Set[(str, int)] = Set(tag("C", e), tag("Q", e), tag("T", e + 1), ("H", 0))
	pure def raw(e: int): Set[(str, int)] = current(e).exclude(Set(tag("T", e))).union(proof(e))
	pure def staged(e: int): Set[(str, int)] = raw(e).exclude(retiring(e))
	pure def verifies(e: int, proposed: Set[(str, int)]): bool = proposed == staged(e)

	def proposedPre: Set[(str, int)] = raw(nativeEpoch)
	def proposedFix: Set[(str, int)] = staged(nativeEpoch)

	action init = all { nativeEpoch' = 1, retained' = false, receivedStaged' = Set() }

	// The live receive stages and retains the next successor.
	action retain = all {
		not(retained),
		nativeEpoch < MAX_EPOCH,
		verifies(nativeEpoch, staged(nativeEpoch)),
		retained' = true,
		receivedStaged' = staged(nativeEpoch),
		nativeEpoch' = nativeEpoch,
	}

	// The install moves the native head; the retained custody no longer matches the head's successor.
	action install = all {
		retained,
		nativeEpoch' = nativeEpoch + 1,
		retained' = false,
		receivedStaged' = Set(),
	}

	action stutter = all { nativeEpoch' = nativeEpoch, retained' = retained, receivedStaged' = receivedStaged }

	action step = any { retain, install, stutter }

	// A process stopped with retained custody at native head E re-adopts it on reopen.
	val reopenReadoptsPre = retained implies verifies(nativeEpoch, proposedPre)
	val reopenReadoptsFix = retained implies verifies(nativeEpoch, proposedFix)
	// The fix re-derives exactly what the live receive staged.
	val fixMatchesLive = retained implies proposedFix == receivedStaged

	run retainedTest = init.then(retain).then(all { assert(retained and nativeEpoch == 1), stutter })
	run preRefusesTest = init.then(retain).then(all { assert(not(verifies(nativeEpoch, proposedPre))), stutter })
	run fixReadoptsTest = init.then(retain).then(all { assert(verifies(nativeEpoch, proposedFix) and proposedFix == receivedStaged), stutter })
	run cycleTest = init.then(retain).then(install).then(retain)
		.then(all { assert(nativeEpoch == 2 and retained and verifies(nativeEpoch, proposedFix)), stutter })
}
