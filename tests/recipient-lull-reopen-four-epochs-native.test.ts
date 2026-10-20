// Track R3 RED: the same genuine recipient lull, persisted close and reopen as
// recipient-lull-reopen-close-native.test.ts, after four rollovers instead of five.
// After four, the current Cut still classifies a scope that this copy retired under
// its PREVIOUS certificate. The reopen's reconstruction request checked absence
// against the current certificate's receipt only, so the room refused to open with
// RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE (Track L, RESULT.md, residual 1), while the
// full reconstruction it requests accepts the same inventory with the previous
// certificate. The shared scenario module reads LULL_REOPEN_EPOCHS when it loads, so
// this file loads it under 4 and restores the environment right after.
const previous = process.env.LULL_REOPEN_EPOCHS;
process.env.LULL_REOPEN_EPOCHS = "4";
try {
	await import("./recipient-lull-reopen-close-native.test.js");
} finally {
	if (previous === undefined) delete process.env.LULL_REOPEN_EPOCHS;
	else process.env.LULL_REOPEN_EPOCHS = previous;
}
