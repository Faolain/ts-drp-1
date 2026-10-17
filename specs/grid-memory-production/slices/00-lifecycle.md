# Whole-storage lifecycle

Primary question: is the intended pruning lifecycle complete for fixed-size live state?

Trace every persistent owner from genuine safe supersession through eligibility, deletion, and cleanup trigger. Distinguish protected recovery data, temporary expiry retention, and history with no deletion path. Use the prior fixed-state 60-transition census as evidence of actual cleanup, not merely a synthetic policy test; the in-memory backend explains residency, not the unbounded persistence concern.

Separate the implemented partial bound (active AHE generation plus two immediate physical rollback ancestors; authenticated issuance window) from a whole-storage bound. A finite temporal transfer window also needs bounded admission/rate and a bounded maintenance delay. Do not invent those parameters or assume arbitrary old-epoch data is safe to delete.

Add a bounded native-browser characterization using the existing direct-room owner with the production grid application and settlement profile. Keep one roster member and one overwritten block; verify exact state and authenticated cleanup across repeated epochs. Census all stores after cleanup. Characterize remaining journal and supporting-record growth as a counterexample, not a passing boundedness gate. A retained-window reclamation/reopen check may follow only after the source trace identifies which snapshot is still required.

No production deletion, profile migration, protocol retirement watermark or availability policy is authorized by this investigation. If the current lifecycle cannot satisfy a finite total bound, that negative result is the investigation verdict; a passing bounded-storage guarantee requires a separately designed implementation.
